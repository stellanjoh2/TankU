// Small quay east of the hangar apron: concrete working deck + wooden walkway edge,
// plus a slab yard south of the deck for the water tower.
import * as THREE from 'three';
import { AIRFIELD_Y, PORT, PORT_YARD, WATER_Y } from './terrain.js';
import { addInstancedBoxes, applyConcreteMaps, prepareSlabGeometry } from './concreteTex.js';

const SLAB = 4.0;
const SLAB_GAP = 0.08;
const SLAB_T = 0.06;
const WALK_W = 2.4;
const PLANK_T = 0.12;
const PILE_SPACING = 3.2;

function mat(color, { metal = 0, rough = 0.85 } = {}) {
  return new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough });
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
  const unit = prepareSlabGeometry(new THREE.BoxGeometry(1, 1, 1));
  const concrete = mat(0xffffff);
  applyConcreteMaps(concrete);
  const concreteDark = mat(0xe2ddd4);
  applyConcreteMaps(concreteDark);
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
  const slabItems = [];
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
        const mat = si++ & 1;
        slabItems.push({
          mat,
          x: x + w * 0.5,
          y: y0 + SLAB_T * 0.5 + ((si * 17) % 5) * 0.004,
          z: z + d * 0.5,
          sx: w,
          sy: SLAB_T,
          sz: d,
        });
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
  // mat index = si&1: 0 → dark, 1 → light (matches prior ternary)
  addInstancedBoxes(slabs, unit, [concreteDark, concrete], slabItems, { name: 'PortSlab' });

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

  // --- Wooden walkway along the quay edge (instanced by material) ---
  const walk = new THREE.Group();
  walk.name = 'WoodenWalkway';
  root.add(walk);

  const walkX = PORT.x1 - WALK_W * 0.5;
  const walkLen = z1 - z0;
  const walkZ = (z0 + z1) * 0.5;
  // mat indices: 0 wood, 1 woodDark, 2 woodWet, 3 iron
  const walkItems = [];
  const pushWalk = (mat, x, y, z, sx, sy, sz) => {
    walkItems.push({ mat, x, y, z, sx, sy, sz });
  };

  const plankCount = Math.max(4, Math.floor(WALK_W / 0.38));
  for (let i = 0; i < plankCount; i++) {
    const px = walkX - WALK_W * 0.5 + 0.2 + i * (WALK_W / plankCount);
    pushWalk(
      (i & 1) ? 0 : 1,
      px, y0 + PLANK_T * 0.5 + 0.01, walkZ,
      0.32, PLANK_T, walkLen,
    );
  }

  for (let z = z0 + 1.2; z < z1 - 0.5; z += PILE_SPACING) {
    pushWalk(1, walkX, y0 - 0.08, z, WALK_W + 0.15, 0.18, 0.28);
  }

  const faceX = PORT.x1 + 0.12;
  const faceH = y0 - WATER_Y;
  pushWalk(2, faceX, y0 - 0.05, walkZ, 0.35, 0.4, walkLen + 0.4);
  pushWalk(2, faceX + 0.05, WATER_Y + faceH * 0.35, walkZ, 0.28, 0.32, walkLen + 0.2);

  const pileTop = y0 + 0.35;
  const pileBot = WATER_Y - 1.6;
  const pileH = pileTop - pileBot;
  for (let z = z0 + 0.8; z <= z1 - 0.6; z += PILE_SPACING) {
    pushWalk(2, PORT.x1 + 0.55, pileBot + pileH * 0.5, z, 0.38, pileH, 0.38);
    pushWalk(1, PORT.x1 + 0.55, pileTop + 0.08, z, 0.48, 0.16, 0.48);
  }

  for (let z = z0 + 2; z < z1 - 1; z += PILE_SPACING * 1.5) {
    const bx = PORT.x1 - 0.55;
    pushWalk(3, bx, y0 + 0.35, z, 0.22, 0.7, 0.22);
    pushWalk(3, bx, y0 + 0.72, z, 0.34, 0.12, 0.34);
  }

  addInstancedBoxes(walk, unit, [wood, woodDark, woodWet, iron], walkItems, { name: 'PortWalk' });

  addCollider(
    RAPIER, world, body,
    WALK_W * 0.5, 0.2, walkLen * 0.5,
    walkX, y0 - 0.1, walkZ,
  );

  // Short concrete retaining lips where the pads meet leftover beach / grass
  const lipItems = [];
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
    lipItems.push({
      mat: 0,
      x: alongX ? mid : at,
      y: y0 + 0.18,
      z: alongX ? at : mid,
      sx: alongX ? len : 0.35,
      sy: 0.45,
      sz: alongX ? 0.35 : len,
    });
  }
  addInstancedBoxes(root, unit, [concreteDark], lipItems, { name: 'PortLip' });

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
