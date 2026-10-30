// Supply drops. On a timer, a C-47 flies one straight pass and releases a
// wooden crate under a parachute. It lands, the walls fall flat and fade, and
// the pickup stays floating until you drive into it.
// Each crate is a coin-flip: health (green heart) or repair (purple wrench).
// tryPickup (wired in main) applies the kind.
import * as THREE from 'three';
import {
  heightAt, shoreSigned, onBridge, WATER_Y,
  PLAYER_SPAWN, ENEMY_SPAWN, ENEMY_SPAWN_BASE,
} from './terrain.js';
import { HANGAR } from './airfield.js';
import { WATER_TOWER } from './watertower.js';
import {
  WORLD_PICKUP_LIGHT,
  PICKUP_LIGHT_HEALTH,
  PICKUP_LIGHT_REPAIR,
} from './pickupLights.js';

const DROP_EVERY = 2 * 60; // dev cadence; ship timing is 5 min
const FIRST_PASS = 30;        // earliest the first C-47 / "Pickup Incoming" starts
const MAX_LIVE = 2;
const DESCEND = 4;             // m/s under the chute
const CHUTE_DELAY = 0.3;      // let the C-47 clear before the canopy blooms
const CHUTE_OPEN = 0.7;
const VIS_SCALE = 1.15;        // chute, crate and pickup
const W = 1.42, H = 1.08, D = 1.42;
const POST = 0.1, T = 0.05;
const CHUTE_Y = 6.4;
const CHUTE_R = 2.75;
const GRAB_R = 4.6;            // nose of the hull meets the floater around here
const REST_Y = 0.4;            // tucked in the closed crate
const FLOAT_Y = 1.7;           // hovering once the walls are down
const OPEN_DELAY = 0.28;
const WALL_TIME = 0.7;         // walls flop out flat
const FADE_TIME = 0.85;        // then the shell disappears
const EMPTY_LINGER = 12;
const CLEAR = 5.4;             // don't set the collider down inside a hull

const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _dust = new THREE.Vector3();
const _cord = new THREE.Vector3();

const woodMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0 });
woodMat.map = woodTexture();
const postMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.92 });
const canopyMat = new THREE.MeshStandardMaterial({
  color: 0xdcc9a6, roughness: 0.92, side: THREE.DoubleSide,
});
const cordMat = new THREE.MeshStandardMaterial({ color: 0x2a221c, roughness: 1 });
const markMat = new THREE.MeshBasicMaterial({ color: 0xe36a1e, side: THREE.DoubleSide });
/** HDR greens / shield-violets — keep in sync with tank.js hull sweeps. */
const HEALTH_GLOW = new THREE.Color().setRGB(0.22, 2.4, 0.4);
const SHIELD_GLOW = new THREE.Color().setRGB(0.95, 0.42, 2.55);
const heartTemplate = new THREE.MeshStandardMaterial({
  color: 0x0d3f1c, roughness: 0.38, metalness: 0.08,
  emissive: HEALTH_GLOW, emissiveIntensity: 1,
});
const wrenchTemplate = new THREE.MeshStandardMaterial({
  color: 0x1a0a3d, roughness: 0.38, metalness: 0.08,
  emissive: SHIELD_GLOW, emissiveIntensity: 1,
});
/** Shared ExtrudeGeometry from wrench_pickup.glb (Phosphor wrench, upright in XY). */
let wrenchGeo = null;

