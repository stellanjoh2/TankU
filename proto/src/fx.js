// Shells (ballistic, raycast against the physics world), muzzle flash, impacts, smoke and track dust.
// Selective emissive bloom: put glow energy in `emissive` / `emissiveNode`, not HDR `color`.
import * as THREE from 'three/webgpu';
import { texture, uniform } from 'three/tsl';
import { heightAt as terrainHeightAt } from './terrain.js';

/** Sprite that writes HDR into the emissive MRT (beauty via emissive add, not diffuse color). */
function emissiveSpriteMat(map, hdr, opts = {}) {
  const hdrCol = hdr.isColor ? hdr.clone() : new THREE.Color(hdr);
  const uEm = uniform(hdrCol);
  const mat = new THREE.SpriteNodeMaterial({
    map: map ?? null,
    color: new THREE.Color(0, 0, 0),
    transparent: true,
    depthWrite: false,
    depthTest: opts.depthTest !== false,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    opacity: opts.opacity ?? 1,
  });
  mat.emissiveNode = map ? texture(map).rgb.mul(uEm) : uEm;
  mat.userData.emissiveUniform = uEm;
  return mat;
}

/** MeshBasic stand-in: black albedo + HDR emissive for selective bloom. */
function emissiveBasicMat(hdr, opts = {}) {
  const hdrCol = hdr.isColor ? hdr.clone() : new THREE.Color(hdr);
  return new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: hdrCol,
    emissiveIntensity: 1,
    map: opts.map ?? null,
    emissiveMap: opts.map ?? null,
    transparent: !!opts.transparent,
    depthWrite: opts.depthWrite !== false,
    depthTest: opts.depthTest !== false,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: opts.side ?? THREE.FrontSide,
    toneMapped: false,
    roughness: 1,
    metalness: 0,
  });
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
  width: 22,
  glowUrl: './textures/vfx/T_impact_glow.png',
  glowSize: 24, // 32 * 0.75
  glowLife: 0.5,
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
    this.particles = [];
    this.onImpact = () => {};
    this.onShellHit = () => {};
    this.onMgShot = () => {};
    this.onMgHit = () => {};
    this.groundExplosionAtlas = null;
    this.impactGlowTex = null;

    this.flashTex = radialTexture([[0, '#ffffff'], [0.25, '#ffd28a'], [0.6, 'rgba(255,120,30,0.35)'], [1, 'rgba(255,80,0,0)']]);
    this.smokeTex = radialTexture([[0, 'rgba(255,255,255,0.9)'], [0.5, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]);
    this.shellGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6).rotateZ(Math.PI / 2);
    // WebGL look: unlit HDR streak so beauty-buffer bloom picks it up (emissive-only was invisible).
    this.shellMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(14, 7, 2.5),
      toneMapped: false,
    });
    this.debrisGeo = new THREE.BoxGeometry(0.15, 0.15, 0.15);
    this.debrisMat = new THREE.MeshStandardMaterial({ color: 0x2b2418, roughness: 1 });
    // Tiny torn blades kicked up by tracks on meadows
    this.grassBitGeo = new THREE.PlaneGeometry(0.05, 0.16);
    this.grassBitMat = new THREE.MeshBasicMaterial({
      color: 0x5a8a32,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.grassBitMatB = new THREE.MeshBasicMaterial({
      color: 0x8aad45,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    // First-pass .50 brass: ~2× real size, warm metal so it pops against olive drab.
    this.brassGeo = new THREE.CylinderGeometry(0.045, 0.052, 0.18, 8);
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
  }

  async load() {
    const loader = new THREE.TextureLoader();
    const [tex, glowMap, starMap, plumeMap] = await Promise.all([
      loader.loadAsync(GROUND_EXPLOSION.url),
      loader.loadAsync(GROUND_EXPLOSION.glowUrl),
      loader.loadAsync(MG_FLASH.starUrl),
      loader.loadAsync(MG_FLASH.plumeUrl),
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

    for (const m of [starMap, plumeMap]) {
      m.colorSpace = THREE.SRGBColorSpace;
      m.magFilter = THREE.LinearFilter;
      m.minFilter = THREE.LinearMipmapLinearFilter;
    }

    // Camera-facing star + two barrel-aligned plumes crossed 90° (reads from all angles).
    // Two kits so player + enemy can spray at once.
    const makeKit = () => {
      const starMat = emissiveSpriteMat(
        starMap,
        new THREE.Color(2.2 * 1.25, 1.6 * 1.25, 0.7 * 1.25),
        { additive: true },
      );
      const star = new THREE.Sprite(starMat);
      star.scale.setScalar(MG_FLASH.starSize);
      star.visible = false;
      this.scene.add(star);
      const plumeGeo = new THREE.PlaneGeometry(1, 1);
      const plumes = [0, 1].map(() => {
        const mat = emissiveBasicMat(new THREE.Color(2.0 * 1.25, 1.4 * 1.25, 0.55 * 1.25), {
          map: plumeMap, transparent: true, depthWrite: false, additive: true, side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(plumeGeo, mat);
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
        map: tex, color, transparent: true, depthWrite: false,
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
    if (!hit) return;
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

    const n = dirt
      ? 6 + Math.floor(Math.random() * 3)   // ~50% of metal count
      : 12 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i++) {
      const size = dirt ? 0.14 + Math.random() * 0.2 : 0.18 + Math.random() * 0.28;
      const mat = emissiveSpriteMat(
        this.flashTex,
        dirt ? new THREE.Color(2.2, 1.2, 0.45) : new THREE.Color(14, 12, 6),
        { additive: true },
      );
      const spark = new THREE.Sprite(mat);
      spark.scale.setScalar(size);
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
        // Dirt: brown → darker earth; metal keeps the default white→red fade in update()
        sparkFrom: dirt ? [2.4, 1.25, 0.4] : null,
        sparkTo: dirt ? [0.45, 0.22, 0.08] : null,
      });
    }
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
    this._traceMgBullet(pos, dir, stream.owner);
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

  muzzleFlash(pos, dir) {
    const fwd = pos.clone().addScaledVector(dir, 0.6);
    this._sprite(this.flashTex, new THREE.Color(30, 18, 8), fwd, 2.6, 0.09, { additive: true, grow: 1.6 });
    this._sprite(this.flashTex, new THREE.Color(14, 8, 3), pos.clone().addScaledVector(dir, 1.6), 1.6, 0.07, { additive: true });
    // Brief yellow muzzle spill (~4 m) — same pool as impact flashes, retargeted per shot.
    this._flashLight(fwd, 45, { color: 0xffcc33, distance: 4 });

    // Placeholder anime-style muzzle plume: dense grey cloud at the breech that
    // billows out along the barrel, then hangs and rises. Replace later with real VFX.
    const side = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(dir.dot(up)) > 0.9) up.set(1, 0, 0);
    side.crossVectors(dir, up).normalize();
    up.crossVectors(side, dir).normalize();

    // −25% smoke count vs prior 22 / 8
    for (let i = 0; i < 17; i++) {
      const along = 0.3 + Math.random() * 2.4;
      const spread = (0.4 + Math.random() * 1.1) * (0.35 + along * 0.25);
      const a = Math.random() * Math.PI * 2;
      const origin = pos.clone()
        .addScaledVector(dir, along)
        .addScaledVector(side, Math.cos(a) * spread * 0.35)
        .addScaledVector(up, Math.sin(a) * spread * 0.25);
      const v = dir.clone().multiplyScalar(1.2 + Math.random() * 3.5)
        .addScaledVector(side, (Math.random() - 0.5) * 2.8)
        .addScaledVector(up, 0.4 + Math.random() * 2.2);
      const grey = 0.38 + Math.random() * 0.22;
      this._sprite(
        this.smokeTex,
        new THREE.Color(grey, grey * 0.97, grey * 0.92),
        origin,
        1.4 + Math.random() * 1.8,
        2.8 + Math.random() * 2.4,
        { vel: v, grow: 4.5 + Math.random() * 3, rise: 0.9 + Math.random() * 0.8, opacity: 0.55 + Math.random() * 0.25, drag: 1.4 },
      );
    }
    // Lingering core puff that stays near the muzzle and climbs
    for (let i = 0; i < 6; i++) {
      const v = new THREE.Vector3(
        (Math.random() - 0.5) * 0.8,
        1.2 + Math.random() * 1.6,
        (Math.random() - 0.5) * 0.8,
      ).addScaledVector(dir, 0.4 + Math.random());
      this._sprite(
        this.smokeTex,
        new THREE.Color(0.48, 0.46, 0.43),
        pos.clone().addScaledVector(dir, 0.5 + Math.random() * 0.6),
        2.2 + Math.random(),
        4 + Math.random() * 2,
        { vel: v, grow: 6, rise: 1.4, opacity: 0.7, drag: 1.1 },
      );
    }
  }

  /** `owner` is the firing tank's rigid body (its own hull is ignored by the shell). */
  fire({ pos, vel, owner = this.exclude }) {
    const mesh = new THREE.Mesh(this.shellGeo, this.shellMat);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.shells.push({ mesh, pos: pos.clone(), vel: vel.clone(), age: 0, owner });
  }

  clearShells() {
    for (const s of this.shells) this.scene.remove(s.mesh);
    this.shells.length = 0;
  }

  /** Destroyed-tank blast: a big flipbook burst plus a second, delayed-looking one above the hull. */
  wreck(pos) {
    const up = new THREE.Vector3(0, 1, 0);
    this._explode(pos.clone(), up, up.clone().negate(), null);
    this._explode(pos.clone().addScaledVector(up, 1.6), up, up.clone().negate(), null);
  }

  dust(pos, amount) {
    if (Math.random() > amount) return;
    this._sprite(this.smokeTex, new THREE.Color(0.42, 0.36, 0.26), pos, 0.8, 1.6 + Math.random(), {
      vel: new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.4 + Math.random() * 0.5, (Math.random() - 0.5) * 0.8),
      grow: 3, opacity: 0.35, drag: 1.2,
    });
  }

  /**
   * Acceleration kick from a track: rearward dust + optional torn grass bits.
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
    if (!grassy || Math.random() > amount * 0.85) return;
    const n = 1 + (Math.random() < amount * 0.7 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const mat = Math.random() < 0.45 ? this.grassBitMatB : this.grassBitMat;
      const m = new THREE.Mesh(this.grassBitGeo, mat);
      m.position.copy(pos).addScaledVector(out, (Math.random() - 0.5) * 0.25);
      m.position.y += 0.06;
      m.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      const s = 0.65 + Math.random() * 0.7;
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
   * Steady diesel exhaust — same sprite as muzzle smoke, ~50% darker, continuous under load.
   * @param {THREE.Vector3} pos world origin
   * @param {number} amount 0..1 emission strength
   * @param {THREE.Vector3} back world-space rear direction (unit)
   * @param {THREE.Vector3} up world-space up (unit)
   */
  engineSmoke(pos, amount, back, up) {
    if (amount < 0.02 || Math.random() > Math.min(1, amount * 1.4)) return;
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
   * @param {THREE.Vector3} pos world origin of the fire (engine deck)
   * @param {number} dt frame time
   * @param {number} intensity 1 = damaged, >1 = burning wreck
   */
  burn(pos, dt, intensity = 1) {
    const emit = (rate) => {
      const n = rate * intensity * dt;
      return Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
    };
    const jitter = (r) => pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * r, Math.random() * 0.2, (Math.random() - 0.5) * r));
    for (let i = emit(30); i > 0; i--) {
      const heat = 0.7 + Math.random() * 0.6;
      this._sprite(this.flashTex, new THREE.Color(4.5 * heat, 1.5 * heat, 0.3 * heat), jitter(0.9),
        0.55 + Math.random() * 0.5 * intensity, 0.3 + Math.random() * 0.3, {
          additive: true, grow: 0.35, drag: 2, rise: 4,
          vel: new THREE.Vector3((Math.random() - 0.5) * 0.6, 1.2 + Math.random() * 1.2, (Math.random() - 0.5) * 0.6),
        });
    }
    for (let i = emit(10); i > 0; i--) {
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

    const mat = new THREE.SpriteMaterial({
      map,
      color: new THREE.Color(1.35, 1.2, 0.95),
      transparent: true,
      depthWrite: false,
      opacity: 1,
      toneMapped: false,
    });
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

  _explode(point, normal, dir, collider) {
    // Test: ground-explosion flipbook as the main impact read (kept large).
    this._groundExplosion(point);
    // Quick emissive glow-ball flash (placeholder texture, additive, fades over glowLife).
    if (this.impactGlowTex) {
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
    for (let i = 0; i < 60; i++) {
      const size = (0.45 + Math.random() * 0.55) * 0.5;
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

    for (let i = 0; i < 6; i++) {
      const v = normal.clone().multiplyScalar(1.5 + Math.random() * 3)
        .add(new THREE.Vector3(Math.random() - 0.5, Math.random(), Math.random() - 0.5).multiplyScalar(3));
      this._sprite(this.smokeTex, new THREE.Color(0.3, 0.27, 0.22), point.clone(), 1.2, 2.5 + Math.random() * 1.5,
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
          this._explode(p, new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z), dir, hit.collider);
        }
        this.scene.remove(s.mesh);
        this.shells.splice(i, 1);
        continue;
      }
      s.pos.add(step);
      s.vel.y -= GRAVITY * dt;
      s.mesh.position.copy(s.pos);
      s.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
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
        const from = p.sparkFrom ?? [10, 10, 10];
        const to = p.sparkTo ?? [8, 0.55, 0.06];
        const r = THREE.MathUtils.lerp(from[0], to[0], k);
        const gC = THREE.MathUtils.lerp(from[1], to[1], k);
        const b = THREE.MathUtils.lerp(from[2], to[2], k);
        const em = p.obj.material.userData.emissiveUniform;
        if (em) em.value.setRGB(r, gC, b);
        else p.obj.material.color.setRGB(r, gC, b);
        p.obj.material.opacity = (1 - k) * (1 - k);
        p.obj.scale.setScalar(p.size * (1 - k * 0.65));
        continue;
      }
      if (p.flipbook) {
        const fb = p.flipbook;
        const frame = Math.min(fb.frames - 1, Math.floor(p.age * fb.fps));
        blitFlipbookFrame(fb, frame);
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

    for (const stream of this._mgStreams.values()) {
      stream.shotT += dt;
      if (stream.shotT >= MG_FLASH.shotInterval) {
        stream.shotT -= MG_FLASH.shotInterval;
        this._triggerMgShot(stream);
      } else {
        this._layoutMgFlash(
          stream.flash, stream.pose.pos, stream.pose.dir,
          stream.flashAge < MG_FLASH.flashLife, stream.roll,
        );
      }
      stream.flashAge += dt;
      if (stream.flashAge >= MG_FLASH.flashLife) {
        stream.flash.star.visible = false;
        for (const p of stream.flash.plumes) p.visible = false;
        stream.flash.light.intensity = 0;
      } else {
        const k = stream.flashAge / MG_FLASH.flashLife;
        stream.flash.light.intensity *= Math.max(0, 1 - k * k);
      }
    }
  }
}
