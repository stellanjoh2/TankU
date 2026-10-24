// Enemy coastal patrol boat: scouts the water, spots the tank, MG bursts, sinks on a shell.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SIZE, WATER_Y, PORT, shoreSigned, onBridge } from './terrain.js';
import { pickLod } from './lod.js';
import { applyBurntMetal } from './burntMetal.js';

const HULL = 'PatrolBoat';
const TURRET = 'FrontTurret';
const LOD_EDGES = [45, 100];
const LOD_LEVELS = LOD_EDGES.length + 1;
const CULL_DIST = 240;

const SHORE_MIN = 5;          // no hull point closer than this (m)
const OFFSHORE_MAX = 42;      // stay a coastal scout, not a blue-water wanderer
const BRIDGE_PAD = 6;
const HX = 5.25;              // half-length
const HZ = 1.48;              // half-beam
const HY = 1.55;              // collider half-height about the waterline (covers cabin / MG)
const BOW = 5.2;
const STERN = 5.4;

const CRUISE = 6.4;           // m/s
const TURN = 1.05;            // hull rad/s — always smoothed, never snapped
const TURRET_YAW = THREE.MathUtils.degToRad(80);
const TURRET_PITCH = THREE.MathUtils.degToRad(25);
const PITCH_MIN = THREE.MathUtils.degToRad(-8);
const PITCH_MAX = THREE.MathUtils.degToRad(18);
const SIGHT = 115;
const EYE_H = 2.16;           // turret roof
const TANK_HULL_H = 1.3;
const TANK_EYE_H = 2.3;
const LOSE_T = 2.4;
const FIRE_SLOT0 = 4;
const SINK_T = 7.5;
const SINK_DEPTH = 4.4;
// Same brake-light red as Tank.flashHit.
const HIT_RGB = [1.0, 0.04, 0.02];
const HIT_GLOW = 18;

const PASS_RANGE = 26;       // start arcing around another hull
const PASS_PAD = 1.8;         // water kept between hull boxes

const SPAWNS = [
  { x: PORT.x1 + 22, z: -10, yaw: -Math.PI / 2 }, // east bay, heading south
  { x: -136, z: 80, yaw: Math.PI / 2 },           // northwest coast, heading north
  { x: 10, z: 136, yaw: Math.PI },                // north coast, heading west — off the satellite
];

const rnd = (a, b) => a + Math.random() * (b - a);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const yawOf = (dx, dz) => Math.atan2(-dz, dx);
const fwdX = (yaw) => Math.cos(yaw);
const fwdZ = (yaw) => -Math.sin(yaw);

const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _spray = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fireAt = new THREE.Vector3();
const _ray = { origin: { x: 0, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 } };

function blenderToThree(v) {
  // GLB extras stay in Blender axes (+X fwd, +Y left, +Z up).
  return new THREE.Vector3(v[0], v[2], -(v[1] ?? 0));
}

function inMap(x, z) {
  const lim = SIZE * 0.5 - 12;
  return Math.abs(x) < lim && Math.abs(z) < lim;
}

function hullPoints(x, z, yaw) {
  const fx = fwdX(yaw), fz = fwdZ(yaw);
  const px = -fz, pz = fx;
  return [
    [x, z],
    [x + fx * BOW, z + fz * BOW],
    [x - fx * STERN, z - fz * STERN],
    [x + px * HZ, z + pz * HZ],
    [x - px * HZ, z - pz * HZ],
  ];
}

function waterOk(x, z) {
  if (!inMap(x, z)) return false;
  const s = shoreSigned(x, z);
  if (s > -SHORE_MIN || s < -OFFSHORE_MAX) return false;
  if (onBridge(x, z, BRIDGE_PAD)) return false;
  return true;
}

function poseOk(x, z, yaw) {
  if (!waterOk(x, z)) return false;
  for (const [px, pz] of hullPoints(x, z, yaw)) {
    if (shoreSigned(px, pz) > -SHORE_MIN) return false;
    if (onBridge(px, pz, 4)) return false;
  }
  return true;
}

