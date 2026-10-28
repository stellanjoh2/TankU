// WebGPU post: scene → bloom → lens dirt → grade → grain → ACES Filmic.
// Bloom runs at quarter resolution. Its input is the beauty image, plus the emissive
// attachment while something bright is on screen (HDR sprites, brake lights, muzzle flash).
// With both off, the sharp image is added to bloom directly.
// Lens dirt: fullscreen additive map, lit by bloom luminance (sun / muzzle / explosions).
// Impact dirt: near-miss shell splat overlay (opaque mud map), linear fade over 5 s.
// Grain is animated and added after the grade.
// Grade (contrast, saturation, temperature, shadow/mid/highlight tint, vignette)
// runs in linear HDR. Exposure is renderer.toneMappingExposure inside the tone map.
// FXAA still unused.
// Tone map matches three.js webgpu_tonemapping: renderer.toneMapping + toneMappingExposure.
import * as THREE from 'three/webgpu';
import { pass, mrt, output, emissive, uniform, vec3, vec4, float, mix, smoothstep, dot, length, rand, screenUV, luminance, saturation, texture } from 'three/tsl';
import { bloom as bloomNode } from 'three/examples/jsm/tsl/display/BloomNode.js';

const LENS_DIRT_URL = './textures/vfx/lens_dirt.jpg';
const IMPACT_DIRT_URL = './textures/vfx/shell_impact_dirt.png';
const IMPACT_DIRT_FADE = 5; // seconds from full splat → clear

export async function createPost(renderer, scene, camera) {
  const loader = new THREE.TextureLoader();
  const [dirtMap, impactDirtMap] = await Promise.all([
    loader.loadAsync(LENS_DIRT_URL),
    loader.loadAsync(IMPACT_DIRT_URL),
  ]);
  dirtMap.colorSpace = THREE.NoColorSpace;
  dirtMap.wrapS = dirtMap.wrapT = THREE.ClampToEdgeWrapping;
  // Artistic mask (black = clear). Keep byte values — sRGB linearize makes mud invisible in HDR.
  impactDirtMap.colorSpace = THREE.NoColorSpace;
  impactDirtMap.wrapS = impactDirtMap.wrapT = THREE.ClampToEdgeWrapping;
  const dirtTex = texture(dirtMap);
  const impactDirtTex = texture(impactDirtMap);
  // Overall dirt opacity when fully lit. 0 = off.
  const uLensDirt = uniform(1.6);
  // 0..1: camera aimed at the sun (CPU). Ordinary sky bloom must not light dirt.
  const uLensDirtView = uniform(0);
  // Near-miss shell splat on the lens (CPU fades linearly over IMPACT_DIRT_FADE).
  const uImpactDirt = uniform(0);
  let impactDirtOpacity = 0;
  const _dirtView = new THREE.Vector3();
  // Extra MRT targets default to no blending, which drops transparent sprites.
  const emissiveBlend = new THREE.BlendMode(THREE.NormalBlending);

  const bloomPasses = [];
  let plainChain = null;
  let glowChain = null;
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
  // Low-HP red edge (0 above 25% health; pulse-driven at ≤10%). Gameplay, not the Visuals slider.
  const uDamageVignette = uniform(0);
  let hurtHp = 1;
  let hurtTime = 0;
  // Finish uniforms. Same .value objects the Visuals sliders write.
  const uTime = uniform(0);
  const uGrain = uniform(0.035);
  const uGrainScale = uniform(1);
  const uGrainTint = uniform(new THREE.Color(1, 1, 1));

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

    // Damage vignette: edges tone red as HP drops. Falloff is independent of the artistic vignette.
    const dmgEdge = smoothstep(0.1, 0.68, length(fromCenter));
    rgb = mix(rgb, rgb.mul(vec3(1.05, 0.08, 0.06)), dmgEdge.mul(uDamageVignette));

    return vec4(rgb, color.a);
  }

  function damageVignetteAmount(hp, t) {
    // Red vignette only at critical HP (≤10%), with a 1 Hz heartbeat pulse.
    if (hp > 0.10) return 0;
    return Math.min(1.25, 0.5 + 0.85 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2)));
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

  // Dirt sits on the lens (screen UV). Fades in when looking into the sun;
  // only very hot bloom (muzzle / explosions) can light it otherwise.
  function applyLensDirt(frame, bloomColor) {
    const dirt = dirtTex.sample(screenUV).rgb;
    const hot = smoothstep(float(4), float(12), luminance(bloomColor));
    const amount = uLensDirtView.max(hot).mul(uLensDirt);
    return frame.add(vec4(dirt.mul(amount), 0));
  }

  // Shell near-miss: mud on the glass. Texture alpha is the mask; uImpactDirt fades 1 → 0.
  function applyImpactDirt(frame) {
    const dirt = impactDirtTex.sample(screenUV);
    return vec4(mix(frame.rgb, dirt.rgb, dirt.a.mul(uImpactDirt)), frame.a);
  }

  // smoothstep(0.62, 0.93, dot(view, sun)) — off until aimed well into the sun.
  function updateLensDirtView(sunDirection) {
    if (!sunDirection) {
      uLensDirtView.value = 0;
      return;
    }
    camera.getWorldDirection(_dirtView);
    const d = Math.max(0, _dirtView.dot(sunDirection));
    const t = Math.min(1, Math.max(0, (d - 0.62) / 0.31));
    uLensDirtView.value = t * t * (3 - 2 * t);
  }

  function view(scenePass, useEmissive) {
    if (useEmissive) {
      const mrtNode = mrt({
        output,
        emissive: vec4(emissive, output.a),
      });
      mrtNode.setBlendMode('emissive', emissiveBlend);
      scenePass.setMRT(mrtNode);
    }

    const color = scenePass.getTextureNode('output');
    const glow = useEmissive ? scenePass.getTextureNode('emissive') : null;
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

    const bloomColor = bloomPass;
    let frame = color.add(bloomPass);
    // Impact mud sits on the lens after grade so it stays readable over HDR/tonemap.
    frame = applyLensDirt(frame, bloomColor);
    pipeline.outputNode = applyGrain(applyImpactDirt(gradeFrame(frame)));
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
      time: uTime,
      grain: uGrain,
      grainScale: uGrainScale,
      grainTint: uGrainTint,
    },
  };

  const lensDirt = {
    get strength() { return uLensDirt.value; },
    set strength(v) { uLensDirt.value = +v; },
  };

  return {
    bloom,
    grade,
    finish,
    lensDirt,
    setSize() {},
    /** Player HP fraction 0..1. Drives pulsing red vignette at ≤10%. */
    setHurt(hpFrac) {
      hurtHp = Math.max(0, Math.min(1, +hpFrac || 0));
    },
    /** Enemy shell hit dirt within ~4 m — full splat, then linear fade over 5 s. */
    splatImpactDirt() {
      impactDirtOpacity = 1;
      uImpactDirt.value = 1;
    },
    clearImpactDirt() {
      impactDirtOpacity = 0;
      uImpactDirt.value = 0;
    },
    render(dt, bright, sunDirection) {
      finish.uniforms.time.value += dt * 60;
      hurtTime += dt;
      uDamageVignette.value = damageVignetteAmount(hurtHp, hurtTime);
      if (impactDirtOpacity > 0) {
        impactDirtOpacity = Math.max(0, impactDirtOpacity - dt / IMPACT_DIRT_FADE);
        uImpactDirt.value = impactDirtOpacity;
      }
      updateLensDirtView(sunDirection);
      (bright ? glowChain : plainChain).pipeline.render();
    },
  };
}
