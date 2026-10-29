// WWII hangar + concrete apron near spawn (refuel / "airport" pad).
// Door clear opening is sized so a Sherman (~3.3 m wide × ~2.8 m tall) just fits.
// Walls are pre-fractured into ~130 shell-hittable panels (roof / door / shed stay solid).
import * as THREE from 'three';
import { AIRFIELD, AIRFIELD_Y, heightAt } from './terrain.js';
import { applyConcreteMaps, prepareSlabGeometry } from './concreteTex.js';
import { roofCorrugatedMaterial, stampCorrugatedUVs, wallCorrugatedMaterial } from './corrugatedTex.js';

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

// Finer grid (~1.3–2 m panels). One shell clears a small blast cluster so holes aren't perfect squares.
const SIDE_COLS = 10;
const SIDE_ROWS = 4;
const BACK_COLS = 8;
const BACK_ROWS = 4;
const FRONT_COLS = 2;
const FRONT_ROWS = 4;
const LINTEL_COLS = 2;
const SHELL_BLAST = 1.85;   // m: panels whose centres fall inside also go
const DEBRIS_PER_HIT = 3;
const DEBRIS_MAX = 40;
const DEBRIS_LINGER = 1.2;
const SCRAP = [
  { size: [0.55, 0.04, 0.4], color: 0xb8c0c4 },
  { size: [0.4, 0.035, 0.5], color: 0x8a9094 },
  { size: [0.3, 0.03, 0.3], color: 0x6b3a22 },
];

/** Hangar group origin (building centre): door on the west face, apron toward spawn. */
export const HANGAR = {
  // Keep the full footprint on the pad; door opens west toward spawn (−8, −5).
  x: AIRFIELD.cx + AIRFIELD.hw - BUILD_D * 0.5 - 0.5,
  z: AIRFIELD.cz,
  yaw: 0, // local +X = into hangar (east); doors face −X toward spawn
};

/** Free spot on the apron by the hangar's south-west corner (a drum stands here, see barrels.js). */
export const HANGAR_PROP_SPOT = { x: HANGAR.x - 6, z: HANGAR.z + BUILD_W * 0.5 + 1.2 };

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

