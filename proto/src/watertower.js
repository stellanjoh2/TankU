// WWII steel water tower on the port yard (GLB from scripts/build_water_tower.py).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AIRFIELD_Y, PORT_YARD } from './terrain.js';

const SLAB_T = 0.06;

// Must match the dimensions in scripts/build_water_tower.py (metres, Y up, origin at ground centre).
const FOOT_HALF = 2.6;
const TOP_HALF = 1.75;
const FOOT_H = 0.6;
const BAY1_Y = 3.9;      // top of the lowest braced bay — taller than a Sherman
const DECK_Y = 10.6;
const DECK_T = 0.18;
const DECK_R = 2.95;
const TANK_R = 2.2;
const TANK_Y0 = DECK_Y + DECK_T;
const TANK_H = 4.6;
const ROOF_R = 2.5;
const ROOF_RISE = 1.5;
const FOOTPRINT = 3.2;   // half-size incl. footings + ladder

/** Ladder faces +X (toward the quay water). */
export const WATER_TOWER = {
  x: (PORT_YARD.x0 + PORT_YARD.x1) * 0.5 + 0.2,
  z: PORT_YARD.z0 + 6.8,
};

/**
 * @returns {Promise<{ root: THREE.Object3D, navObstacles: () => object[] }>}
 */
export async function buildWaterTower(scene, { RAPIER, world }) {
  const gltf = await new GLTFLoader().loadAsync('./models/water_tower.glb');
  const root = gltf.scene;
  root.name = 'WaterTower';
  const y0 = AIRFIELD_Y + SLAB_T;
  root.position.set(WATER_TOWER.x, y0, WATER_TOWER.z);
  root.traverse((o) => {
    if (o.isMesh) o.castShadow = o.receiveShadow = true;
  });
  scene.add(root);

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation(WATER_TOWER.x, y0, WATER_TOWER.z)
      .setUserData({ mat: 'metal' }),
  );
  const add = (desc) => world.createCollider(desc.setFriction(0.8), body);
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(RAPIER.ColliderDesc.cuboid(0.5, FOOT_H * 0.5, 0.5)
        .setTranslation(sx * FOOT_HALF, FOOT_H * 0.5, sz * FOOT_HALF));
      const a = new THREE.Vector3(sx * FOOT_HALF, FOOT_H, sz * FOOT_HALF);
      const b = new THREE.Vector3(sx * TOP_HALF, DECK_Y, sz * TOP_HALF);
      const d = b.clone().sub(a);
      const mid = a.add(b).multiplyScalar(0.5);
      q.setFromUnitVectors(up, d.clone().normalize());
      add(RAPIER.ColliderDesc.cuboid(0.12, d.length() * 0.5, 0.12)
        .setTranslation(mid.x, mid.y, mid.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
    }
  }

  // Lowest bay's X-bracing as thin walls so tanks can't drive through the struts.
  const bayHalf = FOOT_HALF + (TOP_HALF - FOOT_HALF) * ((FOOT_H + BAY1_Y) * 0.5 - FOOT_H) / (DECK_Y - FOOT_H);
  const bayH = (BAY1_Y - FOOT_H) * 0.5;
  const bayY = (BAY1_Y + FOOT_H) * 0.5;
  for (const s of [-1, 1]) {
    add(RAPIER.ColliderDesc.cuboid(bayHalf, bayH, 0.06).setTranslation(0, bayY, s * bayHalf));
    add(RAPIER.ColliderDesc.cuboid(0.06, bayH, bayHalf).setTranslation(s * bayHalf, bayY, 0));
  }

  add(RAPIER.ColliderDesc.cylinder(DECK_T * 0.5, DECK_R).setTranslation(0, DECK_Y + DECK_T * 0.5, 0));
  add(RAPIER.ColliderDesc.cylinder(TANK_H * 0.5, TANK_R).setTranslation(0, TANK_Y0 + TANK_H * 0.5, 0));
  add(RAPIER.ColliderDesc.cone(ROOF_RISE * 0.5, ROOF_R)
    .setTranslation(0, TANK_Y0 + TANK_H - 0.06 + ROOF_RISE * 0.5, 0));

  console.info(`[watertower] @ (${WATER_TOWER.x.toFixed(1)}, ${WATER_TOWER.z.toFixed(1)}) y=${y0.toFixed(2)}`);

  return {
    root,
    navObstacles() {
      return [{ type: 'box', x: WATER_TOWER.x, z: WATER_TOWER.z, hx: FOOTPRINT, hz: FOOTPRINT, yaw: 0 }];
    },
  };
}