/** True when two hull boxes would touch, including a pad of open water. */
function hullsOverlap(x, z, yaw, o, pad) {
  const dx = o.x - x, dz = o.z - z;
  const aFwd = [Math.cos(yaw), -Math.sin(yaw)];
  const aRight = [Math.sin(yaw), Math.cos(yaw)];
  const bFwd = [Math.cos(o.yaw), -Math.sin(o.yaw)];
  const bRight = [Math.sin(o.yaw), Math.cos(o.yaw)];
  for (const [ax, az] of [aFwd, aRight, bFwd, bRight]) {
    const dist = Math.abs(dx * ax + dz * az);
    const ext =
      Math.abs(aFwd[0] * ax + aFwd[1] * az) * HX +
      Math.abs(aRight[0] * ax + aRight[1] * az) * HZ +
      Math.abs(bFwd[0] * ax + bFwd[1] * az) * HX +
      Math.abs(bRight[0] * ax + bRight[1] * az) * HZ;
    if (dist > ext + pad) return false;
  }
  return true;
}

function shoreOut(x, z) {
  const e = 1.6;
  const dx = shoreSigned(x + e, z) - shoreSigned(x - e, z);
  const dz = shoreSigned(x, z + e) - shoreSigned(x, z - e);
  const l = Math.hypot(dx, dz) || 1;
  return { x: -dx / l, z: -dz / l };
}

function fitPose(x, z, yaw) {
  for (let i = 0; i < 10; i++) {
    if (poseOk(x, z, yaw)) return { x, z };
    const n = shoreOut(x, z);
    x += n.x * 1.4;
    z += n.z * 1.4;
  }
  return poseOk(x, z, yaw) ? { x, z } : null;
}

function take(src, name) {
  const o = src.getObjectByName(name);
  if (!o) throw new Error(`[patrolBoat] missing ${name}`);
  o.removeFromParent();
  o.position.set(0, 0, 0);
  o.rotation.set(0, 0, 0);
  o.scale.set(1, 1, 1);
  return o;
}

function prepMesh(root, lod) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = lod < 2;
    o.receiveShadow = false;
    if (lod > 0) o.raycast = () => {};
    for (const m of [].concat(o.material).filter(Boolean)) {
      m.transparent = false;
      m.opacity = 1;
      m.depthWrite = true;
      m.side = THREE.FrontSide;
      m.envMapIntensity = 0.55;
    }
  });
}

