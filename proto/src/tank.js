// Sherman: rigid body + raycast "track contacts" (spring/damper + skid-steer traction), the visual rig
// driven from the GLB's extras (see scripts/sherman_rig.py), turret/gun aiming and firing.
import * as THREE from 'three';
import { float, materialEmissive, mix, positionWorld, smoothstep, uniform } from 'three/tsl';
import { applyBurntMetal } from './burntMetal.js';
import { createEngineHeatHaze } from './heatHaze.js';
import { heightAt, onBridge, WATER_Y } from './terrain.js';
import { waveHeight } from './waves.js';
import { createWake } from './wake.js';
import {
  REPAIR_CHARGES,
  tryNitro as startNitro, updateNitro as stepNitro,
  stressMissChance as stressMiss, missChance as combinedMiss, addStress as gainStress, decayStress,
  trySmoke as launchSmoke, smokeCdFraction as smokeFraction, tryRepair as beginRepair,
  tickRepair, updateRepairSweep,
} from './tankGadgets.js';
import {
  RELOAD,
  tickMg as stepMg, syncMgHeatVisual, muzzleOf, mgMuzzleOf, tryFire as launchShell,
} from './tankWeapons.js';
import {
  obliterateTank, restoreTankWreck, spawnWreckTurret, syncWreckTurret, clearWreckTurret,
} from './tankWreck.js';
import {
  installPickupLights, pulsePickupLight, updatePickupLights, clearPickupLights, pickupLightsHot,
  PICKUP_LIGHT_HEALTH, PICKUP_LIGHT_REPAIR,
} from './pickupLights.js';
import { syncTrackInstances } from './tankLod.js';

export { RELOAD, MG_HEAT_TIME, MG_COOLDOWN, SHELL_SPEED } from './tankWeapons.js';
export { stepMgHeat } from './tankWeapons.js';
export { REPAIR_CHARGES, REPAIR_TIME, REPAIR_HEAL, STRESS_MAX } from './tankGadgets.js';

const MASS = 25500;          // a bit lighter → more playful pitch under throttle
const LINK_T = 0.07;
const RAY_UP = 0.4;          // ray starts this far above each contact's resting track bottom
const SAG = 0.10;            // static spring compression (softer = more bounce)
const MU_LONG = 1.14;        // longitudinal grip; higher = harder launch
const MU_SIDE = 0.54826875;  // lateral grip; lower = more drift in a turn
// Grip stays full on driveable ground, then fades so a rock shoulder sheds the hull
// instead of the tracks parking on it. n·up: 0.88 ≈ 28°, 0.55 ≈ 57°.
const GRIP_FLAT = 0.88;
const GRIP_STEEP = 0.55;
const GRIP_FLOOR = 0.15;
const SPEED = { cruise: 10.9725, boost: 17.787, reverse: 5.1975, pivot: 5.4140625, turn: 4.51171875 };   // m/s
const DAMP_RATIO = 0.28;     // fraction of critical; lower = bouncier rebound
const BRAKE_DIVE = 0.75;     // keep this fraction of nose-dive pitch under hard braking
// Side bumps spin the long axis easily. Stiffen roll inertia, and past a small lean
// push the hull back toward its tracks. Under UPRIGHT_FREE, jumps and nose-lift are left alone.
const ROLL_I_SCALE = 2.4;
const UPRIGHT_FREE = THREE.MathUtils.degToRad(24);
const ROLL_SPRING = 480000;  // N·m, full at sideways
const PITCH_SPRING = 220000;
const ROLL_DAMP = 340000;    // N·m·s, opposes roll rate
const PITCH_DAMP = 220000;
const TRAVERSE = THREE.MathUtils.degToRad(90);      // arcade turret deg/s
const TRAVERSE_CATCHUP = 0.85;                      // extra × at large aim error (caps ~1.85×)
const TRAVERSE_CATCHUP_AT = THREE.MathUtils.degToRad(40);
const ELEVATE = THREE.MathUtils.degToRad(50);
const ELEV_MIN = THREE.MathUtils.degToRad(-10);
const ELEV_MAX = THREE.MathUtils.degToRad(45);
const MG_TRAVERSE = THREE.MathUtils.degToRad(90);
const MG_ELEVATE = THREE.MathUtils.degToRad(60);
const MG_ELEV_MIN = THREE.MathUtils.degToRad(-20);
const MG_ELEV_MAX = THREE.MathUtils.degToRad(70);
export const MAX_HP = 4;     // main-gun hits to destroy
export const MG_DAMAGE = 0.01; // .50 cal chip damage (−80%; ~100 rounds / full bar)
// MG50 mesh tip (Blender build: brake cyl at x=1.24, len 0.08 → tip ~1.28; z=0.43)
const MG_MUZZLE_LOCAL = new THREE.Vector3(1.28, 0.43, 0);
// GLB material index 4 / Blender slot 4 on Hull_Details — red brake/tail lenses
const TAIL_MAT = 'M_Glass_Taillight';
const TAIL_IDLE = 0.35;
const TAIL_BRAKE = 18;       // bloom-heavy red when braking or reversing
const TAIL_RGB = [1.0, 0.04, 0.02];
// Hull local (+X fwd, +Y up): build_sherman lamp(-2.62, ±1.46, deck_z+0.1) → Three (x, z, ∓y)
const TAIL_LIGHT_LOCALS = [
  new THREE.Vector3(-3.72, 1.67, 1.50),
  new THREE.Vector3(-3.72, 1.67, -1.50),
];
const TAIL_LIGHT_DIST = 1.5625;
const TAIL_LIGHT_IDLE = 0;
const TAIL_LIGHT_BRAKE = 5;
// Whip antenna (bones Antenna_0..3, rest pose straight up local +Y): lean = -GAIN * hull accel,
// a slow base spring plus a quicker tip spring chasing it, so the tip lags and whips past.
const ANT_GAIN = 0.075;      // rad of total lean per m/s² of acceleration
const ANT_MAX = 0.65;        // rad, total lean clamp
const ANT_BASE = { hz: 1.4, zeta: 0.12 };
const ANT_TIP = { hz: 3.2, zeta: 0.18 };
const ANT_SHARE = [0.12, 0.2, 0.3, 0.38];   // fraction of the lean per joint, base → tip
const ANT_ACCEL_SMOOTH = 25; // 1/s, low-pass on the measured acceleration

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _susUp = new THREE.Vector3();
const _susFwd = new THREE.Vector3();
const _susDown = new THREE.Vector3();
const _susOrigin = new THREE.Vector3();
const _susN = new THREE.Vector3();
const _susTf = new THREE.Vector3();
const _susTs = new THREE.Vector3();
const _susImp = new THREE.Vector3();
const _susHit = new THREE.Vector3();
const _susSide = new THREE.Vector3();
const _susTarget = { L: 0, R: 0 };
const _susLong = { L: [0, 0], R: [0, 0] };
const _up = new THREE.Vector3(0, 1, 0);
const _side = new THREE.Vector3();

