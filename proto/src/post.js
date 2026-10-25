// WebGPU post: scene → motion blur → bloom → fisheye/aberration → grade → grain → ACES Filmic.
// Bloom runs at quarter resolution. Its input is the beauty image, plus the emissive
// attachment while something bright is on screen (HDR sprites, brake lights, muzzle flash).
// With both off, the sharp image is added to bloom directly. Fisheye or aberration
// resamples that sum. The warp is scaled so the screen corner lands on the texture
// corner — no black edges, and no extra pass when blur is off.
// Aberration is the old finish pass: radial RGB split in UV units (slider 0–0.008).
// At 0 the extra taps are skipped. Grain is animated and added after the grade.
// Grade (contrast, saturation, temperature, shadow/mid/highlight tint, vignette)
// runs in linear HDR. Exposure is renderer.toneMappingExposure inside the tone map.
// FXAA still unused.
// Tone map matches three.js webgpu_tonemapping: renderer.toneMapping + toneMappingExposure.
import * as THREE from 'three/webgpu';
import { pass, mrt, output, emissive, velocity, uniform, vec2, vec3, vec4, float, mix, smoothstep, dot, length, normalize, rand, screenUV, screenSize, luminance, saturation, convertToTexture } from 'three/tsl';
import { bloom as bloomNode } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { motionBlur } from 'three/examples/jsm/tsl/display/MotionBlur.js';