function makeWake() {
  const group = new THREE.Group();
  group.name = 'BoatWake';
  const mat = new THREE.MeshBasicMaterial({
    color: 0xd8eef4,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // Pivot on the forward edge. Yaw then flares the tail only, so the two
  // side streaks open into a V instead of crossing behind the stern.
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(-0.5, 0, 0);
  const strip = (name) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.position.y = 0.04;
    m.renderOrder = 1;
    group.add(m);
    return m;
  };
  return {
    group,
    mat,
    center: strip('WakeCenter'),
    left: strip('WakeL'),
    right: strip('WakeR'),
  };
}

function approachAngle(cur, target, maxStep) {
  const d = wrap(target - cur);
  return cur + THREE.MathUtils.clamp(d, -maxStep, maxStep);
}

function findSpawn(hint) {
  if (poseOk(hint.x, hint.z, hint.yaw)) return { ...hint };
  for (let i = 0; i < 80; i++) {
    const a = (i / 80) * Math.PI * 2;
    const r = 16 + (i % 8) * 3;
    const x = hint.x + Math.cos(a) * r;
    const z = hint.z + Math.sin(a) * r;
    if (poseOk(x, z, hint.yaw)) return { x, z, yaw: hint.yaw };
  }
  return { ...hint };
}

function instance(src) {
  const o = src.clone(true);
  o.traverse((c) => {
    if (!c.isMesh) return;
    c.material = Array.isArray(c.material) ? c.material.map((m) => m.clone()) : c.material.clone();
  });
  o.position.set(0, 0, 0);
  o.rotation.set(0, 0, 0);
  o.scale.set(1, 1, 1);
  o.visible = false;
  return o;
}

function createBoat({ RAPIER, world, scene, hullSrc, turSrc, muzzleLocal, spawnHint, fireSlot, name, fleet }) {
  const spawn = findSpawn(spawnHint);
  const hulls = hullSrc.map(instance);
  const turs = turSrc.map(instance);

  const root = new THREE.Group();
  root.name = name;

  const hullPivot = new THREE.Group();
  hullPivot.name = 'Hull';
  for (const h of hulls) hullPivot.add(h);
  root.add(hullPivot);

  const turret = new THREE.Group();
  turret.name = TURRET;
  turret.position.set(3.35, 1.18, 0);
  for (const t of turs) turret.add(t);
  root.add(turret);

  const flashMats = [];
  for (const rootMesh of [...hulls, ...turs]) {
    rootMesh.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material).filter(Boolean)) {
        if (!m.emissive || flashMats.includes(m)) continue;
        m.userData._hitEmit = m.emissive.clone();
        m.userData._hitEmitI = m.emissiveIntensity ?? 1;
        flashMats.push(m);
      }
    });
  }

  const wake = makeWake();
  root.add(wake.group);
  scene.add(root);

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(spawn.x, WATER_Y, spawn.z)
      .setRotation(_q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spawn.yaw))
      .setUserData({ mat: 'metal' }),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(HX, HY, HZ)
      .setTranslation(0, 0.85, 0)
      .setFriction(0.4),
    body,
  );

  const ray = new RAPIER.Ray(_ray.origin, _ray.dir);
  let lod = -2;
  const lodScale = 1;

  const boat = {
    root,
    body,
    firing: false,
    alive: true,
    x: spawn.x,
    z: spawn.z,
    yaw: spawn.yaw,
    speed: 0,
    mode: 'patrol',
    goal: null,
    visible: false,
    seenFor: 0,
    unseenFor: 99,
    reactT: 0,
    burstT: 0,
    burstBiasX: 0,
    burstBiasY: 0,
    burstWalk: 0,
    coolT: rnd(0.6, 1.4),
    sinkT: 0,
    sinkSign: 1,
    burned: false,
    hitFlashFrames: 0,
    thinkT: 0,
    stuckT: 0,
    lastX: spawn.x,
    lastZ: spawn.z,
    broadside: 0,
    ping: null,
  };
  fleet.push(boat);

  function setLod(level) {
    if (lod === level) return;
    lod = level;
    const show = level >= 0;
    for (let i = 0; i < LOD_LEVELS; i++) {
      const on = show && i === level;
      hulls[i].visible = on;
      turs[i].visible = on;
    }
  }

  function poseBody() {
    _e.set(0, boat.yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    body.setNextKinematicTranslation({ x: boat.x, y: WATER_Y, z: boat.z });
    body.setNextKinematicRotation(_q);
    root.position.set(boat.x, WATER_Y, boat.z);
    root.quaternion.copy(_q);
  }

  function blocked(x, z, yaw, dist) {
    const fx = fwdX(yaw), fz = fwdZ(yaw);
    const ox = x + fx * (BOW - 0.4);
    const oz = z + fz * (BOW - 0.4);
    ray.dir.x = fx;
    ray.dir.y = 0;
    ray.dir.z = fz;
    const reach = dist + 1.6;
    for (const hy of [0.85, 2.05]) {
      ray.origin.x = ox;
      ray.origin.y = WATER_Y + hy;
      ray.origin.z = oz;
      const hit = world.castRay(ray, reach, true, undefined, undefined, undefined, body);
      if (hit && hit.timeOfImpact < dist + 1.2) return true;
    }
    return false;
  }

  function tryStep(x, z, yaw, dist) {
    const nx = x + fwdX(yaw) * dist;
    const nz = z + fwdZ(yaw) * dist;
    if (!poseOk(nx, nz, yaw)) return null;
    if (blocked(x, z, yaw, dist)) return null;
    for (const o of fleet) {
      if (o !== boat && hullsOverlap(nx, nz, yaw, o, PASS_PAD)) return null;
    }
    return { x: nx, z: nz };
  }

  // Steer off another hull before the boxes meet. Head-on, both go to starboard.
  function boatAvoid(wantYaw) {
    let bias = 0;
    let prefer = 1;
    let nearest = Infinity;
    const c = Math.cos(boat.yaw), s = Math.sin(boat.yaw);
    for (const o of fleet) {
      if (o === boat) continue;
      const dx = o.x - boat.x, dz = o.z - boat.z;
      const dist = Math.hypot(dx, dz);
      if (dist > PASS_RANGE || dist < 1e-3) continue;
      const ahead = dx * c - dz * s;
      const lateral = dx * s + dz * c;
      if (ahead < -HX) continue;
      if (ahead < BOW && Math.abs(lateral) > 7) continue;
      const headOn = ahead > 0 && Math.abs(lateral) < 4;
      const turn = headOn ? -1 : (Math.sign(lateral) || -1);
      const urgency = THREE.MathUtils.clamp((PASS_RANGE - dist) / PASS_RANGE, 0, 1);
      bias += turn * (0.5 + 0.75 * urgency);
      if (dist < nearest) { nearest = dist; prefer = turn; }
    }
    if (nearest === Infinity) return { yaw: wantYaw, prefer };
    return { yaw: wantYaw + THREE.MathUtils.clamp(bias, -1.2, 1.2), prefer };
  }

  function pickGoal() {
    for (let i = 0; i < 50; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = rnd(28, 70);
      const x = boat.x + Math.cos(a) * d;
      const z = boat.z + Math.sin(a) * d;
      if (waterOk(x, z) && poseOk(x, z, yawOf(x - boat.x, z - boat.z))) return { x, z };
    }
    const n = shoreOut(boat.x, boat.z);
    return { x: boat.x + n.x * 20, z: boat.z + n.z * 20 };
  }

  function los(player) {
    if (!player?.alive) return false;
    const e = player.body.translation();
    const dx = e.x - boat.x, dz = e.z - boat.z;
    if (Math.hypot(dx, dz) > SIGHT) return false;
    const ax = boat.x, ay = WATER_Y + EYE_H, az = boat.z;
    const hull = clear(ax, ay, az, e.x, e.y + TANK_HULL_H, e.z, player);
    return hull || clear(ax, ay, az, e.x, e.y + TANK_EYE_H, e.z, player);
  }

  function clear(ax, ay, az, bx, by, bz, player) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return true;
    ray.origin.x = ax; ray.origin.y = ay; ray.origin.z = az;
    ray.dir.x = dx / len; ray.dir.y = dy / len; ray.dir.z = dz / len;
    const hit = world.castRay(ray, len, true, undefined, undefined, undefined, body);
    if (!hit) return true;
    if (hit.collider.parent()?.handle === player.body.handle) return true;
    return hit.timeOfImpact > len - 0.45;
  }

  function aimTurret(dt, player) {
    if (!player?.alive || !boat.visible) {
      turret.rotation.y = approachAngle(turret.rotation.y, 0, TURRET_YAW * dt);
      turret.rotation.z = approachAngle(turret.rotation.z, 0, TURRET_PITCH * dt);
      return;
    }
    const e = player.body.translation();
    root.updateMatrixWorld(true);
    _aim.set(e.x, e.y + TANK_HULL_H, e.z);
    const local = turret.parent.worldToLocal(_aim.clone());
    const yaw = Math.atan2(-(local.z - turret.position.z), local.x - turret.position.x);
    turret.rotation.y = approachAngle(turret.rotation.y, yaw, TURRET_YAW * dt);
    turret.updateMatrixWorld(true);
    const g = turret.worldToLocal(_aim.clone());
    const elev = THREE.MathUtils.clamp(Math.atan2(g.y, Math.hypot(g.x, g.z)), PITCH_MIN, PITCH_MAX);
    turret.rotation.z = approachAngle(turret.rotation.z, elev, TURRET_PITCH * dt);
  }

  function onTarget(player) {
    if (!player?.alive) return false;
    const { pos, dir } = mgMuzzle();
    const e = player.body.translation();
    _aim.set(e.x, e.y + TANK_HULL_H, e.z).sub(pos);
    if (_aim.lengthSq() < 1) return false;
    return dir.angleTo(_aim) < 0.16;
  }

  function startBurst() {
    const side = Math.random() < 0.5 ? 1 : -1;
    if (Math.random() < 0.55) {
      // Most of the burst walks past (whoosh).
      boat.burstBiasX = side * rnd(0.03, 0.06);
      boat.burstBiasY = rnd(-0.03, 0.035);
      boat.burstWalk = side * rnd(0.09, 0.16);
    } else {
      // Held near the hull — about half the rounds clip.
      boat.burstBiasX = side * rnd(0.01, 0.032);
      boat.burstBiasY = rnd(-0.018, 0.022);
      boat.burstWalk = 0;
    }
  }

  function sprayDir(dir) {
    const up = Math.abs(dir.y) > 0.92 ? _up.set(1, 0, 0) : _up.set(0, 1, 0);
    _right.crossVectors(dir, up).normalize();
    _up.crossVectors(_right, dir).normalize();
    return _spray.copy(dir)
      .addScaledVector(_right, boat.burstBiasX + rnd(-0.016, 0.016))
      .addScaledVector(_up, boat.burstBiasY + rnd(-0.014, 0.014))
      .normalize();
  }

  function triggerMg(dt, player) {
    boat.firing = false;
    if (!boat.alive || !boat.visible || !player?.alive) {
      boat.burstT = 0;
      return;
    }
    if (boat.seenFor < boat.reactT) return;
    if (boat.burstT > 0) {
      boat.burstT -= dt;
      boat.burstBiasX += boat.burstWalk * dt;
      if (onTarget(player)) boat.firing = true;
      return;
    }
    boat.coolT -= dt;
    if (boat.coolT > 0 || !onTarget(player)) return;
    startBurst();
    boat.burstT = rnd(0.4, 0.85);
    boat.coolT = rnd(1.15, 2.3);
    boat.firing = true;
    const e = player.body.translation();
    boat.ping = { x: e.x, z: e.z };
  }

  function drive(dt, wantYaw, throttle) {
    const avoid = boatAvoid(wantYaw);
    let target = avoid.yaw;
    const probe = Math.max(1.2, CRUISE * 0.25);
    if (!tryStep(boat.x, boat.z, target, probe)) {
      let best = null;
      for (let i = 1; i <= 10 && best == null; i++) {
        const off = i * 0.18;
        for (const s of [avoid.prefer, -avoid.prefer]) {
          const y = boat.yaw + s * off;
          if (tryStep(boat.x, boat.z, y, probe)) { best = y; break; }
        }
      }
      if (best != null) target = best;
    }

    const nextYaw = approachAngle(boat.yaw, target, TURN * dt);
    let yawClear = true;
    for (const o of fleet) {
      if (o !== boat && hullsOverlap(boat.x, boat.z, nextYaw, o, PASS_PAD)) yawClear = false;
    }
    if (yawClear) boat.yaw = nextYaw;
    const fitted = fitPose(boat.x, boat.z, boat.yaw);
    if (fitted && !fleet.some((o) => o !== boat && hullsOverlap(fitted.x, fitted.z, boat.yaw, o, PASS_PAD))) {
      boat.x = fitted.x;
      boat.z = fitted.z;
    }

    const dist = CRUISE * THREE.MathUtils.clamp(throttle, 0, 1) * dt;
    boat.speed = 0;
    if (dist <= 1e-4) return;
    const step = tryStep(boat.x, boat.z, boat.yaw, dist);
    if (!step) return;
    boat.x = step.x;
    boat.z = step.z;
    boat.speed = dist / dt;
  }

  function think(player) {
    const saw = los(player);
    const was = boat.visible;
    boat.visible = saw;
    if (saw) {
      if (!was) boat.reactT = rnd(0.35, 0.75);
      boat.seenFor += 0.2;
      boat.unseenFor = 0;
      boat.mode = 'combat';
    } else {
      boat.seenFor = 0;
      boat.unseenFor += 0.2;
      if (boat.mode === 'combat' && boat.unseenFor > LOSE_T) {
        boat.mode = 'patrol';
        boat.goal = null;
        boat.broadside = 0;
      }
    }
    if (boat.mode === 'patrol' && !boat.goal) boat.goal = pickGoal();
    if (boat.goal && Math.hypot(boat.goal.x - boat.x, boat.goal.z - boat.z) < 7) boat.goal = null;
  }

  function updateWake() {
    const k = boat.alive ? THREE.MathUtils.clamp(boat.speed / CRUISE, 0, 1.25) : 0;
    wake.group.visible = k > 0.06;
    if (!wake.group.visible) {
      wake.mat.opacity = 0;
      return;
    }
    const len = 4.5 + k * 13;
    const flare = 0.14 + k * 0.12;
    const beam = 1.05;
    wake.center.position.set(-STERN - 0.2, 0.04, 0);
    wake.center.rotation.y = 0;
    wake.center.scale.set(len * 0.72, 1, 0.36 + k * 0.2);
    wake.left.position.set(-STERN, 0.04, beam);
    wake.left.rotation.y = flare;
    wake.left.scale.set(len, 1, 0.32 + k * 0.12);
    wake.right.position.set(-STERN, 0.04, -beam);
    wake.right.rotation.y = -flare;
    wake.right.scale.set(len, 1, 0.32 + k * 0.12);
    wake.mat.opacity = 0.2 + k * 0.32;
  }

  function applyHitFlash(on) {
    for (const m of flashMats) {
      if (on) {
        m.emissive.setRGB(...HIT_RGB);
        m.emissiveIntensity = HIT_GLOW;
      } else if (m.userData._hitEmit) {
        m.emissive.copy(m.userData._hitEmit);
        m.emissiveIntensity = m.userData._hitEmitI;
      }
    }
  }

  function tickHitFlash() {
    if (boat.hitFlashFrames <= 0) return;
    boat.hitFlashFrames -= 1;
    applyHitFlash(boat.hitFlashFrames > 0);
  }

  function kill() {
    if (!boat.alive) return;
    boat.alive = false;
    boat.firing = false;
    boat.hitFlashFrames = 0;
    applyHitFlash(false);
    boat.sinkT = 0;
    boat.sinkSign = Math.random() < 0.5 ? 1 : -1;
    boat.speed = 0;
    wake.group.visible = false;
    if (!boat.burned) {
      applyBurntMetal(hullPivot);
      applyBurntMetal(turret);
      boat.burned = true;
    }
    setLod(0);
  }

  function updateSink(dt, fx) {
    boat.sinkT += dt;
    const k = THREE.MathUtils.clamp(boat.sinkT / SINK_T, 0, 1);
    const ease = k * k * (3 - 2 * k);
    const y = WATER_Y - ease * SINK_DEPTH;
    _e.set(ease * 0.18, boat.yaw, boat.sinkSign * ease * 0.85, 'YXZ');
    _q.setFromEuler(_e);
    body.setNextKinematicTranslation({ x: boat.x, y, z: boat.z });
    body.setNextKinematicRotation(_q);
    root.position.set(boat.x, y, boat.z);
    root.quaternion.copy(_q);

    const wet = y < WATER_Y - 0.35;
    if (fx) {
      root.updateMatrixWorld(true);
      _fireAt.set(0.4, 1.55, 0).applyMatrix4(root.matrixWorld);
      if (!wet && _fireAt.y > WATER_Y + 0.15) {
        fx.setDamageFire(_fireAt, 4, fireSlot);
        fx.plume(_fireAt, dt);
        fx.burn(_fireAt, dt, 1.15, false);
      } else {
        fx.setDamageFire(null, 0, fireSlot);
      }
    }
  }

  function mgMuzzle() {
    turret.updateWorldMatrix(true, false);
    const pos = turret.localToWorld(muzzleLocal.clone());
    const dir = _dir.set(1, 0, 0).transformDirection(turret.matrixWorld).normalize();
    return { pos, dir };
  }

  function reset(fx) {
    const s = findSpawn(spawnHint);
    boat.alive = true;
    boat.firing = false;
    boat.x = s.x;
    boat.z = s.z;
    boat.yaw = s.yaw;
    boat.speed = 0;
    boat.mode = 'patrol';
    boat.goal = null;
    boat.visible = false;
    boat.seenFor = 0;
    boat.unseenFor = 99;
    boat.burstT = 0;
    boat.coolT = rnd(0.6, 1.4);
    boat.sinkT = 0;
    boat.thinkT = 0;
    boat.stuckT = 0;
    boat.broadside = 0;
    boat.hitFlashFrames = 0;
    boat.ping = null;
    turret.rotation.set(0, 0, 0);
    if (boat.burned) {
      hullPivot.traverse((o) => {
        if (o.isMesh && o.userData._liveMat) o.material = o.userData._liveMat;
      });
      turret.traverse((o) => {
        if (o.isMesh && o.userData._liveMat) o.material = o.userData._liveMat;
      });
      boat.burned = false;
    }
    fx?.setDamageFire(null, 0, fireSlot);
    applyHitFlash(false);
    poseBody();
    setLod(lod < 0 ? 0 : lod);
    updateWake();
  }

  // Stash live materials so a burnt wreck can be restored on reset.
  hullPivot.traverse((o) => { if (o.isMesh) o.userData._liveMat = o.material; });
  turret.traverse((o) => { if (o.isMesh) o.userData._liveMat = o.material; });

  poseBody();
  setLod(0);
  console.info(`[patrolBoat] ${name} @ ${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}`);

  return {
    root,
    body,
    get firing() { return boat.firing; },
    get alive() { return boat.alive; },
    flashHit() {
      if (!boat.alive) return;
      boat.hitFlashFrames = 2;
      applyHitFlash(true);
    },
    mgMuzzle() {
      const { pos, dir } = mgMuzzle();
      return { pos: pos.clone(), dir: sprayDir(dir).clone() };
    },
    update(dt, { player, fx } = {}) {
      tickHitFlash();
      if (!boat.alive) {
        boat.firing = false;
        updateSink(dt, fx);
        return;
      }
      boat.thinkT -= dt;
      if (boat.thinkT <= 0) {
        boat.thinkT = 0.2;
        think(player);
      }
      if (boat.mode === 'combat' && player?.alive) {
        const e = player.body.translation();
        // Broadside: hull stays tangent to the player. Stick to one side so
        // the heading doesn't flip every time the bearings are close.
        const to = yawOf(e.x - boat.x, e.z - boat.z);
        const a = to + Math.PI * 0.5, b = to - Math.PI * 0.5;
        if (!boat.broadside) {
          boat.broadside = Math.abs(wrap(a - boat.yaw)) <= Math.abs(wrap(b - boat.yaw)) ? 1 : -1;
        } else {
          const cur = to + boat.broadside * Math.PI * 0.5;
          const alt = to - boat.broadside * Math.PI * 0.5;
          if (Math.abs(wrap(alt - boat.yaw)) + 0.55 < Math.abs(wrap(cur - boat.yaw))) {
            boat.broadside = -boat.broadside;
          }
        }
        drive(dt, to + boat.broadside * Math.PI * 0.5, 1);
      } else {
        if (!boat.goal) boat.goal = pickGoal();
        const g = boat.goal;
        const want = g ? yawOf(g.x - boat.x, g.z - boat.z) : boat.yaw;
        const err = Math.abs(wrap(want - boat.yaw));
        drive(dt, want, err > 1.1 ? 0.3 : 1);
      }
      boat.stuckT += dt;
      if (boat.stuckT > 2.4) {
        const moved = Math.hypot(boat.x - boat.lastX, boat.z - boat.lastZ);
        if (moved < 1.4 && boat.mode === 'patrol') boat.goal = pickGoal();
        boat.lastX = boat.x;
        boat.lastZ = boat.z;
        boat.stuckT = 0;
      }
      poseBody();
      aimTurret(dt, player);
      triggerMg(dt, player);
      updateWake();
      const ping = boat.ping;
      boat.ping = null;
      return ping ?? null;
    },
    updateLod(camPos) {
      const d = root.position.distanceTo(camPos);
      const pad = CULL_DIST * lodScale * 0.05;
      const cull = CULL_DIST * lodScale + (lod === -1 ? -pad : pad);
      if (d > cull) {
        setLod(-1);
        wake.group.visible = false;
        return;
      }
      setLod(boat.alive ? pickLod(d, LOD_EDGES, lodScale, lod < 0 ? 0 : lod) : 0);
    },
    shellHit(hitBody) {
      if (hitBody?.handle !== body.handle) return false;
      kill();
      return true;
    },
    reset,
  };
}