function loopSegments(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push(new THREE.Vector2(flat[i], flat[i + 1]));
  const segs = [];
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = a.distanceTo(b);
    segs.push({ s0: L, a, t: b.clone().sub(a).divideScalar(len) });
    L += len;
  }
  return { segs, L };
}

function pointOnLoop({ segs, L }, d, outP) {
  d = ((d % L) + L) % L;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].s0 <= d) lo = mid; else hi = mid - 1;
  }
  const s = segs[lo];
  outP.copy(s.a).addScaledVector(s.t, d - s.s0);
  return s.t;
}

// Jacket + tube + muzzle brake sit forward of the receiver, on the bore (local +X).
function isMgBarrelCentroid(x, y, z) {
  return x >= 0.18 && y > 0.3 && y < 0.6 && Math.abs(z) < 0.1;
}

/** Triangles whose centroid passes `keep`, attributes copied so normals stay smooth. */
function takeTriangles(geo, keep) {
  const index = geo.getIndex();
  const pos = geo.getAttribute('position');
  if (!pos) return null;
  const triCount = (index ? index.count : pos.count) / 3;
  const kept = [];
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const x = (pos.getX(i0) + pos.getX(i1) + pos.getX(i2)) / 3;
    const y = (pos.getY(i0) + pos.getY(i1) + pos.getY(i2)) / 3;
    const z = (pos.getZ(i0) + pos.getZ(i1) + pos.getZ(i2)) / 3;
    if (keep(x, y, z)) kept.push(i0, i1, i2);
  }
  if (!kept.length) return null;
  const map = new Map();
  const seq = [];
  const newIndex = new Uint32Array(kept.length);
  for (let i = 0; i < kept.length; i++) {
    const vi = kept[i];
    let n = map.get(vi);
    if (n === undefined) {
      n = seq.length;
      map.set(vi, n);
      seq.push(vi);
    }
    newIndex[i] = n;
  }
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(geo.attributes)) {
    const attr = geo.getAttribute(name);
    const item = attr.itemSize;
    const arr = new attr.array.constructor(seq.length * item);
    for (let i = 0; i < seq.length; i++) {
      for (let k = 0; k < item; k++) arr[i * item + k] = attr.getComponent(seq[i], k);
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, item, attr.normalized));
  }
  out.setIndex(new THREE.BufferAttribute(newIndex, 1));
  return out;
}

function approachAngle(cur, target, maxStep) {
  let d = Math.atan2(Math.sin(target - cur), Math.cos(target - cur));
  return cur + THREE.MathUtils.clamp(d, -maxStep, maxStep);
}

function smooth01(t) {
  const u = THREE.MathUtils.clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
}

/**
 * World torque (N·m) that resists falling onto a side or roof.
 * Lets go once the hull is on its side, so a completed flip stays put.
 * `side` is the body lateral axis (local +Z), the pitch axis.
 */
function uprightAssist(up, fwd, side, angvel, grounded) {
  const ax = -up.z;
  const az = up.x;
  const sinTilt = Math.hypot(ax, az);
  // Full while a tip can still be saved. Lets go near sideways so a real flip stays put.
  const commit = smooth01((up.y - 0.08) / 0.32);
  // Damping lingers a little past sideways so a tumble stops on its side instead of spinning onto the roof.
  const dampHold = Math.max(commit, smooth01((up.y + 0.35) / 0.7));
  const freeSin = Math.sin(UPRIGHT_FREE);
  const excess = Math.max(0, sinTilt - freeSin) / (1 - freeSin);
  const shaped = excess * excess;
  const air = grounded ? 1 : 0.8;
  const invSin = sinTilt > 1e-4 ? 1 / sinTilt : 0;
  const rollAlign = (ax * fwd.x + az * fwd.z) * invSin;
  const pitchAlign = (ax * side.x + az * side.z) * invSin;
  const rollRate = angvel.x * fwd.x + angvel.y * fwd.y + angvel.z * fwd.z;
  const pitchRate = angvel.x * side.x + angvel.y * side.y + angvel.z * side.z;
  const tiltFrac = Math.min(1, sinTilt / freeSin);
  const rollDampScale = (0.35 + 0.65 * tiltFrac) * (grounded ? 1 : 0.7);
  const pitchDampScale = (0.06 + 0.94 * excess) * (grounded ? 1 : 0.7);
  const rollT = commit * ROLL_SPRING * shaped * air * rollAlign - dampHold * ROLL_DAMP * rollDampScale * rollRate;
  const pitchT = commit * PITCH_SPRING * shaped * air * pitchAlign - dampHold * PITCH_DAMP * pitchDampScale * pitchRate;
  return {
    x: fwd.x * rollT + side.x * pitchT,
    y: fwd.y * rollT + side.y * pitchT,
    z: fwd.z * rollT + side.z * pitchT,
  };
}

