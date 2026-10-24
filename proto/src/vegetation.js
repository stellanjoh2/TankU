// Stylized tropical vegetation pack (Serhii3D) — clustered along beaches / land.
// Distance LODs come from vegetation_lods.glb (scripts/build_vegetation_lods.py).
// Ground plants and rocks are InstancedMesh batches (one per prefab mesh / LOD).
// Palms stay as skinned clones so each trunk can lean on its own phase.
import * as THREE from 'three';
import { PropertyBinding } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { SIZE, WATER_Y, heightAt, shoreSigned, isOnRoad, isAirfield, isPort, ISLAND2, PLAYER_SPAWN } from './terrain.js';
import { pickLod } from './lod.js';

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
  // Big leaf plants (banana / tall broad leaves). Count is thinned 20% after placement.
  Plant_01: { kind: 'plant', weight: 0.9, big: true },
  Plant_02: { kind: 'plant', weight: 0.9, big: true },
  Plant_03: { kind: 'plant', weight: 1.0, big: true },
  Plant_04: { kind: 'plant', weight: 0.55, big: true },
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
const TREE_SCALE = 1.375; // +10% vs prior 1.25
const PALM_SINK = 0.25; // metres — trunks were floating above the ground
const ROCK_SCALE = 1.5; // 50% larger than previous rock scales
const SPAWN = PLAYER_SPAWN;
const SPAWN_CLEAR = 14;
const HALF = SIZE * 0.5;

/** Palm wind joints: bone 0 = foot (never rotates); shares sum to 1 for upper joints. */
const PALM_BONE_COUNT = 4;
const PALM_BONE_SHARE = [0, 0.22, 0.33, 0.45];

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
/** kg/m³ — light wood; shell / .50 impulses topple a standing trunk in one hit. */
const PALM_DENSITY = 135;
/** .50 cal shove at the impact point (main-gun uses fx IMPACT_IMPULSE after we go dynamic). */
const PALM_MG_IMPULSE = 1800;
/** Hull ram: base tip + per m/s of tank speed (applied once when contact starts). */
const PALM_RAM_BASE = 2200;
const PALM_RAM_PER_SPEED = 380;

/** Visible palms at slider 1.0. −20% from the previous 35. */
export const PALM_AMOUNT_DEFAULT = 1;
const BASE_PALM_TARGET = 28;
const MAX_PALM_TARGET = Math.ceil(BASE_PALM_TARGET * 2);

/** Default visible ground-plant count (+25% vs prior 200). Slider 1.0 = this; pool is 2× for headroom. */
export const PLANT_AMOUNT_DEFAULT = 1;
const BASE_PLANT_TARGET = 250;
const MAX_PLANT_TARGET = Math.ceil(BASE_PLANT_TARGET * 2);

export const FOLIAGE_BRIGHTNESS_DEFAULT = 1;
export const PALM_BRIGHTNESS_DEFAULT = 1;
/** Units match visuals Wind strength (grass sway is off). */
export const WIND_DEFAULT = 0.085;
/** Radians of total palm lean per unit of wind amp (distributed across upper bones). */
const PALM_WIND_LEAN = 1.35;

/**
 * Camera-distance band edges (m): LOD0 < 20, LOD1 < 36, LOD2 < 55, LOD3 beyond.
 * The chase cam sits 7–10 m behind the tank, so LOD0 must cover the player's surroundings.
 */
const LOD_EDGES = [20, 36, 55];
const LOD_LEVELS = LOD_EDGES.length + 1;
/** Big cover boulders are 3–5 m tall, so they step down at twice the distance. */
const COVER_LOD_MUL = 2;
/** Ground plants are fully hidden past this (palms and rocks never cull). */
export const PLANT_CULL_DEFAULT = 50;

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
function setupCutoutMaterial(m, doubleSide) {
  m.transparent = false;
  m.opacity = 1;
  m.depthWrite = true;
  m.depthTest = true;
  m.alphaTest = 0.5;
  m.blending = THREE.NormalBlending;
  // Palm fronds and big leaf cards are double-sided. Smaller foliage stays single-sided.
  m.side = doubleSide ? THREE.DoubleSide : THREE.FrontSide;
  // Ensure map alpha drives the discard (not leftover BLEND state from GLTF).
  if (m.map) {
    m.map.colorSpace = THREE.SRGBColorSpace;
    m.map.premultiplyAlpha = false;
  }
  m.needsUpdate = true;
}

