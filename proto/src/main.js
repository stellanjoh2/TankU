import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { LightProbeGenerator } from 'three/examples/jsm/lights/LightProbeGenerator.js';
import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js';
import { createPost } from './post.js';
import { buildTerrain, heightAt, isGrassable } from './terrain.js';
import { buildProps } from './props.js';
import { buildAirfield } from './airfield.js';
import { buildGrass } from './grass.js';
import { buildVegetation } from './vegetation.js';
import { createVisualsEditor } from './visuals.js';
import { shadowTint, patchShadowTint } from './shadowTint.js';
import { Input } from './input.js';
import { Tank, RELOAD, MG_DAMAGE } from './tank.js';
import { Effects } from './fx.js';
import { TankCamera } from './TankCamera.js';
import { Sfx } from './sfx.js';
import { NavGrid } from './navgrid.js';
import { TankAI, pickSpawn } from './ai.js';
import { createHud } from './hud.js';
import { createDebug } from './debug.js';
import { FreeFlight } from './freeflight.js';
import { buildPlanes } from './planes.js';
import { buildSoldiers } from './soldiers.js';
import './style.css';

const FIXED_DT = 1 / 120;
const sunDir = new THREE.Vector3(-0.45, 0.75, 0.48).normalize();
const SHADOW_EXTENT = 38;
const MIN_SPAWN_GAP = 75;        // metres between the two tanks at round start
const ROUND_RESTART_DELAY = 4;   // seconds the wreck burns before the next round
const ENEMY_TINT = new THREE.Color(1.0, 0.72, 0.38);     // orange drab (keep channels ≤1 so bloom stays off)
const IDLE = Object.freeze({ throttle: 0, turn: 0, boost: false });
const SOLO_KEY = 'sherman.solo';
const MUSIC_MUTE_KEY = 'sherman.musicMute';
const MUSIC_VOL_KEY = 'sherman.musicVol';

const $ = (id) => document.getElementById(id);

