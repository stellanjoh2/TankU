// Offshore cruisers. The four main-battery turrets are separate nodes so they can train.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PORT, WATER_Y } from './terrain.js';

// Model length ≈ 9.1 m → scale 10 ≈ 91 m battleship silhouette.
const SCALE = 10;
// Local Y of the dark hull stripe (top of red BOTTOM / waterline paint).
const WATERLINE_Y = 0.16;

// Length is along model +X; ±π/2 lays the keel north–south (side faces land).
const PLACEMENTS = [
  {
    // East bay — ~100 m off the quay.
    x: PORT.x1 + 100,
    z: (PORT.z0 + PORT.z1) * 0.5,
    yaw: Math.PI / 2,
  },
  {
    // West coast — ~100 m offshore opposite the bay.
    x: -212,
    z: 8,
    yaw: -Math.PI / 2,
  },
];

function prepMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      // Export tagged every mat alphaMode:BLEND — that disables depthWrite and
      // lets the water/horizon punch through. Force opaque (flag keeps cutout).
      const isFlag = /flag/i.test(m.name || o.name || '');
      m.transparent = false;
      m.opacity = 1;
      m.depthWrite = true;
      m.side = THREE.FrontSide;
      if (isFlag) {
        m.alphaTest = 0.5;
        m.side = THREE.DoubleSide;
      } else {
        m.alphaTest = 0;
      }
      m.needsUpdate = true;
    }
  });
}

/**
 * @returns {Promise<{ root: THREE.Group, ships: object[], wakeTurrets: () => void }>}
 */
export async function buildShip(scene) {
  const gltf = await new GLTFLoader().loadAsync('./models/ship.glb');
  const proto = gltf.scene;
  prepMaterials(proto);

  const root = new THREE.Group();
  root.name = 'Ships';
  const y = WATER_Y - WATERLINE_Y * SCALE;

  const ships = [];
  for (let i = 0; i < PLACEMENTS.length; i++) {
    const p = PLACEMENTS[i];
    const ship = i === 0 ? proto : proto.clone(true);
    ship.name = i === 0 ? 'ShipEast' : 'ShipWest';
    ship.scale.setScalar(SCALE);
    ship.rotation.y = p.yaw;
    ship.position.set(p.x, y, p.z);
    root.add(ship);
    ships.push({
      name: ship.name,
      x: p.x,
      z: p.z,
      turrets: collectTurrets(ship),
    });
  }

  scene.add(root);

  /** Turrets are scenery until a barrage. Call after freezeStatic so they can yaw. */
  function wakeTurrets() {
    for (const s of ships) {
      for (const t of s.turrets) {
        t.pivot.matrixAutoUpdate = true;
        for (const m of t.muzzles) m.matrixAutoUpdate = true;
      }
    }
  }

  return { root, ships, wakeTurrets };
}

/** Main-battery twins. Local +X is the bore; sign is which way the barrels point at rest.
 *  Only pivots that own muzzle empties train. Static mounts are named Turret* too. */
function collectTurrets(ship) {
  const turrets = [];
  ship.traverse((o) => {
    if (!o.name.startsWith('Turret')) return;
    const muzzles = o.children.filter((c) => c.name.startsWith('Muzzle'));
    if (!muzzles.length) return;
    const sign = muzzles[0].position.x >= 0 ? 1 : -1;
    turrets.push({ pivot: o, muzzles, sign });
  });
  turrets.sort((a, b) => a.pivot.position.x - b.pivot.position.x);
  return turrets;
}
