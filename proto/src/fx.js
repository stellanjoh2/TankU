// Shells (ballistic, raycast against the physics world), muzzle flash, impacts, smoke and track dust.
// Glow sprites keep HDR in emissiveNode. Post blooms the whole frame plus that emissive buffer.
import * as THREE from 'three/webgpu';
import {
  float, instancedDynamicBufferAttribute, mix, smoothstep, texture, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { heightAt as terrainHeightAt, WATER_Y } from './terrain.js';
import { VISUAL_DEFAULTS } from './visualDefaults.js';
import { decodeGif } from './gif.js';
import {
  createBillboard, createMeshPool, releaseSlot, stepBillboards, stepMeshPool, syncMeshPool, takeBillboard, takeMesh,
} from './fxPools.js';

/** Shared glow. Peak channel is this; a tint keeps its hue. */
const SPRITE_EMISSIVE = 2.6 * 1.5;

function toEmissiveLevel(hdr) {
  const col = hdr.isColor ? hdr.clone() : new THREE.Color(hdr);
  const peak = Math.max(col.r, col.g, col.b);
  if (peak > 0) col.multiplyScalar(SPRITE_EMISSIVE / peak);
  return col;
}

/** Same scale as `toEmissiveLevel`, applied to a hot → cool pair so the fade stays. */
function emissiveRamp(from, to) {
  const peak = Math.max(from[0], from[1], from[2]);
  const s = peak > 0 ? SPRITE_EMISSIVE / peak : 0;
  const mul = (a) => [a[0] * s, a[1] * s, a[2] * s];
  return { from: mul(from), to: mul(to) };
}

/** Sprite that writes HDR into the emissive MRT (beauty via emissive add, not diffuse color). */
function emissiveSpriteMat(map, hdr, opts = {}) {
  const hdrCol = toEmissiveLevel(hdr);
  const uEm = uniform(hdrCol);
  const mat = new THREE.SpriteNodeMaterial({
    map: map ?? null,
    color: new THREE.Color(0, 0, 0),
    transparent: true,
    depthWrite: false,
    depthTest: opts.depthTest !== false,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    opacity: opts.opacity ?? 1,
    sizeAttenuation: opts.sizeAttenuation !== false,
    // Fog forces the card's alpha to 1, so the whole quad becomes a washed box
    // tinted by the cyan fog colour.
    fog: false,
  });
  mat.emissiveNode = map ? texture(map).rgb.mul(uEm) : uEm;
  mat.userData.emissiveUniform = uEm;
  return mat;
}

/** Unlit card. Black albedo, HDR in emissive, plain additive so black texels add nothing. */
/**
 * RGB painted on black, no alpha mask. Add the texel and leave framebuffer
 * alpha alone so the card can't stamp a square into the target.
 */
function blackAdditive(mat) {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.fog = false;
  mat.premultipliedAlpha = false;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendEquationAlpha = THREE.AddEquation;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
}

/** 1 in the interior, 0 on the texture border, so a cropped card can't outline the quad. */
function cardEdgeFade(margin) {
  const p = uv().sub(0.5).abs();
  const inner = float(0.5 - margin);
  const outer = float(0.5);
  return float(1).sub(smoothstep(inner, outer, p.x)).mul(float(1).sub(smoothstep(inner, outer, p.y)));
}

const GRAVITY = 9.81;
const _waterUp = new THREE.Vector3(0, 1, 0);
const IMPACT_IMPULSE = 2500;
const BLAST_RADIUS = 7;
const BLAST_IMPULSE = 9000;

/** Ground-explosion flipbook — one source PNG is an 8×8 SubUV sheet (not 128 single frames). */
const GROUND_EXPLOSION = {
  url: './textures/vfx/T_ground_explosion_atlas.png',
  cols: 8,
  rows: 8,
  frameCount: 64,
  aspect: 152 / 173, // cell w/h from baked atlas
  fps: 30,
  // Large on purpose so we can judge the flipbook in-game.
  width: 22 * 0.75,
  glowUrl: './textures/vfx/T_impact_glow.png',
  glowSize: 6,
  glowLife: 0.5,
};

/** Main-gun hit on tanks / props — 6×3 sheet, RGB on black. UV inset hides cell borders. */
const SHELL_IMPACT = {
  url: './textures/vfx/T_shell_impact_explosion.png',
  cols: 6,
  rows: 3,
  frames: 18,
  // ~0.6 s — same punch as the old 8@16, with smoother in-betweens.
  fps: 30,
  height: 12.5,
  // ~18 px on a ~296 px cell — clears the white SubUV lines + mip bleed
  // (denser 6×3 grid needs a larger fraction than the old 4×2 / metal sheet).
  inset: 0.06,
  emissive: SPRITE_EMISSIVE * 1.5 * 1.5,
  mips: true,
  // Soft-out from ~halfway so late smoke frames dissolve instead of popping.
  fadeStart: 0.5,
  // Grow through the flipbook: 0% → 150% of `height` (ease-out).
  scaleFrom: 0,
  scaleTo: 1.5,
};

/** Dirt blast ring, flat on the ground. Grows 0 → ~56 m over 0.5 s (ease-out) while fading out. */
const SHELL_SHOCKWAVE = {
  url: './textures/vfx/T_shell_shockwave.png',
  life: 0.5,
  endSize: 45 * 1.25,
  mips: true,
};

/** Scorched-earth ground decal after a main-gun dirt blast. Draped on the heightfield. */
const SCORCHED_EARTH = {
  url: './textures/vfx/T_scorched_earth.png',
  size: 10,
  life: 8,
  /** Hold full strength, then fade the rest of the life. */
  fadeStart: 0.45,
  lift: 0.05,
  segs: 20,
  poolSize: 8,
};

/** MG ground hit — 4-frame soil splash (left → right on the atlas). */
const MG_SOIL_IMPACT = {
  url: './textures/vfx/T_mg_soil_impact.png',
  cols: 4,
  rows: 1,
  frames: 4,
  fps: 12,
  height: 2,
};

/** MG water hit — 4-frame splash (left → right on the atlas). */
const MG_WATER_IMPACT = {
  url: './textures/vfx/T_mg_water_impact.png',
  cols: 4,
  rows: 1,
  frames: 4,
  fps: 12,
  height: 4.2,
};

/** MG metal hit (tanks / metal props) — 4×2 sheet, sparks spray toward +X. */
const MG_METAL_IMPACT = {
  url: './textures/vfx/T_mg_metal_impact.png',
  cols: 4,
  rows: 2,
  frames: 8,
  fps: 20,
  height: 3.25,
  inset: 0.04,
  mips: true,
  /** Flash origin in the cell (left-biased). */
  originU: 0.28,
};

/** Main-gun muzzle. Two 4-frame strips, RGB on black. Side sheet's point aims left. */
const MAIN_MUZZLE = {
  frontUrl: './textures/vfx/T_turret_muzzle_front.png',
  sideUrl: './textures/vfx/T_turret_muzzle_side.png',
  cols: 4,
  rows: 1,
  frames: 4,
  fps: 12,
  // Cell is mostly empty black; ~6 m tall puts the visible burst around 3 m.
  height: 6,
  // White scale so the painted orange stays. Same peak as every other glow sprite.
  emissive: SPRITE_EMISSIVE,
};

/** Post-shot barrel smoke: big dust burst on fire, then linger puffs pushed out the bore. */
const MAIN_MUZZLE_SMOKE = {
  life: 1.15,
  /** Linger emit rate at t=0 (puffs / s), ease-out. +25% vs first pass. */
  rate: 20,
  /** Along-bore push (m/s); ×3 vs first pass so the cloud reaches downrange. */
  push: 13.5,
  /** Soft drag so speed eases out as the puff settles. */
  drag: 0.85,
};

/** Soft volumetric puff (replaces the old flat radial). Tinted per use via instanceColor. */
const SMOKE_PUFF = {
  url: './textures/vfx/T_smoke_puff.png',
  /** Max yaw drift while a puff is alive. */
  spinMax: (10 * Math.PI) / 180,
  /** Share of smoke that uses the old flat radial (+25% vs the first 25% mix). */
  flatChance: 0.25 * 1.25,
};

/** Smoke grenade + MG discharge puff (separate atlas from general smoke). */
const SMOKE_DISCHARGE = {
  url: './textures/vfx/T_smoke_discharge.png',
};

/**
 * Smoke colour kit — `tex` multiplies the puff atlas; `flat` paints the old radial
 * so both boards read as the same hue when mixed.
 *  bright — main gun / MG / ground impacts (matches the painted puff)
 *  dark   — fires + man-made (tank/prop) impacts
 *  beige  — sand / track dust
 *  white  — water
 */
const SMOKE_TINT = {
  bright: {
    tex: [1, 0.99, 0.96],
    flat: [0.76, 0.72, 0.66],
  },
  dark: {
    tex: [0.28, 0.27, 0.26],
    flat: [0.20, 0.19, 0.18],
  },
  beige: {
    tex: [0.95, 0.82, 0.62],
    flat: [0.78, 0.64, 0.44],
  },
  white: {
    tex: [1.12, 1.16, 1.2],
    flat: [0.88, 0.93, 0.96],
  },
};

/** Shared by muzzle flash + in-flight shell so both stay in sync while tuning. */
const MAIN_GUN_LIGHT = {
  color: 0xffc060,
  intensity: 1238,
  distance: 36,
  decay: 2,
  fade: 0.25,
};

/** Damage-fire lights: derived from muzzle, then −25% radius/strength (×2) and warmer hue. */
const FIRE_LIGHT = {
  color: 0xff8840, // +25% warmer hue vs prior 0xffa040
  intensityMul: 0.25 * 0.75 * 0.75,
  distanceMul: 0.75 * 0.75,
};

const MG_FLASH = {
  starUrl: './textures/vfx/T_muzzle_star.png',
  plumeUrl: './textures/vfx/T_muzzle_plume.png',
  starSize: 0.85 * 1.25 * 1.25,
  // Texture is 512² — keep near-square so the jet isn’t a thin streak.
  plumeSize: 0.95 * 1.5 * 1.25 * 1.25,
  // M2-ish cyclic rate (~545 rpm) with a short visible flash per round.
  shotInterval: 0.11,
  flashLife: 0.048,
  // Spent .50 casings — oversized + punchy eject so they read at gameplay camera distance.
  brassBack: 0.9,       // m back from muzzle toward receiver
  brassSide: 0.14,      // m to the right of the barrel
  brassSpeed: 5.5,      // sideways m/s baseline
  brassUp: 3.2,         // upward m/s baseline
  brassLife: 3.2,
};

// Main-gun tracer. Geometry lies on local +X (nose at +X). Stretched a little along
// travel so a 260 m/s round still reads between frames without becoming a laser.
const SHELL_GEO_LEN = 1.725;
const SHELL_VIS_MAX = 3.9;
// Slow enough to read leaving the gun. The old 480 m/s streak showed up downrange.
const MG_TRACER_SPEED = 220 * 0.75;
const MG_TRACER_GEO_LEN = 0.825 * 1.5;
const MG_TRACER_LEN = 2.55 * 1.5;
// Per-round cone for every MG (roof .50, boat, P-51). Was the strafe's 2.5°.
const MG_SPREAD_DEG = 2.5 * 1.25;
// Metres past the muzzle. The plume reaches about here; a tracer rooted on the
// muzzle covers the star and makes the flash look broken. Clear shifts with the
// extra length so the tail stays where it was.
const MG_TRACER_CLEAR = 2.15 + 0.825 * 0.5;
const _tracerFwd = new THREE.Vector3(1, 0, 0);

const DAMAGE_FIRE_URL = './textures/vfx/fire.gif';
// World metres. Matches the old screen-space size at the chase camera, and shrinks on a distant tank.
// Steps: 25% / 50% / 75% damage, then the wreck.
const DAMAGE_FIRE_SCALE = [0, 2.1, 3.6, 5.3, 7.6];
const DAMAGE_FIRE_SPEED = 2.25;
/** Destroyed tank / truck: full burn, then a short fade, then the wreck is cold. */
export const WRECK_FIRE_LIFE = 60;
const WRECK_FIRE_FADE = 8;
/** Cold wreck stays this long after the fire dies, then the mesh fades out. */
export const WRECK_MESH_LINGER = 30;
const WRECK_MESH_FADE = 2.5;

/** 1 while the wreck is fully alight, 0 once the fire is out (~1 min). */
export function wreckFireFade(age) {
  if (age >= WRECK_FIRE_LIFE) return 0;
  const hold = WRECK_FIRE_LIFE - WRECK_FIRE_FADE;
  if (age <= hold) return 1;
  return (WRECK_FIRE_LIFE - age) / WRECK_FIRE_FADE;
}

/** 1 while the cold wreck stays, 0 once faded away (~30 s after fire out). */
export function wreckMeshFade(age) {
  const start = WRECK_FIRE_LIFE + WRECK_MESH_LINGER;
  if (age <= start) return 1;
  if (age >= start + WRECK_MESH_FADE) return 0;
  return (start + WRECK_MESH_FADE - age) / WRECK_MESH_FADE;
}

/** Opacity on a burnt wreck (materials are already cloned per mesh). */
export function applyWreckMeshFade(root, opacity) {
  if (!root) return;
  const o = Math.max(0, Math.min(1, opacity));
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    for (const m of [].concat(obj.material)) {
      if (!m) continue;
      m.transparent = o < 1;
      m.opacity = o;
      m.depthWrite = o > 0.2;
    }
  });
  if (o <= 0) root.visible = false;
}

/** Right-hand side of a barrel dir (world +Y up). */
function gunRight(dir, out) {
  out.set(0, 1, 0);
  out.crossVectors(dir, out);
  if (out.lengthSq() < 1e-8) out.set(1, 0, 0);
  else out.normalize();
  return out;
}

function radialTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Thin vertical streak: hot head at the top (uv v=1), fading tail toward the bottom. */
function streakTexture() {
  const w = 32, h = 128;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const across = g.createLinearGradient(0, 0, w, 0);
  across.addColorStop(0, 'rgba(255,255,255,0)');
  across.addColorStop(0.35, 'rgba(255,220,150,0.5)');
  across.addColorStop(0.5, 'rgba(255,255,255,1)');
  across.addColorStop(0.65, 'rgba(255,220,150,0.5)');
  across.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = across;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'destination-in';
  const along = g.createLinearGradient(0, 0, 0, h);
  along.addColorStop(0, 'rgba(0,0,0,0)');
  along.addColorStop(0.08, 'rgba(0,0,0,1)');
  along.addColorStop(0.35, 'rgba(0,0,0,0.75)');
  along.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = along;
  g.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Spark-spray burst: streaks fan out from an origin on the left toward +X, plus a few strays. */
const BURST_ORIGIN_U = 0.16;
function sparkBurstTexture(seed) {
  const w = 256, h = 128;
  const ox = w * BURST_ORIGIN_U, oy = h / 2;
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.globalCompositeOperation = 'lighter';
  g.lineCap = 'round';
  const glow = g.createRadialGradient(ox, oy, 0, ox, oy, 26);
  glow.addColorStop(0, 'rgba(255,240,200,0.9)');
  glow.addColorStop(0.4, 'rgba(255,170,60,0.35)');
  glow.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, w, h);
  const streak = (ang, r0, r1, width) => {
    const x0 = ox + Math.cos(ang) * r0, y0 = oy + Math.sin(ang) * r0;
    const x1 = ox + Math.cos(ang) * r1, y1 = oy + Math.sin(ang) * r1;
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, 'rgba(255,150,40,0)');
    grad.addColorStop(0.6, 'rgba(255,190,80,0.8)');
    grad.addColorStop(1, 'rgba(255,245,210,1)');
    g.strokeStyle = grad;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  };
  for (let i = 0; i < 34; i++) {
    const ang = (rnd() - 0.5) * (rnd() < 0.7 ? 0.7 : 1.5);
    const r0 = 6 + rnd() * 70;
    const r1 = Math.min(r0 + 12 + rnd() * 70, w - ox - 4);
    streak(ang, r0, r1, 1 + rnd() * 2.6);
  }
  for (let i = 0; i < 7; i++) {
    streak(rnd() * Math.PI * 2, 8 + rnd() * 10, 24 + rnd() * 26, 1 + rnd() * 1.4);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Sub-UV into an atlas from a per-instance frame index (row 0 = top of image).
 *  `inset` (0..0.5) shrinks each cell so SubUV grid lines stay off-screen. */
function atlasUvNode(frameNode, cols, rows, inset = 0) {
  const c = float(cols);
  const r = float(rows);
  const col = frameNode.mod(c);
  const row = frameNode.div(c).floor();
  const u = uv();
  const uIn = inset > 0 ? u.mul(float(1 - 2 * inset)).add(float(inset)) : u;
  return vec2(col.add(uIn.x).div(c), r.sub(row.add(float(1))).add(uIn.y).div(r));
}

const _cardM = new THREE.Matrix4();
const _cardP = new THREE.Vector3();
const _cardQ = new THREE.Quaternion();
const _cardS = new THREE.Vector3();
const _cardZ = new THREE.Vector3(0, 0, 1);

export class Effects {
  constructor(scene, RAPIER, world, excludeBody, dynamicProps) {
    this.scene = scene;
    this.RAPIER = RAPIER;
    this.world = world;
    this.exclude = excludeBody;
    this.dynamic = dynamicProps;
    this.shells = [];
    this.mgTracers = [];
    this.particles = [];
    this.onImpact = () => {};
    this.onShellHit = () => {};
    this.onMgShot = () => {};
    this.onMgHit = () => {};
    /** Dirt / sand MG impact (air raid + optional ground spray). */
    this.onMgDirtHit = () => {};
    /** Main-gun shell hit terrain/dirt (not metal). Used for near-miss lens splat. */
    this.onShellDirtHit = () => {};
    /** Fired from every `_explode` (shell, drum, wreck) — cheap post lens ghosts. */
    this.onExplosionFlare = () => {};
    this.groundExplosionAtlas = null;
    this.shellImpactAtlas = null;
    this.shellShockwaveTex = null;
    this.scorchTex = null;
    this._scorchPool = null;
    this._scorches = [];
    this.mgSoilImpactAtlas = null;
    this.mgWaterImpactAtlas = null;
    this.mgMetalImpactAtlas = null;
    this.impactGlowTex = null;

    this.flashTex = radialTexture([[0, '#ffffff'], [0.25, '#ffd28a'], [0.6, 'rgba(255,120,30,0.35)'], [1, 'rgba(255,80,0,0)']]);
    this.streakTex = streakTexture();
    this.burstTexs = [11, 4271, 90913].map(sparkBurstTexture);
    // Set from main.js — metal-hit sparks orient their streaks in screen space.
    this.camera = null;
    this.damageFire = null;
    this._camQInv = new THREE.Quaternion();
    this._streakV = new THREE.Vector3();
    // Soft volumetric puff (swapped in load). Flat radial kept for a 25% mix.
    this.smokeTex = radialTexture([[0, 'rgba(255,255,255,0.9)'], [0.5, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]);
    this.smokeFlatTex = this.smokeTex;
    // Unlit HDR streak. Beauty color feeds the full-image bloom; toneMapped off keeps it hot.
    // radiusTop is the tail after rotateZ(+90°); radiusBottom is the nose.
    this.shellGeo = new THREE.CylinderGeometry(0.12, 0.054, SHELL_GEO_LEN, 6).rotateZ(Math.PI / 2);
    this.shellMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(18, 5.6, 0.7),
      toneMapped: false,
      fog: false,
    });
    this.mgTracerGeo = new THREE.CylinderGeometry(0.042 * 1.5, 0.015 * 1.5, MG_TRACER_GEO_LEN, 5).rotateZ(Math.PI / 2);
    this.mgTracerMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(34, 11, 1.4),
      toneMapped: false,
      fog: false,
    });
    this.debrisGeo = new THREE.BoxGeometry(0.15, 0.15, 0.15);
    this.debrisMat = new THREE.MeshStandardMaterial({ color: 0x2b2418, roughness: 1 });
    // Tiny torn blades kicked up by tracks on yellow meadows (match primary grass).
    // Material stays white; per-bit tint is instanceColor.
    this.grassBitGeo = new THREE.PlaneGeometry(0.05, 0.16);
    this.grassBitColors = [
      new THREE.Color(VISUAL_DEFAULTS.grassBase),
      new THREE.Color(VISUAL_DEFAULTS.grassTip1),
      new THREE.Color(VISUAL_DEFAULTS.grassTip2),
    ];
    this.grassBitMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    // First-pass .50 brass: ~2× real size, then −25%. Warm metal so it pops against olive drab.
    this.brassGeo = new THREE.CylinderGeometry(0.045 * 0.75, 0.052 * 0.75, 0.18 * 0.75, 8);
    this.brassMat = new THREE.MeshStandardMaterial({
      color: 0xe0b45a,
      metalness: 0.9,
      roughness: 0.32,
      emissive: 0x4a3208,
      emissiveIntensity: 0.25,
    });
    this._brassRight = new THREE.Vector3();
    this._brassUp = new THREE.Vector3();

    this.lights = [0, 1].map(() => {
      const l = new THREE.PointLight(0xffb060, 0, 40, 2);
      l.castShadow = false;
      scene.add(l);
      return { light: l, t: 1, peak: 0, fade: 0.25 };
    });
    this._light = 0;

    this.mgFlash = null; // player; enemy / enemy2 / boat use the other kits
    this.mgFlashB = null;
    this.mgFlashD = null;
    // Active .50 streams: id → { pose, owner, shotT, flashAge, flash, roll }
    this._mgStreams = new Map();
    // Main-gun barrel smoke after a shot: id → { age, life, pos, dir, emitAcc }
    this._mainSmokeStreams = new Map();
    this._mgUp = new THREE.Vector3();
    this._mgSide = new THREE.Vector3();
    this._mgSide2 = new THREE.Vector3();
    this._mgSpreadDir = new THREE.Vector3();
    this._mgSpreadRight = new THREE.Vector3();
    this._mgSpreadUp = new THREE.Vector3();
    this._mgMat = new THREE.Matrix4();
    this._mgRayOrigin = { x: 0, y: 0, z: 0 };
    this._mgRayDir = { x: 1, y: 0, z: 0 };

    this.mainMuzzleFront = null;
    this.mainMuzzleSide = null;
    this.muzzleCardGeo = new THREE.PlaneGeometry(1, 1);
    this._muzzleX = new THREE.Vector3();
    this._muzzleY = new THREE.Vector3();
    this._muzzleZ = new THREE.Vector3();
    this._camQ = new THREE.Quaternion();
    this._shellStep = new THREE.Vector3();
    this._shellDir = new THREE.Vector3();
    this._hitPoint = new THREE.Vector3();
    this._hitNormal = new THREE.Vector3();
    this._puffTint = new THREE.Color(1, 1, 1);
    this._shellHit = new THREE.Vector3();
    this._boomPos = new THREE.Vector3();
    this._boomN = new THREE.Vector3();
    this._boomDir = new THREE.Vector3();
    this._shellOrigin = { x: 0, y: 0, z: 0 };
    this._shellDirN = { x: 1, y: 0, z: 0 };
    this._shellRay = new this.RAPIER.Ray(this._shellOrigin, this._shellDirN);
    this._mgRay = new this.RAPIER.Ray(this._mgRayOrigin, this._mgRayDir);
    this._yAxis = new THREE.Vector3(0, 1, 0);

    // One material per batch. Slots are reused for the whole match.
    this._smokeBoard = createBillboard(scene, this.smokeTex, 280, { renderOrder: 1 });
    // Larger pool — smoke grenade uses only these soft radials.
    this._smokeFlatBoard = createBillboard(scene, this.smokeFlatTex, 220, { renderOrder: 1 });
    // Placeholder until load swaps in T_smoke_discharge.png.
    this._smokeDischargeBoard = createBillboard(scene, this.smokeTex, 160, { renderOrder: 1 });
    this._flashBoard = createBillboard(scene, this.flashTex, 256, { emissive: true, renderOrder: 3 });
    this._streakBoard = createBillboard(scene, this.streakTex, 160, { emissive: true, renderOrder: 3 });
    this._burstBoards = this.burstTexs.map((tex) => createBillboard(scene, tex, 8, { emissive: true, renderOrder: 4 }));
    this._glowBoard = null;
    this._shellPool = createMeshPool(scene, this.shellGeo, this.shellMat, 16);
    for (const s of this._shellPool.slots) {
      const light = new THREE.PointLight(
        MAIN_GUN_LIGHT.color, 0, MAIN_GUN_LIGHT.distance, MAIN_GUN_LIGHT.decay,
      );
      light.castShadow = false;
      scene.add(light);
      s.light = light;
    }
    this._tracerPool = createMeshPool(scene, this.mgTracerGeo, this.mgTracerMat, 128);
    this._brassPool = createMeshPool(scene, this.brassGeo, this.brassMat, 96);
    this._debrisPool = createMeshPool(scene, this.debrisGeo, this.debrisMat, 48);
    this._grassPool = createMeshPool(scene, this.grassBitGeo, this.grassBitMat, 48, { colored: true });
    this.shells = [];
    this.mgTracers = [];
  }

  async load() {
    const loader = new THREE.TextureLoader();
    const [
      tex, glowMap, starMap, plumeMap, muzzleFront, muzzleSide,
      soilMap, waterMap, shellImpactMap, mgMetalMap, shockwaveMap, scorchMap, smokeMap, dischargeMap,
    ] = await Promise.all([
      loader.loadAsync(GROUND_EXPLOSION.url),
      loader.loadAsync(GROUND_EXPLOSION.glowUrl),
      loader.loadAsync(MG_FLASH.starUrl),
      loader.loadAsync(MG_FLASH.plumeUrl),
      loader.loadAsync(MAIN_MUZZLE.frontUrl),
      loader.loadAsync(MAIN_MUZZLE.sideUrl),
      loader.loadAsync(MG_SOIL_IMPACT.url),
      loader.loadAsync(MG_WATER_IMPACT.url),
      loader.loadAsync(SHELL_IMPACT.url),
      loader.loadAsync(MG_METAL_IMPACT.url),
      loader.loadAsync(SHELL_SHOCKWAVE.url),
      loader.loadAsync(SCORCHED_EARTH.url),
      loader.loadAsync(SMOKE_PUFF.url),
      loader.loadAsync(SMOKE_DISCHARGE.url),
    ]);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    this.groundExplosionAtlas = tex;

    for (const m of [soilMap, waterMap]) {
      m.colorSpace = THREE.SRGBColorSpace;
      m.magFilter = THREE.LinearFilter;
      m.minFilter = THREE.LinearFilter;
      m.generateMipmaps = false;
      m.wrapS = m.wrapT = THREE.ClampToEdgeWrapping;
    }
    // New impact sheets: mip at distance (atlas cells use a larger UV inset to avoid bleed).
    for (const m of [shellImpactMap, mgMetalMap, shockwaveMap, scorchMap]) {
      m.colorSpace = THREE.SRGBColorSpace;
      m.magFilter = THREE.LinearFilter;
      m.minFilter = THREE.LinearMipmapLinearFilter;
      m.generateMipmaps = true;
      m.wrapS = m.wrapT = THREE.ClampToEdgeWrapping;
    }
    this.mgSoilImpactAtlas = soilMap;
    this.mgWaterImpactAtlas = waterMap;
    this.shellImpactAtlas = shellImpactMap;
    this.mgMetalImpactAtlas = mgMetalMap;
    this.shellShockwaveTex = shockwaveMap;
    this.scorchTex = scorchMap;

    for (const m of [smokeMap, dischargeMap]) {
      m.colorSpace = THREE.SRGBColorSpace;
      m.magFilter = THREE.LinearFilter;
      m.minFilter = THREE.LinearMipmapLinearFilter;
      m.generateMipmaps = true;
      m.wrapS = m.wrapT = THREE.ClampToEdgeWrapping;
    }
    this.smokeTex = smokeMap;
    this.smokeDischargeTex = dischargeMap;
    // Rebuild smoke batches on the real puff textures (material samples map at create time).
    if (this._smokeBoard) {
      this.scene.remove(this._smokeBoard.mesh);
      this._smokeBoard.mesh.geometry.dispose();
      this._smokeBoard.mesh.material.dispose();
    }
    this._smokeBoard = createBillboard(this.scene, this.smokeTex, 280, { renderOrder: 1 });
    if (this._smokeDischargeBoard) {
      this.scene.remove(this._smokeDischargeBoard.mesh);
      this._smokeDischargeBoard.mesh.geometry.dispose();
      this._smokeDischargeBoard.mesh.material.dispose();
    }
    this._smokeDischargeBoard = createBillboard(this.scene, this.smokeDischargeTex, 160, { renderOrder: 1 });

    glowMap.colorSpace = THREE.SRGBColorSpace;
    glowMap.magFilter = THREE.LinearFilter;
    glowMap.minFilter = THREE.LinearMipmapLinearFilter;
    this.impactGlowTex = glowMap;

    for (const m of [muzzleFront, muzzleSide]) {
      m.colorSpace = THREE.SRGBColorSpace;
      m.magFilter = THREE.LinearFilter;
      m.minFilter = THREE.LinearFilter;
      m.generateMipmaps = false;
      m.wrapS = m.wrapT = THREE.ClampToEdgeWrapping;
    }
    this.mainMuzzleFront = muzzleFront;
    this.mainMuzzleSide = muzzleSide;

    // No mips: the art runs to the texture edge, and lower mips smear that into a square halo.
    for (const m of [starMap, plumeMap]) {
      m.colorSpace = THREE.SRGBColorSpace;
      m.magFilter = THREE.LinearFilter;
      m.minFilter = THREE.LinearFilter;
      m.generateMipmaps = false;
      m.wrapS = m.wrapT = THREE.ClampToEdgeWrapping;
    }

    // Camera-facing star + two barrel-aligned plumes crossed 90° (reads from all angles).
    // Four kits so the player, both enemy tanks, and the patrol boat can spray at once.
    // Art is RGB on black (no alpha). Same emissive peak as the other glow sprites.
    // One,One so the black texels add nothing; a short edge fade keeps the card from outlining.
    const flashCard = (map, edgeFade, sprite) => {
      const rgb = texture(map).rgb
        .mul(uniform(new THREE.Color(SPRITE_EMISSIVE, SPRITE_EMISSIVE, SPRITE_EMISSIVE)))
        .mul(cardEdgeFade(edgeFade));
      const mat = sprite
        ? new THREE.SpriteNodeMaterial({
          transparent: true, depthWrite: false, fog: false,
        })
        : new THREE.MeshBasicNodeMaterial({
          color: new THREE.Color(0, 0, 0),
          lights: false, transparent: true, depthWrite: false,
          side: THREE.DoubleSide, fog: false,
        });
      mat.colorNode = vec4(0, 0, 0, 1);
      mat.emissiveNode = rgb;
      blackAdditive(mat);
      return mat;
    };
    // Four kits share two InstancedMeshes (stars + plumes) instead of 12 draws.
    const starGeo = new THREE.PlaneGeometry(1, 1);
    const starMat = flashCard(starMap, 0.02, false);
    const plumeGeo = new THREE.PlaneGeometry(1, 1);
    const plumeMat = flashCard(plumeMap, 0.1, false);
    this._mgStarInst = new THREE.InstancedMesh(starGeo, starMat, 4);
    this._mgStarInst.count = 4;
    this._mgStarInst.frustumCulled = false;
    this._mgStarInst.castShadow = false;
    this._mgStarInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this._mgStarInst);
    this._mgPlumeInst = new THREE.InstancedMesh(plumeGeo, plumeMat, 8);
    this._mgPlumeInst.count = 8;
    this._mgPlumeInst.frustumCulled = false;
    this._mgPlumeInst.castShadow = false;
    this._mgPlumeInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this._mgPlumeInst);
    const hideMgFlashInstances = () => {
      _cardS.set(0, 0, 0);
      _cardP.set(0, -999, 0);
      _cardQ.identity();
      _cardM.compose(_cardP, _cardQ, _cardS);
      for (let i = 0; i < 4; i++) this._mgStarInst.setMatrixAt(i, _cardM);
      for (let i = 0; i < 8; i++) this._mgPlumeInst.setMatrixAt(i, _cardM);
      this._mgStarInst.instanceMatrix.needsUpdate = true;
      this._mgPlumeInst.instanceMatrix.needsUpdate = true;
    };
    hideMgFlashInstances();
    const makeKit = (kitIndex) => {
      const star = new THREE.Object3D();
      star.scale.setScalar(MG_FLASH.starSize);
      const plumes = [0, 1].map(() => new THREE.Object3D());
      const light = new THREE.PointLight(0xffc060, 0, 15, 2);
      light.castShadow = false;
      this.scene.add(light);
      return {
        star, plumes, light,
        starSlot: kitIndex,
        plumeSlots: [kitIndex * 2, kitIndex * 2 + 1],
        flashVisible: false,
      };
    };
    this.mgFlash = makeKit(0);
    this.mgFlashB = makeKit(1);
    this.mgFlashC = makeKit(2);
    this.mgFlashD = makeKit(3);
    this._mgKit = {
      player: this.mgFlash,
      enemy: this.mgFlashB,
      boat: this.mgFlashC,
      enemy2: this.mgFlashD,
    };
    this._syncMgFlashKit = (fx) => {
      const starInst = this._mgStarInst;
      const plumeInst = this._mgPlumeInst;
      if (!fx.flashVisible) {
        _cardS.set(0, 0, 0);
        _cardP.set(0, -999, 0);
        _cardQ.identity();
        _cardM.compose(_cardP, _cardQ, _cardS);
        starInst.setMatrixAt(fx.starSlot, _cardM);
        plumeInst.setMatrixAt(fx.plumeSlots[0], _cardM);
        plumeInst.setMatrixAt(fx.plumeSlots[1], _cardM);
      } else {
        if (this.camera) {
          fx.star.quaternion.copy(this._camQ);
          if (fx.starSpin) {
            _cardQ.setFromAxisAngle(_cardZ, fx.starSpin);
            fx.star.quaternion.multiply(_cardQ);
          }
        }
        fx.star.updateMatrix();
        starInst.setMatrixAt(fx.starSlot, fx.star.matrix);
        for (let i = 0; i < 2; i++) {
          fx.plumes[i].updateMatrix();
          plumeInst.setMatrixAt(fx.plumeSlots[i], fx.plumes[i].matrix);
        }
      }
      starInst.instanceMatrix.needsUpdate = true;
      plumeInst.instanceMatrix.needsUpdate = true;
    };

    const gif = decodeGif(await (await fetch(DAMAGE_FIRE_URL)).arrayBuffer());
    const canvas = document.createElement('canvas');
    canvas.width = gif.width;
    canvas.height = gif.height;
    const ctx = canvas.getContext('2d', { alpha: true });
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearFilter;
    map.generateMipmaps = false;
    const fire = {
      gif, ctx, map,
      image: ctx.createImageData(gif.width, gif.height),
      frame: -1,
      acc: 0,
    };
    // Shared gif clip. 0 player, 1 + 6 enemy tanks, 2–3 trucks, 4–5 boats.
    // Own material per slot so a dying wreck can fade without dimming the others.
    const FIRE_SLOTS = 7;
    fire.sprites = Array.from({ length: FIRE_SLOTS }, () => {
      const fadeU = uniform(1);
      const mat = emissiveSpriteMat(map, new THREE.Color(1.15, 1.15, 1.15), {});
      // Additive: dark smoke adds nothing, so it doesn't sit on the scene as a black blob.
      // SrcAlpha keeps the gif's mask. Leave the frame's alpha alone so the card doesn't stamp a square.
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.SrcAlphaFactor;
      mat.blendDst = THREE.OneFactor;
      mat.blendEquationAlpha = THREE.AddEquation;
      mat.blendSrcAlpha = THREE.ZeroFactor;
      mat.blendDstAlpha = THREE.OneFactor;
      const sample = texture(map);
      mat.emissiveNode = sample.rgb.mul(mat.userData.emissiveUniform).mul(fadeU);
      mat.opacityNode = sample.a.mul(fadeU);
      const sprite = new THREE.Sprite(mat);
      sprite.center.set(0.5, 0.02);
      sprite.visible = false;
      sprite.frustumCulled = false;
      sprite.renderOrder = 2;
      sprite.userData.fireFade = fadeU;
      const light = new THREE.PointLight(
        FIRE_LIGHT.color, 0, MAIN_GUN_LIGHT.distance * FIRE_LIGHT.distanceMul, MAIN_GUN_LIGHT.decay,
      );
      light.castShadow = false;
      this.scene.add(light);
      sprite.userData.fireLight = light;
      this.scene.add(sprite);
      return sprite;
    });
    this.damageFire = fire;
    this._blitDamageFire(0);
  }

  /** Build flipbook pools + glow board so the first shot / impact doesn't allocate mid-frame. */
  warmup() {
    if (this.groundExplosionAtlas) {
      this._ensureCardPool('blast', this.groundExplosionAtlas, {
        cols: GROUND_EXPLOSION.cols,
        rows: GROUND_EXPLOSION.rows,
        frames: GROUND_EXPLOSION.frameCount,
        fps: GROUND_EXPLOSION.fps,
        blast: true,
      });
    }
    if (this.shellImpactAtlas) {
      this._ensureCardPool('shell-impact', this.shellImpactAtlas, {
        cols: SHELL_IMPACT.cols,
        rows: SHELL_IMPACT.rows,
        frames: SHELL_IMPACT.frames,
        fps: SHELL_IMPACT.fps,
        inset: SHELL_IMPACT.inset,
        emissive: SHELL_IMPACT.emissive,
        mips: SHELL_IMPACT.mips,
        fadeStart: SHELL_IMPACT.fadeStart,
        poolSize: 8,
        impact: true,
      });
    }
    if (this.shellShockwaveTex) this._ensureShockwavePool();
    if (this.scorchTex) this._ensureScorchPool();
    if (this.mgSoilImpactAtlas) {
      this._ensureCardPool('mg-soil', this.mgSoilImpactAtlas, {
        cols: MG_SOIL_IMPACT.cols,
        rows: MG_SOIL_IMPACT.rows,
        frames: MG_SOIL_IMPACT.frames,
        fps: MG_SOIL_IMPACT.fps,
        poolSize: 12,
        soil: true,
      });
    }
    if (this.mgWaterImpactAtlas) {
      this._ensureCardPool('mg-water', this.mgWaterImpactAtlas, {
        cols: MG_WATER_IMPACT.cols,
        rows: MG_WATER_IMPACT.rows,
        frames: MG_WATER_IMPACT.frames,
        fps: MG_WATER_IMPACT.fps,
        poolSize: 12,
        soil: true,
      });
    }
    if (this.mgMetalImpactAtlas) {
      this._ensureCardPool('mg-metal', this.mgMetalImpactAtlas, {
        cols: MG_METAL_IMPACT.cols,
        rows: MG_METAL_IMPACT.rows,
        frames: MG_METAL_IMPACT.frames,
        fps: MG_METAL_IMPACT.fps,
        inset: MG_METAL_IMPACT.inset,
        mips: MG_METAL_IMPACT.mips,
        poolSize: 16,
        impact: true,
      });
    }
    if (this.mainMuzzleFront) {
      this._ensureCardPool('muzzle-front', this.mainMuzzleFront, MAIN_MUZZLE);
    }
    if (this.mainMuzzleSide) {
      this._ensureCardPool('muzzle-side', this.mainMuzzleSide, MAIN_MUZZLE);
    }
    if (this.impactGlowTex && !this._glowBoard) {
      this._glowBoard = createBillboard(this.scene, this.impactGlowTex, 8, {
        emissive: true, renderOrder: 5,
      });
    }
  }

  _flashLight(pos, peak, { color = 0xffb060, distance = 40, fade = 0.25 } = {}) {
    const L = this.lights[this._light++ % this.lights.length];
    L.light.position.copy(pos);
    L.light.color.set(color);
    L.light.distance = distance;
    L.t = 0;
    L.peak = peak;
    L.fade = fade;
  }

  /**
   * Resolve a smoke kit tint for the board in use (puff atlas vs flat radial).
   * @param {'bright'|'dark'|'beige'|'white'} kind
   * @param {boolean} flat
   */
  _smokeTint(kind, flat) {
    const kit = SMOKE_TINT[kind] || SMOKE_TINT.bright;
    const rgb = flat ? kit.flat : kit.tex;
    const j = 1 + (Math.random() - 0.5) * 0.06;
    return new THREE.Color(rgb[0] * j, rgb[1] * j, rgb[2] * j);
  }

  /**
   * Soft puff. Additive flames share the flash billboard; smoke shares one material.
   * Pass a THREE.Color, or a smoke kind string: 'bright' | 'dark' | 'beige' | 'white'.
   */
  _sprite(tex, colorOrKind, pos, size, life, opts = {}) {
    const additive = !!opts.additive;
    const discharge = !!opts.discharge;
    const forceFlat = !!opts.flat;
    if (!additive) {
      // −25% spawn count on general smoke; discharge / forced flat keep full count.
      if (!discharge && !forceFlat && Math.random() < 0.25) return;
    }
    // Flat radial mix (thickens the cloud when raised). Discharge atlas stays as-is.
    const flat = forceFlat || (!additive && !discharge && Math.random() < SMOKE_PUFF.flatChance);
    const board = additive
      ? this._flashBoard
      : flat
        ? this._smokeFlatBoard
        : (discharge ? this._smokeDischargeBoard : this._smokeBoard);
    const color = typeof colorOrKind === 'string'
      ? this._smokeTint(colorOrKind, flat)
      : colorOrKind;
    const s = takeBillboard(board);
    s.mode = 'puff';
    s.pos.copy(pos);
    if (opts.vel) s.vel.copy(opts.vel);
    s.life = life;
    s.size = size;
    s.grow = opts.grow ?? 1;
    // −25% opacity on smoke (new + flat mix); discharge atlas another −25% (true-alpha is dense).
    s.opacity = (opts.opacity ?? 1) * (additive ? 1 : 0.75) * (discharge ? 0.75 : 1);
    s.drag = opts.drag ?? 1.5;
    s.rise = opts.rise ?? 0;
    s.fadeLinear = !!opts.fadeLinear;
    s.scaleToZero = !!opts.scaleToZero;
    if (additive) {
      const peak = Math.max(color.r, color.g, color.b);
      s.color.copy(color);
      if (peak > 0) s.color.multiplyScalar(SPRITE_EMISSIVE / peak);
    } else {
      s.color.copy(color);
      // Random facing + ≤10° drift over life so stacked puffs don't look stamped.
      s.rot = Math.random() * Math.PI * 2;
      s.rotSpin = (Math.random() * 2 - 1) * SMOKE_PUFF.spinMax;
    }
  }

  /**
   * Hot spark on the flash or streak billboard. `from` / `to` are already emissive-scaled.
   */
  _spawnSpark(point, vel, size, life, from, to, { streak = false } = {}) {
    const board = streak ? this._streakBoard : this._flashBoard;
    const s = takeBillboard(board);
    s.mode = 'spark';
    s.pos.copy(point);
    s.vel.copy(vel);
    s.life = life;
    s.size = size;
    s.streak = streak;
    s.pivotY = streak ? 0.9 : 0.5;
    if (from) s.color.setRGB(from[0], from[1], from[2]);
    else s.color.setRGB(SPRITE_EMISSIVE, SPRITE_EMISSIVE, SPRITE_EMISSIVE);
    if (to) {
      s.sparkTo.setRGB(to[0], to[1], to[2]);
      s.hasSparkTo = true;
    } else {
      const k = SPRITE_EMISSIVE / 10;
      s.sparkTo.setRGB(8 * k, 0.55 * k, 0.06 * k);
      s.hasSparkTo = true;
    }
  }

  /**
   * Hold-to-fire .50 cal. `id` isolates player / enemy / boat streams.
   * Pass { pos, dir } each frame while firing, or null to stop.
   * `owner` = firing rigid body (excluded from the bullet ray).
   */
  setMgFlash(pose, owner = null, id = 'player') {
    if (!this.mgFlash) return;
    if (!pose) {
      const s = this._mgStreams.get(id);
      if (s) {
        s.flash.flashVisible = false;
        this._syncMgFlashKit?.(s.flash);
        s.flash.light.intensity = 0;
        this._mgStreams.delete(id);
      }
      return;
    }
    let s = this._mgStreams.get(id);
    if (!s) {
      const flash = this._mgKit?.[id] || this.mgFlash;
      s = {
        pose, owner, flash,
        shotT: MG_FLASH.shotInterval, // first round fires immediately
        flashAge: 1,
        roll: 0,
      };
      this._mgStreams.set(id, s);
    } else {
      s.pose = pose;
      s.owner = owner;
    }
  }

  _layoutMgFlash(fx, pos, dir, visible, roll) {
    fx.flashVisible = visible;
    fx.star.position.copy(pos);

    const up = this._mgUp.set(0, 1, 0);
    if (Math.abs(dir.dot(up)) > 0.92) up.set(1, 0, 0);
    this._mgSide.crossVectors(dir, up).normalize();
    up.crossVectors(this._mgSide, dir).normalize();

    const c = Math.cos(roll), sn = Math.sin(roll);
    const sx = this._mgSide.x * c + up.x * sn;
    const sy = this._mgSide.y * c + up.y * sn;
    const sz = this._mgSide.z * c + up.z * sn;
    const ux = -this._mgSide.x * sn + up.x * c;
    const uy = -this._mgSide.y * sn + up.y * c;
    const uz = -this._mgSide.z * sn + up.z * c;
    this._mgSide.set(sx, sy, sz);
    up.set(ux, uy, uz);

    const size = MG_FLASH.plumeSize;
    const along = size * 0.45;
    this._mgMat.makeBasis(this._mgSide, dir, up);
    fx.plumes[0].quaternion.setFromRotationMatrix(this._mgMat);
    fx.plumes[0].position.copy(pos).addScaledVector(dir, along);
    fx.plumes[0].scale.set(size, size, 1);

    this._mgMat.makeBasis(up, dir, this._mgSide2.copy(this._mgSide).negate());
    fx.plumes[1].quaternion.setFromRotationMatrix(this._mgMat);
    fx.plumes[1].position.copy(pos).addScaledVector(dir, along);
    fx.plumes[1].scale.set(size, size, 1);

    // ~5 m downrange so the pulse reads on the ground, not just at the muzzle.
    fx.light.position.copy(pos).addScaledVector(dir, 5);
    this._syncMgFlashKit?.(fx);
  }

  /**
   * Hitscan .50 round — real physics ray so ricochets / damage line up with the barrel.
   * @param {{ damage?: number, air?: boolean }} [opts]
   */
  _traceMgBullet(pos, dir, owner, opts = {}) {
    const R = this.RAPIER;
    const o = this._mgRayOrigin;
    const d = this._mgRayDir;
    o.x = pos.x; o.y = pos.y; o.z = pos.z;
    d.x = dir.x; d.y = dir.y; d.z = dir.z;
    const ray = this._mgRay;
    const hit = this.world.castRayAndGetNormal(ray, 450, true, undefined, undefined, undefined, owner);
    // Stop on open water (sea surface) before seabed / far shore — tank MG and air rounds.
    if (d.y < -1e-4) {
      const tWater = (WATER_Y - o.y) / d.y;
      const solid = hit ? hit.timeOfImpact : Infinity;
      const minT = opts.air ? 0.5 : 0.05;
      if (tWater > minT && tWater < solid) {
        const point = pos.clone().addScaledVector(dir, tWater);
        if (terrainHeightAt(point.x, point.z) < WATER_Y - 0.05) {
          this.waterSplash(point);
          this.onMgDirtHit({
            point, dir: dir.clone(), normal: _waterUp, air: !!opts.air, water: true,
          });
          return { reach: tWater, body: null };
        }
      }
    }
    if (!hit) return null;
    const point = pos.clone().addScaledVector(dir, hit.timeOfImpact);
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    // Ground/dirt/concrete: near terrain height with an upward face (keeps tank/barrel hits as metal sparks)
    const dirt = Math.abs(point.y - terrainHeightAt(point.x, point.z)) < 0.35 && normal.y > 0.45;
    if (dirt) {
      this.dirtPlume(point);
      this.onMgDirtHit({ point, dir: dir.clone(), normal, air: !!opts.air });
    } else {
      this._mgImpactSparks(point, normal, dir, false);
    }
    this.onMgHit({
      point,
      collider: hit.collider,
      owner,
      dir: dir.clone(),
      normal,
      damage: opts.damage,
      air: !!opts.air,
    });
    return { reach: hit.timeOfImpact, body: hit.collider?.parent() ?? null };
  }

  /** Square cone around `dir`. Half-angle is `MG_SPREAD_DEG`. */
  _spreadMgDir(dir) {
    const spread = THREE.MathUtils.degToRad(MG_SPREAD_DEG);
    const yawJ = (Math.random() - 0.5) * 2 * spread;
    const pitchJ = (Math.random() - 0.5) * 2 * spread;
    const up = this._mgSpreadUp;
    if (Math.abs(dir.y) > 0.92) up.set(1, 0, 0);
    else up.set(0, 1, 0);
    const right = this._mgSpreadRight.crossVectors(dir, up).normalize();
    up.crossVectors(right, dir).normalize();
    return this._mgSpreadDir.copy(dir)
      .addScaledVector(right, Math.tan(yawJ))
      .addScaledVector(up, Math.tan(pitchJ))
      .normalize();
  }

  /**
   * P-51 strafe round: tracer + hitscan, no brass / roof-gun flash.
   * @param {{ pos: THREE.Vector3, dir: THREE.Vector3 }} pose
   * @param {{ damage?: number, owner?: object }} [opts]
   */
  fireAirMg(pose, opts = {}) {
    if (!pose?.pos || !pose?.dir) return;
    const dir = this._spreadMgDir(pose.dir);
    const hit = this._traceMgBullet(pose.pos, dir, opts.owner ?? null, {
      damage: opts.damage,
      air: true,
    });
    this._spawnMgTracer(pose.pos, dir, hit?.reach ?? null);
  }

  /** Splash where an MG round meets the sea (flipbook + foam). */
  waterSplash(point) {
    this._mgWaterImpact(point);
    const n = 5;
    for (let i = 0; i < n; i++) {
      this._sprite(
        this.smokeTex,
        'white',
        point.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.45, 0.05, (Math.random() - 0.5) * 0.45)),
        0.27 + Math.random() * 0.21,
        0.35 + Math.random() * 0.2,
        {
          vel: new THREE.Vector3((Math.random() - 0.5) * 1.6, 2.5 + Math.random() * 2.8, (Math.random() - 0.5) * 1.6),
          grow: 3.8,
          opacity: 0.55,
          drag: 2.0,
        },
      );
    }
  }

  /**
   * Vertical sandy dust spout for air-raid (and MG) ground strikes — tall narrow plume.
   * @param {THREE.Vector3} point
   */
  dirtPlume(point) {
    this._mgSoilImpact(point);
    // Core column — dense, rises fast, grows into a soft cloud (+50% size).
    const n = 5 + (Math.random() * 3) | 0;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1 || 1);
      const origin = point.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.27,
        0.02 + t * 0.08,
        (Math.random() - 0.5) * 0.27,
      ));
      const v = new THREE.Vector3(
        (Math.random() - 0.5) * 1.2,
        6.5 + Math.random() * 5.5 + t * 2.5,
        (Math.random() - 0.5) * 1.2,
      );
      this._sprite(
        this.smokeTex,
        'bright',
        origin,
        (0.22 + Math.random() * 0.18 + t * 0.12) * 1.5,
        0.38 + Math.random() * 0.28,
        {
          vel: v,
          grow: 4.5 + Math.random() * 2.5,
          opacity: 0.55 + Math.random() * 0.25,
          drag: 1.6,
          rise: 0.15,
        },
      );
    }
    // Wispy top / edge flecks
    for (let i = 0; i < 3; i++) {
      this._sprite(
        this.smokeTex,
        'bright',
        point.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.45, 0.05, (Math.random() - 0.5) * 0.45)),
        (0.14 + Math.random() * 0.12) * 1.5,
        0.45 + Math.random() * 0.25,
        {
          vel: new THREE.Vector3((Math.random() - 0.5) * 2.2, 8 + Math.random() * 6, (Math.random() - 0.5) * 2.2),
          grow: 5.5,
          opacity: 0.35,
          drag: 1.8,
          rise: 0.2,
        },
      );
    }
    // Tiny hot grit at the tip of the spout
    const gritN = 2 + (Math.random() < 0.5 ? 1 : 0);
    const ramp = emissiveRamp([2.2, 1.3, 0.45], [0.4, 0.22, 0.08]);
    for (let i = 0; i < gritN; i++) {
      const size = (0.08 + Math.random() * 0.1) * 1.5;
      this._hitPoint.copy(point).add(this._shellStep.set(
        (Math.random() - 0.5) * 0.15, 0.04, (Math.random() - 0.5) * 0.15,
      ));
      this._spawnSpark(
        this._hitPoint,
        this._shellDir.set((Math.random() - 0.5) * 3, 7 + Math.random() * 8, (Math.random() - 0.5) * 3),
        size,
        0.2 + Math.random() * 0.25,
        ramp.from,
        ramp.to,
      );
    }
  }

  /** Head of the streak sits on `pos`; the tail trails back along `dir`. */
  _placeTracer(mesh, pos, dir, visLen, geoLen) {
    mesh.scale.x = visLen / geoLen;
    mesh.quaternion.setFromUnitVectors(_tracerFwd, dir);
    mesh.position.copy(pos).addScaledVector(dir, -visLen * 0.5);
  }

  /** Visual .50 tracer. Damage stays on the hitscan; this is the streak you can see. */
  _spawnMgTracer(pos, dir, maxDist) {
    const d = this._shellDir.copy(dir);
    if (d.lengthSq() < 1e-8) return;
    d.normalize();
    const s = takeMesh(this._tracerPool);
    const listed = this.mgTracers.indexOf(s);
    if (listed >= 0) this.mgTracers.splice(listed, 1);
    s.pos.copy(pos).addScaledVector(d, MG_TRACER_CLEAR);
    s.dir.copy(d);
    s.traveled = 0;
    s.maxDist = maxDist == null ? 450 : Math.max(0.15, maxDist - MG_TRACER_CLEAR);
    this._placeTracer(s.mesh, s.pos, s.dir, MG_TRACER_GEO_LEN, MG_TRACER_GEO_LEN);
    this.mgTracers.push(s);
  }

  /** Impact sparks — white-hot on metal, fewer brown flecks on dirt. */
  _mgImpactSparks(point, normal, dir, dirt = false) {
    const nDot = dir.dot(normal);
    const bounce = dir.clone().addScaledVector(normal, -2 * nDot);
    if (bounce.lengthSq() < 1e-6) bounce.copy(normal);
    else bounce.normalize();

    this._flashLight(
      point.clone().addScaledVector(normal, 0.15),
      dirt ? 18 : 55,
      { color: dirt ? 0x8a6230 : 0xffb060, distance: dirt ? 8 : 14 },
    );

    if (!dirt) {
      this._mgMetalImpact(point, normal, bounce);
      this._mgSparkBurst(point, normal, bounce);
    }

    // Metal particle spray sits under the new impact sheet — keep it a bit smaller.
    const metalScale = dirt ? 1 : 0.75;
    const n = dirt
      ? 6 + Math.floor(Math.random() * 3)   // ~50% of metal count
      : 12 + Math.floor(Math.random() * 6);
    // Dirt: brown → darker earth; metal: hot gold → deep orange. Peak matches SPRITE_EMISSIVE.
    const ramp = dirt
      ? emissiveRamp([2.4, 1.25, 0.4], [0.45, 0.22, 0.08])
      : emissiveRamp([20, 13, 5], [10, 1.8, 0.2]);
    for (let i = 0; i < n; i++) {
      const size = (dirt ? 0.14 + Math.random() * 0.2 : 0.0675 + Math.random() * 0.105) * metalScale;
      // Pivot near the hot head so the tail trails behind the direction of travel.
      this._hitPoint.copy(point).addScaledVector(normal, 0.04 + Math.random() * 0.08);
      const along = (dirt ? 5 + Math.random() * 9 : 10 + Math.random() * 18) * metalScale;
      const spray = (dirt ? 4 + Math.random() * 7 : 8 + Math.random() * 14) * metalScale;
      const v = this._shellDir.copy(bounce).multiplyScalar(along * (0.55 + Math.random() * 0.45))
        .addScaledVector(normal, ((dirt ? 1 : 2) + Math.random() * (dirt ? 4 : 7)) * metalScale)
        .add(this._shellStep.set(Math.random() - 0.5, Math.random() - 0.15, Math.random() - 0.5).multiplyScalar(spray));
      this._spawnSpark(
        this._hitPoint, v, size,
        (dirt ? 0.22 : 0.28) + Math.random() * (dirt ? 0.35 : 0.45),
        ramp.from, ramp.to,
        { streak: !dirt },
      );
    }
  }

  /** Brief spray-shaped flash at a metal hit, fanned along the on-screen ricochet direction. */
  _mgSparkBurst(point, normal, bounce) {
    const i = Math.floor(Math.random() * this._burstBoards.length);
    const s = takeBillboard(this._burstBoards[i]);
    s.mode = 'burst';
    s.pivotX = BURST_ORIGIN_U;
    let ang = Math.random() * Math.PI * 2;
    if (this.camera) {
      const v = this._streakV.copy(bounce).applyQuaternion(this._camQInv);
      if (Math.hypot(v.x, v.y) > 0.15) ang = Math.atan2(v.y, v.x);
    }
    s.rot = ang + (Math.random() - 0.5) * 0.3;
    s.pos.copy(point).addScaledVector(normal, 0.06);
    s.size = (1.1 + Math.random() * 0.5) * 0.75;
    s.life = 0.09 + Math.random() * 0.05;
    const peak = Math.max(12, 7, 2.2);
    s.color.setRGB(12, 7, 2.2).multiplyScalar(SPRITE_EMISSIVE / peak);
  }

  _triggerMgShot(stream) {
    const fx = stream.flash;
    const { pos, dir } = stream.pose;
    fx.starSpin = Math.random() * Math.PI * 2;
    stream.roll = Math.random() * Math.PI;
    this._layoutMgFlash(fx, pos, dir, true, stream.roll);
    const kick = 0.95 + Math.random() * 0.2;
    fx.star.scale.setScalar(MG_FLASH.starSize * kick);
    const ps = MG_FLASH.plumeSize * kick;
    for (const p of fx.plumes) p.scale.set(ps, ps, 1);
    fx.light.intensity = 44 + Math.random() * 28;
    stream.flashAge = 0;
    this._mgSmoke(pos, dir);
    this._ejectMgBrass(pos, dir);
    const shotDir = this._spreadMgDir(dir);
    const hit = this._traceMgBullet(pos, shotDir, stream.owner);
    this._spawnMgTracer(pos, shotDir, hit?.reach ?? null);
    this.onMgShot({
      owner: stream.owner,
      pos,
      dir: shotDir,
      reach: hit?.reach ?? null,
      hitBody: hit?.body ?? null,
    });
  }

  /** One spent casing out the right side of the receiver per round. */
  _ejectMgBrass(pos, dir) {
    const right = gunRight(dir, this._brassRight);
    const up = this._brassUp.set(0, 1, 0);
    const origin = this._hitPoint.copy(pos)
      .addScaledVector(dir, -MG_FLASH.brassBack)
      .addScaledVector(right, MG_FLASH.brassSide)
      .addScaledVector(up, -0.04);
    const vel = this._shellDir.copy(right).multiplyScalar(MG_FLASH.brassSpeed + Math.random() * 2.5)
      .addScaledVector(up, MG_FLASH.brassUp + Math.random() * 2.2)
      .addScaledVector(dir, -1.2 + Math.random() * 2.4);
    const s = takeMesh(this._brassPool);
    s.brass = true;
    s.life = MG_FLASH.brassLife + Math.random() * 0.8;
    s.vel.copy(vel);
    s.spin.set(
      (Math.random() - 0.5) * 36,
      (Math.random() - 0.5) * 48,
      (Math.random() - 0.5) * 36,
    );
    s.mesh.position.copy(origin);
    // Start roughly aligned with eject arc so the silhouette reads as a casing.
    this._hitNormal.copy(vel).normalize();
    s.mesh.quaternion.setFromUnitVectors(this._yAxis, this._hitNormal);
    s.mesh.rotation.setFromQuaternion(s.mesh.quaternion);
  }

  /** Small discharge puffs out of the .50 cal muzzle each round. */
  _mgSmoke(pos, dir) {
    const side = this._mgSide;
    const up = this._mgUp.set(0, 1, 0);
    if (Math.abs(dir.dot(up)) > 0.9) up.set(1, 0, 0);
    side.crossVectors(dir, up).normalize();
    up.crossVectors(side, dir).normalize();

    // +25% vs prior 2–3 puffs.
    const n = 3 + (Math.random() < 0.4 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const origin = pos.clone()
        .addScaledVector(dir, 0.15 + Math.random() * 0.35)
        .addScaledVector(side, (Math.random() - 0.5) * 0.12)
        .addScaledVector(up, (Math.random() - 0.5) * 0.1);
      const v = dir.clone().multiplyScalar(0.6 + Math.random() * 1.4)
        .addScaledVector(side, (Math.random() - 0.5) * 0.7)
        .addScaledVector(up, 0.35 + Math.random() * 0.9);
      this._sprite(
        this.smokeDischargeTex || this.smokeTex,
        'bright',
        origin,
        0.35 + Math.random() * 0.35,
        1.4 + Math.random() * 1.2,
        {
          discharge: true,
          vel: v,
          grow: 3.2 + Math.random() * 1.8,
          rise: 0.7 + Math.random() * 0.5,
          opacity: 0.4 + Math.random() * 0.2,
          drag: 1.3,
        },
      );
    }
  }

  /** Front card sits across the muzzle. Its face is the barrel axis, so it reads head-on. */
  _aimMuzzleFront(mesh, dir) {
    const z = this._muzzleZ.copy(dir);
    const y = this._muzzleY.set(0, 1, 0);
    if (Math.abs(dir.dot(y)) > 0.98) y.set(1, 0, 0);
    const x = this._muzzleX.crossVectors(y, z).normalize();
    y.crossVectors(z, x).normalize();
    this._mgMat.makeBasis(x, y, z);
    mesh.quaternion.setFromRotationMatrix(this._mgMat);
  }

  /**
   * Side card stands upright along the barrel.
   * Texture-left is the narrow tip (at the muzzle); local +X aims downrange.
   */
  _aimMuzzleSide(mesh, dir) {
    const x = this._muzzleX.copy(dir);
    const y = this._muzzleY.set(0, 1, 0);
    y.addScaledVector(dir, -y.dot(dir));
    if (y.lengthSq() < 1e-8) y.set(0, 0, 1);
    y.normalize();
    const z = this._muzzleZ.crossVectors(x, y);
    this._mgMat.makeBasis(x, y, z);
    mesh.quaternion.setFromRotationMatrix(this._mgMat);
  }

  /**
   * One InstancedMesh per atlas. Frame + fade are per-instance attributes (no canvas blit).
   * @param {THREE.Texture} atlasTex
   */
  _ensureCardPool(key, atlasTex, {
    cols, rows, frames, fps, blast = false, soil = false, impact = false,
    inset = 0, emissive = null, mips = false, frameMap = null, poolSize = 4,
    fadeStart = 0.85,
  }) {
    if (!this._cardPools) this._cardPools = new Map();
    let pool = this._cardPools.get(key);
    if (pool) return pool;
    const img = atlasTex.image;
    const cellW = Math.floor(img.width / cols);
    const cellH = Math.floor(img.height / rows);
    const n = poolSize;
    atlasTex.colorSpace = THREE.SRGBColorSpace;
    atlasTex.magFilter = THREE.LinearFilter;
    if (mips) {
      atlasTex.generateMipmaps = true;
      atlasTex.minFilter = THREE.LinearMipmapLinearFilter;
    } else {
      atlasTex.generateMipmaps = false;
      atlasTex.minFilter = THREE.LinearFilter;
    }

    const frameAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    const fadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    frameAttr.setUsage(THREE.DynamicDrawUsage);
    fadeAttr.setUsage(THREE.DynamicDrawUsage);
    const frameNode = instancedDynamicBufferAttribute(frameAttr, 'float');
    const fadeNode = instancedDynamicBufferAttribute(fadeAttr, 'float');
    const sample = texture(atlasTex, atlasUvNode(frameNode, cols, rows, inset));

    const mat = new THREE.MeshBasicNodeMaterial({
      color: new THREE.Color(0, 0, 0),
      lights: false,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    if (soil) {
      mat.colorNode = sample.rgb;
      mat.opacityNode = sample.a.mul(fadeNode);
    } else if (blast) {
      const lum = sample.r.mul(0.299).add(sample.g.mul(0.587)).add(sample.b.mul(0.114));
      const desat = mix(sample.rgb, vec3(lum), float(0.3));
      mat.colorNode = vec3(0, 0, 0);
      mat.emissiveNode = desat.mul(uniform(toEmissiveLevel(new THREE.Color(1.35, 1.2, 0.95))));
      mat.opacityNode = sample.a.mul(fadeNode);
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.SrcAlphaFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      mat.blendEquationAlpha = THREE.AddEquation;
      mat.blendSrcAlpha = THREE.ZeroFactor;
      mat.blendDstAlpha = THREE.OneFactor;
    } else {
      // Muzzle + shell/MG impact sheets: RGB on black, additive emissive (screenspace cards).
      // `emissive` is an absolute peak (skip renormalize so shell impacts can run hotter).
      const peak = emissive ?? MAIN_MUZZLE.emissive;
      const hdr = new THREE.Color(peak, peak, peak);
      mat.colorNode = vec3(0, 0, 0);
      mat.emissiveNode = sample.rgb.mul(uniform(hdr)).mul(fadeNode);
      mat.opacityNode = fadeNode;
      mat.blending = THREE.AdditiveBlending;
    }

    const billboard = blast || soil || impact;
    const mesh = new THREE.InstancedMesh(this.muzzleCardGeo, mat, n);
    mesh.count = n;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = blast || soil ? 2 : 3;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(mesh);

    const slots = [];
    for (let i = 0; i < n; i++) {
      frameAttr.setX(i, 0);
      fadeAttr.setX(i, 0);
      _cardS.set(0, 0, 0);
      _cardP.set(0, -999, 0);
      _cardQ.identity();
      _cardM.compose(_cardP, _cardQ, _cardS);
      mesh.setMatrixAt(i, _cardM);
      const obj = new THREE.Object3D();
      slots.push({
        obj,
        instanceId: i,
        flipbook: {
          cols, rows, frames, fps, frame: -1, height: 0, frameMap,
          cellW, cellH, billboard, fadeStart,
        },
        pool: null,
        idle: true,
        age: 0,
        life: frames / fps,
        muzzleDir: null,
        screenRot: null,
        fade: 1,
      });
    }
    mesh.instanceMatrix.needsUpdate = true;
    pool = { free: slots.slice(), slots, mesh, frameAttr, fadeAttr, billboard };
    for (const s of slots) s.pool = pool;
    this._cardPools.set(key, pool);
    return pool;
  }

  /** Flat ground shockwave discs (normal alpha blend — not emissive). */
  _ensureShockwavePool() {
    if (this._shockwavePool || !this.shellShockwaveTex) return this._shockwavePool;
    const n = 6;
    const tex = this.shellShockwaveTex;
    const fadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    fadeAttr.setUsage(THREE.DynamicDrawUsage);
    const fadeNode = instancedDynamicBufferAttribute(fadeAttr, 'float');
    const sample = texture(tex);
    const mat = new THREE.MeshBasicNodeMaterial({
      color: new THREE.Color(0xffffff),
      lights: false,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      blending: THREE.NormalBlending,
    });
    mat.colorNode = sample.rgb;
    mat.opacityNode = sample.a.mul(fadeNode);
    const mesh = new THREE.InstancedMesh(this.muzzleCardGeo, mat, n);
    mesh.count = n;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 1;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(mesh);
    // Lie flat on XZ (local +Y → world +Y via −90° about X).
    const flatQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const slots = [];
    for (let i = 0; i < n; i++) {
      fadeAttr.setX(i, 0);
      _cardS.set(0, 0, 0);
      _cardP.set(0, -999, 0);
      _cardQ.copy(flatQ);
      _cardM.compose(_cardP, _cardQ, _cardS);
      mesh.setMatrixAt(i, _cardM);
      const obj = new THREE.Object3D();
      obj.quaternion.copy(flatQ);
      slots.push({
        obj,
        instanceId: i,
        pool: null,
        idle: true,
        age: 0,
        life: SHELL_SHOCKWAVE.life,
        endSize: SHELL_SHOCKWAVE.endSize,
        fade: 1,
        shockwave: true,
        flipbook: null,
      });
    }
    mesh.instanceMatrix.needsUpdate = true;
    const pool = { free: slots.slice(), slots, mesh, fadeAttr, flatQ };
    for (const s of slots) s.pool = pool;
    this._shockwavePool = pool;
    return pool;
  }

  /** Soft scorched patches that drape on the heightfield (not flat cards). */
  _ensureScorchPool() {
    if (this._scorchPool || !this.scorchTex) return this._scorchPool;
    const cfg = SCORCHED_EARTH;
    const tex = this.scorchTex;
    const slots = [];
    for (let i = 0; i < cfg.poolSize; i++) {
      const geo = new THREE.PlaneGeometry(cfg.size, cfg.size, cfg.segs, cfg.segs);
      geo.rotateX(-Math.PI / 2);
      const fadeU = uniform(0);
      const sample = texture(tex);
      const mat = new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color(0xffffff),
        lights: false,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: false,
        blending: THREE.NormalBlending,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      mat.colorNode = sample.rgb;
      mat.opacityNode = sample.a.mul(fadeU);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 0;
      mesh.visible = false;
      this.scene.add(mesh);
      slots.push({
        mesh,
        fadeU,
        idle: true,
        age: 0,
        life: cfg.life,
      });
    }
    this._scorchPool = { free: slots.slice(), slots };
    return this._scorchPool;
  }

  _takeScorch() {
    const pool = this._ensureScorchPool();
    let s = pool.free.pop();
    if (!s) {
      s = pool.slots[0];
      for (const c of pool.slots) if (c.age > s.age) s = c;
      const idx = this._scorches.indexOf(s);
      if (idx >= 0) this._scorches.splice(idx, 1);
    }
    s.idle = false;
    s.age = 0;
    s.life = SCORCHED_EARTH.life;
    s.fadeU.value = 1;
    s.mesh.visible = true;
    this._scorches.push(s);
    return s;
  }

  /**
   * 10×10 m burn mark, vertices snapped to terrain height so it won't clip hills.
   * @param {THREE.Vector3} point
   */
  _spawnScorchedEarth(point) {
    if (!this.scorchTex) return;
    const cfg = SCORCHED_EARTH;
    const s = this._takeScorch();
    const cx = point.x;
    const cz = point.z;
    const cy = terrainHeightAt(cx, cz);
    const yaw = Math.random() * Math.PI * 2;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    s.mesh.position.set(cx, cy, cz);
    s.mesh.rotation.set(0, yaw, 0);
    const pos = s.mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const lz = pos.getZ(i);
      const wx = cx + lx * cos - lz * sin;
      const wz = cz + lx * sin + lz * cos;
      pos.setY(i, terrainHeightAt(wx, wz) - cy + cfg.lift);
    }
    pos.needsUpdate = true;
    s.mesh.geometry.computeBoundingSphere();
    s.fadeU.value = 1;
  }

  _syncCardSlot(card) {
    const pool = card.pool;
    const i = card.instanceId;
    if (card.idle) {
      _cardS.set(0, 0, 0);
      _cardP.set(0, -999, 0);
      _cardQ.identity();
      _cardM.compose(_cardP, _cardQ, _cardS);
      pool.mesh.setMatrixAt(i, _cardM);
      pool.fadeAttr.setX(i, 0);
    } else if (card.shockwave) {
      card.obj.updateMatrix();
      pool.mesh.setMatrixAt(i, card.obj.matrix);
      pool.fadeAttr.setX(i, card.fade);
    } else {
      if (card.flipbook.billboard && this.camera) {
        card.obj.quaternion.copy(this._camQ);
        if (card.screenRot != null) {
          _cardQ.setFromAxisAngle(_cardZ, card.screenRot);
          card.obj.quaternion.multiply(_cardQ);
        }
      }
      card.obj.updateMatrix();
      pool.mesh.setMatrixAt(i, card.obj.matrix);
      const atlasFrame = card.flipbook.frameMap
        ? card.flipbook.frameMap[Math.max(0, card.flipbook.frame)]
        : Math.max(0, card.flipbook.frame);
      pool.frameAttr.setX(i, atlasFrame);
      pool.fadeAttr.setX(i, card.fade);
    }
    pool.mesh.instanceMatrix.needsUpdate = true;
    if (pool.frameAttr) pool.frameAttr.needsUpdate = true;
    pool.fadeAttr.needsUpdate = true;
  }

  /** One-shot flipbook splash at a contact point (soil / water), bottom-aligned on the surface. */
  _spawnMgImpact(key, cfg, atlas, point) {
    if (!atlas) return;
    const pool = this._ensureCardPool(key, atlas, {
      cols: cfg.cols, rows: cfg.rows, frames: cfg.frames, fps: cfg.fps,
      poolSize: 12, soil: true,
    });
    const card = this._takeCard(pool);
    const h = cfg.height;
    const { cellW, cellH } = card.flipbook;
    const w = h * (cellW / cellH);
    card.flipbook.height = h;
    card.flipbook.frame = 0;
    card.fade = 1;
    card.obj.scale.set(w, h, 1);
    card.obj.position.set(point.x, point.y + h * 0.5, point.z);
    this._syncCardSlot(card);
  }

  _mgSoilImpact(point) {
    this._spawnMgImpact('mg-soil', MG_SOIL_IMPACT, this.mgSoilImpactAtlas, point);
  }

  _mgWaterImpact(point) {
    this._spawnMgImpact('mg-water', MG_WATER_IMPACT, this.mgWaterImpactAtlas, point);
  }

  /** Screenspace metal-hit flipbook; spray aims along the on-screen ricochet. */
  _mgMetalImpact(point, normal, bounce) {
    const atlas = this.mgMetalImpactAtlas;
    if (!atlas) return;
    const cfg = MG_METAL_IMPACT;
    const pool = this._ensureCardPool('mg-metal', atlas, {
      cols: cfg.cols, rows: cfg.rows, frames: cfg.frames, fps: cfg.fps,
      inset: cfg.inset, mips: cfg.mips, poolSize: 16, impact: true,
    });
    const card = this._takeCard(pool);
    const h = cfg.height;
    const { cellW, cellH } = card.flipbook;
    const w = h * (cellW / cellH);
    card.flipbook.height = h;
    card.flipbook.frame = 0;
    card.fade = 1;
    card.obj.scale.set(w, h, 1);
    // Shift along bounce so the left-biased flash (originU) sits on the contact.
    const along = (0.5 - cfg.originU) * w;
    card.obj.position.copy(point).addScaledVector(normal, 0.08);
    if (bounce && bounce.lengthSq() > 1e-8) {
      card.obj.position.addScaledVector(bounce, along);
    }
    let ang = Math.random() * Math.PI * 2;
    if (this.camera && bounce) {
      const v = this._streakV.copy(bounce).applyQuaternion(this._camQInv);
      if (Math.hypot(v.x, v.y) > 0.15) ang = Math.atan2(v.y, v.x);
    }
    card.screenRot = ang;
    this._syncCardSlot(card);
  }

  _takeCard(pool) {
    let s = pool.free.pop();
    if (!s) {
      s = pool.slots[0];
      for (const c of pool.slots) if (c.age > s.age) s = c;
      const idx = this.particles.indexOf(s);
      if (idx >= 0) this.particles.splice(idx, 1);
    }
    s.idle = false;
    s.age = 0;
    s.muzzleDir = null;
    s.screenRot = null;
    s.baseW = 0;
    s.baseH = 0;
    s.scaleFrom = null;
    s.scaleTo = null;
    if (s.flipbook) s.flipbook.frame = 0;
    s.fade = 1;
    this.particles.push(s);
    return s;
  }

  /** Main-gun non-ground hit — emissive screenspace fireball flipbook. */
  _shellImpactExplosion(point) {
    const atlas = this.shellImpactAtlas;
    if (!atlas) return;
    const cfg = SHELL_IMPACT;
    const pool = this._ensureCardPool('shell-impact', atlas, {
      cols: cfg.cols, rows: cfg.rows, frames: cfg.frames, fps: cfg.fps,
      inset: cfg.inset, emissive: cfg.emissive, mips: cfg.mips, poolSize: 8, impact: true,
      fadeStart: cfg.fadeStart,
    });
    const card = this._takeCard(pool);
    const h = cfg.height;
    const { cellW, cellH } = card.flipbook;
    const w = h * (cellW / cellH);
    card.flipbook.height = h;
    card.flipbook.frame = 0;
    card.fade = 1;
    card.baseW = w;
    card.baseH = h;
    card.scaleFrom = cfg.scaleFrom;
    card.scaleTo = cfg.scaleTo;
    const s0 = cfg.scaleFrom ?? 1;
    card.obj.scale.set(w * s0, h * s0, 1);
    card.obj.position.set(point.x, point.y, point.z);
    this._syncCardSlot(card);

    // Fire-type flash particles (same size as tank burn) — shoot out from the core.
    const nFire = 12 + Math.floor(Math.random() * 5);
    for (let i = 0; i < nFire; i++) {
      const heat = 0.75 + Math.random() * 0.55;
      const a = Math.random() * Math.PI * 2;
      const elev = (Math.random() - 0.15) * Math.PI * 0.55;
      const speed = 28 + Math.random() * 32;
      this._shellDir.set(
        Math.cos(a) * Math.cos(elev) * speed,
        Math.sin(elev) * speed + 6,
        Math.sin(a) * Math.cos(elev) * speed,
      );
      this._sprite(
        this.flashTex,
        new THREE.Color(5.5 * heat, 1.8 * heat, 0.35 * heat),
        this._hitPoint.copy(point).add(this._shellStep.set(
          (Math.random() - 0.5) * 0.25, Math.random() * 0.2, (Math.random() - 0.5) * 0.25,
        )),
        0.55 + Math.random() * 0.5,
        (0.45 + Math.random() * 0.4) * 1.5,
        {
          additive: true,
          grow: 0.35,
          drag: 0.6 + Math.random() * 0.5,
          rise: 0.4,
          vel: this._shellDir,
        },
      );
    }

    // A few metal-hit spark streaks (real particles — not the impact flipbook).
    const ramp = emissiveRamp([20, 13, 5], [10, 1.8, 0.2]);
    const nMetal = 7 + Math.floor(Math.random() * 4);
    for (let i = 0; i < nMetal; i++) {
      const a = Math.random() * Math.PI * 2;
      const elev = 0.05 + Math.random() * 0.6;
      const speed = 28 + Math.random() * 36;
      this._shellDir.set(
        Math.cos(a) * Math.cos(elev) * speed,
        Math.sin(elev) * speed,
        Math.sin(a) * Math.cos(elev) * speed,
      );
      this._spawnSpark(
        this._hitPoint.copy(point).add(this._shellStep.set(
          (Math.random() - 0.5) * 0.2, 0.05 + Math.random() * 0.15, (Math.random() - 0.5) * 0.2,
        )),
        this._shellDir,
        0.1 + Math.random() * 0.14,
        (0.45 + Math.random() * 0.55) * 1.5,
        ramp.from,
        ramp.to,
        { streak: true },
      );
    }
  }

  /** Expanding dirt ring on the ground under a main-gun dirt blast. */
  _spawnShockwave(point) {
    if (!this.shellShockwaveTex) return;
    const pool = this._ensureShockwavePool();
    const card = this._takeCard(pool);
    card.life = SHELL_SHOCKWAVE.life;
    card.endSize = SHELL_SHOCKWAVE.endSize;
    card.fade = 1;
    card.obj.position.set(point.x, point.y + 0.05, point.z);
    card.obj.quaternion.copy(pool.flatQ);
    card.obj.scale.set(0.01, 0.01, 1);
    this._syncCardSlot(card);
  }

  /** One 4-frame strip. `side` lies along the barrel; the front card faces down it. */
  _spawnMainMuzzle(atlas, pos, dir, side, scale = 1) {
    if (!atlas) return;
    const cfg = MAIN_MUZZLE;
    const key = side ? 'muzzle-side' : 'muzzle-front';
    const pool = this._ensureCardPool(key, atlas, cfg);
    const card = this._takeCard(pool);
    const { cellW, cellH } = card.flipbook;
    const h = cfg.height * scale;
    const w = h * (cellW / cellH);
    const obj = card.obj;
    obj.scale.set(w, h, 1);
    if (side) {
      // Narrow tip sits on the muzzle; the flare leads downrange.
      obj.position.copy(pos).addScaledVector(dir, w * 0.35);
      this._aimMuzzleSide(obj, dir);
      if (!card._dir) card._dir = new THREE.Vector3();
      card.muzzleDir = card._dir.copy(dir);
    } else {
      obj.position.copy(pos).addScaledVector(dir, 0.2);
      this._aimMuzzleFront(obj, dir);
    }
    card.flipbook.frame = 0;
    card.fade = 1;
    this._syncCardSlot(card);
  }

  /**
   * Main-gun muzzle flash + dust. `id` tracks linger smoke so the spawn follows the barrel.
   * Call `setMainMuzzle` each frame while the tank is alive so turning the turret re-aims it.
   */
  muzzleFlash(pos, dir, id = 'player') {
    const d = dir.clone();
    if (d.lengthSq() < 1e-8) d.set(1, 0, 0);
    else d.normalize();
    this._spawnMainMuzzle(this.mainMuzzleFront, pos, d, false);
    this._spawnMainMuzzle(this.mainMuzzleSide, pos, d, true);
    this._mainGunDustBurst(pos, d);
    const smoke = this._mainSmokeStreams.get(id);
    if (smoke) {
      smoke.age = 0;
      smoke.pos.copy(pos);
      smoke.dir.copy(d);
      smoke.emitAcc = 0;
    } else {
      this._mainSmokeStreams.set(id, {
        age: 0,
        life: MAIN_MUZZLE_SMOKE.life,
        pos: pos.clone(),
        dir: d.clone(),
        emitAcc: 0,
      });
    }
    // Ground pool ~8 m downrange, dropped 1 m so it reads on the terrain.
    const blastLight = pos.clone().addScaledVector(d, 8);
    blastLight.y -= 1;
    this._flashLight(blastLight, MAIN_GUN_LIGHT.intensity, {
      color: MAIN_GUN_LIGHT.color,
      distance: MAIN_GUN_LIGHT.distance,
      fade: MAIN_GUN_LIGHT.fade,
    });
  }

  /** Keep linger barrel smoke locked to the current muzzle while a stream is active. */
  setMainMuzzle(pose, id = 'player') {
    const s = this._mainSmokeStreams.get(id);
    if (!s || !pose?.pos || !pose?.dir) return;
    s.pos.copy(pose.pos);
    s.dir.copy(pose.dir);
    if (s.dir.lengthSq() > 1e-8) s.dir.normalize();
    else s.dir.set(1, 0, 0);
  }

  /** One-shot discharge cloud shoved out of the bore. */
  _mainGunDustBurst(pos, dir) {
    const side = this._mgSide;
    const up = this._mgUp.set(0, 1, 0);
    if (Math.abs(dir.dot(up)) > 0.9) up.set(1, 0, 0);
    side.crossVectors(dir, up).normalize();
    up.crossVectors(side, dir).normalize();
    // +25% vs prior 6–8 puffs.
    const n = Math.ceil((6 + Math.random() * 3) * 1.25);
    for (let i = 0; i < n; i++) {
      const origin = pos.clone()
        .addScaledVector(dir, 0.2 + Math.random() * 0.8)
        .addScaledVector(side, (Math.random() - 0.5) * 0.55)
        .addScaledVector(up, (Math.random() - 0.5) * 0.4);
      // ×3 along-bore throw vs first pass — reads as a blast toward the target.
      const v = dir.clone().multiplyScalar((2.5 + Math.random() * 4.5) * 3)
        .addScaledVector(side, (Math.random() - 0.5) * 2.2)
        .addScaledVector(up, 0.5 + Math.random() * 1.4);
      this._sprite(
        this.smokeDischargeTex || this.smokeTex,
        'bright',
        origin,
        2.0 + Math.random() * 2.4,
        2.2 + Math.random() * 1.4,
        {
          discharge: true,
          vel: v,
          grow: 4.5 + Math.random() * 2.5,
          rise: 0.55 + Math.random() * 0.4,
          opacity: 0.5 + Math.random() * 0.2,
          drag: MAIN_MUZZLE_SMOKE.drag,
        },
      );
    }
  }

  /** Smaller discharge puffs pushed out along the bore (linger stream). */
  _mainGunBarrelPuff(pos, dir, strength = 1) {
    const side = this._mgSide;
    const up = this._mgUp.set(0, 1, 0);
    if (Math.abs(dir.dot(up)) > 0.9) up.set(1, 0, 0);
    side.crossVectors(dir, up).normalize();
    up.crossVectors(side, dir).normalize();
    const origin = pos.clone()
      .addScaledVector(dir, 0.05 + Math.random() * 0.25)
      .addScaledVector(side, (Math.random() - 0.5) * 0.12)
      .addScaledVector(up, (Math.random() - 0.5) * 0.1);
    const push = MAIN_MUZZLE_SMOKE.push * (0.55 + 0.45 * strength);
    const v = dir.clone().multiplyScalar(push * (0.7 + Math.random() * 0.8))
      .addScaledVector(side, (Math.random() - 0.5) * 0.55)
      .addScaledVector(up, 0.1 + Math.random() * 0.35);
    this._sprite(
      this.smokeDischargeTex || this.smokeTex,
      'bright',
      origin,
      0.45 + Math.random() * 0.45,
      1.35 + Math.random() * 0.9,
      {
        discharge: true,
        vel: v,
        grow: 2.8 + Math.random() * 1.6,
        rise: 0.25 + Math.random() * 0.25,
        opacity: 0.35 + Math.random() * 0.2,
        drag: MAIN_MUZZLE_SMOKE.drag,
      },
    );
  }

  /** Cruiser broadside: a tank muzzle scaled up, plus a thick smoke plume downrange. */
  navalMuzzle(pos, dir) {
    const d = dir.clone();
    if (d.lengthSq() < 1e-8) d.set(1, 0, 0);
    else d.normalize();
    const scale = 5.5;
    this._spawnMainMuzzle(this.mainMuzzleFront, pos, d, false, scale);
    this._spawnMainMuzzle(this.mainMuzzleSide, pos, d, true, scale);
    this._flashLight(pos.clone().addScaledVector(d, 8), 220, { color: 0xffcc66, distance: 70 });
    for (let i = 0; i < 12; i++) {
      const along = 1.5 + Math.random() * 10;
      const puff = pos.clone().addScaledVector(d, along);
      puff.y += Math.random() * 2;
      this._sprite(
        this.smokeTex,
        'bright',
        puff,
        4 + Math.random() * 4,
        2.4 + Math.random() * 1.6,
        {
          vel: d.clone().multiplyScalar(8 + Math.random() * 10).add(new THREE.Vector3(
            (Math.random() - 0.5) * 4,
            5 + Math.random() * 7,
            (Math.random() - 0.5) * 4,
          )),
          grow: 12,
          rise: 1.6,
          opacity: 0.62,
          drag: 0.55,
        },
      );
    }
  }

  /** `owner` is the firing tank's rigid body (its own hull is ignored by the shell).
   *  `aim` (naval) is where this shell is supposed to arrive: hits far from it are ignored. */
  fire({ pos, vel, owner = this.exclude, naval = false, aim = null }) {
    const s = takeMesh(this._shellPool);
    const listed = this.shells.indexOf(s);
    if (listed >= 0) this.shells.splice(listed, 1);
    s.pos.copy(pos);
    s.vel.copy(vel);
    s.owner = owner || undefined;
    s.naval = naval;
    s.aim = aim;
    s.age = 0;
    const dir = this._shellDir.copy(vel);
    if (dir.lengthSq() > 1e-8) dir.normalize();
    else dir.set(1, 0, 0);
    this._placeTracer(s.mesh, s.pos, dir, SHELL_GEO_LEN, SHELL_GEO_LEN);
    s.light.color.set(MAIN_GUN_LIGHT.color);
    s.light.distance = MAIN_GUN_LIGHT.distance;
    s.light.intensity = MAIN_GUN_LIGHT.intensity;
    s.light.position.copy(pos);
    this.shells.push(s);
  }

  _releaseShell(s) {
    s.light.intensity = 0;
    releaseSlot(this._shellPool, s);
  }

  clearShells() {
    for (const s of this.shells) this._releaseShell(s);
    this.shells.length = 0;
    for (const t of this.mgTracers) releaseSlot(this._tracerPool, t);
    this.mgTracers.length = 0;
  }

  /** Destroyed-tank blast: a big flipbook burst plus a second, delayed-looking one above the hull. */
  wreck(pos) {
    const up = new THREE.Vector3(0, 1, 0);
    // No glow ball / sparks here: each spark builds its own node material and the burst hitches the kill frame.
    this._explode(pos.clone(), up, up.clone().negate(), null, { emissive: false });
    this._explode(pos.clone().addScaledVector(up, 1.6), up, up.clone().negate(), null, { emissive: false });
  }

  /** Single free-standing blast (fuel drum): flipbook, sparks, debris, impulse on nearby props. */
  blast(pos) {
    const up = new THREE.Vector3(0, 1, 0);
    this._explode(pos.clone(), up, up.clone().negate(), null);
  }

  /**
   * Smoke-launcher pop: canisters fire out from the tank centre, then bloom into the screen cloud.
   * @param {{ x: number, y: number, z: number }} pos tank origin
   * @param {number} [radius=10.5] cloud radius (land ring scales with it)
   */
  smokeBurst(pos, radius = 10.5) {
    // Soft flat radials only; +25% vs prior 10 jets.
    const n = 13;
    const y0 = pos.y + 1.5;
    const cx = pos.x;
    const cz = pos.z;
    const landR0 = radius * 0.4;
    const landR1 = radius * 0.58;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.12;
      const cos = Math.cos(a), sin = Math.sin(a);
      // Spawn at hull centre — push reads as discharge leaving the tank.
      const origin = new THREE.Vector3(
        cx + cos * (0.35 + Math.random() * 0.4),
        y0 + Math.random() * 0.25,
        cz + sin * (0.35 + Math.random() * 0.4),
      );
      const out = new THREE.Vector3(cos, 0.12 + Math.random() * 0.1, sin);
      // Fast outward jet, soft drag → ease-out settle.
      this._sprite(
        this.smokeFlatTex,
        'bright',
        origin,
        0.7 + Math.random() * 0.45,
        0.85 + Math.random() * 0.35,
        {
          flat: true,
          vel: out.clone().multiplyScalar(16 + Math.random() * 7),
          grow: 9,
          rise: 0.15,
          opacity: 0.95,
          drag: 1.15,
        },
      );
      // Second thinner jet for density (+25% particles overall).
      if (Math.random() < 0.69) {
        this._sprite(
          this.smokeFlatTex,
          'bright',
          origin.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.1, (Math.random() - 0.5) * 0.3)),
          0.45 + Math.random() * 0.3,
          0.7 + Math.random() * 0.3,
          {
            flat: true,
            vel: out.clone().multiplyScalar(12 + Math.random() * 6)
              .add(new THREE.Vector3((Math.random() - 0.5) * 1.2, 0, (Math.random() - 0.5) * 1.2)),
            grow: 7,
            rise: 0.2,
            opacity: 0.85,
            drag: 1.25,
          },
        );
      }
      // Landing bloom still pushed slightly outward from centre.
      const land = new THREE.Vector3(
        cx + cos * (landR0 + Math.random() * (landR1 - landR0)),
        y0 + Math.random() * 0.4,
        cz + sin * (landR0 + Math.random() * (landR1 - landR0)),
      );
      const landOut = new THREE.Vector3(land.x - cx, 0.2, land.z - cz).normalize();
      this._sprite(
        this.smokeFlatTex,
        'bright',
        land,
        2.4 + Math.random() * 1.2,
        2.6 + Math.random() * 1.3,
        {
          flat: true,
          vel: landOut.multiplyScalar(2.5 + Math.random() * 2.2)
            .add(new THREE.Vector3(0, 1.0 + Math.random() * 0.8, 0)),
          grow: 5.2,
          rise: 0.7,
          opacity: 0.95,
          drag: 0.95,
        },
      );
    }
  }

  /**
   * Sustained screen cloud for an active smoke volume. Call every frame while alive.
   * Puffs keep a gentle outward push from the tank/cloud centre.
   * @param {{ x: number, y: number, z: number, r: number }} cloud
   * @param {number} dt
   * @param {number} amount emission strength 0..1+ (includes density multiplier)
   */
  smokeScreen(cloud, dt, amount = 1) {
    // Soft flat radials; +25% vs prior rate 17.5.
    const rate = 21.875 * amount * dt;
    let n = Math.floor(rate);
    if (Math.random() < rate - n) n += 1;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = cloud.r * (0.15 + Math.random() * 0.75);
      const cos = Math.cos(a), sin = Math.sin(a);
      const origin = new THREE.Vector3(
        cloud.x + cos * d,
        cloud.y + Math.random() * 2.2,
        cloud.z + sin * d,
      );
      // Radial push from centre — stronger near the core, eases out via drag.
      const push = (1.2 + Math.random() * 1.8) * (1.15 - d / cloud.r);
      this._sprite(
        this.smokeFlatTex,
        'bright',
        origin,
        3.2 + Math.random() * 2.2,
        2.0 + Math.random() * 1.3,
        {
          flat: true,
          vel: new THREE.Vector3(
            cos * push + (Math.random() - 0.5) * 0.35,
            0.45 + Math.random() * 0.55,
            sin * push + (Math.random() - 0.5) * 0.35,
          ),
          grow: 2.9 + Math.random() * 1.3,
          rise: 0.5,
          opacity: Math.min(1, (0.55 + Math.random() * 0.22) * 1.56),
          drag: 0.85,
        },
      );
    }
  }

  /** Smoke rising off a wreck. A handful of puffs a second. */
  plume(pos, dt) {
    const n = 8 * dt;
    let count = Math.floor(n);
    if (Math.random() < n - count) count += 1;
    for (let i = 0; i < count; i++) {
      this._sprite(
        this.smokeTex,
        'dark',
        pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.6, Math.random() * 0.5, (Math.random() - 0.5) * 1.6)),
        2.2 + Math.random() * 1.4,
        3.2 + Math.random() * 1.6,
        {
          vel: new THREE.Vector3((Math.random() - 0.5) * 0.7, 1.8 + Math.random() * 1.1, (Math.random() - 0.5) * 0.7),
          grow: 5,
          rise: 1.1,
          opacity: 0.5,
          drag: 0.55,
        },
      );
    }
  }

  dust(pos, amount) {
    if (Math.random() > amount) return;
    this._sprite(this.smokeDischargeTex || this.smokeTex, 'beige', pos, 0.8, 1.6 + Math.random(), {
      discharge: true,
      vel: new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.4 + Math.random() * 0.5, (Math.random() - 0.5) * 0.8),
      grow: 3, opacity: 0.35, drag: 1.2,
    });
  }

  /** Keep torn-blade colours in sync with the primary FluffyGrass palette. */
  setGrassColors({ base, tip1, tip2 } = {}) {
    if (base != null) this.grassBitColors[0].set(base);
    if (tip1 != null) this.grassBitColors[1].set(tip1);
    if (tip2 != null) this.grassBitColors[2].set(tip2);
  }

  /**
   * Torn meadow blades ripped up behind the tracks (yellow grass only — caller gates).
   * Amount and size are +50% vs the original track-kick bits.
   * @param {THREE.Vector3} pos world origin at the track / ground
   * @param {number} amount 0..1
   * @param {{ back: THREE.Vector3, out: THREE.Vector3 }} dirs
   */
  grassRip(pos, amount, { back, out } = {}) {
    if (amount < 0.08 || Math.random() > amount * 0.85) return;
    const baseN = 1 + (Math.random() < amount * 0.7 ? 1 : 0);
    const n = Math.max(1, Math.round(baseN * 1.5));
    for (let i = 0; i < n; i++) {
      const bit = takeMesh(this._grassPool);
      bit.color.copy(this.grassBitColors[(Math.random() * this.grassBitColors.length) | 0]);
      bit.life = 1.0 + Math.random() * 0.9;
      bit.mesh.position.copy(pos).addScaledVector(out, (Math.random() - 0.5) * 0.25);
      bit.mesh.position.y += 0.06;
      bit.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      const sc = (0.65 + Math.random() * 0.7) * 1.5;
      bit.mesh.scale.set(sc * (0.7 + Math.random() * 0.5), sc, 1);
      bit.vel.copy(back).multiplyScalar(2.2 + Math.random() * 4.5)
        .addScaledVector(out, 0.6 + Math.random() * 2.8);
      bit.vel.y += 2.2 + Math.random() * 3.5;
      bit.spin.randomDirection().multiplyScalar(10 + Math.random() * 14);
    }
  }

  /**
   * Acceleration kick from a track: rearward dust (+ optional torn grass).
   * @param {THREE.Vector3} pos world origin at the track / ground
   * @param {number} amount 0..1
   * @param {{ back: THREE.Vector3, out: THREE.Vector3, grassy?: boolean }} dirs
   */
  trackKick(pos, amount, { back, out, grassy = false } = {}) {
    if (amount < 0.08) return;
    if (Math.random() < Math.min(1, amount * 1.1)) {
      const v = back.clone().multiplyScalar(1.0 + Math.random() * 2.2)
        .addScaledVector(out, (Math.random() - 0.3) * 1.4)
        .add(new THREE.Vector3(0, 0.6 + Math.random() * 1.1, 0));
      this._sprite(
        this.smokeDischargeTex || this.smokeTex,
        'beige',
        pos.clone()
          .addScaledVector(out, (Math.random() - 0.5) * 0.35)
          .add(new THREE.Vector3(0, 0.05 + Math.random() * 0.08, 0)),
        0.85 + Math.random() * 0.7,
        1.3 + Math.random() * 0.7,
        {
          discharge: true,
          vel: v,
          grow: 3.2,
          opacity: 0.38 + amount * 0.12,
          drag: 1.35,
          rise: 0.25,
        },
      );
    }
    if (grassy) this.grassRip(pos, amount, { back, out });
  }

  /**
   * Steady diesel exhaust — same sprite as muzzle smoke, ~50% darker, continuous under load.
   * @param {THREE.Vector3} pos world origin
   * @param {number} amount 0..1 emission strength
   * @param {THREE.Vector3} back world-space rear direction (unit)
   * @param {THREE.Vector3} up world-space up (unit)
   */
  engineSmoke(pos, amount, back, up) {
    // −25% spawn chance — same puff, fewer of them.
    if (amount < 0.02 || Math.random() > Math.min(1, amount * 1.4) * 0.75) return;
    const side = new THREE.Vector3().crossVectors(up, back).normalize();
    const v = back.clone().multiplyScalar(0.4 + Math.random() * 0.5)
      .addScaledVector(up, 0.55 + Math.random() * 0.35)
      .addScaledVector(side, (Math.random() - 0.5) * 0.25);
    this._sprite(
      this.smokeTex,
      'dark',
      pos.clone()
        .addScaledVector(back, (Math.random() - 0.5) * 0.1)
        .addScaledVector(up, Math.random() * 0.1)
        .addScaledVector(side, (Math.random() - 0.5) * 0.12),
      0.7 + Math.random() * 0.5,
      1.8 + Math.random() * 1.2,
      {
        vel: v,
        grow: 2.2 + Math.random() * 0.8,
        rise: 0.55 + Math.random() * 0.25,
        opacity: (0.45 + Math.random() * 0.2) * 0.5,
        drag: 0.9,
      },
    );
  }

  /**
   * Damaged-tank fire: flickering flames, black smoke and the odd ember. Call every frame.
   * `embers` cuts the flame sprites by 80% and shrinks them into rising sparks (player, under the gif).
   * @param {THREE.Vector3} pos world origin of the fire (engine deck)
   * @param {number} dt frame time
   * @param {number} intensity 1 = damaged, >1 = burning wreck
   * @param {boolean} embers
   */
  burn(pos, dt, intensity = 1, embers = false) {
    const emit = (rate) => {
      const n = rate * intensity * dt;
      return Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
    };
    const jitter = (r) => pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * r, Math.random() * 0.2, (Math.random() - 0.5) * r));
    for (let i = emit(embers ? 6 : 30); i > 0; i--) {
      const heat = 0.7 + Math.random() * 0.6;
      if (embers) {
        this._sprite(this.flashTex, new THREE.Color(7 * heat, 2.4 * heat, 0.45 * heat), jitter(0.4),
          0.07 + Math.random() * 0.08, 0.4 + Math.random() * 0.45, {
            additive: true, grow: 0.35, drag: 1.1, rise: 1.5,
            vel: new THREE.Vector3((Math.random() - 0.5) * 1.6, 2.4 + Math.random() * 2.2, (Math.random() - 0.5) * 1.6),
          });
      } else {
        this._sprite(this.flashTex, new THREE.Color(4.5 * heat, 1.5 * heat, 0.3 * heat), jitter(0.9),
          0.55 + Math.random() * 0.5 * intensity, 0.3 + Math.random() * 0.3, {
            additive: true, grow: 0.35, drag: 2, rise: 4,
            vel: new THREE.Vector3((Math.random() - 0.5) * 0.6, 1.2 + Math.random() * 1.2, (Math.random() - 0.5) * 0.6),
          });
      }
    }
    for (let i = emit(10 * 0.75); i > 0; i--) {
      this._sprite(this.smokeTex, 'dark', jitter(0.6).add(new THREE.Vector3(0, 0.6, 0)),
        0.9 + Math.random() * 0.5, 3 + Math.random() * 1.8, {
          grow: 4 + Math.random() * 1.5, drag: 0.8, rise: 0.9, opacity: 0.6 + Math.random() * 0.2,
          vel: new THREE.Vector3((Math.random() - 0.5) * 0.5 + 0.35, 1.4 + Math.random() * 0.8, (Math.random() - 0.5) * 0.5),
        });
    }
    for (let i = emit(4); i > 0; i--) {
      const size = 0.1 + Math.random() * 0.14;
      this._spawnSpark(
        jitter(0.8),
        this._shellDir.set((Math.random() - 0.5) * 4, 3 + Math.random() * 4, (Math.random() - 0.5) * 4),
        size,
        0.7 + Math.random() * 0.8,
      );
    }
  }

  /** Fire gif. slot 0 = player, 1 = enemy, 2+ = props. stage 0 hides; 1–4 grow with damage. `fade` is 0..1. */
  setDamageFire(pos, stage, slot = 0, fade = 1) {
    const sprite = this.damageFire?.sprites[slot];
    if (!sprite) return;
    const k = fade > 0 ? fade : 0;
    const scale = DAMAGE_FIRE_SCALE[stage] ?? 0;
    const u = sprite.userData.fireFade;
    const light = sprite.userData.fireLight;
    if (scale <= 0 || !pos || k <= 0.02) {
      sprite.visible = false;
      if (u) u.value = 1;
      if (light) light.intensity = 0;
      return;
    }
    sprite.visible = true;
    sprite.position.copy(pos);
    if (u) u.value = k;
    sprite.scale.set(scale, scale, 1);
    // Pivot is near the feet (center.y ≈ 0.02); light sits in the middle of the card.
    // Size tracks damage stage (HP); fade is wreck burn-out. Both scale the light.
    if (light) {
      const maxScale = DAMAGE_FIRE_SCALE[DAMAGE_FIRE_SCALE.length - 1];
      const sizeK = maxScale > 0 ? scale / maxScale : 0;
      light.color.set(FIRE_LIGHT.color);
      light.distance = MAIN_GUN_LIGHT.distance * FIRE_LIGHT.distanceMul * (0.45 + 0.55 * sizeK);
      light.intensity = MAIN_GUN_LIGHT.intensity * FIRE_LIGHT.intensityMul * k * sizeK;
      light.position.copy(pos);
      light.position.y += scale * (0.5 - sprite.center.y);
    }
  }

  /** Metres to the nearest visible fire-gif, or Infinity when nothing is burning. */
  nearestDamageFireDist(from) {
    const sprites = this.damageFire?.sprites;
    if (!sprites || !from) return Infinity;
    let best = Infinity;
    for (const s of sprites) {
      if (!s.visible) continue;
      const d = from.distanceTo(s.position);
      if (d < best) best = d;
    }
    return best;
  }

  _blitDamageFire(frame) {
    const fire = this.damageFire;
    if (!fire || frame === fire.frame) return;
    fire.frame = frame;
    const { gif, image } = fire;
    const idx = gif.frames[frame];
    const pal = gif.palettes[frame];
    const px = image.data;
    for (let i = 0; i < idx.length; i++) {
      const p = idx[i];
      const o = i * 4;
      const c = p * 3;
      px[o] = pal[c];
      px[o + 1] = pal[c + 1];
      px[o + 2] = pal[c + 2];
      // Palette 0 is the black backdrop — punch it out so the quad doesn't cover the tank.
      px[o + 3] = p === 0 ? 0 : 255;
    }
    fire.ctx.putImageData(image, 0, 0);
    fire.map.needsUpdate = true;
  }

  _tickDamageFire(dt) {
    const fire = this.damageFire;
    if (!fire?.sprites.some((s) => s.visible)) return;
    fire.acc += dt;
    const delay = (fire.gif.delays[fire.frame] ?? 0.1) / DAMAGE_FIRE_SPEED;
    if (fire.acc < delay) return;
    fire.acc -= delay;
    if (fire.acc > delay) fire.acc = 0;
    this._blitDamageFire((fire.frame + 1) % fire.gif.frames.length);
  }

  _groundExplosion(point) {
    const cfg = GROUND_EXPLOSION;
    const atlas = this.groundExplosionAtlas;
    if (!atlas) return;
    const pool = this._ensureCardPool('blast', atlas, {
      cols: cfg.cols, rows: cfg.rows, frames: cfg.frameCount, fps: cfg.fps, blast: true,
    });
    const card = this._takeCard(pool);
    const w = cfg.width;
    const h = w / cfg.aspect;
    card.flipbook.height = h;
    card.flipbook.frame = 0;
    card.fade = 1;
    card.obj.scale.set(w, h, 1);
    // Atlas cells are bottom-aligned; cards are centered — lift so contact sits on the ground.
    card.obj.position.set(point.x, point.y + h * 0.5, point.z);
    this._syncCardSlot(card);
  }

  /**
   * A few soft additive warm blobs that linger 0.5 s past the flipbook — fireball afterglow.
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} normal
   * @param {number} flipLife active explosion sprite life (s)
   */
  _explosionWarmPuffs(point, normal, flipLife) {
    const life = flipLife + 0.5;
    const n = 5 + (Math.random() * 3) | 0;
    // Orange / yellow / red — cycle so the mix reads warm, not grey.
    const hues = [
      [1.2, 0.48, 0.06],
      [1.25, 0.9, 0.2],
      [1.1, 0.2, 0.05],
    ];
    for (let i = 0; i < n; i++) {
      const [hr, hg, hb] = hues[i % hues.length];
      const heat = 0.75 + Math.random() * 0.45;
      const a = Math.random() * Math.PI * 2;
      const out = 0.5 + Math.random() * 1.6;
      this._sprite(
        this.flashTex,
        new THREE.Color(hr * heat, hg * heat, hb * heat),
        this._hitPoint.copy(point)
          .addScaledVector(normal, 0.4 + Math.random() * 0.8)
          .add(this._shellStep.set(
            (Math.random() - 0.5) * 1.6,
            0.2 + Math.random() * 0.8,
            (Math.random() - 0.5) * 1.6,
          )),
        1.8 + Math.random() * 2.4,
        life,
        {
          additive: true,
          vel: this._shellDir.set(
            Math.cos(a) * out,
            0.35 + Math.random() * 0.9,
            Math.sin(a) * out,
          ),
          grow: 2.4 + Math.random() * 2.2,
          rise: 0.35 + Math.random() * 0.35,
          drag: 1.1 + Math.random() * 0.4,
          opacity: 0.7 + Math.random() * 0.25,
        },
      );
    }
  }

  _explode(point, normal, dir, collider, { emissive = true, muzzle = false, ground = false } = {}) {
    // Copy off the caller's scratches. Spawns below reuse those vectors.
    point = this._boomPos.copy(point);
    normal = this._boomN.copy(normal);
    dir = this._boomDir.copy(dir);
    // Dirt atlas only on terrain; tanks / props get the new fireball sheet.
    if (ground) {
      this._groundExplosion(point);
      this._spawnShockwave(point);
      this._spawnScorchedEarth(point);
      this._explosionWarmPuffs(point, normal, GROUND_EXPLOSION.frameCount / GROUND_EXPLOSION.fps);
    } else {
      this._shellImpactExplosion(point);
      this._explosionWarmPuffs(point, normal, SHELL_IMPACT.frames / SHELL_IMPACT.fps);
    }
    // Quick emissive glow-ball flash (placeholder texture, additive, fades over glowLife).
    if (emissive && this.impactGlowTex) {
      if (!this._glowBoard) {
        this._glowBoard = createBillboard(this.scene, this.impactGlowTex, 8, {
          emissive: true, renderOrder: 5,
        });
      }
      const glow = takeBillboard(this._glowBoard);
      glow.mode = 'puff';
      glow.scaleToZero = true;
      glow.fadeLinear = true;
      glow.drag = 0;
      glow.rise = 0;
      glow.grow = 0;
      glow.opacity = 1;
      glow.size = GROUND_EXPLOSION.glowSize;
      glow.life = GROUND_EXPLOSION.glowLife;
      glow.pos.copy(point).addScaledVector(normal, 2.5);
      const peak = Math.max(21, 10.5, 2.4);
      glow.color.setRGB(21, 10.5, 2.4).multiplyScalar(SPRITE_EMISSIVE / peak);
    }
    if (muzzle) {
      // Same yellow-orange as the muzzle / shell — never pickup green/purple.
      this._flashLight(this._hitPoint.copy(point).addScaledVector(normal, 1.5), MAIN_GUN_LIGHT.intensity, {
        color: MAIN_GUN_LIGHT.color,
        distance: MAIN_GUN_LIGHT.distance,
        fade: 1,
      });
    } else {
      // Wreck / drum blasts — warm muzzle yellow (never pickup green/purple).
      this._flashLight(this._hitPoint.copy(point).addScaledVector(normal, 1.5), 520, {
        color: MAIN_GUN_LIGHT.color,
        distance: 28,
        fade: 0.4,
      });
    }

    // Emissive sparks: fly out from center, bounce, white → red as they die.
    for (let i = 0; emissive && i < 30; i++) {
      const size = (0.45 + Math.random() * 0.55) * 0.25;
      this._hitPoint.copy(point).addScaledVector(normal, 0.5 + Math.random() * 0.4);
      const v = this._shellDir.copy(normal).multiplyScalar(6 + Math.random() * 10)
        .add(this._shellStep.set(Math.random() - 0.5, Math.random() * 0.35, Math.random() - 0.5).multiplyScalar(14));
      this._spawnSpark(this._hitPoint, v, size, 1.1 + Math.random() * 0.9);
    }

    // Soft edge puffs — bright on dirt, dark on tanks/props.
    const edgeKind = ground ? 'bright' : 'dark';
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = 1.8 + Math.random() * 2.4;
      const v = this._shellDir.set(
        Math.cos(a) * out,
        2.2 + Math.random() * 2.8,
        Math.sin(a) * out,
      );
      this._sprite(
        this.smokeTex,
        edgeKind,
        this._hitPoint.copy(point).add(this._shellStep.set((Math.random() - 0.5) * 1.2, 0.3, (Math.random() - 0.5) * 1.2)),
        1.4 + Math.random() * 1.1,
        1.8 + Math.random() * 1.2,
        { vel: v, grow: 4.5, rise: 1.1, opacity: 0.5, drag: 1.4 },
      );
    }
    // Non-ground (tank / prop) hits: extra dark soot cloud.
    if (!ground) {
      const dustN = 5 + (Math.random() * 3) | 0;
      for (let i = 0; i < dustN; i++) {
        const a = Math.random() * Math.PI * 2;
        const out = 1.2 + Math.random() * 2.8;
        this._sprite(
          this.smokeTex,
          'dark',
          this._hitPoint.copy(point).add(this._shellStep.set(
            (Math.random() - 0.5) * 1.4,
            0.2 + Math.random() * 0.6,
            (Math.random() - 0.5) * 1.4,
          )).addScaledVector(normal, 0.15),
          2.4 + Math.random() * 2.2,
          2.2 + Math.random() * 1.6,
          {
            vel: this._shellDir.set(
              Math.cos(a) * out,
              1.6 + Math.random() * 2.4,
              Math.sin(a) * out,
            ),
            grow: 4.2 + Math.random() * 2.2,
            rise: 0.9 + Math.random() * 0.5,
            opacity: 0.45 + Math.random() * 0.2,
            drag: 1.15,
          },
        );
      }
    }
    for (let i = 0; i < 10; i++) {
      const chunk = takeMesh(this._debrisPool);
      chunk.life = 2.5;
      chunk.mesh.position.copy(point).addScaledVector(normal, 0.2);
      chunk.mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      chunk.vel.copy(normal).multiplyScalar(5 + Math.random() * 8)
        .add(this._shellStep.set(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5).multiplyScalar(9));
      chunk.spin.randomDirection().multiplyScalar(12);
    }

    const body = collider?.parent();
    // onShellHit may have already despawned the hit body (e.g. wooden crates).
    try {
      if (body && body.isDynamic()) body.applyImpulseAtPoint(dir.clone().multiplyScalar(IMPACT_IMPULSE), point, true);
    } catch (_) { /* freed rigid body */ }
    for (const { body: b } of this.dynamic) {
      const p = b.translation();
      const d = new THREE.Vector3(p.x - point.x, p.y - point.y + 0.5, p.z - point.z);
      const dist = d.length();
      if (dist > BLAST_RADIUS) continue;
      b.applyImpulse(d.normalize().multiplyScalar(BLAST_IMPULSE * (1 - dist / BLAST_RADIUS) ** 2 * Math.min(1, b.mass() / 200)), true);
    }
    this.onImpact(point);
    this.onExplosionFlare(point);
  }

  /** HDR sprites and muzzle cards. Smoke and debris stay in the beauty pass. */
  emissiveHot() {
    if (this.particles.length > 0) return true;
    const sprites = this.damageFire?.sprites;
    if (sprites) {
      for (const s of sprites) if (s.visible) return true;
    }
    const boards = [this._flashBoard, this._streakBoard, this._glowBoard];
    if (this._burstBoards) boards.push(...this._burstBoards);
    for (const b of boards) {
      if (b && b.mesh.count > 0 && b.mesh.visible) return true;
    }
    if (this._mgKit) {
      for (const kit of Object.values(this._mgKit)) {
        if (kit.flashVisible) return true;
      }
    }
    return false;
  }

  update(dt, heightAt) {
    this._tickDamageFire(dt);
    if (this.camera) {
      this.camera.getWorldQuaternion(this._camQ);
      this._camQInv.copy(this._camQ).invert();
    }
    for (let i = this._scorches.length - 1; i >= 0; i--) {
      const s = this._scorches[i];
      s.age += dt;
      const k = s.age / s.life;
      if (k >= 1) {
        s.idle = true;
        s.fadeU.value = 0;
        s.mesh.visible = false;
        this._scorchPool.free.push(s);
        this._scorches.splice(i, 1);
        continue;
      }
      const fadeStart = SCORCHED_EARTH.fadeStart;
      s.fadeU.value = k < fadeStart ? 1 : Math.max(0, 1 - (k - fadeStart) / (1 - fadeStart));
    }
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.age += dt;
      const step = this._shellStep.copy(s.vel).multiplyScalar(dt);
      const len = step.length();
      const dir = this._shellDir.copy(step);
      if (len > 1e-8) dir.divideScalar(len);
      else dir.set(0, -1, 0);
      const o = this._shellOrigin;
      const d = this._shellDirN;
      o.x = s.pos.x; o.y = s.pos.y; o.z = s.pos.z;
      d.x = dir.x; d.y = dir.y; d.z = dir.z;
      let hit = this.world.castRayAndGetNormal(this._shellRay, len, true, undefined, undefined, undefined, s.owner || undefined);
      // A cruiser shell is aimed at one point. A ridge or the sea floor along the way
      // used to detonate it early, so the marked circle never got a burst. Hits that
      // start inside a mesh (toi ≈ 0) are the same case: the tracer is still crossing
      // a hill it already entered, not the ground at the aim point.
      if (hit && s.aim) {
        const hx = s.pos.x + dir.x * hit.timeOfImpact;
        const hz = s.pos.z + dir.z * hit.timeOfImpact;
        const far = Math.hypot(hx - s.aim.x, hz - s.aim.z) > s.aim.r;
        if (far || hit.timeOfImpact < 0.05) hit = null;
      }
      const due = s.aim && s.age > s.aim.fuse;
      if (hit || due || s.age > 6) {
        if (hit) {
          this._shellHit.copy(s.pos).addScaledVector(dir, hit.timeOfImpact);
          this._boomN.set(hit.normal.x, hit.normal.y, hit.normal.z);
          this.onShellHit({ point: this._shellHit, collider: hit.collider, owner: s.owner, dir, naval: !!s.naval });
          // Ground/dirt: near terrain with an upward face (tank / metal stay onShellHit only).
          const ground = Math.abs(this._shellHit.y - terrainHeightAt(this._shellHit.x, this._shellHit.z)) < 1.0
            && this._boomN.y > 0.35;
          if (ground) {
            this.onShellDirtHit({
              point: this._shellHit, owner: s.owner, naval: !!s.naval, normal: this._boomN,
            });
          }
          this._explode(this._shellHit, this._boomN, dir, hit.collider, { muzzle: true, ground });
        } else if (due) {
          this._shellHit.set(s.aim.x, s.aim.y, s.aim.z);
          this._boomN.set(0, 1, 0);
          const ground = Math.abs(this._shellHit.y - terrainHeightAt(this._shellHit.x, this._shellHit.z)) < 1.0;
          this._explode(this._shellHit, this._boomN, dir, null, { muzzle: true, ground });
        }
        this._releaseShell(s);
        this.shells.splice(i, 1);
        continue;
      }
      s.pos.add(step);
      s.vel.y -= GRAVITY * dt;
      s.light.position.copy(s.pos);
      const visLen = Math.min(SHELL_VIS_MAX, Math.max(SHELL_GEO_LEN, len * 0.38));
      this._placeTracer(s.mesh, s.pos, dir, visLen, SHELL_GEO_LEN);
    }

    for (const stream of this._mgStreams.values()) {
      stream.shotT += dt;
      if (stream.shotT >= MG_FLASH.shotInterval) {
        stream.shotT -= MG_FLASH.shotInterval;
        this._triggerMgShot(stream);
        // Leave it up for this render. Ageing here hid the flash before draw when dt >= flashLife.
      } else {
        stream.flashAge += dt;
        const alive = stream.flashAge < MG_FLASH.flashLife;
        this._layoutMgFlash(
          stream.flash, stream.pose.pos, stream.pose.dir,
          alive, stream.roll,
        );
        if (alive) {
          const k = stream.flashAge / MG_FLASH.flashLife;
          stream.flash.light.intensity *= Math.max(0, 1 - k * k);
        } else {
          stream.flash.light.intensity = 0;
        }
      }
    }

    // Main-gun barrel linger: small puffs pushed out the bore from the live muzzle pose.
    for (const [id, s] of this._mainSmokeStreams) {
      s.age += dt;
      if (s.age >= s.life) {
        this._mainSmokeStreams.delete(id);
        continue;
      }
      const t = s.age / s.life;
      const strength = (1 - t) * (1 - t);
      s.emitAcc += MAIN_MUZZLE_SMOKE.rate * strength * dt;
      while (s.emitAcc >= 1) {
        s.emitAcc -= 1;
        this._mainGunBarrelPuff(s.pos, s.dir, strength);
      }
    }

    for (let i = this.mgTracers.length - 1; i >= 0; i--) {
      const t = this.mgTracers[i];
      let step = MG_TRACER_SPEED * dt;
      const remain = t.maxDist - t.traveled;
      const done = step >= remain;
      if (done) step = Math.max(0, remain);
      t.traveled += step;
      t.pos.addScaledVector(t.dir, step);
      if (done) {
        releaseSlot(this._tracerPool, t);
        this.mgTracers.splice(i, 1);
        continue;
      }
      // Tail stays in front of the plume. Stretching back to the muzzle ate the flash.
      const visLen = Math.min(MG_TRACER_LEN, Math.max(0.4 * 1.5, t.traveled));
      this._placeTracer(t.mesh, t.pos, t.dir, visLen, MG_TRACER_GEO_LEN);
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        p.idle = true;
        this._syncCardSlot(p);
        p.pool?.free.push(p);
        this.particles.splice(i, 1);
        continue;
      }
      if (p.shockwave) {
        // Ease-out scale (fast expand, settle), linear fade.
        const ease = 1 - (1 - k) * (1 - k);
        const s = Math.max(0.01, p.endSize * ease);
        p.obj.scale.set(s, s, 1);
        p.fade = 1 - k;
        this._syncCardSlot(p);
        continue;
      }
      const fb = p.flipbook;
      fb.frame = Math.min(fb.frames - 1, Math.floor(p.age * fb.fps));
      if (p.muzzleDir) this._aimMuzzleSide(p.obj, p.muzzleDir);
      // Soft fade over the tail so sparse / smoke frames don't hard-cut.
      const fadeStart = fb.fadeStart ?? 0.85;
      p.fade = k > fadeStart ? Math.max(0, 1 - (k - fadeStart) / (1 - fadeStart)) : 1;
      if (p.scaleFrom != null && p.baseW) {
        // Ease-out: fast expand early, settles toward the end.
        const ease = 1 - (1 - k) * (1 - k);
        const s = p.scaleFrom + (p.scaleTo - p.scaleFrom) * ease;
        p.obj.scale.set(p.baseW * s, p.baseH * s, 1);
      }
      this._syncCardSlot(p);
    }

    stepMeshPool(this._debrisPool, dt, heightAt);
    stepMeshPool(this._brassPool, dt, heightAt);
    stepMeshPool(this._grassPool, dt, heightAt);
    syncMeshPool(this._shellPool);
    syncMeshPool(this._tracerPool);
    stepBillboards(
      [
        this._smokeBoard, this._smokeFlatBoard, this._smokeDischargeBoard,
        this._flashBoard, this._streakBoard, this._glowBoard, ...this._burstBoards,
      ],
      dt, heightAt, this._camQ, this._camQInv,
    );

    for (const L of this.lights) {
      L.t += dt;
      const fade = L.fade || 0.25;
      L.light.intensity = L.t < fade ? L.peak * (1 - L.t / fade) ** 2 : 0;
    }
  }
}
