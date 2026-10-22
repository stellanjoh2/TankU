import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import { createPost } from './post.js';
import { buildTerrain, heightAt, isGrassable } from './terrain.js';
import { buildProps } from './props.js';
import { buildGrass } from './grass.js';
import { buildVegetation } from './vegetation.js';
import { createVisualsEditor } from './visuals.js';
import { shadowTint, patchShadowTint } from './shadowTint.js';
import { Input } from './input.js';
import { Tank, RELOAD } from './tank.js';
import { Effects } from './fx.js';
import { TankCamera } from './TankCamera.js';
import { Sfx } from './sfx.js';
import { NavGrid } from './navgrid.js';
import { TankAI, pickSpawn } from './ai.js';
import { createHud } from './hud.js';
import './style.css';

const FIXED_DT = 1 / 120;
const sunDir = new THREE.Vector3(-0.45, 0.75, 0.48).normalize();
const SHADOW_EXTENT = 38;
const MIN_SPAWN_GAP = 75;        // metres between the two tanks at round start
const ROUND_RESTART_DELAY = 4;   // seconds the wreck burns before the next round
const ENEMY_TINT = new THREE.Color(0.62, 0.6, 0.58);   // weathered grey vs your olive drab
const IDLE = Object.freeze({ throttle: 0, turn: 0, boost: false });
const SOLO_KEY = 'sherman.solo';

const $ = (id) => document.getElementById(id);

