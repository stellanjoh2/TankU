// Small quay east of the hangar apron: concrete working deck + wooden walkway edge,
// plus a slab yard south of the deck for the water tower.
import * as THREE from 'three';
import { AIRFIELD_Y, PORT, PORT_YARD, WATER_Y } from './terrain.js';
import { concreteSlabMap } from './concreteTex.js';

const SLAB = 4.0;
const SLAB_GAP = 0.08;
const SLAB_T = 0.06;
const WALK_W = 2.4;
const PLANK_T = 0.12;
const PILE_SPACING = 3.2;

function mat(color, { metal = 0, rough = 0.85 } = {}) {
  return new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough });
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

/**
 * @returns {{ root: THREE.Group, navObstacles: () => object[] }}
 */
export function buildPort(RAPIER, world, scene) {
  const root = new THREE.Group();
  root.name = 'Port';
  scene.add(root);

  const y0 = AIRFIELD_Y;
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const concrete = mat(0xffffff, { rough: 0.95 });
  concrete.map = concreteSlabMap();
  const concreteDark = mat(0xe2ddd4, { rough: 0.97 });
  concreteDark.map = concrete.map;
  const wood = mat(0x6b4a2e, { rough: 0.92 });
  const woodDark = mat(0x4a3220, { rough: 0.95 });
  const woodWet = mat(0x3d2a1a, { rough: 0.88 });
  const iron = mat(0x3a3a38, { metal: 0.7, rough: 0.45 });

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0),
  );

  // --- Concrete slabs: apron → quay (handmade port ground) ---
  const slabs = new THREE.Group();
  slabs.name = 'PortSlabs';
  root.add(slabs);

  const x0 = PORT.x0 + 0.4;
  const x1 = PORT.x1 - WALK_W - 0.15;
  const z0 = PORT.z0 + 0.6;
  const z1 = PORT.z1 - 0.6;
  const step = SLAB + SLAB_GAP;
  let si = 0;
  /** [start, size] runs from a toward b (descending when b < a), skipping slivers. */
  const runs = (a, b) => {
    const out = [];
    const dir = Math.sign(b - a);
    for (let s = a; (b - s) * dir > SLAB * 0.25; s += step * dir) {
      const len = Math.min(SLAB, Math.abs(b - s));
      if (len >= 0.8) out.push(dir > 0 ? [s, len] : [s - len, len]);
    }
    return out;
  };
  const laySlabs = (xs, zs) => {
    for (const [x, w] of xs) {
      for (const [z, d] of zs) {
        const m = boxMesh(
          unit,
          (si++ & 1) ? concrete : concreteDark,
          x + w * 0.5,
          y0 + SLAB_T * 0.5,
          z + d * 0.5,
          w,
          SLAB_T,
          d,
        );
        m.position.y += ((si * 17) % 5) * 0.004;
        slabs.add(m);
      }
    }
  };
  const deckXs = runs(x0, x1);
  laySlabs(deckXs, runs(z0, z1));

  // Yard south of the deck: continues the deck's slab columns, stepping south.
  const yardXs = deckXs.filter(([x]) => x >= PORT_YARD.x0);
  const yx0 = yardXs[0][0];
  const yz1 = z0 - SLAB_GAP;
  const yz0 = PORT_YARD.z0 + 0.6;
  laySlabs(yardXs, runs(yz1, yz0));

  // Deck collider under the working pad (single slab for tanks to drive on)
  const padW = x1 - x0;
  const padD = z1 - z0;
  addCollider(
    RAPIER, world, body,
    padW * 0.5, 0.2, padD * 0.5,
    (x0 + x1) * 0.5, y0 - 0.15, (z0 + z1) * 0.5,
  );
  addCollider(
    RAPIER, world, body,
    (x1 - yx0) * 0.5, 0.2, (yz1 - yz0) * 0.5,
    (yx0 + x1) * 0.5, y0 - 0.15, (yz0 + yz1) * 0.5,
  );

  // --- Wooden walkway along the quay edge ---
  const walk = new THREE.Group();
  walk.name = 'WoodenWalkway';
  root.add(walk);

  const walkX = PORT.x1 - WALK_W * 0.5;
  const walkLen = z1 - z0;
  const walkZ = (z0 + z1) * 0.5;

  // Plank deck (long boards parallel to shore)
  const plankCount = Math.max(4, Math.floor(WALK_W / 0.38));
  for (let i = 0; i < plankCount; i++) {
    const px = walkX - WALK_W * 0.5 + 0.2 + i * (WALK_W / plankCount);
    const plank = boxMesh(
      unit,
      (i & 1) ? wood : woodDark,
      px,
      y0 + PLANK_T * 0.5 + 0.01,
      walkZ,
      0.32,
      PLANK_T,
      walkLen,
    );
    walk.add(plank);
  }

  // Cross-beams under the walkway
  for (let z = z0 + 1.2; z < z1 - 0.5; z += PILE_SPACING) {
    walk.add(boxMesh(unit, woodDark, walkX, y0 - 0.08, z, WALK_W + 0.15, 0.18, 0.28));
  }

  // Outer header / fender beam along the water face
  const faceX = PORT.x1 + 0.12;
  const faceH = y0 - WATER_Y;
  walk.add(boxMesh(unit, woodWet, faceX, y0 - 0.05, walkZ, 0.35, 0.4, walkLen + 0.4));
  // Second fender lower, half in the splash zone
  walk.add(boxMesh(unit, woodWet, faceX + 0.05, WATER_Y + faceH * 0.35, walkZ, 0.28, 0.32, walkLen + 0.2));

  // Pilings into the water
  const pileTop = y0 + 0.35;
  const pileBot = WATER_Y - 1.6;
  const pileH = pileTop - pileBot;
  for (let z = z0 + 0.8; z <= z1 - 0.6; z += PILE_SPACING) {
    const pile = boxMesh(
      unit,
      woodWet,
      PORT.x1 + 0.55,
      pileBot + pileH * 0.5,
      z,
      0.38,
      pileH,
      0.38,
    );
    walk.add(pile);
    // Cap
    walk.add(boxMesh(unit, woodDark, PORT.x1 + 0.55, pileTop + 0.08, z, 0.48, 0.16, 0.48));
  }

  // Walkway collider
  addCollider(
    RAPIER, world, body,
    WALK_W * 0.5, 0.2, walkLen * 0.5,
    walkX, y0 - 0.1, walkZ,
  );

  // Bollards along the edge
  for (let z = z0 + 2; z < z1 - 1; z += PILE_SPACING * 1.5) {
    const bx = PORT.x1 - 0.55;
    walk.add(boxMesh(unit, iron, bx, y0 + 0.35, z, 0.22, 0.7, 0.22));
    walk.add(boxMesh(unit, iron, bx, y0 + 0.72, z, 0.34, 0.12, 0.34));
  }

  // Short concrete retaining lips where the pads meet leftover beach / grass
  // (the deck's south edge stays open where it runs into the yard).
  const lips = [
    [x0, PORT.x1, z1 + 0.15, true],
    [x0, yx0, z0 - 0.15, true],
    [x1, PORT.x1, z0 - 0.15, true],
    [yx0, x1 + 0.35, yz0 - 0.15, true],
    [yz0 - 0.3, z0, x1 + 0.17, false],
  ];
  for (const [a, b, at, alongX] of lips) {
    const len = b - a;
    const mid = (a + b) * 0.5;
    root.add(boxMesh(
      unit,
      concreteDark,
      alongX ? mid : at,
      y0 + 0.18,
      alongX ? at : mid,
      alongX ? len : 0.35,
      0.45,
      alongX ? 0.35 : len,
    ));
  }

  console.info(
    `[port] deck x=${PORT.x0}→${PORT.x1} z=${PORT.z0}→${PORT.z1}; ` +
      `walkway @ x=${walkX.toFixed(1)} y=${y0.toFixed(2)}`,
  );

  return {
    root,
    navObstacles() {
      // Open deck — no nav blockers; bollards are small enough to ignore.
      return [];
    },
  };
}
