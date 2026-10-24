// Strafing-run planner. Pure math (three Vector3 only) so it can be unit-tested in node.
//
//   ENTRY  : curve from the orbit onto the attack line      (arc – straight – arc)
//   ATTACK : dead-straight shallow dive at the target; guns fire in this stretch
//   EXIT   : pull-out, climbing and curving back onto orbit (arc – straight – arc)
//
// Horizontal motion is a Dubins path, so the plane never turns tighter than TURN_R and
// every join is tangent-continuous. Altitude is a separate smooth profile.
import * as THREE from 'three';

export const RUN = {
  IP_DIST: 320,        // m before target where the straight attack line begins
  IP_DROP: 4,          // m below current altitude at the attack-line start (lets the dive begin smoothly)
  PITCH_OVER: 120,     // m of entry used to ease from level flight into the dive
  PULL_DIST: 45,       // m before target where the pull-out begins
  PULL_ALT: 20,        // m above ground at pull-out start (lowest point ≈ 13 m)
  FIRE_FAR: 240,       // m slant range: guns on
  FIRE_NEAR: 85,       // m slant range: guns off
  TURN_R: 130,         // m, horizontal turn radius for entry / exit arcs
  CRUISE_ALT: 52,
  MAP_SOFT_LIMIT: 330, // m from centre; paths wandering further than this get penalised
  HEADINGS: 36,        // attack headings tried
  REJOINS: 24,         // orbit rejoin points tried
  STEP: 3,             // m between path samples
};

const TWO_PI = Math.PI * 2;
const mod2pi = (a) => { a %= TWO_PI; if (a < 0) a += TWO_PI; return a > TWO_PI - 1e-7 ? 0 : a; };

// ---------- Dubins (x,z plane; heading θ → direction (cosθ, sinθ)) ----------
function dubins(x0, z0, th0, x1, z1, th1, r, startDir = 0) {
  // circle centres: ds=+1 turns toward increasing θ, ds=-1 toward decreasing θ
  const centre = (x, z, th, d) => [x - d * r * Math.sin(th), z + d * r * Math.cos(th)];
  let best = null;
  for (const ds of [1, -1]) for (const de of [1, -1]) {
    if (startDir && ds !== startDir) continue;
    const [cx0, cz0] = centre(x0, z0, th0, ds);
    const [cx1, cz1] = centre(x1, z1, th1, de);
    const dx = cx1 - cx0, dz = cz1 - cz0, D = Math.hypot(dx, dz);
    let h = null, lineLen = 0;
    if (ds === de) {
      if (D < 1e-6) continue;
      h = Math.atan2(dz, dx); lineLen = D;
    } else {
      if (D < 2 * r) continue;
      const beta = Math.asin(2 * r / D);
      const base = Math.atan2(dz, dx);
      h = base + ds * beta;           // sign: first circle's turn direction decides which inner tangent
      lineLen = Math.sqrt(D * D - 4 * r * r);
    }
    const a0 = mod2pi(ds * (h - th0)) * r;
    const a1 = mod2pi(de * (th1 - h)) * r;
    const len = a0 + lineLen + a1;
    if (!best || len < best.len) best = { len, ds, de, h, a0, a1, lineLen, cx0, cz0, cx1, cz1 };
  }
  if (!best) return null;
  best.x0 = x0; best.z0 = z0; best.th0 = th0; best.r = r;
  return best;
}

/** Sample a Dubins path every `step` m → array of {x, z, s}. */
function sampleDubins(P, step, out = []) {
  const { r, ds, de, a0, a1, lineLen, h, th0, x0, z0, cx0, cz0, cx1, cz1 } = P;
  const arc = (cx, cz, thStart, d, len, s0, skipFirst) => {
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = skipFirst ? 1 : 0; i <= n; i++) {
      const dl = (len * i) / n;
      const th = thStart + d * (dl / r);
      // point on circle whose heading is th
      out.push({ x: cx + d * r * Math.sin(th), z: cz - d * r * Math.cos(th), th, s: s0 + dl });
    }
  };
  if (a0 > 1e-6) arc(cx0, cz0, th0, ds, a0, 0, false); else out.push({ x: x0, z: z0, th: th0, s: 0 });
  const last = out[out.length - 1];
  const nL = Math.max(1, Math.ceil(lineLen / step));
  for (let i = 1; i <= nL; i++) {
    const dl = (lineLen * i) / nL;
    out.push({ x: last.x + Math.cos(h) * dl, z: last.z + Math.sin(h) * dl, th: h, s: last.s + dl });
  }
  if (a1 > 1e-6) {
    const l2 = out[out.length - 1];
    arc(cx1, cz1, h, de, a1, l2.s, true);
  }
  return out;
}

const smoothHermite = (h0, m0, h1, m1, L, s) => {
  const t = Math.min(1, Math.max(0, s / L)), t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * h0 + (t3 - 2 * t2 + t) * L * m0 + (-2 * t3 + 3 * t2) * h1 + (t3 - t2) * L * m1;
};

