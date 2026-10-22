// Adapted from https://github.com/thebenezer/FluffyGrass (MIT).
// Standalone ShaderMaterial so we don't fight three@0.186 MeshLambert chunk changes.
import * as THREE from 'three';
import { shadowTint } from './shadowTint.js';

const vertexShader = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uHeightAmp;
  uniform float uWindAmp;
  uniform float uTerrainSize;
  uniform float uNoiseScale;
  uniform sampler2D uNoiseTexture;

  varying vec2 vGrassUv;
  varying vec2 vGlobalUV;
  varying float vFogDepth;

  #include <common>
  #include <shadowmap_pars_vertex>

  void main() {
    vec3 pos = position;
    #ifdef USE_INSTANCING
      pos = (instanceMatrix * vec4(pos, 1.0)).xyz;
    #endif

    vec4 worldPosition = modelMatrix * vec4(pos, 1.0);
    vGlobalUV = (uTerrainSize - worldPosition.xz) / uTerrainSize;

    vec4 noise = texture2D(uNoiseTexture, vGlobalUV + uTime * 0.0008);
    float tip = 1.0 - uv.y;
    float sinWave = sin(
      28.0 * dot(normalize(vec2(1.0, 0.65)), vGlobalUV)
      + noise.g * 4.0
      + uTime * 0.85
    ) * uWindAmp * tip;
    worldPosition.x += sinWave;
    worldPosition.z += sinWave;
    worldPosition.y += exp(texture2D(uNoiseTexture, vGlobalUV * uNoiseScale).r) * uHeightAmp * tip;

    vec4 mvPosition = viewMatrix * worldPosition;
    gl_Position = projectionMatrix * mvPosition;

    vGrassUv = vec2(uv.x, 1.0 - uv.y);
    vFogDepth = -mvPosition.z;

    // Manual shadow coords — geometry has normals (HAS_NORMAL) but we don't run
    // defaultnormal_vertex, so shadowmap_vertex would fail on transformedNormal.
    // Light.normalBias already handles acne; grass blades are thin receivers.
    #if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )
      #pragma unroll_loop_start
      for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
        vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * worldPosition;
      }
      #pragma unroll_loop_end
    #endif
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform vec3 uBaseColor;
  uniform vec3 uTipColor1;
  uniform vec3 uTipColor2;
  uniform sampler2D uGrassAlphaTexture;
  uniform sampler2D uNoiseTexture;
  uniform float uNoiseScale;
  uniform float uGrassLightIntensity;
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  uniform vec3 shadowTint;

  varying vec2 vGrassUv;
  varying vec2 vGlobalUV;
  varying float vFogDepth;

  #include <common>
  #include <packing>

  uniform bool receiveShadow;

  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>

  void main() {
    float alpha = texture2D(uGrassAlphaTexture, vGrassUv).r;
    if (alpha < 0.15) discard;

    vec3 tipColor = mix(uTipColor1, uTipColor2, texture2D(uNoiseTexture, vGlobalUV * uNoiseScale).r);
    vec3 color = mix(uBaseColor, tipColor, vGrassUv.y) * uGrassLightIntensity;

    // Unlit grass has no ambient fill — floor shadow at 50% so blades stay readable.
    float sm = mix(0.5, 1.0, getShadowMask());
    color *= mix(shadowTint, vec3(1.0), sm);

    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    color = mix(color, fogColor, fogFactor);

    gl_FragColor = vec4(color, 1.0);
  }
`;

export class GrassMaterial {
  constructor({
    baseColor = '#2a3518',
    tipColor1 = '#8aa85a',
    tipColor2 = '#3a4f28',
    heightAmp = 0.06,
    windAmp = 0.04,
    terrainSize = 500,
    fogColor = 0x8caebc,
    fogNear = 70,
    fogFar = 240,
  } = {}) {
    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      {
        uTime: { value: 0 },
        uHeightAmp: { value: heightAmp },
        uWindAmp: { value: windAmp },
        uTerrainSize: { value: terrainSize },
        uNoiseScale: { value: 1.2 },
        uGrassLightIntensity: { value: 1.35 },
        uBaseColor: { value: new THREE.Color(baseColor) },
        uTipColor1: { value: new THREE.Color(tipColor1) },
        uTipColor2: { value: new THREE.Color(tipColor2) },
        uNoiseTexture: { value: null },
        uGrassAlphaTexture: { value: null },
        fogColor: { value: fogColor.isColor ? fogColor : new THREE.Color(fogColor) },
        fogNear: { value: fogNear },
        fogFar: { value: fogFar },
      },
    ]);
    // Shared with MeshStandard tint patch — must not be cloned by merge.
    this.uniforms.shadowTint = shadowTint;

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      lights: true,
      side: THREE.DoubleSide,
      // Opaque + discard (not transparent blending) — sorts correctly with the terrain.
      transparent: false,
      depthWrite: true,
      fog: false, // fog applied manually to match scene Fog ranges
    });
  }

  update(time) {
    this.uniforms.uTime.value = time;
  }

  setupTextures(grassAlpha, noise) {
    grassAlpha.colorSpace = THREE.NoColorSpace;
    grassAlpha.wrapS = grassAlpha.wrapT = THREE.ClampToEdgeWrapping;
    grassAlpha.needsUpdate = true;
    noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
    noise.colorSpace = THREE.NoColorSpace;
    noise.needsUpdate = true;
    this.uniforms.uGrassAlphaTexture.value = grassAlpha;
    this.uniforms.uNoiseTexture.value = noise;
  }
}
