// Engine heat shimmer — soft blob above the rear deck that refracts the backdrop.
// Rising Perlin offsets screen UVs; strength falls to zero at the rim so the quad never shows.
import * as THREE from 'three/webgpu';
import {
  time, uv, vec2, float, smoothstep, length, uniform,
  viewportSharedTexture, viewportSafeUV, screenUV,
  mx_noise_float, billboarding,
} from 'three/tsl';

/**
 * Camera-facing heat haze card, meant as a child of the tank model.
 * Hull local: +X forward — sits over the engine grille / exhaust deck.
 */
export function createEngineHeatHaze({
  local = new THREE.Vector3(-2.05, 2.6, 0),
  // +25% vs old 1.54×1.925 — player-only, so spend the fill on a bigger shimmer.
  width = 1.925,
  height = 2.40625,
  strength = 0.0128,
} = {}) {
  const mat = new THREE.MeshBasicNodeMaterial({
    color: new THREE.Color(0, 0, 0),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    lights: false,
  });

  // Soft ellipse — no hard plane edge
  const p = uv().sub(0.5).mul(vec2(2.1, 1.55));
  const blob = float(1).sub(smoothstep(0.2, 1.0, length(p)));

  const strengthU = uniform(strength);
  // One rising Perlin octave (was two) — half the noise taps, still reads as heat.
  const t = time;
  const nUv = uv().mul(vec2(2.6, 2.0)).add(vec2(0, t.mul(-0.78125)));
  const nx = mx_noise_float(nUv);
  const ny = mx_noise_float(nUv.add(13.7));
  const offset = vec2(nx, ny.mul(0.55)).mul(strengthU).mul(blob);

  mat.backdropNode = viewportSharedTexture(viewportSafeUV(screenUV.add(offset)));
  // Upright billboard — always reads as a heat column from the chase cam / freefly
  mat.vertexNode = billboarding({ horizontalRotation: true });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
  mesh.position.copy(local);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 6;
  mesh.name = 'EngineHeatHaze';
  mesh.userData.heatStrength = strengthU;
  return mesh;
}
