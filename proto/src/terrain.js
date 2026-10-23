import * as THREE from 'three';
import { WaterMesh } from './WaterMesh.js';

export const SIZE = 250;
export const WATER_Y = 0.2;
// −20% vs the old 220-seg grid; sea faces are pruned after displace
const SEGS = 176;
/** Keep a triangle if any corner is at least this far from shore (inland +, sea −). */
const SEA_PRUNE = -10;

// Hills: [cx, cz, height, radius] — ~50% taller + tighter falloff than the old 500 m map.
const HILLS = [
  [-35, -20, 18, 20], [22, -58, 15, 16], [-58, 42, 20, 22],
  [8, 58, 12, 14], [-72, -48, 16, 18], [42, 18, 13, 12],
  [-22, 72, 11, 12], [2, -78, 17, 18], [-48, -8, 14, 15],
];

// Flat-valley tracks only (open polylines). Never routed over hill flanks.
// Each entry: { closed, pts: [[x,z],…] }
const ROAD_WAYS = [
  // South meadow bowl
  { closed: false, pts: [[-8, -5], [0, -18], [8, -28], [4, -40], [-8, -36], [-2, -22]] },
  // North / west saddles between the big hills
  { closed: true, pts: [
    [-8, -5], [0, 8], [-8, 22], [-18, 30], [-28, 28], [-34, 16], [-28, 6], [-16, 2],
  ] },
  // East meadow spur
  { closed: false, pts: [[-8, -5], [4, 0], [10, 12], [6, 26], [-4, 34]] },
];
export const ROAD_HALF_W = 4.2;

/** Spawn-side airfield / refuel pad (axis-aligned; hangar sits on the east edge). */
export const AIRFIELD = {
  cx: -1,
  cz: -11,
  hw: 17,   // half-width along X
  hd: 14,   // half-depth along Z
  edge: 5,  // soft blend outside the hard pad
};

/**
 * Small working quay east of the hangar apron — hard port deck instead of beach,
 * with a vertical face at x1 where the wooden walkway sits.
 */
export const PORT = {
  x0: 12,    // meets airfield east edge (~16)
  x1: 26.5,  // quay face (ships dock east of this)
  z0: -20,
  z1: 1,
  edge: 3.5,
  wall: 2.8, // metres of horizontal drop for the quay face
};

/** Player spawn: meadow between the two southern hills, looking at the port. Flattened so the tank doesn't creep. */
export const PLAYER_SPAWN = { x: -40, z: -62, padR: 5, padEdge: 7 };

/** Concrete yard on dry land south of the quay deck (water tower stands here). */
export const PORT_YARD = {
  x0: 16.4,  // east of the airfield slabs (x ≤ 15.5)
  x1: 24,
  z0: -33,
  z1: PORT.z0,
};

const smooth = (x, a, b) => THREE.MathUtils.smoothstep(x, a, b);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Soft 0..1 mask for the airfield pad (1 = fully flattened concrete apron). */
export function airfieldFactor(x, z) {
  const dx = Math.abs(x - AIRFIELD.cx) - AIRFIELD.hw;
  const dz = Math.abs(z - AIRFIELD.cz) - AIRFIELD.hd;
  const outside = Math.max(dx, dz);
  if (outside <= 0) return 1;
  if (outside >= AIRFIELD.edge) return 0;
  return 1 - smooth(outside, 0, AIRFIELD.edge);
}

export function isAirfield(x, z) {
  return airfieldFactor(x, z) > 0.4;
}

function rectFactor(r, x, z, edge) {
  const dx = Math.max(r.x0 - x, x - r.x1);
  const dz = Math.max(r.z0 - z, z - r.z1);
  const outside = Math.max(dx, dz);
  if (outside <= 0) return 1;
  if (outside >= edge) return 0;
  return 1 - smooth(outside, 0, edge);
}

/** Soft 0..1 mask for the port deck (west of the quay face) + the yard south of it. */
export function portFactor(x, z) {
  return Math.max(rectFactor(PORT, x, z, PORT.edge), rectFactor(PORT_YARD, x, z, PORT.edge));
}

