// Shared concrete slab maps (airfield apron + port deck/yard).
// AmbientCG CC0 Concrete047A, 1K JPG downscaled to 256.
// Slabs are 4 m with UVs spanning 0..1. Repeat 0.5 makes one photo cover 8 m.
import * as THREE from 'three';

let maps = null;

function prep(tex, colorSpace) {
  tex.colorSpace = colorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.5, 0.5);
  tex.anisotropy = 8;
  return tex;
}

export async function preloadConcrete() {
  if (maps) return maps;
  const loader = new THREE.TextureLoader();
  const base = './textures/concrete/';
  const [color, normal, rough, ao] = await Promise.all([
    loader.loadAsync(`${base}color.jpg`),
    loader.loadAsync(`${base}normal.jpg`),
    loader.loadAsync(`${base}rough.jpg`),
    loader.loadAsync(`${base}ao.jpg`),
  ]);
  maps = {
    color: prep(color, THREE.SRGBColorSpace),
    normal: prep(normal, THREE.NoColorSpace),
    rough: prep(rough, THREE.NoColorSpace),
    ao: prep(ao, THREE.NoColorSpace),
  };
  return maps;
}

function loadMaps() {
  if (!maps) throw new Error('concrete textures not preloaded');
  return maps;
}

/** Colour, normal, roughness and occlusion for a slab material. Roughness map replaces the flat value. */
export function applyConcreteMaps(mat) {
  const m = loadMaps();
  mat.map = m.color;
  mat.normalMap = m.normal;
  mat.roughnessMap = m.rough;
  mat.roughness = 1;
  mat.aoMap = m.ao;
}

/** Normal maps need tangents. Safe to call on the shared unit box. */
export function prepareSlabGeometry(geo) {
  if (!geo.attributes.tangent) geo.computeTangents();
  return geo;
}