/**
 * @param {object} o
 * @param {THREE.Vector3} o.p0  plane position, o.t0 horizontal unit heading
 * @param {THREE.Vector3} o.target  tank centre
 * @param {{x:number,z:number}} o.center  orbit centre;  o.radius orbit radius;  o.orbitDir ±1
 * @param {number} [o.groundY]   ground height at target
 * @param {(x:number,z:number)=>number} [o.heightAt]  terrain height (clearance check)
 * @param {number} [o.headingHint]  re-plan: only try attack headings within ±headingTol of this (rad)
 * @param {number} [o.startTurn]    re-plan: -1/0/+1 = keep turning that way (0 = straight / any)
 */
export function planStrafeRun(o) {
  const { p0, t0, target, center, radius, orbitDir } = o;
  const r = RUN.TURN_R;
  const gy = o.groundY ?? target.y - 1;
  const cruiseAlt = o.cruiseAlt ?? RUN.CRUISE_ALT;
  const th0 = Math.atan2(t0.z, t0.x);
  let best = null;

  const hinted = o.headingHint !== undefined, nH = hinted ? 13 : RUN.HEADINGS;
  for (let i = 0; i < nH; i++) {
    const thD = hinted
      ? o.headingHint + (i / (nH - 1) - 0.5) * 2 * (o.headingTol ?? 0.5)
      : (i / nH) * TWO_PI;
    const dx = Math.cos(thD), dz = Math.sin(thD);
    const ipx = target.x - dx * RUN.IP_DIST, ipz = target.z - dz * RUN.IP_DIST;
    const pox = target.x - dx * RUN.PULL_DIST, poz = target.z - dz * RUN.PULL_DIST;
    const entry = dubins(p0.x, p0.z, th0, ipx, ipz, thD, r, o.startTurn ?? 0);
    if (!entry) continue;

    for (let j = 0; j < RUN.REJOINS; j++) {
      const psi = (j / RUN.REJOINS) * TWO_PI;
      const rx = center.x + radius * Math.cos(psi), rz = center.z + radius * Math.sin(psi);
      const thR = Math.atan2(Math.cos(psi) * orbitDir, -Math.sin(psi) * orbitDir);
      const exit = dubins(pox, poz, thD, rx, rz, thR, r);
      if (!exit || exit.len < 130) continue;
      const total = entry.len + (RUN.IP_DIST - RUN.PULL_DIST) + exit.len;
      if (best && total >= best.cost - 1e-6) continue;

      // soft containment: penalise paths that wander far off the map
      const pts = [...sampleDubins(entry, 12), ...sampleDubins(exit, 12)];
      let maxD = 0;
      for (const p of pts) maxD = Math.max(maxD, Math.hypot(p.x - center.x, p.z - center.z));
      const cost = total + 6 * Math.max(0, maxD - RUN.MAP_SOFT_LIMIT);
      if (!best || cost < best.cost) best = { cost, thD, entry, exit, psi, rx, rz };
    }
  }
  if (!best) return null;

  // ---- assemble 3-D polyline ----
  const dx = Math.cos(best.thD), dz = Math.sin(best.thD);
  const ipAlt = p0.y - RUN.IP_DROP, poAlt = gy + RUN.PULL_ALT;
  const attackLen = RUN.IP_DIST - RUN.PULL_DIST;
  const slope = (poAlt - ipAlt) / attackLen;                    // m per m (negative = diving)

  const E = sampleDubins(best.entry, RUN.STEP);
  const X = sampleDubins(best.exit, RUN.STEP);
  const Le = E[E.length - 1].s, Lx = X[X.length - 1].s;
  const pts = [];
  const Lt = Math.min(Le, RUN.PITCH_OVER), sT = Le - Lt;     // level until sT, then ease into the dive
  for (const p of E) {
    const y = p.s <= sT ? p0.y : smoothHermite(p0.y, 0, ipAlt, slope, Lt, p.s - sT);
    pts.push(new THREE.Vector3(p.x, y, p.z));
  }
  const iAttackStart = pts.length - 1;
  const nA = Math.ceil(attackLen / RUN.STEP);
  const ipx = target.x - dx * RUN.IP_DIST, ipz = target.z - dz * RUN.IP_DIST;
  for (let k = 1; k <= nA; k++) {
    const f = k / nA;
    pts.push(new THREE.Vector3(ipx + dx * attackLen * f, ipAlt + (poAlt - ipAlt) * f, ipz + dz * attackLen * f));
  }
  const iAttackEnd = pts.length - 1;
  for (let k = 1; k < X.length; k++) {
    pts.push(new THREE.Vector3(X[k].x, smoothHermite(poAlt, slope, cruiseAlt, 0, Lx, X[k].s), X[k].z));
  }
  if (o.heightAt) for (const p of pts) p.y = Math.max(p.y, o.heightAt(p.x, p.z) + 10);

  const cum = new Float32Array(pts.length);
  for (let k = 1; k < pts.length; k++) cum[k] = cum[k - 1] + pts[k].distanceTo(pts[k - 1]);
  return {
    pts, cum, length: cum[cum.length - 1],
    sEntryEnd: cum[iAttackStart], sPullOut: cum[iAttackEnd],
    attackDir: new THREE.Vector3(dx, 0, dz), rejoinAngle: best.psi,
    pitchOverLen: Lt,
  };
}

