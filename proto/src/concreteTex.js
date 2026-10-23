// Shared concrete slab texture (airfield apron + port deck/yard).
import * as THREE from 'three';

let tex = null;

/** One tile per slab face: slabs are scaled unit boxes, so UVs span 0..1 per face. */
export function concreteSlabMap() {
  if (!tex) {
    tex = new THREE.TextureLoader().load('./textures/concrete_slab.jpg');
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
  }
  return tex;
}
