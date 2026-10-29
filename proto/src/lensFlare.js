// Lens flares — PlayCanvas-style textured elements along a light→screen-centre axis
// (textures from playcanvas/engine examples, MIT / PR #9734).
// Sun: persistent, occlusion + edge fade. Explosion: cheap one-shot pool, same assets.
import * as THREE from 'three/webgpu';
import { texture, uniform, vec3, vec4 } from 'three/tsl';

const TEX_BASE = './textures/lens-flare/';

/** PlayCanvas sun look — offset 0 at sun, 1 at centre, 2 mirrored. Size = screen-height fraction. */
const SUN_LOOK = [
  { shape: 'glow_soft', size: 0.4, color: [1, 0.85, 0.65], intensity: 1.2 },
  { shape: 'burst_star', size: 0.8, color: [1, 0.95, 0.85], intensity: 1.4 },
  { shape: 'anamorphic_streak', size: 0.08, aspect: 18, intensity: 0.6 },
  { shape: 'halo', size: 0.5, color: [1, 0.9, 0.8], intensity: 0.2 },
  {
    shape: 'iris_hexagon',
    offset: 0.45,
    size: 0.05,
    color: [0.5, 0.8, 1],
    intensity: 0.14,
    count: 3,
    spread: 0.35,
  },
  { shape: 'spectrum_arc', offset: 1.1, size: 0.6, rotation: 180, autoRotate: true, intensity: 0.2 },
  { shape: 'iris_round', offset: 1.35, size: 0.2, color: [1, 0.6, 0.35], intensity: 0.16 },
  { shape: 'iris_pentagon', offset: 1.75, size: 0.1, color: [0.6, 1, 0.6], intensity: 0.24 },
  { shape: 'glow_rim', offset: 2.2, size: 0.28, color: [1, 0.5, 0.8], intensity: 0.12 },
  { shape: 'spectrum_smudge', offset: 2.6, size: 0.1, aspect: 2.5, autoRotate: true, intensity: 0.24 },
];

/**
 * Blast look — small core on the hit; ghosts shoot along the optical axis toward the
 * *edges* (offset 0 = blast, 1 = centre, 2 = opposite edge). No big orbs near centre.
 */
const BLAST_LOOK = [
  // Hot white → amber core (matches impact glow / fireball)
  { shape: 'glow_soft', size: 0.28, color: [1, 0.72, 0.32], intensity: 1.0, core: true },
  { shape: 'burst_star', size: 0.32, color: [1, 0.9, 0.55], intensity: 0.4, core: true },
  { shape: 'halo', size: 0.36, color: [1, 0.45, 0.12], intensity: 0.45, core: true },
  // Near the blast — yellow / orange peel-off
  { shape: 'iris_hexagon', offset: 0.22, size: 0.26, color: [1, 0.82, 0.28], intensity: 2.4 },
  { shape: 'iris_hexagon', offset: 0.42, size: 0.38, color: [1, 0.55, 0.14], intensity: 2.6 },
  { shape: 'iris_round', offset: 0.58, size: 0.3, color: [1, 0.38, 0.08], intensity: 2.0 },
  // Far side — deeper ember reds / ambers
  { shape: 'iris_hexagon', offset: 1.35, size: 0.48, color: [1, 0.48, 0.1], intensity: 2.8 },
  { shape: 'iris_round', offset: 1.55, size: 0.55, color: [1, 0.28, 0.06], intensity: 2.5 },
  { shape: 'iris_hexagon', offset: 1.8, size: 0.4, color: [1, 0.62, 0.18], intensity: 2.7 },
  { shape: 'iris_hexagon', offset: 2.05, size: 0.52, color: [0.95, 0.22, 0.05], intensity: 2.3 },
  { shape: 'glow_rim', offset: 2.35, size: 0.58, color: [1, 0.35, 0.08], intensity: 1.8 },
];

/** NDC radius — ghosts inside this are hidden so nothing stares at the camera. */
const BLAST_CENTER_DEAD = 0.28;
/** If the blast is closer to centre than this, push the ghost axis outward. */
const BLAST_MIN_AXIS = 0.6;
/** How much the ghost axis may follow the live view while fading (1 = full spin). */
const BLAST_AXIS_FOLLOW = 0.25;

