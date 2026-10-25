// Colour-coded steel drums around the port (barrels.glb, built by scripts/build_barrels.py).
// Red = fuel: detonates on a nearby shell / blast (chains to other reds) or a burst of .50 fire.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { heightAt } from './terrain.js';
import { HANGAR_PROP_SPOT } from './airfield.js';
import { lodDist, pickLod } from './lod.js';

/** Game-side upscale of the real-size drums in barrels.glb (0.88 m → 1.1 m) so they read from the chase cam. */
const SCALE = 1.25;
const VOL = SCALE ** 3;

/** Node names in barrels.glb, keyed by colour code. Density in kg/m³, divided by VOL so masses match the real drum. */
export const BARREL_KINDS = {
  red:    { node: 'Barrel_Red',    density: 600 / VOL, explosive: true },  // full fuel drum, ~130 kg
  blue:   { node: 'Barrel_Blue',   density: 450 / VOL },
  yellow: { node: 'Barrel_Yellow', density: 450 / VOL },
  old:    { node: 'Barrel_Old',    density: 85 / VOL },                    // empty and rusty, ~18 kg
};

const H = 0.88 * SCALE;
const R = 0.278 * SCALE;
const SLAB_TOP = 0.06;            // port / apron slabs sit this far above heightAt
const GAP = 0.6 * SCALE;          // centre spacing for grouped drums
const STACK_DY = Math.sqrt((2 * R) ** 2 - (GAP / 2) ** 2);

const MG_HITS_TO_DETONATE = 6;
const CHAIN_RADIUS = 3.2;         // any explosion this close sets a red drum off
const FUSE_MIN = 0.12;
const FUSE_PER_M = 0.08;          // farther drums cook off a bit later → readable chain
const FIRE_TIME = 5;              // s of flames left on the spot after a blast
const SETTLE_TIME = 1.5;          // s after spawn before drums are put to sleep (stops stack creep)

/** Camera-distance band edges (m): LOD0 (962 tris) < 20, LOD1 (384) < 45, LOD2 (115) beyond. */
const LOD_EDGES = [20, 45];
const LOD_LEVELS = LOD_EDGES.length + 1;
const CULL_DIST = 130;            // fog is nearly opaque here; a 1.1 m drum is a few pixels

/** Standing grid of drums, row-major; `kinds` cycles if shorter than cols × rows. */
function standGroup(kinds, cx, cz, cols, rows, yaw = 0) {
  const out = [];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const lx = (k - (cols - 1) / 2) * GAP;
      const lz = (r - (rows - 1) / 2) * GAP;
      out.push({
        kind: kinds[(r * cols + k) % kinds.length],
        x: cx + lx * c + lz * s, z: cz - lx * s + lz * c,
        yaw: (r * 7 + k * 3) * 0.7,
      });
    }
  }
  return out;
}

/** Drums on their sides, axes parallel (world Z rotated by `yaw`), with `top` stacked in the grooves. */
function lyingStack(kind, cx, cz, base, top = 0, yaw = 0) {
  const out = [];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const row = (n, lift) => {
    for (let i = 0; i < n; i++) {
      const lx = (i - (n - 1) / 2) * GAP;
      out.push({ kind, x: cx + lx * c, z: cz - lx * s, yaw, lie: true, lift });
    }
  };
  row(base, 0);
  if (top) row(top, STACK_DY);
  return out;
}