export function isPort(x, z) {
  return portFactor(x, z) > 0.4;
}

/** Soft corridor along the quay Z range (for the vertical wall drop). */
function portCorridor(z) {
  if (z >= PORT.z0 && z <= PORT.z1) return 1;
  const d = z < PORT.z0 ? PORT.z0 - z : z - PORT.z1;
  if (d >= PORT.edge) return 0;
  return 1 - smooth(d, 0, PORT.edge);
}

function distPointSeg(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const apx = px - ax, apz = pz - az;
  const ab2 = abx * abx + abz * abz || 1e-8;
  const t = clamp01((apx * abx + apz * abz) / ab2);
  const dx = apx - abx * t, dz = apz - abz * t;
  return Math.hypot(dx, dz);
}

/** Peak hill gaussian height at (x,z) — used to keep roads/grass off flanks. */
function hillStrength(x, z) {
  let s = 0;
  for (const [cx, cz, hh, rad] of HILLS) {
    const d2 = (x - cx) ** 2 + (z - cz) ** 2;
    s = Math.max(s, hh * Math.exp(-d2 / (rad * rad)));
  }
  return s;
}

function slopeAt(x, z, e = 1) {
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  return 1 - (2 * e) / Math.hypot(dx, 2 * e, dz);
}

/** Metres to the nearest mud-road centreline. */
export function roadDist(x, z) {
  let best = Infinity;
  for (const way of ROAD_WAYS) {
    const pts = way.pts;
    const n = pts.length;
    const segs = way.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      best = Math.min(best, distPointSeg(x, z, a[0], a[1], b[0], b[1]));
    }
  }
  return best;
}

/** Flat valley only — roads never climb the hills even if a segment grazes a flank. */
function isRoadable(x, z) {
  if (shoreSigned(x, z) < 10) return false;
  if (hillStrength(x, z) > 3.4) return false;
  if (ridgeHeight(x, z) > 4) return false;
  if (slopeAt(x, z) > 0.11) return false;
  return true;
}

/** Soft 0..1 mask for painting the track (1 = centre). */
export function roadFactor(x, z) {
  const d = roadDist(x, z);
  if (d >= ROAD_HALF_W + 1.5) return 0;
  if (!isRoadable(x, z)) return 0;
  return 1 - smooth(d, ROAD_HALF_W * 0.55, ROAD_HALF_W + 1.5);
}

export function isOnRoad(x, z, margin = 0) {
  return roadDist(x, z) < ROAD_HALF_W + margin && isRoadable(x, z);
}

/** Signed distance-ish to shore: >0 inland, 0 at beach edge, <0 in water. */
export function shoreSigned(x, z) {
  // C / crescent: land mass shifted west, deep bay opening east (matches ref).
  const lx = x + 18;
  const lz = z * 0.92;
  const r = Math.hypot(lx, lz);
  const ang = Math.atan2(lz, lx);

  const bay = Math.max(0, Math.cos(ang));
  const bayCarve = bay * bay * (48 + 10 * Math.sin(ang * 3.0));

  // Irregular coastline
  const coastNoise =
    6.5 * Math.sin(ang * 5.2 + 0.4) +
    3.2 * Math.sin(ang * 11.0 - 1.1) +
    2.0 * Math.sin(ang * 19.0 + x * 0.04) +
    1.4 * Math.sin(x * 0.09 + z * 0.07);

  const landR = 98 - bayCarve + coastNoise;
  // Soft eastern inlet fingers
  const inlet = Math.exp(-((ang - 0.15) ** 2) / 0.18) * 14;
  return landR - inlet - r;
}

/** 0 at/beyond waterline → 1 deep inland (past beach). */
export function landFactor(x, z) {
  return clamp01(shoreSigned(x, z) / 22);
}

