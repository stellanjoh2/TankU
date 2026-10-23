// WebGPU post: scene → motion blur → bloom → grade → ACES Filmic.
// Bloom is the full beauty image plus the emissive attachment, so HDR sprites
// (emissiveNode, black albedo) glow with the rest of the frame.
// Grade (contrast, saturation, temperature, shadow/mid/highlight tint, vignette)
// runs in linear HDR. Exposure is renderer.toneMappingExposure inside the tone map.
// Grain / aberration / FXAA still unused.
// Tone map matches three.js webgpu_tonemapping: renderer.toneMapping + toneMappingExposure.
import * as THREE from 'three/webgpu';
import { pass, mrt, output, emissive, velocity, uniform, vec2, vec3, vec4, float, mix, smoothstep, dot, screenUV, luminance, saturation } from 'three/tsl';
import { bloom as bloomNode } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { motionBlur } from 'three/examples/jsm/tsl/display/MotionBlur.js';

export function createPost(renderer, scene, camera) {
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  // VelocityNode is NDC; motionBlur samples in UV — same scale as TRAA / velocityToUVOffset.
  const blurAmount = uniform(1);
  // Extra MRT targets default to no blending, which drops transparent sprites.
  const emissiveBlend = new THREE.BlendMode(THREE.NormalBlending);

  let bloomPass = null;
  let motionBlurOn = false;
  let bloomStrength = 0.15;
  let bloomRadius = 0.45;
  let bloomThresh = 0.95;

  // Same objects the Visuals panel writes (.value / Color.set). White grade colors are neutral.
  const uContrast = uniform(1);
  const uSaturation = uniform(1);
  const uTemperature = uniform(0);
  const uShadows = uniform(new THREE.Color(1, 1, 1));
  const uMids = uniform(new THREE.Color(1, 1, 1));
  const uHighlights = uniform(new THREE.Color(1, 1, 1));
  const uVignette = uniform(0.35);

  function tintMul(col, weight) {
    const peak = col.r.max(col.g.max(col.b));
    const floor = col.r.min(col.g.min(col.b));
    const sat = peak.sub(floor).div(peak.max(0.001));
    const hue = vec3(col.r, col.g, col.b).div(peak.max(0.001));
    return mix(vec3(1), hue, weight.mul(sat));
  }

  function gradeFrame(color) {
    const pivot = float(0.18);
    let rgb = color.rgb.sub(pivot).mul(uContrast).add(pivot).max(0);

    const t = uTemperature;
    rgb = rgb.mul(vec3(
      float(1).add(t.mul(0.35)),
      float(1).add(t.mul(0.08)),
      float(1).sub(t.mul(0.35)),
    )).max(0);
    rgb = saturation(rgb, uSaturation);

    const lum = luminance(rgb);
    const split = lum.div(lum.add(1));
    const shadowW = float(1).sub(smoothstep(0, 0.55, split));
    const highW = smoothstep(0.45, 1, split);
    const midW = float(1).sub(shadowW).sub(highW).max(0);
    // White is neutral. The swatch's hue tints that range; its brightness does not crush it.
    rgb = rgb.mul(tintMul(uShadows, shadowW))
      .mul(tintMul(uMids, midW))
      .mul(tintMul(uHighlights, highW));

    const fromCenter = screenUV.sub(0.5);
    const vig = float(1).sub(dot(fromCenter, fromCenter).mul(uVignette));
    rgb = rgb.mul(vig.max(0));

    return vec4(rgb, color.a);
  }

  function view() {
    const targets = {
      output,
      emissive: vec4(emissive, output.a),
    };
    if (motionBlurOn) targets.velocity = velocity;
    const mrtNode = mrt(targets);
    mrtNode.setBlendMode('emissive', emissiveBlend);
    scenePass.setMRT(mrtNode);

    let color = scenePass.getTextureNode('output');
    let glow = scenePass.getTextureNode('emissive');
    if (motionBlurOn) {
      const vel = scenePass.getTextureNode('velocity').xy.mul(vec2(0.5, -0.5)).mul(blurAmount);
      color = motionBlur(color, vel);
      glow = motionBlur(glow, vel);
    }
    return { color, glow };
  }

  function rebuild() {
    bloomPass?.dispose();
    const { color, glow } = view();
    // Beauty is the whole frame. Emissive is added only into the bloom extract
    // so sprites that store their glow there still bloom; the sharp image stays beauty.
    bloomPass = bloomNode(color.add(vec4(glow.rgb, 0)), bloomStrength, bloomRadius, bloomThresh);
    pipeline.outputNode = gradeFrame(color.add(bloomPass));
    // RenderPipeline keeps the previous output shader until this is set.
    pipeline.needsUpdate = true;
  }

  rebuild();

  // visuals.js assigns bloom.strength / .radius / .threshold as plain numbers
  const bloom = {
    get strength() { return bloomPass.strength.value; },
    set strength(v) { bloomStrength = +v; bloomPass.strength.value = bloomStrength; },
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
      contrast: uContrast,
      saturation: uSaturation,
      temperature: uTemperature,
      shadows: uShadows,
      midtones: uMids,
      highlights: uHighlights,
      vignetteIntensity: uVignette,
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
