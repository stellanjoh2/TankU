// WebGPU post: scene → motion blur → bloom → ACES Filmic (RenderPipeline outputColorTransform).
// Contrast / sat / vignette / FXAA / finish still stubbed (TSL later).
// Tone map matches three.js webgpu_tonemapping: renderer.toneMapping + toneMappingExposure.
import * as THREE from 'three/webgpu';
import { pass, mrt, output, velocity, uniform, vec2 } from 'three/tsl';
import { bloom as bloomNode } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { motionBlur } from 'three/examples/jsm/tsl/display/MotionBlur.js';

export function createPost(renderer, scene, camera) {
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  // VelocityNode is NDC; motionBlur samples in UV — same scale as TRAA / velocityToUVOffset.
  const blurAmount = uniform(1);

  let bloomPass = null;
  let motionBlurOn = false;
  let bloomStrength = 0.6;
  let bloomRadius = 0.45;
  let bloomThresh = 0.95;

  function rebuild() {
    if (motionBlurOn) {
      scenePass.setMRT(mrt({ output, velocity }));
      const beauty = scenePass.getTextureNode('output');
      const vel = scenePass.getTextureNode('velocity').xy.mul(vec2(0.5, -0.5)).mul(blurAmount);
      const color = motionBlur(beauty, vel);
      bloomPass = bloomNode(color, bloomStrength, bloomRadius, bloomThresh);
      // HDR beauty+bloom; ACES + sRGB applied by pipeline.outputColorTransform
      pipeline.outputNode = color.add(bloomPass);
    } else {
      scenePass.setMRT(null);
      const color = scenePass.getTextureNode('output');
      bloomPass = bloomNode(color, bloomStrength, bloomRadius, bloomThresh);
      pipeline.outputNode = color.add(bloomPass);
    }
  }

  rebuild();

  // visuals.js assigns bloom.strength / .radius / .threshold as plain numbers
  const bloom = {
    get strength() { return bloomPass.strength.value; },
    set strength(v) { bloomStrength = v; bloomPass.strength.value = v; },
    get radius() { return bloomPass.radius.value; },
    set radius(v) { bloomRadius = v; bloomPass.radius.value = v; },
    get threshold() { return bloomPass.threshold.value; },
    set threshold(v) { bloomThresh = v; bloomPass.threshold.value = v; },
  };

  const motionBlurCtrl = {
    get enabled() { return motionBlurOn; },
    set enabled(v) {
      v = !!v;
      if (v === motionBlurOn) return;
      motionBlurOn = v;
      rebuild();
    },
    get amount() { return blurAmount.value; },
    set amount(v) { blurAmount.value = v; },
  };

  // Exposure drives ACES via renderer.toneMappingExposure (same as webgpu_tonemapping GUI).
  const exposure = {
    get value() { return renderer.toneMappingExposure; },
    set value(v) { renderer.toneMappingExposure = v; },
  };

  const grade = {
    uniforms: {
      exposure,
      contrast: { value: 1.0 },
      saturation: { value: 1.0 },
      temperature: { value: 0.0 },
      shadows: { value: new THREE.Color(1, 1, 1) },
      midtones: { value: new THREE.Color(1, 1, 1) },
      highlights: { value: new THREE.Color(1, 1, 1) },
      vignetteIntensity: { value: 0.35 },
      vignetteColor: { value: new THREE.Color(0.03, 0.03, 0.03) },
    },
  };

  const finish = {
    uniforms: {
      aberration: { value: 0.0012 },
      time: { value: 0 },
      grain: { value: 0.035 },
      grainScale: { value: 1.0 },
      grainTint: { value: new THREE.Color(1, 1, 1) },
    },
  };

  return {
    bloom,
    motionBlur: motionBlurCtrl,
    grade,
    finish,
    pipeline,
    setSize() {},
    render(dt) {
      finish.uniforms.time.value += dt * 60;
      pipeline.render();
    },
  };
}