// Hangar footprint ≈ x −4.5…15.5, z −17.5…−4.5; east wall meets the port deck.
// Keep the wooden quay walkway and mid-deck clear for driving — cluster drums
// against the hangar instead (flag at 17.6, −16.5; trucks further south at z ≈ −20.6).
const LAYOUT = [
  // Fuel dump against hangar NE / east wall
  ...standGroup(['red'], 16.4, -15.2, 2, 2, 0.15),
  { kind: 'red', x: 17.1, z: -13.8, yaw: 0.4, lie: true },
  // Blue drums stacked on their sides along hangar east wall
  ...lyingStack('blue', 16.6, -8.2, 2, 1, Math.PI / 2),
  // Mixed working stock at hangar SE corner
  ...standGroup(['yellow', 'red', 'yellow'], 16.8, -5.0, 3, 1, -0.2),
  { kind: 'yellow', x: 15.6, z: -3.6, yaw: 1.1, lie: true },
  // Old empties by the flag / hangar back corner (pulled west off the walkway)
  { kind: 'old', x: 16.2, z: -16.8, yaw: 0.5 },
  { kind: 'old', x: 15.4, z: -17.6, yaw: 2.3, lie: true },
  // South of hangar, east of the trucks
  ...standGroup(['red', 'yellow'], 12.2, -19.4, 2, 1, Math.PI / 2),
  { kind: 'blue', x: 13.4, z: -18.2, yaw: 0.2, lie: true },
  // Replaces the old green placeholder by the hangar
  { kind: 'old', x: HANGAR_PROP_SPOT.x, z: HANGAR_PROP_SPOT.z, yaw: 0 },
];

/**
 * @returns {Promise<{
 *   dynamic: { obj: THREE.Group, body: object }[],
 *   onExplode: (point: THREE.Vector3) => void,
 *   sync: () => void, update: (dt: number, fx: object) => void, reset: () => void,
 *   updateLod: (camPos: THREE.Vector3) => void, getLodScale: () => number, setLodScale: (v: number) => void,
 *   mgHit: (body: object) => void, blastAt: (point: THREE.Vector3) => void,
 * }>}
 */
