// Camera-centred FFT ocean mesh. WebGPU port of Ultra-Water (MIT, Copyright (c) 2026 Humpalumps).
import {
  BufferAttribute, BufferGeometry, Color, FrontSide, Mesh, NoColorSpace, NodeMaterial, Vector2, Vector3, Vector4,
} from 'three/webgpu';
import {
  Fn, cameraPosition, cameraViewMatrix, float, frontFacing, length, max, positionLocal, positionView,
  positionWorld, screenUV, select, texture, uniform, varying, vec2, vec3, viewportDepthTexture,
  viewportSharedTexture, wgslFn, cubeTexture,
} from 'three/tsl';
import { OceanSim } from './OceanSim.js';
import { WATER_PRESETS, oceanParamsFrom } from './oceanParams.js';
import { bakeFoamTexture } from './foam.js';
import { DISPLACE_WGSL, SHADE_WGSL } from './waterWgsl.js';
import { createSurfaceHeight } from './surfaceHeight.js';
import { bindOceanHeight } from '../waves.js';

const ANGULAR = 128;
const HIGH_CAMERA = 35;
const INNER = 1;
const OUTER = 3000;
const SKIRT = 60000;

function buildGrid(angular) {
  const q = 1 + (2 * Math.PI) / angular;
  const radii = [];
  for (let r = INNER / 16; r < INNER * 0.99; r *= 1.12) radii.push(r);
  for (let r = INNER; r < OUTER; r *= q) radii.push(r);
  radii.push(SKIRT);
  const verts = new Float32Array((1 + radii.length * angular) * 3);
  let v = 3;
  for (const r of radii) {
    for (let a = 0; a < angular; a++) {
      const t = (a / angular) * Math.PI * 2;
      verts[v++] = Math.cos(t) * r;
      verts[v++] = 0;
      verts[v++] = Math.sin(t) * r;
    }
  }
  const idx = [];
  for (let a = 0; a < angular; a++) idx.push(0, 1 + ((a + 1) % angular), 1 + a);
  for (let ring = 0; ring < radii.length - 1; ring++) {
    const i0 = 1 + ring * angular;
    const i1 = i0 + angular;
    for (let a = 0; a < angular; a++) {
      const b = (a + 1) % angular;
      idx.push(i0 + a, i0 + b, i1 + a, i0 + b, i1 + b, i1 + a);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(verts, 3));
  geo.setIndex(new BufferAttribute(new Uint32Array(idx), 1));
  return geo;
}

function specKey(p) {
  return [p.windSpeed, p.windDirection, p.fetchKm, p.waveScale, p.spreadBlend, p.swellScale, p.swellDirection].join('|');
}

export function createUltraWater(renderer, { shore, skyCube, seaY }) {
  const sim = new OceanSim(renderer);
  const params = oceanParamsFrom();
  const foamTex = bakeFoamTexture(512);
  foamTex.colorSpace = NoColorSpace;

  const timeU = uniform(0);
  const wl = sim.wl;
  const waveDamp = uniform(new Vector2(26, 0.55));
  const shoreWave = uniform(new Vector4(params.shoreAmplitude, params.shoreWavelength, params.shoreSpeed, params.shoreSteepness));
  const swellDir = uniform(new Vector2(1, 0));
  const extent = uniform(shore.extent);
  const wind = uniform(params.windSpeed);
  const optics = uniform(new Vector4(params.roughness, params.refraction, params.reflectionDistort, 1 / params.horizon));
  const sss = uniform(new Vector4(params.sssPeak, params.sssView, 0.05, 0));
  const foamP = uniform(new Vector4(params.foamBias, params.foamScale, params.shoreFoamBand, 0.85));
  const absorption = uniform(new Vector3(0.42, 0.075, 0.048));
  const scatter = uniform(new Color(0, 0.05, 0.08));
  const foamTint = uniform(new Color(0.62, 0.78, 0.82));
  const sunDirection = uniform(new Vector3(0.5, 0.7, 0.2).normalize());
  const sunColor = uniform(new Color(1, 1, 1));
  const fogColor = uniform(new Color(0.7, 0.75, 0.8));
  const glint = uniform(params.glitter);
  const sea = uniform(seaY);
  const nearFar = uniform(new Vector2(0.1, 2000));
  const skyMaxLod = uniform(8);
  const camFwd = uniform(new Vector3(0, 0, -1));
  const camSide = uniform(-1);
  const gridScale = uniform(1);
  const cellStep = uniform((2 * Math.PI) / ANGULAR);
  const absorptionBase = new Vector3(0.42, 0.075, 0.048);

  const d0 = sim.dispNodes[0];
  const d1 = sim.dispNodes[1];
  const d2 = sim.dispNodes[2];
  const s0 = sim.slopeNodes[0];
  const s1 = sim.slopeNodes[1];
  const s2 = sim.slopeNodes[2];
  const shMap = texture(shore.texture);
  const trMap = texture(shore.travel);
  const foamMap = texture(foamTex);
  const sceneMap = viewportSharedTexture();
  const depthMap = viewportDepthTexture();
  const skyMap = cubeTexture(skyCube);

  const maps = {
    d0, d0s: d0, d1, d1s: d1, d2, d2s: d2,
    s0, s0s: s0, s1, s1s: s1, s2, s2s: s2,
    shMap, shS: shMap, trMap, trS: trMap,
  };
  const look = {
    time: timeU, wl, waveDamp, shoreWave, swellDir, extent, wind,
  };

  const vXZ = varying(vec2(0), 'vWaterXZ');
  const vUnres = varying(float(0), 'vWaterUnres');
  const depthTex = renderer.backend.compatibilityMode ? 'texture_2d<f32>' : 'texture_depth_2d';
  const depthLoad = renderer.backend.compatibilityMode ? 'textureLoad(map, c, 0).r' : 'textureLoad(map, c, 0)';
  const patchDepth = (src) => src.replaceAll('DEPTH_TEX', depthTex).replaceAll('DEPTH_LOAD', depthLoad);
  const displace = wgslFn(patchDepth(DISPLACE_WGSL));
  const shade = wgslFn(patchDepth(SHADE_WGSL));

  const material = new NodeMaterial();
  material.positionNode = Fn(() => {
    const local = positionLocal.xz;
    const r = length(local);
    const scale = select(r.greaterThan(6000), float(1), gridScale);
    const xz = cameraPosition.xz.add(local.mul(scale));
    const cell = max(r, float(INNER)).mul(cellStep).mul(scale);
    vXZ.assign(xz);
    const d = displace({ xz, cell, ...look, ...maps });
    vUnres.assign(d.w);
    return vec3(xz.x.add(d.x), d.y, xz.y.add(d.z));
  })();
  material.colorNode = Fn(() => shade({
    xz: vXZ,
    world: positionWorld,
    cam: cameraPosition,
    facing: float(frontFacing),
    camSide,
    camFwd,
    waterDepth: positionView.z.negate(),
    uv: screenUV,
    unresolved: vUnres,
    ...look,
    optics, sss, foamP,
    absorption: vec3(absorption),
    scatter: vec3(scatter),
    foamTint: vec3(foamTint),
    sunDir: sunDirection,
    sunCol: vec3(sunColor),
    fogCol: vec3(fogColor),
    glint, seaY: sea, nearFar, skyMaxLod,
    viewM: cameraViewMatrix,
    ...maps,
    foamMap, foamS: foamMap,
    sceneMap,
    depthMap,
    skyMap, skyS: skyMap,
  }))();
  material.side = FrontSide;
  material.forceSinglePass = true;
  material.transparent = true;
  material.depthWrite = false;
  material.fog = false;

  const grids = [buildGrid(ANGULAR), buildGrid(ANGULAR / 2)];
  const mesh = new Mesh(grids[0], material);
  mesh.frustumCulled = false;
  mesh.position.y = seaY;
  mesh.renderOrder = -1;
  mesh.name = 'Ocean';
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  let presetApplied = '';
  let specApplied = '';

  function applyPreset(name) {
    const p = WATER_PRESETS[name] || WATER_PRESETS.clear;
    params.preset = name in WATER_PRESETS ? name : 'clear';
    absorptionBase.fromArray(p.absorption);
    scatter.value.fromArray(p.scatter);
    foamTint.value.fromArray(p.foam);
    presetApplied = params.preset;
  }

  function pushLook() {
    if (params.preset !== presetApplied) applyPreset(params.preset);
    const key = specKey(params);
    if (key !== specApplied) {
      specApplied = key;
      sim.dirty = true;
    }
    sim.params.windSpeed = params.windSpeed;
    sim.params.windDirection = params.windDirection;
    sim.params.fetchKm = params.fetchKm;
    sim.params.waveScale = params.waveScale;
    sim.params.spreadBlend = params.spreadBlend;
    sim.params.swellScale = params.swellScale;
    sim.params.swellDirection = params.swellDirection;
    sim.params.choppiness = params.choppiness;
    sim.params.timeScale = params.timeScale;
    sim.params.foamRecovery = params.foamRecovery;
    shoreWave.value.set(params.shoreAmplitude, params.shoreWavelength, params.shoreSpeed, params.shoreSteepness);
    optics.value.set(params.roughness, params.refraction, params.reflectionDistort, 1 / Math.max(params.horizon, 20));
    sss.value.set(params.sssPeak, params.sssView, 0.05, 0);
    foamP.value.set(params.foamBias, params.foamScale, params.shoreFoamBand, 0.85);
    glint.value = params.glitter;
    wind.value = params.windSpeed;
    absorption.value.copy(absorptionBase).multiplyScalar(1 / Math.max(params.clarity, 0.05));
    const a = params.swellDirection * Math.PI / 180;
    swellDir.value.set(-Math.cos(a), -Math.sin(a));
  }

  applyPreset(params.preset);
  pushLook();

  const surface = createSurfaceHeight(renderer, { shore, sim, params, waveDamp, swellDir });
  bindOceanHeight((x, z) => surface.height(x, z));

  // Half-rate FFT: accumulate dt so wave speed stays the same.
  let simPending = 0;
  let simTick = 0;

  const water = {
    mesh,
    sim,
    params,
    sunDirection,
    sunColor,
    waterColor: scatter,
    fogColor,
    scatter,
    foamTint,
    applyPreset,
    update(dt, camera) {
      pushLook();
      simPending += dt;
      if ((simTick++ & 1) === 0) {
        sim.update(simPending);
        simPending = 0;
      }
      surface.capture();
      timeU.value = sim.time;
      const height = Math.abs(camera.position.y - seaY);
      gridScale.value = Math.max(1, height / 2);
      const coarse = height > HIGH_CAMERA;
      mesh.geometry = grids[coarse ? 1 : 0];
      cellStep.value = (2 * Math.PI) / (coarse ? ANGULAR / 2 : ANGULAR);
      camera.getWorldDirection(camFwd.value);
      const dy = camera.position.y - seaY;
      camSide.value = dy > 0.5 ? -1 : dy < -0.5 ? 1 : 0;
      nearFar.value.set(camera.near, camera.far);
    },
  };
  return water;
}
