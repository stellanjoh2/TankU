// Backdrop P-51 scout orbits; Air Support spawns a separate attacker for one strafe.
// Attack = one fixed horizontal circle at constant speed. Nose = path tangent only.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SIZE } from './terrain.js';
import { AIR_RAID_DURATION, AIR_RAID_FIRE_START, AIR_RAID_FIRE_END } from './airSupport.js';

const GROUPS = 1;
const RADIUS = SIZE * 0.72;
const ALT_CRUISE = 52;
const SPEED = 36;
const BANK = THREE.MathUtils.degToRad(18);
const SCALE = 1.0;
const PROP_RPS = 28;

// Attack circle: constant radius / altitude / groundspeed. No dive, no re-aim.
const ATK_R = 180;
const ATK_ALT = 38;
const ATK_SPEED = 48; // m/s — fixed; duration only sets how far around the circle we fly
const GUN_WING = 1.35;
const FADE_START = 0.78;

const Y = new THREE.Vector3(0, 1, 0);
const _euler = new THREE.Euler();
const _fwd = new THREE.Vector3();
const _u0 = new THREE.Vector3();
const _r = new THREE.Vector3();
const _up = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _gunPos = new THREE.Vector3();
const _gunDir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upGun = new THREE.Vector3();
const _aim = new THREE.Vector3();

function isPropName(name) {
  return /prop/i.test(name || '');
}

function findProp(root) {
  let prop = null;
  root.traverse((o) => {
    if (prop) return;
    if (isPropName(o.name)) prop = o;
  });
  return prop;
}

function prepModel(root, propMat) {
  root.scale.setScalar(SCALE);
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    const propMesh = isPropName(o.name)
      || (Array.isArray(o.material) ? o.material : [o.material]).some((m) => m && isPropName(m.name));
    if (propMesh) {
      o.material = propMat;
      o.renderOrder = 2;
      return;
    }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.flatShading = true;
      if (m.transparent || m.opacity < 1) {
        m.depthWrite = false;
        m.side = THREE.DoubleSide;
      }
    }
  });
  return root;
}

function prepAttacker(mesh) {
  const mats = [];
  mesh.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const src = Array.isArray(o.material) ? o.material : [o.material];
    const cloned = src.map((m) => {
      const c = m.clone();
      c.transparent = true;
      c.depthWrite = false;
      mats.push(c);
      return c;
    });
    o.material = cloned.length === 1 ? cloned[0] : cloned;
  });
  return mats;
}

/**
 * Nose (+X) along flight tangent. Path attitude only — never aims at a target.
 */
function orientAlong(mesh, tanX, tanY, tanZ, bank) {
  _fwd.set(tanX, tanY, tanZ);
  if (_fwd.lengthSq() < 1e-10) _fwd.set(1, 0, 0);
  else _fwd.normalize();
  _u0.copy(Y).addScaledVector(_fwd, -Y.dot(_fwd));
  if (_u0.lengthSq() < 1e-8) _u0.set(0, 1, 0);
  else _u0.normalize();
  _r.crossVectors(_fwd, _u0);
  _up.copy(_u0).multiplyScalar(Math.cos(bank)).addScaledVector(_r, Math.sin(bank));
  _z.crossVectors(_fwd, _up);
  _m.makeBasis(_fwd, _up, _z);
  mesh.quaternion.setFromRotationMatrix(_m);
}

/**
 * @returns {Promise<{
 *   root: THREE.Group,
 *   update: (dt: number) => void,
 *   beginRaid: (tx: number, tz: number, ty?: number) => boolean,
 *   isRaiding: boolean,
 *   firing: boolean,
 *   gunPose: (side: number) => { pos: THREE.Vector3, dir: THREE.Vector3 } | null,
 *   setRaidAim: (x: number, z: number) => void,
 *   scoutPos: () => THREE.Vector3 | null,
 * }>}
 */
