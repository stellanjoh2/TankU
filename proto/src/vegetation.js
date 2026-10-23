// Stylized tropical vegetation pack (Serhii3D) — clustered along beaches / land.
// LODs intentionally deferred.
import * as THREE from 'three';
import { PropertyBinding } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SIZE, WATER_Y, heightAt, shoreSigned, isOnRoad, isAirfield } from './terrain.js';

const PREFABS = {
  Palm_01: { kind: 'tree', weight: 1.0 },
  // Palm_02 omitted: heavily bent trunk (~51° lean)
  Palm_03: { kind: 'tree', weight: 0.9 },
  Palm_04: { kind: 'tree', weight: 0.95 },
  Rocks_low: { kind: 'rock', weight: 1.2 },
  'Rocks_low.001': { kind: 'rock', weight: 0.7 },
  'Rocks_low.002': { kind: 'rock', weight: 0.35 },
  'Rocks_low.003': { kind: 'rock', weight: 0.55 },
  'Rocks_low.004': { kind: 'rock', weight: 1.0 },
  Bush_01: { kind: 'plant', weight: 1.1 },
  Bush_02: { kind: 'plant', weight: 1.0 },
  Bush_03: { kind: 'plant', weight: 0.7 },
  Bush_04: { kind: 'plant', weight: 0.85 },
  Plant_01: { kind: 'plant', weight: 0.9 },
  Plant_02: { kind: 'plant', weight: 0.9 },
  Plant_03: { kind: 'plant', weight: 1.0 },
  Plant_04: { kind: 'plant', weight: 0.55 },
  Plant_05: { kind: 'plant', weight: 1.0 },
  Plant_06: { kind: 'plant', weight: 1.05 },
  Plant_07: { kind: 'plant', weight: 1.15 },
  Plant_08: { kind: 'plant', weight: 1.0 },
  Dry_Plant_01: { kind: 'plant', weight: 1.2 },
  Dry_Plant_02: { kind: 'plant', weight: 1.1 },
  Dry_Plant_03: { kind: 'plant', weight: 0.9 },
  Dry_Plant_04: { kind: 'plant', weight: 1.15 },
};

const GLOBAL_SCALE = 1.0;
const TREE_SCALE = 1.25; // 25% taller/larger palms
const ROCK_SCALE = 1.5; // 50% larger than previous rock scales
const SPAWN = { x: -8, z: -5 };
const SPAWN_CLEAR = 14;
const HALF = SIZE * 0.5;

const CLUSTER_COUNT = 32;
// Gray-rock piles: few sites, many stones packed tight (reads as intentional outcrops).
const ROCK_GROUPS = 10;
const ROCK_GROUP_SPACING = 32;
const ROCK_GROUP_MEMBERS = [4, 7]; // inclusive range
const ROCK_PACK = [0.55, 2.4];     // metres from group centre
const MAX_PLACED = 620;

// Tank-sized cover: clustered into small outcrops (total count −20% vs original 28).
const COVER_ROCKS = 22;
const COVER_GROUP_SIZE = [2, 3];
const COVER_GROUP_SPACING = 28;
const COVER_PACK = [2.5, 6.5];
const COVER_HEIGHT = [3.4, 4.8];
const COVER_MAX_FOOTPRINT = 15;
const COVER_SPAWN_CLEAR = 18;
const PALM_TRUNK_R = 0.4;

/** Default visible palm count (previous ~28 + 25%). Slider 1.0 = this. */
export const PALM_AMOUNT_DEFAULT = 1;
const BASE_PALM_TARGET = 35;
const MAX_PALM_TARGET = Math.ceil(BASE_PALM_TARGET * 2);

/** Default visible ground-plant count (+25% vs prior 200). Slider 1.0 = this; pool is 2× for headroom. */
export const PLANT_AMOUNT_DEFAULT = 1;
const BASE_PLANT_TARGET = 250;
const MAX_PLANT_TARGET = Math.ceil(BASE_PLANT_TARGET * 2);

