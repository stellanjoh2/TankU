// WWII steel water tower on the port yard (GLB from scripts/build_water_tower.py).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AIRFIELD_Y, PORT_YARD, heightAt } from './terrain.js';

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
const SHEET_LINGER = 1;  // seconds on the ground before the scrap vanishes
const SHEETS = [
  { size: [1.5, 0.04, 0.85], color: 0x6d8fa6 },
  { size: [1.15, 0.04, 1.2], color: 0x8d5c38 },
  { size: [0.75, 0.035, 0.7], color: 0xc8c2b2 },
];

/** Ladder faces +X (toward the quay water). */
export const WATER_TOWER = {
  x: (PORT_YARD.x0 + PORT_YARD.x1) * 0.5 + 0.2,
  z: PORT_YARD.z0 + 6.8,
};

/**
 * @returns {Promise<{ root: THREE.Object3D, navObstacles: () => object[],
 *   shellHit: (body: object, dir?: THREE.Vector3) => boolean,
 *   update: (dt: number, fx: object) => void, reset: () => void }>}
 */
export async function buildWaterTower(scene, { RAPIER, world }) {
  const loader = new GLTFLoader();
  const [intactGltf, ruinedGltf] = await Promise.all([
    loader.loadAsync('./models/water_tower.glb'),
    loader.loadAsync('./models/water_tower_destroyed.glb'),
  ]);
  const root = intactGltf.scene;
  const ruined = ruinedGltf.scene;
  root.name = 'WaterTower';
  ruined.name = 'WaterTowerDestroyed';
  const y0 = AIRFIELD_Y + SLAB_T;
  for (const obj of [root, ruined]) {
    obj.position.set(WATER_TOWER.x, y0, WATER_TOWER.z);
    obj.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });
    scene.add(obj);
  }
  ruined.visible = false;

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
  // Tank and roof go away with the swap. Legs, footings and the low bay stay.
  const upper = [
    add(RAPIER.ColliderDesc.cylinder(TANK_H * 0.5, TANK_R).setTranslation(0, TANK_Y0 + TANK_H * 0.5, 0)),
    add(RAPIER.ColliderDesc.cone(ROOF_RISE * 0.5, ROOF_R)
      .setTranslation(0, TANK_Y0 + TANK_H - 0.06 + ROOF_RISE * 0.5, 0)),
  ];

  let dead = false;
  const sheets = [];
  const smokeAt = new THREE.Vector3();

  function removeSheet(s) {
    scene.remove(s.mesh);
    s.mesh.geometry.dispose();
    s.mesh.material.dispose();
    world.removeRigidBody(s.body);
  }

  function spawnSheets(dir) {
    const y = y0 + DECK_Y + 2.4;
    for (let i = 0; i < SHEETS.length; i++) {
      const { size, color } = SHEETS[i];
      const [w, h, d] = size;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({ color, metalness: 0.65, roughness: 0.55 }),
      );
      mesh.castShadow = mesh.receiveShadow = true;
      const a = (i / SHEETS.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const px = WATER_TOWER.x + Math.cos(a) * 3.6;
      const pz = WATER_TOWER.z + Math.sin(a) * 3.6;
      const py = y + (i - 1) * 0.5;
      const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI,
      ));
      mesh.position.set(px, py, pz);
      mesh.quaternion.copy(quat);
      scene.add(mesh);
      const sheet = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(px, py, pz)
        .setRotation(quat)
        .setLinearDamping(0.08)
        .setAngularDamping(0.15)
        .setCcdEnabled(true)
        .setUserData({ mat: 'metal' }));
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2)
          .setDensity(250)
          .setFriction(0.55)
          .setRestitution(0.25),
        sheet,
      );
      const vel = new THREE.Vector3(
        Math.cos(a) * (8 + Math.random() * 3),
        7 + Math.random() * 4,
        Math.sin(a) * (8 + Math.random() * 3),
      );
      if (dir) vel.addScaledVector(dir, 3);
      sheet.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
      sheet.setAngvel({
        x: (Math.random() - 0.5) * 10,
        y: (Math.random() - 0.5) * 10,
        z: (Math.random() - 0.5) * 10,
      }, true);
      sheets.push({ mesh, body: sheet, age: 0, linger: -1 });
    }
  }

  console.info(`[watertower] @ (${WATER_TOWER.x.toFixed(1)}, ${WATER_TOWER.z.toFixed(1)}) y=${y0.toFixed(2)}`);

  return {
    root,
    navObstacles() {
      return [{ type: 'box', x: WATER_TOWER.x, z: WATER_TOWER.z, hx: FOOTPRINT, hz: FOOTPRINT, yaw: 0 }];
    },
    /** Main-gun shell hit this tower. Returns true when the collider belongs to it. */
    shellHit(hitBody, dir) {
      if (hitBody?.handle !== body.handle) return false;
      if (dead) return true;
      dead = true;
      root.visible = false;
      ruined.visible = true;
      for (const c of upper) c.setEnabled(false);
      spawnSheets(dir);
      return true;
    },
    update(dt, fx) {
      if (dead && fx) {
        smokeAt.set(WATER_TOWER.x, y0 + TANK_Y0 + 1.2, WATER_TOWER.z);
        fx.plume(smokeAt, dt);
      }
      for (let i = sheets.length - 1; i >= 0; i--) {
        const s = sheets[i];
        const t = s.body.translation();
        s.mesh.position.set(t.x, t.y, t.z);
        s.mesh.quaternion.copy(s.body.rotation());
        s.age += dt;
        if (s.linger < 0) {
          const v = s.body.linvel();
          const onGround = t.y - heightAt(t.x, t.z) < 0.55 && v.y < 1;
          const settled = s.age > 0.4 && Math.hypot(v.x, v.y, v.z) < 1.1;
          if (onGround || settled || s.age > 6) s.linger = SHEET_LINGER;
        } else if ((s.linger -= dt) <= 0) {
          removeSheet(s);
          sheets.splice(i, 1);
        }
      }
    },
    reset() {
      dead = false;
      root.visible = true;
      ruined.visible = false;
      for (const c of upper) c.setEnabled(true);
      for (const s of sheets) removeSheet(s);
      sheets.length = 0;
    },
  };
}
