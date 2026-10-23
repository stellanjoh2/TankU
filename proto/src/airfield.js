// WWII hangar + concrete apron near spawn (refuel / "airport" pad).
// Door clear opening is sized so a Sherman (~3.3 m wide × ~2.8 m tall) just fits.
import * as THREE from 'three';
import { AIRFIELD, AIRFIELD_Y, heightAt } from './terrain.js';

// Sherman hull ≈ 3.24 m track-outer width, turret roof ≈ 2.81 m — leave a few cm.
export const DOOR_W = 4.0;
export const DOOR_H = 3.55;

const WALL_T = 0.18;
const EAVE_H = 5.1;
const RIDGE_H = 7.0;
const BUILD_W = 13.0;   // exterior width (Z in hangar-local)
const BUILD_D = 20.0;   // exterior depth (X in hangar-local, door on −X)
const SLAB = 4.0;
const SLAB_GAP = 0.08;
const SLAB_T = 0.06;

/** Hangar group origin (building centre): door on the west face, apron toward spawn. */
export const HANGAR = {
  // Keep the full footprint on the pad; door opens west toward spawn (−8, −5).
  x: AIRFIELD.cx + AIRFIELD.hw - BUILD_D * 0.5 - 0.5,
  z: AIRFIELD.cz,
  yaw: 0, // local +X = into hangar (east); doors face −X toward spawn
};

function mat(color, { metal = 0, rough = 0.85, flat = false } = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: metal,
    roughness: rough,
    flatShading: flat,
  });
}

function boxMesh(geo, material, x, y, z, sx, sy, sz) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function addCollider(RAPIER, world, body, hx, hy, hz, x, y, z) {
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(x, y, z)
      .setFriction(0.85),
    body,
  );
}

