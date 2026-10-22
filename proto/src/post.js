// Post chain: render (linear HDR) -> UnrealBloom -> grade -> FXAA -> finish.
// Grade: exposure + ACES + temperature + shadow/mid/highlight tints + vignette.
// Finish: chromatic aberration + film grain (ported from MeshGL).
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    exposure: { value: 1.0 },
    contrast: { value: 1.0 },
    saturation: { value: 1.0 },
    temperature: { value: 0.0 },
    shadows: { value: new THREE.Color(1, 1, 1) },
    midtones: { value: new THREE.Color(1, 1, 1) },
    highlights: { value: new THREE.Color(1, 1, 1) },
    vignetteIntensity: { value: 0.35 },
    vignetteColor: { value: new THREE.Color(0.03, 0.03, 0.03) },
  },
  vertexShader,
  fragmentShader: /* glsl */ `
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float exposure;
uniform float contrast;
uniform float saturation;
uniform float temperature;
uniform vec3 shadows;
uniform vec3 midtones;
uniform vec3 highlights;
uniform float vignetteIntensity;
uniform vec3 vignetteColor;

vec3 ACESFilmicToneMapping(vec3 color) {
  color *= 0.6;
  float a = 2.51; float b = 0.03; float c = 2.43; float d = 0.59; float e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec4 color = texture2D(tDiffuse, vUv);
  vec3 rgb = ACESFilmicToneMapping(color.rgb * exposure);
  rgb = (rgb - 0.5) * contrast + 0.5;

  // White-balance: cool (−) ↔ warm (+)
  rgb.r += temperature * 0.12;
  rgb.b -= temperature * 0.12;

  float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float wS = 1.0 - smoothstep(0.0, 0.45, lum);
  float wH = smoothstep(0.55, 1.0, lum);
  float wM = clamp(1.0 - wS - wH, 0.0, 1.0);
  rgb *= mix(vec3(1.0), shadows, wS);
  rgb *= mix(vec3(1.0), midtones, wM);
  rgb *= mix(vec3(1.0), highlights, wH);

  lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(lum), rgb, saturation);
  if (vignetteIntensity > 0.0001) {
    float dist = distance(vUv, vec2(0.5));
    float start = mix(0.3, 0.0, vignetteIntensity);
    float end = mix(1.0, 0.6, vignetteIntensity * 0.5);
    float mask = pow(smoothstep(start, end, dist), mix(1.0, 3.0, vignetteIntensity));
    rgb = mix(rgb, rgb * vignetteColor, mask * vignetteIntensity);
  }
  gl_FragColor = vec4(linearToSrgb(clamp(rgb, 0.0, 1.0)), 1.0);
}`,
};

const FinishShader = {
  uniforms: {
    tDiffuse: { value: null },
    aberration: { value: 0.0012 },
    time: { value: 0 },
    grain: { value: 0.035 },
    grainScale: { value: 1.0 },
    grainTint: { value: new THREE.Color(1, 1, 1) },
  },
  vertexShader,
  fragmentShader: /* glsl */ `
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float aberration;
uniform float time;
uniform float grain;
uniform float grainScale;
uniform vec3 grainTint;

float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 dir = vUv - 0.5;
  vec2 shift = normalize(dir + 1e-6) * aberration * length(dir) * 2.0;
  vec3 base = vec3(texture2D(tDiffuse, vUv + shift).r, texture2D(tDiffuse, vUv).g,
                   texture2D(tDiffuse, vUv - shift).b);
  if (grain > 0.0001) {
    float noise = rand(vUv * (800.0 * grainScale) + time * 0.05) * 2.0 - 1.0;
    float lum = dot(base, vec3(0.299, 0.587, 0.114));
    base += grainTint * noise * grain * 0.5 * mix(0.3, 1.0, smoothstep(0.0, 0.5, lum));
  }
  gl_FragColor = vec4(base, 1.0);
}`,
};

export function createPost(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, target);

  const render = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(size.clone(), 0.6, 0.45, 0.95);
  const grade = new ShaderPass(GradeShader);
  const fxaa = new ShaderPass(FXAAShader);
  const finish = new ShaderPass(FinishShader);

  composer.addPass(render);
  composer.addPass(bloom);
  composer.addPass(grade);
  composer.addPass(fxaa);
  composer.addPass(finish);

  function setSize(w, h) {
    composer.setSize(w, h);
    bloom.resolution.set(w, h);
    const pr = renderer.getPixelRatio();
    fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
  }
  setSize(size.x, size.y);

  return {
    composer, bloom, grade, finish, setSize,
    render(dt) {
      finish.uniforms.time.value += dt * 60;
      composer.render(dt);
    },
  };
}
