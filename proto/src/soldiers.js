// American footsoldiers: walk the island in pairs via NavGrid A*.
// GLB is +X forward, metres; height ≈ 1.75 m to match world scale.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { heightAt, SIZE } from './terrain.js';

const PAIRS = 3;
const PAIR_GAP = 1.15;       // metres between buddies
const SPEED = 2.15;          // walk m/s
const ARRIVE = 1.4;
const GOAL_R = SIZE * 0.38;  // patrol radius from map centre
const _euler = new THREE.Euler();
const _fwd = new THREE.Vector3();
const yawOf = (dx, dz) => Math.atan2(-dz, dx); // +X-forward (same as tanks / planes)

function prep(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.flatShading = true;
    }
  });
  return root;
}

function pickGoal(nav, from) {
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 18 + Math.random() * GOAL_R;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (!nav.passable(x, z)) continue;
    if (Math.hypot(x - from.x, z - from.z) < 12) continue;
    return { x, z };
  }
  // Fallback: any open cell away from start
  const n = nav.n;
  for (let t = 0; t < 80; t++) {
    const k = (Math.random() * n * n) | 0;
    if (!Number.isFinite(nav.cost[k])) continue;
    const x = nav.xOf(k), z = nav.zOf(k);
    if (Math.hypot(x - from.x, z - from.z) > 15) return { x, z };
  }
  return { x: from.x + 20, z: from.z };
}

/**
 * @param {THREE.Scene} scene
 * @param {{ passable: Function, findPath: Function, cost: Float32Array, n: number, xOf: Function, zOf: Function }} nav
 */
export async function buildSoldiers(scene, nav) {
  const gltf = await new GLTFLoader().loadAsync('./models/footsoldier.glb');
  const proto = prep(gltf.scene);
  proto.updateMatrixWorld(true);

  const clips = gltf.animations || [];
  const walkClip = clips.find((c) => /walk/i.test(c.name)) || clips[0] || null;

  const root = new THREE.Group();
  root.name = 'Footsoldiers';
  scene.add(root);

  /** @type {{ lead: THREE.Object3D, wing: THREE.Object3D, units: { mesh: THREE.Object3D, mixer: THREE.AnimationMixer, action: THREE.AnimationAction | null }[], path: {x:number,z:number}[], wp: number, x: number, z: number, yaw: number, phase: number }[]} */
  const pairs = [];

  for (let i = 0; i < PAIRS; i++) {
    const lead = cloneSkinned(proto);
    const wing = cloneSkinned(proto);
    root.add(lead, wing);

    const units = [];
    for (const m of [lead, wing]) {
      const mixer = new THREE.AnimationMixer(m);
      let action = null;
      if (walkClip) {
        action = mixer.clipAction(walkClip);
        action.play();
        action.paused = false;
      }
      units.push({ mesh: m, mixer, action });
    }

    // Stagger spawn around the meadow / roads
    const a = (i / PAIRS) * Math.PI * 2 + 0.4;
    const d = 22 + i * 6;
    let x = Math.cos(a) * d;
    let z = Math.sin(a) * d;
    const open = nav.nearestOpen?.(x, z) ?? null;
    if (open) { x = open.x; z = open.z; }

    const pair = {
      lead, wing, units,
      path: [],
      wp: 0,
      x, z,
      yaw: a + Math.PI,
      phase: i * 0.37,
    };
    repath(pair, nav);
    pairs.push(pair);
  }

  function repath(pair, navGrid) {
    const goal = pickGoal(navGrid, pair);
    const { points } = navGrid.findPath(pair.x, pair.z, goal.x, goal.z, { maxIter: 5000 });
    pair.path = points.length ? points : [goal];
    pair.wp = 0;
  }

  function placePair(pair) {
    const y = heightAt(pair.x, pair.z);
    _euler.set(0, pair.yaw, 0, 'YXZ');
    pair.lead.position.set(pair.x, y, pair.z);
    pair.lead.quaternion.setFromEuler(_euler);

    _fwd.set(Math.cos(pair.yaw), 0, -Math.sin(pair.yaw));
    const rx = -_fwd.z;
    const rz = _fwd.x;
    const wx = pair.x + rx * PAIR_GAP;
    const wz = pair.z + rz * PAIR_GAP;
    pair.wing.position.set(wx, heightAt(wx, wz), wz);
    pair.wing.quaternion.copy(pair.lead.quaternion);
  }

  function update(dt) {
    for (const pair of pairs) {
      if (!pair.path.length || pair.wp >= pair.path.length) {
        repath(pair, nav);
      }

      const target = pair.path[Math.min(pair.wp, pair.path.length - 1)];
      const dx = target.x - pair.x;
      const dz = target.z - pair.z;
      const dist = Math.hypot(dx, dz);

      let moving = 0;
      if (dist < ARRIVE) {
        pair.wp++;
        if (pair.wp >= pair.path.length) repath(pair, nav);
      } else {
        const step = Math.min(SPEED * dt, dist);
        pair.x += (dx / dist) * step;
        pair.z += (dz / dist) * step;
        pair.yaw = yawOf(dx, dz);
        moving = 1;
      }

      placePair(pair);

      for (let mi = 0; mi < pair.units.length; mi++) {
        const u = pair.units[mi];
        if (u.action) u.action.timeScale = moving ? 1 : 0;
        u.mixer.update(mi === 1 ? dt * 1.03 : dt);
      }
    }
  }

  // Initial placement
  for (const p of pairs) placePair(p);

  return { root, update, pairs };
}