/** Position + unit tangent at arc length s (clamped). */
export function sampleRun(run, s, outPos, outTan) {
  const { pts, cum } = run;
  s = Math.min(Math.max(s, 0), run.length - 1e-3);
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const k = (s - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
  outPos.lerpVectors(pts[lo], pts[hi], k);
  const a = Math.max(0, lo - 1), b = Math.min(pts.length - 1, hi + 1);
  outTan.subVectors(pts[b], pts[a]).normalize();
  return outPos;
}

/**
 * Per-round hit decision, stratified: exactly 1 in every round(1/hitFraction) rounds is
 * aimed to hit (25 % → 1 in 4), at a random slot inside each group so it isn't mechanical.
 */
export function makeHitPicker(hitFraction = 0.25) {
  const group = Math.max(1, Math.round(1 / hitFraction));
  let slot = 0, hitAt = Math.floor(Math.random() * group);
  return () => {
    const hit = slot === hitAt;
    if (++slot >= group) { slot = 0; hitAt = Math.floor(Math.random() * group); }
    return hit;
  };
}

// ---------------------------------------------------------------------------------------
// Flight follower: moves along the planned path with a speed profile.
// ---------------------------------------------------------------------------------------
export const FLIGHT = { CRUISE: 36, ATTACK: 44 };
const sstep = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

const _tmpP = new THREE.Vector3(), _tA = new THREE.Vector3(), _tB = new THREE.Vector3();

export class RunFlight {
  constructor(run, v0 = FLIGHT.CRUISE) { this.run = run; this.s = 0; this.done = false; this.v0 = v0; this.speed = v0; }
  speedAt(s) {
    const r = this.run;
    if (s < r.sPullOut) return this.v0 + (FLIGHT.ATTACK - this.v0) * sstep(s / r.sEntryEnd);
    return FLIGHT.ATTACK + (FLIGHT.CRUISE - FLIGHT.ATTACK) * sstep((s - r.sPullOut) / (r.length - r.sPullOut));
  }
  /** Advance dt seconds. Fills pos, tangent and *perpendicular* acceleration (v²·dT/ds). */
  step(dt, pos, tan, acc) {
    this.speed = this.speedAt(this.s);
    this.s += this.speed * dt;
    if (this.s >= this.run.length - 0.5) this.done = true;
    sampleRun(this.run, this.s, pos, tan);
    sampleRun(this.run, this.s - 5, _tmpP, _tA);
    sampleRun(this.run, this.s + 5, _tmpP, _tB);
    acc.subVectors(_tB, _tA).multiplyScalar(this.speed * this.speed / 10);
    return this;
  }
}

// ---------------------------------------------------------------------------------------
// One round: decide where it lands.
// ---------------------------------------------------------------------------------------
export const GUN = { BULLET_SPEED: 380, HIT_CONE: 0.36 /* rad ≈ 20° off the nose */ };

/**
 * @returns {{point: THREE.Vector3, dir: THREE.Vector3, dist: number, hit: boolean}}
 */
export function planShot({ muzzle, fwd, target, targetVel, attackDir, wantHit, groundY, heightAt }) {
  const dist0 = muzzle.distanceTo(target);
  const tof = dist0 / GUN.BULLET_SPEED;
  const pred = target.clone().addScaledVector(targetVel, tof);          // lead the target
  const toPred = pred.clone().sub(muzzle);
  const ang = toPred.angleTo(fwd);
  const point = new THREE.Vector3();
  let hit = false;

  if (wantHit && ang < GUN.HIT_CONE) {
    hit = true;
    point.set(pred.x + (Math.random() - 0.5) * 1.2, pred.y + 0.2 + Math.random() * 0.8, pred.z + (Math.random() - 0.5) * 1.2);
  } else if (ang < GUN.HIT_CONE * 1.6) {
    // Miss, but near: rounds walk in around the target – mostly short, some wide.
    const right = new THREE.Vector3(-attackDir.z, 0, attackDir.x);
    const lat = (Math.random() < 0.5 ? -1 : 1) * (2.4 + Math.random() * 5.5);
    const along = -16 + Math.random() * 21;
    point.copy(pred).addScaledVector(right, lat).addScaledVector(attackDir, along);
    point.y = heightAt ? heightAt(point.x, point.z) : groundY;
  } else {
    // Way off the nose: rounds simply follow the gun line into the ground.
    const f = fwd.clone(); f.y = Math.min(f.y, -0.05); f.normalize();
    const t = Math.max(5, (muzzle.y - groundY) / -f.y);
    point.copy(muzzle).addScaledVector(f, t);
    point.y = heightAt ? heightAt(point.x, point.z) : groundY;
  }
  const dir = point.clone().sub(muzzle);
  const dist = dir.length();
  dir.divideScalar(Math.max(1e-6, dist));
  return { point, dir, dist, hit };
}
