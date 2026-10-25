// Static wooden crate props (wooden_crate_final.glb). Instanced filler around / inside
// the hangar — disappear on shell, nearby blast, or a short .50 burst (proper debris later).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { heightAt } from './terrain.js';
import { HANGAR, HANGAR_PROP_SPOT } from './airfield.js';

const SLAB_TOP = 0.06;
const SCALE = 2;              // GLB is 1×1×1.12 m → ~2×2×2.24 m in-game
const HALF_XZ = 0.5 * SCALE;
const HEIGHT = 1.119 * SCALE;
const HALF_Y = HEIGHT * 0.5;
const BLAST_R = 3.6;
const MG_HITS = 4;
// Worst-case AABB half-extent when yawed, plus a little air off the wall face.
const WALL_CLEAR = HALF_XZ * Math.SQRT2 + 0.25;

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(SCALE, SCALE, SCALE);
const _e = new THREE.Euler();

// Hangar ≈ x −4.5…15.5, z −17.5…−4.5; door west — keep the bay clear.
// Interior centres stay ≥ WALL_CLEAR inside the wall planes; exterior ≥ outside.
const LAYOUT = [
  { x: 12.0, z: -14.5, yaw: 0.25 },                         // inside, back-north
  { x: 11.5, z: -7.5, yaw: -0.35 },                         // inside, back-south
  { x: 15.5 + WALL_CLEAR, z: -11.2, yaw: 0.1 },             // outside east wall
  { x: HANGAR_PROP_SPOT.x + 2.2, z: HANGAR_PROP_SPOT.z + 1.4, yaw: 0.55 }, // SW apron
  { x: HANGAR.x - 1.5, z: -17.5 - WALL_CLEAR, yaw: -0.2 },  // north exterior
];

/**
 * @returns {Promise<{
 *   root: THREE.Group,
 *   navObstacles: () => object[],
 *   shellHit: (body: object) => boolean,
 *   mgHit: (body: object) => boolean,
 *   blastAt: (point: THREE.Vector3) => void,
 *   reset: () => void,
 * }>}
 */
export async function buildWoodenCrates(scene, { RAPIER, world }) {
  const gltf = await new GLTFLoader().loadAsync('./models/wooden_crate_final.glb');
  let src = null;
  gltf.scene.traverse((o) => { if (o.isMesh && !src) src = o; });
  if (!src) throw new Error('[woodenCrates] no mesh in wooden_crate_final.glb');

  // Mesh origin sits near the base (Y ≈ −0.024…1.095) — nudge so the underside is Y=0.
  const geo = src.geometry.clone().translate(0, 0.024, 0);
  const mat = src.material;

  const root = new THREE.Group();
  root.name = 'WoodenCrates';
  scene.add(root);

  const mesh = new THREE.InstancedMesh(geo, mat, LAYOUT.length);
  mesh.name = 'WoodenCrateInstances';
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  root.add(mesh);

  const live = []; // { body, x, y, z, yaw, hits }
  const byHandle = new Map();

  function writeInstances() {
    mesh.count = live.length;
    for (let i = 0; i < live.length; i++) {
      const c = live[i];
      _e.set(0, c.yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      // Geometry base at Y=0; instance origin is ground contact.
      _p.set(c.x, c.y - HALF_Y, c.z);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  function spawn({ x, z, yaw = 0 }) {
    _e.set(0, yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    const y = heightAt(x, z) + SLAB_TOP + HALF_Y + 0.01;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(x, y, z)
        .setRotation(_q)
        .setUserData({ crate: true }),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(HALF_XZ, HALF_Y, HALF_XZ)
        .setFriction(0.7)
        .setRestitution(0.05),
      body,
    );
    const c = { body, x, y, z, yaw, hits: 0 };
    live.push(c);
    byHandle.set(body.handle, c);
  }

  function remove(c, { deferBody = false } = {}) {
    const i = live.indexOf(c);
    if (i < 0) return;
    live.splice(i, 1);
    byHandle.delete(c.body.handle);
    writeInstances();
    // Shell path: onShellHit runs before fx._explode, which still calls isDynamic on
    // the hit collider's parent — drop the body on the next microtask.
    if (deferBody) queueMicrotask(() => world.removeRigidBody(c.body));
    else world.removeRigidBody(c.body);
  }

  function reset() {
    for (const c of [...live]) {
      byHandle.delete(c.body.handle);
      world.removeRigidBody(c.body);
    }
    live.length = 0;
    for (const spec of LAYOUT) spawn(spec);
    writeInstances();
  }

  const api = {
    root,

    navObstacles() {
      return live.map((c) => ({
        type: 'box', x: c.x, z: c.z, hx: HALF_XZ + 0.15, hz: HALF_XZ + 0.15, yaw: c.yaw,
      }));
    },

    shellHit(hitBody) {
      const c = byHandle.get(hitBody?.handle);
      if (!c) return false;
      remove(c, { deferBody: true });
      return true;
    },

    mgHit(hitBody) {
      const c = byHandle.get(hitBody?.handle);
      if (!c) return false;
      if (++c.hits >= MG_HITS) remove(c);
      return true;
    },

    blastAt(point) {
      for (const c of [...live]) {
        const d = Math.hypot(c.x - point.x, c.y - point.y, c.z - point.z);
        if (d < BLAST_R) remove(c);
      }
    },

    reset,
  };

  reset();
  console.info(`[woodenCrates] ${live.length} crates (≈${(HALF_XZ * 2).toFixed(1)}×${HEIGHT.toFixed(2)} m)`);
  return api;
}