/** Mountain spine along the C arc (west/north-south wrap). */
function ridgeHeight(x, z) {
  const lx = x + 18;
  const lz = z * 0.92;
  const ang = Math.atan2(lz, lx);
  const r = Math.hypot(lx, lz);
  // Ridge sits mid-island, away from the bay mouth — tight radial = steep flanks
  const along = clamp01(1 - Math.abs(ang) / 2.4);
  const awayFromBay = clamp01((-Math.cos(ang) + 0.35) / 1.2);
  const radial = Math.exp(-((r - 55) ** 2) / (16 * 16));
  const jagged =
    1 +
    0.45 * Math.sin(ang * 7.0 + 0.6) +
    0.28 * Math.sin(ang * 15.0 - r * 0.08) +
    0.15 * Math.sin(ang * 23.0 + r * 0.12);
  return along * awayFromBay * radial * jagged * 28;
}

/**
 * Natural terrain height (no airfield flatten).
 * Island interior with dramatic hills; beach shelf; seabed below WATER_Y offshore.
 */
function naturalHeightAt(x, z) {
  const signed = shoreSigned(x, z);

  if (signed < -1.5) {
    // Seabed slopes away from shore
    const depth = -signed;
    return WATER_Y - 0.8 - Math.min(12, depth * 0.12) - 0.15 * Math.sin(x * 0.08) * Math.cos(z * 0.07);
  }

  const inland = clamp01(signed / 22);
  const beach = clamp01(signed / 8); // 0 at water → 1 a short way inland

  // Base rolling relief (50% stronger than old map's ~1.6/0.8/0.3)
  let h =
    2.4 * Math.sin(x * 0.028 + 0.4) * Math.cos(z * 0.024 - 0.3) +
    1.35 * Math.sin(x * 0.055 + 1.3) * Math.sin(z * 0.048 + 0.7) +
    0.7 * Math.sin(x * 0.13 + 2.1) * Math.cos(z * 0.15 + 0.4);

  for (const [cx, cz, hh, rad] of HILLS) {
    const d2 = (x - cx) ** 2 + (z - cz) ** 2;
    h += hh * Math.exp(-d2 / (rad * rad));
  }

  h += ridgeHeight(x, z);

  // Micro relief / natural roughness
  h += 0.18 * Math.sin(x * 0.31) * Math.cos(z * 0.27) + 0.1 * Math.sin(x * 0.72 + z * 0.55);

  // Calm pocket near spawn meadow (west-central) — keep a driveable yard
  const spawnR = Math.hypot(x + 8, z + 5);
  h *= 0.4 + 0.6 * smooth(spawnR, 6, 22);

  // Beach shelf: low, sandy, mild slope into the sea
  const beachH = 0.35 + beach * 1.4 + inland * 0.4;
  h = beachH + h * Math.pow(inland, 1.35);

  // Soft blend through the intertidal strip
  if (signed < 6) {
    const t = clamp01((signed + 1.5) / 7.5);
    const seabed = WATER_Y - 0.5;
    h = THREE.MathUtils.lerp(seabed, h, smooth(t, 0, 1));
  }

  return h;
}

/** Pad height locked to the meadow at the airfield centre. */
export const AIRFIELD_Y = naturalHeightAt(AIRFIELD.cx, AIRFIELD.cz);

const SPAWN_PAD_Y = naturalHeightAt(PLAYER_SPAWN.x, PLAYER_SPAWN.z);

/**
 * Terrain height in metres (airfield + port deck flattened; sharp quay drop seaward).
 */
export function heightAt(x, z) {
  let h = naturalHeightAt(x, z);
  const pad = Math.max(airfieldFactor(x, z), portFactor(x, z));
  if (pad > 0) h = THREE.MathUtils.lerp(h, AIRFIELD_Y, pad);

  const { padR, padEdge } = PLAYER_SPAWN;
  const spawnD = Math.hypot(x - PLAYER_SPAWN.x, z - PLAYER_SPAWN.z);
  if (spawnD < padR + padEdge) h = THREE.MathUtils.lerp(SPAWN_PAD_Y, h, smooth(spawnD, padR, padR + padEdge));

  // Vertical-ish quay face: slam from deck height down to seabed just east of x1.
  const corridor = portCorridor(z);
  if (corridor > 0.01 && x > PORT.x1) {
    const past = x - PORT.x1;
    if (past < PORT.wall + 1.5) {
      const drop = smooth(past, 0.15, PORT.wall);
      const seabed = WATER_Y - 0.9 - Math.min(5, past * 0.35);
      const wallH = THREE.MathUtils.lerp(AIRFIELD_Y, seabed, drop);
      h = THREE.MathUtils.lerp(h, wallH, corridor);
    }
  }
  return h;
}

