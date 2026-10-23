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

function loadMaps() {
  if (maps) return maps;
  const loader = new THREE.TextureLoader();
  const base = './textures/planks/';
  maps = {
    color: prep(loader.load(`${base}color.jpg`), THREE.SRGBColorSpace),
    normal: prep(loader.load(`${base}normal.jpg`), THREE.NoColorSpace),
    rough: prep(loader.load(`${base}rough.jpg`), THREE.NoColorSpace),
    ao: prep(loader.load(`${base}ao.jpg`), THREE.NoColorSpace),
  };
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