async function main() {
  await RAPIER.init();

  // ---------------------------------------------------------------- renderer / scene
  // TODO: LensflareMesh once post+shaders are ported.
  const renderer = new WebGPURenderer({ antialias: false, powerPreference: 'high-performance' });
  await renderer.init();
  if (!renderer.backend.isWebGPUBackend) {
    throw new Error('WebGPU is required (WebGL2 fallback disabled for this proto).');
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  // HDR scene → post bloom → ACES Filmic (same path as three.js webgpu_tonemapping).
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.74;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(0xc2fff3);
  scene.fog = new THREE.Fog(fogColor, 30, 151);

  // HDRI → cube RT → LightProbe (diffuse SH) + PMREM env (specular), same path as webgpu_lightprobe
  const equirect = await new EXRLoader().loadAsync('./textures/hdri/env.exr');
  equirect.mapping = THREE.EquirectangularReflectionMapping;

  const cubeRT = new THREE.CubeRenderTarget(256, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    generateMipmaps: false,
  });
  cubeRT.fromEquirectangularTexture(renderer, equirect);
  const lightProbe = await LightProbeGenerator.fromCubeRenderTarget(renderer, cubeRT);
  lightProbe.intensity = 1;
  scene.add(lightProbe);
  cubeRT.dispose();

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(equirect).texture;
  scene.environmentIntensity = 1;
  equirect.dispose();
  pmrem.dispose();

  // Procedural skydome (three.js SkyMesh / webgpu_sky) — depth forced to far plane.
  const sky = new SkyMesh();
  sky.scale.setScalar(450000);
  sky.turbidity.value = 6;
  sky.rayleigh.value = 0.293;
  sky.mieCoefficient.value = 0.001;
  sky.mieDirectionalG.value = 0.413;
  sky.cloudCoverage.value = 0.22;
  sky.cloudDensity.value = 0.39;
  sky.cloudElevation.value = 0.46;
  sky.showSunDisc.value = true;
  sky.sunPosition.value.copy(sunDir);
  // Fog colour lives on the mesh for the visuals editor (sky itself is procedural).
  sky.userData.fogColor = fogColor;
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

  const hemi = new THREE.HemisphereLight(new THREE.Color(0.55, 0.65, 0.85), new THREE.Color(0.32, 0.27, 0.18), 0.85);
  const ambient = new THREE.AmbientLight(0xffffff, 0.12);
  scene.add(hemi, ambient);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 2000);
  const post = createPost(renderer, scene, camera);

  // ---------------------------------------------------------------- world
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  const terrain = await buildTerrain(RAPIER, world, scene, { sunDir });
  const props = buildProps(RAPIER, world, scene);
  const airfield = buildAirfield(RAPIER, world, scene);
  const [grass, vegetation, planes] = await Promise.all([
    buildGrass(scene),
    buildVegetation(scene, { RAPIER, world }),
    buildPlanes(scene),
  ]);

  const loader = new GLTFLoader();
  const [gltf, enemyGltf] = await Promise.all([
    loader.loadAsync('./models/sherman.glb'),
    loader.loadAsync('./models/sherman.glb'),
  ]);
  const spawn = { x: -8, y: heightAt(-8, -5) + 0.6, z: -5, yaw: Math.PI / 2 };
  const tank = new Tank(gltf, RAPIER, world, spawn);
  scene.add(tank.model);
  const fx = new Effects(scene, RAPIER, world, tank.body, props.dynamic);

  const nav = new NavGrid();
  nav.setObstacles([...vegetation.navObstacles(), ...airfield.navObstacles()]);
  const soldiers = await buildSoldiers(scene, nav);
  const enemySpawn = pickSpawn(nav, spawn, MIN_SPAWN_GAP);
  const enemy = new Tank(enemyGltf, RAPIER, world, enemySpawn, { tint: ENEMY_TINT });
  scene.add(enemy.model);
  const ai = new TankAI({ tank: enemy, enemy: tank, nav, world, RAPIER, coverRocks: vegetation.coverRocks });
  const hud = createHud();

  const tankCam = new TankCamera(camera);
  tankCam.setColliders([terrain.mesh, vegetation.coverRoot]);
  const sfx = new Sfx();
  await Promise.all([sfx.load(), fx.load()]);
  sfx.setMusicMuted(localStorage.getItem(MUSIC_MUTE_KEY) === '1');
  {
    const saved = localStorage.getItem(MUSIC_VOL_KEY);
    if (saved != null) sfx.setMusicVolume(Number(saved));
  }

  // ---------------------------------------------------------------- round state
  const game = {
    solo: localStorage.getItem(SOLO_KEY) === '1',
    showPath: false,
    debug: false,
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
    const bits = [];
    if (game.debug) bits.push('DEBUG · F3');
    if (fly.enabled) bits.push(`FLY · F · ${Math.round(fly.speed)} m/s`);
    if (pathLine.visible) {
      const { mode, mood, path } = ai.debug;
      const attr = pathLine.geometry.attributes.position;
      const n = Math.min(path.length, 255);
      const p = enemy.body.translation();
      attr.setXYZ(0, p.x, p.y + 1.5, p.z);
      for (let i = 0; i < n; i++) attr.setXYZ(i + 1, path[i].x, heightAt(path[i].x, path[i].z) + 1.5, path[i].z);
      attr.needsUpdate = true;
      pathLine.geometry.setDrawRange(0, n + 1);
      bits.push(`AI ${mode} · ${mood}${ai.visible ? ' · sees you' : ''}`);
    }
    hud.debug(bits.join('\n'));
  }

  sky.name = 'SkyDome';
  const debug = createDebug(scene, world, { tanks: [tank, enemy], grass });
  const fly = new FreeFlight(camera);

  patchShadowTint(scene);
  const visuals = createVisualsEditor({
    renderer, scene, sky, sun, sunDir, hemi, ambient, lightProbe, terrain, grass, vegetation, post, shadowTint,
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
      getDebug: () => game.debug,
      setDebug: (v) => setDebug(v),
      getFly: () => fly.enabled,
      setFly: (v) => {
        if (!!v === fly.enabled) return;
        toggleFly();
      },
      getFlyFov: () => fly.fov,
      setFlyFov: (v) => fly.setFov(v),
      getFlyTilt: () => fly.getTiltDeg(),
      setFlyTilt: (v) => fly.setTiltDeg(v),
      getMusicMuted: () => sfx.musicMuted,
      setMusicMuted: (v) => {
        sfx.setMusicMuted(v);
        localStorage.setItem(MUSIC_MUTE_KEY, v ? '1' : '0');
      },
      getMusicVolume: () => sfx.musicVolume,
      setMusicVolume: (v) => {
        sfx.setMusicVolume(v);
        localStorage.setItem(MUSIC_VOL_KEY, String(sfx.musicVolume));
      },
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
  fx.onMgShot = ({ owner } = {}) => {
    if (owner === tank.body) tankCam.pulseMgShake();
  };
  const metalBodies = new Set(props.dynamic.map((d) => d.body.handle));

  function onTankDestroyed(victim) {
    fx.wreck(new THREE.Vector3().copy(victim.body.translation()).add(new THREE.Vector3(0, 1.2, 0)));
    tankCam.addShake(victim === tank ? 1 : 0.4);
    game.overT = ROUND_RESTART_DELAY;
    game.wreck = victim;
    hud.banner(victim === tank ? 'YOU WERE DESTROYED' : 'ENEMY DESTROYED', 'next round in a moment…');
  }

  fx.onShellHit = ({ collider, owner, point, dir }) => {
    const body = collider?.parent();
    if (!body || game.overT > 0) return;
    const victim = [tank, enemy].find((t) => t.body.handle === body.handle);
    if (!victim || victim.body === owner || !victim.alive) return;
    victim.hp -= 1;
    // Clank at the impact (player hits = full volume; distant enemy hits fall off)
    {
      const d = (point ?? victim.model.position).distanceTo(tank.model.position);
      sfx.hit(THREE.MathUtils.clamp(1 - d / 220, 0.15, 1));
    }
    if (victim === tank) {
      hud.flash();
      if (owner) hud.hitFrom(owner.translation());
      if (owner === enemy.body) ai.onScored();
      input.rumble(1, 1, 450);
      // Same fire-kick envelope, shoved along the shell's travel (away from where it came)
      tankCam.kick(1.0, RELOAD, dir);
    } else {
      victim.flashHit();
      ai.onHit();
    }
    hud.setHealth(tank.hp / tank.maxHp, enemy.hp / enemy.maxHp);
    if (!victim.alive) onTankDestroyed(victim);
  };

  // Traced .50 hits: metal ricochet SFX + tiny chip damage on tanks / barrels.
  fx.onMgHit = ({ collider, owner, point }) => {
    const body = collider?.parent();
    if (!body || game.overT > 0) return;
    const victim = [tank, enemy].find((t) => t.body.handle === body.handle);
    const isTank = !!victim && victim.body !== owner && victim.alive;
    const isBarrel = metalBodies.has(body.handle);
    if (!isTank && !isBarrel) return;

    const d = point.distanceTo(tank.model.position);
    sfx.ricochet(THREE.MathUtils.clamp(1 - d / 180, 0.12, 1));

    if (!isTank) return;
    const wasAlive = victim.alive;
    victim.hp = Math.max(0, victim.hp - MG_DAMAGE);
    if (victim === tank) {
      if (owner) hud.hitFrom(owner.translation());
      input.rumble(0.08, 0.18, 40);
    }
    hud.setHealth(tank.hp / tank.maxHp, enemy.hp / enemy.maxHp);
    if (wasAlive && !victim.alive) {
      if (victim === tank && owner === enemy.body) ai.onScored();
      if (victim === enemy) ai.onHit();
      onTankDestroyed(victim);
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
    nav.setObstacles([...vegetation.navObstacles(), ...airfield.navObstacles()]);   // palm slider may have changed
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
    if (fly.enabled) fly.exit();
    if (resetCam) tankCam.resetDefaults();
    snapCam();
    updatePathLine();
  }

  $('reset-cam').addEventListener('click', (e) => {
    e.stopPropagation();
    resetCameraDefaults();
  });
  $('restart-game').addEventListener('click', (e) => {
    e.stopPropagation();
    restartGame();
  });

  function setDebug(on) {
    debug.setEnabled(on);
    game.debug = debug.enabled;
    updatePathLine();
    visuals.syncUi();
  }

  /** Freefly is independent of F3 debug — full colour for screenshots / paint-overs. */
  function toggleFly() {
    if (fly.toggle()) {
      updatePathLine();
      visuals.syncUi();
    } else {
      snapCam();
      updatePathLine();
      visuals.syncUi();
    }
  }

  input.onPress = (code) => {
    if (code === 'KeyR' && !fly.enabled) { tank.reset(heightAt); snapCam(); }
    // Space: hop upright only when flipped (ignored while upright / in freefly)
    if (code === 'Space' && !fly.enabled) tank.unflipJump(heightAt);
    if (code === 'KeyV') visuals.toggle();
    if (code === 'F3' || code === 'Backquote') setDebug(!game.debug);
    if (code === 'KeyF') toggleFly();
  };

  function castFrom(origin, dir, maxDist, out) {
    const hit = world.castRay(new RAPIER.Ray(origin, dir), maxDist, true, undefined, undefined, undefined, tank.body);
    return out.copy(origin).addScaledVector(dir, hit ? hit.timeOfImpact : maxDist);
  }

  function updateCamera(dt, inp) {
    if (fly.enabled) {
      fly.update(dt, inp);
      camera.getWorldDirection(viewDir);
      return;
    }

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
    const tp = fly.enabled ? camera.position : tank.model.position;
    const step = (2 * SHADOW_EXTENT) / sun.shadow.mapSize.x;
    sun.target.position.set(Math.round(tp.x / step) * step, tp.y, Math.round(tp.z / step) * step);
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 120);
    sun.target.updateMatrixWorld();
    terrain.water.sunDirection.value.copy(sunDir);
    terrain.water.sunColor.value.copy(sun.color);
  }

  // ---------------------------------------------------------------- reticle + start overlay
  const gunMarker = $('gun-marker');
  const projected = new THREE.Vector3();

  function updateHud(inp) {
    // Freefly screenshots: hide reticle chrome so the frame is clean to draw on
    if (fly.enabled) {
      gunMarker.style.display = 'none';
      $('crosshair').style.display = 'none';
    } else {
      $('crosshair').style.display = '';
      projected.copy(gunPoint).project(camera);
      const visible = projected.z < 1;
      gunMarker.style.display = visible ? 'block' : 'none';
      if (visible) {
        gunMarker.style.transform =
          `translate(${(projected.x * 0.5 + 0.5) * innerWidth}px, ${(-projected.y * 0.5 + 0.5) * innerHeight}px)`;
      }
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
    input.setEnabled(!visuals.open);
    const inp = input.read(dt);
    if (inp.padPressed.includes(9) && !fly.enabled) { tank.reset(heightAt); snapCam(); }

    const versus = !game.solo;
    const flying = fly.enabled;
    // Freefly freezes the sim so screenshots don't fight moving tanks / FX.
    const paused = flying;
    if (!paused) elapsed += dt;

    if (versus && !paused) ai.update(dt, { halt: game.overT > 0 });
    const playerDrive = (!flying && tank.alive) ? inp : IDLE;
    const enemyDrive = (!paused && enemy.alive) ? ai.drive : IDLE;

    if (!paused) {
      acc += dt;
      while (acc >= FIXED_DT) {
        tank.physicsStep(FIXED_DT, playerDrive);
        if (versus) enemy.physicsStep(FIXED_DT, enemyDrive);
        world.step();
        acc -= FIXED_DT;
      }
    }
    props.sync();
    if (!paused) {
      planes.update(dt);
      soldiers.update(dt);
    }

    updateCamera(dt, inp);
    castFrom(camera.position, viewDir, 1200, aimPoint);
    // Freefly owns the look — leave the turret alone so the hull doesn't track the ghost cam
    if (!paused) tank.update(dt, tank.alive ? aimPoint : null);
    const m = tank.muzzle();
    castFrom(m.pos, m.dir, 1200, gunPoint);

    if (inp.fire && tank.alive && !flying) {
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

    if (versus && !paused) {
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

    // Roof .50 cal — player RMB/R1; enemy AI sprays sometimes while its main gun reloads
    const mgFire = inp.mgFire && tank.alive && !flying;
    const enemyMg = versus && !paused && enemy.alive && ai.wantsMg;
    sfx.setMgFire(mgFire || enemyMg);
    if (mgFire) {
      fx.setMgFlash(tank.mgMuzzle(), tank.body, 'player');
      input.rumble(0.12, 0.35, 50);
    } else {
      fx.setMgFlash(null, null, 'player');
    }
    if (enemyMg) fx.setMgFlash(enemy.mgMuzzle(), enemy.body, 'enemy');
    else fx.setMgFlash(null, null, 'enemy');
    if (!paused) tankFx(tank, dt);

    if (!paused && game.overT > 0) {
      game.overT -= dt;
      if (game.overT <= 0) restartGame({ resetCam: false });
    }
    updatePathLine();
    debug.update();
    if (!paused) {
      fx.update(dt, heightAt);
      grass.update(elapsed);
      vegetation?.update?.(elapsed);
      sfx.update(dt, {
        speed: tank.forwardSpeed(),
        throttle: tank.cmd.throttle,
        maxSpeed: 12.5,
        turretSlew: tank.turretSlew,
      });
    } else {
      sfx.update(dt, { speed: 0, throttle: 0, maxSpeed: 12.5, turretSlew: 0 });
    }
    updateSun();
    updateHud(inp);
    hud.update(dt, camera);
    post.render(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  $('loading').remove();
  window.__sherman = { tank, enemy, ai, nav, game, input, fx, tankCam, sfx, world, grass, vegetation, terrain, visuals, debug, fly, lightProbe, sky, planes, soldiers };
}

main().catch((e) => {
  console.error(e);
  $('loading').textContent = `Error: ${e.message}`;
});
