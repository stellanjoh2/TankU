import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, float, mix, normalMap, texture, uniform, uv, vec3 } from 'three/tsl';
import { WaterMesh } from './WaterMesh.js';

export const SIZE = 380;
export const WATER_Y = 0.2;
// Keep ~1.44 m cells after the map grew to fit the satellite island.
const SEGS = 264;
/** Keep a triangle if any corner is at least this far from shore (inland +, sea −). */
const SEA_PRUNE = -10;

// Hills: [cx, cz, height, radius] — ~50% taller + tighter falloff than the old 500 m map.
const HILLS = [
  [-35, -20, 18, 20], [22, -58, 15, 16], [-58, 42, 20, 22],
  [8, 58, 12, 14], [-72, -48, 16, 18], [42, 18, 13, 12],
  [-22, 72, 11, 12], [2, -78, 17, 18], [-48, -8, 14, 15],
  // Satellite island: one rise on the far (SW) side, landing stays flat.
  [-146.4, -147.4, 10, 15],
];

/** Satellite SW of the main island. r ≈ 42 m → about ¼ the main land area. */
export const ISLAND2 = { cx: -127.6, cz: -128.5, r: 42 };

/**
 * Slab bridge, main → satellite. Origin is deck-top centre; +X along the span.
 * yaw maps local +X onto the world XZ direction (see three.js Y rotation).
 */
export const BRIDGE = {
  x: -90.64,
  z: -91.54,
  yaw: 2.356194490192345,
  length: 25,
  deckW: 5.0,
  deckY: 2.2,
};

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
  // Satellite → bridge approach (plank deck is the water crossing)
  { closed: false, pts: [
    [ISLAND2.cx, ISLAND2.cz], [-121, -126], [-114, -118], [-108, -112], [-103, -106], [-100.5, -101.4],
  ] },
  // Far bank → south meadow, then the existing bowl track into the airfield
  { closed: false, pts: [
    [-80.7, -81.6], [-70, -80], [-58, -79], [-46, -75], [-34, -68], [-24, -56], [-14, -44], [-8, -36],
  ] },
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

/** Player spawn: centre of the satellite, facing the bridge / main island. Flattened so the tank doesn't creep. */
export const PLAYER_SPAWN = { x: ISLAND2.cx, z: ISLAND2.cz, padR: 5, padEdge: 7 };

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

/** 0 on the flanks, 1 on the crown. Measured against each hill's own radius. */
function hillCrown(x, z) {
  let best = 0;
  for (const [cx, cz, , rad] of HILLS) {
    const t = Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (rad * rad));
    if (t > best) best = t;
  }
  return smooth(best, 0.6, 0.85);
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
  if (onBridge(x, z, 1)) return false;
  if (shoreSigned(x, z) < 1.5) return false;
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