/**
 * @returns {Promise<{
 *   boats: object[],
 *   firing: boolean,
 *   firingBody: () => object | null,
 *   isBody: (body: object) => boolean,
 *   mgMuzzle: () => { pos: THREE.Vector3, dir: THREE.Vector3 } | null,
 *   update: (dt: number, opts: { player: object, fx?: object }) => void,
 *   updateLod: (camPos: THREE.Vector3) => void,
 *   shellHit: (body: object) => boolean,
 *   flashHit: (body: object) => void,
 *   reset: (fx?: object) => void,
 * }>}
 */
export async function buildPatrolBoat(scene, { RAPIER, world }) {
  const gltf = await new GLTFLoader().loadAsync('./models/patrol_boat.glb');
  const src = gltf.scene;

  const hullSrc = [];
  const turSrc = [];
  for (let lvl = 0; lvl < LOD_LEVELS; lvl++) {
    const hull = take(src, lvl ? `${HULL}_LOD${lvl}` : HULL);
    const tur = take(src, lvl ? `${TURRET}_LOD${lvl}` : TURRET);
    prepMesh(hull, lvl);
    prepMesh(tur, lvl);
    hullSrc.push(hull);
    turSrc.push(tur);
  }

  const extras = turSrc[0].userData.muzzle_local ?? [1.48, 0, 0.98];
  const muzzleLocal = blenderToThree(extras);

  const fleet = [];
  const names = ['PatrolBoatEast', 'PatrolBoatWest', 'PatrolBoatNorth'];
  const boats = SPAWNS.map((hint, i) => createBoat({
    RAPIER, world, scene, hullSrc, turSrc, muzzleLocal,
    spawnHint: hint,
    fireSlot: FIRE_SLOT0 + i,
    name: names[i],
    fleet,
  }));

  const shooter = () => boats.find((b) => b.firing) ?? null;

  return {
    boats,
    get firing() { return boats.some((b) => b.firing); },
    firingBody: () => shooter()?.body ?? null,
    isBody: (body) => boats.some((b) => b.body.handle === body?.handle),
    flashHit(body) {
      boats.find((b) => b.body.handle === body?.handle)?.flashHit();
    },
    mgMuzzle() {
      const b = shooter() ?? boats[0];
      return b.mgMuzzle();
    },
    update(dt, opts) {
      for (const b of boats) {
        const ping = b.update(dt, opts);
        if (ping) opts?.onContact?.(ping);
      }
    },
    updateLod(camPos) {
      for (const b of boats) b.updateLod(camPos);
    },
    shellHit(hitBody) {
      return boats.some((b) => b.shellHit(hitBody));
    },
    reset(fx) {
      for (const b of boats) b.reset(fx);
    },
  };
}