/**
 * Bake a Sketchfab prefab (incl. FBX 0.01 parent scale) into a grounded group at origin.
 * `lodNodes` maps `<mesh>_LOD<n>` → node from vegetation_lods.glb (world transforms match the source).
 * Every mesh gets `userData.lodRange = [min, max]`: it shows while the instance's LOD level is in range.
 */
function extractPrefab(src, foliageMats, palmLeafMats, lodNodes, doubleSideLeaves) {
  src.updateWorldMatrix(true, true);
  const group = new THREE.Group();
  group.name = src.name;
  const lodMeshes = [];

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
        setupCutoutMaterial(m, isPalmLeafMaterial(m) || doubleSideLeaves);
        if (!m.userData.baseColor) m.userData.baseColor = m.color.clone();
        if (isPalmLeafMaterial(m)) palmLeafMats.add(m);
        else foliageMats.add(m);
      } else {
        m.side = THREE.DoubleSide;
      }
    }
    group.add(mesh);

    let prevLevel = 0;
    let prev = mesh;
    for (let lvl = 1; lvl < LOD_LEVELS; lvl++) {
      const node = lodNodes.get(`${child.name}_LOD${lvl}`);
      if (!node) continue;
      prev.userData.lodRange = [prevLevel, lvl - 1];
      const lod = new THREE.Mesh(node.geometry, mesh.material);
      lod.name = node.name;
      lod.castShadow = true;
      lod.receiveShadow = true;
      node.matrixWorld.decompose(lod.position, lod.quaternion, lod.scale);
      lodMeshes.push(lod);
      prevLevel = lvl;
      prev = lod;
    }
    prev.userData.lodRange = [prevLevel, LOD_LEVELS - 1];
  });

  // Bounds / trunk foot from full detail only; LOD meshes are added afterwards with the same offset.
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
  const base = lowVertexCentre(group, 0.5);
  for (const lod of lodMeshes) {
    lod.position.x -= center.x;
    lod.position.z -= center.z;
    lod.position.y -= minY;
    group.add(lod);
  }
  return { template: group, radius, height: size.y, size, base };
}