/** Corrugated-looking metal: procedural stripes via canvas map. */
function corrugatedMap() {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  g.fillStyle = '#c4ccd0';
  g.fillRect(0, 0, n, n);
  for (let x = 0; x < n; x += 4) {
    g.fillStyle = x % 8 === 0 ? 'rgba(90,70,55,0.18)' : 'rgba(255,255,255,0.1)';
    g.fillRect(x, 0, 2, n);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * @returns {{ root: THREE.Group, navObstacles: () => object[] }}
 */
export function buildAirfield(RAPIER, world, scene) {
  const root = new THREE.Group();
  root.name = 'Airfield';
  scene.add(root);

  const y0 = AIRFIELD_Y;
  const metalMap = corrugatedMap();
  metalMap.repeat.set(6, 3);
  const metal = mat(0xb8c0c4, { metal: 0.55, rough: 0.55 });
  metal.map = metalMap;
  const metalDark = mat(0x6a7074, { metal: 0.65, rough: 0.5 });
  const frame = mat(0x2a3328, { metal: 0.2, rough: 0.7 });
  const glass = mat(0x1a2218, { metal: 0.1, rough: 0.15 });
  glass.transparent = true;
  glass.opacity = 0.45;
  const rust = mat(0x6b3a22, { metal: 0.3, rough: 0.85 });
  const concrete = mat(0xc8c0a8, { rough: 0.95 });
  const concreteDark = mat(0xb0a890, { rough: 0.97 });
  const interior = mat(0x2a2c2e, { rough: 0.95 });

  const unit = new THREE.BoxGeometry(1, 1, 1);
  const hangar = new THREE.Group();
  hangar.name = 'Hangar';
  hangar.position.set(HANGAR.x, y0, HANGAR.z);
  hangar.rotation.y = HANGAR.yaw;
  root.add(hangar);

  // Physics body at hangar origin (world), colliders in hangar-local via body rotation.
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), HANGAR.yaw);
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation(HANGAR.x, y0, HANGAR.z)
      .setRotation(q),
  );

  const hw = BUILD_W * 0.5;
  const hd = BUILD_D * 0.5;
  // Local: door face at x = −hd, back at +hd, sides ±hw.

  // --- Floor (interior) ---
  hangar.add(boxMesh(unit, interior, 0, 0.04, 0, BUILD_D - 0.4, 0.08, BUILD_W - 0.4));

  // --- Side walls ---
  const sideY = EAVE_H * 0.5;
  for (const sz of [-1, 1]) {
    const wall = boxMesh(unit, metal, 0, sideY, sz * (hw - WALL_T * 0.5), BUILD_D, EAVE_H, WALL_T);
    hangar.add(wall);
    addCollider(RAPIER, world, body, BUILD_D * 0.5, EAVE_H * 0.5, WALL_T * 0.5, 0, sideY, sz * (hw - WALL_T * 0.5));
  }

  // --- Back wall ---
  hangar.add(boxMesh(unit, metal, hd - WALL_T * 0.5, sideY, 0, WALL_T, EAVE_H, BUILD_W));
  addCollider(RAPIER, world, body, WALL_T * 0.5, EAVE_H * 0.5, hw, hd - WALL_T * 0.5, sideY, 0);

  // --- Front wall (door opening centred) ---
  const doorHalf = DOOR_W * 0.5;
  const sidePanelW = (BUILD_W - DOOR_W) * 0.5;
  const frontX = -hd + WALL_T * 0.5;
  for (const sz of [-1, 1]) {
    const cz = sz * (doorHalf + sidePanelW * 0.5);
    hangar.add(boxMesh(unit, metal, frontX, sideY, cz, WALL_T, EAVE_H, sidePanelW));
    addCollider(RAPIER, world, body, WALL_T * 0.5, EAVE_H * 0.5, sidePanelW * 0.5, frontX, sideY, cz);
  }
  // Lintel above door
  const lintelH = EAVE_H - DOOR_H;
  const lintelY = DOOR_H + lintelH * 0.5;
  hangar.add(boxMesh(unit, metal, frontX, lintelY, 0, WALL_T, lintelH, DOOR_W));
  addCollider(RAPIER, world, body, WALL_T * 0.5, lintelH * 0.5, doorHalf, frontX, lintelY, 0);

  // --- Sliding door (parked open to +Z, leaving the clear opening free) ---
  const doorPanel = new THREE.Group();
  doorPanel.position.set(frontX - 0.12, DOOR_H * 0.5, doorHalf + DOOR_W * 0.55);
  hangar.add(doorPanel);
  doorPanel.add(boxMesh(unit, metalDark, 0, 0, 0, WALL_T * 0.7, DOOR_H, DOOR_W));
  // X-brace
  const brace = boxMesh(unit, rust, 0, -DOOR_H * 0.15, 0, 0.06, DOOR_H * 0.45, 0.12);
  brace.rotation.x = 0.55;
  doorPanel.add(brace);
  const brace2 = brace.clone();
  brace2.rotation.x = -0.55;
  doorPanel.add(brace2);
  // Door windows
  for (let i = 0; i < 3; i++) {
    const wy = DOOR_H * 0.22;
    const wz = (i - 1) * (DOOR_W * 0.28);
    doorPanel.add(boxMesh(unit, frame, 0.06, wy, wz, 0.04, DOOR_H * 0.28, DOOR_W * 0.2));
    doorPanel.add(boxMesh(unit, glass, 0.08, wy, wz, 0.02, DOOR_H * 0.24, DOOR_W * 0.16));
  }
  addCollider(
    RAPIER, world, body,
    WALL_T * 0.35, DOOR_H * 0.5, doorHalf,
    frontX - 0.12, DOOR_H * 0.5, doorHalf + DOOR_W * 0.55,
  );

  // --- Gabled roof (two slabs) ---
  const roofLen = BUILD_D + 0.4;
  const roofRun = hw + 0.25;
  const rise = RIDGE_H - EAVE_H;
  const roofAngle = Math.atan2(rise, roofRun);
  const roofHyp = Math.hypot(roofRun, rise);
  for (const sz of [-1, 1]) {
    const roof = boxMesh(unit, metal, 0, EAVE_H + rise * 0.5, sz * (roofRun * 0.5), roofLen, 0.12, roofHyp);
    roof.rotation.x = sz * roofAngle;
    hangar.add(roof);
  }
  // Ridge beam
  hangar.add(boxMesh(unit, metalDark, 0, RIDGE_H - 0.05, 0, roofLen, 0.16, 0.2));

  // --- Gable ends (close the triangle under the ridge on front & back) ---
  const gableShape = new THREE.Shape();
  gableShape.moveTo(-hw, 0);
  gableShape.lineTo(hw, 0);
  gableShape.lineTo(0, rise);
  gableShape.closePath();
  const gableGeo = new THREE.ExtrudeGeometry(gableShape, { depth: WALL_T, bevelEnabled: false });
  for (const sx of [-1, 1]) {
    const gable = new THREE.Mesh(gableGeo, metal);
    // Extrude is +Z; rotate so thickness runs along X, flush with front/back walls.
    gable.position.set(sx > 0 ? hd - WALL_T : -hd + WALL_T, EAVE_H, 0);
    gable.rotation.y = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    gable.castShadow = gable.receiveShadow = true;
    hangar.add(gable);
  }

  // --- Side window strip (high industrial panes) ---
  const winY = EAVE_H * 0.72;
  for (const sz of [-1, 1]) {
    const z = sz * (hw - 0.02);
    for (let i = 0; i < 8; i++) {
      const x = -hd + 1.8 + i * 2.1;
      hangar.add(boxMesh(unit, frame, x, winY, z, 1.6, 1.35, 0.08));
      hangar.add(boxMesh(unit, glass, x, winY, z + sz * 0.04, 1.4, 1.15, 0.04));
    }
  }

  // --- Lean-to shed on +Z side ---
  const shed = new THREE.Group();
  shed.position.set(hd * 0.15, 0, hw + 2.2);
  hangar.add(shed);
  shed.add(boxMesh(unit, metal, 0, 1.4, 0, 6.5, 2.8, 4.0));
  shed.add(boxMesh(unit, metalDark, 0, 2.85, 0, 6.8, 0.12, 4.3));
  addCollider(RAPIER, world, body, 3.25, 1.4, 2.0, hd * 0.15, 1.4, hw + 2.2);

  // --- Gooseneck lamp over door ---
  const lamp = new THREE.Group();
  lamp.position.set(frontX - 0.8, EAVE_H + 0.2, 0);
  hangar.add(lamp);
  lamp.add(boxMesh(unit, metalDark, 0.5, 0.8, 0, 0.08, 1.6, 0.08));
  const arm = boxMesh(unit, metalDark, -0.35, 1.5, 0, 1.4, 0.07, 0.07);
  lamp.add(arm);
  const shade = boxMesh(unit, rust, -1.0, 1.25, 0, 0.45, 0.25, 0.45);
  lamp.add(shade);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), mat(0xffe6a0, { rough: 0.4 }));
  bulb.position.set(-1.0, 1.1, 0);
  lamp.add(bulb);
  const lampLight = new THREE.PointLight(0xffd9a0, 12, 18, 2);
  lampLight.position.copy(bulb.position);
  lamp.add(lampLight);

  // --- Small "20" speed disc on front ---
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(0.28, 20),
    mat(0xe8c020, { rough: 0.6 }),
  );
  disc.position.set(frontX - 0.1, 4.2, hw * 0.55);
  disc.rotation.y = Math.PI / 2;
  hangar.add(disc);

  // --- Concrete slabs on the apron (and under hangar footprint) ---
  const slabs = new THREE.Group();
  slabs.name = 'ConcreteSlabs';
  root.add(slabs);

  const x0 = AIRFIELD.cx - AIRFIELD.hw + 0.5;
  const x1 = AIRFIELD.cx + AIRFIELD.hw - 0.5;
  const z0 = AIRFIELD.cz - AIRFIELD.hd + 0.5;
  const z1 = AIRFIELD.cz + AIRFIELD.hd - 0.5;
  const step = SLAB + SLAB_GAP;
  let si = 0;
  for (let x = x0; x < x1 - SLAB * 0.5; x += step) {
    for (let z = z0; z < z1 - SLAB * 0.5; z += step) {
      const w = Math.min(SLAB, x1 - x);
      const d = Math.min(SLAB, z1 - z);
      const m = boxMesh(unit, (si++ & 1) ? concrete : concreteDark, x + w * 0.5, y0 + SLAB_T * 0.5, z + d * 0.5, w, SLAB_T, d);
      // Slight height jitter so joints read
      m.position.y += ((si * 17) % 5) * 0.004;
      slabs.add(m);
    }
  }

  // Green barrel near corner (scale prop like the reference)
  const barrelMat = mat(0x3a5a32, { metal: 0.4, rough: 0.55 });
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.9, 14), barrelMat);
  barrel.position.set(HANGAR.x - 6, y0 + SLAB_T + 0.45, HANGAR.z + hw + 1.2);
  barrel.castShadow = barrel.receiveShadow = true;
  root.add(barrel);

  /** Wall / shed footprints for AI — door mouth left open. */
  function navObstacles() {
    const hx = HANGAR.x;
    const hz = HANGAR.z;
    const yaw = HANGAR.yaw;
    const sidePanel = (BUILD_W - DOOR_W) * 0.5;
    return [
      { type: 'box', x: hx, z: hz - (hw - WALL_T * 0.5), hx: hd, hz: WALL_T * 0.5 + 0.2, yaw },
      { type: 'box', x: hx, z: hz + (hw - WALL_T * 0.5), hx: hd, hz: WALL_T * 0.5 + 0.2, yaw },
      { type: 'box', x: hx + (hd - WALL_T * 0.5), z: hz, hx: WALL_T * 0.5 + 0.2, hz: hw, yaw },
      { type: 'box', x: hx - (hd - WALL_T * 0.5), z: hz - (doorHalf + sidePanel * 0.5), hx: WALL_T * 0.5 + 0.2, hz: sidePanel * 0.5, yaw },
      { type: 'box', x: hx - (hd - WALL_T * 0.5), z: hz + (doorHalf + sidePanel * 0.5), hx: WALL_T * 0.5 + 0.2, hz: sidePanel * 0.5, yaw },
      { type: 'box', x: hx - hd - 0.12, z: hz + doorHalf + DOOR_W * 0.55, hx: 0.25, hz: doorHalf, yaw },
      { type: 'box', x: hx + hd * 0.15, z: hz + hw + 2.2, hx: 3.3, hz: 2.1, yaw },
    ];
  }

  // Sanity: door vs Sherman
  console.info(
    `[airfield] pad @ (${AIRFIELD.cx}, ${AIRFIELD.cz}) y=${y0.toFixed(2)}; ` +
      `hangar door ${DOOR_W}×${DOOR_H} m (Sherman ~3.3×2.8); terrain h@door=${heightAt(HANGAR.x - hd, HANGAR.z).toFixed(2)}`,
  );

  return { root, navObstacles };
}