const ALL_SHAPES = [...new Set([...SUN_LOOK, ...BLAST_LOOK].map((e) => e.shape))];
const PLANE = /* @__PURE__ */ new THREE.PlaneGeometry(1, 1);
const POOL = 2; // concurrent blast flares (drum chains)
const BLAST_FADE = 3.2; // opacity / s (~0.3 s)

function expandLook(look) {
  const out = [];
  for (const el of look) {
    const count = Math.max(1, el.count | 0 || 1);
    const spread = el.spread ?? 0;
    const base = el.offset ?? 0;
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      out.push({
        shape: el.shape,
        offset: base + (t - 0.5) * spread,
        size: el.size ?? 0.1,
        aspect: el.aspect ?? 1,
        rotation: ((el.rotation ?? 0) * Math.PI) / 180,
        autoRotate: !!el.autoRotate,
        color: el.color ?? [1, 1, 1],
        intensity: el.intensity ?? 1,
        core: !!el.core,
      });
    }
  }
  return out;
}

async function loadMaps(names = ALL_SHAPES) {
  const loader = new THREE.TextureLoader();
  const maps = {};
  await Promise.all(names.map(async (name) => {
    const tex = await loader.loadAsync(`${TEX_BASE}${name}.png`);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    maps[name] = tex;
  }));
  return maps;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.punchy]  One/One additive + alpha-as-mask (reads on bright scenes)
 * @param {number} [opts.renderOrder]
 */