export const FOLIAGE_BRIGHTNESS_DEFAULT = 1;
export const PALM_BRIGHTNESS_DEFAULT = 1;
/** Units match visuals Wind strength (grass sway is off). */
export const WIND_DEFAULT = 0.085;
/** Radians of whole-tree lean per unit of wind amp. */
const PALM_WIND_LEAN = 1.35;
/** Radians of big-leaf / bush lean per unit of wind amp (shorter plants → less lean). */
const PLANT_WIND_LEAN = 0.7;

function seededRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function slopeAt(x, z, e = 0.8) {
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  const ny = (2 * e) / Math.hypot(dx, 2 * e, dz);
  return 1 - ny;
}

function pickWeighted(list, rand) {
  let t = 0;
  for (const item of list) t += item.meta.weight;
  let r = rand() * t;
  for (const item of list) {
    r -= item.meta.weight;
    if (r <= 0) return item;
  }
  return list[list.length - 1];
}

function isPalmLeafMaterial(m) {
  const n = (m.name || '').toLowerCase();
  // "PalmLeaves" contains "leaves", not "leaf" — match both.
  return n.includes('palmleaf') || n.includes('palmleaves') || n === 'palmleaves';
}

function isFoliageMaterial(m) {
  const n = (m.name || '').toLowerCase();
  return (
    isPalmLeafMaterial(m) ||
    n.includes('leaf') ||
    n.includes('leaves') ||
    n.includes('veget') ||
    n.includes('plant') ||
    n.includes('atlas')
  );
}

/** Pack ships leaves as alphaMode:BLEND (depthWrite off) — force opaque cutouts. */
function setupCutoutMaterial(m) {
  m.transparent = false;
  m.opacity = 1;
  m.depthWrite = true;
  m.depthTest = true;
  m.alphaTest = 0.5;
  m.blending = THREE.NormalBlending;
  m.side = THREE.DoubleSide;
  // Ensure map alpha drives the discard (not leftover BLEND state from GLTF).
  if (m.map) {
    m.map.colorSpace = THREE.SRGBColorSpace;
    m.map.premultiplyAlpha = false;
  }
  m.needsUpdate = true;
}

/** Bake a Sketchfab prefab (incl. FBX 0.01 parent scale) into a grounded group at origin. */
function extractPrefab(src, foliageMats, palmLeafMats) {
  src.updateWorldMatrix(true, true);
  const group = new THREE.Group();
  group.name = src.name;

  src.traverse((child) => {
    if (!child.isMesh) return;
    const mesh = new THREE.Mesh(child.geometry, child.material);
    mesh.name = child.name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    child.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (let i = 0; i < mats.length; i++) {
      let m = mats[i];
      if (!m) continue;
      // Clone so we don't keep GLTF BLEND flags on a shared source material.
      m = m.clone();
      if (Array.isArray(mesh.material)) mesh.material[i] = m;
      else mesh.material = m;
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
      if (isFoliageMaterial(m)) {
        setupCutoutMaterial(m);
        if (!m.userData.baseColor) m.userData.baseColor = m.color.clone();
        if (isPalmLeafMaterial(m)) palmLeafMats.add(m);
        else foliageMats.add(m);
      } else {
        m.side = THREE.DoubleSide;
      }
    }
    group.add(mesh);
  });

  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) {
    return { template: group, radius: 0.5, height: 1 };
  }
  const center = box.getCenter(new THREE.Vector3());
  const minY = box.min.y;
  for (const child of group.children) {
    child.position.x -= center.x;
    child.position.z -= center.z;
    child.position.y -= minY;
  }
  box.setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(0.3, Math.max(size.x, size.z) * 0.5);
  return { template: group, radius, height: size.y, size, base: lowVertexCentre(group, 0.5) };
}

/** Average XZ of vertices within `maxY` of the ground — a palm's trunk foot, not its leaning crown. */
function lowVertexCentre(group, maxY) {
  const v = new THREE.Vector3();
  let sx = 0, sz = 0, n = 0;
  for (const mesh of group.children) {
    mesh.updateMatrix();
    const p = mesh.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrix);
      if (v.y > maxY) continue;
      sx += v.x; sz += v.z; n++;
    }
  }
  return n ? new THREE.Vector2(sx / n, sz / n) : new THREE.Vector2();
}

