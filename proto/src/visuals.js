// Live Visuals editor — sky / sun / ground / grass / grading / post. Toggle with V.
import * as THREE from 'three';
import { VISUAL_DEFAULTS } from './visualDefaults.js';
import { getTankLodScale, setTankLodScale } from './tankLod.js';

const SKY_CLOUD_SPEED = 0.00002; // SkyMesh default cloudSpeed = slider 1×

// key, GLB material, slider label. Headlights and tail lamps stay on the baked map.
const TANK_PBR = [
  ['paint', 'M_Paint_Olive', 'Paint'],
  ['metal', 'M_Metal_Dark', 'Metal'],
  ['track', 'M_Track', 'Tracks'],
  ['rubber', 'M_Rubber', 'Rubber'],
];

function tankFromJson(json) {
  const src = json?.tank;
  const out = {};
  for (const [key] of TANK_PBR) {
    const d = VISUAL_DEFAULTS.tank[key];
    const s = src?.[key];
    out[key] = { metal: s?.metal ?? d.metal, rough: s?.rough ?? d.rough };
  }
  return out;
}

function hexOf(c) {
  return `#${c.getHexString()}`;
}

function format(v, step) {
  if (step >= 1) return String(Math.round(v));
  if (step >= 0.1) return v.toFixed(1);
  return v.toFixed(2);
}

/** Turn a saved JSON snapshot into Color/number state for writeState. */
function hydrate(json) {
  const col = (h) => new THREE.Color(h);
  const g = json.ground;
  return {
    horizon: col(json.horizon),
    fogNear: json.fogNear,
    fogFar: json.fogFar,
    elev: json.elev,
    az: json.az,
    turbidity: json.turbidity ?? 10,
    rayleigh: json.rayleigh ?? 3,
    mieCoefficient: json.mieCoefficient ?? 0.005,
    mieDirectionalG: json.mieDirectionalG ?? 0.7,
    cloudCoverage: json.cloudCoverage ?? 0.4,
    cloudDensity: json.cloudDensity ?? 0.4,
    cloudElevation: json.cloudElevation ?? 0.5,
    showSunDisc: json.showSunDisc ?? true,
    toneExposure: json.toneExposure ?? 0.8,
    sunIntensity: json.sunIntensity,
    sunColor: col(json.sunColor),
    hemiSky: col(json.hemiSky),
    hemiGround: col(json.hemiGround),
    hemiIntensity: json.hemiIntensity,
    ambient: json.ambient,
    lightProbe: json.lightProbe ?? 1,
    env: json.env,
    tank: tankFromJson(json),
    ground: {
      grass: col(g.grass),
      dry: col(g.dry),
      dirt: col(g.dirt),
      sand: col(g.sand),
      wetSand: col(g.wetSand),
      rock: col(g.rock),
      concrete: col(g.concrete ?? '#908773'),
      water: col(g.water),
    },
    grassBase: col(json.grassBase),
    grassTip1: col(json.grassTip1),
    grassTip2: col(json.grassTip2),
    grassIntensity: json.grassIntensity,
    wind: json.wind,
    palmAmount: json.palmAmount ?? 1,
    plantAmount: json.plantAmount ?? 1,
    palmBrightness: json.palmBrightness ?? 1,
    foliageBrightness: json.foliageBrightness ?? 1,
    bloom: json.bloom,
    bloomRadius: json.bloomRadius,
    bloomThresh: json.bloomThresh,
    exposure: json.exposure,
    contrast: json.contrast,
    saturation: json.saturation,
    temperature: json.temperature ?? 0,
    gradeShadows: col(json.gradeShadows ?? '#ffffff'),
    gradeMids: col(json.gradeMids ?? '#ffffff'),
    gradeHighlights: col(json.gradeHighlights ?? '#ffffff'),
    vignette: json.vignette,
    fisheye: json.fisheye ?? VISUAL_DEFAULTS.fisheye,
    grain: json.grain,
    aberration: json.aberration,
    flareEnabled: json.flareEnabled ?? VISUAL_DEFAULTS.flareEnabled,
    flareIntensity: json.flareIntensity ?? VISUAL_DEFAULTS.flareIntensity,
    flareScale: json.flareScale ?? VISUAL_DEFAULTS.flareScale,
    flareEdgeFade: json.flareEdgeFade ?? VISUAL_DEFAULTS.flareEdgeFade,
    flareAllowOffScreen: json.flareAllowOffScreen ?? VISUAL_DEFAULTS.flareAllowOffScreen,
    flareOcclusionFade: json.flareOcclusionFade ?? VISUAL_DEFAULTS.flareOcclusionFade,
    shadowIntensity: json.shadowIntensity ?? 1,
    shadowColor: col(json.shadowColor ?? '#000000'),
  };
}