/** Real-size box (no mesh scale) so corrugated UVs stay in metres. */
function steelBox(material, x, y, z, sx, sy, sz) {
  const mesh = new THREE.Mesh(stampCorrugatedUVs(new THREE.BoxGeometry(sx, sy, sz), x, y, z), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

/**
 * @returns {{ root: THREE.Group, navObstacles: () => object[],
 *   shellHit: (body: object, dir?: THREE.Vector3, point?: THREE.Vector3, collider?: object) => boolean,
 *   update: (dt: number) => void, reset: () => void }}
 */
export function buildAirfield(RAPIER, world, scene) {
  const root = new THREE.Group();
  root.name = 'Airfield';
  scene.add(root);

  const y0 = AIRFIELD_Y;
  const wallMat = wallCorrugatedMaterial();
  const roofMat = roofCorrugatedMaterial();
  const metalDark = mat(0x6a7074, { metal: 0.65, rough: 0.5 });
  const frame = mat(0x2a3328, { metal: 0.2, rough: 0.7 });
  const glass = mat(0x1a2218, { metal: 0.1, rough: 0.15 });
  glass.transparent = true;
  glass.opacity = 0.45;
  const rust = mat(0x6b3a22, { metal: 0.3, rough: 0.85 });
  const concrete = mat(0xffffff);
  applyConcreteMaps(concrete);
  const concreteDark = mat(0xe2ddd4);
  applyConcreteMaps(concreteDark);
  const interior = mat(0x2a2c2e, { rough: 0.95 });

  const unit = prepareSlabGeometry(new THREE.BoxGeometry(1, 1, 1));
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
      .setRotation(q)
      // Metal warehouse — MG hits play ricochet clank (see match.js / metal-hit-sfx rule).
      .setUserData({ mat: 'metal' }),
  );

  const hw = BUILD_W * 0.5;
  const hd = BUILD_D * 0.5;
  // Local: door face at x = −hd, back at +hd, sides ±hw.

  /** @type {{ mesh: THREE.Mesh, collider: object, dead: boolean, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number }[]} */
  const pieces = [];
  const byCollider = new Map();
  /** @type {{ mesh: THREE.Mesh, body: object, age: number, linger: number }[]} */
  const debris = [];

  function addPiece(lx, ly, lz, sx, sy, sz) {
    const mesh = steelBox(wallMat, lx, ly, lz, sx, sy, sz);
    hangar.add(mesh);
    const col = world.createCollider(
      RAPIER.ColliderDesc.cuboid(sx * 0.5, sy * 0.5, sz * 0.5)
        .setTranslation(lx, ly, lz)
        .setFriction(0.85),
      body,
    );
    const piece = { mesh, collider: col, dead: false, lx, ly, lz, sx, sy, sz, extras: [] };
    pieces.push(piece);
    byCollider.set(col.handle, piece);
    return piece;
  }

  function removeDebris(d) {
    scene.remove(d.mesh);
    d.mesh.geometry.dispose();
    d.mesh.material.dispose();
    world.removeRigidBody(d.body);
  }

  function spawnDebris(piece, dir) {
    while (debris.length >= DEBRIS_MAX) {
      removeDebris(debris.shift());
    }
    const wx = HANGAR.x + piece.lx;
    const wy = y0 + piece.ly;
    const wz = HANGAR.z + piece.lz;
    const n = Math.min(DEBRIS_PER_HIT, SCRAP.length);
    for (let i = 0; i < n; i++) {
      const { size, color } = SCRAP[i];
      const [w, h, d] = size;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.55 }),
      );
      mesh.castShadow = true;
      const ox = (Math.random() - 0.5) * piece.sx * 0.4;
      const oy = (Math.random() - 0.5) * piece.sy * 0.35;
      const oz = (Math.random() - 0.5) * piece.sz * 0.4;
      const px = wx + ox;
      const py = wy + oy;
      const pz = wz + oz;
      const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI,
      ));
      mesh.position.set(px, py, pz);
      mesh.quaternion.copy(quat);
      scene.add(mesh);
      const rb = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(px, py, pz)
          .setRotation(quat)
          .setLinearDamping(0.12)
          .setAngularDamping(0.2)
          .setCcdEnabled(true)
          .setUserData({ mat: 'metal' }),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2)
          .setDensity(180)
          .setFriction(0.55)
          .setRestitution(0.2),
        rb,
      );
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 4,
        4 + Math.random() * 4,
        (Math.random() - 0.5) * 4,
      );
      if (dir) vel.addScaledVector(dir, 6 + Math.random() * 3);
      rb.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
      rb.setAngvel({
        x: (Math.random() - 0.5) * 14,
        y: (Math.random() - 0.5) * 14,
        z: (Math.random() - 0.5) * 14,
      }, true);
      debris.push({ mesh, body: rb, age: 0, linger: -1 });
    }
  }

  function destroyPiece(piece, dir, withDebris) {
    if (piece.dead) return;
    piece.dead = true;
    piece.mesh.visible = false;
    for (const m of piece.extras) m.visible = false;
    piece.collider.setEnabled(false);
    if (withDebris) spawnDebris(piece, dir);
  }

  /** Knock out the hit panel plus neighbours in a small blast so the hole isn't one clean rectangle. */
  function destroyAt(hitPiece, dir, point) {
    let cx = hitPiece.lx;
    let cy = hitPiece.ly;
    let cz = hitPiece.lz;
    if (point) {
      cx = point.x - HANGAR.x;
      cy = point.y - y0;
      cz = point.z - HANGAR.z;
    }
    let primary = null;
    let primaryD = Infinity;
    const hit = [];
    for (const p of pieces) {
      if (p.dead) continue;
      const d = Math.hypot(p.lx - cx, p.ly - cy, p.lz - cz);
      if (d > SHELL_BLAST) continue;
      hit.push(p);
      if (d < primaryD) {
        primaryD = d;
        primary = p;
      }
    }
    for (const p of hit) destroyPiece(p, dir, p === primary);
  }

  // --- Floor (interior) ---
  hangar.add(boxMesh(unit, interior, 0, 0.04, 0, BUILD_D - 0.4, 0.08, BUILD_W - 0.4));

  // --- Side walls (pre-fractured grid) ---
  const colW = BUILD_D / SIDE_COLS;
  const rowH = EAVE_H / SIDE_ROWS;
  for (const sz of [-1, 1]) {
    const z = sz * (hw - WALL_T * 0.5);
    for (let c = 0; c < SIDE_COLS; c++) {
      for (let r = 0; r < SIDE_ROWS; r++) {
        const lx = -hd + colW * (c + 0.5);
        const ly = rowH * (r + 0.5);
        addPiece(lx, ly, z, colW, rowH, WALL_T);
      }
    }
  }

  // --- Back wall ---
  const backColW = BUILD_W / BACK_COLS;
  const backRowH = EAVE_H / BACK_ROWS;
  for (let c = 0; c < BACK_COLS; c++) {
    for (let r = 0; r < BACK_ROWS; r++) {
      const lz = -hw + backColW * (c + 0.5);
      const ly = backRowH * (r + 0.5);
      addPiece(hd - WALL_T * 0.5, ly, lz, WALL_T, backRowH, backColW);
    }
  }

  // --- Front wall (door opening centred) ---
  const doorHalf = DOOR_W * 0.5;
  const sidePanelW = (BUILD_W - DOOR_W) * 0.5;
  const frontX = -hd + WALL_T * 0.5;
  const frontColW = sidePanelW / FRONT_COLS;
  const frontRowH = EAVE_H / FRONT_ROWS;
  for (const sz of [-1, 1]) {
    const z0 = sz * (doorHalf + sidePanelW * 0.5) - sidePanelW * 0.5;
    for (let c = 0; c < FRONT_COLS; c++) {
      for (let r = 0; r < FRONT_ROWS; r++) {
        addPiece(
          frontX, frontRowH * (r + 0.5), z0 + frontColW * (c + 0.5),
          WALL_T, frontRowH, frontColW,
        );
      }
    }
  }
  // Lintel above door
  const lintelH = EAVE_H - DOOR_H;
  const lintelY = DOOR_H + lintelH * 0.5;
  const lintelColW = DOOR_W / LINTEL_COLS;
  for (let c = 0; c < LINTEL_COLS; c++) {
    addPiece(frontX, lintelY, -doorHalf + lintelColW * (c + 0.5), WALL_T, lintelH, lintelColW);
  }

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
    const roof = steelBox(roofMat, 0, EAVE_H + rise * 0.5, sz * (roofRun * 0.5), roofLen, 0.12, roofHyp);
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
    // Back gable (rot +Y) maps local X to −Z; flip so ribs continue the wall.
    const gable = new THREE.Mesh(
      stampCorrugatedUVs(gableGeo, 0, EAVE_H, 0, sx > 0 ? -1 : 1, 1, 1),
      wallMat,
    );
    // Extrude is +Z; rotate so thickness runs along X, flush with front/back walls.
    gable.position.set(sx > 0 ? hd - WALL_T : -hd + WALL_T, EAVE_H, 0);
    gable.rotation.y = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    gable.castShadow = gable.receiveShadow = true;
    hangar.add(gable);
  }

  // --- Side window strip (tied to upper wall panels so they vanish with the hole) ---
  const winY = EAVE_H * 0.72;
  for (const sz of [-1, 1]) {
    const zWall = sz * (hw - WALL_T * 0.5);
    for (let i = 0; i < 8; i++) {
      const x = -hd + 1.8 + i * 2.1;
      const fr = boxMesh(unit, frame, x, winY, sz * (hw - 0.02), 1.6, 1.35, 0.08);
      const gl = boxMesh(unit, glass, x, winY, sz * (hw - 0.02) + sz * 0.04, 1.4, 1.15, 0.04);
      hangar.add(fr, gl);
      const host = pieces.find((p) => (
        Math.abs(p.lz - zWall) < 0.01
        && Math.abs(x - p.lx) <= p.sx * 0.5 + 0.05
        && Math.abs(winY - p.ly) <= p.sy * 0.5 + 0.05
      ));
      if (host) host.extras.push(fr, gl);
    }
  }

  // --- Lean-to shed on +Z side ---
  const shed = new THREE.Group();
  shed.position.set(hd * 0.15, 0, hw + 2.2);
  hangar.add(shed);
  shed.add(steelBox(wallMat, 0, 1.4, 0, 6.5, 2.8, 4.0));
  shed.add(steelBox(roofMat, 0, 2.85, 0, 6.8, 0.12, 4.3));
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

  // One box over the slab field. Top is the concrete surface, so the tracks
  // sit on the slabs instead of the terrain buried 6 cm under them.
  const slabBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  addCollider(
    RAPIER, world, slabBody,
    (x1 - x0) * 0.5, 0.2, (z1 - z0) * 0.5,
    (x0 + x1) * 0.5, y0 + SLAB_T - 0.2, (z0 + z1) * 0.5,
  );

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
      `hangar door ${DOOR_W}×${DOOR_H} m (Sherman ~3.3×2.8); ` +
      `${pieces.length} wall panels; terrain h@door=${heightAt(HANGAR.x - hd, HANGAR.z).toFixed(2)}`,
  );

  return {
    root,
    navObstacles,
    /** Main-gun shell: punch out the hit wall panel. Returns true if this hangar body was hit. */
    shellHit(hitBody, dir, point, collider) {
      if (hitBody?.handle !== body.handle) return false;
      const piece = collider ? byCollider.get(collider.handle) : null;
      if (piece) destroyAt(piece, dir, point);
      return true;
    },
    update(dt) {
      for (let i = debris.length - 1; i >= 0; i--) {
        const d = debris[i];
        const t = d.body.translation();
        d.mesh.position.set(t.x, t.y, t.z);
        d.mesh.quaternion.copy(d.body.rotation());
        d.age += dt;
        if (d.linger < 0) {
          const v = d.body.linvel();
          const onGround = t.y - heightAt(t.x, t.z) < 0.45 && v.y < 1;
          const settled = d.age > 0.35 && Math.hypot(v.x, v.y, v.z) < 1.2;
          if (onGround || settled || d.age > 5) d.linger = DEBRIS_LINGER;
        } else if ((d.linger -= dt) <= 0) {
          removeDebris(d);
          debris.splice(i, 1);
        }
      }
    },
    reset() {
      for (const p of pieces) {
        p.dead = false;
        p.mesh.visible = true;
        for (const m of p.extras) m.visible = true;
        p.collider.setEnabled(true);
      }
      for (const d of debris) removeDebris(d);
      debris.length = 0;
    },
  };
}