const postGeo = new THREE.BoxGeometry(POST, H, POST);
const PANEL_H = H - 0.02;
const panelXGeo = new THREE.BoxGeometry(W - POST + 0.02, PANEL_H, T);
const panelZGeo = new THREE.BoxGeometry(T, PANEL_H, D - POST + 0.02);
const floorGeo = new THREE.BoxGeometry(W - POST, T, D - POST);
const lidGeo = new THREE.BoxGeometry(W + 0.04, T, D + 0.02);
const battenGeo = new THREE.BoxGeometry(W * 0.16, 0.045, D * 0.9);
const canopyGeo = new THREE.SphereGeometry(CHUTE_R, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
const markGeo = new THREE.CircleGeometry(0.9, 18);
const cordGeo = new THREE.CylinderGeometry(0.018, 0.018, 1, 5);
const heartGeo = heartGeometry();

function woodTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#7a4e2b';
  g.fillRect(0, 0, 64, 128);
  const rows = 5;
  const rowH = 128 / rows;
  for (let i = 0; i < rows; i++) {
    const y = i * rowH;
    g.fillStyle = i % 2 ? '#6a4124' : '#8d5a34';
    g.fillRect(0, y + 1, 64, rowH - 3);
    g.fillStyle = 'rgba(40, 22, 8, 0.45)';
    g.fillRect(0, y + rowH - 3, 64, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function heartGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, 0.35);
  s.bezierCurveTo(0, 0.35, -0.05, 0.72, -0.45, 0.72);
  s.bezierCurveTo(-1.05, 0.72, -1.05, 0.12, -1.05, -0.05);
  s.bezierCurveTo(-1.05, -0.45, -0.65, -0.85, 0, -1.25);
  s.bezierCurveTo(0.65, -0.85, 1.05, -0.45, 1.05, -0.05);
  s.bezierCurveTo(1.05, 0.12, 1.05, 0.72, 0.45, 0.72);
  s.bezierCurveTo(0.05, 0.72, 0, 0.35, 0, 0.35);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.42,
    bevelEnabled: true,
    bevelThickness: 0.06,
    bevelSize: 0.06,
    bevelSegments: 1,
    curveSegments: 8,
  });
  // Upright in XY. The crate spins every pickup around Y, so later icons should stand the same way.
  geo.center();
  geo.computeVertexNormals();
  return geo;
}

function shaded(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function grade(x, z) {
  const e = 2.5;
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
}

/** Flat inland ground a tank can drive to, clear of buildings and respawn pads. */
function dropOk(x, z) {
  if (shoreSigned(x, z) < 12) return false;
  if (heightAt(x, z) < WATER_Y + 0.8) return false;
  if (onBridge(x, z, 3)) return false;
  if (grade(x, z) > 0.16) return false;
  if (Math.abs(x - HANGAR.x) < 11 && Math.abs(z - HANGAR.z) < 8) return false;
  if (Math.hypot(x - WATER_TOWER.x, z - WATER_TOWER.z) < 6) return false;
  if (Math.hypot(x - PLAYER_SPAWN.x, z - PLAYER_SPAWN.z) < 10) return false;
  if (Math.hypot(x - ENEMY_SPAWN.x, z - ENEMY_SPAWN.z) < 10) return false;
  if (Math.hypot(x - ENEMY_SPAWN_BASE.x, z - ENEMY_SPAWN_BASE.z) < 12) return false;
  return true;
}

function cordBetween(a, b) {
  const m = new THREE.Mesh(cordGeo, cordMat);
  _cord.subVectors(b, a);
  const len = _cord.length();
  m.position.copy(a).addScaledVector(_cord, 0.5);
  m.scale.y = len;
  _cord.multiplyScalar(1 / (len || 1));
  m.quaternion.setFromUnitVectors(_up, _cord);
  m.castShadow = true;
  return m;
}

/** Tucked in the crate so it doesn't show through the planks, then the pop size. Every kind uses these. */
const PICKUP_BOXED = 0.36 * 1.2 * 0.8;
const PICKUP_SCALE = PICKUP_BOXED * 1.3 * 1.2;

function buildPickup(kind) {
  let mat;
  let mesh;
  if (kind === 'health') {
    mat = heartTemplate.clone();
    mesh = new THREE.Mesh(heartGeo, mat);
  } else if (kind === 'repair') {
    if (!wrenchGeo) throw new Error('[crates] wrench geometry not loaded');
    mat = wrenchTemplate.clone();
    mesh = new THREE.Mesh(wrenchGeo, mat);
  } else {
    throw new Error(`[crates] no mesh for pickup "${kind}"`);
  }
  mesh.scale.setScalar(PICKUP_BOXED);
  mesh.castShadow = true;
  // Light comes from the createCrates pool — never new PointLight at release (WebGPU recompile hitch).
  return { kind, mesh, mat, light: null, base: PICKUP_SCALE, phase: Math.random() * Math.PI * 2, takeT: -1, dead: false };
}

/** One hinge per wall. `axis`/`sign`/`angle` flop it outward onto the ground. */
function addWall(parent, x, y, z, axis, sign, angle, mesh) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.add(mesh);
  parent.add(g);
  return { g, axis, sign, angle };
}

