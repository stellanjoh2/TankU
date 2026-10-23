// Distant backdrop islands flanking ShipEast (north + south), leaving the ship's silhouette
// against open sea. Visual only — no collider, no vegetation. Polar mesh so the coastline
// is resolved with very few triangles.
import * as THREE from 'three/webgpu';
import { uniform, vec4, mix, smoothstep, positionView } from 'three/tsl';
import { WATER_Y } from './terrain.js';

// Same mesh twice. Long axis runs east–west; yaw turns each bay to face the channel by the ship.
const PLACEMENTS = [
  { name: 'BgIslandNorth', x: 300, z: -400, yaw: Math.PI / 2 },
  { name: 'BgIslandSouth', x: 300, z: 400, yaw: -Math.PI / 2 },
];
const SCALE = 1.5;
const SCALE_X = SCALE;
const SCALE_Z = SCALE * 1.45; // elongated along the local long axis
const ANG_SEGS = 64;
// Normalised radius (1 = shoreline). Dense near the coast for the beach band, last ring sinks under water.
const RINGS = [0.2, 0.36, 0.5, 0.6, 0.7, 0.78, 0.85, 0.9, 0.95, 1.0, 1.07, 1.22];

// Scene fog saturates at ~150 m, which would erase the island; it gets a stretched, capped haze instead.
const FOG_STRETCH = 3.5;
const FOG_MAX = 0.85;

// Local hills: [x, z, height, radius] in unscaled island metres.
const HILLS = [[25, -45, 20, 22], [-5, 55, 16, 20], [45, 20, 18, 16], [-30, -20, 10, 18]];

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Shore radius by angle — hero C shape mirrored so the bay opens west, towards the player. */
function shoreR(ang) {
  const bay = Math.max(0, -Math.cos(ang));
  const carve = bay * bay * (44 + 9 * Math.sin(ang * 3.0 + 1.2));
  const noise =
    7.0 * Math.sin(ang * 4.7 + 2.1) +
    3.4 * Math.sin(ang * 10.0 - 0.4) +
    1.8 * Math.sin(ang * 17.0 + 0.9);
  return 100 - carve + noise;
}

function heightAt(ang, t, lx, lz) {
  if (t > 1) return WATER_Y - 0.8 - Math.min(10, (t - 1) * 40);

  const inland = clamp01((1 - t) / 0.22);
  let h =
    3.0 * Math.sin(lx * 0.025 + 1.1) * Math.cos(lz * 0.021 - 0.6) +
    1.6 * Math.sin(lx * 0.05 + 0.3) * Math.sin(lz * 0.044 + 1.7);
  for (const [cx, cz, hh, rad] of HILLS) {
    h += hh * Math.exp(-((lx - cx) ** 2 + (lz - cz) ** 2) / (rad * rad));
  }
  // Mountain spine on the far (east) side, behind the bay
  const away = clamp01((Math.cos(ang) + 0.4) / 1.2);
  const jagged = 1 + 0.45 * Math.sin(ang * 6.0 + 0.3) + 0.25 * Math.sin(ang * 13.0 - 1.0);
  h += away * Math.exp(-((t - 0.5) ** 2) / (0.2 * 0.2)) * jagged * 36;

  const beach = clamp01((1 - t) / 0.08);
  return 0.35 + beach * 1.4 + Math.max(0, h) * Math.pow(inland, 1.35);
}

/**
 * @param {THREE.Scene} scene
 * @param {{ palette: Record<string, THREE.Color>, onPaletteChange: (fn: () => void) => void }} terrain
 */
export function buildBgIsland(scene, terrain) {
  const ringCount = RINGS.length;
  const vertCount = 1 + ringCount * ANG_SEGS;
  const positions = new Float32Array(vertCount * 3);
  const shore = new Float32Array(vertCount); // normalised radius per vertex, for colouring
  positions[1] = heightAt(0, 0, 0, 0);

  for (let r = 0; r < ringCount; r++) {
    const t = RINGS[r];
    for (let a = 0; a < ANG_SEGS; a++) {
      const ang = (a / ANG_SEGS) * Math.PI * 2;
      const rad = t * shoreR(ang);
      const lx = Math.cos(ang) * rad;
      const lz = Math.sin(ang) * rad;
      const i = 1 + r * ANG_SEGS + a;
      positions.set([lx * SCALE_X, heightAt(ang, t, lx, lz) * SCALE, lz * SCALE_Z], i * 3);
      shore[i] = t;
    }
  }

  const index = [];
  for (let a = 0; a < ANG_SEGS; a++) {
    const b = (a + 1) % ANG_SEGS;
    index.push(0, 1 + b, 1 + a);
  }
  for (let r = 0; r < ringCount - 1; r++) {
    const i0 = 1 + r * ANG_SEGS, i1 = i0 + ANG_SEGS;
    for (let a = 0; a < ANG_SEGS; a++) {
      const b = (a + 1) % ANG_SEGS;
      index.push(i0 + a, i0 + b, i1 + a, i0 + b, i1 + b, i1 + a);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();

  const nrm = geo.attributes.normal;
  const colors = new Float32Array(vertCount * 3);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  geo.setAttribute('color', colorAttr);
  const c = new THREE.Color();

  function applyPalette() {
    const { grass, dry, dirt, sand, wetSand, rock } = terrain.palette;
    for (let i = 0; i < vertCount; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const t = shore[i];
      const slope = 1 - nrm.getY(i);
      const patch = 0.5 + 0.5 * Math.sin(x * 0.05 + Math.sin(z * 0.04) * 2.0) * Math.cos(z * 0.045);
      if (y < WATER_Y + 0.05 || t >= 1) {
        c.copy(wetSand);
      } else if (t > 0.88) {
        c.copy(wetSand).lerp(sand, 0.35 + 0.65 * clamp01((1 - t) / 0.12));
      } else {
        const rocky = clamp01(slope * 2.8 + y * 0.02 - 0.2);
        c.copy(grass).lerp(dry, patch * 0.4);
        c.lerp(dirt, clamp01(slope * 2.5) * 0.25);
        c.lerp(rock, rocky);
      }
      if (y < WATER_Y) c.multiplyScalar(0.65);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    colorAttr.needsUpdate = true;
  }
  applyPalette();
  terrain.onPaletteChange(applyPalette);

  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.97 });
  const fogColor = uniform(scene.fog.color);
  const fogNear = uniform(scene.fog.near).onRenderUpdate(() => scene.fog.near);
  const fogFar = uniform(scene.fog.far).onRenderUpdate(() => scene.fog.far * FOG_STRETCH);
  mat.setupFog = (builder, outputNode) => {
    const f = smoothstep(fogNear, fogFar, positionView.length()).mul(FOG_MAX);
    return vec4(mix(outputNode.rgb, fogColor, f), outputNode.a);
  };

  const root = new THREE.Group();
  root.name = 'BgIslands';
  for (const p of PLACEMENTS) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = p.name;
    mesh.position.set(p.x, 0, p.z);
    mesh.rotation.y = p.yaw;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    root.add(mesh);
  }
  scene.add(root);
  return { root };
}
