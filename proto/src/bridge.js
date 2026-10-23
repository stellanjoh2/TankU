// Concrete slab bridge (GLB from scripts/build_bridge.py). Clear roadway 5.0 m ≈ 1.5 Shermans.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { BRIDGE } from './terrain.js';
import { applyConcreteMaps, prepareSlabGeometry } from './concreteTex.js';
import { applyPlankMaps } from './planksTex.js';

const SPAN = 25.0;
const DECK_W = 5.40;
const DECK_T = 0.42;
const CLEAR_W = 5.0;
const POST_W = 0.12;
const RAIL_H = 1.07;
const WING_L = 2.20;
const WING_T = 0.46;
const WING_H = 1.10;
const RAMP_LEN = 2.0;
const RAMP_DROP = 0.20;
const RAMP_T = 0.12;

/**
 * @returns {Promise<{ root: THREE.Object3D, navObstacles: () => object[] }>}
 */
export async function buildBridge(scene, { RAPIER, world }) {
  const gltf = await new GLTFLoader().loadAsync('./models/bridge.glb');
  const root = gltf.scene;
  root.name = 'Bridge';
  root.position.set(BRIDGE.x, BRIDGE.deckY, BRIDGE.z);
  root.rotation.y = BRIDGE.yaw;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    const matName = o.material?.name || o.name || '';
    if (/deck|plank/i.test(matName)) {
      applyPlankMaps(o.material);
      if (o.geometry) prepareSlabGeometry(o.geometry);
    } else if (/concrete/i.test(matName)) {
      applyConcreteMaps(o.material);
      if (o.geometry) prepareSlabGeometry(o.geometry);
    }
  });
  scene.add(root);

  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), BRIDGE.yaw);
  const rot = { x: q.x, y: q.y, z: q.z, w: q.w };

  const deckBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation(BRIDGE.x, BRIDGE.deckY, BRIDGE.z)
      .setRotation(rot),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(SPAN * 0.5, DECK_T * 0.5, DECK_W * 0.5)
      .setTranslation(0, -DECK_T * 0.5, 0)
      .setFriction(0.9),
    deckBody,
  );

  const alongX = new THREE.Vector3();
  const rampUp = new THREE.Vector3();
  const rampZ = new THREE.Vector3();
  const rampMid = new THREE.Vector3();
  const rampMat = new THREE.Matrix4();
  const rampQ = new THREE.Quaternion();
  for (const sx of [-1, 1]) {
    alongX.set(sx * RAMP_LEN, -RAMP_DROP, 0).normalize();
    rampUp.set(-sx * RAMP_DROP, RAMP_LEN, 0).normalize();
    rampZ.crossVectors(alongX, rampUp).normalize();
    rampMat.makeBasis(alongX, rampUp, rampZ);
    rampQ.setFromRotationMatrix(rampMat);
    rampMid.set(sx * (SPAN * 0.5 + RAMP_LEN * 0.5), -RAMP_DROP * 0.5, 0)
      .addScaledVector(rampUp, -RAMP_T * 0.5);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(RAMP_LEN * 0.5, RAMP_T * 0.5, DECK_W * 0.5)
        .setTranslation(rampMid.x, rampMid.y, rampMid.z)
        .setRotation({ x: rampQ.x, y: rampQ.y, z: rampQ.z, w: rampQ.w })
        .setFriction(0.9),
      deckBody,
    );
  }

  const steel = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation(BRIDGE.x, BRIDGE.deckY, BRIDGE.z)
      .setRotation(rot)
      .setUserData({ mat: 'metal' }),
  );
  const yPost = CLEAR_W * 0.5 + POST_W * 0.5;
  for (const s of [-1, 1]) {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(SPAN * 0.5 + 2.1, RAIL_H * 0.5, 0.08)
        .setTranslation(0, RAIL_H * 0.5, s * yPost)
        .setFriction(0.6),
      steel,
    );
  }

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wx = sx * (SPAN * 0.5 + WING_L * 0.5 - 0.45);
      const wz = sz * (DECK_W * 0.5 + WING_T * 0.5 + 0.04);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(WING_L * 0.5, (WING_H + 0.12) * 0.5, WING_T * 0.5)
          .setTranslation(wx, WING_H * 0.5, wz)
          .setFriction(0.85),
        deckBody,
      );
    }
  }

  console.info(`[bridge] @ (${BRIDGE.x.toFixed(1)}, ${BRIDGE.z.toFixed(1)}) y=${BRIDGE.deckY.toFixed(2)}`);

  return {
    root,
    navObstacles() {
      return [];
    },
  };
}
