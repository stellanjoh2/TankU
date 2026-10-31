// Parked WWII 6x6 cargo trucks (army_truck.glb + army_truck_destroyed.glb).
// A main-gun hit swaps the intact LODs for the ruined mesh (water-tower style).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AIRFIELD_Y, heightAt } from './terrain.js';
import { lodDist, pickLod } from './lod.js';
import { applyBurntMetal } from './burntMetal.js';
import { wreckFireFade, wreckMeshFade, applyWreckMeshFade } from './fx.js';

const SLAB_T = 0.06;
const NODE = 'ArmyTruck';
const RUIN_NODE = 'ArmyTruck_Destroyed';
const LOD_EDGES = [28, 65];
const LOD_LEVELS = LOD_EDGES.length + 1;
const CULL_DIST = 180;
const SHEET_LINGER = 1.2;
// Damage-fire gif slots 0–1 are tanks; trucks start at 2.
const FIRE_SLOT0 = 2;
const FIRE_STAGE = 4; // wreck-sized flame

// Half-extents matching the intact GLB (metres, local +X forward, origin at ground centre).
const HX = 3.38;
const HY = 1.34;
const HZ = 1.25;

const SCRAP = [
  { size: [0.9, 0.03, 0.55], color: 0x3a3d28 },
  { size: [0.7, 0.03, 0.7], color: 0x6a5a38 },
  { size: [0.5, 0.03, 0.4], color: 0x2a2a2a },
];

/** Two deuces on the south apron, noses west, just off the hangar wall. */
export const TRUCK_SPOTS = [
  { x: 8.4, z: -20.6, yaw: Math.PI },
  { x: -0.8, z: -20.6, yaw: Math.PI },
];

function patchIntactMat(mat) {
  if (!mat || mat.userData.truckPatched) return;
  mat.userData.truckPatched = true;
  mat.side = THREE.FrontSide;
  mat.depthWrite = true;
  if (mat.transparent) mat.transparent = false;
  const n = mat.name || '';
  const top = /Canvas|Mark|Head|Tail/i.test(n);
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = top ? -1 : 1;
  mat.polygonOffsetUnits = top ? -1 : 1;
}

/**
 * @returns {Promise<{
 *   root: THREE.Group,
 *   navObstacles: () => object[],
 *   updateLod: (camPos: THREE.Vector3) => void,
 *   getLodScale: () => number,
 *   setLodScale: (v: number) => void,
 *   shellHit: (body: object, dir?: THREE.Vector3) => boolean,
 *   update: (dt: number, fx: object) => void,
 *   reset: (fx?: object) => void,
 * }>}
 */