/** Average XZ of vertices within `maxY` of the ground — a palm's trunk foot, not its leaning crown. */
function lowVertexCentre(group, maxY) {
  const v = new THREE.Vector3();
  let sx = 0, sz = 0, n = 0;
  for (const mesh of group.children) {
    if (!mesh.isMesh && !mesh.isSkinnedMesh) continue;
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

/** Blend each vertex between neighbouring palm bones by height (bone 0 = foot). */
function addPalmSkinAttributes(geometry, height, boneCount) {
  const pos = geometry.attributes.position;
  const n = pos.count;
  const skinIndex = new THREE.BufferAttribute(new Uint16Array(n * 4), 4);
  const skinWeight = new THREE.BufferAttribute(new Float32Array(n * 4), 4);
  const h = Math.max(height, 0.01);
  for (let i = 0; i < n; i++) {
    const t = THREE.MathUtils.clamp(pos.getY(i) / h, 0, 0.999) * (boneCount - 1);
    const i0 = Math.floor(t);
    const i1 = Math.min(i0 + 1, boneCount - 1);
    const f = t - i0;
    skinIndex.setXYZW(i, i0, i1, 0, 0);
    skinWeight.setXYZW(i, 1 - f, f, 0, 0);
  }
  geometry.setAttribute('skinIndex', skinIndex);
  geometry.setAttribute('skinWeight', skinWeight);
}

/**
 * Replace a baked palm group (trunk + leaves meshes) with a skinned rig:
 * bone 0 stays planted; upper bones carry wind lean.
 */
function rigPalmTemplate(template, height) {
  const group = new THREE.Group();
  group.name = template.name;

  const bones = [];
  const spacing = height / (PALM_BONE_COUNT - 1);
  for (let i = 0; i < PALM_BONE_COUNT; i++) {
    const bone = new THREE.Bone();
    bone.name = `PalmBone_${i}`;
    bone.position.y = i === 0 ? 0 : spacing;
    if (i === 0) group.add(bone);
    else bones[i - 1].add(bone);
    bones.push(bone);
  }
  const skeleton = new THREE.Skeleton(bones);
  group.updateMatrixWorld(true);

  for (const child of template.children) {
    if (!child.isMesh) continue;
    const geo = child.geometry.clone();
    child.updateMatrix();
    geo.applyMatrix4(child.matrix);
    addPalmSkinAttributes(geo, height, PALM_BONE_COUNT);
    const sm = new THREE.SkinnedMesh(geo, child.material);
    sm.name = child.name;
    sm.userData.lodRange = child.userData.lodRange;
    sm.castShadow = true;
    sm.receiveShadow = true;
    group.add(sm);
    sm.bind(skeleton);
  }

  group.userData.palmBones = bones;
  return group;
}

function collectPalmBones(root) {
  const bones = [];
  for (let i = 0; i < PALM_BONE_COUNT; i++) {
    let found = null;
    root.traverse((c) => {
      if (c.isBone && c.name === `PalmBone_${i}`) found = c;
    });
    if (found) bones.push(found);
  }
  return bones;
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
  if (isAirfield(x, z) || isPort(x, z)) return false;
  if (isOnRoad(x, z, 1.5)) return false;
  return true;
}

function canPlacePlant(x, z) {
  const shore = shoreSigned(x, z);
  if (shore < 4 || shore > 45) return false;
  if (heightAt(x, z) < WATER_Y + 0.25) return false;
  if (slopeAt(x, z) > 0.28) return false;
  if (nearSpawn(x, z)) return false;
  if (isAirfield(x, z) || isPort(x, z)) return false;
  if (isOnRoad(x, z, 1.5)) return false;
  return true;
}

function canPlaceRock(x, z) {
  const shore = shoreSigned(x, z);
  if (shore < 1.5) return false;
  if (heightAt(x, z) < WATER_Y + 0.05) return false;
  if (nearSpawn(x, z)) return false;
  if (isAirfield(x, z) || isPort(x, z)) return false;
  if (isOnRoad(x, z, 1.5)) return false; // keep the mud track clear of gray rocks
  return true;
}

function canPlaceCover(x, z) {
  if (shoreSigned(x, z) < 12) return false;
  if (heightAt(x, z) < WATER_Y + 1) return false;
  if (slopeAt(x, z, 2) > 0.1) return false;
  if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < COVER_SPAWN_CLEAR) return false;
  if (isAirfield(x, z) || isPort(x, z)) return false;
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
 *   getLodScale: () => number,
 *   setLodScale: (v: number) => void,
 *   getPlantCull: () => number,
 *   setPlantCull: (v: number) => void,
 *   update: (time: number) => void,
 *   sync: () => void,
 *   updateLod: (camPos: THREE.Vector3) => void,
 *   shellHit: (body: object, dir?: THREE.Vector3, point?: THREE.Vector3) => boolean,
 *   mgHit: (body: object, dir?: THREE.Vector3, point?: THREE.Vector3) => boolean,
 *   checkRams: (bodies: object[]) => void,
 *   reset: () => void,
 * }>}
 */
