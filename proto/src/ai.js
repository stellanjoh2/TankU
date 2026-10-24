// Enemy tank brain.
//  * Perception: ray-cast line of sight (terrain + rocks block it), plus hearing — your shots
//    and your engine, but only nearby. Until a tank spots you, hears you close, or a patrol
//    boat opens fire, it has no fix on you and stays on patrol. After that, a fuzzy radio
//    fix keeps the hunt going when it loses you.
//  * Mood from the health balance: ahead → hunter (pushes, flanks, punishes your reload),
//    behind → cautious (long range, hides, routes around your sight lines), even → in between.
//  * Modes: patrol → (contact) → hunt → engage → (shoot) → cover → peek → engage …,
//    with flank / evade as fallbacks.
//  * Driving: threat-aware A* from NavGrid (exposed cells cost more), pure-pursuit steering,
//    unstick + unflip recovery. Aim leads the target with deliberately imperfect, settling error.
import * as THREE from 'three';
import { heightAt, ENEMY_SPAWN } from './terrain.js';
import { SHELL_SPEED, STRESS_MAX } from './tank.js';

const SIGHT_RANGE = 170;
const HEAR_SHOT = 80;       // a cannon past this doesn't pull an unalerted patrol
const PATROL_R = [14, 26];  // default lap; a guard post passes a tighter ring
const EYE_H = 2.6;          // turret roof above the body origin
const HULL_H = 1.3;         // aim at hull centre
const TURRET_H = 2.3;       // …or at the turret when the hull is behind a crest
const SPOT_EYE_H = 2.3;     // height that must be hidden for a spot to count as cover
const THINK_EVERY = 0.2;
const REPLAN_EVERY = 2.0;
const LOOKAHEAD = 7;
const ARRIVE_R = 3.5;
const GRAVITY = 9.81;
/** Goals / probes must stay this far from blocked cells (water, rocks). */
const MIN_CLEAR = 4;
/** Abort forward drive if ground this far ahead isn't dry. */
const WATER_PROBE = [3, 6, 10];

const MOODS = {
  hunter:   { threat: 1.5, avoidR: 0,  avoidW: 0, range: [20, 50], hide: [0.3, 1.0], react: [0.9, 1.5] },
  even:     { threat: 5,   avoidR: 20, avoidW: 3, range: [30, 65], hide: [1.0, 2.4], react: [1.1, 1.8] },
  cautious: { threat: 12,  avoidR: 50, avoidW: 8, range: [50, 95], hide: [2.5, 4.5], react: [1.2, 2.0] },
};
// Gunnery difficulty
const SHOT_GAP = [4.5, 7];        // s between the AI's shots (the gun itself reloads in 4)
const SCORED_PAUSE = [7, 10];     // s of holding fire after it hits you
const BASE_SPREAD = 1.0;          // m aim error at 60 m with both tanks still
const RANGING = [2.2, 1.5, 1.15]; // spread multiplier for the 1st/2nd/3rd shot at a fresh sighting

const rnd = (a, b) => a + Math.random() * (b - a);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/** Hull yaw convention: +X forward, yaw = atan2(-z, x) (positive = left). */
const yawOf = (dx, dz) => Math.atan2(-dz, dx);

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Pure-terrain sight check (no physics needed, works before the first world step). */
function terrainLos(ax, az, bx, bz, h = EYE_H) {
  const ay = heightAt(ax, az) + h, by = heightAt(bx, bz) + h;
  const len = Math.hypot(bx - ax, bz - az);
  const steps = Math.ceil(len / 3);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (heightAt(ax + (bx - ax) * t, az + (bz - az) * t) > ay + (by - ay) * t) return false;
  }
  return true;
}

/**
 * Random drivable spawn near `near` (default ENEMY_SPAWN on the far side of the island).
 * Prefers a spot out of `face`'s sight (usually the player). Heading is random — patrol, not a bearing on the player.
 * Small radius keeps each round feeling familiar but not identical.
 */
export function pickSpawn(nav, face = null, near = ENEMY_SPAWN, radius = 18) {
  const faceX = face?.x ?? near.x, faceZ = face?.z ?? near.z;
  const home = nav.regionAt(near.x, near.z);
  let fallback = null;
  for (let i = 0; i < 600; i++) {
    const a = Math.random() * Math.PI * 2, d = rnd(4, radius);
    const x = near.x + Math.cos(a) * d, z = near.z + Math.sin(a) * d;
    if (!nav.passable(x, z) || nav.clearanceAt(x, z) < 6 || nav.gradeAt(x, z) > 0.2) continue;
    if (home && nav.regionAt(x, z) !== home) continue;
    const spawn = { x, y: heightAt(x, z) + 0.6, z, yaw: Math.random() * Math.PI * 2 };
    if (face && !terrainLos(faceX, faceZ, x, z)) return spawn;
    fallback ??= spawn;
  }
  if (fallback) return fallback;
  // Last resort: nearest passable cell to the base anchor.
  let best = null, bestD = Infinity;
  for (let k = 0; k < nav.n * nav.n; k++) {
    if (!Number.isFinite(nav.cost[k])) continue;
    if (home && nav.region[k] !== home) continue;
    const x = nav.xOf(k), z = nav.zOf(k), d = Math.hypot(x - near.x, z - near.z);
    if (d < bestD) { bestD = d; best = { x, y: heightAt(x, z) + 0.6, z, yaw: Math.random() * Math.PI * 2 }; }
  }
  return best;
}

