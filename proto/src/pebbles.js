// Tiny pebbles and stones (pebbles.glb). Instanced, textured with the terrain splat,
// and parked so the mesh centre sits on the lowest ground under the stone:
// half the bounding height is buried, and the downhill lip cannot float.
import * as THREE from 'three/webgpu';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, float, mix, positionWorld, texture, uniform, vec2 } from 'three/tsl';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  SIZE, GROUND_TILE_M, WATER_Y, BRIDGE, PLAYER_SPAWN,
  heightAt, shoreSigned, isOnRoad, isAirfield, isPort, bridgeLocal, groundSurfaceAt,
} from './terrain.js';

/** How many to drop around one anchor, and how far past its edge they may sit (m). */
const SKIRT = {
  cover:  { n: [3, 5], reach: 6.0, pebble: 0.62 },
  rock:   { n: [2, 3], reach: 3.5, pebble: 0.72 },
  palm:   { n: [1, 2], reach: 2.8, pebble: 0.88 },
  plant:  { n: [1, 2], reach: 2.0, pebble: 0.92 },
  wall:   { n: [1, 2], reach: 2.2, pebble: 0.8 },
};

const SPAWN_CLEAR = 8;

function seededRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function lowestGround(x, z, radius) {
  let y = heightAt(x, z);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    y = Math.min(y, heightAt(x + Math.cos(a) * radius, z + Math.sin(a) * radius));
  }
  return y;
}

function canPlace(x, z) {
  if (shoreSigned(x, z) < 2) return false;
  if (heightAt(x, z) < WATER_Y + 0.2) return false;
  if (isAirfield(x, z) || isPort(x, z)) return false;
  if (isOnRoad(x, z, 0.6)) return false;
  if (Math.hypot(x - PLAYER_SPAWN.x, z - PLAYER_SPAWN.z) < SPAWN_CLEAR) return false;
  if (groundSurfaceAt(x, z).concrete > 0.35) return false;
  return true;
}

// Deck plus the approach ramps. Stones are wide enough that the centre can sit
// beside the slab while the mesh still covers the planks.
const BRIDGE_HALF_L = BRIDGE.length * 0.5 + 2;
const BRIDGE_HALF_W = 2.7;

/** False when a stone of this horizontal radius would sit on the bridge. */
function clearsBridge(x, z, radius) {
  const { lx, lz } = bridgeLocal(x, z);
  const along = Math.abs(lx) - BRIDGE_HALF_L;
  const across = Math.abs(lz) - BRIDGE_HALF_W;
  if (along > radius || across > radius) return true;
  if (along <= 0 && across <= 0) return false;
  const ax = Math.max(along, 0);
  const az = Math.max(across, 0);
  return ax * ax + az * az > radius * radius;
}

/** Climb-wall base — structures that aren't in the vegetation anchors. */
function structureAnchors() {
  const out = [];
  // props.js climb wall: centre (−18, 16), 12 m along local Z, yaw 0.3.
  const yaw = 0.3;
  for (let i = -2; i <= 2; i++) {
    const along = i * 2.4;
    out.push({
      x: -18 + Math.sin(yaw) * along,
      z: 16 + Math.cos(yaw) * along,
      r: 0.4,
      kind: 'wall',
    });
  }
  return out;
}

function makeMaterial(sets, concreteColor) {
  const halfTiles = SIZE / (2 * GROUND_TILE_M);
  const mapUv = vec2(
    positionWorld.x.div(GROUND_TILE_M).add(halfTiles),
    positionWorld.z.negate().div(GROUND_TILE_M).add(halfTiles),
  );
  const biome = attribute('biome', 'vec4');
  const shadeWet = attribute('shadeWet', 'vec2');
  const rgb = (tex) => texture(tex).sample(mapUv).rgb;
  const pack = (tex) => texture(tex).sample(mapUv);
  const albedo = rgb(sets.mud.color).mul(biome.x)
    .add(rgb(sets.rock.color).mul(biome.y))
    .add(rgb(sets.sand.color).mul(biome.z));
  const mudS = pack(sets.mud.roughAo);
  const rockS = pack(sets.rock.roughAo);
  const sandS = pack(sets.sand.roughAo);
  const rough = mudS.r.mul(biome.x).add(rockS.r.mul(biome.y)).add(sandS.r.mul(biome.z));
  const ao = mudS.g.mul(biome.x).add(rockS.g.mul(biome.y)).add(sandS.g.mul(biome.z));
  const mat = new MeshStandardNodeMaterial({ metalness: 0, roughness: 1 });
  mat.colorNode = mix(albedo.mul(shadeWet.x), uniform(concreteColor), biome.w);
  const dulled = mix(rough.mul(float(1).sub(shadeWet.y.mul(0.5))), float(1), float(0.5));
  mat.roughnessNode = mix(dulled, float(0.9), biome.w);
  mat.aoNode = mix(ao, float(1), biome.w);
  return mat;
}

function overlaps(placed, x, z, r) {
  for (const p of placed) {
    const dx = p.x - x;
    const dz = p.z - z;
    const min = p.r + r;
    if (dx * dx + dz * dz < min * min) return true;
  }
  return false;
}

/**
 * @param {Array<{ x: number, z: number, r: number, kind: string }>} anchors
 * @param {{ mud: object, rock: object, sand: object }} sets terrain ground textures
 * @param {THREE.Color} concreteColor
 */