/** Damped spring on a 2D value (pos, vel: Vector2) towards target, semi-implicit Euler. */
function springStep(pos, vel, target, { hz, zeta }, dt) {
  const w = 2 * Math.PI * hz;
  vel.x += (w * w * (target.x - pos.x) - 2 * zeta * w * vel.x) * dt;
  vel.y += (w * w * (target.y - pos.y) - 2 * zeta * w * vel.y) * dt;
  pos.addScaledVector(vel, dt);
}

export class Tank {
  /**
   * @param {object} [opts]
   * @param {THREE.Color} [opts.tint] multiplies every non-lamp material colour (enemy)
   * @param {THREE.Object3D} [opts.wreck] destroyed-tank mesh to clone and swap in on death
   */
  constructor(gltf, RAPIER, world, spawn, opts = {}) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.model = gltf.scene;
    this.tailMats = [];
    this.flashMats = [];
    this.pbrMats = new Map();
    this.hitFlashFrames = 0;
    this.hp = MAX_HP;
    this.maxHp = MAX_HP;
    this.stress = 0;          // 0..100 temporary aim jitter; decays after main-gun hits
    this.smokeCd = 0;         // gadget cooldown (smoke launchers)
    this.repairs = REPAIR_CHARGES;
    this.repairT = 0;         // s left on the current channel (0 = idle)
    this.repairDone = false;
    this.repairCancelled = false;
    this._sweep = -1;
    this._repairU = null;
    this.wrecked = false;
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.name) {
          let list = this.pbrMats.get(m.name);
          if (!list) this.pbrMats.set(m.name, (list = []));
          if (!list.includes(m)) list.push(m);
        }
        m.envMapIntensity = 0.6;
        if (m.emissive) this.flashMats.push(m);
        if (m.name === TAIL_MAT) {
          m.emissive.setRGB(...TAIL_RGB);
          m.emissiveIntensity = TAIL_IDLE;
          this.tailMats.push(m);
        } else if (opts.tint && m.color) {
          m.color.multiply(opts.tint);
        }
      }
    });
    if (opts.repairGlow) this._installRepairGlow();
    // Destroyed hull (static) + turret template (physics on obliterate). Hidden until death.
    // Snapshot before pickup/tail lights so obliterate only toggles mesh roots.
    this.intactRoots = [...this.model.children];
    this.wreck = null;
    this.wreckTurretSrc = null;
    this.wreckTurret = null;
    this.wreckTurretBody = null;
    if (opts.wreck) {
      const src = opts.wreck.getObjectByName('Sherman_Destroyed') || opts.wreck;
      this.wreck = src.clone(true);
      this.wreck.name = 'Sherman_Destroyed';
      this.wreck.visible = false;
      this.wreck.position.set(0, 0, 0);
      this.wreck.rotation.set(0, 0, 0);
      this.wreck.scale.set(1, 1, 1);
      applyBurntMetal(this.wreck, opts.tint);
      this.model.add(this.wreck);
      const tur = opts.wreck.getObjectByName('Sherman_Destroyed_Turret');
      if (tur) {
        this.wreckTurretSrc = tur.clone(true);
        this.wreckTurretSrc.name = 'Sherman_Destroyed_Turret';
        this.wreckTurretSrc.position.set(0, 0, 0);
        this.wreckTurretSrc.rotation.set(0, 0, 0);
        this.wreckTurretSrc.scale.set(1, 1, 1);
        applyBurntMetal(this.wreckTurretSrc, opts.tint);
      }
    }
    if (opts.repairGlow) installPickupLights(this);
    // Red point lights at the two rear brake lenses — spill onto hull/grass when braking.
    this.tailLights = TAIL_LIGHT_LOCALS.map((local) => {
      const l = new THREE.PointLight(new THREE.Color(...TAIL_RGB), TAIL_LIGHT_IDLE, TAIL_LIGHT_DIST, 1);
      l.position.copy(local);
      this.model.add(l);
      return l;
    });
    const node = (n) => {
      const o = this.model.getObjectByName(n);
      if (!o) throw new Error(`missing node ${n}`);
      return o;
    };

    this.turret = node('Turret');
    this.gunMount = node('Gun_Mount');
    this.barrel = node('Gun_Barrel');
    this.mgMount = node('MG50_Mount');
    this.mgElev = node('MG50_Elevation');
    this.mg = node('MG50');
    // GLB rests the pintle aft (π); face turret-forward for gameplay.
    this.mgMount.rotation.set(0, 0, 0);
    this.barrelRest = this.barrel.position.x;
    // GLB ships 0.25; push a bit deeper for a heavier main-gun feel
    this.recoilDistance = 0.2;
    this.muzzleLocal = new THREE.Vector3(...(this.barrel.userData.muzzle_local ?? [2.44, 0, 0]));
    this.mgMuzzleLocal = MG_MUZZLE_LOCAL.clone();
    this.mgHeat = 0;       // 0..1, barrel glow and heat shimmer
    this.mgLock = 0;       // s left on a cook-off; gun won't fire
    this.mgFiring = false;
    this._installMgHeat();

    // antenna: x = lean towards turret +X (forward), y = towards turret +Z
    this.antennaBones = ANT_SHARE.map((_, i) => node(`Antenna_${i}`));
    this.accelLocal = new THREE.Vector3();   // hull-frame acceleration, smoothed
    this._prevVel = { x: 0, y: 0, z: 0 };
    this.prevVel = null;
    this.antBase = new THREE.Vector2();
    this.antBaseVel = new THREE.Vector2();
    this.antTip = new THREE.Vector2();
    this.antTipVel = new THREE.Vector2();

    // ---- visual rig
    this.sides = ['L', 'R'].map((side) => {
      const track = node(`Track_${side}`);
      const loop = loopSegments(track.userData.path_xz);
      const links = track.children.filter((c) => c.userData.track_s != null);
      const wheels = node(`Wheels_${side}`).children.filter((c) => c.userData.spin_radius);
      return { side, z: track.position.z, loop, links, wheels, dist: 0, speed: 0 };
    });

    // Wake sits just aft of the rear roadwheel and about as wide as the tracks.
    let rearX = Infinity;
    for (const s of this.sides) {
      for (const w of s.wheels) rearX = Math.min(rearX, w.position.x);
    }
    if (!Number.isFinite(rearX)) rearX = -3.2;
    const trackZ = Math.abs(this.sides[0]?.z) || 1.2;
    this.wake = createWake(null, {
      name: 'TankWake',
      stern: THREE.MathUtils.clamp(-rearX + 0.45, 2.4, 4.2),
      cruise: SPEED.cruise,
      step: 0.85,
      max: 20,
      life: 5.5,
      half: Math.min(1.25, Math.max(0.95, trackZ * 0.9)),
      belly: 0.28,
      bellyLen: 7,
      grow: 0.01,
      growCap: 12,
      raggedA: 0.07,
      raggedB: 0.1,
      fadeStart: 1.2,
      fadeEnd: 16,
      crestIn0: 1.4,
      crestIn1: 4,
      crestOut0: 7,
      crestOut1: 14,
      crestSpread0: 0.12,
      crestThick: 0.28,
      crestThickGrow: 0.008,
      wobble: 0.12,
      minSpeed: 0.7,
      // Shore-style foam ring around the hull waterline while wet.
      collar: {
        halfL: 3.05,
        halfW: Math.max(1.55, trackZ + 0.35),
        band: 0.9,
        inset: 0.2,
      },
    });

    // ---- physics body
    const rb = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spawn.yaw ?? 0))
      .setLinearDamping(0.04).setAngularDamping(0.48).setCanSleep(false);
    this.body = world.createRigidBody(rb);
    const hx = 2.9, hy = 0.7, hz = 1.62;
    const hullRound = 0.22; // eased corners; outer size stays hx/hy/hz
    const I = (a, b) => (MASS / 12) * (a * a + b * b);
    // COM raised + slightly aft so forward drive lifts the nose a little (arcade weight transfer).
    // Low friction (Min vs the other shape) so the belly slides off a rock instead of hanging on it.
    world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(hx - hullRound, hy - hullRound, hz - hullRound, hullRound)
        .setTranslation(0, 1.25, 0)
        .setFriction(0.12)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setMassProperties(MASS, { x: -0.28, y: 0.45, z: 0 },
          { x: I(2 * hy, 2 * hz) * ROLL_I_SCALE, y: I(2 * hx, 2 * hz), z: I(2 * hx, 2 * hy) * 0.88 }, { x: 0, y: 0, z: 0, w: 1 }),
      this.body,
    );
    // Intact turret volume — disabled while the wreck turret flies so they don't explode apart.
    this.turretCollider = world.createCollider(
      RAPIER.ColliderDesc.cylinder(0.45, 1.05).setTranslation(-0.16, 2.4, 0)
        .setDensity(0).setFriction(0.5),
      this.body,
    );

    // ---- track contacts: every road wheel plus sprocket and idler (those only touch on bumps)
    this.contacts = [];
    for (const s of this.sides) {
      for (const w of s.wheels) {
        const name = w.name;
        if (name.startsWith('ReturnRoller')) continue;
        const r = w.userData.spin_radius;
        const isGear = name.startsWith('Sprocket') || name.startsWith('Idler');
        const bottom = w.position.y - r - (isGear ? LINK_T / 2 : LINK_T);
        this.contacts.push({
          side: s,
          local: new THREE.Vector3(w.position.x, bottom + RAY_UP, s.z),
          load: 0,
          vLong: 0,
          hitDist: -1, // last suspension ray TOI (−1 = miss); used by debug overlay
        });
      }
    }
    const share = (MASS * 9.81) / this.contacts.filter((c) => c.local.y < RAY_UP + 0.1).length;
    this.K = share / SAG;
    this.C = DAMP_RATIO * 2 * Math.sqrt(this.K * MASS / this.contacts.length);
    this.KD = (MASS / this.contacts.length) * 5.76;
    this.KS = (MASS / this.contacts.length) * 8.55;  // side scrub; lower = slide lingers

    this.cmd = { throttle: 0, turn: 0 };
    this.reload = 0;
    this.reloadDone = false;
    this.recoilT = 1;
    this.grounded = 0;
    this.yawAim = 0;
    this.elevAim = 0;
    this.turretSlew = 0;     // rad/s, + = left (CCW from above)
    // charge 0..1 (two 0.5 hits); needFull = spent both, wait for 100% before next use
    this.nitro = { charge: 1, t: 0, power: 0, held: false, needFull: false, justStarted: false };
  }

  /** Flat metal/rough for one GLB material. Drops the shared ORM map so the slider value is what renders. */
  setPbr(name, metalness, roughness) {
    const list = this.pbrMats.get(name);
    if (!list) return;
    for (const m of list) {
      if (m.metalnessMap || m.roughnessMap) {
        m.metalnessMap = null;
        m.roughnessMap = null;
        m.needsUpdate = true;
      }
      m.metalness = metalness;
      m.roughness = roughness;
    }
  }

  get nitroCharge() { return this.nitro.charge; }
  get nitroActive() { return this.nitro.t > 0; }

  /** Rising-edge Shift/L3: spend half a bar if available. Returns true when a burst starts. */
  tryNitro() { return startNitro(this); }

  /**
   * Edge-trigger nitro from held boost, advance envelope / recharge.
   * Call once per frame (variable dt) before physics steps.
   */
  updateNitro(dt, wantBoost) { stepNitro(this, dt, wantBoost); }

  get position() { return this.body.translation(); }
  get alive() { return this.hp > 0; }
  /** Chance a well-aimed main-gun shell still misses, from Stress (0..1). */
  get stressMissChance() { return stressMiss(this); }

  /**
   * Combined miss chance: stress jitter + optional smoke penalty (0..1).
   * Hit rate = 1 − this.
   */
  missChance(smokeMiss = 0) { return combinedMiss(this, smokeMiss); }

  /** Effective direct-hit rate for HUD (0..1). */
  hitRate(smokeMiss = 0) { return 1 - this.missChance(smokeMiss); }

  /** Spike stress from a hard hit (main gun). Clamped to 0..100. */
  addStress(amount) { gainStress(this, amount); }

  /** BF3/4 smoke launchers. Returns deploy pose or null if on cooldown / dead. */
  trySmoke() { return launchSmoke(this); }

  get smokeReady() { return this.alive && this.smokeCd <= 0; }
  get smokeCdFraction() { return smokeFraction(this); }

  get repairing() { return this.repairT > 0; }

  /**
   * Start a repair channel. Spends one charge up front.
   * No-op at full HP, while already repairing, or with no charges left.
   */
  tryRepair() { return beginRepair(this); }

  /** Remove from (or return to) the world without destroying it — used by solo mode. */
  setActive(on) {
    if (!on) this.restoreWreck();
    this.body.setEnabled(on);
    this.model.visible = on;
  }

  /** Kill-shot: freeze pose, hide the intact rig, show the destroyed hull + flying turret. */
  obliterate() { obliterateTank(this); }

  /** Swap the intact rig back in (round restart). */
  restoreWreck() { restoreTankWreck(this); }

  _spawnWreckTurret() { spawnWreckTurret(this); }
  _syncWreckTurret() { syncWreckTurret(this); }
  _clearWreckTurret() { clearWreckTurret(this); }

  forwardSpeed() {
    const v = this.body.linvel();
    _v.set(1, 0, 0).applyQuaternion(_q.copy(this.body.rotation()));
    return v.x * _v.x + v.y * _v.y + v.z * _v.z;
  }

  /** One fixed physics step: suspension, traction, drive. */
  physicsStep(dt, input) {
    if (!this.body.isEnabled() || this.wrecked) return;
    const R = this.RAPIER;
    const ramp = (cur, tgt, rate) => cur + THREE.MathUtils.clamp(tgt - cur, -rate * dt, rate * dt);
    let throttleTgt = input.throttle;
    // Nitro pulls you forward even if you're not holding W (arcade burst).
    if (this.nitro.power > 0.05 && throttleTgt >= 0) {
      throttleTgt = Math.max(throttleTgt, 0.55 + this.nitro.power * 0.45);
    }
    this.cmd.throttle = ramp(this.cmd.throttle, throttleTgt, throttleTgt === 0 ? 3.5 : 2.4);
    this.cmd.turn = ramp(this.cmd.turn, input.turn, 6.25);

    const top = this.cmd.throttle >= 0
      ? THREE.MathUtils.lerp(SPEED.cruise, SPEED.boost, this.nitro.power)
      : SPEED.reverse;
    const v = this.cmd.throttle * top;
    const steer = this.cmd.turn * THREE.MathUtils.lerp(SPEED.pivot, SPEED.turn, Math.min(1, Math.abs(v) / 4));
    const target = _susTarget;   // D (turn > 0) = right: left track runs faster
    target.L = v + steer;
    target.R = v - steer;

    const t = this.body.translation();
    const q = _q.copy(this.body.rotation());
    const up = _susUp.set(0, 1, 0).applyQuaternion(q);
    const fwd = _susFwd.set(1, 0, 0).applyQuaternion(q);
    const down = _susDown.copy(up).negate();
    const origin = _susOrigin;
    const n = _susN;
    const tf = _susTf;
    const ts = _susTs;
    const imp = _susImp;
    if (!this._susRay) this._susRay = new R.Ray(origin, down);
    const ray = this._susRay;
    const maxDist = RAY_UP + SAG;
    let grounded = 0;
    const sideLong = _susLong;
    sideLong.L[0] = sideLong.L[1] = sideLong.R[0] = sideLong.R[1] = 0;
    const fwdSpeed = this.forwardSpeed();
    const com = this.body.worldCom();
    const diveCancel = 1 - BRAKE_DIVE;

    for (const c of this.contacts) {
      origin.copy(c.local).applyQuaternion(q).add(t);
      ray.origin = origin;
      ray.dir = down;
      const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, undefined, undefined, this.body);
      c.load = 0;
      c.hitDist = hit ? hit.timeOfImpact : -1;
      if (!hit) continue;
      const dist = hit.timeOfImpact;
      const comp = maxDist - dist;
      const p = _susHit.copy(origin).addScaledVector(down, dist);
      const vel = this.body.velocityAtPoint(p);
      n.set(hit.normal.x, hit.normal.y, hit.normal.z);
      const vAlong = vel.x * up.x + vel.y * up.y + vel.z * up.z;
      const Fs = Math.max(0, this.K * comp - this.C * vAlong);
      c.load = Fs;
      grounded++;

      const face = n.x * up.x + n.y * up.y + n.z * up.z;
      const steep = smooth01((GRIP_FLAT - face) / (GRIP_FLAT - GRIP_STEEP));
      const grip = 1 - steep * (1 - GRIP_FLOOR);
      tf.copy(fwd).addScaledVector(n, -fwd.dot(n)).normalize();
      ts.crossVectors(n, tf).normalize();
      const vLong = vel.x * tf.x + vel.y * tf.y + vel.z * tf.z;
      const vSide = vel.x * ts.x + vel.y * ts.y + vel.z * ts.z;
      const tgt = target[c.side.side];
      const muL = MU_LONG * grip * Fs;
      const muS = MU_SIDE * grip * Fs;
      const Fl = THREE.MathUtils.clamp(this.KD * (tgt - vLong), -muL, muL);
      const Fsd = THREE.MathUtils.clamp(-this.KS * vSide, -muS, muS);
      sideLong[c.side.side][0] += vLong;
      sideLong[c.side.side][1]++;

      imp.copy(up).multiplyScalar(Fs).addScaledVector(tf, Fl).addScaledVector(ts, Fsd).multiplyScalar(dt);
      this.body.applyImpulseAtPoint(imp, p, true);

      // Soften hard-brake nose-dive without touching accel lift
      if (diveCancel > 0 && fwdSpeed > 0.5 && Fl < 0) {
        const lx = Fl * dt * tf.x, ly = Fl * dt * tf.y, lz = Fl * dt * tf.z;
        const rx = p.x - com.x, ry = p.y - com.y, rz = p.z - com.z;
        this.body.applyTorqueImpulse({
          x: -diveCancel * (ry * lz - rz * ly),
          y: -diveCancel * (rz * lx - rx * lz),
          z: -diveCancel * (rx * ly - ry * lx),
        }, true);
      }
    }
    this.grounded = grounded;

    // Keep small leans. Bleed off roll speed, and shove back once a tip is actually underway.
    {
      const side = _susSide.set(0, 0, 1).applyQuaternion(q);
      const av = this.body.angvel();
      const torque = uprightAssist(up, fwd, side, av, grounded > 0);
      this.body.applyTorqueImpulse({ x: torque.x * dt, y: torque.y * dt, z: torque.z * dt }, true);
    }

    // track surface speed for the visuals: ground speed when touching, commanded when spinning free
    for (const s of this.sides) {
      const [sum, cnt] = sideLong[s.side];
      const tgt = target[s.side];
      const ground = cnt ? sum / cnt : tgt;
      const slip = cnt ? THREE.MathUtils.clamp(Math.abs(tgt - ground) - 1.0, 0, 1) : 1;
      s.speed = THREE.MathUtils.lerp(ground, tgt, slip);
      s.dist += s.speed * dt;
    }

    const lv = this.body.linvel();
    if (this.prevVel) {
      _v.set((lv.x - this.prevVel.x) / dt, (lv.y - this.prevVel.y) / dt, (lv.z - this.prevVel.z) / dt)
        .applyQuaternion(_q.copy(this.body.rotation()).invert());
      this.accelLocal.lerp(_v, 1 - Math.exp(-ANT_ACCEL_SMOOTH * dt));
    }
    const prev = this._prevVel;
    prev.x = lv.x;
    prev.y = lv.y;
    prev.z = lv.z;
    this.prevVel = prev;
  }

  /** Swing the whip antenna from the hull's acceleration, expressed in the turret's frame. */
  updateAntenna(dt) {
    const yaw = this.turret.rotation.y;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const ax = this.accelLocal.x, az = this.accelLocal.z;
    const target = new THREE.Vector2(c * ax - s * az, s * ax + c * az).multiplyScalar(-ANT_GAIN);
    if (target.length() > ANT_MAX) target.setLength(ANT_MAX);
    const steps = Math.ceil(dt / (1 / 120));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      springStep(this.antBase, this.antBaseVel, target, ANT_BASE, h);
      springStep(this.antTip, this.antTipVel, this.antBase, ANT_TIP, h);
    }
    this.antennaBones.forEach((bone, i) => {
      const lean = i < 2 ? this.antBase : this.antTip;
      const k = ANT_SHARE[i];
      bone.rotation.set(lean.y * k, 0, -lean.x * k);
    });
  }

  /** Sync the model to the body, animate the running gear, aim, recoil. */
  update(dt, aimPoint) {
    if (this.wrecked) {
      this._syncWreckTurret();
      this._tickRepair(dt);
      this._updateRepairSweep(dt);
      const t = this.body.translation();
      this.wake.clear(t.x, t.z);
      return;
    }
    this.model.position.copy(this.body.translation());
    this.model.quaternion.copy(this.body.rotation());
    this.model.updateMatrixWorld();

    const p = new THREE.Vector2();
    for (const s of this.sides) {
      for (const link of s.links) {
        const tan = pointOnLoop(s.loop, link.userData.track_s - s.dist, p);
        link.position.set(p.x, p.y, 0);
        link.rotation.set(0, 0, Math.atan2(tan.y, tan.x));
      }
      for (const w of s.wheels) w.rotation.z = -s.dist / w.userData.spin_radius;
    }
    syncTrackInstances(this);

    if (aimPoint) {
      const local = this.turret.parent.worldToLocal(aimPoint.clone());
      const yaw = Math.atan2(-(local.z - this.turret.position.z), local.x - this.turret.position.x);
      const yaw0 = this.turret.rotation.y;
      const yawErr = Math.abs(Math.atan2(Math.sin(yaw - yaw0), Math.cos(yaw - yaw0)));
      const catchUp = 1 + TRAVERSE_CATCHUP * Math.min(1, yawErr / TRAVERSE_CATCHUP_AT);
      this.turret.rotation.y = approachAngle(yaw0, yaw, TRAVERSE * catchUp * dt);
      this.turretSlew = Math.atan2(
        Math.sin(this.turret.rotation.y - yaw0),
        Math.cos(this.turret.rotation.y - yaw0),
      ) / Math.max(dt, 1e-4);
      this.turret.updateMatrixWorld();
      const g = this.turret.worldToLocal(aimPoint.clone()).sub(this.gunMount.position);
      const elev = THREE.MathUtils.clamp(Math.atan2(g.y, Math.hypot(g.x, g.z)), ELEV_MIN, ELEV_MAX);
      this.gunMount.rotation.z = approachAngle(this.gunMount.rotation.z, elev, ELEVATE * catchUp * dt);

      // Roof .50 cal: track aim point (0 yaw = turret-forward after clearing the aft rest pose).
      const mgLocal = this.turret.worldToLocal(aimPoint.clone()).sub(this.mgMount.position);
      const mgYaw = Math.atan2(-mgLocal.z, mgLocal.x);
      this.mgMount.rotation.y = approachAngle(this.mgMount.rotation.y, mgYaw, MG_TRAVERSE * dt);
      this.mgMount.updateMatrixWorld();
      const me = this.mgMount.worldToLocal(aimPoint.clone()).sub(this.mgElev.position);
      const mgElev = THREE.MathUtils.clamp(Math.atan2(me.y, Math.hypot(me.x, me.z)), MG_ELEV_MIN, MG_ELEV_MAX);
      this.mgElev.rotation.z = approachAngle(this.mgElev.rotation.z, mgElev, MG_ELEVATE * dt);
    } else {
      this.turretSlew = 0;
    }

    decayStress(this, dt);
    if (this.smokeCd > 0) this.smokeCd = Math.max(0, this.smokeCd - dt);

    const wasReloading = this.reload > 0;
    this.reload = Math.max(0, this.reload - dt);
    this.reloadDone = wasReloading && this.reload === 0;
    this.recoilT = Math.min(1, this.recoilT + dt);
    const r = this.recoilT;
    const k = r < 0.05 ? r / 0.05 : Math.pow(1 - Math.min(1, (r - 0.05) / 0.8), 2);
    this.barrel.position.x = this.barrelRest - k * this.recoilDistance;
    this.updateAntenna(dt);

    // Brake / reverse: hard red emissive on M_Glass_Taillight (idle dim red) + short-range spill
    {
      const spd = this.forwardSpeed();
      const reversing = this.cmd.throttle < -0.05;
      const braking = this.cmd.throttle < 0.08 && spd > 1.2;
      const lit = reversing || braking;
      if (this.tailMats.length) {
        const target = lit ? TAIL_BRAKE : TAIL_IDLE;
        for (const m of this.tailMats) {
          m.emissiveIntensity += (target - m.emissiveIntensity) * Math.min(1, 14 * dt);
        }
      }
      const lightTarget = lit ? TAIL_LIGHT_BRAKE : TAIL_LIGHT_IDLE;
      for (const l of this.tailLights) {
        l.intensity += (lightTarget - l.intensity) * Math.min(1, 14 * dt);
      }
    }

    // Classic RPG hit flash: brake-light red emissive for a couple of frames
    if (this.hitFlashFrames > 0) {
      this.hitFlashFrames -= 1;
      if (this.hitFlashFrames > 0) this._applyHitFlash(true);
      else this._applyHitFlash(false);
    }

    this.model.updateMatrixWorld();
    this._tickRepair(dt);
    this._updateRepairSweep(dt);
    this._updateWake(dt);
  }

  /** Foam behind / around the hull while the tracks are in the water. */
  _updateWake(dt) {
    const parent = this.model.parent;
    if (parent && !this.wake.group.parent) parent.add(this.wake.group);
    const t = this.body.translation();
    _v.set(1, 0, 0).applyQuaternion(_q.copy(this.body.rotation()));
    _v.y = 0;
    if (_v.lengthSq() < 1e-8) _v.set(1, 0, 0);
    else _v.normalize();
    const fx = _v.x;
    const fz = _v.z;
    const sx = t.x - fx * this.wake.stern;
    const sz = t.z - fz * this.wake.stern;
    const surface = WATER_Y + waveHeight(sx, sz, 0);
    const wet = t.y < surface + 2.8
      && !onBridge(sx, sz, 1.5)
      && heightAt(sx, sz) < surface - 0.2;
    const upright = !this.isFlipped();
    const speed = Math.max(0, this.forwardSpeed());
    this.wake.update(dt, {
      x: t.x,
      z: t.z,
      fx,
      fz,
      rx: -fz,
      rz: fx,
      speed,
      emit: wet && upright && speed > 0.7,
      foam: wet && upright,
      time: 0,
    });
  }

  /** Sweep band along the hull (local +X, rear → front). Installed before the wreck mesh exists. */
  _installRepairGlow() {
    const origin = uniform(new THREE.Vector3());
    const forward = uniform(new THREE.Vector3(1, 0, 0));
    const t = uniform(0);
    const amp = uniform(0);
    // Default green (health). Repair channel sets shield violet before starting the sweep.
    const color = uniform(new THREE.Color().setRGB(0.22, 2.4, 0.4));
    this._repairU = { origin, forward, t, amp, color };
    const along = positionWorld.sub(origin).dot(forward);
    const center = mix(float(-4.2), float(4.6), t);
    const band = smoothstep(float(1.5), float(0.08), along.sub(center).abs());
    const glow = color.mul(band).mul(amp);
    const seen = new Set();
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || seen.has(m)) continue;
        if (!m.isMeshStandardMaterial && !m.isMeshPhysicalMaterial) continue;
        seen.add(m);
        m.emissiveNode = materialEmissive.add(glow);
        m.needsUpdate = true;
      }
    });
  }

  _tickRepair(dt) { tickRepair(this, dt); }
  _updateRepairSweep(dt) {
    updateRepairSweep(this, dt);
    updatePickupLights(this, dt);
  }

  /** Green hull band + streak light — health pickup (same swipe as repair finish). */
  showHeal() {
    if (!this._repairU) return;
    this._repairU.color.value.setRGB(0.22, 2.4, 0.4);
    this._sweepLit = true;
    this._sweep = 0;
    pulsePickupLight(this, PICKUP_LIGHT_HEALTH);
  }

  /** Purple world light when a repair-charge pickup is grabbed. */
  showRepairPickup() {
    pulsePickupLight(this, PICKUP_LIGHT_REPAIR);
  }

  /** Brake lights, hit flash, repair/heal sweep, or a hot .50 barrel. */
  emissiveHot() {
    if (this.hitFlashFrames > 0 || this.repairT > 0 || this.mgHeat > 0.5) return true;
    if (this._sweep >= 0) return true;
    if (pickupLightsHot(this)) return true;
    for (const m of this.tailMats) if (m.emissiveIntensity > 1.2) return true;
    return false;
  }

  /** Two-frame red emissive flash (same red as taillights / bloom). */
  flashHit() {
    this.hitFlashFrames = 2;
    this._applyHitFlash(true);
  }

  _applyHitFlash(on) {
    for (const m of this.flashMats) {
      if (on) {
        m.emissive.setRGB(...TAIL_RGB);
        m.emissiveIntensity = TAIL_BRAKE;
      } else if (m.name === TAIL_MAT) {
        m.emissive.setRGB(...TAIL_RGB);
        m.emissiveIntensity = TAIL_IDLE;
      } else {
        m.emissive.setRGB(0, 0, 0);
        m.emissiveIntensity = 1;
      }
    }
  }

  /**
   * Orange emissive on the barrel tube only. Receiver and ammo can keep the shared metal.
   * The .50 is one mesh, so the jacket / tube / muzzle triangles are split onto their own material.
   */
  _installMgHeat() {
    this._mgHeatMats = [];
    const targets = [];
    this.mg.traverse((o) => {
      if (!o.isMesh || Array.isArray(o.material)) return;
      if (o.material?.name === 'M_Metal_Dark') targets.push(o);
    });
    for (const o of targets) {
      const barrelGeo = takeTriangles(o.geometry, isMgBarrelCentroid);
      const bodyGeo = takeTriangles(o.geometry, (x, y, z) => !isMgBarrelCentroid(x, y, z));
      if (!barrelGeo || !bodyGeo) {
        barrelGeo?.dispose();
        bodyGeo?.dispose();
        continue;
      }
      const heatMat = o.material.clone();
      heatMat.emissive = new THREE.Color(0, 0, 0);
      heatMat.emissiveIntensity = 1;
      heatMat.emissiveNode = null;
      this._mgHeatMats.push(heatMat);
      this.flashMats.push(heatMat);
      const barrel = new THREE.Mesh(barrelGeo, heatMat);
      barrel.name = 'MG50_Barrel';
      barrel.castShadow = o.castShadow;
      barrel.receiveShadow = o.receiveShadow;
      o.add(barrel);
      const old = o.geometry;
      o.geometry = bodyGeo;
      old.dispose();
    }

    this.mgHaze = createEngineHeatHaze({
      local: new THREE.Vector3(1.08, 0.92, 0),
      width: 0.95,
      height: 1.35,
      strength: 0,
    });
    this.mgHaze.name = 'MGHeatHaze';
    this.mgHaze.userData.skipLod = true;
    this.mgHaze.visible = false;
    this.mg.add(this.mgHaze);
  }

  /**
   * Advance roof-gun heat. `trigger` is the held fire button (already gated on pause / death).
   * Returns whether a round should actually leave the barrel this frame.
   */
  tickMg(dt, trigger) { return stepMg(this, dt, trigger); }

  _syncMgHeatVisual(firing) { syncMgHeatVisual(this, firing); }

  muzzle() { return muzzleOf(this); }

  /** World pose of the roof .50 cal muzzle. */
  mgMuzzle() { return mgMuzzleOf(this); }

  /**
   * Returns shell launch data if the gun fired this frame.
   * @param {number} [smokeMiss=0] extra miss from smoke (see smoke.js)
   */
  tryFire(smokeMiss = 0) { return launchShell(this, smokeMiss); }

  /** True when the hull is on its side / roof (tracks no longer under it). */
  isFlipped() {
    _v.set(0, 1, 0).applyQuaternion(_q.copy(this.body.rotation()));
    return _v.y < 0.4;
  }

  /** Unstick in place: lift to terrain and kill velocity, keep heading. */
  reset(spawnY) {
    const t = this.body.translation();
    const yaw = new THREE.Euler().setFromQuaternion(_q.copy(this.body.rotation()), 'YXZ').y;
    this.body.setTranslation({ x: t.x, y: spawnY(t.x, t.z) + 1.5, z: t.z }, true);
    this.body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevVel = null;
    this.wake.clear(t.x, t.z);
  }

  /**
   * Arcade recovery when overturned: snap upright (keep yaw), hop clear of the ground.
   * No-op while driving normally — Space must not bounce an upright tank.
   */
  unflipJump(spawnY) {
    if (!this.isFlipped()) return false;
    const t = this.body.translation();
    const yaw = new THREE.Euler().setFromQuaternion(_q.copy(this.body.rotation()), 'YXZ').y;
    const ground = spawnY(t.x, t.z);
    this.body.setTranslation({ x: t.x, y: Math.max(t.y, ground) + 1.35, z: t.z }, true);
    this.body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), true);
    this.body.setLinvel({ x: 0, y: 8.5, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevVel = null;
    return true;
  }

  /** Full restart at the original spawn pose. */
  respawn(spawn) {
    this.restoreWreck();
    this.body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
    this.body.setRotation(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spawn.yaw ?? 0),
      true,
    );
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.wake.clear(spawn.x, spawn.z);
    this.reload = 0;
    this.reloadDone = false;
    this.recoilT = 1;
    this.mgHeat = 0;
    this.mgLock = 0;
    this.mgFiring = false;
    this._syncMgHeatVisual(false);
    this.prevVel = null;
    this.hp = this.maxHp;
    this.stress = 0;
    this.smokeCd = 0;
    this.repairs = REPAIR_CHARGES;
    this.repairT = 0;
    this.repairDone = false;
    this.repairCancelled = false;
    this._sweep = -1;
    if (this._repairU) this._repairU.amp.value = 0;
    clearPickupLights(this);
    this.hitFlashFrames = 0;
    this._applyHitFlash(false);
    this.cmd.throttle = this.cmd.turn = 0;
    Object.assign(this.nitro, { charge: 1, t: 0, power: 0, held: false, needFull: false, justStarted: false });
  }

  get reloadFraction() { return 1 - this.reload / RELOAD; }
}
