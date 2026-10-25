// Sun lens flare — PlayCanvas-style elements along the light→screen-centre axis
// (textures from playcanvas/engine examples, MIT / PR #9734). Fades with occlusion and screen edge.
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

const SHAPE_NAMES = [...new Set(SUN_LOOK.map((e) => e.shape))];

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
      });
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {*} opts.RAPIER
 * @param {import('@dimforge/rapier3d-compat').World} opts.world
 * @param {THREE.Vector3} opts.sunDir  direction toward the sun
 */
export async function createSunLensFlare({ camera, RAPIER, world, sunDir }) {
  const loader = new THREE.TextureLoader();
  const maps = {};
  await Promise.all(SHAPE_NAMES.map(async (name) => {
    const tex = await loader.loadAsync(`${TEX_BASE}${name}.png`);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    maps[name] = tex;
  }));

  const elements = expandLook(SUN_LOOK);
  const root = new THREE.Group();
  root.name = 'SunLensFlare';
  root.frustumCulled = false;
  camera.add(root);

  const uVisibility = uniform(0);
  const uIntensity = uniform(1.0);
  const uScale = uniform(1);
  const items = [];

  for (const el of elements) {
    const map = maps[el.shape];
    if (!map) continue;

    const uTint = uniform(new THREE.Color(el.color[0], el.color[1], el.color[2]));
    const uElIntensity = uniform(el.intensity);
    const sample = texture(map);

    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
      lights: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    // Coverage in alpha (PlayCanvas shapes). Additive rgb scaled by visibility × intensity.
    const gain = uElIntensity.mul(uIntensity).mul(uVisibility);
    mat.colorNode = vec4(sample.rgb.mul(vec3(uTint.r, uTint.g, uTint.b)).mul(gain), sample.a.mul(gain));

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1000;
    root.add(mesh);
    items.push({ mesh, el });
  }

  let enabled = true;
  let edgeFade = 0.2;
  let allowOffScreen = true;
  let occlusionFade = 0.15;
  let occlusionRadius = 0.02;
  let visibility = 0;

  const _sunNdc = new THREE.Vector3();
  const _axis = new THREE.Vector2();
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });

  function edgeFactor(nx, ny) {
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
    const edge = behind ? 0 : edgeFactor(_sunNdc.x, _sunNdc.y);

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

    const dist = 1.5;
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const planeH = 2 * Math.tan(vFov * 0.5) * dist;
    const planeW = planeH * camera.aspect;
    _axis.set(-_sunNdc.x, -_sunNdc.y);

    const scale = uScale.value;
    for (const { mesh, el } of items) {
      const ox = _sunNdc.x + _axis.x * el.offset;
      const oy = _sunNdc.y + _axis.y * el.offset;
      mesh.position.set(ox * planeW * 0.5, oy * planeH * 0.5, -dist);

      const h = el.size * scale * planeH;
      mesh.scale.set(h * el.aspect, h, 1);

      let rot = el.rotation;
      if (el.autoRotate) rot += Math.atan2(_axis.y, _axis.x);
      mesh.rotation.z = rot;
    }
  }

  return {
    root,
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
