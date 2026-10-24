// Shared wreck look: rock albedo darkened to burnt metal (tanks, trucks, towers, …).
import * as THREE from 'three';

const BURNT_MAP_URL = './textures/ground/rock_color.jpg';
const BURNT_DARKEN = 0.15;
let _burntMap = null;

function burntMetalMap() {
  if (_burntMap) return _burntMap;
  _burntMap = new THREE.TextureLoader().load(BURNT_MAP_URL);
  _burntMap.colorSpace = THREE.SRGBColorSpace;
  _burntMap.wrapS = _burntMap.wrapT = THREE.RepeatWrapping;
  _burntMap.repeat.set(2.5, 2.5);
  _burntMap.anisotropy = 8;
  return _burntMap;
}

/** Swap every mesh on `root` to the default destruction / burning texture. */
export function applyBurntMetal(root, tint) {
  const burnt = burntMetalMap();
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    const mats = [].concat(o.material).filter(Boolean).map((m) => m.clone());
    o.material = Array.isArray(o.material) ? mats : mats[0];
    for (const m of mats) {
      m.map = burnt;
      m.color.setScalar(BURNT_DARKEN);
      m.metalness = 0.4;
      m.roughness = 0.92;
      m.envMapIntensity = 0.35;
      m.needsUpdate = true;
      if (tint) m.color.multiply(tint);
    }
  });
}