function overlaps(placed, x, z, r) {
  for (const p of placed) {
    const dx = p.x - x;
    const dz = p.z - z;
    if (dx * dx + dz * dz < (p.r + r) * (p.r + r)) return true;
  }
  return false;
}

function nearSpawn(x, z) {
  return Math.hypot(x - SPAWN.x, z - SPAWN.z) < SPAWN_CLEAR;
}

function canPlaceTree(x, z) {
  const shore = shoreSigned(x, z);
  if (shore < 6 || shore > 22) return false;
  if (heightAt(x, z) < WATER_Y + 0.4) return false;
  if (slopeAt(x, z) > 0.12) return false;
  if (nearSpawn(x, z)) return false;
  if (isAirfield(x, z)) return false;
  return true;
}

function canPlacePlant(x, z) {
  const shore = shoreSigned(x, z);
  if (shore < 4 || shore > 45) return false;
  if (heightAt(x, z) < WATER_Y + 0.25) return false;
  if (slopeAt(x, z) > 0.28) return false;
  if (nearSpawn(x, z)) return false;
  if (isAirfield(x, z)) return false;
  return true;
}

function canPlaceRock(x, z) {
  const shore = shoreSigned(x, z);
  if (shore < 1.5) return false;
  if (heightAt(x, z) < WATER_Y + 0.05) return false;
  if (nearSpawn(x, z)) return false;
  if (isAirfield(x, z)) return false;
  if (isOnRoad(x, z, 1.5)) return false; // keep the mud track clear of gray rocks
  return true;
}

function canPlaceCover(x, z) {
  if (shoreSigned(x, z) < 12) return false;
  if (heightAt(x, z) < WATER_Y + 1) return false;
  if (slopeAt(x, z, 2) > 0.1) return false;
  if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < COVER_SPAWN_CLEAR) return false;
  if (isAirfield(x, z)) return false;
  if (isOnRoad(x, z, 3.5)) return false;
  return true;
}

function lowestGround(x, z, radius) {
  let y = heightAt(x, z);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    y = Math.min(y, heightAt(x + Math.cos(a) * radius, z + Math.sin(a) * radius));
  }
  return y;
}

/**
 * @returns {Promise<{
 *   root: THREE.Group,
 *   count: number,
 *   getPalmAmount: () => number,
 *   setPalmAmount: (v: number) => void,
 *   getPlantAmount: () => number,
 *   setPlantAmount: (v: number) => void,
 *   getFoliageBrightness: () => number,
 *   setFoliageBrightness: (v: number) => void,
 *   getWind: () => number,
 *   setWind: (v: number) => void,
 *   update: (time: number) => void,
 * }>}
 */