async function main() {
  await RAPIER.init();

  // ---------------------------------------------------------------- renderer / scene
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const horizon = new THREE.Color(0.55, 0.68, 0.74);
  scene.fog = new THREE.Fog(horizon, 70, 240);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(900, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { horizon: { value: horizon }, zenith: { value: new THREE.Color(0.18, 0.32, 0.62) },
                  sunDir: { value: sunDir }, sunColor: { value: new THREE.Color(8, 6.5, 4.5) } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec3 vDir; uniform vec3 horizon, zenith, sunDir, sunColor;
        void main(){ float h = max(vDir.y, 0.0);
          vec3 c = mix(horizon, zenith, pow(h, 0.55));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          c += sunColor * pow(s, 900.0) + vec3(1.0, 0.8, 0.55) * pow(s, 12.0) * 0.25;
          gl_FragColor = vec4(c, 1.0); }`,
    }),
  );
  scene.add(sky);

  const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.93, 0.82), 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -SHADOW_EXTENT, right: SHADOW_EXTENT, top: SHADOW_EXTENT,
                                     bottom: -SHADOW_EXTENT, near: 1, far: 260 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = 2.5;
  sun.shadow.intensity = 1;
  scene.add(sun, sun.target);

  // Soft warm sun flare (less saturated than a classic red Knoll look)
  {
    const loader = new THREE.TextureLoader();
    const flare0 = loader.load('./textures/lensflare/lensflare0.png');
    const flare2 = loader.load('./textures/lensflare/lensflare2.png');
    const flare3 = loader.load('./textures/lensflare/lensflare3.png');
    const warm = new THREE.Color(1.0, 0.94, 0.86);
    const soft = new THREE.Color(1.0, 0.88, 0.78);
    const pale = new THREE.Color(0.95, 0.92, 0.88);
    const lensflare = new Lensflare();
    lensflare.addElement(new LensflareElement(flare0, 520, 0, warm));
    lensflare.addElement(new LensflareElement(flare3, 48, 0.35, soft));
    lensflare.addElement(new LensflareElement(flare2, 36, 0.5, pale));
    lensflare.addElement(new LensflareElement(flare3, 60, 0.6, soft));
    lensflare.addElement(new LensflareElement(flare3, 70, 0.7, pale));
    lensflare.addElement(new LensflareElement(flare2, 50, 0.85, soft));
    lensflare.addElement(new LensflareElement(flare3, 100, 0.9, pale));
    lensflare.addElement(new LensflareElement(flare3, 55, 1.0, warm));
    sun.add(lensflare);
  }

  const hemi = new THREE.HemisphereLight(new THREE.Color(0.55, 0.65, 0.85), new THREE.Color(0.32, 0.27, 0.18), 0.85);
  const ambient = new THREE.AmbientLight(0xffffff, 0.12);
  scene.add(hemi, ambient);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 2000);
  const post = createPost(renderer, scene, camera);

  // ---------------------------------------------------------------- world
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  const terrain = buildTerrain(RAPIER, world, scene);
  const props = buildProps(RAPIER, world, scene);
  const [grass, vegetation] = await Promise.all([
    buildGrass(scene),
    buildVegetation(scene, { RAPIER, world }),
  ]);

  const loader = new GLTFLoader();
  const [gltf, enemyGltf] = await Promise.all([
    loader.loadAsync('./models/sherman.glb'),
    loader.loadAsync('./models/sherman.glb'),
  ]);
  const spawn = { x: -8, y: heightAt(-8, -5) + 0.6, z: -5, yaw: 0 };
  const tank = new Tank(gltf, RAPIER, world, spawn);
  scene.add(tank.model);
  const fx = new Effects(scene, RAPIER, world, tank.body, props.dynamic);

  const nav = new NavGrid();
  nav.setObstacles(vegetation.navObstacles());
  const enemySpawn = pickSpawn(nav, spawn, MIN_SPAWN_GAP);
  const enemy = new Tank(enemyGltf, RAPIER, world, enemySpawn, { tint: ENEMY_TINT });
  scene.add(enemy.model);
  const ai = new TankAI({ tank: enemy, enemy: tank, nav, world, RAPIER, coverRocks: vegetation.coverRocks });
  const hud = createHud();

  const tankCam = new TankCamera(camera);
  tankCam.setColliders([terrain.mesh, vegetation.coverRoot]);
  const sfx = new Sfx();
  await Promise.all([sfx.load(), fx.load()]);

  // ---------------------------------------------------------------- round state
  const game = {
    solo: localStorage.getItem(SOLO_KEY) === '1',
    showPath: false,
    overT: 0,          // > 0 while a wreck burns before the auto-restart
    wreck: null,       // the destroyed tank
  };

  const pathLine = new THREE.Line(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(256 * 3), 3)),
    new THREE.LineBasicMaterial({ color: new THREE.Color(4, 3, 0.4), depthTest: false, fog: false }),
  );
  pathLine.frustumCulled = false;
  pathLine.renderOrder = 10;
  pathLine.visible = false;
  scene.add(pathLine);

  function updatePathLine() {
    pathLine.visible = game.showPath && !game.solo;
    if (!pathLine.visible) { hud.debug(''); return; }
    const { mode, mood, path } = ai.debug;
    const attr = pathLine.geometry.attributes.position;
    const n = Math.min(path.length, 255);
    const p = enemy.body.translation();
    attr.setXYZ(0, p.x, p.y + 1.5, p.z);
    for (let i = 0; i < n; i++) attr.setXYZ(i + 1, path[i].x, heightAt(path[i].x, path[i].z) + 1.5, path[i].z);
    attr.needsUpdate = true;
    pathLine.geometry.setDrawRange(0, n + 1);
    hud.debug(`AI ${mode} · ${mood}${ai.visible ? ' · sees you' : ''}`);
  }

  patchShadowTint(scene);
  const visuals = createVisualsEditor({
    scene, sky, sun, sunDir, hemi, ambient, terrain, grass, vegetation, post, shadowTint,
    getEnvIntensity: () => scene.environmentIntensity,
    setEnvIntensity: (v) => { scene.environmentIntensity = v; },
    game: {
      getSolo: () => game.solo,
      setSolo: (v) => {
        game.solo = v;
        localStorage.setItem(SOLO_KEY, v ? '1' : '0');
        restartGame({ resetCam: false });
      },
      getShowPath: () => game.showPath,
      setShowPath: (v) => { game.showPath = v; },
    },
  });

  const input = new Input(renderer.domElement);
  // unlock audio on first gesture (pointer lock / click / key)
  const unlockAudio = () => sfx.unlock();
  addEventListener('pointerdown', unlockAudio, { once: true });
  addEventListener('keydown', unlockAudio, { once: true });
  fx.onImpact = (p) => {
    const d = p.distanceTo(tank.model.position);
    if (d < 40) {
      input.rumble(0.6 * (1 - d / 40), 0.3, 160);
      tankCam.addShake(0.45 * (1 - d / 40));
    }
  };
  fx.onMgShot = () => tankCam.pulseMgShake();
  fx.onShellHit = ({ collider, owner }) => {
    const body = collider?.parent();
    if (!body || game.overT > 0) return;
    const victim = [tank, enemy].find((t) => t.body.handle === body.handle);
    if (!victim || victim.body === owner || !victim.alive) return;
    victim.hp -= 1;
    sfx.hit(1);
    if (victim === tank) {
      hud.flash();
      if (owner) hud.hitFrom(owner.translation());
      if (owner === enemy.body) ai.onScored();
      input.rumble(1, 1, 450);
      tankCam.addShake(0.9);
    } else {
      ai.onHit();
    }
    hud.setHealth(tank.hp / tank.maxHp, enemy.hp / enemy.maxHp);
    if (!victim.alive) {
      fx.wreck(new THREE.Vector3().copy(victim.body.translation()).add(new THREE.Vector3(0, 1.2, 0)));
      tankCam.addShake(victim === tank ? 1 : 0.4);
      game.overT = ROUND_RESTART_DELAY;
      game.wreck = victim;
      hud.banner(victim === tank ? 'YOU WERE DESTROYED' : 'ENEMY DESTROYED', 'next round in a moment…');
    }
  };
  // ---------------------------------------------------------------- resize
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    post.setSize(innerWidth, innerHeight);
  });

  // ---------------------------------------------------------------- camera + aim helpers
  // Mouse look drives TankCamera's turret blend; hull yaw is body heading (+X forward).
  let lookYaw = spawn.yaw;
  let lookPitch = -0.08;
  const viewDir = new THREE.Vector3();
  const aimPoint = new THREE.Vector3();
  const gunPoint = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _euler = new THREE.Euler();
  let prevLookYaw = spawn.yaw;

  function bodyYaw() {
    _fwd.set(1, 0, 0).applyQuaternion(_q.copy(tank.body.rotation()));
    return Math.atan2(-_fwd.z, _fwd.x);
  }

  function bodyPitch() {
    _euler.setFromQuaternion(_q.copy(tank.body.rotation()), 'YXZ');
    return _euler.x;
  }

  function camState(turretTurn = 0) {
    return {
      position: camPos.copy(tank.body.translation()),
      heading: bodyYaw(),
      turretYaw: lookYaw,
      turretPitch: lookPitch,
      speed: tank.forwardSpeed(),
      throttle: tank.cmd.throttle,
      steer: tank.cmd.turn,
      turretTurn,
      pitch: bodyPitch(),
    };
  }

  function snapCam() {
    lookYaw = bodyYaw();
    lookPitch = -0.08;
    prevLookYaw = lookYaw;
    tankCam.snap(camState());
  }

  function resetCameraDefaults() {
    tankCam.resetDefaults();
    snapCam();
  }

  function restartGame({ resetCam = true } = {}) {
    tank.respawn(spawn);
    fx.clearShells();
    nav.setObstacles(vegetation.navObstacles());   // palm slider may have changed
    enemy.setActive(!game.solo);
    if (!game.solo) {
      enemy.respawn(pickSpawn(nav, spawn, MIN_SPAWN_GAP));
      ai.reset();
    }
    game.overT = 0;
    game.wreck = null;
    hud.banner(null);
    hud.clearHits();
    hud.showEnemy(!game.solo);
    hud.setHealth(1, 1);
    lookYaw = spawn.yaw;
    lookPitch = -0.08;
    prevLookYaw = lookYaw;
    if (resetCam) tankCam.resetDefaults();
    snapCam();
  }

  $('reset-cam').addEventListener('click', (e) => {
    e.stopPropagation();
    resetCameraDefaults();
  });
  $('restart-game').addEventListener('click', (e) => {
    e.stopPropagation();
    restartGame();
  });

  input.onPress = (code) => {
    if (code === 'KeyR') { tank.reset(heightAt); snapCam(); }
    if (code === 'KeyV') visuals.toggle();
  };

  function castFrom(origin, dir, maxDist, out) {
    const hit = world.castRay(new RAPIER.Ray(origin, dir), maxDist, true, undefined, undefined, undefined, tank.body);
    return out.copy(origin).addScaledVector(dir, hit ? hit.timeOfImpact : maxDist);
  }

  function updateCamera(dt, inp) {
    lookYaw -= inp.aimX;
    lookPitch = THREE.MathUtils.clamp(lookPitch - inp.aimY, -0.75, 0.45);

    if (inp.zoom) {
      const k = 1 + inp.zoom * 0.08;
      tankCam.cfg.distanceMin = THREE.MathUtils.clamp(tankCam.cfg.distanceMin * k, 4, 16);
      tankCam.cfg.distanceMax = THREE.MathUtils.clamp(tankCam.cfg.distanceMax * k, tankCam.cfg.distanceMin + 1, 22);
    }

    const turretTurn = THREE.MathUtils.clamp(
      (lookYaw - prevLookYaw) / Math.max(dt, 1e-4) / 2.6, -1, 1,
    );
    prevLookYaw = lookYaw;

    tankCam.update(dt, camState(turretTurn));

    // ADS: pull FOV in on top of speed zoom
    if (inp.zoomHold) {
      camera.fov = THREE.MathUtils.damp(camera.fov, 28, 8, dt);
      camera.updateProjectionMatrix();
    }

    // Aim through screen center (crosshair), not raw lookYaw — camera lag/blend
    // means those diverge; turret must track what the reticle actually sees.
    camera.getWorldDirection(viewDir);
  }

  function updateSun() {
    const tp = tank.model.position;
    const step = (2 * SHADOW_EXTENT) / sun.shadow.mapSize.x;
    sun.target.position.set(Math.round(tp.x / step) * step, tp.y, Math.round(tp.z / step) * step);
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 120);
    sun.target.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- reticle + start overlay
  const gunMarker = $('gun-marker');
  const projected = new THREE.Vector3();

  function updateHud(inp) {
    projected.copy(gunPoint).project(camera);
    const visible = projected.z < 1;
    gunMarker.style.display = visible ? 'block' : 'none';
    if (visible) {
      gunMarker.style.transform =
        `translate(${(projected.x * 0.5 + 0.5) * innerWidth}px, ${(-projected.y * 0.5 + 0.5) * innerHeight}px)`;
    }
    // Hide while driving, on gamepad, or while the visuals editor has the cursor
    $('overlay').classList.toggle('hidden', input.locked || !!inp.pad || visuals.open);
  }

  // ---------------------------------------------------------------- loop
  restartGame();
  let acc = 0;
  let last = performance.now();
  let elapsed = 0;
  const dustPoint = new THREE.Vector3();
  const exhaustPoint = new THREE.Vector3();
  const exhaustBack = new THREE.Vector3();
  const exhaustUp = new THREE.Vector3();
  const kickBack = new THREE.Vector3();
  const kickOut = new THREE.Vector3();
  // Hull local: +X forward, exhaust sits on the rear deck
  const EXHAUST_LOCAL = new THREE.Vector3(-2.55, 1.85, 0);
  const WRECK_LOCAL = new THREE.Vector3(-0.2, 2.6, 0);
  const BURN_LOCAL = new THREE.Vector3(-1.7, 2.05, 0.35);   // engine deck behind the turret
  const burnPoint = new THREE.Vector3();

  /** Track dust, diesel exhaust and track kick for one tank; damaged tanks burn, wrecks smoke. */
  function tankFx(t, dt) {
    const mw = t.model.matrixWorld;
    if (t.hp < t.maxHp) fx.burn(burnPoint.copy(BURN_LOCAL).applyMatrix4(mw), dt, t.alive ? 1 : 1.6);
    if (!t.alive) {
      exhaustPoint.copy(WRECK_LOCAL).applyMatrix4(mw);
      exhaustUp.set(0, 1, 0);
      exhaustBack.set(-1, 0, 0).transformDirection(mw);
      fx.engineSmoke(exhaustPoint, 1, exhaustBack, exhaustUp);
      return;
    }
    for (const s of t.sides) {
      const amount = Math.min(1, Math.abs(s.speed) / 8) * 0.5;
      if (t.grounded && amount > 0.05) {
        dustPoint.set(-2.4 * Math.sign(s.speed || 1), 0.15, s.z).applyMatrix4(mw);
        fx.dust(dustPoint, amount);
      }
    }
    // Diesel exhaust + track dust/grass while accelerating (throttle on, speed catching up)
    const thr = Math.abs(t.cmd.throttle);
    if (thr <= 0.08) return;
    const spd = Math.abs(t.forwardSpeed());
    const top = t.cmd.throttle >= 0 ? 12.5 : 4.0;
    const deficit = Math.max(0, thr * top - spd);
    const accel = thr * (0.25 + 0.75 * Math.min(1, deficit / 5));
    if (accel > 0.05) {
      exhaustPoint.copy(EXHAUST_LOCAL).applyMatrix4(mw);
      exhaustBack.set(-1, 0, 0).transformDirection(mw);
      exhaustUp.set(0, 1, 0).transformDirection(mw);
      fx.engineSmoke(exhaustPoint, accel, exhaustBack, exhaustUp);
    }
    if (t.grounded && accel > 0.12) {
      const sign = Math.sign(t.cmd.throttle || 1);
      kickBack.set(-sign, 0, 0).transformDirection(mw);
      for (const s of t.sides) {
        dustPoint.set(-2.35 * sign, 0.1, s.z).applyMatrix4(mw);
        kickOut.set(0, 0, Math.sign(s.z || 1)).transformDirection(mw);
        fx.trackKick(dustPoint, accel, {
          back: kickBack,
          out: kickOut,
          grassy: isGrassable(dustPoint.x, dustPoint.z),
        });
      }
    }
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    elapsed += dt;
    input.setEnabled(!visuals.open);
    const inp = input.read(dt);
    if (inp.padPressed.includes(9)) { tank.reset(heightAt); snapCam(); }

    const versus = !game.solo;
    if (versus) ai.update(dt, { halt: game.overT > 0 });
    const playerDrive = tank.alive ? inp : IDLE;
    const enemyDrive = enemy.alive ? ai.drive : IDLE;

    acc += dt;
    while (acc >= FIXED_DT) {
      tank.physicsStep(FIXED_DT, playerDrive);
      if (versus) enemy.physicsStep(FIXED_DT, enemyDrive);
      world.step();
      acc -= FIXED_DT;
    }
    props.sync();

    updateCamera(dt, inp);
    castFrom(camera.position, viewDir, 1200, aimPoint);
    tank.update(dt, tank.alive ? aimPoint : null);
    const m = tank.muzzle();
    castFrom(m.pos, m.dir, 1200, gunPoint);

    if (inp.fire && tank.alive) {
      const shot = tank.tryFire();
      if (shot) {
        fx.fire({ ...shot, owner: tank.body });
        fx.muzzleFlash(shot.pos, shot.dir);
        tankCam.kick(1.0, RELOAD);
        sfx.fire();
        input.rumble(1.0, 0.8, 220);
        if (versus) ai.hearShot(shot.pos);
      }
    }

    if (versus) {
      enemy.update(dt, enemy.alive ? ai.aimPoint : null);
      if (ai.wantsFire) {
        const shot = enemy.tryFire();
        if (shot) {
          fx.fire({ ...shot, owner: enemy.body });
          fx.muzzleFlash(shot.pos, shot.dir);
          ai.onFired();
          const d = shot.pos.distanceTo(tank.model.position);
          sfx.fire(0.9 * THREE.MathUtils.clamp(1 - d / 220, 0.2, 1));
        }
      }
      tankFx(enemy, dt);
    }

    // Roof .50 cal — hold RMB (or pad R1)
    const mgFire = inp.mgFire && tank.alive;
    sfx.setMgFire(mgFire);
    if (mgFire) {
      fx.setMgFlash(tank.mgMuzzle());
      input.rumble(0.12, 0.35, 50);
    } else {
      fx.setMgFlash(null);
    }
    tankFx(tank, dt);

    if (game.overT > 0) {
      game.overT -= dt;
      if (game.overT <= 0) restartGame({ resetCam: false });
    }
    updatePathLine();
    fx.update(dt, heightAt);
    grass.update(elapsed);
    sfx.update(dt, {
      speed: tank.forwardSpeed(),
      throttle: tank.cmd.throttle,
      maxSpeed: 12.5,
      turretSlew: tank.turretSlew,
    });
    updateSun();
    updateHud(inp);
    hud.update(dt, camera);
    post.render(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  $('loading').remove();
  window.__sherman = { tank, enemy, ai, nav, game, input, fx, tankCam, sfx, world, grass, vegetation, terrain, visuals };
}

main().catch((e) => {
  console.error(e);
  $('loading').textContent = `Error: ${e.message}`;
});
