// Ship Support: the cruiser for that half of the island sounds a horn, trains on the
// circle painted with the reticle, then dumps every cannon over 5s. Shells are the same tracers
// as the tank gun. Most of them hit the painted circle. A few are aimed
// at a live enemy, wherever that tank is. The call does not need an enemy.

import * as THREE from 'three';
import { WATER_Y } from './terrain.js';
import { SHELL_SPEED } from './tankWeapons.js';
import { createGroundMark, placeGroundMark, pulseGroundMark, hideGroundMark, tickGroundMark } from './groundMark.js';

export const SHIP_SUPPORT_COOLDOWN = 50;
/** Horn, then the barrage. This is the time you have to leave the marked circle. */
const HORN_S = 5;
const BARRAGE_S = 5;
/** Share of shells aimed at the live enemy. The rest hit the marked circle. */
const HIT_CHANCE = 0.3;
const SCATTER = 16;
/** Terrain farther than this from a shell's aim point does not stop it. */
const ARM = SCATTER + 4;
const YAW_RATE = 1.6;
/** Main-island land midline. The coast runs about x = -118..38, so x = 0 is not halfway. */
const ISLAND_SPLIT_X = -35;
const G = 9.81;

const _inv = new THREE.Matrix4();
const _local = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _bore = new THREE.Vector3();