export async function buildVegetation(scene, { RAPIER, world }) {
  const loader = new GLTFLoader();
  const [gltf, lodGltf] = await Promise.all([
    loader.loadAsync('./models/vegetation.glb'),
    loader.loadAsync('./models/vegetation_lods.glb').catch((err) => {
      console.warn('[vegetation] no LOD file, using full detail everywhere', err);
      return null;
    }),
  ]);
  gltf.scene.updateMatrixWorld(true);

  const lodNodes = new Map();
  if (lodGltf) {
    lodGltf.scene.updateMatrixWorld(true);
    lodGltf.scene.traverse((o) => {
      if (o.isMesh) lodNodes.set(o.name, o);
    });
  }

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
    const extracted = extractPrefab(src, foliageMats, palmLeafMats, lodNodes, !!meta.big);
    if (meta.kind === 'tree') {
      extracted.template = rigPalmTemplate(extracted.template, extracted.height);
    }
    catalog[meta.kind].push({
      name, meta, ...extracted, plantRecs: [], rockRecs: [], coverRecs: [],
    });
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
    const kind = item.meta.kind;
    const kindScale = kind === 'tree' ? TREE_SCALE : 1;
    const scale = GLOBAL_SCALE * kindScale * scaleMul;
    const r = collisionRadius(item, scale);
    if (overlaps(placed, x, z, r)) return false;

    const yaw = rand() * Math.PI * 2;
    // Rocks: bury 50% of height so they sit in the ground, not float.
    const y =
      kind === 'rock'
        ? lowestGround(x, z, r * 0.6) - item.height * scale * 0.5
        : heightAt(x, z) - (kind === 'tree' ? PALM_SINK : 0);

    if (kind !== 'tree') {
      const rec = {
        item, x, y, z, yaw, scale, kind,
        windPhase: rand() * Math.PI * 2,
        lod: 0,
        visible: true,
        rotX: 0,
        rotZ: 0,
      };
      if (kind === 'plant') {
        item.plantRecs.push(rec);
        plants.push(rec);
      } else {
        item.rockRecs.push(rec);
      }
      placed.push({ x, z, r });
      count++;
      return true;
    }

    const inst = cloneSkinned(item.template);
    inst.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });
    initLod(inst);

    inst.position.set(x, y, z);
    inst.rotation.y = yaw;
    inst.scale.setScalar(scale);
    inst.userData.kind = kind;
    inst.userData.windPhase = rand() * Math.PI * 2;
    inst.userData.yaw = yaw;
    inst.userData.palmBones = collectPalmBones(inst);
    root.add(inst);
    placed.push({ x, z, r });
    count++;
    palms.push(inst);
    return true;
  }

  const lodInstances = [];

  function initLod(inst) {
    const meshes = [];
    inst.traverse((c) => {
      if (c.isMesh && c.userData.lodRange) meshes.push(c);
    });
    inst.userData.lodMeshes = meshes;
    inst.userData.lod = -2;
    lodInstances.push(inst);
  }

  function setLodLevel(inst, level) {
    if (inst.userData.lod === level) return;
    inst.userData.lod = level;
    for (const m of inst.userData.lodMeshes) {
      const [lo, hi] = m.userData.lodRange;
      m.visible = level >= lo && level <= hi;
    }
  }

  let lodScale = 1;
  let plantCull = PLANT_CULL_DEFAULT;

  const staticBatches = [];
  const plantBatches = [];
  const _dummy = new THREE.Object3D();
  const _m = new THREE.Matrix4();

  function lodMeshesOf(template) {
    const meshes = [];
    template.traverse((c) => {
      if (c.isMesh && c.userData.lodRange) meshes.push(c);
    });
    return meshes;
  }

  function composeRec(rec, local, dst) {
    _dummy.position.set(rec.x, rec.y, rec.z);
    _dummy.rotation.set(rec.rotX, rec.yaw, rec.rotZ);
    _dummy.scale.setScalar(rec.scale);
    _dummy.updateMatrix();
    dst.multiplyMatrices(_dummy.matrix, local);
  }

  /** Drop one instance and swap the tail into its slot. One matrix write. */
  function hidePart(mesh, rec, partIndex) {
    const slot = rec.slots[partIndex];
    if (slot < 0) return;
    const last = mesh.count - 1;
    const slotRec = mesh.userData.slotRec;
    if (slot !== last) {
      const moved = slotRec[last];
      mesh.getMatrixAt(last, _m);
      mesh.setMatrixAt(slot, _m);
      moved.slots[partIndex] = slot;
      slotRec[slot] = moved;
    }
    slotRec[last] = null;
    rec.slots[partIndex] = -1;
    mesh.count = last;
    mesh.visible = last > 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  function showPart(mesh, rec, partIndex) {
    if (rec.slots[partIndex] >= 0) return;
    const slot = mesh.count;
    mesh.userData.slotRec[slot] = rec;
    rec.slots[partIndex] = slot;
    composeRec(rec, mesh.userData.localMatrix, _m);
    mesh.setMatrixAt(slot, _m);
    mesh.count = slot + 1;
    mesh.visible = true;
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Show this record on the LOD parts that should draw it. Other parts are left alone. */
  function syncRec(batch, rec) {
    if (!rec.slots || rec.slots.length !== batch.parts.length) {
      rec.slots = batch.parts.map(() => -1);
    }
    for (let p = 0; p < batch.parts.length; p++) {
      const mesh = batch.parts[p];
      const [lo, hi] = mesh.userData.lodRange;
      const show = !!(rec.visible && rec.lod >= lo && rec.lod <= hi);
      const shown = rec.slots[p] >= 0;
      if (show && !shown) showPart(mesh, rec, p);
      else if (!show && shown) hidePart(mesh, rec, p);
    }
  }

  /** Sphere must cover every record, including ones a later LOD pack leaves out. */
  function sealBounds(batch) {
    for (const mesh of batch.parts) {
      const local = mesh.userData.localMatrix;
      const recs = batch.recs;
      for (let i = 0; i < recs.length; i++) {
        composeRec(recs[i], local, _m);
        mesh.setMatrixAt(i, _m);
      }
      mesh.count = recs.length;
      mesh.computeBoundingSphere();
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 1.5;
      mesh.userData.slotRec = new Array(recs.length);
      mesh.count = 0;
      mesh.visible = false;
    }
  }

  function makeBatch(item, recs, parent, lodMul, castShadow = false) {
    if (!recs.length) return null;
    const parts = [];
    for (const src of lodMeshesOf(item.template)) {
      src.updateMatrix();
      const mesh = new THREE.InstancedMesh(src.geometry, src.material, recs.length);
      mesh.name = `${item.name}:${src.name}`;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.userData.lodRange = src.userData.lodRange.slice();
      mesh.userData.localMatrix = src.matrix.clone();
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      parent.add(mesh);
      parts.push(mesh);
    }
    if (!parts.length) return null;
    const batch = { recs, parts, lodMul };
    staticBatches.push(batch);
    return batch;
  }

  function bakeStatic() {
    for (const item of catalog.plant) {
      const batch = makeBatch(item, item.plantRecs, root, 1, false);
      if (batch) plantBatches.push(batch);
    }
    for (const item of catalog.rock) {
      makeBatch(item, item.rockRecs, root, 1, false);
      makeBatch(item, item.coverRecs, coverRoot, COVER_LOD_MUL, true);
    }
    for (const batch of staticBatches) {
      sealBounds(batch);
      for (const rec of batch.recs) syncRec(batch, rec);
    }
  }

  function dropRec(list, rec) {
    const i = list.indexOf(rec);
    if (i >= 0) list.splice(i, 1);
  }

  /** Cover boulders remove the plants and pebbles they bury. Palms stay. */
  function swallowStatic(x, z, swallow) {
    for (let i = plants.length - 1; i >= 0; i--) {
      const p = plants[i];
      if (Math.hypot(p.x - x, p.z - z) >= swallow) continue;
      plants.splice(i, 1);
      dropRec(p.item.plantRecs, p);
    }
    for (const item of catalog.rock) {
      const recs = item.rockRecs;
      for (let i = recs.length - 1; i >= 0; i--) {
        const p = recs[i];
        if (Math.hypot(p.x - x, p.z - z) >= swallow) continue;
        recs.splice(i, 1);
      }
    }
  }

  /** Level -1 hides every plant past the cull distance. Palms stay per-object. */
  function updateLod(camPos) {
    for (const inst of lodInstances) {
      if (!inst.visible || !inst.parent) continue;
      const d = inst.position.distanceTo(camPos);
      const cur = inst.userData.lod;
      setLodLevel(inst, pickLod(d, LOD_EDGES, lodScale, cur));
    }
    const cullPad = plantCull * 0.05;
    for (const batch of staticBatches) {
      for (const rec of batch.recs) {
        const d = Math.hypot(rec.x - camPos.x, rec.y - camPos.y, rec.z - camPos.z);
        const cur = rec.lod;
        let level;
        if (rec.kind === 'plant' && d > plantCull + (cur === -1 ? -cullPad : cullPad)) {
          level = -1;
        } else {
          level = pickLod(d, LOD_EDGES, lodScale * batch.lodMul, cur);
        }
        if (level !== cur) {
          rec.lod = level;
          syncRec(batch, rec);
        }
      }
    }
  }

  function setWind(v) {
    windAmp = THREE.MathUtils.clamp(v, 0, 0.15);
  }

  function update(time) {
    // Palms: foot bone stays planted; lean is shared across upper trunk/crown bones.
    const palmLean = windAmp * PALM_WIND_LEAN;
    for (const p of palms) {
      if (!p.visible || p.userData.fallen) continue;
      const ph = p.userData.windPhase ?? 0;
      p.rotation.y = p.userData.yaw ?? p.rotation.y;
      p.rotation.x = 0;
      p.rotation.z = 0;
      const bones = p.userData.palmBones;
      if (!bones?.length) continue;
      const leanX = Math.sin(time * 0.95 + ph) * palmLean;
      const leanZ = Math.sin(time * 1.15 + ph * 1.7) * palmLean * 0.85;
      for (let i = 0; i < bones.length; i++) {
        const k = PALM_BONE_SHARE[i] ?? 0;
        bones[i].rotation.x = leanX * k;
        bones[i].rotation.z = leanZ * k;
      }
    }
  }

  function sync() {
    for (const p of palms) {
      if (!p.userData.fallen) continue;
      const body = p.userData.body;
      if (!body) continue;
      p.position.copy(body.translation());
      p.quaternion.copy(body.rotation());
    }
  }

  function applyPalmVisibility() {
    const show = Math.round(BASE_PALM_TARGET * palmAmount);
    for (let i = 0; i < palms.length; i++) {
      const p = palms[i];
      const on = i < show;
      p.visible = on;
      p.userData.collider?.setEnabled(on);
    }
  }

  function setPalmAmount(v) {
    palmAmount = THREE.MathUtils.clamp(v, 0, 2);
    applyPalmVisibility();
  }

  function applyPlantVisibility() {
    const show = Math.round(BASE_PLANT_TARGET * plantAmount);
    for (let i = 0; i < plants.length; i++) {
      // Culled big plants keep their slot so smaller plants don't backfill the gap.
      plants[i].visible = i < show && !plants[i].culled;
    }
    for (const batch of plantBatches) {
      for (const rec of batch.recs) syncRec(batch, rec);
    }
  }

  /** Hide 20% of big-leaf plants, spread evenly so every part of the map thins together. */
  function cullBigPlants() {
    const big = [];
    for (const p of plants) if (p.item.meta.big) big.push(p);
    const remove = Math.round(big.length * 0.2);
    if (remove <= 0) return;
    const step = big.length / remove;
    const used = new Set();
    for (let k = 0; k < remove; k++) {
      let i = Math.min(big.length - 1, Math.floor((k + 0.5) * step));
      while (used.has(i) && i + 1 < big.length) i++;
      if (used.has(i)) continue;
      used.add(i);
      big[i].culled = true;
    }
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

  // Satellite island — the main radial scatter never reaches this far SW.
  let satTries = 0;
  const satWant = 6;
  const satTarget = clusterCenters.length + satWant;
  while (clusterCenters.length < satTarget && satTries < 80) {
    satTries++;
    const ang = rand() * Math.PI * 2;
    const rad = 12 + rand() * (ISLAND2.r - 18);
    const x = ISLAND2.cx + Math.cos(ang) * rad;
    const z = ISLAND2.cz + Math.sin(ang) * rad;
    if (!canPlacePlant(x, z) && !canPlaceTree(x, z)) continue;
    if (clusterCenters.some((c) => Math.hypot(c.x - x, c.z - z) < 8)) continue;
    clusterCenters.push({ x, z, shore: shoreSigned(x, z) });
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
    item.coverRecs.push({
      item, x, y, z, yaw, scale, kind: 'cover',
      windPhase: 0, lod: 0, visible: true, rotX: 0, rotZ: 0,
    });

    _dummy.position.set(x, y, z);
    _dummy.rotation.set(0, yaw, 0);
    _dummy.scale.setScalar(scale);
    _dummy.updateMatrix();

    const pts = [];
    for (const src of lodMeshesOf(item.template)) {
      if (src.userData.lodRange?.[0] > 0) continue;
      src.updateMatrix();
      _m.multiplyMatrices(_dummy.matrix, src.matrix);
      const p = src.geometry.attributes.position;
      const stride = Math.max(1, Math.floor(p.count / 600));
      for (let i = 0; i < p.count; i += stride) {
        v.fromBufferAttribute(p, i).applyMatrix4(_m);
        pts.push(v.x - x, v.y - y, v.z - z);
      }
    }
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
    if (hull) world.createCollider(hull.setFriction(0.8), body);

    // Drop undergrowth / pebbles the boulder now swallows.
    swallowStatic(x, z, Math.max(hx, hz));
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
  // Fixed cylinder colliders so shells / .50 can hit; knockPalm turns them dynamic.
  const palmByHandle = new Map();
  const _palmQ = new THREE.Quaternion();
  const _palmYaw = new THREE.Vector3(0, 1, 0);
  for (const p of palms) {
    const item = catalog.tree.find((t) => t.name === p.name);
    const b = item?.base ?? new THREE.Vector2();
    const yaw = p.userData.yaw ?? p.rotation.y;
    const c = Math.cos(yaw), s = Math.sin(yaw), k = p.scale.x;
    p.userData.trunk = { x: p.position.x + (b.x * c + b.y * s) * k, z: p.position.z + (-b.x * s + b.y * c) * k };
    const h = Math.max(2, (item?.height ?? 8) * k);
    const halfH = h * 0.5;
    _palmQ.setFromAxisAngle(_palmYaw, yaw);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(p.position.x, p.position.y, p.position.z)
        .setRotation(_palmQ)
        .setLinearDamping(0.15)
        .setAngularDamping(0.3)
        .setCcdEnabled(true)
        .setUserData({ palm: true }),
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cylinder(halfH, PALM_TRUNK_R)
        .setTranslation(b.x * k, halfH, b.y * k)
        .setDensity(PALM_DENSITY)
        .setFriction(0.75)
        .setRestitution(0.05),
      body,
    );
    p.userData.body = body;
    p.userData.collider = collider;
    p.userData.fallen = false;
    p.userData.spawnPos = p.position.clone();
    p.userData.spawnYaw = yaw;
    palmByHandle.set(body.handle, p);
  }

  function zeroPalmBones(p) {
    const bones = p.userData.palmBones;
    if (!bones) return;
    for (const bone of bones) {
      bone.rotation.x = 0;
      bone.rotation.z = 0;
    }
  }

  /** Stand → fall: fixed collider becomes a dynamic trunk that reacts to impulses. */
  function knockPalm(p, dir, point, impulse) {
    const body = p.userData.body;
    if (!body) return;
    if (!p.userData.fallen) {
      p.userData.fallen = true;
      zeroPalmBones(p);
      body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    }
    if (impulse > 0 && dir && point) {
      body.applyImpulseAtPoint(
        dir.clone().multiplyScalar(impulse),
        point,
        true,
      );
    }
  }

  function shellHit(hitBody, dir, point) {
    const p = palmByHandle.get(hitBody?.handle);
    if (!p || !p.visible) return false;
    // Impulse comes from fx._explode (IMPACT_IMPULSE) once the body is dynamic.
    knockPalm(p, dir, point, 0);
    return true;
  }

  function mgHit(hitBody, dir, point) {
    const p = palmByHandle.get(hitBody?.handle);
    if (!p || !p.visible) return false;
    knockPalm(p, dir, point, PALM_MG_IMPULSE);
    return true;
  }

  const _ramDir = new THREE.Vector3();
  const _ramPoint = new THREE.Vector3();
  const _ramBodies = [];
  const RAM_REACH_SQ = 10 * 10;

  /** After world.step: a tank hull touching a standing palm knocks it over. */
  function checkRams(bodies) {
    if (!bodies?.length) return;
    _ramBodies.length = 0;
    for (const b of bodies) if (b) _ramBodies.push(b);
    if (!_ramBodies.length) return;
    for (const p of palms) {
      if (!p.visible || p.userData.fallen) continue;
      const col = p.userData.collider;
      if (!col) continue;
      const px = p.position.x;
      const pz = p.position.z;
      let close = false;
      for (const b of _ramBodies) {
        const t = b.translation();
        const dx = px - t.x;
        const dz = pz - t.z;
        if (dx * dx + dz * dz < RAM_REACH_SQ) { close = true; break; }
      }
      if (!close) continue;
      let rammer = null;
      world.contactPairsWith(col, (other) => {
        const ob = other.parent();
        if (!ob) return;
        for (const b of _ramBodies) {
          if (b.handle === ob.handle) rammer = ob;
        }
      });
      if (!rammer) continue;
      const vel = rammer.linvel();
      const speed = Math.hypot(vel.x, vel.y, vel.z);
      const dir = _ramDir;
      dir.set(vel.x, Math.max(0, vel.y * 0.2), vel.z);
      if (dir.lengthSq() < 0.35) {
        const t = rammer.translation();
        dir.set(p.position.x - t.x, 0.08, p.position.z - t.z);
      }
      if (dir.lengthSq() < 1e-6) continue;
      dir.normalize();
      const trunk = p.userData.trunk;
      const point = _ramPoint;
      point.set(trunk.x, p.position.y + 1.25, trunk.z);
      knockPalm(p, dir, point, PALM_RAM_BASE + PALM_RAM_PER_SPEED * Math.max(speed, 1.2));
    }
  }

  function reset() {
    for (const p of palms) {
      const body = p.userData.body;
      if (!body) continue;
      const pos = p.userData.spawnPos;
      const yaw = p.userData.spawnYaw ?? 0;
      _palmQ.setFromAxisAngle(_palmYaw, yaw);
      p.userData.fallen = false;
      p.position.copy(pos);
      p.rotation.set(0, yaw, 0);
      p.userData.yaw = yaw;
      zeroPalmBones(p);
      body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      body.setTranslation(pos, true);
      body.setRotation(_palmQ, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    applyPalmVisibility();
  }

  /** Solid things the AI should route around: cover rocks + currently visible palm trunks. */
  function navObstacles() {
    const list = coverRocks.map((r) => ({ type: 'box', x: r.x, z: r.z, hx: r.hx * 0.8, hz: r.hz * 0.8, yaw: r.yaw }));
    for (const p of palms) {
      if (p.visible && !p.userData.fallen) {
        list.push({ type: 'circle', x: p.userData.trunk.x, z: p.userData.trunk.z, r: PALM_TRUNK_R });
      }
    }
    return list;
  }

  cullBigPlants();
  applyPalmVisibility();
  applyPlantVisibility();
  bakeStatic();

  const pebbleAnchors = [];
  for (const item of catalog.rock) {
    for (const rec of item.rockRecs) {
      pebbleAnchors.push({
        x: rec.x, z: rec.z,
        r: Math.max(0.3, item.radius * rec.scale * 0.55),
        kind: 'rock',
      });
    }
    for (const rec of item.coverRecs) {
      pebbleAnchors.push({
        x: rec.x, z: rec.z,
        r: Math.max(item.size.x, item.size.z) * 0.5 * rec.scale * 0.92,
        kind: 'cover',
      });
    }
  }
  for (const p of palms) {
    if (!p.visible) continue;
    const t = p.userData.trunk;
    if (!t) continue;
    pebbleAnchors.push({ x: t.x, z: t.z, r: 0.42, kind: 'palm' });
  }
  for (const rec of plants) {
    if (!rec.visible || rec.culled) continue;
    if (!rec.item.name.startsWith('Bush') && !rec.item.meta.big) continue;
    // About half the bushes — pebbles at every stem would read as gravel.
    if (Math.abs(Math.sin(rec.x * 12.9898 + rec.z * 78.233)) > 0.5) continue;
    pebbleAnchors.push({
      x: rec.x, z: rec.z,
      r: THREE.MathUtils.clamp(rec.item.radius * rec.scale * 0.22, 0.18, 0.55),
      kind: 'plant',
    });
  }

  console.info(
    `[vegetation] ${count} placed (` +
      `${palms.length} palms pooled, ${Math.round(BASE_PALM_TARGET * palmAmount)} visible; ` +
      `${plants.length} plants instanced, ${Math.round(BASE_PLANT_TARGET * plantAmount)} visible) + ` +
      `${rockGroups} gray-rock piles (${rockStoneCount} stones, instanced) + ` +
      `${coverGroupCenters.length} cover outcrops (${coverRocks.length} boulders, instanced)`,
  );

  return {
    root,
    coverRoot,
    coverRocks,
    pebbleAnchors,
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
    getLodScale: () => lodScale,
    setLodScale: (v) => { lodScale = THREE.MathUtils.clamp(v, 0.25, 50); },
    getPlantCull: () => plantCull,
    setPlantCull: (v) => { plantCull = THREE.MathUtils.clamp(v, 10, 1000); },
    update,
    sync,
    updateLod,
    shellHit,
    mgHit,
    checkRams,
    reset,
  };
}