function buildVisual() {
  const root = new THREE.Group();
  root.name = 'SupplyCrate';
  root.scale.setScalar(VIS_SCALE);

  const wood = woodMat.clone();
  const post = postMat.clone();
  wood.transparent = post.transparent = true;
  const shellMats = [wood, post];
  const shell = new THREE.Group();
  root.add(shell);

  const hz = D / 2 - POST / 2;
  const walls = [];

  const right = new THREE.Group();
  right.position.set(W / 2, 0, 0);
  right.add(shaded(panelZGeo, wood, -T / 2, PANEL_H / 2, 0));
  right.add(shaded(postGeo, post, -POST / 2, H / 2, hz));
  right.add(shaded(postGeo, post, -POST / 2, H / 2, -hz));
  shell.add(right);
  walls.push({ g: right, axis: 'z', sign: -1, angle: Math.PI / 2 });

  const left = new THREE.Group();
  left.position.set(-W / 2, 0, 0);
  left.add(shaded(panelZGeo, wood, T / 2, PANEL_H / 2, 0));
  left.add(shaded(postGeo, post, POST / 2, H / 2, hz));
  left.add(shaded(postGeo, post, POST / 2, H / 2, -hz));
  shell.add(left);
  walls.push({ g: left, axis: 'z', sign: 1, angle: Math.PI / 2 });

  walls.push(addWall(
    shell, 0, 0, D / 2, 'x', 1, Math.PI / 2,
    shaded(panelXGeo, wood, 0, PANEL_H / 2, -T / 2),
  ));
  walls.push(addWall(
    shell, 0, 0, -D / 2, 'x', -1, Math.PI / 2,
    shaded(panelXGeo, wood, 0, PANEL_H / 2, T / 2),
  ));
  shell.add(shaded(floorGeo, wood, 0, T / 2, 0));

  const lid = new THREE.Group();
  lid.position.set(0, H, -D / 2);
  lid.add(shaded(lidGeo, wood, 0, T / 2, D / 2));
  lid.add(shaded(battenGeo, post, -W * 0.22, T + 0.03, D / 2));
  lid.add(shaded(battenGeo, post, W * 0.22, T + 0.03, D / 2));
  shell.add(lid);

  const chute = new THREE.Group();
  chute.position.y = CHUTE_Y;
  const canopy = new THREE.Mesh(canopyGeo, canopyMat);
  canopy.scale.y = 0.42;
  canopy.castShadow = true;
  chute.add(canopy);
  const mark = new THREE.Mesh(markGeo, markMat);
  mark.rotation.x = -Math.PI / 2;
  mark.position.y = CHUTE_R * 0.42 + 0.04;
  chute.add(mark);
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const rim = new THREE.Vector3(sx * CHUTE_R * 0.7, 0.06, sz * CHUTE_R * 0.7);
    const foot = new THREE.Vector3(sx * (W / 2 - 0.04), H - CHUTE_Y, sz * (D / 2 - 0.04));
    chute.add(cordBetween(rim, foot));
  }
  root.add(chute);

  const kind = Math.random() < 0.5 ? 'health' : 'repair';
  const item = buildPickup(kind);
  item.mesh.position.set(0, REST_Y, 0);
  root.add(item.mesh);

  return { root, walls, lid, shell, shellMats, chute, items: [item] };
}