function wrap(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Ballistic direction so a shell at `speed` falls onto `to`. */
function ballistic(from, to, speed, out) {
  const flat = Math.hypot(to.x - from.x, to.z - from.z);
  const t = Math.max(0.05, flat / speed);
  out.copy(to);
  out.y += 0.5 * G * t * t;
  return out.sub(from).normalize();
}

/**
 * @param {{
 *   ships: { x: number, z: number, turrets: { pivot: import('three').Object3D, muzzles: import('three').Object3D[], sign: number }[] }[],
 *   fx: { fire: Function, navalMuzzle: Function },
 *   sfx: { shipHorn: Function, fire: Function },
 *   getSpot: () => { x: number, y: number, z: number } | null,
 *   getTarget: () => { x: number, y: number, z: number } | null,
 *   getListener: () => { x: number, y: number, z: number },
 *   heightAt: (x: number, z: number) => number,
 *   distGain: (d: number, maxDist: number) => number,
 *   scene: import('three').Scene,
 * }} deps
 */
export function createShipSupport({ ships, fx, sfx, getSpot, getTarget, getListener, heightAt, distGain, scene }) {
  let cd = 0;
  /** @type {'idle'|'warn'|'fire'|'stow'} */
  let phase = 'idle';
  let t = 0;
  let shotT = 0;
  let shotI = 0;
  let call = null;
  let ship = null;
  /** @type {{ pivot: import('three').Object3D, muzzles: import('three').Object3D[], sign: number }[][]} */
  let guns = [];
  const zone = createGroundMark(scene, SCATTER);

  /** West of the island midline, including the satellite, is the western cruiser. */
  function shipForHalf(x) {
    const ready = ships.filter((s) => s.turrets.length);
    if (!ready.length) return null;
    ready.sort((a, b) => a.x - b.x);
    return x < ISLAND_SPLIT_X ? ready[0] : ready[ready.length - 1];
  }

  function aimYaw(turret, world) {
    _local.copy(world).applyMatrix4(_inv.copy(turret.pivot.parent.matrixWorld).invert());
    const dx = _local.x - turret.pivot.position.x;
    const dy = _local.y - turret.pivot.position.y;
    const rest = turret.sign >= 0 ? 0 : Math.PI;
    return wrap(Math.atan2(dy, dx) - rest);
  }

  function stepTurrets(dt, world) {
    if (!ship) return;
    for (const turret of ship.turrets) {
      const want = world ? aimYaw(turret, world) : 0;
      const cur = turret.pivot.rotation.z;
      let d = wrap(want - cur);
      const max = YAW_RATE * dt;
      if (Math.abs(d) > max) d = Math.sign(d) * max;
      turret.pivot.rotation.z = cur + d;
    }
  }

  function fireGun(muzzle) {
    const turret = muzzle.parent;
    turret.updateWorldMatrix(true, true);
    muzzle.getWorldPosition(_muzzle);
    turret.getWorldPosition(_pivot);
    _bore.copy(_muzzle).sub(_pivot);
    if (_bore.lengthSq() < 1e-6) _bore.set(1, 0, 0);
    else _bore.normalize();

    const live = getTarget();
    const accurate = !!live && Math.random() < HIT_CHANCE;
    let ax, ay, az;
    if (accurate) {
      ax = live.x;
      ay = live.y;
      az = live.z;
    } else {
      const a = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random()) * SCATTER;
      ax = call.x + Math.cos(a) * rad;
      az = call.z + Math.sin(a) * rad;
      // On the surface. The seabed is below the sea, so a water paint aims at the waterline.
      const ground = heightAt(ax, az);
      ay = ground < WATER_Y ? WATER_Y : ground;
    }
    _aim.set(ax, ay, az);
    ballistic(_muzzle, _aim, SHELL_SPEED, _dir);
    const flat = Math.hypot(ax - _muzzle.x, az - _muzzle.z);
    const pos = _muzzle.clone();
    fx.navalMuzzle(pos, _bore);
    fx.fire({
      pos,
      vel: _dir.clone().multiplyScalar(SHELL_SPEED),
      owner: null,
      naval: true,
      aim: { x: ax, y: ay, z: az, r: ARM, fuse: Math.max(0.05, flat / SHELL_SPEED) + 0.15 },
    });
    const ear = getListener();
    const dist = Math.hypot(pos.x - ear.x, pos.y - ear.y, pos.z - ear.z);
    sfx.fire(0.95 * distGain(dist, 280), dist, 0.74);
  }

  return {
    get cd() { return cd; },
    get ready() { return cd <= 0 && phase === 'idle'; },

    call() {
      if (cd > 0 || phase !== 'idle') return false;
      const spot = getSpot();
      if (!spot) return false;
      const x = spot.x;
      const y = spot.y;
      const z = spot.z;
      ship = shipForHalf(x);
      if (!ship) return false;
      guns = [];
      const n = Math.max(...ship.turrets.map((tur) => tur.muzzles.length));
      for (let i = 0; i < n; i++) {
        for (const tur of ship.turrets) {
          if (tur.muzzles[i]) guns.push(tur.muzzles[i]);
        }
      }
      if (!guns.length) return false;
      call = { x, y, z };
      placeGroundMark(zone, x, z, heightAt);
      phase = 'warn';
      t = 0;
      shotT = 0;
      shotI = 0;
      cd = SHIP_SUPPORT_COOLDOWN;
      sfx.shipHorn();
      return true;
    },

    update(dt) {
      if (cd > 0) cd = Math.max(0, cd - dt);
      tickGroundMark(zone, dt, heightAt);
      if (phase === 'idle') return;

      const ground = heightAt(call.x, call.z);
      const world = _aim.set(call.x, (ground < WATER_Y ? WATER_Y : ground) + 1.2, call.z);

      if (phase === 'warn') {
        t += dt;
        stepTurrets(dt, world);
        pulseGroundMark(zone, t, HORN_S);
        if (t >= HORN_S) {
          phase = 'fire';
          t = 0;
          shotT = BARRAGE_S / guns.length;
        }
        return;
      }

      if (phase === 'fire') {
        t += dt;
        shotT += dt;
        stepTurrets(dt, world);
        pulseGroundMark(zone, HORN_S + t, HORN_S);
        const step = BARRAGE_S / guns.length;
        while (shotI < guns.length && shotT >= step) {
          shotT -= step;
          fireGun(guns[shotI]);
          shotI++;
        }
        if (shotI >= guns.length) {
          phase = 'stow';
          hideGroundMark(zone);
        }
        return;
      }

      stepTurrets(dt, null);
      const stowed = ship.turrets.every((tur) => Math.abs(wrap(tur.pivot.rotation.z)) < 0.02);
      if (stowed) {
        for (const tur of ship.turrets) tur.pivot.rotation.z = 0;
        phase = 'idle';
        ship = null;
        guns = [];
      }
    },
  };
}
