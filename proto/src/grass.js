// FluffyGrass-style billboard clumps scattered on our terrain.
// Assets: https://github.com/thebenezer/FluffyGrass (MIT)
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GrassMaterial } from './GrassMaterial.js';
import { SIZE, heightAt, isGrassable } from './terrain.js';
import { pickLod } from './lod.js';

// 16 m chunks so LOD bands (measured to the nearest chunk edge) stay meaningful.
const CHUNK = 16;
/**
 * Band edges (m) from camera to chunk edge. Bands 0–2 pick LOD00/01/02 geometry;
 * the outer bands keep LOD02 and only thin the clump count (BAND_DENSITY).
 */
const LOD_EDGES = [25, 50, 85, 120];
const BAND_DENSITY = [1, 1, 1, 0.85, 0.72];
const DENSITY = 0.828; // clumps per m² on meadows (−10% vs 0.92)
// LOD00 native height ≈ 0.14 m; ~0.5–1.0 m after scale (+15% vs prior 5.4).
const BASE_SCALE = 6.21;
const HALF = SIZE * 0.5;

function hash2(ix, iz) {
  const n = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Low-frequency patchiness: short meadows vs slightly taller patches. */
function heightMulAt(x, z) {
  const a = 0.5 + 0.5 * Math.sin(x * 0.028 + 0.7) * Math.cos(z * 0.024 - 0.3);
  const b = 0.5 + 0.5 * Math.sin(x * 0.011 + z * 0.009);
  const patch = a * 0.65 + b * 0.35;
  // 0.55 … 1.25 → roughly 0.4 m … 0.85 m after BASE_SCALE
  return 0.55 + patch * 0.7;
}

function seededRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * @returns {{ root: THREE.Group, update: (t: number) => void, updateLod: (camPos: THREE.Vector3) => void }}
 */
export async function buildGrass(scene) {
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();

  const [gltf, grassAlpha, noise] = await Promise.all([
    loader.loadAsync('./grass/grassLODs.glb'),
    texLoader.loadAsync('./grass/grass.jpeg'),
    texLoader.loadAsync('./grass/perlinnoise.webp'),
  ]);

  const lodGeos = [];
  gltf.scene.traverse((child) => {
    if (!child.isMesh) return;
    const m = /LOD(\d+)/.exec(child.name);
    if (m) lodGeos[Number(m[1])] = child.geometry;
  });
  if (!lodGeos[0]) throw new Error('grassLODs.glb: missing LOD00');
  for (let i = 1; i < lodGeos.length; i++) lodGeos[i] ??= lodGeos[i - 1];

  const grassMat = new GrassMaterial({
    baseColor: '#354820',
    tipColor1: '#a8c45c',
    tipColor2: '#5a7838',
    heightAmp: 0.07,
    terrainSize: SIZE,
    fogColor: new THREE.Color(0.55, 0.68, 0.74),
    fogNear: 70,
    fogFar: 240,
  });
  grassMat.setupTextures(grassAlpha, noise);

  const root = new THREE.Group();
  root.name = 'FluffyGrass';
  scene.add(root);

  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const qSpin = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const eul = new THREE.Euler();

  const nChunks = Math.ceil(SIZE / CHUNK);
  const origin = -HALF;
  let total = 0;
  const chunks = [];

  for (let cz = 0; cz < nChunks; cz++) {
    for (let cx = 0; cx < nChunks; cx++) {
      const x0 = origin + cx * CHUNK;
      const z0 = origin + cz * CHUNK;
      const x1 = Math.min(x0 + CHUNK, HALF);
      const z1 = Math.min(z0 + CHUNK, HALF);
      const w = x1 - x0;
      const d = z1 - z0;
      if (w <= 0 || d <= 0) continue;

      const cxm = x0 + w * 0.5;
      const czm = z0 + d * 0.5;
      if (!isGrassable(cxm, czm) && !isGrassable(cxm + w * 0.25, czm) && !isGrassable(cxm, czm + d * 0.25)) {
        // Cheap reject: skip chunks that are clearly water/beach/rock
        let any = false;
        for (let s = 0; s < 4 && !any; s++) {
          any = isGrassable(x0 + ((s % 2) + 0.5) * w * 0.5, z0 + ((s >> 1) + 0.5) * d * 0.5);
        }
        if (!any) continue;
      }

      const dist = Math.hypot(cxm + 8, czm + 5);
      const dens = DENSITY * (0.55 + 0.45 * THREE.MathUtils.clamp(1 - dist / 90, 0.35, 1));
      const capacity = Math.max(0, Math.floor(w * d * dens));
      if (capacity < 8) continue;

      const mesh = new THREE.InstancedMesh(lodGeos[0], grassMat.material, capacity);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.frustumCulled = true;

      const rand = seededRand((cx * 73856093) ^ (cz * 19349663) ^ 0x9e3779b9);
      let written = 0;
      const tries = capacity * 4;
      for (let t = 0; t < tries && written < capacity; t++) {
        const x = x0 + rand() * w;
        const z = z0 + rand() * d;
        if (!isGrassable(x, z)) continue;

        const y = heightAt(x, z);
        pos.set(x, y, z);

        const e = 0.6;
        normal
          .set(
            heightAt(x - e, z) - heightAt(x + e, z),
            2 * e,
            heightAt(x, z - e) - heightAt(x, z + e),
          )
          .normalize();
        quat.setFromUnitVectors(yAxis, normal);
        eul.set(0, rand() * Math.PI * 2, 0);
        qSpin.setFromEuler(eul);
        quat.multiply(qSpin);

        const hm = heightMulAt(x, z);
        const jitter = 0.88 + hash2(Math.floor(x * 3), Math.floor(z * 3)) * 0.28;
        const sy = BASE_SCALE * hm * jitter;
        const sxz = BASE_SCALE * (0.9 + rand() * 0.2);
        scale.set(sxz, sy, sxz);

        matrix.compose(pos, quat, scale);
        mesh.setMatrixAt(written++, matrix);
      }

      if (written === 0) continue;

      mesh.count = written;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      // Pad so tip height doesn't get frustum-culled at edges
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 1.5;
      root.add(mesh);
      // Instances are written in random order, so any prefix is an even thinning of the chunk.
      chunks.push({ mesh, x0, z0, x1, z1, y: heightAt(cxm, czm), full: written, band: -1 });
      total += written;
    }
  }

  console.info(`[grass] ${total.toLocaleString()} clumps across ${root.children.length} chunks`);

  let lodScale = 1;

  function updateLod(camPos) {
    for (const c of chunks) {
      const dx = Math.max(c.x0 - camPos.x, 0, camPos.x - c.x1);
      const dz = Math.max(c.z0 - camPos.z, 0, camPos.z - c.z1);
      const d = Math.hypot(dx, dz, camPos.y - c.y);
      const band = pickLod(d, LOD_EDGES, lodScale, c.band);
      if (band === c.band) continue;
      c.band = band;
      c.mesh.geometry = lodGeos[Math.min(band, lodGeos.length - 1)];
      c.mesh.count = Math.max(1, Math.round(c.full * BAND_DENSITY[band]));
    }
  }

  return {
    root,
    material: grassMat,
    update() {
      grassMat.update();
    },
    updateLod,
    getLodScale: () => lodScale,
    setLodScale(v) {
      lodScale = THREE.MathUtils.clamp(v, 0.25, 50);
    },
    setColors({ base, tip1, tip2, intensity } = {}) {
      if (base != null) grassMat.uniforms.uBaseColor.value.set(base);
      if (tip1 != null) grassMat.uniforms.uTipColor1.value.set(tip1);
      if (tip2 != null) grassMat.uniforms.uTipColor2.value.set(tip2);
      if (intensity != null) grassMat.uniforms.uGrassLightIntensity.value = intensity;
    },
    setFog(color, near, far) {
      if (color != null) grassMat.uniforms.fogColor.value.set(color);
      if (near != null) grassMat.uniforms.fogNear.value = near;
      if (far != null) grassMat.uniforms.fogFar.value = far;
    },
  };
}
