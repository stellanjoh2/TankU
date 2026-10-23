// Shells (ballistic, raycast against the physics world), muzzle flash, impacts, smoke and track dust.
// Glow sprites keep HDR in emissiveNode. Post blooms the whole frame plus that emissive buffer.
import * as THREE from 'three/webgpu';
import { float, smoothstep, texture, uniform, uv, vec4 } from 'three/tsl';
import { heightAt as terrainHeightAt } from './terrain.js';
import { VISUAL_DEFAULTS } from './visualDefaults.js';
import { decodeGif } from './gif.js';

/** Shared glow. Peak channel is this; a tint keeps its hue. */
const SPRITE_EMISSIVE = 2.6;

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
function emissiveCardMat(map, hdr) {
  const hdrCol = toEmissiveLevel(hdr);
  const uEm = uniform(hdrCol);
  const mat = new THREE.MeshBasicNodeMaterial({
    color: new THREE.Color(0, 0, 0),
    lights: false,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    blending: THREE.AdditiveBlending,
  });
  mat.emissiveNode = texture(map).rgb.mul(uEm);
  mat.userData.emissiveUniform = uEm;
  return mat;
}

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

/** Blit one atlas cell into a canvas texture — reliable flipbook on WebGPU (offset/repeat is flaky). */
function blitFlipbookFrame(fb, frame) {
  if (frame === fb.frame) return;
  fb.frame = frame;
  const col = frame % fb.cols;
  const row = Math.floor(frame / fb.cols);
  const { ctx, cellW, cellH, atlasImg } = fb;
  ctx.clearRect(0, 0, cellW, cellH);
  ctx.drawImage(atlasImg, col * cellW, row * cellH, cellW, cellH, 0, 0, cellW, cellH);
  fb.map.needsUpdate = true;
}

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
    this.groundExplosionAtlas = null;
    this.impactGlowTex = null;

    this.flashTex = radialTexture([[0, '#ffffff'], [0.25, '#ffd28a'], [0.6, 'rgba(255,120,30,0.35)'], [1, 'rgba(255,80,0,0)']]);
    this.streakTex = streakTexture();
    this.burstTexs = [11, 4271, 90913].map(sparkBurstTexture);
    // Set from main.js — metal-hit sparks orient their streaks in screen space.
    this.camera = null;
    this.damageFire = null;
    this._camQInv = new THREE.Quaternion();
    this._streakV = new THREE.Vector3();
    this.smokeTex = radialTexture([[0, 'rgba(255,255,255,0.9)'], [0.5, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]);
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
    // Tiny torn blades kicked up by tracks on yellow meadows (match primary grass)
    this.grassBitGeo = new THREE.PlaneGeometry(0.05, 0.16);
    this.grassBitMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(VISUAL_DEFAULTS.grassBase),
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.grassBitMatB = new THREE.MeshBasicMaterial({
      color: new THREE.Color(VISUAL_DEFAULTS.grassTip1),
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.grassBitMatC = new THREE.MeshBasicMaterial({
      color: new THREE.Color(VISUAL_DEFAULTS.grassTip2),
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
      scene.add(l);
      return { light: l, t: 1, peak: 0 };
    });
    this._light = 0;

    this.mgFlash = null; // legacy single kit (player); enemy uses mgFlashB
    this.mgFlashB = null;
    // Active .50 streams: id → { pose, owner, shotT, flashAge, flash, roll }
    this._mgStreams = new Map();
    this._mgUp = new THREE.Vector3();
    this._mgSide = new THREE.Vector3();
    this._mgSide2 = new THREE.Vector3();
    this._mgMat = new THREE.Matrix4();
    this._mgRayOrigin = { x: 0, y: 0, z: 0 };
    this._mgRayDir = { x: 1, y: 0, z: 0 };

    this.mainMuzzleFront = null;
    this.mainMuzzleSide = null;
    this.muzzleCardGeo = new THREE.PlaneGeometry(1, 1);
    this._muzzleX = new THREE.Vector3();
    this._muzzleY = new THREE.Vector3();
    this._muzzleZ = new THREE.Vector3();
  }

  async load() {
    const loader = new THREE.TextureLoader();
    const [tex, glowMap, starMap, plumeMap, muzzleFront, muzzleSide] = await Promise.all([
      loader.loadAsync(GROUND_EXPLOSION.url),
      loader.loadAsync(GROUND_EXPLOSION.glowUrl),
      loader.loadAsync(MG_FLASH.starUrl),
      loader.loadAsync(MG_FLASH.plumeUrl),
      loader.loadAsync(MAIN_MUZZLE.frontUrl),
      loader.loadAsync(MAIN_MUZZLE.sideUrl),
    ]);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    this.groundExplosionAtlas = tex;

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
    // Two kits so player + enemy can spray at once.
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
    const makeKit = () => {
      const star = new THREE.Sprite(flashCard(starMap, 0.02, true));
      star.scale.setScalar(MG_FLASH.starSize);
      star.visible = false;
      this.scene.add(star);
      const plumeGeo = new THREE.PlaneGeometry(1, 1);
      const plumeMat = flashCard(plumeMap, 0.1, false);
      const plumes = [0, 1].map(() => {
        const mesh = new THREE.Mesh(plumeGeo, plumeMat);
        mesh.visible = false;
        this.scene.add(mesh);
        return mesh;
      });
      const light = new THREE.PointLight(0xffb060, 0, 18, 2);
      this.scene.add(light);
      return { star, plumes, light };
    };
    this.mgFlash = makeKit();
    this.mgFlashB = makeKit();

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
    mat.opacityNode = texture(map).a;
    // One shared clip, two sprites — player and enemy can burn at once.
    fire.sprites = [0, 1].map(() => {
      const sprite = new THREE.Sprite(mat);
      sprite.center.set(0.5, 0.02);
      sprite.visible = false;
      sprite.frustumCulled = false;
      sprite.renderOrder = 2;
      this.scene.add(sprite);
      return sprite;
    });
    this.damageFire = fire;
    this._blitDamageFire(0);
  }

  _flashLight(pos, peak, { color = 0xffb060, distance = 40 } = {}) {
    const L = this.lights[this._light++ % this.lights.length];
    L.light.position.copy(pos);
    L.light.color.set(color);
    L.light.distance = distance;
    L.t = 0;
    L.peak = peak;
  }

  _sprite(tex, color, pos, size, life, opts = {}) {
    const mat = opts.additive
      ? emissiveSpriteMat(tex, color, { additive: true })
      : new THREE.SpriteMaterial({
        map: tex, color, transparent: true, depthWrite: false, fog: false,
      });
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.scale.setScalar(size);
    this.scene.add(s);
    this.particles.push({
      obj: s, life, age: 0, vel: opts.vel ?? new THREE.Vector3(), grow: opts.grow ?? 1,
      size, fade: opts.fade ?? 1, drag: opts.drag ?? 1.5, rise: opts.rise ?? 0, opacity: opts.opacity ?? 1,
    });
  }

  /**
   * Hold-to-fire .50 cal. `id` isolates player vs enemy streams.
   * Pass { pos, dir } each frame while firing, or null to stop.
   * `owner` = firing tank rigid body (excluded from the bullet ray).
   */
  setMgFlash(pose, owner = null, id = 'player') {
    if (!this.mgFlash) return;
    if (!pose) {
      const s = this._mgStreams.get(id);
      if (s) {
        s.flash.star.visible = false;
        for (const p of s.flash.plumes) p.visible = false;
        s.flash.light.intensity = 0;
        this._mgStreams.delete(id);
      }
      return;
    }
    let s = this._mgStreams.get(id);
    if (!s) {
      const flash = id === 'enemy' && this.mgFlashB ? this.mgFlashB : this.mgFlash;
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
    fx.star.visible = visible;
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
    fx.plumes[0].visible = visible;

    this._mgMat.makeBasis(up, dir, this._mgSide2.copy(this._mgSide).negate());
    fx.plumes[1].quaternion.setFromRotationMatrix(this._mgMat);
    fx.plumes[1].position.copy(pos).addScaledVector(dir, along);
    fx.plumes[1].scale.set(size, size, 1);
    fx.plumes[1].visible = visible;

    fx.light.position.copy(pos).addScaledVector(dir, 0.3);
  }

  /** Hitscan .50 round — real physics ray so ricochets / damage line up with the barrel. */
  _traceMgBullet(pos, dir, owner) {
    const R = this.RAPIER;
    const o = this._mgRayOrigin;
    const d = this._mgRayDir;
    o.x = pos.x; o.y = pos.y; o.z = pos.z;
    d.x = dir.x; d.y = dir.y; d.z = dir.z;
    const ray = new R.Ray(o, d);
    const hit = this.world.castRayAndGetNormal(ray, 450, true, undefined, undefined, undefined, owner);
    if (!hit) return null;
    const point = pos.clone().addScaledVector(dir, hit.timeOfImpact);
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    // Ground/dirt: near terrain height with an upward face (keeps tank/barrel hits as metal sparks)
    const dirt = Math.abs(point.y - terrainHeightAt(point.x, point.z)) < 0.35 && normal.y > 0.45;
    this._mgImpactSparks(point, normal, dir, dirt);
    this.onMgHit({
      point,
      collider: hit.collider,
      owner,
      dir: dir.clone(),
      normal,
    });
    return hit.timeOfImpact;
  }

  /** Head of the streak sits on `pos`; the tail trails back along `dir`. */
  _placeTracer(mesh, pos, dir, visLen, geoLen) {
    mesh.scale.x = visLen / geoLen;
    mesh.quaternion.setFromUnitVectors(_tracerFwd, dir);
    mesh.position.copy(pos).addScaledVector(dir, -visLen * 0.5);
  }

  /** Visual .50 tracer. Damage stays on the hitscan; this is the streak you can see. */
  _spawnMgTracer(pos, dir, maxDist) {
    const d = dir.clone().normalize();
    if (d.lengthSq() < 1e-8) return;
    const origin = pos.clone().addScaledVector(d, MG_TRACER_CLEAR);
    const mesh = new THREE.Mesh(this.mgTracerGeo, this.mgTracerMat);
    this._placeTracer(mesh, origin, d, MG_TRACER_GEO_LEN, MG_TRACER_GEO_LEN);
    this.scene.add(mesh);
    const reach = maxDist == null ? 450 : Math.max(0.15, maxDist - MG_TRACER_CLEAR);
    this.mgTracers.push({
      mesh,
      pos: origin,
      dir: d,
      traveled: 0,
      maxDist: reach,
    });
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

    if (!dirt) this._mgSparkBurst(point, normal, bounce);

    const n = dirt
      ? 6 + Math.floor(Math.random() * 3)   // ~50% of metal count
      : 12 + Math.floor(Math.random() * 6);
    // Dirt: brown → darker earth; metal: hot gold → deep orange. Peak matches SPRITE_EMISSIVE.
    const ramp = dirt
      ? emissiveRamp([2.4, 1.25, 0.4], [0.45, 0.22, 0.08])
      : emissiveRamp([20, 13, 5], [10, 1.8, 0.2]);
    for (let i = 0; i < n; i++) {
      const size = dirt ? 0.14 + Math.random() * 0.2 : 0.0675 + Math.random() * 0.105;
      const mat = emissiveSpriteMat(
        dirt ? this.flashTex : this.streakTex,
        new THREE.Color(...ramp.from),
        { additive: true },
      );
      const spark = new THREE.Sprite(mat);
      spark.scale.setScalar(size);
      // Pivot near the hot head so the tail trails behind the direction of travel.
      if (!dirt) spark.center.set(0.5, 0.9);
      spark.position.copy(point).addScaledVector(normal, 0.04 + Math.random() * 0.08);
      this.scene.add(spark);
      const along = dirt ? 5 + Math.random() * 9 : 10 + Math.random() * 18;
      const spray = dirt ? 4 + Math.random() * 7 : 8 + Math.random() * 14;
      const v = bounce.clone().multiplyScalar(along * (0.55 + Math.random() * 0.45))
        .addScaledVector(normal, (dirt ? 1 : 2) + Math.random() * (dirt ? 4 : 7))
        .add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.15, Math.random() - 0.5).multiplyScalar(spray));
      this.particles.push({
        obj: spark,
        life: (dirt ? 0.22 : 0.28) + Math.random() * (dirt ? 0.35 : 0.45),
        age: 0,
        vel: v,
        size,
        spark: true,
        streak: !dirt,
        sparkFrom: ramp.from,
        sparkTo: ramp.to,
      });
    }
  }

  /** Brief spray-shaped flash at a metal hit, fanned along the on-screen ricochet direction. */
  _mgSparkBurst(point, normal, bounce) {
    const tex = this.burstTexs[Math.floor(Math.random() * this.burstTexs.length)];
    const mat = emissiveSpriteMat(tex, new THREE.Color(12, 7, 2.2), { additive: true });
    let ang = Math.random() * Math.PI * 2;
    if (this.camera) {
      const v = this._streakV.copy(bounce)
        .applyQuaternion(this.camera.getWorldQuaternion(this._camQInv).invert());
      if (Math.hypot(v.x, v.y) > 0.15) ang = Math.atan2(v.y, v.x);
    }
    mat.rotation = ang + (Math.random() - 0.5) * 0.3;
    const burst = new THREE.Sprite(mat);
    burst.center.set(BURST_ORIGIN_U, 0.5);
    burst.position.copy(point).addScaledVector(normal, 0.06);
    const size = 1.1 + Math.random() * 0.5;
    burst.scale.set(size, size * 0.5, 1);
    this.scene.add(burst);
    this.particles.push({
      obj: burst,
      life: 0.09 + Math.random() * 0.05,
      age: 0,
      size,
      burst: true,
    });
  }

  _triggerMgShot(stream) {
    const fx = stream.flash;
    const { pos, dir } = stream.pose;
    fx.star.material.rotation = Math.random() * Math.PI * 2;
    stream.roll = Math.random() * Math.PI;
    this._layoutMgFlash(fx, pos, dir, true, stream.roll);
    const kick = 0.95 + Math.random() * 0.2;
    fx.star.scale.setScalar(MG_FLASH.starSize * kick);
    const ps = MG_FLASH.plumeSize * kick;
    for (const p of fx.plumes) p.scale.set(ps, ps, 1);
    fx.light.intensity = 22 + Math.random() * 14;
    stream.flashAge = 0;
    this._mgSmoke(pos, dir);
    this._ejectMgBrass(pos, dir);
    const reach = this._traceMgBullet(pos, dir, stream.owner);
    this._spawnMgTracer(pos, dir, reach);
    this.onMgShot({ owner: stream.owner });
  }

  /** One spent casing out the right side of the receiver per round. */
  _ejectMgBrass(pos, dir) {
    const right = gunRight(dir, this._brassRight);
    const up = this._brassUp.set(0, 1, 0);
    const origin = pos.clone()
      .addScaledVector(dir, -MG_FLASH.brassBack)
      .addScaledVector(right, MG_FLASH.brassSide)
      .addScaledVector(up, -0.04);
    const vel = right.clone().multiplyScalar(MG_FLASH.brassSpeed + Math.random() * 2.5)
      .addScaledVector(up, MG_FLASH.brassUp + Math.random() * 2.2)
      .addScaledVector(dir, -1.2 + Math.random() * 2.4);
    const mesh = new THREE.Mesh(this.brassGeo, this.brassMat);
    mesh.position.copy(origin);
    mesh.castShadow = true;
    // Start roughly aligned with eject arc so the silhouette reads as a casing.
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vel.clone().normalize());
    this.scene.add(mesh);
    this.particles.push({
      obj: mesh,
      life: MG_FLASH.brassLife + Math.random() * 0.8,
      age: 0,
      vel,
      brass: true,
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 36,
        (Math.random() - 0.5) * 48,
        (Math.random() - 0.5) * 36,
      ),
    });
  }

  /** Small grey puffs out of the .50 cal muzzle each round. */
  _mgSmoke(pos, dir) {
    const side = this._mgSide;
    const up = this._mgUp.set(0, 1, 0);
    if (Math.abs(dir.dot(up)) > 0.9) up.set(1, 0, 0);
    side.crossVectors(dir, up).normalize();
    up.crossVectors(side, dir).normalize();

    const n = 2 + (Math.random() < 0.35 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const origin = pos.clone()
        .addScaledVector(dir, 0.15 + Math.random() * 0.35)
        .addScaledVector(side, (Math.random() - 0.5) * 0.12)
        .addScaledVector(up, (Math.random() - 0.5) * 0.1);
      const v = dir.clone().multiplyScalar(0.6 + Math.random() * 1.4)
        .addScaledVector(side, (Math.random() - 0.5) * 0.7)
        .addScaledVector(up, 0.35 + Math.random() * 0.9);
      const grey = 0.40 + Math.random() * 0.18;
      this._sprite(
        this.smokeTex,
        new THREE.Color(grey, grey * 0.97, grey * 0.92),
        origin,
        0.35 + Math.random() * 0.35,
        1.4 + Math.random() * 1.2,
        {
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
   * Texture-left is the pointed tip, so local -X aims downrange.
   */
  _aimMuzzleSide(mesh, dir) {
    const x = this._muzzleX.copy(dir).negate();
    const y = this._muzzleY.set(0, 1, 0);
    y.addScaledVector(dir, -y.dot(dir));
    if (y.lengthSq() < 1e-8) y.set(0, 0, 1);
    y.normalize();
    const z = this._muzzleZ.crossVectors(x, y);
    this._mgMat.makeBasis(x, y, z);
    mesh.quaternion.setFromRotationMatrix(this._mgMat);
  }

  /** One 4-frame strip. `side` lies along the barrel; the front card faces down it. */
  _spawnMainMuzzle(atlas, pos, dir, side, scale = 1) {
    const atlasImg = atlas?.image;
    if (!atlasImg) return;
    const cfg = MAIN_MUZZLE;
    const cellW = Math.floor(atlasImg.width / cfg.cols);
    const cellH = Math.floor(atlasImg.height / cfg.rows);
    const canvas = document.createElement('canvas');
    canvas.width = cellW;
    canvas.height = cellH;
    const ctx = canvas.getContext('2d', { alpha: true });
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearFilter;
    map.generateMipmaps = false;
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;

    const flipbook = {
      map, ctx, cellW, cellH, atlasImg,
      cols: cfg.cols, rows: cfg.rows, frames: cfg.frames, fps: cfg.fps,
      frame: -1,
    };
    blitFlipbookFrame(flipbook, 0);

    const hdr = new THREE.Color(cfg.emissive, cfg.emissive, cfg.emissive);
    const h = cfg.height * scale;
    const w = h * (cellW / cellH);
    const mat = emissiveCardMat(map, hdr);
    const obj = new THREE.Mesh(this.muzzleCardGeo, mat);
    obj.scale.set(w, h, 1);
    if (side) {
      // Fat end of the blast sits on the muzzle; the point leads downrange.
      obj.position.copy(pos).addScaledVector(dir, w * 0.35);
      this._aimMuzzleSide(obj, dir);
    } else {
      obj.position.copy(pos).addScaledVector(dir, 0.2);
      this._aimMuzzleFront(obj, dir);
    }
    obj.frustumCulled = false;
    obj.renderOrder = 3;
    this.scene.add(obj);
    this.particles.push({
      obj, life: cfg.frames / cfg.fps, age: 0, vel: new THREE.Vector3(),
      grow: 1, size: w, fade: 1, drag: 0, rise: 0, opacity: 1,
      flipbook,
      muzzleDir: side ? dir.clone() : null,
    });
  }

  muzzleFlash(pos, dir) {
    const d = dir.clone();
    if (d.lengthSq() < 1e-8) d.set(1, 0, 0);
    else d.normalize();
    this._spawnMainMuzzle(this.mainMuzzleFront, pos, d, false);
    this._spawnMainMuzzle(this.mainMuzzleSide, pos, d, true);
    this._flashLight(pos.clone().addScaledVector(d, 0.8), 45, { color: 0xffcc33, distance: 4 });
  }

  /** `owner` is the firing tank's rigid body (its own hull is ignored by the shell). */
  fire({ pos, vel, owner = this.exclude }) {
    const mesh = new THREE.Mesh(this.shellGeo, this.shellMat);
    const dir = vel.clone();
    if (dir.lengthSq() > 1e-8) dir.normalize();
    else dir.set(1, 0, 0);
    this._placeTracer(mesh, pos, dir, SHELL_GEO_LEN, SHELL_GEO_LEN);
    this.scene.add(mesh);
    this.shells.push({ mesh, pos: pos.clone(), vel: vel.clone(), age: 0, owner });
  }

  clearShells() {
    for (const s of this.shells) this.scene.remove(s.mesh);
    this.shells.length = 0;
    for (const t of this.mgTracers) this.scene.remove(t.mesh);
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

  dust(pos, amount) {
    if (Math.random() > amount) return;
    this._sprite(this.smokeTex, new THREE.Color(0.42, 0.36, 0.26), pos, 0.8, 1.6 + Math.random(), {
      vel: new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.4 + Math.random() * 0.5, (Math.random() - 0.5) * 0.8),
      grow: 3, opacity: 0.35, drag: 1.2,
    });
  }

  /** Keep torn-blade colours in sync with the primary FluffyGrass palette. */
  setGrassColors({ base, tip1, tip2 } = {}) {
    if (base != null) this.grassBitMat.color.set(base);
    if (tip1 != null) this.grassBitMatB.color.set(tip1);
    if (tip2 != null) this.grassBitMatC.color.set(tip2);
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
    const mats = [this.grassBitMat, this.grassBitMatB, this.grassBitMatC];
    for (let i = 0; i < n; i++) {
      const mat = mats[(Math.random() * mats.length) | 0];
      const m = new THREE.Mesh(this.grassBitGeo, mat);
      m.position.copy(pos).addScaledVector(out, (Math.random() - 0.5) * 0.25);
      m.position.y += 0.06;
      m.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      const s = (0.65 + Math.random() * 0.7) * 1.5;
      m.scale.set(s * (0.7 + Math.random() * 0.5), s, 1);
      this.scene.add(m);
      const v = back.clone().multiplyScalar(2.2 + Math.random() * 4.5)
        .addScaledVector(out, 0.6 + Math.random() * 2.8)
        .add(new THREE.Vector3(0, 2.2 + Math.random() * 3.5, 0));
      this.particles.push({
        obj: m,
        life: 1.0 + Math.random() * 0.9,
        age: 0,
        vel: v,
        debris: true,
        spin: new THREE.Vector3().randomDirection().multiplyScalar(10 + Math.random() * 14),
      });
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
        this.smokeTex,
        new THREE.Color(0.48, 0.4, 0.28),
        pos.clone()
          .addScaledVector(out, (Math.random() - 0.5) * 0.35)
          .add(new THREE.Vector3(0, 0.05 + Math.random() * 0.08, 0)),
        0.85 + Math.random() * 0.7,
        1.3 + Math.random() * 0.7,
        { vel: v, grow: 3.2, opacity: 0.38 + amount * 0.12, drag: 1.35, rise: 0.25 },
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
    // Turret plume greys are ~0.38–0.60; diesel is half that, then another 25% darker.
    const grey = (0.38 + Math.random() * 0.22) * 0.5 * 0.75;
    const side = new THREE.Vector3().crossVectors(up, back).normalize();
    const v = back.clone().multiplyScalar(0.4 + Math.random() * 0.5)
      .addScaledVector(up, 0.55 + Math.random() * 0.35)
      .addScaledVector(side, (Math.random() - 0.5) * 0.25);
    this._sprite(
      this.smokeTex,
      new THREE.Color(grey, grey * 0.97, grey * 0.92),
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
        opacity: 0.45 + Math.random() * 0.2,
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
      const g = 0.04 + Math.random() * 0.05;
      this._sprite(this.smokeTex, new THREE.Color(g, g, g), jitter(0.6).add(new THREE.Vector3(0, 0.6, 0)),
        0.9 + Math.random() * 0.5, 3 + Math.random() * 1.8, {
          grow: 4 + Math.random() * 1.5, drag: 0.8, rise: 0.9, opacity: 0.6 + Math.random() * 0.2,
          vel: new THREE.Vector3((Math.random() - 0.5) * 0.5 + 0.35, 1.4 + Math.random() * 0.8, (Math.random() - 0.5) * 0.5),
        });
    }
    for (let i = emit(4); i > 0; i--) {
      const size = 0.1 + Math.random() * 0.14;
      const mat = emissiveSpriteMat(this.flashTex, new THREE.Color(10, 10, 10), { additive: true });
      const spark = new THREE.Sprite(mat);
      spark.scale.setScalar(size);
      spark.position.copy(jitter(0.8));
      this.scene.add(spark);
      const v = new THREE.Vector3((Math.random() - 0.5) * 4, 3 + Math.random() * 4, (Math.random() - 0.5) * 4);
      this.particles.push({ obj: spark, life: 0.7 + Math.random() * 0.8, age: 0, vel: v, size, spark: true });
    }
  }

  /** Engine fire for one tank. slot 0 = player, 1 = enemy. stage 0 hides; 1–4 grow with damage. */
  setDamageFire(pos, stage, slot = 0) {
    const sprite = this.damageFire?.sprites[slot];
    if (!sprite) return;
    const scale = DAMAGE_FIRE_SCALE[stage] ?? 0;
    if (scale <= 0 || !pos) {
      sprite.visible = false;
      return;
    }
    sprite.visible = true;
    sprite.position.copy(pos);
    sprite.scale.set(scale, scale, 1);
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
    if (!atlas?.image) return;

    const atlasImg = atlas.image;
    const cellW = Math.floor(atlasImg.width / cfg.cols);
    const cellH = Math.floor(atlasImg.height / cfg.rows);
    const canvas = document.createElement('canvas');
    canvas.width = cellW;
    canvas.height = cellH;
    const ctx = canvas.getContext('2d', { alpha: true });
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearFilter;
    map.generateMipmaps = false;

    const flipbook = {
      map, ctx, cellW, cellH, atlasImg,
      cols: cfg.cols, rows: cfg.rows, frames: cfg.frameCount, fps: cfg.fps,
      frame: -1, height: 0,
    };
    blitFlipbookFrame(flipbook, 0);

    // Atlas stores the fire in RGB and the coverage in alpha. Straight alpha shows
    // that pair; screen was remixing it into the wrong channel. Don't write the
    // card's alpha into the target or the quad stamps a white square.
    const sample = texture(map);
    const mat = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      opacity: 1,
      fog: false,
    });
    mat.colorNode = vec4(0, 0, 0, sample.a);
    mat.emissiveNode = sample.rgb.mul(uniform(toEmissiveLevel(new THREE.Color(1.35, 1.2, 0.95))));
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.SrcAlphaFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendEquationAlpha = THREE.AddEquation;
    mat.blendSrcAlpha = THREE.ZeroFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    const s = new THREE.Sprite(mat);
    const w = cfg.width;
    const h = w / cfg.aspect;
    flipbook.height = h;
    s.scale.set(w, h, 1);
    // Atlas cells are bottom-aligned; sprites are centered — lift so contact sits on the ground.
    s.position.set(point.x, point.y + h * 0.5, point.z);
    this.scene.add(s);
    const life = cfg.frameCount / cfg.fps;
    this.particles.push({
      obj: s, life, age: 0, vel: new THREE.Vector3(), grow: 1, size: w, fade: 1, drag: 0, rise: 0, opacity: 1,
      flipbook,
    });
  }

  _explode(point, normal, dir, collider, { emissive = true, muzzle = false } = {}) {
    // Test: ground-explosion flipbook as the main impact read (kept large).
    this._groundExplosion(point);
    // Main-gun hits reuse the turret firing cards. Plume points out of the surface.
    if (muzzle) {
      const out = normal.clone();
      if (out.lengthSq() < 1e-8) out.copy(dir).negate();
      else out.normalize();
      this._spawnMainMuzzle(this.mainMuzzleFront, point, out, false, 2);
      this._spawnMainMuzzle(this.mainMuzzleSide, point, out, true, 2);
    }
    // Quick emissive glow-ball flash (placeholder texture, additive, fades over glowLife).
    if (emissive && this.impactGlowTex) {
      const glowSize = GROUND_EXPLOSION.glowSize;
      const mat = emissiveSpriteMat(this.impactGlowTex, new THREE.Color(21, 10.5, 2.4), {
        additive: true, depthTest: false,
      });
      const glow = new THREE.Sprite(mat);
      glow.renderOrder = 5;
      glow.scale.setScalar(glowSize);
      glow.position.copy(point).addScaledVector(normal, 2.5);
      this.scene.add(glow);
      this.particles.push({
        obj: glow,
        life: GROUND_EXPLOSION.glowLife,
        age: 0,
        vel: new THREE.Vector3(),
        grow: 0, // scale: size → 0 over life
        size: glowSize,
        fade: 1,
        drag: 0,
        rise: 0,
        opacity: 1,
        fadeLinear: true,
        scaleToZero: true,
      });
    }
    this._flashLight(point.clone().addScaledVector(normal, 1.5), 220);

    // Emissive sparks: fly out from center, bounce, white → red as they die.
    for (let i = 0; emissive && i < 30; i++) {
      const size = (0.45 + Math.random() * 0.55) * 0.25;
      const mat = emissiveSpriteMat(this.flashTex, new THREE.Color(10, 10, 10), { additive: true });
      const spark = new THREE.Sprite(mat);
      spark.scale.setScalar(size);
      spark.position.copy(point).addScaledVector(normal, 0.5 + Math.random() * 0.4);
      this.scene.add(spark);
      const v = normal.clone().multiplyScalar(6 + Math.random() * 10)
        .add(new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.35, Math.random() - 0.5).multiplyScalar(14));
      this.particles.push({
        obj: spark, life: 1.1 + Math.random() * 0.9, age: 0, vel: v, size, spark: true,
      });
    }

    for (let i = 0; i < 3; i++) {
      const v = normal.clone().multiplyScalar(1.5 + Math.random() * 3)
        .add(new THREE.Vector3(Math.random() - 0.5, Math.random(), Math.random() - 0.5).multiplyScalar(3));
      this._sprite(this.smokeTex, new THREE.Color(0.3, 0.27, 0.22), point.clone(), 0.6, 2.5 + Math.random() * 1.5,
        { vel: v, grow: 3.5, rise: 0.7, opacity: 0.45, drag: 1.8 });
    }
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(this.debrisGeo, this.debrisMat);
      m.position.copy(point).addScaledVector(normal, 0.2);
      m.castShadow = true;
      this.scene.add(m);
      const v = normal.clone().multiplyScalar(5 + Math.random() * 8)
        .add(new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5).multiplyScalar(9));
      this.particles.push({ obj: m, life: 2.5, age: 0, vel: v, debris: true, spin: new THREE.Vector3().randomDirection().multiplyScalar(12) });
    }

    const body = collider?.parent();
    if (body && body.isDynamic()) body.applyImpulseAtPoint(dir.clone().multiplyScalar(IMPACT_IMPULSE), point, true);
    for (const { body: b } of this.dynamic) {
      const p = b.translation();
      const d = new THREE.Vector3(p.x - point.x, p.y - point.y + 0.5, p.z - point.z);
      const dist = d.length();
      if (dist > BLAST_RADIUS) continue;
      b.applyImpulse(d.normalize().multiplyScalar(BLAST_IMPULSE * (1 - dist / BLAST_RADIUS) ** 2 * Math.min(1, b.mass() / 200)), true);
    }
    this.onImpact(point);
  }

  update(dt, heightAt) {
    const R = this.RAPIER;
    this._tickDamageFire(dt);
    if (this.camera) this.camera.getWorldQuaternion(this._camQInv).invert();
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.age += dt;
      const step = s.vel.clone().multiplyScalar(dt);
      const len = step.length();
      const dir = step.clone().divideScalar(len);
      const ray = new R.Ray(s.pos, dir);
      const hit = this.world.castRayAndGetNormal(ray, len, true, undefined, undefined, undefined, s.owner);
      if (hit || s.age > 6) {
        if (hit) {
          const p = s.pos.clone().addScaledVector(dir, hit.timeOfImpact);
          this.onShellHit({ point: p, collider: hit.collider, owner: s.owner, dir });
          this._explode(p, new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z), dir, hit.collider, { muzzle: true });
        }
        this.scene.remove(s.mesh);
        this.shells.splice(i, 1);
        continue;
      }
      s.pos.add(step);
      s.vel.y -= GRAVITY * dt;
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

    for (let i = this.mgTracers.length - 1; i >= 0; i--) {
      const t = this.mgTracers[i];
      let step = MG_TRACER_SPEED * dt;
      const remain = t.maxDist - t.traveled;
      const done = step >= remain;
      if (done) step = Math.max(0, remain);
      t.traveled += step;
      t.pos.addScaledVector(t.dir, step);
      if (done) {
        this.scene.remove(t.mesh);
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
        this.scene.remove(p.obj);
        if (
          p.obj.material !== this.debrisMat
          && p.obj.material !== this.brassMat
          && p.obj.material !== this.grassBitMat
          && p.obj.material !== this.grassBitMatB
          && p.obj.material !== this.grassBitMatC
        ) {
          // Flipbook uses a per-burst CanvasTexture — dispose it. Shared atlas stays alive.
          if (p.flipbook) p.flipbook.map.dispose();
          p.obj.material.dispose();
        }
        this.particles.splice(i, 1);
        continue;
      }
      if (p.debris || p.brass) {
        p.vel.y -= GRAVITY * dt;
        p.obj.position.addScaledVector(p.vel, dt);
        const groundPad = p.brass ? 0.05 : 0.07;
        const g = heightAt(p.obj.position.x, p.obj.position.z) + groundPad;
        if (p.obj.position.y < g) {
          p.obj.position.y = g;
          p.vel.multiplyScalar(p.brass ? 0.35 : 0.4);
          p.vel.y = Math.abs(p.vel.y) * (p.brass ? 0.25 : 0.3);
          if (p.brass) p.spin.multiplyScalar(0.55);
        }
        p.obj.rotation.x += p.spin.x * dt;
        p.obj.rotation.y += p.spin.y * dt;
        if (p.brass) p.obj.rotation.z += p.spin.z * dt;
        continue;
      }
      if (p.spark) {
        p.vel.y -= GRAVITY * dt;
        p.obj.position.addScaledVector(p.vel, dt);
        const g = heightAt(p.obj.position.x, p.obj.position.z) + 0.04;
        if (p.obj.position.y < g) {
          p.obj.position.y = g;
          p.vel.x *= 0.55;
          p.vel.z *= 0.55;
          p.vel.y = Math.abs(p.vel.y) * 0.5;
        }
        // Metal: white → red. Dirt: brown → dark earth. Stay emissive either way.
        const from = p.sparkFrom ?? [SPRITE_EMISSIVE, SPRITE_EMISSIVE, SPRITE_EMISSIVE];
        const to = p.sparkTo ?? [8, 0.55, 0.06].map((v) => v * (SPRITE_EMISSIVE / 10));
        const r = THREE.MathUtils.lerp(from[0], to[0], k);
        const gC = THREE.MathUtils.lerp(from[1], to[1], k);
        const b = THREE.MathUtils.lerp(from[2], to[2], k);
        const em = p.obj.material.userData.emissiveUniform;
        if (em) em.value.setRGB(r, gC, b);
        else p.obj.material.color.setRGB(r, gC, b);
        p.obj.material.opacity = (1 - k) * (1 - k);
        const w = p.size * (1 - k * 0.65);
        if (p.streak && this.camera) {
          // Velocity in camera space: x/y give the on-screen direction and the speed across the view.
          const v = this._streakV.copy(p.vel).applyQuaternion(this._camQInv);
          const across = Math.hypot(v.x, v.y);
          p.obj.material.rotation = Math.atan2(v.y, v.x) - Math.PI / 2;
          p.obj.scale.set(w, w * 2.5 + across * 0.044, 1);
        } else {
          p.obj.scale.setScalar(w);
        }
        continue;
      }
      if (p.burst) {
        const s = p.size * (1 + 0.6 * Math.sqrt(k));
        p.obj.scale.set(s, s * 0.5, 1);
        p.obj.material.opacity = 1 - k * k;
        continue;
      }
      if (p.flipbook) {
        const fb = p.flipbook;
        const frame = Math.min(fb.frames - 1, Math.floor(p.age * fb.fps));
        blitFlipbookFrame(fb, frame);
        if (p.muzzleDir) this._aimMuzzleSide(p.obj, p.muzzleDir);
        // Soft fade on the last ~15% so the last sparse frames don't hard-cut.
        p.obj.material.opacity = k > 0.85 ? (1 - (k - 0.85) / 0.15) : 1;
        continue;
      }
      p.vel.multiplyScalar(Math.exp(-p.drag * dt));
      p.vel.y += p.rise * dt;
      p.obj.position.addScaledVector(p.vel, dt);
      const scale = p.scaleToZero
        ? p.size * (1 - k)
        : p.size * (1 + (p.grow - 1) * Math.sqrt(k));
      p.obj.scale.setScalar(scale);
      const fade = p.fadeLinear ? (1 - k) : (1 - k) * (1 - k);
      p.obj.material.opacity = p.opacity * fade;
    }

    for (const L of this.lights) {
      L.t += dt;
      L.light.intensity = L.t < 0.25 ? L.peak * (1 - L.t / 0.25) ** 2 : 0;
    }
  }
}