function buildElements(root, look, maps, uVisibility, uIntensity, opts = {}) {
  const punchy = !!opts.punchy;
  const renderOrder = opts.renderOrder ?? 1000;
  const items = [];
  for (const el of expandLook(look)) {
    const map = maps[el.shape];
    if (!map) continue;

    const uTint = uniform(new THREE.Color(el.color[0], el.color[1], el.color[2]));
    const uElIntensity = uniform(el.intensity);
    const sample = texture(map);
    const gain = uElIntensity.mul(uIntensity).mul(uVisibility);
    const tinted = sample.rgb.mul(vec3(uTint.r, uTint.g, uTint.b));

    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
      lights: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    if (punchy) {
      // Textures are white×alpha. Premultiply so AdditiveBlending’s src×a doesn’t square gain,
      // and One/One keeps ghosts readable over bright daytime terrain.
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneFactor;
      mat.blendEquationAlpha = THREE.AddEquation;
      mat.blendSrcAlpha = THREE.ZeroFactor;
      mat.blendDstAlpha = THREE.OneFactor;
      mat.colorNode = vec4(tinted.mul(sample.a).mul(gain), 1);
    } else {
      mat.blending = THREE.AdditiveBlending;
      mat.colorNode = vec4(tinted.mul(gain), sample.a.mul(gain));
    }

    const mesh = new THREE.Mesh(PLANE, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    root.add(mesh);
    items.push({ mesh, el });
  }
  return items;
}

function screenPlane(camera) {
  const dist = 1.5;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const planeH = 2 * Math.tan(vFov * 0.5) * dist;
  const planeW = planeH * camera.aspect;
  return { dist, planeH, planeW };
}

function placeElements(items, ndcX, ndcY, camera, scale) {
  const { dist, planeH, planeW } = screenPlane(camera);
  const axisX = -ndcX;
  const axisY = -ndcY;
  const axisAng = Math.atan2(axisY, axisX);

  for (const { mesh, el } of items) {
    const ox = ndcX + axisX * el.offset;
    const oy = ndcY + axisY * el.offset;
    mesh.visible = true;
    mesh.position.set(ox * planeW * 0.5, oy * planeH * 0.5, -dist);

    const h = el.size * scale * planeH;
    mesh.scale.set(h * el.aspect, h, 1);

    let rot = el.rotation;
    if (el.autoRotate) rot += axisAng;
    mesh.rotation.z = rot;
  }
}

/** Stretch a blast NDC so the ghost axis always reaches an edge. */
function stretchBlastAxis(nx, ny) {
  let lx = nx;
  let ly = ny;
  const len = Math.hypot(lx, ly);
  if (len < BLAST_MIN_AXIS) {
    if (len < 1e-4) {
      lx = 0.4;
      ly = -BLAST_MIN_AXIS;
    } else {
      const s = BLAST_MIN_AXIS / len;
      lx *= s;
      ly *= s;
    }
  }
  return { lx, ly };
}

/**
 * Core sticks to the real blast. Ghosts use `ghostX/Y` (often a dampened axis)
 * so they peel toward a screen edge without spinning hard while the cam moves.
 */
function placeBlastElements(items, realX, realY, ghostX, ghostY, camera, scale) {
  const { dist, planeH, planeW } = screenPlane(camera);
  const axisX = -ghostX;
  const axisY = -ghostY;
  // −75% spin vs full axis alignment
  const axisAng = Math.atan2(axisY, axisX) * BLAST_AXIS_FOLLOW;

  for (const { mesh, el } of items) {
    let ox;
    let oy;
    if (el.core) {
      ox = realX;
      oy = realY;
    } else {
      ox = ghostX + axisX * el.offset;
      oy = ghostY + axisY * el.offset;
      const r = Math.hypot(ox, oy);
      if (r < BLAST_CENTER_DEAD) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
    }

    mesh.position.set(ox * planeW * 0.5, oy * planeH * 0.5, -dist);
    const h = el.size * scale * planeH;
    mesh.scale.set(h * el.aspect, h, 1);
    mesh.rotation.z = el.autoRotate ? el.rotation + axisAng : el.rotation;
  }
}

function edgeFactor(nx, ny, edgeFade, allowOffScreen) {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const outside = Math.max(ax, ay) - 1;
  const band = Math.max(1e-4, edgeFade);
  if (outside <= 0) {
    const fromEdge = 1 - Math.max(ax, ay);
    return Math.min(1, fromEdge / band);
  }
  if (!allowOffScreen) return 0;
  return Math.max(0, 1 - outside / band);
}

/**
 * @param {object} opts
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {*} opts.RAPIER
 * @param {import('@dimforge/rapier3d-compat').World} opts.world
 * @param {THREE.Vector3} opts.sunDir  direction toward the sun
 */
export async function createSunLensFlare({ camera, RAPIER, world, sunDir }) {
  const maps = await loadMaps();

  const root = new THREE.Group();
  root.name = 'SunLensFlare';
  root.frustumCulled = false;
  camera.add(root);

  const uVisibility = uniform(0);
  const uIntensity = uniform(1.74);
  const uScale = uniform(1.5);
  const items = buildElements(root, SUN_LOOK, maps, uVisibility, uIntensity);

  let enabled = true;
  let edgeFade = 0.2;
  let allowOffScreen = true;
  let occlusionFade = 0.15;
  let occlusionRadius = 0.02;
  let visibility = 0;

  const _sunNdc = new THREE.Vector3();
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });

  function update(dt) {
    if (!enabled) {
      visibility = 0;
      uVisibility.value = 0;
      root.visible = false;
      return;
    }

    _sunNdc.copy(camera.position).addScaledVector(sunDir, 500);
    _sunNdc.project(camera);
    const behind = _sunNdc.z > 1;
    const edge = behind ? 0 : edgeFactor(_sunNdc.x, _sunNdc.y, edgeFade, allowOffScreen);

    ray.origin.x = camera.position.x;
    ray.origin.y = camera.position.y;
    ray.origin.z = camera.position.z;
    ray.dir.x = sunDir.x;
    ray.dir.y = sunDir.y;
    ray.dir.z = sunDir.z;
    // Statics only — a passing truck shouldn't snuff the sun flare.
    const hit = world.castRay(ray, 400, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
    const occ = hit ? 0 : 1;

    const target = edge * occ;
    const fade = Math.max(1e-4, occlusionFade);
    visibility += (target - visibility) * (1 - Math.exp(-dt / fade));
    if (visibility < 0.001) visibility = 0;

    uVisibility.value = visibility;
    root.visible = visibility > 0.001;
    if (!root.visible) return;

    placeElements(items, _sunNdc.x, _sunNdc.y, camera, uScale.value);
  }

  return {
    root,
    maps,
    update,
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; },
    get intensity() { return uIntensity.value; },
    set intensity(v) { uIntensity.value = +v; },
    get scale() { return uScale.value; },
    set scale(v) { uScale.value = +v; },
    get edgeFade() { return edgeFade; },
    set edgeFade(v) { edgeFade = Math.max(0, +v); },
    get allowOffScreen() { return allowOffScreen; },
    set allowOffScreen(v) { allowOffScreen = !!v; },
    get occlusionFade() { return occlusionFade; },
    set occlusionFade(v) { occlusionFade = Math.max(0, +v); },
    get occlusionRadius() { return occlusionRadius; },
    set occlusionRadius(v) { occlusionRadius = Math.max(0, +v); },
  };
}

