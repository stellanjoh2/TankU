// Live Visuals editor — sky / sun / ground / grass / grading / post. Toggle with V.
import * as THREE from 'three';
import { VISUAL_DEFAULTS } from './visualDefaults.js';

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
    zenith: col(json.zenith),
    fogNear: json.fogNear,
    fogFar: json.fogFar,
    elev: json.elev,
    az: json.az,
    sunIntensity: json.sunIntensity,
    sunColor: col(json.sunColor),
    skySun: col(json.skySun).multiplyScalar(6.5),
    hemiSky: col(json.hemiSky),
    hemiGround: col(json.hemiGround),
    hemiIntensity: json.hemiIntensity,
    ambient: json.ambient,
    env: json.env,
    ground: {
      grass: col(g.grass),
      dry: col(g.dry),
      dirt: col(g.dirt),
      sand: col(g.sand),
      wetSand: col(g.wetSand),
      rock: col(g.rock),
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
    grain: json.grain,
    aberration: json.aberration,
    shadowIntensity: json.shadowIntensity ?? 1,
    shadowColor: col(json.shadowColor ?? '#000000'),
  };
}

/**
 * @param {object} ctx scene wiring from main.js
 */
export function createVisualsEditor(ctx) {
  const {
    scene, sky, sun, sunDir, hemi, ambient,
    terrain, grass, vegetation, post, shadowTint,
    getEnvIntensity, setEnvIntensity,
    initial = VISUAL_DEFAULTS,
    game = null,
  } = ctx;

  const horizon = sky.material.uniforms.horizon.value;
  const zenith = sky.material.uniforms.zenith.value;
  const skySun = sky.material.uniforms.sunColor.value;
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
    sky.material.uniforms.sunDir.value.copy(sunDir);
  }

  function readState() {
    return {
      horizon: horizon.clone(),
      zenith: zenith.clone(),
      fogNear: scene.fog.near,
      fogFar: scene.fog.far,
      elev,
      az,
      sunIntensity: sun.intensity,
      sunColor: sun.color.clone(),
      skySun: skySun.clone(),
      hemiSky: hemi.color.clone(),
      hemiGround: hemi.groundColor.clone(),
      hemiIntensity: hemi.intensity,
      ambient: ambient.intensity,
      env: getEnvIntensity(),
      ground: {
        grass: terrain.palette.grass.clone(),
        dry: terrain.palette.dry.clone(),
        dirt: terrain.palette.dirt.clone(),
        sand: terrain.palette.sand.clone(),
        wetSand: terrain.palette.wetSand.clone(),
        rock: terrain.palette.rock.clone(),
        water: terrain.palette.water.clone(),
      },
      grassBase: gU.uBaseColor.value.clone(),
      grassTip1: gU.uTipColor1.value.clone(),
      grassTip2: gU.uTipColor2.value.clone(),
      grassIntensity: gU.uGrassLightIntensity.value,
      wind: gU.uWindAmp.value,
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
      grain: finish.grain.value,
      aberration: finish.aberration.value,
      shadowIntensity: sun.shadow.intensity,
      shadowColor: shadowTint.value.clone(),
    };
  }

  function writeState(s) {
    horizon.copy(s.horizon);
    zenith.copy(s.zenith);
    scene.fog.color.copy(s.horizon);
    scene.fog.near = s.fogNear;
    scene.fog.far = s.fogFar;
    grass.setFog(s.horizon, s.fogNear, s.fogFar);
    elev = s.elev;
    az = s.az;
    applySunDir();
    sun.intensity = s.sunIntensity;
    sun.color.copy(s.sunColor);
    skySun.copy(s.skySun);
    hemi.color.copy(s.hemiSky);
    hemi.groundColor.copy(s.hemiGround);
    hemi.intensity = s.hemiIntensity;
    ambient.intensity = s.ambient;
    setEnvIntensity(s.env);
    terrain.setPalette(s.ground);
    grass.setColors({
      base: s.grassBase,
      tip1: s.grassTip1,
      tip2: s.grassTip2,
      intensity: s.grassIntensity,
    });
    gU.uWindAmp.value = s.wind;
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
    finish.grain.value = s.grain;
    finish.aberration.value = s.aberration;
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
      zenith: c(s.zenith),
      fogNear: s.fogNear,
      fogFar: s.fogFar,
      elev: s.elev,
      az: s.az,
      sunIntensity: s.sunIntensity,
      sunColor: c(s.sunColor),
      // stored ×6.5 in the shader; export matches the colour-picker hex
      skySun: c(s.skySun.clone().multiplyScalar(1 / 6.5)),
      hemiSky: c(s.hemiSky),
      hemiGround: c(s.hemiGround),
      hemiIntensity: s.hemiIntensity,
      ambient: s.ambient,
      env: s.env,
      ground: {
        grass: c(s.ground.grass),
        dry: c(s.ground.dry),
        dirt: c(s.ground.dirt),
        sand: c(s.ground.sand),
        wetSand: c(s.ground.wetSand),
        rock: c(s.ground.rock),
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
      grain: s.grain,
      aberration: s.aberration,
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
  }

  // Sky & fog
  {
    const s = addSection('Sky & fog');
    addColor(s, 'Horizon', () => hexOf(horizon), (v) => {
      horizon.set(v);
      scene.fog.color.copy(horizon);
      grass.setFog(horizon);
    });
    addColor(s, 'Zenith', () => hexOf(zenith), (v) => zenith.set(v));
    addSlider(s, 'Fog near', 10, 200, 1, () => scene.fog.near, (v) => {
      scene.fog.near = v;
      grass.setFog(undefined, v, undefined);
    });
    addSlider(s, 'Fog far', 40, 500, 1, () => scene.fog.far, (v) => {
      scene.fog.far = v;
      grass.setFog(undefined, undefined, v);
    });
  }

  // Sun
  {
    const s = addSection('Sun');
    addSlider(s, 'Height', 2, 88, 1, () => elev, (v) => { elev = v; applySunDir(); });
    addSlider(s, 'Azimuth', -180, 180, 1, () => az, (v) => { az = v; applySunDir(); });
    addSlider(s, 'Strength', 0, 8, 0.05, () => sun.intensity, (v) => { sun.intensity = v; });
    addColor(s, 'Sun colour', () => hexOf(sun.color), (v) => sun.color.set(v));
    addColor(s, 'Sky disc', () => {
      const t = skySun.clone().multiplyScalar(1 / 6.5);
      return hexOf(t);
    }, (v) => { skySun.set(v).multiplyScalar(6.5); });
    addSlider(s, 'Shadow strength', 0, 1, 0.02, () => sun.shadow.intensity, (v) => {
      sun.shadow.intensity = v;
    });
    addColor(s, 'Shadow colour', () => hexOf(shadowTint.value), (v) => shadowTint.value.set(v));
  }

  // Fill
  {
    const s = addSection('Fill light');
    addColor(s, 'Hemi sky', () => hexOf(hemi.color), (v) => hemi.color.set(v));
    addColor(s, 'Hemi ground', () => hexOf(hemi.groundColor), (v) => hemi.groundColor.set(v));
    addSlider(s, 'Hemi strength', 0, 2, 0.02, () => hemi.intensity, (v) => { hemi.intensity = v; });
    addSlider(s, 'Ambient', 0, 1, 0.01, () => ambient.intensity, (v) => { ambient.intensity = v; });
    addSlider(s, 'Env light', 0, 1.5, 0.02, getEnvIntensity, setEnvIntensity);
  }

  // Ground
  {
    const s = addSection('Ground');
    for (const [key, label] of [
      ['grass', 'Meadow'],
      ['dry', 'Dry grass'],
      ['dirt', 'Dirt'],
      ['sand', 'Sand'],
      ['wetSand', 'Wet sand'],
      ['rock', 'Rock'],
      ['water', 'Water'],
    ]) {
      addColor(s, label, () => hexOf(terrain.palette[key]), (v) => terrain.setPalette({ [key]: v }));
    }
  }

  // Grass
  {
    const s = addSection('Grass');
    addColor(s, 'Base', () => hexOf(gU.uBaseColor.value), (v) => grass.setColors({ base: v }));
    addColor(s, 'Tip A', () => hexOf(gU.uTipColor1.value), (v) => grass.setColors({ tip1: v }));
    addColor(s, 'Tip B', () => hexOf(gU.uTipColor2.value), (v) => grass.setColors({ tip2: v }));
    addSlider(s, 'Brightness', 0.2, 2.5, 0.05, () => gU.uGrassLightIntensity.value, (v) => {
      grass.setColors({ intensity: v });
    });
    addSlider(s, 'Wind', 0, 0.15, 0.005, () => gU.uWindAmp.value, (v) => { gU.uWindAmp.value = v; });
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
    addSlider(s, 'Bloom', 0, 2.5, 0.05, () => bloom.strength, (v) => { bloom.strength = v; });
    addSlider(s, 'Bloom radius', 0, 1.5, 0.05, () => bloom.radius, (v) => { bloom.radius = v; });
    addSlider(s, 'Bloom thresh', 0, 1.5, 0.05, () => bloom.threshold, (v) => { bloom.threshold = v; });
    addSlider(s, 'Grain', 0, 0.2, 0.005, () => finish.grain.value, (v) => { finish.grain.value = v; });
    addSlider(s, 'Aberration', 0, 0.008, 0.0001, () => finish.aberration.value, (v) => {
      finish.aberration.value = v;
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
    exportSettings,
  };
}