/**
 * @param {object} ctx scene wiring from main.js
 */
export function createVisualsEditor(ctx) {
  const {
    renderer, scene, sky, sun, sunDir, hemi, ambient, lightProbe,
    terrain, grass, vegetation, barrels, trucks, post, shadowTint, fx, clouds, lensFlare,
    getEnvIntensity, setEnvIntensity,
    tanks = [],
    initial = VISUAL_DEFAULTS,
    game = null,
  } = ctx;

  function applyTankPbr(state) {
    if (!state) return;
    for (const t of tanks) {
      for (const [key, matName] of TANK_PBR) {
        const s = state[key];
        if (s) t.setPbr(matName, s.metal, s.rough);
      }
    }
  }

  function readTankPbr() {
    const src = tanks[0];
    const out = {};
    for (const [key, matName] of TANK_PBR) {
      const m = src?.pbrMats.get(matName)?.[0];
      const d = VISUAL_DEFAULTS.tank[key];
      out[key] = m
        ? { metal: m.metalness, rough: m.roughness }
        : { metal: d.metal, rough: d.rough };
    }
    return out;
  }

  const fogColor = sky.userData.fogColor;
  const gU = grass.material.uniforms;
  const bloom = post.bloom;
  const grade = post.grade.uniforms;
  const finish = post.finish.uniforms;

  let elev = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sunDir.y, -1, 1)));
  let az = THREE.MathUtils.radToDeg(Math.atan2(sunDir.z, sunDir.x));

  function applySunDir() {
    const el = THREE.MathUtils.degToRad(elev);
    const a = THREE.MathUtils.degToRad(az);
    sunDir.set(Math.cos(el) * Math.cos(a), Math.sin(el), Math.cos(el) * Math.sin(a)).normalize();
    sky.sunPosition.value.copy(sunDir);
    terrain.water.sunDirection.value.copy(sunDir);
  }

  function applySky(s) {
    sky.turbidity.value = s.turbidity;
    sky.rayleigh.value = s.rayleigh;
    sky.mieCoefficient.value = s.mieCoefficient;
    sky.mieDirectionalG.value = s.mieDirectionalG;
    sky.cloudCoverage.value = s.cloudCoverage;
    sky.cloudDensity.value = s.cloudDensity;
    sky.cloudElevation.value = s.cloudElevation;
    sky.showSunDisc.value = s.showSunDisc ? 1 : 0;
    if (renderer) renderer.toneMappingExposure = s.toneExposure;
  }

  function readState() {
    return {
      horizon: fogColor.clone(),
      fogNear: scene.fog.near,
      fogFar: scene.fog.far,
      elev,
      az,
      turbidity: sky.turbidity.value,
      rayleigh: sky.rayleigh.value,
      mieCoefficient: sky.mieCoefficient.value,
      mieDirectionalG: sky.mieDirectionalG.value,
      cloudCoverage: sky.cloudCoverage.value,
      cloudDensity: sky.cloudDensity.value,
      cloudElevation: sky.cloudElevation.value,
      showSunDisc: !!sky.showSunDisc.value,
      toneExposure: renderer?.toneMappingExposure ?? 0.8,
      sunIntensity: sun.intensity,
      sunColor: sun.color.clone(),
      hemiSky: hemi.color.clone(),
      hemiGround: hemi.groundColor.clone(),
      hemiIntensity: hemi.intensity,
      ambient: ambient.intensity,
      lightProbe: lightProbe?.intensity ?? 0,
      env: getEnvIntensity(),
      tank: readTankPbr(),
      ground: {
        grass: terrain.palette.grass.clone(),
        dry: terrain.palette.dry.clone(),
        dirt: terrain.palette.dirt.clone(),
        sand: terrain.palette.sand.clone(),
        wetSand: terrain.palette.wetSand.clone(),
        rock: terrain.palette.rock.clone(),
        concrete: terrain.palette.concrete.clone(),
        water: terrain.palette.water.clone(),
      },
      grassBase: gU.uBaseColor.value.clone(),
      grassTip1: gU.uTipColor1.value.clone(),
      grassTip2: gU.uTipColor2.value.clone(),
      grassIntensity: gU.uGrassLightIntensity.value,
      wind: vegetation?.getWind?.() ?? 0,
      palmAmount: vegetation?.getPalmAmount?.() ?? 1,
      plantAmount: vegetation?.getPlantAmount?.() ?? 1,
      palmBrightness: vegetation?.getPalmBrightness?.() ?? 1,
      foliageBrightness: vegetation?.getFoliageBrightness?.() ?? 1,
      bloom: bloom.strength,
      bloomRadius: bloom.radius,
      bloomThresh: bloom.threshold,
      exposure: grade.exposure.value,
      contrast: grade.contrast.value,
      saturation: grade.saturation.value,
      temperature: grade.temperature.value,
      gradeShadows: grade.shadows.value.clone(),
      gradeMids: grade.midtones.value.clone(),
      gradeHighlights: grade.highlights.value.clone(),
      vignette: grade.vignetteIntensity.value,
      fisheye: grade.fisheye.value,
      grain: finish.grain.value,
      aberration: finish.aberration.value,
      flareEnabled: lensFlare?.enabled ?? true,
      flareIntensity: lensFlare?.intensity ?? VISUAL_DEFAULTS.flareIntensity,
      flareScale: lensFlare?.scale ?? VISUAL_DEFAULTS.flareScale,
      flareEdgeFade: lensFlare?.edgeFade ?? VISUAL_DEFAULTS.flareEdgeFade,
      flareAllowOffScreen: lensFlare?.allowOffScreen ?? VISUAL_DEFAULTS.flareAllowOffScreen,
      flareOcclusionFade: lensFlare?.occlusionFade ?? VISUAL_DEFAULTS.flareOcclusionFade,
      shadowIntensity: sun.shadow.intensity,
      shadowColor: shadowTint.value.clone(),
    };
  }

  function writeState(s) {
    fogColor.copy(s.horizon);
    scene.fog.color.copy(s.horizon);
    scene.fog.near = s.fogNear;
    scene.fog.far = s.fogFar;
    grass.setFog(s.horizon, s.fogNear, s.fogFar);
    elev = s.elev;
    az = s.az;
    applySunDir();
    applySky(s);
    sun.intensity = s.sunIntensity;
    sun.color.copy(s.sunColor);
    hemi.color.copy(s.hemiSky);
    hemi.groundColor.copy(s.hemiGround);
    hemi.intensity = s.hemiIntensity;
    ambient.intensity = s.ambient;
    if (lightProbe) lightProbe.intensity = s.lightProbe ?? 1;
    setEnvIntensity(s.env);
    applyTankPbr(s.tank);
    terrain.setPalette(s.ground);
    grass.setColors({
      base: s.grassBase,
      tip1: s.grassTip1,
      tip2: s.grassTip2,
      intensity: s.grassIntensity,
    });
    fx?.setGrassColors?.({ base: s.grassBase, tip1: s.grassTip1, tip2: s.grassTip2 });
    // Grass wind is disabled; slider only drives vegetation lean.
    vegetation?.setWind?.(s.wind);
    vegetation?.setPalmAmount?.(s.palmAmount ?? 1);
    vegetation?.setPlantAmount?.(s.plantAmount ?? 1);
    vegetation?.setPalmBrightness?.(s.palmBrightness ?? 1);
    vegetation?.setFoliageBrightness?.(s.foliageBrightness ?? 1);
    bloom.strength = s.bloom;
    bloom.radius = s.bloomRadius;
    bloom.threshold = s.bloomThresh;
    grade.exposure.value = s.exposure;
    grade.contrast.value = s.contrast;
    grade.saturation.value = s.saturation;
    grade.temperature.value = s.temperature ?? 0;
    if (s.gradeShadows) grade.shadows.value.copy(s.gradeShadows);
    if (s.gradeMids) grade.midtones.value.copy(s.gradeMids);
    if (s.gradeHighlights) grade.highlights.value.copy(s.gradeHighlights);
    grade.vignetteIntensity.value = s.vignette;
    grade.fisheye.value = s.fisheye ?? VISUAL_DEFAULTS.fisheye;
    finish.grain.value = s.grain;
    finish.aberration.value = s.aberration;
    if (lensFlare) {
      lensFlare.enabled = s.flareEnabled ?? true;
      lensFlare.intensity = s.flareIntensity ?? VISUAL_DEFAULTS.flareIntensity;
      lensFlare.scale = s.flareScale ?? VISUAL_DEFAULTS.flareScale;
      lensFlare.edgeFade = s.flareEdgeFade ?? VISUAL_DEFAULTS.flareEdgeFade;
      lensFlare.allowOffScreen = s.flareAllowOffScreen ?? VISUAL_DEFAULTS.flareAllowOffScreen;
      lensFlare.occlusionFade = s.flareOcclusionFade ?? VISUAL_DEFAULTS.flareOcclusionFade;
    }
    sun.shadow.intensity = s.shadowIntensity ?? 1;
    if (s.shadowColor) shadowTint.value.copy(s.shadowColor);
  }

  // Bake saved look first so Reset returns here
  if (initial) writeState(hydrate(initial));
  const defaults = readState();

  /** Plain JSON snapshot (colors as #hex) — pasteable back into chat. */
  function exportSettings() {
    const s = readState();
    const c = (col) => `#${col.getHexString()}`;
    return {
      horizon: c(s.horizon),
      fogNear: s.fogNear,
      fogFar: s.fogFar,
      elev: s.elev,
      az: s.az,
      turbidity: s.turbidity,
      rayleigh: s.rayleigh,
      mieCoefficient: s.mieCoefficient,
      mieDirectionalG: s.mieDirectionalG,
      cloudCoverage: s.cloudCoverage,
      cloudDensity: s.cloudDensity,
      cloudElevation: s.cloudElevation,
      showSunDisc: s.showSunDisc,
      toneExposure: s.toneExposure,
      sunIntensity: s.sunIntensity,
      sunColor: c(s.sunColor),
      hemiSky: c(s.hemiSky),
      hemiGround: c(s.hemiGround),
      hemiIntensity: s.hemiIntensity,
      ambient: s.ambient,
      lightProbe: s.lightProbe,
      env: s.env,
      tank: s.tank,
      ground: {
        grass: c(s.ground.grass),
        dry: c(s.ground.dry),
        dirt: c(s.ground.dirt),
        sand: c(s.ground.sand),
        wetSand: c(s.ground.wetSand),
        rock: c(s.ground.rock),
        concrete: c(s.ground.concrete),
        water: c(s.ground.water),
      },
      grassBase: c(s.grassBase),
      grassTip1: c(s.grassTip1),
      grassTip2: c(s.grassTip2),
      grassIntensity: s.grassIntensity,
      wind: s.wind,
      palmAmount: s.palmAmount,
      plantAmount: s.plantAmount,
      palmBrightness: s.palmBrightness,
      foliageBrightness: s.foliageBrightness,
      bloom: s.bloom,
      bloomRadius: s.bloomRadius,
      bloomThresh: s.bloomThresh,
      exposure: s.exposure,
      contrast: s.contrast,
      saturation: s.saturation,
      temperature: s.temperature,
      gradeShadows: c(s.gradeShadows),
      gradeMids: c(s.gradeMids),
      gradeHighlights: c(s.gradeHighlights),
      vignette: s.vignette,
      fisheye: s.fisheye,
      grain: s.grain,
      aberration: s.aberration,
      flareEnabled: s.flareEnabled,
      flareIntensity: s.flareIntensity,
      flareScale: s.flareScale,
      flareEdgeFade: s.flareEdgeFade,
      flareAllowOffScreen: s.flareAllowOffScreen,
      flareOcclusionFade: s.flareOcclusionFade,
      shadowIntensity: s.shadowIntensity,
      shadowColor: c(s.shadowColor),
    };
  }

  // —— UI shell ————————————————————————————————————————————————
  const panel = document.createElement('aside');
  panel.id = 'visuals';
  panel.classList.add('hidden');
  panel.innerHTML = `
    <header>
      <strong>Visuals</strong>
      <span class="vis-hint">V</span>
      <button type="button" class="vis-close" title="Close">×</button>
    </header>
    <div class="vis-body"></div>
    <div class="vis-footer">
      <button type="button" class="vis-copy">Copy settings</button>
      <button type="button" class="vis-reset">Reset</button>
    </div>`;
  const body = panel.querySelector('.vis-body');
  document.body.append(panel);

  for (const type of ['mousedown', 'pointerdown', 'click', 'wheel', 'dblclick']) {
    panel.addEventListener(type, (e) => e.stopPropagation());
  }

  /** @type {{ sync: () => void }[]} */
  const controls = [];

  function addSection(title) {
    const el = document.createElement('details');
    el.open = true;
    el.className = 'vis-section';
    const sum = document.createElement('summary');
    sum.textContent = title;
    el.append(sum);
    body.append(el);
    return el;
  }

  function addColor(parent, label, get, set) {
    const row = document.createElement('label');
    row.className = 'vis-row';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = get();
    input.addEventListener('input', () => set(input.value));
    row.append(span, input);
    parent.append(row);
    controls.push({ sync() { input.value = get(); } });
  }

  function addSlider(parent, label, min, max, step, get, set) {
    const row = document.createElement('label');
    row.className = 'vis-row';
    const span = document.createElement('span');
    span.textContent = label;
    const wrap = document.createElement('div');
    wrap.className = 'vis-slider';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(get());
    const val = document.createElement('em');
    val.textContent = format(get(), step);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      val.textContent = format(v, step);
      set(v);
    });
    wrap.append(input, val);
    row.append(span, wrap);
    parent.append(row);
    controls.push({
      sync() {
        const v = get();
        input.value = String(v);
        val.textContent = format(v, step);
      },
    });
  }

  function addToggle(parent, label, get, set) {
    const row = document.createElement('label');
    row.className = 'vis-row';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = get();
    input.addEventListener('change', () => set(input.checked));
    row.append(span, input);
    parent.append(row);
    controls.push({ sync() { input.checked = get(); } });
  }

  function syncUi() {
    for (const c of controls) c.sync();
  }

  // Game (dev) — not part of the visual look, so Reset / Copy settings leave these alone
  if (game) {
    const s = addSection('Game');
    addToggle(s, 'Solo (no enemy)', game.getSolo, game.setSolo);
    addToggle(s, 'Show AI path', game.getShowPath, game.setShowPath);
    if (game.getMusicMuted && game.setMusicMuted) {
      addToggle(s, 'Mute music', game.getMusicMuted, game.setMusicMuted);
    }
    if (game.getMusicVolume && game.setMusicVolume) {
      addSlider(s, 'Music volume', 0, 1, 0.01, game.getMusicVolume, game.setMusicVolume);
    }
    if (game.getDebug && game.setDebug) {
      addToggle(s, 'Debug (F3)', game.getDebug, game.setDebug);
    }
    if (game.getFly && game.setFly) {
      addToggle(s, 'Freefly / photomode (F)', game.getFly, game.setFly);
    }
    if (game.getFlyFov && game.setFlyFov) {
      addSlider(s, 'Photomode FOV', 15, 120, 1, game.getFlyFov, game.setFlyFov);
    }
    if (game.getFlyTilt && game.setFlyTilt) {
      addSlider(s, 'Photomode tilt', -45, 45, 1, game.getFlyTilt, game.setFlyTilt);
    }
    if (post.motionBlur) {
      addToggle(s, 'Motion blur',
        () => post.motionBlur.enabled,
        (v) => { post.motionBlur.enabled = v; });
    }
  }

  // Sky & fog (SkyMesh / webgpu_sky params)
  {
    const s = addSection('Sky & fog');
    addColor(s, 'Fog colour', () => hexOf(fogColor), (v) => {
      fogColor.set(v);
      scene.fog.color.copy(fogColor);
      grass.setFog(fogColor);
    });
    addSlider(s, 'Fog near', 10, 200, 1, () => scene.fog.near, (v) => {
      scene.fog.near = v;
      grass.setFog(undefined, v, undefined);
    });
    addSlider(s, 'Fog far', 40, 500, 1, () => scene.fog.far, (v) => {
      scene.fog.far = v;
      grass.setFog(undefined, undefined, v);
    });
    addSlider(s, 'Turbidity', 0, 20, 0.1, () => sky.turbidity.value, (v) => {
      sky.turbidity.value = v;
    });
    addSlider(s, 'Rayleigh', 0, 4, 0.001, () => sky.rayleigh.value, (v) => {
      sky.rayleigh.value = v;
    });
    addSlider(s, 'Mie coeff', 0, 0.1, 0.001, () => sky.mieCoefficient.value, (v) => {
      sky.mieCoefficient.value = v;
    });
    addSlider(s, 'Mie G', 0, 1, 0.001, () => sky.mieDirectionalG.value, (v) => {
      sky.mieDirectionalG.value = v;
    });
    addSlider(s, 'Tone exposure', 0, 1, 0.01, () => renderer.toneMappingExposure, (v) => {
      renderer.toneMappingExposure = v;
    });
    addToggle(s, 'Sun disc', () => !!sky.showSunDisc.value, (v) => {
      sky.showSunDisc.value = v ? 1 : 0;
    });
    addSlider(s, 'Cloud coverage', 0, 1, 0.01, () => sky.cloudCoverage.value, (v) => {
      sky.cloudCoverage.value = v;
    });
    addSlider(s, 'Cloud density', 0, 1, 0.01, () => sky.cloudDensity.value, (v) => {
      sky.cloudDensity.value = v;
    });
    addSlider(s, 'Cloud elevation', 0, 1, 0.01, () => sky.cloudElevation.value, (v) => {
      sky.cloudElevation.value = v;
    });
  }

  // Sun
  {
    const s = addSection('Sun');
    addSlider(s, 'Height', 2, 88, 1, () => elev, (v) => { elev = v; applySunDir(); });
    addSlider(s, 'Azimuth', -180, 180, 1, () => az, (v) => { az = v; applySunDir(); });
    addSlider(s, 'Strength', 0, 8, 0.05, () => sun.intensity, (v) => { sun.intensity = v; });
    addColor(s, 'Sun colour', () => hexOf(sun.color), (v) => {
      sun.color.set(v);
      terrain.water.sunColor.value.copy(sun.color);
    });
    addSlider(s, 'Shadow strength', 0, 1, 0.02, () => sun.shadow.intensity, (v) => {
      sun.shadow.intensity = v;
    });
    addColor(s, 'Shadow colour', () => hexOf(shadowTint.value), (v) => shadowTint.value.set(v));
    if (clouds) {
      addSlider(s, 'Cloud shadow', 0, 1, 0.02, () => clouds.strength, (v) => { clouds.strength = v; });
      // Drives the sky's cloud drift; shadows follow it.
      addSlider(s, 'Cloud speed', 0, 10, 0.1, () => sky.cloudSpeed.value / SKY_CLOUD_SPEED, (v) => {
        sky.cloudSpeed.value = v * SKY_CLOUD_SPEED;
      });
    }
  }

  // Fill
  {
    const s = addSection('Fill light');
    if (lightProbe) {
      addSlider(s, 'Light probe', 0, 2, 0.02, () => lightProbe.intensity, (v) => {
        lightProbe.intensity = v;
      });
    }
    addSlider(s, 'Env map', 0, 2, 0.02, getEnvIntensity, setEnvIntensity);
    addColor(s, 'Hemi sky', () => hexOf(hemi.color), (v) => hemi.color.set(v));
    addColor(s, 'Hemi ground', () => hexOf(hemi.groundColor), (v) => hemi.groundColor.set(v));
    addSlider(s, 'Hemi strength', 0, 2, 0.02, () => hemi.intensity, (v) => { hemi.intensity = v; });
    addSlider(s, 'Ambient', 0, 1, 0.01, () => ambient.intensity, (v) => { ambient.intensity = v; });
  }

  if (tanks.length) {
    const s = addSection('Tank');
    for (const [key, matName, label] of TANK_PBR) {
      addSlider(s, `${label} metallic`, 0, 1, 0.01,
        () => readTankPbr()[key].metal,
        (v) => {
          for (const t of tanks) {
            const rough = t.pbrMats.get(matName)?.[0]?.roughness ?? VISUAL_DEFAULTS.tank[key].rough;
            t.setPbr(matName, v, rough);
          }
        });
      addSlider(s, `${label} roughness`, 0, 1, 0.01,
        () => readTankPbr()[key].rough,
        (v) => {
          for (const t of tanks) {
            const metal = t.pbrMats.get(matName)?.[0]?.metalness ?? VISUAL_DEFAULTS.tank[key].metal;
            t.setPbr(matName, metal, v);
          }
        });
    }
    addSlider(s, 'Enemy LOD distance ×', 0.25, 4, 0.05, getTankLodScale, setTankLodScale);
  }

  // Ground
  {
    const s = addSection('Ground');
    // Soil, rock and beach are photo maps. Concrete and water stay flat colours.
    for (const [key, label] of [
      ['concrete', 'Concrete'],
      ['water', 'Water'],
    ]) {
      addColor(s, label, () => hexOf(terrain.palette[key]), (v) => terrain.setPalette({ [key]: v }));
    }
  }

  // Grass
  {
    const s = addSection('Grass');
    addColor(s, 'Base', () => hexOf(gU.uBaseColor.value), (v) => {
      grass.setColors({ base: v });
      fx?.setGrassColors?.({ base: v });
    });
    addColor(s, 'Tip A', () => hexOf(gU.uTipColor1.value), (v) => {
      grass.setColors({ tip1: v });
      fx?.setGrassColors?.({ tip1: v });
    });
    addColor(s, 'Tip B', () => hexOf(gU.uTipColor2.value), (v) => {
      grass.setColors({ tip2: v });
      fx?.setGrassColors?.({ tip2: v });
    });
    addSlider(s, 'Brightness', 0.2, 2.5, 0.05, () => gU.uGrassLightIntensity.value, (v) => {
      grass.setColors({ intensity: v });
    });
    addSlider(s, 'Wind strength', 0, 0.15, 0.005, () => vegetation?.getWind?.() ?? 0, (v) => {
      vegetation?.setWind?.(v);
    });
    addSlider(s, 'LOD distance ×', 0.25, 4, 0.05, () => grass.getLodScale(), (v) => grass.setLodScale(v));
  }

  // Vegetation (palms / tropical pack)
  if (vegetation) {
    const s = addSection('Vegetation');
    addSlider(s, 'Palm trees', 0, 2, 0.05, () => vegetation.getPalmAmount(), (v) => {
      vegetation.setPalmAmount(v);
    });
    addSlider(s, 'Ground plants', 0, 2, 0.05, () => vegetation.getPlantAmount(), (v) => {
      vegetation.setPlantAmount(v);
    });
    addSlider(s, 'Palm tree brightness', 0.2, 2.5, 0.05, () => vegetation.getPalmBrightness(), (v) => {
      vegetation.setPalmBrightness(v);
    });
    addSlider(s, 'Foliage brightness', 0.2, 2.5, 0.05, () => vegetation.getFoliageBrightness(), (v) => {
      vegetation.setFoliageBrightness(v);
    });
    addSlider(s, 'LOD distance ×', 0.25, 4, 0.05, () => vegetation.getLodScale(), (v) => vegetation.setLodScale(v));
    addSlider(s, 'Plant cull (m)', 10, 400, 5, () => vegetation.getPlantCull(), (v) => vegetation.setPlantCull(v));
  }

  if (barrels || trucks) {
    const s = addSection('Props');
    if (barrels) {
      addSlider(s, 'Barrel LOD distance ×', 0.25, 4, 0.05, () => barrels.getLodScale(), (v) => barrels.setLodScale(v));
    }
    if (trucks) {
      addSlider(s, 'Truck LOD distance ×', 0.25, 4, 0.05, () => trucks.getLodScale(), (v) => trucks.setLodScale(v));
    }
  }

  // Grading — whole-image look
  {
    const s = addSection('Grading');
    addSlider(s, 'Exposure', 0.2, 2.5, 0.05, () => grade.exposure.value, (v) => { grade.exposure.value = v; });
    addSlider(s, 'Contrast', 0.5, 1.8, 0.02, () => grade.contrast.value, (v) => { grade.contrast.value = v; });
    addSlider(s, 'Saturation', 0, 2, 0.02, () => grade.saturation.value, (v) => { grade.saturation.value = v; });
    addSlider(s, 'Temperature', -1, 1, 0.02, () => grade.temperature.value, (v) => {
      grade.temperature.value = v;
    });
    addColor(s, 'Shadows', () => hexOf(grade.shadows.value), (v) => grade.shadows.value.set(v));
    addColor(s, 'Mids', () => hexOf(grade.midtones.value), (v) => grade.midtones.value.set(v));
    addColor(s, 'Highlights', () => hexOf(grade.highlights.value), (v) => grade.highlights.value.set(v));
    addSlider(s, 'Vignette', 0, 1, 0.02, () => grade.vignetteIntensity.value, (v) => {
      grade.vignetteIntensity.value = v;
    });
  }

  // Post
  {
    const s = addSection('Post');
    addSlider(s, 'Fisheye', 0, 2, 0.01, () => grade.fisheye.value, (v) => {
      grade.fisheye.value = v;
    });
    addSlider(s, 'Bloom', 0, 2.5, 0.05, () => bloom.strength, (v) => { bloom.strength = v; });
    addSlider(s, 'Bloom radius', 0, 1.5, 0.05, () => bloom.radius, (v) => { bloom.radius = v; });
    addSlider(s, 'Bloom thresh', 0, 1.5, 0.05, () => bloom.threshold, (v) => { bloom.threshold = v; });
    addSlider(s, 'Grain', 0, 0.2, 0.005, () => finish.grain.value, (v) => { finish.grain.value = v; });
    addSlider(s, 'Aberration', 0, 0.008, 0.0001, () => finish.aberration.value, (v) => {
      finish.aberration.value = v;
    });
  }

  // Lens flare (sun) — PlayCanvas CameraFrame knobs
  if (lensFlare) {
    const s = addSection('Lens flare');
    addToggle(s, 'Enabled', () => lensFlare.enabled, (v) => { lensFlare.enabled = v; });
    addSlider(s, 'Intensity', 0, 2, 0.01, () => lensFlare.intensity, (v) => { lensFlare.intensity = v; });
    addSlider(s, 'Scale', 0.1, 3, 0.05, () => lensFlare.scale, (v) => { lensFlare.scale = v; });
    addSlider(s, 'Edge fade', 0, 1, 0.01, () => lensFlare.edgeFade, (v) => { lensFlare.edgeFade = v; });
    addToggle(s, 'Allow off-screen', () => lensFlare.allowOffScreen, (v) => { lensFlare.allowOffScreen = v; });
    addSlider(s, 'Occlusion fade', 0, 1, 0.01, () => lensFlare.occlusionFade, (v) => {
      lensFlare.occlusionFade = v;
    });
  }

  let open = false;
  function setOpen(v) {
    open = !!v;
    panel.classList.toggle('hidden', !open);
    if (open && document.pointerLockElement) document.exitPointerLock();
  }

  panel.querySelector('.vis-close').addEventListener('click', () => setOpen(false));
  panel.querySelector('.vis-reset').addEventListener('click', () => {
    writeState(defaults);
    syncUi();
  });

  const copyBtn = panel.querySelector('.vis-copy');
  let copyResetTimer = 0;
  copyBtn.addEventListener('click', async () => {
    const text = JSON.stringify(exportSettings(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback when clipboard API is blocked (e.g. insecure context)
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    copyBtn.textContent = 'Copied!';
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => { copyBtn.textContent = 'Copy settings'; }, 1500);
  });

  return {
    panel,
    get open() { return open; },
    setOpen,
    toggle() { setOpen(!open); },
    syncUi,
    exportSettings,
  };
}