export async function buildBarrels(scene, { RAPIER, world }) {
  const gltf = await new GLTFLoader().loadAsync('./models/barrels.glb');
  const sources = {};    // kind → [{ geo, mat }] per LOD level (missing levels reuse the previous one)
  for (const [kind, { node }] of Object.entries(BARREL_KINDS)) {
    const levels = [];
    for (let lvl = 0; lvl < LOD_LEVELS; lvl++) {
      const src = gltf.scene.getObjectByName(lvl ? `${node}_LOD${lvl}` : node);
      if (!src?.isMesh) {
        if (!lvl) throw new Error(`[barrels] missing ${node} in barrels.glb`);
        levels.push(levels[lvl - 1]);
        continue;
      }
      // Body origin is the drum centre; the mesh comes in with its origin on the base.
      levels.push({ geo: src.geometry.clone().scale(SCALE, SCALE, SCALE).translate(0, -H / 2, 0), mat: src.material });
    }
    sources[kind] = levels;
  }

  const root = new THREE.Group();
  root.name = 'Barrels';
  scene.add(root);

  const live = [];       // { obj, lods, lod, body, kind, hits, fuse }
  const dynamic = [];    // Effects blast impulses read this ({ obj, body }); live drums only
  const byHandle = new Map();
  const fires = [];      // { pos, t }
  let settleT = SETTLE_TIME;
  let lodScale = 1;
  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();

  function spawn({ kind, x, z, yaw = 0, lie = false, lift = 0 }) {
    const obj = new THREE.Group();
    obj.name = `${BARREL_KINDS[kind].node}_${live.length}`;
    const lods = sources[kind].map(({ geo, mat }, lvl) => {
      const m = new THREE.Mesh(geo, mat);
      m.name = `${obj.name}_LOD${lvl}`;
      m.castShadow = lvl < LOD_LEVELS - 1;
      m.receiveShadow = true;
      m.visible = false;
      obj.add(m);
      return m;
    });
    root.add(obj);

    euler.set(lie ? Math.PI / 2 : 0, yaw, 0, 'YXZ');
    quat.setFromEuler(euler);
    const y = heightAt(x, z) + SLAB_TOP + (lie ? R : H / 2) + lift + 0.01;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation(quat)
      .setLinearDamping(0.05).setAngularDamping(0.25)
      .setCcdEnabled(true)
      .setUserData({ mat: 'metal', barrel: kind }));
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(H / 2, R)
        .setDensity(BARREL_KINDS[kind].density)
        .setFriction(0.55)
        .setRestitution(0.25),
      body,
    );
    obj.position.set(x, y, z);
    obj.quaternion.copy(quat);

    const b = { obj, lods, lod: -2, body, kind, hits: 0, fuse: -1 };
    live.push(b);
    dynamic.push(b);
    byHandle.set(body.handle, b);
  }

  function remove(b) {
    root.remove(b.obj);
    byHandle.delete(b.body.handle);
    world.removeRigidBody(b.body);
    live.splice(live.indexOf(b), 1);
    dynamic.splice(dynamic.indexOf(b), 1);
  }

  function arm(b, delay) {
    if (!BARREL_KINDS[b.kind].explosive) return;
    b.fuse = b.fuse < 0 ? delay : Math.min(b.fuse, delay);
  }

  /** Level -1 hides the drum (past CULL_DIST). */
  function setLod(b, level) {
    if (b.lod === level) return;
    b.lod = level;
    for (let i = 0; i < b.lods.length; i++) b.lods[i].visible = i === level;
  }

  function reset() {
    for (const b of [...live]) remove(b);
    fires.length = 0;
    settleT = SETTLE_TIME;
    for (const spec of LAYOUT) spawn(spec);
  }

  const api = {
    dynamic,
    /** Set by the match: tank damage / camera shake for a drum going up at `point`. */
    onExplode: () => {},

    sync() {
      for (const { obj, body } of live) {
        obj.position.copy(body.translation());
        obj.quaternion.copy(body.rotation());
      }
    },

    updateLod(camPos) {
      const cullPad = CULL_DIST * lodScale * 0.05;
      for (const b of live) {
        const d = b.obj.position.distanceTo(camPos);
        const cull = CULL_DIST * lodScale + (b.lod === -1 ? -cullPad : cullPad);
        setLod(b, lodDist(d) > cull ? -1 : pickLod(d, LOD_EDGES, lodScale, b.lod));
      }
    },

    getLodScale: () => lodScale,
    setLodScale(v) {
      lodScale = THREE.MathUtils.clamp(v, 0.25, 4);
    },

    /** Any explosion (shell, wreck, another drum) → cook off red drums within CHAIN_RADIUS. */
    blastAt(point) {
      for (const b of live) {
        const d = b.obj.position.distanceTo(point);
        if (d < CHAIN_RADIUS) arm(b, FUSE_MIN + d * FUSE_PER_M);
      }
    },

    /** .50 round hit `body`; red drums go up after a short burst. */
    mgHit(body) {
      const b = byHandle.get(body?.handle);
      if (b && ++b.hits >= MG_HITS_TO_DETONATE) arm(b, FUSE_MIN);
    },

    update(dt, fx) {
      if (settleT > 0 && (settleT -= dt) <= 0) {
        for (const { body } of live) body.sleep();
      }
      for (const b of [...live]) {
        if (b.fuse < 0 || (b.fuse -= dt) > 0) continue;
        const p = b.obj.position.clone();
        remove(b);
        fires.push({ pos: p.clone().setY(heightAt(p.x, p.z) + SLAB_TOP), t: FIRE_TIME });
        api.onExplode(p);
        fx.blast(p);   // fires fx.onImpact → blastAt → chain
      }
      for (let i = fires.length - 1; i >= 0; i--) {
        const f = fires[i];
        f.t -= dt;
        if (f.t <= 0) fires.splice(i, 1);
        else fx.burn(f.pos, dt, 0.4 + 1.2 * (f.t / FIRE_TIME));
      }
    },

    reset,
  };

  reset();
  console.info(`[barrels] ${live.length} drums (${Object.keys(BARREL_KINDS).join(' / ')})`);
  return api;
}