export class TankAI {
  constructor({ tank, enemy, nav, world, RAPIER, coverRocks, anchor, patrolR }) {
    Object.assign(this, { tank, enemy, nav, world, RAPIER, coverRocks });
    this.anchor = anchor ?? ENEMY_SPAWN;
    this.patrolR = patrolR ?? PATROL_R;
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    this.drive = { throttle: 0, turn: 0, boost: false };
    this.aimPoint = new THREE.Vector3();
    this.wantsFire = false;
    this.wantsMg = false;
    this.wantsSmoke = false;
    this.exposure = new Int8Array(nav.n * nav.n);
    this.exposureFrom = { x: Infinity, z: Infinity };
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.enemyPos = new THREE.Vector3();
    this.jitter = new THREE.Vector3();
    this.jitterTarget = new THREE.Vector3();
    this.reset();
  }

  reset() {
    this.mode = 'patrol';
    this.alerted = false;
    this.modeT = 0;
    this.path = [];
    this.wp = 0;
    this.pathGoal = null;
    this.pathAge = 0;
    this.pathReached = false;
    this.arrived = false;
    this.goal = null;
    this.spot = null;
    this.hurry = false;
    this.speedScale = 1;
    this.face = null;
    const t = this.tank.body.translation();
    this.known = { x: t.x, z: t.z, eyeY: heightAt(t.x, t.z) + EYE_H };
    this.visible = false;
    this.aimH = HULL_H;
    this.seenFor = 0;
    this.unseenFor = 99;
    this.reactT = 0;
    this.cooldown = rnd(2, 3.5);
    this.shotsAt = 0;
    this.mgBurstT = 0;
    this.mgCool = rnd(0.8, 1.8);
    this.blockedT = 0;
    this.holdT = 0;
    this.hideFor = 1;
    this.weaveSign = 1;
    this.progT = 0;
    this.progX = this.progZ = this.progYaw = 0;
    this.unstickT = 0;
    this.unstickTurn = 1;
    this.flipT = 0;
    this.intelT = rnd(5, 8);
    this.hearT = 0;
    this.thinkT = 0;
    this.jitterT = 0;
    this.leadK = 1;
    this.exposureFrom.x = Infinity;
    this.side = Math.random() < 0.5 ? 1 : -1;
    this.spotBasis = null;
    this.closeIn = 1;
  }

  /** A probe came up blind: next approach goes in tighter. */
  _blind() {
    this.closeIn = Math.max(0.3, this.closeIn - 0.25);
  }

  get mood() {
    const d = this.tank.hp - this.enemy.hp;
    return d > 0 ? 'hunter' : d < 0 ? 'cautious' : 'even';
  }

  get debug() { return { mode: this.mode, mood: this.mood, path: this.path, wp: this.wp }; }

  // ------------------------------------------------------------------ events from the game
  /** The enemy fired. A distant shot doesn't wake a patrol that hasn't found anyone. */
  hearShot(pos) {
    const d = Math.hypot(pos.x - this.pos.x, pos.z - this.pos.z);
    if (!this.alerted && d > HEAR_SHOT) return;
    if (!this.visible) this._learn(pos.x, pos.z, 8);
    this._markContact();
  }

  /** A patrol boat opened fire: share the reported position and start the hunt. */
  alert(x, z) {
    this._learn(x, z, 12);
    this.alerted = true;
    if (this.mode === 'patrol') this._setMode('hunt');
  }

  /** We took a hit: we know roughly where it came from, and we want out of there. */
  onHit() {
    const e = this.enemy.body.translation();
    this._learn(e.x, e.z, 4);
    this.alerted = true;
    this._setMode('cover');
  }

  /** First real contact (sight, close noise, a hit, or a boat report). */
  _markContact() {
    if (this.alerted) return;
    this.alerted = true;
    if (this.mode === 'patrol') this._setMode('hunt');
  }

  /** Our shell hit the enemy: ease off, so a second hit isn't instant. */
  onScored() {
    this.cooldown = Math.max(this.cooldown, rnd(...SCORED_PAUSE));
    this.shotsAt = 0;
  }

  onFired() {
    this.cooldown = rnd(...SHOT_GAP);
    this.shotsAt++;
    this.jitterT = 0;
    // Shoot-and-scoot. A hunter sometimes keeps the pressure on by swinging around instead.
    this._setMode(this.mood === 'hunter' && Math.random() < 0.45 ? 'flank' : 'cover');
  }