export async function buildVegetation(scene, { RAPIER, world }) {
  const gltf = await new GLTFLoader().loadAsync('./models/vegetation.glb');
  gltf.scene.updateMatrixWorld(true);

  const nodes = [];
  gltf.scene.traverse((o) => nodes.push(o));

  function findPrefab(name) {
    const sanitized = PropertyBinding.sanitizeNodeName(name);
    return (
      nodes.find((o) => o.userData?.name === name) ||
      nodes.find((o) => o.name === name) ||
      nodes.find((o) => o.name === sanitized) ||
      null
    );
  }

  const foliageMats = new Set();
  const palmLeafMats = new Set();
  const catalog = { tree: [], rock: [], plant: [] };
  for (const [name, meta] of Object.entries(PREFABS)) {
    const src = findPrefab(name);
    if (!src) {
      console.warn(`[vegetation] missing prefab ${name}`);
      continue;
    }
    const extracted = extractPrefab(src, foliageMats, palmLeafMats);
    catalog[meta.kind].push({ name, meta, ...extracted });
  }
  console.info(
    `[vegetation] catalog trees=${catalog.tree.length} rocks=${catalog.rock.length} plants=${catalog.plant.length}`,
  );
  if (!catalog.tree.length || !catalog.rock.length || !catalog.plant.length) {
    throw new Error('[vegetation] incomplete catalog');
  }

  const root = new THREE.Group();
  root.name = 'Vegetation';
  scene.add(root);

  const rand = seededRand(0x7e9a41c3);
  const placed = [];
  const palms = [];
  const plants = [];
  let count = 0;
  let palmAmount = PALM_AMOUNT_DEFAULT;
  let plantAmount = PLANT_AMOUNT_DEFAULT;
  let foliageBrightness = FOLIAGE_BRIGHTNESS_DEFAULT;
  let palmBrightness = PALM_BRIGHTNESS_DEFAULT;
  let windAmp = WIND_DEFAULT;

  function collisionRadius(item, scale) {
    const kind = item.meta.kind;
    const mul = kind === 'tree' ? 0.32 : kind === 'rock' ? 0.48 : 0.22;
    return Math.max(kind === 'plant' ? 0.2 : 0.35, item.radius * scale * mul);
  }

  function placeOne(item, x, z, scaleMul = 1) {
    if (count >= MAX_PLACED) return false;
    const kindScale = item.meta.kind === 'tree' ? TREE_SCALE : 1;
    const scale = GLOBAL_SCALE * kindScale * scaleMul;
    const r = collisionRadius(item, scale);
    if (overlaps(placed, x, z, r)) return false;

    const inst = item.template.clone(true);
    inst.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });

    const yaw = rand() * Math.PI * 2;
    // Rocks: bury 50% of height so they sit in the ground, not float.
    const y =
      item.meta.kind === 'rock'
        ? lowestGround(x, z, r * 0.6) - item.height * scale * 0.5
        : heightAt(x, z);
    inst.position.set(x, y, z);
    inst.rotation.y = yaw;
    inst.scale.setScalar(scale);
    inst.userData.kind = item.meta.kind;
    if (item.meta.kind === 'tree' || item.meta.kind === 'plant') {
      inst.userData.windPhase = rand() * Math.PI * 2;
      inst.userData.yaw = yaw;
    }
    root.add(inst);
    placed.push({ x, z, r });
    count++;
    if (item.meta.kind === 'tree') palms.push(inst);
    if (item.meta.kind === 'plant') plants.push(inst);
    return true;
  }

  function setWind(v) {
    windAmp = THREE.MathUtils.clamp(v, 0, 0.15);
  }

  function update(time) {
    // Lean the whole prefab (trunk + crown / stem + leaves). Don't rotate leaf
    // meshes alone — their local origin isn't at the stem tip.
    const palmLean = windAmp * PALM_WIND_LEAN;
    for (const p of palms) {
      if (!p.visible) continue;
      const ph = p.userData.windPhase ?? 0;
      p.rotation.y = p.userData.yaw ?? p.rotation.y;
      p.rotation.x = Math.sin(time * 0.95 + ph) * palmLean;
      p.rotation.z = Math.sin(time * 1.15 + ph * 1.7) * palmLean * 0.85;
    }
    const plantLean = windAmp * PLANT_WIND_LEAN;
    for (const p of plants) {
      if (!p.visible) continue;
      const ph = p.userData.windPhase ?? 0;
      p.rotation.y = p.userData.yaw ?? p.rotation.y;
      // Slightly faster sway than palms — big leaves catch gusts quicker.
      p.rotation.x = Math.sin(time * 1.35 + ph) * plantLean;
      p.rotation.z = Math.sin(time * 1.55 + ph * 1.9) * plantLean * 0.9;
    }
  }

  function applyPalmVisibility() {
    const show = Math.round(BASE_PALM_TARGET * palmAmount);
    for (let i = 0; i < palms.length; i++) palms[i].visible = i < show;
  }

  function setPalmAmount(v) {
    palmAmount = THREE.MathUtils.clamp(v, 0, 2);
    applyPalmVisibility();
  }

  function applyPlantVisibility() {
    const show = Math.round(BASE_PLANT_TARGET * plantAmount);
    for (let i = 0; i < plants.length; i++) plants[i].visible = i < show;
  }

  function setPlantAmount(v) {
    plantAmount = THREE.MathUtils.clamp(v, 0, 2);
    applyPlantVisibility();
  }

  function applyMatBrightness(mats, mul) {
    for (const m of mats) {
      const base = m.userData.baseColor;
      if (base) m.color.copy(base).multiplyScalar(mul);
    }
  }

  function setFoliageBrightness(v) {
    foliageBrightness = THREE.MathUtils.clamp(v, 0.2, 2.5);
    applyMatBrightness(foliageMats, foliageBrightness);
  }

  function setPalmBrightness(v) {
    palmBrightness = THREE.MathUtils.clamp(v, 0.2, 2.5);
    applyMatBrightness(palmLeafMats, palmBrightness);
  }

  // --- Beach / meadow clusters ---
  const clusterCenters = [];
  let tries = 0;
  while (clusterCenters.length < CLUSTER_COUNT && tries < CLUSTER_COUNT * 40) {
    tries++;
    const ang = rand() * Math.PI * 2;
    const rad = 35 + rand() * 85;
    const x = Math.cos(ang) * rad - 10 + (rand() - 0.5) * 20;
    const z = Math.sin(ang) * rad + (rand() - 0.5) * 20;
    if (Math.abs(x) > HALF - 8 || Math.abs(z) > HALF - 8) continue;
    if (!canPlacePlant(x, z) && !canPlaceTree(x, z)) continue;
    const shore = shoreSigned(x, z);
    if (shore < 6 || shore > 38) continue;
    if (clusterCenters.length < CLUSTER_COUNT * 0.7 && !canPlaceTree(x, z)) continue;
    if (clusterCenters.some((c) => Math.hypot(c.x - x, c.z - z) < 10)) continue;
    clusterCenters.push({ x, z, shore });
  }

  for (const c of clusterCenters) {
    const treeOk = canPlaceTree(c.x, c.z);
    const nTrees = treeOk ? 1 + (rand() < 0.55 ? 1 : 0) : 0;
    const nPlants = 6 + Math.floor(rand() * 10);
    // Rocks are placed as dedicated piles below — not sprinkled into every bush cluster.

    if (nTrees > 0 && canPlaceTree(c.x, c.z) && palms.length < MAX_PALM_TARGET) {
      placeOne(pickWeighted(catalog.tree, rand), c.x, c.z, 0.9 + rand() * 0.25);
    }
    for (let i = 1; i < nTrees && palms.length < MAX_PALM_TARGET; i++) {
      const item = pickWeighted(catalog.tree, rand);
      let placedTree = false;
      for (let attempt = 0; attempt < 8 && !placedTree; attempt++) {
        const jitter = 1.5 + rand() * 3.2;
        const a = rand() * Math.PI * 2;
        const x = c.x + Math.cos(a) * jitter;
        const z = c.z + Math.sin(a) * jitter;
        if (!canPlaceTree(x, z)) continue;
        placedTree = placeOne(item, x, z, 0.85 + rand() * 0.3);
      }
    }

    for (let i = 0; i < nPlants && plants.length < MAX_PLANT_TARGET; i++) {
      const item = pickWeighted(catalog.plant, rand);
      const jitter = 0.6 + rand() * 5.5;
      const a = rand() * Math.PI * 2;
      const x = c.x + Math.cos(a) * jitter * (0.6 + rand() * 0.8);
      const z = c.z + Math.sin(a) * jitter * (0.6 + rand() * 0.8);
      if (!canPlacePlant(x, z)) continue;
      placeOne(item, x, z, 0.75 + rand() * 0.45);
    }
  }

  // Extra palms for the amount slider headroom (up to 2× default).
  let palmTries = 0;
  while (palms.length < MAX_PALM_TARGET && palmTries < MAX_PALM_TARGET * 60) {
    palmTries++;
    const ang = rand() * Math.PI * 2;
    const rad = 40 + rand() * 80;
    const x = Math.cos(ang) * rad - 10 + (rand() - 0.5) * 16;
    const z = Math.sin(ang) * rad + (rand() - 0.5) * 16;
    if (!canPlaceTree(x, z)) continue;
    if (palms.some((p) => Math.hypot(p.position.x - x, p.position.z - z) < 6)) continue;
    placeOne(pickWeighted(catalog.tree, rand), x, z, 0.85 + rand() * 0.3);
  }

  // Extra ground plants for the amount slider headroom (up to 2× default).
  let plantTries = 0;
  while (plants.length < MAX_PLANT_TARGET && plantTries < MAX_PLANT_TARGET * 40) {
    plantTries++;
    const ang = rand() * Math.PI * 2;
    const rad = 28 + rand() * 95;
    const x = Math.cos(ang) * rad - 10 + (rand() - 0.5) * 24;
    const z = Math.sin(ang) * rad + (rand() - 0.5) * 24;
    if (!canPlacePlant(x, z)) continue;
    placeOne(pickWeighted(catalog.plant, rand), x, z, 0.7 + rand() * 0.5);
  }

  // --- Gray-rock outcrops: tight piles, sites spaced far apart ---
  const rockGroupCenters = [];
  let rockTries = 0;
  let rockGroups = 0;
  let rockStoneCount = 0;
  while (rockGroups < ROCK_GROUPS && rockTries < ROCK_GROUPS * 80) {
    rockTries++;
    const x = (rand() * 2 - 1) * (HALF - 10);
    const z = (rand() * 2 - 1) * (HALF - 10);
    if (!canPlaceRock(x, z)) continue;
    const shore = shoreSigned(x, z);
    const slope = slopeAt(x, z);
    // Prefer slopes / inland edges — outcrops, not meadow sprinkle
    if (shore < 8 && slope < 0.1) continue;
    if (rockGroupCenters.some((c) => Math.hypot(c.x - x, c.z - z) < ROCK_GROUP_SPACING)) continue;

    const members = ROCK_GROUP_MEMBERS[0]
      + Math.floor(rand() * (ROCK_GROUP_MEMBERS[1] - ROCK_GROUP_MEMBERS[0] + 1));
    let got = 0;
    for (let i = 0; i < members; i++) {
      const item = pickWeighted(catalog.rock, rand);
      const a = rand() * Math.PI * 2;
      // Pack tight: first stone at centre, rest in a small ring
      const d = i === 0 ? 0 : ROCK_PACK[0] + rand() * (ROCK_PACK[1] - ROCK_PACK[0]);
      const px = x + Math.cos(a) * d;
      const pz = z + Math.sin(a) * d;
      if (!canPlaceRock(px, pz)) continue;
      const base = item.name.includes('002') ? 0.45 + rand() * 0.35 : 0.55 + rand() * 0.55;
      if (placeOne(item, px, pz, base * ROCK_SCALE)) got++;
    }
    if (got >= 3) {
      rockGroupCenters.push({ x, z });
      rockGroups++;
      rockStoneCount += got;
    }
  }

  // --- Big cover rocks: 2–3 boulders per outcrop ---
  const coverRoot = new THREE.Group();
  coverRoot.name = 'CoverRocks';
  scene.add(coverRoot);
  const coverRocks = [];
  const coverGroupCenters = [];
  const crand = seededRand(0x51c0ffee);
  const v = new THREE.Vector3();

  function addCoverRock(item, x, z, scale, yaw) {
    const hx = item.size.x * 0.5 * scale, hz = item.size.z * 0.5 * scale;
    const rockH = item.height * scale;
    // Bury 50% so big cover stones don't float on uneven ground
    const y = lowestGround(x, z, Math.min(hx, hz) * 0.8) - rockH * 0.5;
    const inst = item.template.clone(true);
    inst.position.set(x, y, z);
    inst.rotation.y = yaw;
    inst.scale.setScalar(scale);
    inst.userData.kind = 'cover';
    coverRoot.add(inst);
    inst.updateMatrixWorld(true);

    const pts = [];
    inst.traverse((m) => {
      if (!m.isMesh) return;
      const p = m.geometry.attributes.position;
      const stride = Math.max(1, Math.floor(p.count / 600));
      for (let i = 0; i < p.count; i += stride) {
        v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
        pts.push(v.x - x, v.y - y, v.z - z);
      }
    });
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
    if (hull) world.createCollider(hull.setFriction(0.8), body);

    // Drop undergrowth / pebbles the boulder now swallows.
    const swallow = Math.max(hx, hz);
    for (const c of [...root.children]) {
      if (c.userData.kind === 'tree') continue;
      if (Math.hypot(c.position.x - x, c.position.z - z) >= swallow) continue;
      root.remove(c);
      const i = plants.indexOf(c);
      if (i >= 0) plants.splice(i, 1);
    }
    coverRocks.push({ x, z, y, yaw, hx, hz, r: Math.max(hx, hz), height: item.size.y * scale });
  }

  let coverTries = 0;
  while (coverRocks.length < COVER_ROCKS && coverTries++ < COVER_ROCKS * 100) {
    const cx = (crand() * 2 - 1) * (HALF - 14);
    const cz = (crand() * 2 - 1) * (HALF - 14);
    if (!canPlaceCover(cx, cz)) continue;
    if (coverGroupCenters.some((c) => Math.hypot(c.x - cx, c.z - cz) < COVER_GROUP_SPACING)) continue;
    if (palms.some((p) => Math.hypot(p.position.x - cx, p.position.z - cz) < 7)) continue;

    const want = COVER_GROUP_SIZE[0]
      + Math.floor(crand() * (COVER_GROUP_SIZE[1] - COVER_GROUP_SIZE[0] + 1));
    let got = 0;
    for (let i = 0; i < want && coverRocks.length < COVER_ROCKS; i++) {
      const a = crand() * Math.PI * 2;
      const d = i === 0 ? 0 : COVER_PACK[0] + crand() * (COVER_PACK[1] - COVER_PACK[0]);
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      if (!canPlaceCover(x, z)) continue;
      if (coverRocks.some((r) => Math.hypot(r.x - x, r.z - z) < 3.5)) continue;
      const item = pickWeighted(catalog.rock, crand);
      const targetH = THREE.MathUtils.lerp(COVER_HEIGHT[0], COVER_HEIGHT[1], crand());
      // Slight size variety inside a pile (hero boulder + satellites)
      const sizeMul = i === 0 ? 1 : 0.72 + crand() * 0.22;
      const scale = Math.min(
        (targetH * sizeMul) / item.size.y,
        COVER_MAX_FOOTPRINT / (item.radius * 2),
      );
      addCoverRock(item, x, z, scale, crand() * Math.PI * 2);
      got++;
    }
    if (got > 0) coverGroupCenters.push({ x: cx, z: cz });
  }

  // Palm trunk feet in world space (the crowns lean, so the bbox centre isn't the trunk).
  for (const p of palms) {
    const item = catalog.tree.find((t) => t.name === p.name);
    const b = item?.base ?? new THREE.Vector2();
    const c = Math.cos(p.rotation.y), s = Math.sin(p.rotation.y), k = p.scale.x;
    p.userData.trunk = { x: p.position.x + (b.x * c + b.y * s) * k, z: p.position.z + (-b.x * s + b.y * c) * k };
  }

  /** Solid things the AI should route around: cover rocks + currently visible palm trunks. */
  function navObstacles() {
    const list = coverRocks.map((r) => ({ type: 'box', x: r.x, z: r.z, hx: r.hx * 0.8, hz: r.hz * 0.8, yaw: r.yaw }));
    for (const p of palms) {
      if (p.visible) list.push({ type: 'circle', x: p.userData.trunk.x, z: p.userData.trunk.z, r: PALM_TRUNK_R });
    }
    return list;
  }

  applyPalmVisibility();
  applyPlantVisibility();

  console.info(
    `[vegetation] ${count} instances (` +
      `${palms.length} palms pooled, ${Math.round(BASE_PALM_TARGET * palmAmount)} visible; ` +
      `${plants.length} plants pooled, ${Math.round(BASE_PLANT_TARGET * plantAmount)} visible) + ` +
      `${rockGroups} gray-rock piles (${rockStoneCount} stones) + ` +
      `${coverGroupCenters.length} cover outcrops (${coverRocks.length} boulders)`,
  );

  return {
    root,
    coverRoot,
    coverRocks,
    navObstacles,
    count,
    getPalmAmount: () => palmAmount,
    setPalmAmount,
    getPlantAmount: () => plantAmount,
    setPlantAmount,
    getPalmBrightness: () => palmBrightness,
    setPalmBrightness,
    getFoliageBrightness: () => foliageBrightness,
    setFoliageBrightness,
    getWind: () => windAmp,
    setWind,
    update,
  };
}