export function createPost(renderer, scene, camera) {
  // VelocityNode is NDC; motionBlur samples in UV — same scale as TRAA / velocityToUVOffset.
  const blurAmount = uniform(1);
  // Extra MRT targets default to no blending, which drops transparent sprites.
  const emissiveBlend = new THREE.BlendMode(THREE.NormalBlending);

  const bloomPasses = [];
  let plainChain = null;
  let glowChain = null;
  let motionBlurOn = false;
  let bloomStrength = 0.15;
  let bloomRadius = 0.45;
  let bloomThresh = 0.95;
  // Quarter of the drawing buffer. BloomNode's own default is half.
  const BLOOM_SCALE = 0.25;

  // Same objects the Visuals panel writes (.value / Color.set). White grade colors are neutral.
  const uContrast = uniform(1);
  const uSaturation = uniform(1);
  const uTemperature = uniform(0);
  const uShadows = uniform(new THREE.Color(1, 1, 1));
  const uMids = uniform(new THREE.Color(1, 1, 1));
  const uHighlights = uniform(new THREE.Color(1, 1, 1));
  const uVignette = uniform(0.35);
  // 0 = rectilinear. Higher bulges the center. Corner scale keeps samples in-frame.
  const uFisheye = uniform(0.5);
  let fisheyeOn = true;
  // Finish uniforms. Same .value objects the Visuals sliders write.
  const uAberration = uniform(0);
  const uTime = uniform(0);
  const uGrain = uniform(0.035);
  const uGrainScale = uniform(1);
  const uGrainTint = uniform(new THREE.Color(1, 1, 1));
  // Extra RGB taps only while the slider is above zero.
  let aberrationOn = false;

  // Circular in pixels. Dividing by the corner factor zooms out just enough
  // that the screen corner samples the texture corner.
  function lensUv() {
    const aspect = screenSize.x.div(screenSize.y.max(1));
    const ratio = vec2(aspect, 1);
    const centered = screenUV.sub(0.5).mul(ratio);
    const r2 = dot(centered, centered);
    const corner = ratio.mul(0.5);
    const cornerR2 = dot(corner, corner);
    const k = uFisheye.max(0);
    const fit = float(1).add(k.mul(cornerR2));
    const factor = float(1).add(k.mul(r2)).div(fit);
    return centered.mul(factor).div(ratio).add(0.5);
  }

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

  // Old FinishShader: hash noise, stronger on brighter pixels, tinted.
  function applyGrain(color) {
    const coord = screenUV.mul(float(800).mul(uGrainScale)).add(uTime.mul(0.05));
    const noise = rand(coord).mul(2).sub(1);
    const lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    const weight = mix(float(0.3), float(1), smoothstep(0, 0.5, lum));
    const tint = vec3(uGrainTint.r, uGrainTint.g, uGrainTint.b);
    const rgb = color.rgb.add(tint.mul(noise.mul(uGrain).mul(0.5).mul(weight)));
    return vec4(rgb, color.a);
  }

  function view(scenePass, useEmissive) {
    const targets = { output };
    if (useEmissive) targets.emissive = vec4(emissive, output.a);
    if (motionBlurOn) targets.velocity = velocity;
    if (useEmissive || motionBlurOn) {
      const mrtNode = mrt(targets);
      if (useEmissive) mrtNode.setBlendMode('emissive', emissiveBlend);
      scenePass.setMRT(mrtNode);
    }

    let color = scenePass.getTextureNode('output');
    let glow = useEmissive ? scenePass.getTextureNode('emissive') : null;
    if (motionBlurOn) {
      const vel = scenePass.getTextureNode('velocity').xy.mul(vec2(0.5, -0.5)).mul(blurAmount);
      color = motionBlur(color, vel);
      if (glow) glow = motionBlur(glow, vel);
    }
    return { color, glow };
  }

  function dropChain(chain) {
    if (!chain) return;
    chain.pipeline.dispose();
  }

  function makeChain(useEmissive) {
    const pipeline = new THREE.RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    const { color, glow } = view(scenePass, useEmissive);
    // Beauty is the whole frame. Emissive is added only into the bloom extract
    // so sprites that store their glow there still bloom; the sharp image stays beauty.
    const bloomInput = glow ? color.add(vec4(glow.rgb, 0)) : color;
    const bloomPass = bloomNode(bloomInput, bloomStrength, bloomRadius, bloomThresh);
    bloomPass.setResolutionScale(BLOOM_SCALE);
    bloomPasses.push(bloomPass);

    let frame;
    if (fisheyeOn || aberrationOn) {
      const uv = lensUv();
      // Beauty is already a pass texture (free resample). Motion blur is a
      // computed node, so it is copied to a texture only while that effect is on.
      const sceneTex = convertToTexture(color);
      const bloomTex = bloomPass.getTextureNode();
      const sampleAt = (sampleUv) => sceneTex.sample(sampleUv).add(bloomTex.sample(sampleUv));
      frame = sampleAt(uv);
      if (aberrationOn) {
        // shift = normalize(dir) * aberration * length(dir) * 2, from the old finish pass.
        const dir = uv.sub(0.5);
        const shift = normalize(dir.add(vec2(1e-6, 1e-6))).mul(uAberration.mul(length(dir)).mul(2));
        frame = vec4(sampleAt(uv.add(shift)).r, frame.g, sampleAt(uv.sub(shift)).b, frame.a);
      }
    } else {
      frame = color.add(bloomPass);
    }
    pipeline.outputNode = applyGrain(gradeFrame(frame));
    // RenderPipeline keeps the previous output shader until this is set.
    pipeline.needsUpdate = true;
    return { pipeline, bloomPass };
  }

  function rebuild() {
    for (const p of bloomPasses) p.dispose();
    bloomPasses.length = 0;
    dropChain(plainChain);
    dropChain(glowChain);
    plainChain = makeChain(false);
    glowChain = makeChain(true);
  }

  rebuild();

  // visuals.js assigns bloom.strength / .radius / .threshold as plain numbers
  const bloom = {
    get strength() { return bloomStrength; },
    set strength(v) {
      bloomStrength = +v;
      for (const p of bloomPasses) p.strength.value = bloomStrength;
    },
    get radius() { return bloomRadius; },
    set radius(v) {
      bloomRadius = v;
      for (const p of bloomPasses) p.radius.value = bloomRadius;
    },
    get threshold() { return bloomThresh; },
    set threshold(v) {
      bloomThresh = v;
      for (const p of bloomPasses) p.threshold.value = bloomThresh;
    },
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
      fisheye: {
        get value() { return uFisheye.value; },
        set value(v) {
          uFisheye.value = +v;
          const on = Math.abs(uFisheye.value) > 1e-4;
          if (on === fisheyeOn) return;
          fisheyeOn = on;
          rebuild();
        },
      },
    },
  };

  const finish = {
    uniforms: {
      aberration: {
        get value() { return uAberration.value; },
        set value(v) {
          uAberration.value = +v;
          const on = uAberration.value > 1e-6;
          if (on === aberrationOn) return;
          aberrationOn = on;
          rebuild();
        },
      },
      time: uTime,
      grain: uGrain,
      grainScale: uGrainScale,
      grainTint: uGrainTint,
    },
  };

  return {
    bloom,
    motionBlur: motionBlurCtrl,
    grade,
    finish,
    setSize() {},
    render(dt, bright) {
      finish.uniforms.time.value += dt * 60;
      (bright ? glowChain : plainChain).pipeline.render();
    },
  };
}