  // ------------------------------------------------------------------ per frame
  update(dt, { halt = false } = {}) {
    const t = this.tank.body.translation();
    this.pos.set(t.x, t.y, t.z);
    _v.set(1, 0, 0).applyQuaternion(_q.copy(this.tank.body.rotation()));
    this.yaw = Math.atan2(-_v.z, _v.x);
    const e = this.enemy.body.translation();
    this.enemyPos.set(e.x, e.y, e.z);

    this.wantsFire = false;
    this.wantsMg = false;
    this.wantsSmoke = false;
    if (halt || !this.tank.alive) {
      this.drive.throttle = this.drive.turn = 0;
      this.drive.boost = false;
      return;
    }
    this.modeT += dt;
    this.pathAge += dt;
    this._perceive(dt);
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = THINK_EVERY;
      this._think();
    }
    this._steer(dt);
    this._aim(dt);
    this._trigger(dt);
    this._triggerMg(dt);
    // BF panic: full stress → pop smoke (cooldown lives on the tank)
    if (this.tank.stress >= STRESS_MAX && this.tank.smokeReady) this.wantsSmoke = true;
    this._flipCheck(dt);
  }

  // ------------------------------------------------------------------ perception
  _clear(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return true;
    const r = this.ray;
    r.origin.x = ax; r.origin.y = ay; r.origin.z = az;
    r.dir.x = dx / len; r.dir.y = dy / len; r.dir.z = dz / len;
    const hit = this.world.castRay(r, len, true, this.RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
    return !hit || hit.timeOfImpact > len - 0.3;
  }

  _perceive(dt) {
    const p = this.pos, e = this.enemyPos;
    const d = p.distanceTo(e);
    const was = this.visible;
    const inRange = this.enemy.alive && d < SIGHT_RANGE;
    const hull = inRange && this._clear(p.x, p.y + EYE_H, p.z, e.x, e.y + HULL_H, e.z);
    this.visible = hull || (inRange && this._clear(p.x, p.y + EYE_H, p.z, e.x, e.y + EYE_H, e.z));
    // hull-down target: only the turret shows, so that's what we shoot at
    this.aimH = hull ? HULL_H : TURRET_H;
    if (this.visible) {
      if (!was) this.reactT = rnd(...MOODS[this.mood].react);
      this.seenFor += dt;
      this.unseenFor = 0;
      this._learn(e.x, e.z, 0);
      this._markContact();
    } else {
      this.seenFor = 0;
      this.unseenFor += dt;
      if (this.unseenFor > 6) this.shotsAt = 0;
    }
    this.hearT -= dt;
    if (!this.visible && d < 45 && Math.abs(this.enemy.forwardSpeed()) > 2 && this.hearT <= 0) {
      this._learn(e.x, e.z, 6);
      this.hearT = 1;
      this._markContact();
    }
    if (!this.alerted) return;
    this.intelT -= dt;
    if (this.intelT <= 0) {
      this.intelT = rnd(6, 9);
      if (this.unseenFor > 5) this._learn(e.x, e.z, 14);
    }
  }

  _learn(x, z, noise) {
    this.known.x = x + rnd(-noise, noise);
    this.known.z = z + rnd(-noise, noise);
    this.known.eyeY = heightAt(this.known.x, this.known.z) + EYE_H;
  }

  /** Would a tank at the last-known enemy position see a turret at (x, z)? */
  _seenFromKnown(x, z) {
    const k = this.known;
    if (Math.hypot(x - k.x, z - k.z) > SIGHT_RANGE) return false;
    return this._clear(k.x, k.eyeY, k.z, x, heightAt(x, z) + SPOT_EYE_H, z);
  }

  // ------------------------------------------------------------------ threat-aware planning
  _exposed(k) {
    let v = this.exposure[k];
    if (v < 0) {
      const { nav, known } = this;
      const x = nav.xOf(k), z = nav.zOf(k);
      v = Math.hypot(x - known.x, z - known.z) < SIGHT_RANGE
        && this._clear(known.x, known.eyeY, known.z, x, nav.height[k] + SPOT_EYE_H, z) ? 1 : 0;
      this.exposure[k] = v;
    }
    return v;
  }

  _extraCost() {
    const m = MOODS[this.mood];
    const { nav, known } = this;
    const threat = m.threat * (this.hurry ? 1.3 : 1);
    return (k) => {
      let c = threat * this._exposed(k);
      if (m.avoidR) {
        const d = Math.hypot(nav.xOf(k) - known.x, nav.zOf(k) - known.z);
        if (d < m.avoidR) c += m.avoidW * (1 - d / m.avoidR) ** 2;
      }
      return c;
    };
  }

  _goTo(spot) {
    this.goal = spot;
    const g = this.pathGoal;
    if (!g || Math.hypot(g.x - spot.x, g.z - spot.z) > 4 || this.pathAge > REPLAN_EVERY) this._plan();
  }

  _plan() {
    const k = this.known;
    if (Math.hypot(k.x - this.exposureFrom.x, k.z - this.exposureFrom.z) > 4) {
      this.exposure.fill(-1);
      this.exposureFrom.x = k.x;
      this.exposureFrom.z = k.z;
    }
    const res = this.nav.findPath(this.pos.x, this.pos.z, this.goal.x, this.goal.z, { extra: this._extraCost() });
    this.path = res.points;
    this.wp = 0;
    this.pathGoal = { x: this.goal.x, z: this.goal.z };
    this.pathAge = 0;
    this.pathReached = res.reached;
    this.arrived = !this.path.length;
  }

  _stop() {
    this.goal = null;
    this.path = [];
    this.pathGoal = null;
    this.arrived = true;
  }

  // ------------------------------------------------------------------ spot finding
  /**
   * Score candidate spots (travel + distance-to-enemy preference + bias) and return the best one
   * that passes the sight test: hidden=true → enemy can't see it, false → it can, undefined → any.
   */
  _bestSpot(cands, { hidden, pref, prefW = 0.5, towardPenalty = 0, maxTests = 24 }) {
    const { known, pos, nav } = this;
    const dK = Math.hypot(known.x - pos.x, known.z - pos.z) || 1;
    const home = nav.regionAt(pos.x, pos.z);
    const scored = [];
    for (const c of cands) {
      const p = nav.nearestOpen(c.x, c.z, 3);
      if (!p) continue;
      // Stay on our connected landmass (avoids shoreline dead-ends when a goal is cut off).
      if (home && nav.region[p.k] !== home) continue;
      // Never pick a beach-edge goal — A* would still path there and the hull can slide in.
      if (nav.clearance[p.k] < MIN_CLEAR) continue;
      const travel = Math.hypot(p.x - pos.x, p.z - pos.z);
      const dE = Math.hypot(p.x - known.x, p.z - known.z);
      if (dE < 12) continue;
      let s = travel + Math.abs(dE - pref) * prefW + (c.bias ?? 0);
      if (towardPenalty) {
        const toward = ((p.x - pos.x) * (known.x - pos.x) + (p.z - pos.z) * (known.z - pos.z)) / ((travel || 1) * dK);
        if (toward > 0.3) s += towardPenalty * toward;
      }
      scored.push({ x: p.x, z: p.z, s });
    }
    scored.sort((a, b) => a.s - b.s);
    if (hidden === undefined) return scored[0] ?? null;
    let tests = 0;
    for (const c of scored) {
      if (tests++ >= maxTests) break;
      if (this._seenFromKnown(c.x, c.z) !== hidden) return c;
    }
    return null;
  }

  /** Behind a boulder (on the far side from the enemy) or any terrain fold that hides the turret. */
  _coverSpot(pref) {
    const { known, pos } = this;
    const c = [];
    for (const r of this.coverRocks) {
      if (Math.hypot(r.x - pos.x, r.z - pos.z) > 80) continue;
      const ax = r.x - known.x, az = r.z - known.z, al = Math.hypot(ax, az) || 1;
      for (const off of [0, 0.5, -0.5]) {
        const cs = Math.cos(off), sn = Math.sin(off);
        const dx = (ax * cs - az * sn) / al, dz = (ax * sn + az * cs) / al;
        // rock extent along that direction (ellipse through the half-extents)
        const yc = Math.cos(r.yaw), ys = Math.sin(r.yaw);
        const lx = dx * yc - dz * ys, lz = dx * ys + dz * yc;
        const ext = 1 / Math.sqrt((lx / r.hx) ** 2 + (lz / r.hz) ** 2);
        c.push({ x: r.x + dx * (ext + 4.5), z: r.z + dz * (ext + 4.5), bias: -4 });
      }
    }
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, d = rnd(10, 40);
      c.push({ x: pos.x + Math.cos(a) * d, z: pos.z + Math.sin(a) * d });
    }
    return this._bestSpot(c, { hidden: true, pref, towardPenalty: this.mood === 'hunter' ? 0 : 30 });
  }

  /** The smallest move out of cover that regains a sight line. */
  _peekSpot(pref) {
    const { pos } = this;
    const c = [];
    for (const rad of [5, 9, 14]) {
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + rad;
        c.push({ x: pos.x + Math.cos(a) * rad, z: pos.z + Math.sin(a) * rad });
      }
    }
    return this._bestSpot(c, { hidden: false, pref, prefW: 0.15, maxTests: 30 });
  }

  /** Swing round the enemy's side, ending somewhere it can't currently see. */
  _flankSpot(pref) {
    const { known, pos } = this;
    const b = Math.atan2(pos.z - known.z, pos.x - known.x);
    const c = [];
    for (const off of [1.0, 1.4, 1.8]) {
      for (const rf of [0.75, 1]) {
        const a = b + this.side * off;
        c.push({ x: known.x + Math.cos(a) * pref * rf, z: known.z + Math.sin(a) * pref * rf });
      }
    }
    return this._bestSpot(c, { hidden: true, pref, maxTests: 6 }) ?? this._bestSpot(c, { pref });
  }

  /** Close to engagement range from an angle — never straight down the enemy's line. */
  _approachSpot(pref) {
    const { known, pos } = this;
    const b = Math.atan2(pos.z - known.z, pos.x - known.x);
    const c = [];
    for (const off of [-0.9, -0.45, 0, 0.45, 0.9]) {
      const a = b + off * this.side;
      c.push({ x: known.x + Math.cos(a) * pref * 0.9, z: known.z + Math.sin(a) * pref * 0.9, bias: off === 0 ? 8 : 0 });
    }
    const sneaky = this.mood !== 'hunter' ? this._bestSpot(c, { hidden: true, pref, maxTests: 5 }) : null;
    return sneaky ?? this._bestSpot(c, { pref });
  }

  /** A lap around the spawn anchor. Stays on the same landmass, off the beach. */
  _patrolSpot() {
    const { nav, anchor, pos } = this;
    const home = nav.regionAt(anchor.x, anchor.z);
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = rnd(...this.patrolR);
      const p = nav.nearestOpen(anchor.x + Math.cos(a) * d, anchor.z + Math.sin(a) * d, 4);
      if (!p || nav.clearance[p.k] < MIN_CLEAR) continue;
      if (home && nav.region[p.k] !== home) continue;
      if (Math.hypot(p.x - pos.x, p.z - pos.z) < 12) continue;
      return { x: p.x, z: p.z };
    }
    return null;
  }

  /** No cover in reach: weave across the line of fire. */
  _weaveSpot() {
    const { known, pos, nav } = this;
    const ax = known.x - pos.x, az = known.z - pos.z, al = Math.hypot(ax, az) || 1;
    this.weaveSign = -this.weaveSign;
    const px = (-az / al) * this.weaveSign, pz = (ax / al) * this.weaveSign;
    const p = nav.nearestOpen(pos.x + px * 16 - (ax / al) * 4, pos.z + pz * 16 - (az / al) * 4, 4);
    if (!p || nav.clearance[p.k] < MIN_CLEAR) return null;
    return { x: p.x, z: p.z };
  }

  // ------------------------------------------------------------------ decisions
  _setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.modeT = 0;
    this.spot = null;
    this.holdT = 0;
    if (mode === 'cover') this.hideFor = rnd(...MOODS[this.mood].hide);
  }

  _think() {
    const mood = this.mood;
    const m = MOODS[mood];
    if (this.visible) this.closeIn = 1;
    const pref = (m.range[0] + m.range[1]) / 2 * this.closeIn;
    const { known } = this;
    const loaded = this.tank.reload <= 0;
    const dE = this.pos.distanceTo(this.enemyPos);
    this.hurry = false;
    this.speedScale = 1;
    this.face = this.alerted ? { x: known.x, z: known.z } : null;

    // You just fired and we're loaded: punish the reload window (unless we're the one losing).
    if (this.visible && loaded && this.enemy.reload > 0.9 && mood !== 'cautious' && this.mode !== 'engage') {
      this._setMode('engage');
    }

    switch (this.mode) {
      case 'patrol': {
        if (this.visible) { this._setMode('engage'); break; }
        if (this.alerted) { this._setMode('hunt'); break; }
        if (this.arrived && this.spot) {
          this.holdT += THINK_EVERY;
          if (this.holdT < 1.8) break;
        }
        if (!this.spot || this.arrived || this.modeT > 24) {
          this.spot = this._patrolSpot();
          this.holdT = 0;
          this.modeT = 0;
        }
        if (this.spot) {
          this._goTo(this.spot);
          this.face = this.spot;
        }
        break;
      }
      case 'hunt': {
        if (this.visible) { this._setMode('engage'); break; }
        // only re-pick when the intel has genuinely moved, so the route doesn't flip-flop
        const b = this.spotBasis;
        if (!this.spot || !b || Math.hypot(known.x - b.x, known.z - b.z) > 15 || this.modeT > 20) {
          this.spot = this._approachSpot(pref);
          this.spotBasis = { x: known.x, z: known.z };
          this.modeT = 0;
        }
        if (!this.spot) { this._setMode('flank'); break; }
        this._goTo(this.spot);
        if (this.arrived) this._setMode('peek');
        break;
      }
      case 'engage': {
        if (!this.visible) {
          if (this.unseenFor > 1.0) this._setMode(!loaded ? 'cover' : mood === 'hunter' ? 'hunt' : 'peek');
          break;
        }
        if (dE > m.range[1]) {
          if (!this.spot || this.modeT > 4) { this.spot = this._approachSpot(pref); this.modeT = 0; }
          if (this.spot) this._goTo(this.spot);
        } else if (dE < m.range[0] * 0.6 && mood !== 'hunter') {
          this._setMode('cover');
          break;
        } else {
          this._stop();   // hold still for a steadier shot
        }
        if (this.blockedT > 2) {
          this.blockedT = 0;
          this._setMode('peek');
        }
        break;
      }
      case 'cover': {
        if (!this.spot) {
          this.spot = this._coverSpot(pref);
          if (!this.spot) { this._setMode('evade'); break; }
        }
        this.hurry = true;
        this._goTo(this.spot);
        if (this.arrived) {
          this.holdT += THINK_EVERY;
          if (this.visible && this.seenFor > 0.8) {
            if (loaded) this._setMode('engage');
            else this.spot = null;   // spot is compromised, find another
          } else if (loaded && this.holdT > this.hideFor) {
            this._setMode('peek');
          }
        }
        if (this.modeT > 14) this._setMode('peek');
        break;
      }
      case 'peek': {
        const giveUp = () => { this._blind(); this._setMode(Math.random() < 0.35 ? 'flank' : 'hunt'); };
        if (!this.spot) {
          this.spot = this._peekSpot(pref);
          if (!this.spot) { giveUp(); break; }
        }
        this.speedScale = 0.6;
        this._goTo(this.spot);
        if (this.visible && this.seenFor > 0.15) this._setMode('engage');
        else if ((this.arrived && this.modeT > 2) || this.modeT > 8) giveUp();
        break;
      }
      case 'flank': {
        if (!this.spot) {
          this.side = -this.side;
          this.spot = this._flankSpot(pref) ?? this._approachSpot(pref);
          if (!this.spot) { this._setMode('hunt'); break; }
        }
        this.hurry = this.visible;
        this._goTo(this.spot);
        if (this.visible && loaded && this.seenFor > 0.3) this._setMode('engage');
        else if (this.arrived) this._setMode('peek');
        else if (this.modeT > 18) { this._blind(); this._setMode('hunt'); }
        break;
      }
      case 'evade': {
        if (!this.spot || this.holdT > 2.2) {
          this.spot = this._weaveSpot();
          this.holdT = 0;
        }
        this.holdT += THINK_EVERY;
        this.hurry = true;
        if (this.spot) this._goTo(this.spot);
        if (loaded) this._setMode(this.visible ? 'engage' : 'hunt');
        break;
      }
    }
  }

  // ------------------------------------------------------------------ driving
  /** True if the hull centre this far along body +X sits on dry, open ground. */
  _dryAlong(fx, fz, dist, minClear = 2) {
    const { pos, nav } = this;
    const x = pos.x + fx * dist, z = pos.z + fz * dist;
    return nav.passable(x, z) && nav.clearanceAt(x, z) >= minClear;
  }

  /** Furthest path point within LOOKAHEAD that still has a passable straight line from here. */
  _lookTarget(P) {
    const { pos, nav } = this;
    let t = P[Math.min(this.wp, P.length - 1)];
    for (let i = this.wp; i < P.length; i++) {
      const p = P[i];
      if (!nav._lineOk(pos.x, pos.z, p.x, p.z, null, 0)) break;
      t = p;
      if (Math.hypot(p.x - pos.x, p.z - pos.z) >= LOOKAHEAD) break;
    }
    return t;
  }

  _steer(dt) {
    const d = this.drive;
    d.boost = false;
    if (this.unstickT > 0) {
      this.unstickT -= dt;
      // Never reverse into water while unsticking.
      _v.set(1, 0, 0).applyQuaternion(_q.copy(this.tank.body.rotation()));
      if (!this._dryAlong(-_v.x, -_v.z, 4, 1.5)) {
        this.unstickT = 0;
        this.pathGoal = null;
        d.throttle = 0;
        d.turn = 0;
        return;
      }
      d.throttle = -0.8;
      d.turn = this.unstickTurn;
      return;
    }
    const { pos, nav } = this;
    let thr = 0, turn = 0;
    const P = this.path;

    // Near water / blocked ground: crawl back inland before the hull slides in.
    if (!nav.passable(pos.x, pos.z) || nav.clearanceAt(pos.x, pos.z) < 2.5) {
      const safe = nav.nearestOpen(pos.x, pos.z, 12);
      if (safe) {
        const want = yawOf(safe.x - pos.x, safe.z - pos.z);
        const err = wrap(want - this.yaw);
        turn = THREE.MathUtils.clamp(-err * 2.2, -1, 1);
        _v.set(1, 0, 0).applyQuaternion(_q.copy(this.tank.body.rotation()));
        const towardDry = this._dryAlong(_v.x, _v.z, 4, 2);
        thr = Math.abs(err) > 1.0 ? (towardDry ? 0 : -0.6) : (towardDry ? 0.7 : -0.5);
        d.throttle = thr;
        d.turn = turn;
        return;
      }
    }

    if (P.length && !this.arrived) {
      // advance past waypoints we've reached or driven beyond
      while (this.wp < P.length - 1) {
        const a = P[this.wp];
        const prev = P[this.wp - 1] ?? pos;
        const passed = (pos.x - a.x) * (a.x - prev.x) + (pos.z - a.z) * (a.z - prev.z) > 0;
        if (Math.hypot(a.x - pos.x, a.z - pos.z) < 4 || passed) this.wp++;
        else break;
      }
      const end = P[P.length - 1];
      const remaining = Math.hypot(end.x - pos.x, end.z - pos.z);
      // Incomplete routes end at the shore facing an unreachable goal — bail early, don't nose in.
      if (!this.pathReached && remaining < 14 && nav.clearanceAt(end.x, end.z) < MIN_CLEAR) {
        this.pathGoal = null;
        this.spot = null;
        this.arrived = false;
        this.path = [];
      } else if (remaining < ARRIVE_R) {
        this.arrived = this.pathReached !== false;
        if (!this.arrived) {
          this.pathGoal = null;
          this.spot = null;
        }
      } else {
        const t = this._lookTarget(P);
        const want = yawOf(t.x - pos.x, t.z - pos.z);
        const err = wrap(want - this.yaw);
        const a = Math.abs(err);
        if (a > 2.2 && remaining < 18) {
          // target close behind: back up to it rather than a slow about-turn
          turn = THREE.MathUtils.clamp(-wrap(want - this.yaw - Math.PI) * 2.2, -1, 1);
          thr = -0.7;
        } else {
          // skid-steer pivots crawl (~0.4 rad/s); a rolling arc turns ~3× faster
          turn = THREE.MathUtils.clamp(-err * 2.2, -1, 1);
          thr = a > 1.0 ? 0.35 : THREE.MathUtils.clamp(1.15 - a, 0.35, 1);
          thr *= THREE.MathUtils.clamp(remaining / 12, 0.5, 1) * this.speedScale;
          d.boost = this.hurry && a < 0.3 && remaining > 15;
        }
      }
    }
    if (this.arrived && this.face) {
      const err = wrap(yawOf(this.face.x - pos.x, this.face.z - pos.z) - this.yaw);
      if (Math.abs(err) > 0.3) turn = THREE.MathUtils.clamp(-err * 1.4, -0.7, 0.7);
    }
    // don't ram the other tank
    const ex = this.enemyPos.x - pos.x, ez = this.enemyPos.z - pos.z;
    if (thr > 0 && Math.hypot(ex, ez) < 11) {
      const be = wrap(yawOf(ex, ez) - this.yaw);
      if (Math.abs(be) < 0.7) {
        thr = Math.min(thr, 0.15);
        turn = be > 0 ? 1 : -1;
      }
    }
    // Hard water gate: never drive forward into wet / blocked ground.
    if (thr > 0) {
      _v.set(1, 0, 0).applyQuaternion(_q.copy(this.tank.body.rotation()));
      let wetAhead = false;
      for (const dist of WATER_PROBE) {
        if (!this._dryAlong(_v.x, _v.z, dist, 2)) { wetAhead = true; break; }
      }
      if (wetAhead) {
        d.boost = false;
        const safe = nav.nearestOpen(pos.x + _v.x * 2, pos.z + _v.z * 2, 14)
          ?? nav.nearestOpen(pos.x, pos.z, 14);
        if (safe) {
          const want = yawOf(safe.x - pos.x, safe.z - pos.z);
          const err = wrap(want - this.yaw);
          turn = THREE.MathUtils.clamp(-err * 2.4, -1, 1);
          thr = Math.abs(err) > 0.7 ? 0 : (this._dryAlong(_v.x, _v.z, 4, 2) ? 0.35 : -0.55);
        } else {
          thr = -0.6;
        }
        // Drop the route once so the next think picks an inland goal.
        if (this.pathGoal) { this.pathGoal = null; this.spot = null; this.path = []; }
      }
    }
    // following a path but neither moving nor turning (wedged on a crate, slope or hull) →
    // back out with a twist, then replan
    this.progT += dt;
    if (this.progT > 2) {
      const moved = Math.hypot(pos.x - this.progX, pos.z - this.progZ);
      const turned = Math.abs(wrap(this.yaw - this.progYaw));
      if (P.length && !this.arrived && moved < 1.2 && turned < 0.35) {
        _v.set(1, 0, 0).applyQuaternion(_q.copy(this.tank.body.rotation()));
        // Prefer reversing away from water / blocked ground when unsticking.
        const fwd = this._dryAlong(_v.x, _v.z, 4, 1.5);
        const back = this._dryAlong(-_v.x, -_v.z, 4, 1.5);
        nav.penalize(pos.x + _v.x * 4, pos.z + _v.z * 4);
        this.unstickT = 1.3;
        this.unstickTurn = Math.random() < 0.5 ? -1 : 1;
        if (!back && fwd) this.unstickT = 0; // don't reverse into water — replan instead
        this.pathGoal = null;
      }
      this.progT = 0;
      this.progX = pos.x;
      this.progZ = pos.z;
      this.progYaw = this.yaw;
    }
    d.throttle = thr;
    d.turn = turn;
  }

  _flipCheck(dt) {
    _v.set(0, 1, 0).applyQuaternion(_q.copy(this.tank.body.rotation()));
    this.flipT = _v.y < 0.35 ? this.flipT + dt : 0;
    if (this.flipT > 2.5) {
      this.flipT = 0;
      this.tank.reset(heightAt);
    }
  }

  // ------------------------------------------------------------------ gunnery
  _aim(dt) {
    if (!this.visible) {
      if (!this.alerted) {
        this.aimPoint.set(
          this.pos.x + Math.cos(this.yaw) * 40,
          this.pos.y + HULL_H,
          this.pos.z - Math.sin(this.yaw) * 40,
        );
        return;
      }
      this.aimPoint.set(this.known.x, this.known.eyeY - EYE_H + HULL_H, this.known.z);
      return;
    }
    const ev = this.enemy.body.linvel();
    const tgt = _t.set(this.enemyPos.x, this.enemyPos.y + this.aimH, this.enemyPos.z);
    const dist = this.pos.distanceTo(tgt);
    const tof = dist / SHELL_SPEED;
    this.jitterT -= dt;
    if (this.jitterT <= 0) {
      this.jitterT = rnd(0.35, 0.6);
      const mySpd = Math.abs(this.tank.forwardSpeed()), eSpd = Math.hypot(ev.x, ev.z);
      // Wider when either tank moves, right after acquiring, and at range; settles while held.
      const spread = (BASE_SPREAD + 0.3 * mySpd + 0.22 * eSpd)
        * (RANGING[this.shotsAt] ?? 1)
        * (1 + 2.5 * Math.exp(-this.seenFor / 0.9))
        * THREE.MathUtils.clamp(dist / 60, 0.5, 1.8);
      this.jitterTarget.randomDirection().multiplyScalar(spread * Math.cbrt(Math.random()));
      this.jitterTarget.y *= 0.5;
      this.leadK = rnd(0.55, 1.1);   // misjudges your speed a bit — keep moving!
    }
    this.jitter.lerp(this.jitterTarget, 1 - Math.exp(-4 * dt));
    this.aimPoint.copy(tgt).addScaledVector(ev, tof * this.leadK).add(this.jitter);
    this.aimPoint.y += 0.5 * GRAVITY * tof * tof;
  }

  _trigger(dt) {
    this.cooldown -= dt;
    if (!this.visible || !this.enemy.alive || this.tank.reload > 0 || this.cooldown > 0) return;
    if (this.seenFor < this.reactT) return;
    const { pos, dir } = this.tank.muzzle();
    const to = _t.copy(this.aimPoint).sub(pos);
    const dist = to.length();
    if (dir.angleTo(to) > 0.022) return;
    const r = this.ray;
    r.origin.x = pos.x; r.origin.y = pos.y; r.origin.z = pos.z;
    r.dir.x = dir.x; r.dir.y = dir.y; r.dir.z = dir.z;
    const hit = this.world.castRay(r, dist + 5, true, undefined, undefined, undefined, this.tank.body);
    const clear = !hit || hit.collider.parent()?.handle === this.enemy.body.handle || hit.timeOfImpact > dist - 2.5;
    if (clear) {
      this.wantsFire = true;
      this.blockedT = 0;
    } else {
      this.blockedT += dt;
    }
  }

  /**
   * Occasional .50 bursts while the main gun reloads — not every reload, short sprays
   * when the roof gun is roughly on the player.
   */
  _triggerMg(dt) {
    this.mgCool -= dt;
    if (this.mgBurstT > 0) {
      this.mgBurstT -= dt;
      if (this.visible && this.enemy.alive && this.tank.reload > 0.15) this.wantsMg = true;
      return;
    }
    if (!this.visible || !this.enemy.alive || this.tank.reload <= 0.2) return;
    if (this.mgCool > 0 || this.seenFor < 0.4) return;
    // Skip most reload windows so it stays an accent, not a constant hose
    if (Math.random() > 0.38) {
      this.mgCool = rnd(0.5, 1.2);
      return;
    }
    const { pos, dir } = this.tank.mgMuzzle();
    const to = _t.set(this.enemyPos.x, this.enemyPos.y + this.aimH, this.enemyPos.z).sub(pos);
    if (to.lengthSq() < 1 || dir.angleTo(to) > 0.4) {
      this.mgCool = rnd(0.25, 0.6);
      return;
    }
    this.mgBurstT = rnd(0.35, 0.85);
    this.mgCool = rnd(1.4, 2.8);
    this.wantsMg = true;
  }
}