export async function buildPlanes(scene) {
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const [gltf, propMap] = await Promise.all([
    loader.loadAsync('./models/p51.glb'),
    texLoader.loadAsync('./models/prop_blur.png'),
  ]);
  propMap.colorSpace = THREE.NoColorSpace;
  propMap.anisotropy = 4;
  propMap.wrapS = propMap.wrapT = THREE.ClampToEdgeWrapping;

  const propMat = new THREE.MeshBasicMaterial({
    map: propMap,
    color: 0x0e0e0c,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    alphaTest: 0.05,
    opacity: 0.92,
  });

  const proto = prepModel(gltf.scene, propMat);

  const root = new THREE.Group();
  root.name = 'Planes';
  scene.add(root);

  /** @type {{ mesh: THREE.Object3D, prop: THREE.Object3D | null, angle: number, dir: number, cx: number, cz: number }[]} */
  const planes = [];

  for (let i = 0; i < GROUPS; i++) {
    const mesh = proto.clone(true);
    root.add(mesh);
    planes.push({
      mesh,
      prop: findProp(mesh),
      angle: (i / GROUPS) * Math.PI * 2,
      dir: i % 2 === 0 ? 1 : -1,
      cx: Math.sin(i * 1.7) * 12,
      cz: Math.cos(i * 1.7) * 12,
    });
  }

  const atkMesh = proto.clone(true);
  atkMesh.visible = false;
  root.add(atkMesh);
  const atkProp = findProp(atkMesh);
  const atkMats = prepAttacker(atkMesh);
  const atkMatBase = atkMats.map((m) => m.opacity);

  /**
   * Fixed horizontal circle baked at call time.
   * @type {null | {
   *   t: number, duration: number,
   *   cx: number, cz: number, r: number, alt: number,
   *   dir: number, omega: number, a0: number,
   *   aimX: number, aimY: number, aimZ: number,
   *   bank: number,
   * }}
   */
  let raid = null;

  function placeOrbit(mesh, x, y, z, faceYaw, pitch, bank) {
    mesh.position.set(x, y, z);
    _euler.set(pitch, faceYaw, -bank, 'YXZ');
    mesh.quaternion.setFromEuler(_euler);
  }

  function setAttackerOpacity(a) {
    const k = Math.max(0, Math.min(1, a));
    for (let i = 0; i < atkMats.length; i++) {
      atkMats[i].opacity = atkMatBase[i] * k;
    }
  }

  /** Position + unit tangent on the attack circle at angle `a`. */
  function sampleCircle(r, a) {
    const x = r.cx + r.r * Math.cos(a);
    const z = r.cz + r.r * Math.sin(a);
    // θ̇ > 0 → tangent (−sin, cos); flip for opposite turn.
    const tanX = -r.dir * Math.sin(a);
    const tanZ = r.dir * Math.cos(a);
    return { x, y: r.alt, z, tanX, tanY: 0, tanZ };
  }

  /**
   * Bake a level circular pass. Closest point is over the aim; heading there
   * matches scout→target. Path never changes after this.
   */
  function beginRaid(tx, tz, ty) {
    if (raid) return false;

    const scout = planes[0];
    let hx;
    let hz;
    if (scout) {
      hx = tx - scout.mesh.position.x;
      hz = tz - scout.mesh.position.z;
      const len = Math.hypot(hx, hz);
      if (len < 12) {
        const ang = Math.random() * Math.PI * 2;
        hx = Math.cos(ang);
        hz = Math.sin(ang);
      } else {
        hx /= len;
        hz /= len;
      }
    } else {
      const ang = Math.random() * Math.PI * 2;
      hx = Math.cos(ang);
      hz = Math.sin(ang);
    }

    // Turn so the tank sits inside the circle (left of the attack heading).
    const dir = 1;
    // At closest approach a=af: position = aim, tangent = (hx,hz).
    // tan = dir*(-sin a, cos a) = (hx, hz) → sin a = -dir*hx, cos a = dir*hz
    const af = Math.atan2(-dir * hx, dir * hz);
    const cx = tx - ATK_R * Math.cos(af);
    const cz = tz - ATK_R * Math.sin(af);

    const omega = (ATK_SPEED / ATK_R) * dir;
    // Mid-raid = closest approach; start half the timed sweep before that.
    const sweep = omega * AIR_RAID_DURATION;
    const a0 = af - sweep * 0.5;

    raid = {
      t: 0,
      duration: AIR_RAID_DURATION,
      cx,
      cz,
      r: ATK_R,
      alt: ATK_ALT,
      dir,
      omega,
      a0,
      aimX: tx,
      aimY: Number.isFinite(ty) ? ty : 1.4,
      aimZ: tz,
      bank: BANK * dir,
    };

    atkMesh.visible = true;
    setAttackerOpacity(1);
    const pose = sampleCircle(raid, a0);
    atkMesh.position.set(pose.x, pose.y, pose.z);
    orientAlong(atkMesh, pose.tanX, pose.tanY, pose.tanZ, raid.bank);
    return true;
  }

  function endRaid() {
    raid = null;
    atkMesh.visible = false;
    setAttackerOpacity(1);
  }

  function updateRaid(dt) {
    if (!raid) return;
    raid.t += dt;
    // Constant ω — angle is linear in time, no easing.
    const a = raid.a0 + raid.omega * raid.t;
    const pose = sampleCircle(raid, a);
    atkMesh.position.set(pose.x, pose.y, pose.z);
    orientAlong(atkMesh, pose.tanX, pose.tanY, pose.tanZ, raid.bank);

    const u = Math.min(1, raid.t / raid.duration);
    if (u >= FADE_START) {
      setAttackerOpacity(1 - (u - FADE_START) / (1 - FADE_START));
    }
    if (raid.t >= raid.duration) endRaid();
  }

  function updateOrbit(p, dt) {
    const omega = (SPEED / RADIUS) * p.dir;
    p.angle += omega * dt;

    const x = p.cx + RADIUS * Math.cos(p.angle);
    const z = p.cz + RADIUS * Math.sin(p.angle);
    const vx = -RADIUS * omega * Math.sin(p.angle);
    const vz = RADIUS * omega * Math.cos(p.angle);
    const faceYaw = Math.atan2(-vz, vx);
    placeOrbit(p.mesh, x, ALT_CRUISE, z, faceYaw, 0, BANK * p.dir);
  }

  function update(dt) {
    const propSpin = PROP_RPS * Math.PI * 2 * dt;
    for (const p of planes) {
      if (p.prop) p.prop.rotation.x += propSpin;
      updateOrbit(p, dt);
    }
    if (atkProp) atkProp.rotation.x += propSpin;
    updateRaid(dt);
  }

  function firing() {
    if (!raid) return false;
    return raid.t >= AIR_RAID_FIRE_START && raid.t <= AIR_RAID_FIRE_END;
  }

  /** Kept for airSupport API — path is frozen at beginRaid; does not steer the plane. */
  function setRaidAim() {}

  /**
   * Wing guns: muzzle on the airframe, shot toward the frozen aim (plane itself
   * stays on the circle tangent — no lookAt).
   */
  function gunPose(side) {
    if (!raid || !firing()) return null;
    atkMesh.getWorldPosition(_gunPos);
    _right.set(0, 0, 1).applyQuaternion(atkMesh.quaternion).normalize();
    _upGun.set(0, 1, 0).applyQuaternion(atkMesh.quaternion).normalize();
    _gunPos.addScaledVector(_right, side * GUN_WING);
    _gunPos.addScaledVector(_upGun, -0.35);

    _aim.set(raid.aimX, raid.aimY, raid.aimZ);
    _gunDir.copy(_aim).sub(_gunPos);
    if (_gunDir.lengthSq() < 1e-6) {
      _fwd.set(1, 0, 0).applyQuaternion(atkMesh.quaternion).normalize();
      _gunDir.copy(_fwd);
    } else {
      _gunDir.normalize();
    }

    return { pos: _gunPos.clone(), dir: _gunDir.clone() };
  }

  function scoutPos() {
    const p = planes[0];
    return p ? p.mesh.position : null;
  }

  return {
    root,
    update,
    beginRaid,
    setRaidAim,
    get isRaiding() { return !!raid; },
    get firing() { return firing(); },
    gunPose,
    scoutPos,
  };
}