/** Meadow mask: grass ground inland, not beach / hill rock / road / airfield / port. */
export function isGrassable(x, z) {
  if (isAirfield(x, z) || isPort(x, z)) return false;
  if (shoreSigned(x, z) < 12) return false; // beach stays sand
  if (heightAt(x, z) < WATER_Y + 1.6) return false;
  if (isOnRoad(x, z, 0.8)) return false;
  if (hillStrength(x, z) > 4.5) return false;
  if (ridgeHeight(x, z) > 6) return false;
  if (slopeAt(x, z, 0.75) > 0.16) return false;
  return true;
}

function detailTexture() {
  const n = 256;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  const img = g.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const v = 200 + Math.random() * 55;
    img.data.set([v, v, v * 0.97, 255], i * 4);
  }
  g.putImageData(img, 0, 0);
  for (let k = 0; k < 900; k++) {
    g.fillStyle = `rgba(${90 + Math.random() * 60},${80 + Math.random() * 50},60,${0.08 + Math.random() * 0.12})`;
    const s = 2 + Math.random() * 10;
    g.fillRect(Math.random() * n, Math.random() * n, s, s * (0.3 + Math.random()));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(SIZE / 5, SIZE / 5);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export const DEFAULT_GROUND_PALETTE = {
  grass: '#3a5a22',   // meadow under the fluffy grass
  dry: '#6a6a38',
  dirt: '#5a4028',
  mud: '#4a321c',     // packed track
  sand: '#d2c49a',    // beach
  wetSand: '#9a8c68',
  rock: '#6e6a64',    // hills / stone
  concrete: '#c4bda8', // airfield apron (beige / light gray)
  water: '#2a6a88',
};

/** Drop faces that sit entirely out at sea so the wireframe/collider aren't a dense ocean grid. */
function pruneSeaFaces(geo) {
  const pos = geo.attributes.position;
  const src = geo.index.array;
  const out = [];
  for (let i = 0; i < src.length; i += 3) {
    const a = src[i], b = src[i + 1], c = src[i + 2];
    const sa = shoreSigned(pos.getX(a), pos.getZ(a));
    const sb = shoreSigned(pos.getX(b), pos.getZ(b));
    const sc = shoreSigned(pos.getX(c), pos.getZ(c));
    if (sa > SEA_PRUNE || sb > SEA_PRUNE || sc > SEA_PRUNE) out.push(a, b, c);
  }
  geo.setIndex(out);
}

export async function buildTerrain(RAPIER, world, scene, { sunDir } = {}) {
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  pruneSeaFaces(geo);
  geo.computeVertexNormals();

  const nrm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  geo.setAttribute('color', colorAttr);

  const palette = {
    grass: new THREE.Color(DEFAULT_GROUND_PALETTE.grass),
    dry: new THREE.Color(DEFAULT_GROUND_PALETTE.dry),
    dirt: new THREE.Color(DEFAULT_GROUND_PALETTE.dirt),
    mud: new THREE.Color(DEFAULT_GROUND_PALETTE.mud),
    sand: new THREE.Color(DEFAULT_GROUND_PALETTE.sand),
    wetSand: new THREE.Color(DEFAULT_GROUND_PALETTE.wetSand),
    rock: new THREE.Color(DEFAULT_GROUND_PALETTE.rock),
    concrete: new THREE.Color(DEFAULT_GROUND_PALETTE.concrete),
    water: new THREE.Color(DEFAULT_GROUND_PALETTE.water),
  };
  const c = new THREE.Color();

  function applyPalette() {
    const grass = palette.grass, dry = palette.dry, dirt = palette.dirt, mud = palette.mud;
    const sand = palette.sand, wetSand = palette.wetSand, rock = palette.rock;
    const concrete = palette.concrete;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const signed = shoreSigned(x, z);
      const slope = 1 - nrm.getY(i);
      const patch = 0.5 + 0.5 * Math.sin(x * 0.07 + Math.sin(z * 0.05) * 2.0) * Math.cos(z * 0.06);
      const ridge = ridgeHeight(x, z);
      const hills = hillStrength(x, z);
      const road = roadFactor(x, z);
      const apron = Math.max(airfieldFactor(x, z), portFactor(x, z));

      // --- Biomes (intentional, little cross-bleed) ---
      if (y < WATER_Y + 0.05 || signed < 0) {
        // Intertidal / seabed
        c.copy(wetSand).lerp(sand, clamp01((y - (WATER_Y - 1)) / 1.5));
      } else if (signed < 12 && apron < 0.35) {
        // Beach: sand only (wet → dry as you leave the water) — skipped under port
        const t = clamp01(signed / 12);
        c.copy(wetSand).lerp(sand, 0.35 + 0.65 * t);
      } else {
        // Inland: rock on hills, grass meadows in the flats
        const rocky = clamp01(
          slope * 2.8 + hills * 0.12 + ridge * 0.05 - 0.2,
        );
        if (rocky > 0.45) {
          c.copy(rock).lerp(dirt, 0.15 + patch * 0.1);
          c.lerp(sand, clamp01(slope - 0.15) * 0.12); // dusty stone
        } else {
          // Grass ground — fluffy grass draws on top of this
          c.copy(grass).lerp(dry, patch * 0.4);
          c.lerp(dirt, clamp01(slope * 2.5) * 0.25);
          c.lerp(rock, rocky * 0.9); // soft foot-of-hill blend
        }
      }

      // Mud road on flat valleys only (roadFactor already gated)
      if (road > 0.02) {
        const rut = 0.82 + 0.18 * Math.sin(x * 0.55 + z * 0.4);
        c.lerp(mud, road * rut);
        c.lerp(dirt, road * 0.3 * (1 - rut));
      }
      // Beige concrete under hangar apron + port deck
      if (apron > 0.02) {
        const slab = 0.92 + 0.08 * Math.sin(x * 1.1) * Math.cos(z * 1.05);
        c.lerp(concrete, apron * slab);
        c.lerp(dirt, apron * 0.12 * (1 - slab));
      }
      if (y < WATER_Y) c.multiplyScalar(0.65);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    colorAttr.needsUpdate = true;
  }
  applyPalette();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detailTexture(), roughness: 0.97 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'IslandTerrain';
  scene.add(mesh);

  // WebGPU ocean placeholder (three.js WaterMesh / webgpu_ocean example).
  // Seabed collider stays on the terrain mesh (shore skirt only after prune).
  const waterNormals = await new THREE.TextureLoader().loadAsync('./textures/waternormals.jpg');
  waterNormals.wrapS = waterNormals.wrapT = THREE.RepeatWrapping;
  const water = new WaterMesh(
    new THREE.PlaneGeometry(SIZE * 6, SIZE * 6), // reaches past the backdrop islands (bgIsland.js)
    {
      waterNormals,
      sunDirection: (sunDir || new THREE.Vector3(0.70707, 0.70707, 0)).clone().normalize(),
      sunColor: 0xffffff,
      waterColor: palette.water,
      distortionScale: 3.7,
      size: 2.0, // world→UV multiplier: higher = smaller ripples
      timeScale: 0.5,
      resolutionScale: 0.5,
    },
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_Y;
  water.receiveShadow = true;
  water.name = 'Ocean';
  scene.add(water);

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const verts = new Float32Array(pos.array);
  const idx = new Uint32Array(geo.index.array);
  world.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx).setFriction(0.9), body);

  const paletteListeners = [];

  return {
    mesh,
    water,
    palette,
    setPalette( partial ) {
      for (const [k, v] of Object.entries(partial)) {
        if (!palette[k]) continue;
        palette[k].set(v);
        if (k === 'water') water.waterColor.value.copy(palette.water);
      }
      applyPalette();
      for (const fn of paletteListeners) fn();
    },
    onPaletteChange(fn) {
      paletteListeners.push(fn);
    },
  };
}