/**
 * Cheap blast flares — same textures as the sun, no occlusion rays, tiny pool.
 * Ghosts sit on the explosion→screen-centre axis and fade out fast.
 *
 * @param {object} opts
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {Record<string, THREE.Texture>} opts.maps  shared sun maps
 */
export function createExplosionLensFlare({ camera, maps }) {
  const group = new THREE.Group();
  group.name = 'ExplosionLensFlare';
  group.frustumCulled = false;
  camera.add(group);

  const uBrightness = uniform(0.15);
  const uScale = uniform(0.1); // group size for all ghosts / core
  const slots = [];
  const _ndc = new THREE.Vector3();

  for (let i = 0; i < POOL; i++) {
    const root = new THREE.Group();
    root.visible = false;
    group.add(root);
    const uVisibility = uniform(0);
    const items = buildElements(root, BLAST_LOOK, maps, uVisibility, uBrightness, {
      punchy: true,
      renderOrder: 1001,
    });
    slots.push({
      root,
      items,
      uVisibility,
      opacity: 0,
      world: new THREE.Vector3(),
      // Ghost axis frozen at trigger; live view only pulls 25% while fading
      axisX: 0,
      axisY: 0,
      hasAxis: false,
    });
  }

  let next = 0;

  function trigger(worldPos) {
    if (!worldPos || uBrightness.value <= 0) return;
    const slot = slots[next];
    next = (next + 1) % POOL;
    slot.world.copy(worldPos);
    slot.opacity = 1;
    slot.uVisibility.value = 1;
    slot.root.visible = true;
    slot.hasAxis = false;
  }

  function update(dt) {
    let any = false;
    for (const slot of slots) {
      if (slot.opacity <= 0) {
        slot.root.visible = false;
        continue;
      }
      slot.opacity = Math.max(0, slot.opacity - dt * BLAST_FADE);
      if (slot.opacity <= 0) {
        slot.uVisibility.value = 0;
        slot.root.visible = false;
        slot.hasAxis = false;
        continue;
      }

      _ndc.copy(slot.world).project(camera);
      // Behind / degenerate projection
      if (!Number.isFinite(_ndc.x) || !Number.isFinite(_ndc.y) || _ndc.z > 1 || _ndc.z < -1) {
        slot.opacity = 0;
        slot.uVisibility.value = 0;
        slot.root.visible = false;
        slot.hasAxis = false;
        continue;
      }

      const live = stretchBlastAxis(_ndc.x, _ndc.y);
      if (!slot.hasAxis) {
        slot.axisX = live.lx;
        slot.axisY = live.ly;
        slot.hasAxis = true;
      }
      // 75% locked to trigger pose, 25% live follow (−75% spin while visible)
      const gx = slot.axisX * (1 - BLAST_AXIS_FOLLOW) + live.lx * BLAST_AXIS_FOLLOW;
      const gy = slot.axisY * (1 - BLAST_AXIS_FOLLOW) + live.ly * BLAST_AXIS_FOLLOW;

      // Soft edge only — don’t kill ghosts when the blast is near the frame
      const edge = edgeFactor(_ndc.x, _ndc.y, 0.55, true);
      slot.uVisibility.value = slot.opacity * Math.max(0.35, edge);
      slot.root.visible = true;
      placeBlastElements(slot.items, _ndc.x, _ndc.y, gx, gy, camera, uScale.value);
      any = true;
    }
    group.visible = any;
  }

  return {
    root: group,
    trigger,
    update,
    get brightness() { return uBrightness.value; },
    set brightness(v) { uBrightness.value = Math.max(0, +v); },
    get scale() { return uScale.value; },
    set scale(v) { uScale.value = Math.max(0.05, +v); },
  };
}
