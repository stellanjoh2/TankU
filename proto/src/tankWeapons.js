// Main gun and roof .50. The hull still owns reload, heat, and the barrel nodes.
import * as THREE from 'three';

export const RELOAD = 4.0;
export const MG_HEAT_TIME = 6;
export const MG_COOLDOWN = RELOAD * 2;
const MG_HEAT_BLEED = 4.5;
export const SHELL_SPEED = 260 * 0.8 * 0.75;
const RECOIL_IMPULSE = 4500;

const _up = new THREE.Vector3(0, 1, 0);
const _side = new THREE.Vector3();
const _muzzleDir = new THREE.Vector3();

/** Panic throw: yaw hard enough to miss a hull at duel range. Mutates `dir`. */
export function deflectShell(dir) {
  const yaw = (Math.random() < 0.5 ? -1 : 1) * (0.26 + Math.random() * 0.12);
  dir.applyAxisAngle(_up, yaw);
  _side.crossVectors(_up, dir);
  if (_side.lengthSq() > 1e-8) {
    dir.applyAxisAngle(_side.normalize(), (Math.random() - 0.4) * 0.08);
  }
  return dir.normalize();
}

/** One step of roof-gun heat. `firing` is true for the step that cooks the barrel. */
export function stepMgHeat(heat, lock, dt, trigger, alive) {
  if (lock > 0) {
    lock = Math.max(0, lock - dt);
    if (lock > 0) return { heat: lock / MG_COOLDOWN, lock, firing: false };
    heat = 0;
  }
  const firing = !!trigger && !!alive;
  if (firing) {
    heat = Math.min(1, heat + dt / MG_HEAT_TIME);
    if (heat >= 0.999) {
      heat = 1;
      lock = MG_COOLDOWN;
    }
  } else if (heat > 0) {
    heat = Math.max(0, heat - dt / MG_HEAT_BLEED);
  }
  return { heat, lock, firing };
}

export function tickMg(tank, dt, trigger) {
  const s = stepMgHeat(tank.mgHeat, tank.mgLock, dt, trigger, tank.alive);
  tank.mgHeat = s.heat;
  tank.mgLock = s.lock;
  tank.mgFiring = s.firing;
  syncMgHeatVisual(tank, s.firing);
  return s.firing;
}

export function syncMgHeatVisual(tank, _firing) {
  const h = tank.mgHeat;
  const glow = h <= 0.5 ? 0 : (h - 0.5) / 0.5;
  const hot = glow > 0.02;
  for (const m of tank._mgHeatMats) {
    if (tank.hitFlashFrames > 0) break;
    if (hot) {
      m.emissive.setRGB(1, 0.28, 0.02);
      m.emissiveIntensity = glow * 36;
    } else {
      m.emissive.setRGB(0, 0, 0);
      m.emissiveIntensity = 1;
    }
  }
}

export function muzzleOf(tank) {
  const pos = tank.barrel.localToWorld(tank.muzzleLocal.clone().setX(tank.muzzleLocal.x));
  const dir = _muzzleDir.set(1, 0, 0).transformDirection(tank.barrel.matrixWorld).clone();
  return { pos, dir };
}

export function mgMuzzleOf(tank) {
  const pos = tank.mg.localToWorld(tank.mgMuzzleLocal.clone());
  const dir = new THREE.Vector3(1, 0, 0).transformDirection(tank.mg.matrixWorld);
  return { pos, dir };
}

/**
 * Returns shell launch data if the gun fired this frame.
 * @param {number} [smokeMiss=0]
 */
export function tryFire(tank, smokeMiss = 0) {
  if (tank.reload > 0) return null;
  tank.reload = RELOAD;
  tank.recoilT = 0;
  const { pos, dir } = muzzleOf(tank);
  const miss = tank.missChance(smokeMiss);
  const shotDir = (miss > 0 && Math.random() < miss)
    ? deflectShell(dir.clone())
    : dir;
  const lv = tank.body.linvel();
  const vel = shotDir.clone().multiplyScalar(SHELL_SPEED).add(new THREE.Vector3(lv.x, lv.y, lv.z));
  const at = tank.turret.getWorldPosition(new THREE.Vector3());
  tank.body.applyImpulseAtPoint(dir.clone().multiplyScalar(-RECOIL_IMPULSE), at, true);
  return { pos, dir: shotDir, vel };
}