export async function buildTrucks(scene, { RAPIER, world }) {
  const loader = new GLTFLoader();
  const [gltf, ruinGltf] = await Promise.all([
    loader.loadAsync('./models/army_truck.glb'),
    loader.loadAsync('./models/army_truck_destroyed.glb'),
  ]);

  const sources = [];
  for (let lvl = 0; lvl < LOD_LEVELS; lvl++) {
    const src = gltf.scene.getObjectByName(lvl ? `${NODE}_LOD${lvl}` : NODE);
    if (!src) {
      if (!lvl) throw new Error(`[trucks] missing ${NODE} in army_truck.glb`);
      sources.push(sources[lvl - 1]);
      continue;
    }
    src.position.set(0, 0, 0);
    src.rotation.set(0, 0, 0);
    src.scale.set(1, 1, 1);
    sources.push(src);
  }

  const ruinSrc = ruinGltf.scene.getObjectByName(RUIN_NODE) || ruinGltf.scene;
  ruinSrc.position.set(0, 0, 0);
  ruinSrc.rotation.set(0, 0, 0);
  ruinSrc.scale.set(1, 1, 1);
  applyBurntMetal(ruinSrc);

  const root = new THREE.Group();
  root.name = 'ArmyTrucks';
  scene.add(root);

  const y0 = AIRFIELD_Y + SLAB_T;
  const live = [];
  const sheets = [];
  let lodScale = 1;
  const smokeAt = new THREE.Vector3();

  function setLod(t, level) {
    if (t.dead) {
      // Ruin stays visible until it fades out; hide all intact LODs.
      for (let i = 0; i < t.lods.length; i++) t.lods[i].visible = false;
      t.ruin.visible = !t.gone;
      t.lod = -3;
      return;
    }
    if (t.lod === level) return;
    t.lod = level;
    for (let i = 0; i < t.lods.length; i++) t.lods[i].visible = i === level;
    t.ruin.visible = false;
  }

  function removeSheet(s) {
    scene.remove(s.mesh);
    s.mesh.geometry.dispose();
    s.mesh.material.dispose();
    world.removeRigidBody(s.body);
  }

  function spawnScrap(t, dir) {
    const { x, z, yaw } = t.spot;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (let i = 0; i < SCRAP.length; i++) {
      const { size, color } = SCRAP[i];
      const [w, h, d] = size;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.7 }),
      );
      mesh.castShadow = true;
      const a = (i / SCRAP.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
      const lx = Math.cos(a) * 2.2;
      const lz = Math.sin(a) * 1.4;
      const px = x + lx * c + lz * s;
      const pz = z - lx * s + lz * c;
      const py = y0 + 1.6 + i * 0.25;
      const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI,
      ));
      mesh.position.set(px, py, pz);
      mesh.quaternion.copy(quat);
      scene.add(mesh);
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(px, py, pz)
        .setRotation(quat)
        .setLinearDamping(0.1)
        .setAngularDamping(0.2)
        .setCcdEnabled(true)
        .setUserData({ mat: 'metal' }));
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2)
          .setDensity(220)
          .setFriction(0.55)
          .setRestitution(0.2),
        body,
      );
      const vel = new THREE.Vector3(
        Math.cos(a) * (5 + Math.random() * 3),
        5 + Math.random() * 3,
        Math.sin(a) * (5 + Math.random() * 3),
      );
      // Rotate burst into truck yaw
      const wx = vel.x * c + vel.z * s;
      const wz = -vel.x * s + vel.z * c;
      vel.set(wx, vel.y, wz);
      if (dir) vel.addScaledVector(dir, 2.5);
      body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
      body.setAngvel({
        x: (Math.random() - 0.5) * 12,
        y: (Math.random() - 0.5) * 12,
        z: (Math.random() - 0.5) * 12,
      }, true);
      sheets.push({ mesh, body, age: 0, linger: -1, truck: t });
    }
  }

  for (const [i, spot] of TRUCK_SPOTS.entries()) {
    const obj = new THREE.Group();
    obj.name = `${NODE}_${i}`;
    obj.position.set(spot.x, y0, spot.z);
    obj.rotation.y = spot.yaw;

    const lods = sources.map((src, lvl) => {
      const m = src.clone(true);
      m.name = `${obj.name}_LOD${lvl}`;
      m.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = lvl < LOD_LEVELS - 1;
        o.receiveShadow = false;
        if (lvl > 0) o.raycast = () => {};
        for (const mat of [].concat(o.material)) patchIntactMat(mat);
      });
      m.visible = false;
      obj.add(m);
      return m;
    });

    const ruin = ruinSrc.clone(true);
    ruin.name = `${obj.name}_Destroyed`;
    ruin.visible = false;
    obj.add(ruin);

    root.add(obj);

    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spot.yaw);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(spot.x, y0, spot.z)
        .setRotation(q)
        .setUserData({ mat: 'metal', camBlock: true }),
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(HX, HY, HZ)
        .setTranslation(0, HY, 0)
        .setFriction(0.8),
      body,
    );

    const t = {
      obj, lods, ruin, lod: -2, body, collider, spot, dead: false, gone: false,
      fireSlot: FIRE_SLOT0 + i,
      burnT: 0,
    };
    live.push(t);
    setLod(t, 0);
  }

  console.info(`[trucks] ${live.length} parked @ apron y=${y0.toFixed(2)} (destructible)`);

  return {
    root,
    navObstacles() {
      return TRUCK_SPOTS.map((s) => ({
        type: 'box', x: s.x, z: s.z, hx: HX + 0.25, hz: HZ + 0.25, yaw: s.yaw,
      }));
    },
    updateLod(camPos) {
      const cullPad = CULL_DIST * lodScale * 0.05;
      for (const t of live) {
        if (t.dead) {
          if (t.gone) {
            t.ruin.visible = false;
            continue;
          }
          // Keep ruin + fire FX visible until culled far away.
          const d = t.obj.position.distanceTo(camPos);
          const cull = CULL_DIST * lodScale + (t.ruin.visible ? cullPad : -cullPad);
          t.ruin.visible = lodDist(d) <= cull;
          continue;
        }
        const d = t.obj.position.distanceTo(camPos);
        const cull = CULL_DIST * lodScale + (t.lod === -1 ? -cullPad : cullPad);
        setLod(t, lodDist(d) > cull ? -1 : pickLod(d, LOD_EDGES, lodScale, t.lod));
      }
    },
    getLodScale: () => lodScale,
    setLodScale(v) {
      lodScale = THREE.MathUtils.clamp(v, 0.25, 4);
    },
    /** Main-gun shell hit. Returns true when the collider belongs to a truck. */
    shellHit(hitBody, dir) {
      const t = live.find((x) => x.body.handle === hitBody?.handle);
      if (!t) return false;
      if (t.dead) return true;
      t.dead = true;
      t.gone = false;
      t.burnT = 0;
      for (const m of t.lods) m.visible = false;
      applyWreckMeshFade(t.ruin, 1);
      t.ruin.visible = true;
      t.lod = -3;
      spawnScrap(t, dir);
      return true;
    },
    update(dt, fx) {
      for (const t of live) {
        if (!t.dead || t.gone || !fx) continue;
        t.burnT += dt;
        const k = wreckFireFade(t.burnT);
        if (k <= 0) {
          fx.setDamageFire(null, 0, t.fireSlot);
        } else if (t.ruin.visible) {
          // Fire gif is bottom-anchored — sit on terrain so flames don't float over the wreck.
          smokeAt.set(t.spot.x, heightAt(t.spot.x, t.spot.z), t.spot.z);
          fx.plume(smokeAt, dt * 0.85 * k);
          fx.setDamageFire(smokeAt, FIRE_STAGE, t.fireSlot, k);
        } else {
          fx.setDamageFire(null, 0, t.fireSlot);
        }
        const meshK = wreckMeshFade(t.burnT);
        if (meshK < 1) applyWreckMeshFade(t.ruin, meshK);
        if (meshK <= 0) {
          t.gone = true;
          t.ruin.visible = false;
          t.body.setEnabled(false);
        }
      }
      for (let i = sheets.length - 1; i >= 0; i--) {
        const s = sheets[i];
        const tr = s.body.translation();
        s.mesh.position.set(tr.x, tr.y, tr.z);
        s.mesh.quaternion.copy(s.body.rotation());
        s.age += dt;
        if (s.linger < 0) {
          const v = s.body.linvel();
          const onGround = tr.y - heightAt(tr.x, tr.z) < 0.5 && v.y < 1;
          const settled = s.age > 0.35 && Math.hypot(v.x, v.y, v.z) < 1.2;
          if (onGround || settled || s.age > 5) s.linger = SHEET_LINGER;
        } else if ((s.linger -= dt) <= 0) {
          removeSheet(s);
          sheets.splice(i, 1);
        }
      }
    },
    reset(fx) {
      for (const s of sheets) removeSheet(s);
      sheets.length = 0;
      for (const t of live) {
        t.dead = false;
        t.gone = false;
        t.burnT = 0;
        applyWreckMeshFade(t.ruin, 1);
        t.ruin.visible = false;
        t.lod = -2;
        if (!t.body.isEnabled()) t.body.setEnabled(true);
        fx?.setDamageFire(null, 0, t.fireSlot);
        setLod(t, 0);
      }
    },
  };
}
