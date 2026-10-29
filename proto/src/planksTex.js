// AmbientCG CC0 Planks023B, 1K JPG downscaled to 512.
// Mesh UVs are world metres / 2: U across the road (plank length), V along the span.
import * as THREE from 'three';

let maps = null;

function prep(tex, colorSpace) {
  tex.colorSpace = colorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export async function preloadPlanks() {
  if (maps) return maps;
  const loader = new THREE.TextureLoader();
  const base = './textures/planks/';
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
  if (!maps) throw new Error('planks textures not preloaded');
  return maps;
}

export function applyPlankMaps(mat) {
  const m = loadMaps();
  mat.map = m.color;
  mat.normalMap = m.normal;
  mat.roughnessMap = m.rough;
  mat.roughness = 1;
  mat.aoMap = m.ao;
}