export async function buildPebbles(scene, anchors, sets, concreteColor) {
  const gltf = await new GLTFLoader().loadAsync('./models/pebbles.glb');
  const variants = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !/^(Pebble|Stone)_/i.test(o.name)) return;
    const geo = o.geometry.clone();
    geo.computeBoundingBox();
    const center = geo.boundingBox.getCenter(new THREE.Vector3());
    geo.translate(-center.x, -center.y, -center.z);
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    const size = geo.boundingBox.getSize(new THREE.Vector3());
    variants.push({
      name: o.name,
      geo,
      size,
      pebble: !/stone/i.test(o.name),
      recs: [],
    });
  });
  const pebbles = variants.filter((v) => v.pebble);
  const stones = variants.filter((v) => !v.pebble);
  if (!pebbles.length || !stones.length) {
    throw new Error('[pebbles] glb needs both Pebble_* and Stone_* meshes');
  }

  const rand = seededRand(0x5eed01e5);
  const placed = [];
  const all = structureAnchors().concat(anchors);

  function pickMesh(wantPebble) {
    const list = wantPebble ? pebbles : stones;
    return list[(rand() * list.length) | 0];
  }

  function tryPlace(x, z, wantPebble) {
    if (!canPlace(x, z)) return false;
    const variant = pickMesh(wantPebble);
    const base = variant.pebble ? 0.8 + rand() * 0.55 : 0.85 + rand() * 0.4;
    const sx = base * (0.9 + rand() * 0.2);
    const sy = base * (0.85 + rand() * 0.25);
    const sz = base * (0.9 + rand() * 0.2);
    const hx = variant.size.x * 0.5 * sx;
    const hz = variant.size.z * 0.5 * sz;
    const foot = Math.hypot(hx, hz);
    if (!clearsBridge(x, z, foot + 0.3)) return false;
    if (overlaps(placed, x, z, Math.max(0.04, foot * 0.65))) return false;
    const surf = groundSurfaceAt(x, z);
    variant.recs.push({
      x, z,
      y: lowestGround(x, z, foot),
      yaw: rand() * Math.PI * 2,
      sx, sy, sz,
      surf,
    });
    placed.push({ x, z, r: Math.max(0.04, foot * 0.65) });
    return true;
  }

  for (const anchor of all) {
    const skirt = SKIRT[anchor.kind] || SKIRT.rock;
    const n = skirt.n[0] + ((rand() * (skirt.n[1] - skirt.n[0] + 1)) | 0);
    const pockets = Math.min(n, anchor.kind === 'cover' ? 2 + (rand() < 0.5 ? 1 : 0) : 1);
    const arcs = [];
    for (let p = 0; p < pockets; p++) {
      let arc = rand() * Math.PI * 2;
      for (let k = 0; k < 6 && arcs.some((a) => Math.abs(Math.atan2(Math.sin(a - arc), Math.cos(a - arc))) < 0.9); k++) {
        arc = rand() * Math.PI * 2;
      }
      arcs.push(arc);
    }
    const spread = anchor.kind === 'cover' ? 1.15 : 0.75;
    let left = n;
    for (let p = 0; p < pockets && left > 0; p++) {
      const share = p === pockets - 1 ? left : Math.min(left, Math.max(1, Math.round(n / pockets)));
      left -= share;
      for (let i = 0; i < share; i++) {
        let ok = false;
        for (let attempt = 0; attempt < 8 && !ok; attempt++) {
          const a = arcs[p] + (rand() - 0.5) * spread;
          const d = anchor.r * 0.88 + (rand() ** 1.65) * skirt.reach;
          ok = tryPlace(
            anchor.x + Math.cos(a) * d,
            anchor.z + Math.sin(a) * d,
            rand() < skirt.pebble,
          );
        }
      }
    }
  }

  const mat = makeMaterial(sets, concreteColor);
  const root = new THREE.Group();
  root.name = 'Pebbles';
  const dummy = new THREE.Object3D();
  let count = 0;
  for (const variant of variants) {
    const recs = variant.recs;
    if (!recs.length) continue;
    const geo = variant.geo;
    const biome = new THREE.InstancedBufferAttribute(new Float32Array(recs.length * 4), 4);
    const shadeWet = new THREE.InstancedBufferAttribute(new Float32Array(recs.length * 2), 2);
    geo.setAttribute('biome', biome);
    geo.setAttribute('shadeWet', shadeWet);
    const mesh = new THREE.InstancedMesh(geo, mat, recs.length);
    mesh.name = variant.name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      dummy.position.set(r.x, r.y, r.z);
      dummy.rotation.set(0, r.yaw, 0);
      dummy.scale.set(r.sx, r.sy, r.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      biome.setXYZW(i, r.surf.mud, r.surf.rock, r.surf.sand, r.surf.concrete);
      shadeWet.setXY(i, r.surf.shade, r.surf.wet);
    }
    mesh.instanceMatrix.needsUpdate = true;
    biome.needsUpdate = true;
    shadeWet.needsUpdate = true;
    root.add(mesh);
    count += recs.length;
  }
  scene.add(root);
  console.info(`[pebbles] ${count} instanced around ${all.length} anchors`);
  return { root, count };
}