/** Signed distance-ish to the main C-island shore: >0 inland, 0 at beach, <0 in water. */
function mainShoreSigned(x, z) {
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

function island2Signed(x, z) {
  const dx = x - ISLAND2.cx;
  const dz = z - ISLAND2.cz;
  const r = Math.hypot(dx, dz);
  const ang = Math.atan2(dz, dx);
  const noise =
    3.2 * Math.sin(ang * 4.6 + 1.2) +
    1.6 * Math.sin(ang * 9.1 - 0.4) +
    0.9 * Math.sin(ang * 15.0 + x * 0.05);
  return ISLAND2.r + noise - r;
}

/** Signed distance-ish to shore: >0 inland, 0 at beach edge, <0 in water. */
export function shoreSigned(x, z) {
  return Math.max(mainShoreSigned(x, z), island2Signed(x, z));
}

/** Bridge-local XZ: +X along the span (main → satellite), +Z across. */
export function bridgeLocal(x, z) {
  const dx = x - BRIDGE.x, dz = z - BRIDGE.z;
  const c = Math.cos(BRIDGE.yaw), s = Math.sin(BRIDGE.yaw);
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

export function onBridge(x, z, margin = 0) {
  const { lx, lz } = bridgeLocal(x, z);
  return Math.abs(lx) < BRIDGE.length * 0.5 + margin && Math.abs(lz) < BRIDGE.deckW * 0.5 + margin;
}

/** Soft 0..1 pad on each bank so the deck meets flat ground. */
function approachFactor(x, z) {
  const { lx, lz } = bridgeLocal(x, z);
  const half = BRIDGE.length * 0.5;
  // Stay off the slab — the old 1.5 m overlap was the intersecting end-patches.
  if (Math.abs(lx) < half) return 0;
  const along = 9;
  const halfW = 4;
  const edge = 3.5;
  const a0 = lx < 0 ? -(half + along) : half;
  const a1 = lx < 0 ? -half : half + along;
  const alongD = lx >= a0 && lx <= a1 ? 0 : Math.min(Math.abs(lx - a0), Math.abs(lx - a1));
  const outside = Math.max(alongD, Math.max(0, Math.abs(lz) - halfW));
  if (outside <= 0) return 1;
  if (outside >= edge) return 0;
  return 1 - smooth(outside, 0, edge);
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
  const main = mainShoreSigned(x, z);
  const sat = island2Signed(x, z);
  const signed = Math.max(main, sat);
  const onSat = sat > main;

  if (signed < -1.5) {
    // Seabed slopes away from shore
    const depth = -signed;
    return WATER_Y - 0.8 - Math.min(12, depth * 0.12) - 0.15 * Math.sin(x * 0.08) * Math.cos(z * 0.07);
  }

  const inland = clamp01(signed / 22);
  const beach = clamp01(signed / 8); // 0 at water → 1 a short way inland

  // Base rolling relief (50% stronger than old map's ~1.6/0.8/0.3)
  let roll =
    2.4 * Math.sin(x * 0.028 + 0.4) * Math.cos(z * 0.024 - 0.3) +
    1.35 * Math.sin(x * 0.055 + 1.3) * Math.sin(z * 0.048 + 0.7) +
    0.7 * Math.sin(x * 0.13 + 2.1) * Math.cos(z * 0.15 + 0.4);

  let hills = 0;
  for (const [cx, cz, hh, rad] of HILLS) {
    const d2 = (x - cx) ** 2 + (z - cz) ** 2;
    hills += hh * Math.exp(-d2 / (rad * rad));
  }

  let h;
  if (!onSat) {
    h = roll + hills + ridgeHeight(x, z);
    h += 0.18 * Math.sin(x * 0.31) * Math.cos(z * 0.27) + 0.1 * Math.sin(x * 0.72 + z * 0.55);
    // Calm pocket near spawn meadow (west-central) — keep a driveable yard
    const spawnR = Math.hypot(x + 8, z + 5);
    h *= 0.4 + 0.6 * smooth(spawnR, 6, 22);
  } else {
    // Mostly flat satellite — keep a little roll; the one hill stays full-size.
    h = 0.4 + roll * 0.22 + hills;
  }

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

  const approach = approachFactor(x, z);
  if (approach > 0) h = THREE.MathUtils.lerp(h, BRIDGE.deckY - 0.2, approach);

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

/**
 * 0..1 meadow patch. High values are grass zones (~48 m); low values are the open ground between them.
 * Shared with grass placement so the vertex colour matches where clumps actually sit.
 */
export function grassCluster(x, z) {
  const a = 0.5 + 0.5 * Math.sin(x * 0.105 + 1.15) * Math.cos(z * 0.097 - 0.55);
  const b = 0.5 + 0.5 * Math.sin(x * 0.046 + z * 0.041 + 0.8);
  const c = 0.5 + 0.5 * Math.sin(x * 0.19 - z * 0.16 + 2.4);
  return a * 0.55 + b * 0.3 + c * 0.15;
}

/** Keep the upper ~75% of `grassCluster` — the other quarter of the meadow stays bare. */
export const GRASS_CLUSTER_CUT = 0.373;

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

/** World metres per repeat. AmbientCG CC0, 1K JPG downscaled to 256:
 *  mud = Ground088, rock = Ground110, sand = Ground010. */
export const GROUND_TILE_M = 4;

/**
 * Same splat the terrain mesh bakes per vertex: mud / rock / sand / concrete, plus shade and wet.
 * `slope` is 0 on flat ground (1 − normal.y).
 */
export function groundSurfaceAt(x, z, y = heightAt(x, z), slope = slopeAt(x, z)) {
  const signed = shoreSigned(x, z);
  const ridge = ridgeHeight(x, z);
  const hills = hillStrength(x, z);
  const road = roadFactor(x, z);
  const apron = Math.max(airfieldFactor(x, z), portFactor(x, z));

  const beach = apron < 0.35 ? 1 - clamp01((signed - 4) / 10) : 0;
  const cap = apron < 0.35 ? hillCrown(x, z) : 0;
  const rocky = clamp01(slope * 2.8 + hills * 0.12 + ridge * 0.05 - 0.2);
  const rock = clamp01((rocky - 0.15) / 0.5) * (1 - beach) * (1 - cap);
  const sand = beach + cap * (1 - beach);
  const mud = 1 - sand - rock;
  const concrete = apron > 0.02 ? apron : 0;

  let wet = 0;
  if (beach > 0) wet = (signed < 0 ? 1 : clamp01(1 - signed / 12)) * beach;

  let shade = 1;
  if (wet > 0) shade *= 1 - wet * 0.35;
  if (road > 0.02) shade *= 1 - road * 0.35;
  if (y < WATER_Y) shade *= 0.65;

  return { mud, rock, sand, concrete, shade, wet };
}

function prepGroundMap(tex, colorSpace) {
  tex.colorSpace = colorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

async function loadGroundSet(loader, name) {
  const base = `./textures/ground/${name}`;
  const [color, normal, roughAo] = await Promise.all([
    loader.loadAsync(`${base}_color.jpg`),
    loader.loadAsync(`${base}_normal.jpg`),
    loader.loadAsync(`${base}_rough_ao.jpg`),
  ]);
  return {
    color: prepGroundMap(color, THREE.SRGBColorSpace),
    normal: prepGroundMap(normal, THREE.NoColorSpace),
    // R = roughness, G = ambient occlusion. Packed so the splat stays under the sampler limit.
    roughAo: prepGroundMap(roughAo, THREE.NoColorSpace),
  };
}

function makeGroundMaterial(sets, concreteColor) {
  const mapUv = uv().mul(SIZE / GROUND_TILE_M);
  // xyz = mud, rock, sand (sum to 1). w = concrete apron overlay.
  const biome = attribute('biome', 'vec4');
  const shade = attribute('shade', 'float');
  const wet = attribute('wet', 'float');
  const rgb = (tex) => texture(tex).sample(mapUv).rgb;
  const surface = (tex) => texture(tex).sample(mapUv);

  const albedo = rgb(sets.mud.color).mul(biome.x)
    .add(rgb(sets.rock.color).mul(biome.y))
    .add(rgb(sets.sand.color).mul(biome.z));
  const packedN = rgb(sets.mud.normal).mul(biome.x)
    .add(rgb(sets.rock.normal).mul(biome.y))
    .add(rgb(sets.sand.normal).mul(biome.z));
  const mudS = surface(sets.mud.roughAo);
  const rockS = surface(sets.rock.roughAo);
  const sandS = surface(sets.sand.roughAo);
  const rough = mudS.r.mul(biome.x).add(rockS.r.mul(biome.y)).add(sandS.r.mul(biome.z));
  const ao = mudS.g.mul(biome.x).add(rockS.g.mul(biome.y)).add(sandS.g.mul(biome.z));

  const mat = new MeshStandardNodeMaterial({ metalness: 0, roughness: 1 });
  mat.colorNode = mix(albedo.mul(shade), uniform(concreteColor), biome.w);
  mat.normalNode = normalMap(mix(packedN, vec3(0.5, 0.5, 1), biome.w));
  // Gloss (1 − roughness) halved so the photo sets read less shiny. Concrete stays at 0.9.
  const dulled = mix(rough.mul(float(1).sub(wet.mul(0.5))), float(1), float(0.5));
  mat.roughnessNode = mix(dulled, float(0.9), biome.w);
  mat.aoNode = mix(ao, float(1), biome.w);
  return mat;
}

// Grass / sand / rock entries stay so saved visuals still load. The mesh uses the photo sets;
// only concrete and water are still sampled as flat colours.
export const DEFAULT_GROUND_PALETTE = {
  grass: '#3a5a22',   // meadow under the fluffy grass
  dry: '#6a6a38',
  dirt: '#5a4028',
  mud: '#4a321c',     // packed track
  sand: '#d2c49a',    // beach
  wetSand: '#9a8c68',
  rock: '#6e6a64',    // hills / stone
  concrete: '#908773', // apron edge, matched to Concrete047A
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
  geo.computeTangents();

  const nrm = geo.attributes.normal;
  const biomeArr = new Float32Array(pos.count * 4);
  const shadeArr = new Float32Array(pos.count);
  const wetArr = new Float32Array(pos.count);
  geo.setAttribute('biome', new THREE.BufferAttribute(biomeArr, 4));
  geo.setAttribute('shade', new THREE.BufferAttribute(shadeArr, 1));
  geo.setAttribute('wet', new THREE.BufferAttribute(wetArr, 1));

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

  function applyPalette() {
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const s = groundSurfaceAt(x, z, y, 1 - nrm.getY(i));
      biomeArr.set([s.mud, s.rock, s.sand, s.concrete], i * 4);
      shadeArr[i] = s.shade;
      wetArr[i] = s.wet;
    }
    geo.attributes.biome.needsUpdate = true;
    geo.attributes.shade.needsUpdate = true;
    geo.attributes.wet.needsUpdate = true;
  }
  applyPalette();

  const loader = new THREE.TextureLoader();
  const [mudMaps, rockMaps, sandMaps] = await Promise.all([
    loadGroundSet(loader, 'mud'),
    loadGroundSet(loader, 'rock'),
    loadGroundSet(loader, 'sand'),
  ]);
  const mat = makeGroundMaterial({ mud: mudMaps, rock: rockMaps, sand: sandMaps }, palette.concrete);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'IslandTerrain';
  scene.add(mesh);

  // WebGPU ocean (three.js WaterMesh). Seabed collider stays on the terrain mesh.
  const waterNormals = await loader.loadAsync('./textures/waternormals.jpg');
  waterNormals.wrapS = waterNormals.wrapT = THREE.RepeatWrapping;
  const water = new WaterMesh(
    new THREE.PlaneGeometry(SIZE * 6, SIZE * 6),
    {
      waterNormals,
      sunDirection: (sunDir || new THREE.Vector3(0.70707, 0.70707, 0)).clone().normalize(),
      sunColor: 0xffffff,
      waterColor: palette.water,
      distortionScale: 3.7,
      size: 2.0,
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
    groundSets: { mud: mudMaps, rock: rockMaps, sand: sandMaps },
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