/**
 * @param {object} deps
 * @param {() => object} deps.getPlayer
 * @param {() => object[]} deps.getTanks
 * @param {(kind: string) => boolean} deps.tryPickup  true if the pickup was consumed
 * @param {() => void} [deps.onIncoming]  the C-47 has started its pass
 * @param {THREE.BufferGeometry} deps.wrenchGeo  extruded Phosphor wrench (shared)
 * @param {{ update: (dt: number) => void, beginPass: Function, inbound: number, untilRelease: () => number | null }} deps.transport
 */
export function createCrates({ scene, RAPIER, world, fx, getPlayer, getTanks, tryPickup, onIncoming = () => {}, transport, wrenchGeo: geo }) {
  wrenchGeo = geo;
  const root = new THREE.Group();
  root.name = 'SupplyCrates';
  scene.add(root);

  // Keep light count fixed for the whole match. Adding/removing a PointLight at drop
  // time forces a full material recompile on WebGPU and freezes the game for seconds.
  const lightPool = Array.from({ length: MAX_LIVE }, () => {
    const l = new THREE.PointLight(
      0xffffff, 0, WORLD_PICKUP_LIGHT.distance, WORLD_PICKUP_LIGHT.decay,
    );
    l.castShadow = false;
    root.add(l);
    return l;
  });

  const live = [];
  function openingTimer() {
    return DROP_EVERY - FIRST_PASS;
  }
  let timer = openingTimer();

  function bindLight(item) {
    const used = new Set();
    for (const c of live) {
      for (const it of c.items) if (it.light) used.add(it.light);
    }
    const light = lightPool.find((l) => !used.has(l));
    if (!light) return;
    light.color.copy(item.kind === 'health' ? PICKUP_LIGHT_HEALTH : PICKUP_LIGHT_REPAIR);
    light.intensity = 0;
    light.position.set(0, 0, 0);
    item.mesh.add(light);
    item.light = light;
  }

  function unbindLight(item) {
    const light = item.light;
    if (!light) return;
    light.intensity = 0;
    light.color.setRGB(0, 0, 0);
    root.add(light);
    light.position.set(0, 0, 0);
    item.light = null;
  }

  function closestTank(x, z, maxD) {
    let best = null;
    let bestD = maxD;
    for (const t of getTanks()) {
      if (!t.alive) continue;
      const p = t.position;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /** Push the landing spot out of any hull. Null if that leaves the island. */
  function clearSpot(x, z) {
    let cx = x, cz = z;
    for (let n = 0; n < 4; n++) {
      const hit = closestTank(cx, cz, CLEAR);
      if (!hit) return dropOk(cx, cz) ? { x: cx, z: cz } : null;
      const dx = cx - hit.x, dz = cz - hit.z;
      const len = Math.hypot(dx, dz) || 1;
      cx = hit.x + (dx / len) * (CLEAR + 0.5);
      cz = hit.z + (dz / len) * (CLEAR + 0.5);
    }
    return null;
  }

  function removeCrate(c) {
    const i = live.indexOf(c);
    if (i < 0) return;
    live.splice(i, 1);
    for (const item of c.items) unbindLight(item);
    root.remove(c.root);
    if (c.body) world.removeRigidBody(c.body);
    for (const item of c.items) item.mat.dispose();
    for (const m of c.shellMats) m.dispose();
  }

  function makeRoom(player) {
    const p = player?.position;
    while (live.length >= MAX_LIVE) {
      let idx = 0;
      if (p) {
        let far = -1;
        for (let i = 0; i < live.length; i++) {
          const d = Math.hypot(live[i].x - p.x, live[i].z - p.z);
          if (d > far) { far = d; idx = i; }
        }
      }
      removeCrate(live[idx]);
    }
  }

  function pickSpot(player) {
    const p = player.position;
    _q.copy(player.body.rotation());
    _fwd.set(1, 0, 0).applyQuaternion(_q);
    const heading = Math.atan2(_fwd.z, _fwd.x);
    const spreads = [1.0, Math.PI];
    for (const spread of spreads) {
      for (let i = 0; i < 18; i++) {
        const ang = spread === Math.PI
          ? Math.random() * Math.PI * 2
          : heading + (Math.random() - 0.5) * 2 * spread;
        const dist = 24 + Math.random() * 16;
        const x = p.x + Math.cos(ang) * dist;
        const z = p.z + Math.sin(ang) * dist;
        if (!dropOk(x, z) || closestTank(x, z, 8)) continue;
        let blocked = false;
        for (const c of live) {
          if (Math.hypot(c.x - x, c.z - z) < 10) blocked = true;
        }
        if (!blocked) return { x, z };
      }
    }
    return null;
  }

  function land(c) {
    const spot = clearSpot(c.x, c.z);
    if (!spot) {
      c.y = heightAt(c.x, c.z) + 5;
      return;
    }
    c.x = spot.x;
    c.z = spot.z;
    c.y = heightAt(c.x, c.z);
    c.state = 'down';
    c.landedAt = c.age;
    c.root.position.set(c.x, c.y, c.z);
    c.root.rotation.set(0, c.yaw, 0);
    const halfH = H * VIS_SCALE * 0.5;
    c.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(c.x, c.y + halfH, c.z)
        .setRotation(_q.setFromAxisAngle(_up, c.yaw)),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(W * VIS_SCALE * 0.5, halfH, D * VIS_SCALE * 0.5).setFriction(0.8),
      c.body,
    );
    _dust.set(c.x, c.y + 0.25, c.z);
    for (let i = 0; i < 5; i++) fx.dust(_dust, 1);
  }

  function poseChuteClosed(chute) {
    chute.scale.setScalar(0.16);
    chute.position.y = 1.05;
  }

  function release(spot, dropY) {
    makeRoom(getPlayer());
    const { x, z } = spot;
    const visual = buildVisual();
    for (const item of visual.items) bindLight(item);
    poseChuteClosed(visual.chute);
    const yaw = Math.random() * Math.PI * 2;
    visual.root.position.set(x, dropY, z);
    visual.root.rotation.set(0, yaw, 0);
    root.add(visual.root);
    const ang = Math.random() * Math.PI * 2;
    const spd = 0.35 + Math.random() * 0.45;
    live.push({
      ...visual,
      x, y: dropY, z, yaw,
      vx: Math.cos(ang) * spd,
      vz: Math.sin(ang) * spd,
      state: 'fall',
      age: 0,
      landedAt: 0,
      chuteT: 0,
      chuteOpen: 0,
      emptyFor: 0,
      body: null,
    });
  }

  function spawn(player) {
    const spot = pickSpot(player);
    if (!spot) return false;
    if (!transport.beginPass(spot.x, spot.z, (dropY) => release(spot, dropY))) return false;
    onIncoming();
    return true;
  }

  function collapseChute(c, dt) {
    if (!c.chute.visible) return;
    c.chuteT = Math.min(1, c.chuteT + dt / 1.15);
    const k = c.chuteT * c.chuteT;
    c.chute.position.y = CHUTE_Y + (0.35 - CHUTE_Y) * k;
    c.chute.rotation.z = k * 1.35;
    c.chute.rotation.x = k * 0.45;
    c.chute.scale.setScalar(Math.max(0.02, 1 - k * 0.94));
    if (c.chuteT >= 1) c.chute.visible = false;
  }

  function openChute(c) {
    if (c.chuteOpen >= 1 || !c.chute.visible) return;
    const t = Math.max(0, c.age - CHUTE_DELAY);
    c.chuteOpen = Math.min(1, t / CHUTE_OPEN);
    const k = 1 - (1 - c.chuteOpen) ** 2;
    c.chute.scale.setScalar(0.16 + 0.84 * k);
    c.chute.position.y = 1.05 + (CHUTE_Y - 1.05) * k;
  }

  function stepFall(c, dt) {
    openChute(c);
    const nx = c.x + c.vx * dt;
    const nz = c.z + c.vz * dt;
    if (dropOk(nx, nz)) { c.x = nx; c.z = nz; }
    else { c.vx = 0; c.vz = 0; }
    c.y -= DESCEND * dt;
    const ground = heightAt(c.x, c.z);
    if (c.y <= ground) land(c);
    if (c.state !== 'fall') return;
    c.root.position.set(
      c.x + Math.sin(c.age * 0.65) * 0.35,
      c.y,
      c.z + Math.cos(c.age * 0.5) * 0.28,
    );
    c.root.rotation.set(
      Math.cos(c.age * 0.8) * 0.04,
      c.yaw,
      Math.sin(c.age * 1.05) * 0.05,
      'YXZ',
    );
  }

  function dropBody(c) {
    if (!c.body) return;
    world.removeRigidBody(c.body);
    c.body = null;
  }

  function stepItems(c, dt, player, reveal, open) {
    const p = player?.alive ? player.position : null;
    const d = p ? Math.hypot(p.x - c.x, p.z - c.z) : Infinity;
    let any = false;
    for (const item of c.items) {
      if (item.dead) continue;
      any = true;
      if (item.takeT >= 0) {
        item.takeT -= dt;
        const k = Math.max(0, item.takeT / 0.24);
        item.mesh.scale.setScalar(item.base * k);
        item.mesh.position.y += dt * 1.6;
        if (item.light) item.light.intensity = WORLD_PICKUP_LIGHT.intensity * k;
        if (item.takeT <= 0) {
          unbindLight(item);
          item.mesh.removeFromParent();
          item.mat.dispose();
          item.dead = true;
        }
        continue;
      }
      item.mesh.rotation.y += dt * 2.2;
      const bob = reveal > 0.05 ? Math.sin(c.age * 3.2 + item.phase) * 0.06 : 0;
      item.mesh.position.y = THREE.MathUtils.lerp(REST_Y, FLOAT_Y, reveal) + bob;
      item.mesh.scale.setScalar(THREE.MathUtils.lerp(PICKUP_BOXED, item.base, reveal));
      item.mat.emissiveIntensity = 1 + Math.sin(c.age * 4 + item.phase) * 0.12;
      // Reveal with the crate open so it doesn't bleed through closed walls.
      if (item.light) item.light.intensity = WORLD_PICKUP_LIGHT.intensity * reveal;
      if (open && d < GRAB_R && tryPickup(item.kind)) item.takeT = 0.24;
    }
    if (any) return;
    c.emptyFor += dt;
    if (c.emptyFor > EMPTY_LINGER) removeCrate(c);
  }

  function step(c, dt, player) {
    c.age += dt;
    if (c.state === 'fall') {
      stepFall(c, dt);
      return;
    }
    collapseChute(c, dt);
    const since = c.age - c.landedAt;
    const wallT = Math.min(1, Math.max(0, (since - OPEN_DELAY) / WALL_TIME));
    const k = 1 - (1 - wallT) ** 3;
    for (const w of c.walls) w.g.rotation[w.axis] = w.sign * w.angle * k;
    c.lid.position.y = THREE.MathUtils.lerp(H, T, k);
    const fadeT = Math.min(1, Math.max(0, (since - OPEN_DELAY - WALL_TIME) / FADE_TIME));
    if (fadeT > 0 && c.shell.visible) {
      const o = 1 - fadeT;
      for (const m of c.shellMats) {
        m.opacity = o;
        m.depthWrite = o > 0.2;
      }
      if (fadeT >= 1) c.shell.visible = false;
    }
    if (wallT >= 1) dropBody(c);
    stepItems(c, dt, player, k, wallT >= 1);
  }

  return {
    /** Clear landed and falling crates, and cancel a pass that has not released yet. */
    reset() {
      for (const c of [...live]) removeCrate(c);
      transport.abort();
      timer = openingTimer();
    },
    /** Seconds until the next crate is released. */
    timeToDrop() {
      const flying = transport.untilRelease();
      if (flying != null) return flying;
      return Math.max(0, DROP_EVERY - timer) + transport.inbound;
    },
    update(dt) {
      transport.update(dt);
      const player = getPlayer();
      timer += dt;
      if (timer >= DROP_EVERY && player) {
        if (spawn(player)) timer = 0;
      }
      for (const c of [...live]) step(c, dt, player);
    },
  };
}
