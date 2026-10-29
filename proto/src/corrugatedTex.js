// Hangar sheet metal. AmbientCG CC0, 1K JPG downscaled to 256.
// Wall = CorrugatedSteel007A, roof = CorrugatedSteel007C.
// One repeat is 4 m, same texel density as the ground maps.
import * as THREE from 'three';

export const STEEL_TILE_M = 4;

const KINDS = {
  wall: './textures/corrugated/wall/',
  roof: './textures/corrugated/roof/',
};

let cache = null;

function prep(tex, colorSpace) {
  tex.colorSpace = colorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function loadKind(base) {
  const loader = new THREE.TextureLoader();
  return {
    color: prep(loader.load(`${base}color.jpg`), THREE.SRGBColorSpace),
    normal: prep(loader.load(`${base}normal.jpg`), THREE.NoColorSpace),
    rough: prep(loader.load(`${base}rough.jpg`), THREE.NoColorSpace),
    ao: prep(loader.load(`${base}ao.jpg`), THREE.NoColorSpace),
    metal: prep(loader.load(`${base}metal.jpg`), THREE.NoColorSpace),
  };
}

function maps() {
  if (cache) return cache;
  cache = {
    wall: loadKind(KINDS.wall),
    roof: loadKind(KINDS.roof),
  };
  return cache;
}

function material(kind) {
  const m = maps()[kind];
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    metalness: 1,
    roughness: 1,
    map: m.color,
    normalMap: m.normal,
    roughnessMap: m.rough,
    aoMap: m.ao,
    metalnessMap: m.metal,
  });
}

export function wallCorrugatedMaterial() {
  return material('wall');
}

export function roofCorrugatedMaterial() {
  return material('roof');
}

/**
 * Tile every face at STEEL_TILE_M using the mesh centre (geometry stays centred).
 * The photo's ribs run with V, so U is horizontal and V is up: stripes stay
 * vertical on walls. Roofs use U along the building and V down the sheet.
 * `mx` mirrors local X (back gable) so the ribs meet the wall underneath.
 */
export function stampCorrugatedUVs(geo, cx, cy, cz, mx = 1, my = 1, mz = 1) {
  const src = geo.index ? geo.toNonIndexed() : geo.clone();
  const pos = src.attributes.position;
  const uvArr = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a));
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const x = cx + pos.getX(i + k) * mx;
      const y = cy + pos.getY(i + k) * my;
      const z = cz + pos.getZ(i + k) * mz;
      let u;
      let v;
      if (ay >= ax && ay >= az) {
        u = x; v = z;
      } else if (ax >= az) {
        u = z; v = y;
      } else {
        u = x; v = y;
      }
      const o = (i + k) * 2;
      uvArr[o] = u / STEEL_TILE_M;
      uvArr[o + 1] = v / STEEL_TILE_M;
    }
  }
  src.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  src.clearGroups();
  const idx = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) idx[i] = i;
  src.setIndex(idx);
  src.computeVertexNormals();
  src.computeTangents();
  return src;
}
