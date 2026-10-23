// TSL grass for WebGPU — UV flip, tip/base colors, alpha discard, world wind, shadow receive.
import * as THREE from 'three/webgpu';
import {
  uv, texture, vec2, vec3, vec4, float, mix, uniform, sin, exp, dot, normalize,
  positionLocal, modelWorldMatrix, modelWorldMatrixInverse,
  normalView, diffuseColor, BRDF_Lambert,
} from 'three/tsl';
import { shadowTint } from './shadowTint.js';

/** Two-sided wrapped diffuse — crossed billboard cards never go black when facing away from the sun. */
class GrassLightingModel extends THREE.PhongLightingModel {
  constructor() {
    super(false);
  }

  direct({ lightDirection, lightColor, reflectedLight }) {
    const wrap = float(0.4);
    const ndotl = normalView.dot(lightDirection).abs();
    const diffuse = ndotl.add(wrap).div(wrap.add(1.0)).clamp();
    const irradiance = diffuse.mul(lightColor);
    reflectedLight.directDiffuse.addAssign(
      irradiance.mul(BRDF_Lambert({ diffuseColor: diffuseColor.rgb })),
    );
  }
}

const grassLighting = new GrassLightingModel();

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
    const base = new THREE.Color(baseColor);
    const tip1 = new THREE.Color(tipColor1);
    const tip2 = new THREE.Color(tipColor2);
    const fogCol = fogColor.isColor ? fogColor : new THREE.Color(fogColor);

    this.uniforms = {
      uTime: { value: 0 },
      uHeightAmp: { value: heightAmp },
      uWindAmp: { value: windAmp },
      uTerrainSize: { value: terrainSize },
      uNoiseScale: { value: 1.2 },
      uGrassLightIntensity: { value: 1.35 },
      uBaseColor: { value: base },
      uTipColor1: { value: tip1 },
      uTipColor2: { value: tip2 },
      uNoiseTexture: { value: null },
      uGrassAlphaTexture: { value: null },
      fogColor: { value: fogCol },
      fogNear: { value: fogNear },
      fogFar: { value: fogFar },
      shadowTint,
    };

    this._uTime = uniform(0);
    this._uHeightAmp = uniform(heightAmp);
    this._uWindAmp = uniform(windAmp);
    this._uTerrainSize = uniform(terrainSize);
    this._uNoiseScale = uniform(1.2);
    this._uIntensity = uniform(1.35);
    this._uBase = uniform(base);
    this._uTip1 = uniform(tip1);
    this._uTip2 = uniform(tip2);
    this._alphaTex = null;
    this._noiseTex = null;

    // Lambert so InstancedMesh receiveShadow works (MeshBasic is unlit).
    this.material = new THREE.MeshLambertNodeMaterial({
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      fog: true,
    });
    this.material.setupLightingModel = () => grassLighting;
  }

  update(time) {
    this.uniforms.uTime.value = time;
    this._uTime.value = time;
    this._uHeightAmp.value = this.uniforms.uHeightAmp.value;
    this._uWindAmp.value = this.uniforms.uWindAmp.value;
    this._uTerrainSize.value = this.uniforms.uTerrainSize.value;
    this._uNoiseScale.value = this.uniforms.uNoiseScale.value;
    this._uIntensity.value = this.uniforms.uGrassLightIntensity.value;
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
    this._alphaTex = texture(grassAlpha);
    this._noiseTex = texture(noise);

    // Same flip as the old GLSL: vGrassUv = vec2(uv.x, 1.0 - uv.y)
    const grassUv = vec2(uv().x, float(1).sub(uv().y));
    const tipBlend = this._noiseTex.sample(grassUv.mul(this._uNoiseScale)).r;
    const tipColor = mix(this._uTip1, this._uTip2, tipBlend);
    const albedo = mix(this._uBase, tipColor, grassUv.y).mul(this._uIntensity);

    this.material.colorNode = albedo;
    this.material.opacityNode = this._alphaTex.sample(grassUv).r;
    this.material.alphaTestNode = float(0.15);

    // World-space wind (same math as prior FluffyGrass GLSL).
    const worldPos = modelWorldMatrix.mul(vec4(positionLocal, 1.0)).xyz.toVar();
    const globalUV = vec2(
      this._uTerrainSize.sub(worldPos.x),
      this._uTerrainSize.sub(worldPos.z),
    ).div(this._uTerrainSize);

    const windNoise = this._noiseTex.sample(globalUV.add(this._uTime.mul(0.0008)));
    const tip = float(1).sub(uv().y);
    const windDir = normalize(vec2(1.0, 0.65));
    const sinWave = sin(
      float(28).mul(dot(windDir, globalUV))
        .add(windNoise.g.mul(4))
        .add(this._uTime.mul(0.85)),
    ).mul(this._uWindAmp).mul(tip);

    const heightNoise = this._noiseTex.sample(globalUV.mul(this._uNoiseScale)).r;
    worldPos.assign(worldPos.add(vec3(sinWave, exp(heightNoise).mul(this._uHeightAmp).mul(tip), sinWave)));

    this.material.positionNode = modelWorldMatrixInverse.mul(vec4(worldPos, 1.0)).xyz;

    this.material.needsUpdate = true;
  }
}
