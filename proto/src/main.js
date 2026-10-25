import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { LightProbeGenerator } from 'three/examples/jsm/lights/LightProbeGenerator.js';
import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js';
import { createPost } from './post.js';
import { buildTerrain, heightAt, isGrassable, PLAYER_SPAWN, BRIDGE, ENEMY_SPAWN, ENEMY_SPAWN_BASE, WATER_Y } from './terrain.js';
import { buildProps } from './props.js';
import { buildAirfield } from './airfield.js';
import { buildPort } from './port.js';
import { buildGrass } from './grass.js';
import { buildVegetation } from './vegetation.js';
import { createVisualsEditor } from './visuals.js';
import { shadowTint, patchShadowTint } from './shadowTint.js';
import { createCloudShadows } from './cloudShadows.js';
import { Input, PAD } from './input.js';
import { Tank, RELOAD, REPAIR_TIME, MG_HEAT_TIME } from './tank.js';
import { tankPose, boatPose } from './combatPose.js';
import { installTankLods, updateTankLod } from './tankLod.js';
import { Effects, wreckFireFade } from './fx.js';
import { TankCamera } from './TankCamera.js';
import { Sfx, distGain, FIRE_HEAR } from './sfx.js';
import { NavGrid } from './navgrid.js';
import { TankAI, pickSpawn } from './ai.js';
import { createMatch } from './match.js';
import { createHud } from './hud.js';
import { createRadialMenu } from './radialMenu.js';
import cloudIcon from '@phosphor-icons/core/assets/fill/cloud-fill.svg?raw';
import planeIcon from '@phosphor-icons/core/assets/fill/airplane-tilt-fill.svg?raw';
import wrenchIcon from '@phosphor-icons/core/assets/fill/wrench-fill.svg?raw';
import boatIcon from '@phosphor-icons/core/assets/fill/boat-fill.svg?raw';
import { createSmokeField } from './smoke.js';
import { createAirSupport } from './airSupport.js';
import { createShipSupport } from './shipSupport.js';
import { createDebug } from './debug.js';
import { FreeFlight } from './freeflight.js';
import { buildPlanes } from './planes.js';
import { buildTransport } from './c47.js';
import { buildShip } from './ship.js';
import { buildBgIsland } from './bgIsland.js';
import { buildWaterTower } from './watertower.js';
import { buildBridge } from './bridge.js';
import { buildFlag } from './flag.js';
import { buildBarrels } from './barrels.js';
import { createCrates } from './crates.js';
import { buildTrucks } from './truck.js';
import { buildPatrolBoat } from './patrolBoat.js';
import { buildPebbles } from './pebbles.js';
import { createEngineHeatHaze } from './heatHaze.js';
import './style.css';

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 2;
const MAX_RENDER_W = 960;
const MAX_RENDER_H = 540;

/** Bake local matrices and stop recomputing them. Safe for scenery that never moves. */
function freezeStatic(root) {
  root.traverse((obj) => {
    obj.updateMatrix();
    obj.matrixAutoUpdate = false;
  });
  root.updateMatrixWorld(true);
}

/** 540p drawing buffer (960×540). The canvas stretches it to the window with bilinear filtering. */
function renderPixelRatio() {
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  const w = innerWidth * dpr;
  const h = innerHeight * dpr;
  return dpr * Math.min(1, MAX_RENDER_W / w, MAX_RENDER_H / h);
}
const sunDir = new THREE.Vector3(-0.45, 0.75, 0.48).normalize();
const SHADOW_EXTENT = 38;
const ENEMY_TINT = new THREE.Color(1.0, 0.72, 0.38);     // orange drab (keep channels ≤1 so bloom stays off)
const IDLE = Object.freeze({ throttle: 0, turn: 0, boost: false });
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
  renderer.setPixelRatio(renderPixelRatio());
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
  sun.shadow.mapSize.set(512, 512);
  Object.assign(sun.shadow.camera, { left: -SHADOW_EXTENT, right: SHADOW_EXTENT, top: SHADOW_EXTENT,
                                     bottom: -SHADOW_EXTENT, near: 1, far: 260 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = 1;
  sun.shadow.intensity = 1;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(new THREE.Color(0.55, 0.65, 0.85), new THREE.Color(0.32, 0.27, 0.18), 0.85);
  const ambient = new THREE.AmbientLight(0xffffff, 0.12);
  scene.add(hemi, ambient);
  const clouds = await createCloudShadows([[sun, 1], [hemi, 0.5], [ambient, 0.5]], sky);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 2000);
  const post = createPost(renderer, scene, camera);

  // ---------------------------------------------------------------- world
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  const terrain = await buildTerrain(RAPIER, world, scene, { sunDir });
  buildBgIsland(scene, terrain);
  buildProps(RAPIER, world, scene);
  const airfield = buildAirfield(RAPIER, world, scene);
  freezeStatic(airfield.root);
  const port = buildPort(RAPIER, world, scene);
  freezeStatic(port.root);
  const [grass, vegetation, planes, transport, ship, waterTower, flag, barrels, trucks, bridge, patrolBoat] = await Promise.all([
    buildGrass(scene),
    buildVegetation(scene, { RAPIER, world }),
    buildPlanes(scene),
    buildTransport(scene),
    buildShip(scene),
    buildWaterTower(scene, { RAPIER, world }),
    buildFlag(scene, { RAPIER, world }),
    buildBarrels(scene, { RAPIER, world }),
    buildTrucks(scene, { RAPIER, world }),
    buildBridge(scene, { RAPIER, world }),
    buildPatrolBoat(scene, { RAPIER, world }),
  ]);
  freezeStatic(ship.root);
  ship.wakeTurrets();
  freezeStatic(bridge.root);
  await buildPebbles(scene, vegetation.pebbleAnchors, terrain.groundSets, terrain.palette.concrete);

  // Player keeps the parsed scene. Each enemy gets a skinned clone and its own
  // materials, taken before the player installs the repair glow on the original.
  function cloneSherman(src) {
    const scene = cloneSkinned(src.scene);
    const mats = new Map();
    const cloneMat = (m) => {
      if (!m) return m;
      let c = mats.get(m.uuid);
      if (!c) {
        c = m.clone();
        mats.set(m.uuid, c);
      }
      return c;
    };
    scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      o.material = Array.isArray(o.material) ? o.material.map(cloneMat) : cloneMat(o.material);
    });
    return { scene };
  }

  const loader = new GLTFLoader();
  const [gltf, wreckGltf] = await Promise.all([
    loader.loadAsync('./models/sherman.glb'),
    loader.loadAsync('./models/sherman_destroyed.glb'),
  ]);
  const { x: sx, z: sz } = PLAYER_SPAWN;
  const spawn = { x: sx, y: heightAt(sx, sz) + 0.6, z: sz, yaw: Math.atan2(-(BRIDGE.z - sz), BRIDGE.x - sx) };
  const wreckSrc = wreckGltf.scene;
  const enemyScenes = [cloneSherman(gltf), cloneSherman(gltf)];
  const tank = new Tank(gltf, RAPIER, world, spawn, { wreck: wreckSrc, repairGlow: true });
  scene.add(tank.model);
  const heatHaze = createEngineHeatHaze();
  const HEAT_HAZE = heatHaze.userData.heatStrength.value;
  heatHaze.visible = false;
  tank.model.add(heatHaze);
  const fx = new Effects(scene, RAPIER, world, tank.body, barrels.dynamic);
  fx.camera = camera;
  const smoke = createSmokeField(fx);

  const nav = new NavGrid();
  nav.setObstacles([
    ...vegetation.navObstacles(), ...airfield.navObstacles(),
    ...port.navObstacles(), ...waterTower.navObstacles(), ...flag.navObstacles(),
    ...trucks.navObstacles(),
  ]);
  const foeSpecs = [
    { src: enemyScenes[0], anchor: ENEMY_SPAWN, fireSlot: 1, mgId: 'enemy' },
    { src: enemyScenes[1], anchor: ENEMY_SPAWN_BASE, spawnR: 10, patrolR: [8, 16], fireSlot: 6, mgId: 'enemy2' },
  ];
  const foes = foeSpecs.map(({ src, anchor, fireSlot, mgId, patrolR, spawnR }) => {
    const foe = new Tank(src, RAPIER, world, pickSpawn(nav, spawn, anchor, spawnR), { tint: ENEMY_TINT, wreck: wreckSrc });
    scene.add(foe.model);
    const brain = new TankAI({ tank: foe, enemy: tank, nav, world, RAPIER, coverRocks: vegetation.coverRocks, anchor, patrolR });
    return { tank: foe, ai: brain, anchor, spawnR, fireSlot, mgId };
  });
  const enemy = foes[0].tank;
  const ai = foes[0].ai;
  const hud = createHud();

  const tankCam = new TankCamera(camera);
  const camRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  tankCam.setCollisionCast((origin, dir, maxDist) => {
    camRay.origin.x = origin.x; camRay.origin.y = origin.y; camRay.origin.z = origin.z;
    camRay.dir.x = dir.x; camRay.dir.y = dir.y; camRay.dir.z = dir.z;
    const hit = world.castRay(
      camRay, maxDist, true,
      undefined, undefined, undefined, undefined,
      (col) => col.parent()?.userData?.camBlock === true,
    );
    return hit ? hit.timeOfImpact : null;
  });
  const sfx = new Sfx();
  await Promise.all([
    sfx.load(),
    fx.load(),
    ...foes.map((f) => installTankLods(f.tank)),
  ]);
  sfx.setMusicMuted(localStorage.getItem(MUSIC_MUTE_KEY) === '1');
  {
    const saved = localStorage.getItem(MUSIC_VOL_KEY);
    if (saved != null) sfx.setMusicVolume(Number(saved));
  }

  // ---------------------------------------------------------------- match (round + combat)
  // onRestart filled in after camera helpers exist (lookYaw / snapCam / fly).
  let onMatchRestart = () => {};
  const input = new Input(renderer.domElement);
  const unlockAudio = () => sfx.unlock();
  addEventListener('pointerdown', unlockAudio, { once: true });
  addEventListener('keydown', unlockAudio, { once: true });

  const match = createMatch({
    tank, foes, nav, fx, hud, sfx, tankCam, input,
    vegetation, airfield, port, waterTower, barrels, trucks, patrolBoat, spawn,
    smoke,
    onRestart: (opts) => onMatchRestart(opts),
  });
  match.wireFx();
  const { game } = match;
  const crates = createCrates({
    scene, RAPIER, world, fx,
    getPlayer: () => tank,
    getTanks: () => [tank, ...foes.map((f) => f.tank)],
    tryPickup: (kind) => {
      if (kind !== 'health' || !match.healFull(tank)) return false;
      input.rumble(0.22, 0.48, 110);
      return true;
    },
    transport,
    onIncoming: () => {
      sfx.c47Pass();
      if (game.overT > 0) return;
      hud.banner('Pickup Incoming', '', 'win', 3);
    },
  });

  function nearestLivingFoe() {
    let best = null;
    let bestD = Infinity;
    const p = tank.position;
    for (const f of foes) {
      if (!f.tank.alive) continue;
      const e = f.tank.position;
      const d = (e.x - p.x) ** 2 + (e.z - p.z) ** 2;
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  }

  const airSupport = createAirSupport({
    planes,
    fx,
    sfx,
    getTarget: () => reticlePoint(),
    getOwner: () => tank.body,
    scene,
    heightAt: (x, z) => nav.sampleHeight(x, z),
  });

  const shipSupport = createShipSupport({
    ships: ship.ships,
    fx,
    sfx,
    getSpot: () => reticlePoint(),
    getTarget: () => {
      if (game.solo) return null;
      const f = nearestLivingFoe();
      if (!f) return null;
      const p = f.tank.body.translation();
      return { x: p.x, y: p.y + 1.1, z: p.z };
    },
    getListener: () => tank.position,
    heightAt: (x, z) => nav.sampleHeight(x, z),
    distGain,
    scene,
  });

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
  const debug = createDebug(scene, world, { tanks: [tank, ...foes.map((f) => f.tank)], grass });
  const fly = new FreeFlight(camera);

  patchShadowTint(scene);
  const visuals = createVisualsEditor({
    renderer, scene, sky, sun, sunDir, hemi, ambient, lightProbe, terrain, grass, vegetation, barrels, trucks, post, shadowTint, fx, clouds,
    getEnvIntensity: () => scene.environmentIntensity,
    setEnvIntensity: (v) => { scene.environmentIntensity = v; },
    tanks: [tank, ...foes.map((f) => f.tank)],
    game: {
      getSolo: () => game.solo,
      setSolo: (v) => match.setSolo(v),
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

  // ---------------------------------------------------------------- resize
  addEventListener('resize', () => {
    renderer.setPixelRatio(renderPixelRatio());
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    post.setSize(innerWidth, innerHeight);
  });

  // ---------------------------------------------------------------- camera + aim helpers
  // Soft orbit: mouse leads the barrel within this window; boom follows look
  // (TankCamera turretFollowWeight). Past the lead, the window slides as the
  // turret catches the reticle — never a hard lock, never free 360 freelook.
  const TURRET_CAM_LEAD = THREE.MathUtils.degToRad(55);
  // v1 Focus: chase cam sits near 62°. 28° is about 2× magnification.
  const FOCUS_FOV = 28;
  // Full zoom: half stick/mouse aim rate so the tighter view stays placeable.
  const FOCUS_AIM_SCALE = 0.5;
  let focusBlend = 0;
  let lookYaw = spawn.yaw;
  let lookPitch = -0.08;
  const viewDir = new THREE.Vector3();
  const aimPoint = new THREE.Vector3();
  const gunPoint = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _euler = new THREE.Euler();

  function bodyYaw() {
    _fwd.set(1, 0, 0).applyQuaternion(_q.copy(tank.body.rotation()));
    return Math.atan2(-_fwd.z, _fwd.x);
  }

  function bodyPitch() {
    _euler.setFromQuaternion(_q.copy(tank.body.rotation()), 'YXZ');
    return _euler.x;
  }

  const wrapYaw = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  /** World yaw of the barrel. Null once the tank is a wreck. */
  function turretAimYaw() {
    if (tank.wrecked) return null;
    tank.model.position.copy(tank.body.translation());
    tank.model.quaternion.copy(tank.body.rotation());
    tank.turret.updateWorldMatrix(true, false);
    _fwd.set(1, 0, 0).applyQuaternion(tank.turret.getWorldQuaternion(_q));
    return Math.atan2(-_fwd.z, _fwd.x);
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
    lookYaw = turretAimYaw() ?? bodyYaw();
    lookPitch = -0.08;
    tankCam.snap(camState());
  }

  function resetCameraDefaults() {
    tankCam.resetDefaults();
    snapCam();
  }

  onMatchRestart = ({ resetCam = true } = {}) => {
    crates.reset();
    sfx.c47Stop();
    sfx.repairStop();
    lookYaw = spawn.yaw;
    lookPitch = -0.08;
    if (fly.enabled) fly.exit();
    if (resetCam) tankCam.resetDefaults();
    snapCam();
    updatePathLine();
  };

  // Wheel entries. Add or remove objects — slices, icons, and hit areas rebuild.
  // svg is a Phosphor fill icon (solid).
  let activeGadget = 'smoke';
  const MAIN_GUNS = [
    { id: 'cannon', label: 'MAIN GUN' },
    { id: 'mg', label: '.50 CAL' },
  ];
  let mainGun = 0;
  function switchMainGun() {
    mainGun = (mainGun + 1) % MAIN_GUNS.length;
    sfx.weaponSwitch();
  }
  const radial = createRadialMenu([
    { id: 'smoke', label: 'SMOKE', svg: cloudIcon },
    { id: 'air', label: 'AIR SUPPORT', svg: planeIcon },
    { id: 'repair', label: 'REPAIR', svg: wrenchIcon },
    { id: 'ship', label: 'SHIP SUPPORT', svg: boatIcon },
  ], {
    onSelect(item) {
      if (item.id === 'smoke') useSmoke();
      else if (item.id === 'air') useAir();
      else if (item.id === 'repair') useRepair();
      else if (item.id === 'ship') useShip();
    },
  });
  radial.setActive(activeGadget);

  // ---------------------------------------------------------------- pause (one overlay: Esc / unlock)
  // True pause whenever the menu is up — sim, camera, FX time, and audio all freeze.
  let menuPaused = true;
  // Esc that exits pointer-lock must not also count as "resume" on the same keypress.
  let escHeld = false;
  let suppressEscResume = false;
  const overlayEl = $('overlay');
  const canvasEl = renderer.domElement;

  function setMenuPaused(on) {
    on = !!on;
    if (on && radial.isOpen) radial.close();
    if (menuPaused === on) return;
    menuPaused = on;
    overlayEl.classList.toggle('hidden', !on || visuals.open);
    sfx.setPaused(on);
    if (on) {
      focusPause(0);
      pauseStick = null;
      if (document.pointerLockElement) document.exitPointerLock();
    }
  }

  function resumeFromMenu() {
    setMenuPaused(false);
    canvasEl.requestPointerLock();
  }

  const pauseItems = ['pause-resume', 'restart-game', 'reset-cam'];
  let pauseIndex = 0;
  let pauseStick = null; // latched stick direction; null until the menu has seen the stick

  function focusPause(i) {
    const n = pauseItems.length;
    pauseIndex = ((i % n) + n) % n;
    for (let k = 0; k < n; k++) $(pauseItems[k]).classList.toggle('pad-focus', k === pauseIndex);
  }

  function movePause(dir) {
    if (dir) focusPause(pauseIndex + dir);
  }
  focusPause(0);

  addEventListener('keydown', (e) => {
    if (e.code !== 'Escape') return;
    escHeld = true;
  }, true);
  addEventListener('keyup', (e) => {
    if (e.code !== 'Escape') return;
    escHeld = false;
    suppressEscResume = false;
  }, true);

  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvasEl) {
      setMenuPaused(false);
    } else if (!visuals.open) {
      setMenuPaused(true);
      if (escHeld) suppressEscResume = true;
    }
  });

  overlayEl.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    resumeFromMenu();
  });
  $('pause-resume').addEventListener('click', (e) => {
    e.stopPropagation();
    resumeFromMenu();
  });
  $('restart-game').addEventListener('click', (e) => {
    e.stopPropagation();
    match.restart();
  });
  $('reset-cam').addEventListener('click', (e) => {
    e.stopPropagation();
    resetCameraDefaults();
  });
  sfx.setPaused(true);

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

  // Gadget hotkeys: 1 = smoke, 2 = air support, 3 = repair, 4 = ship support.
  // The radial menu equips one of these; the number keys still fire them.

  function useSmoke() {
    activeGadget = 'smoke';
    if (fly.enabled || !tank.alive) return;
    const pose = tank.trySmoke();
    if (!pose) return;
    smoke.deploy(pose);
    sfx.smokeBomb();
    input.rumble(0.2, 0.45, 140);
  }

  function useAir() {
    activeGadget = 'air';
    if (fly.enabled || !tank.alive) return;
    if (airSupport.call()) input.rumble(0.15, 0.35, 120);
  }

  function useShip() {
    activeGadget = 'ship';
    if (fly.enabled || !tank.alive) return;
    if (shipSupport.call()) input.rumble(0.2, 0.4, 160);
  }

  function useRepair() {
    activeGadget = 'repair';
    if (fly.enabled || !tank.alive) return;
    if (!tank.tryRepair()) return;
    sfx.repairStart();
    input.rumble(0.16, 0.28, 90);
  }

  input.onRelease = (code) => {
    if (code === 'KeyR' && radial.isOpen) radial.release();
  };

  input.onPress = (code) => {
    if (code === 'Escape') {
      if (visuals.open) { visuals.setOpen(false); return; }
      if (radial.isOpen) { radial.close(); return; }
      if (menuPaused) {
        if (!suppressEscResume) resumeFromMenu();
        return;
      }
      suppressEscResume = true;
      setMenuPaused(true);
      return;
    }
    if (menuPaused) return;
    if (code === 'KeyR') {
      if (!visuals.open) radial.open();
      return;
    }
    if (radial.isOpen) return;
    if (code === 'KeyT' && !fly.enabled) { tank.reset(heightAt); snapCam(); }
    if (code === 'KeyC') toggleFly();
    // Space: hop upright only when flipped (ignored while upright / in freefly)
    if (code === 'Space' && !fly.enabled && tank.unflipJump(heightAt)) input.rumble(0.55, 0.35, 160);
    if (code === 'KeyV') visuals.toggle();
    if (code === 'F3' || code === 'Backquote') setDebug(!game.debug);
    if (code === 'Digit1' || code === 'Numpad1') useSmoke();
    if (code === 'Digit2' || code === 'Numpad2') useAir();
    if (code === 'Digit3' || code === 'Numpad3') useRepair();
    if (code === 'Digit4' || code === 'Numpad4') useShip();
  };

  // True while R1 is held open. The right stick owns the cursor, including center = no slice.
  let padRadial = false;

  // Pad edges. Holds (drive, aim, fire, nitro, focus) are sampled in Input.read.
  function applyGamepad(inp) {
    if (visuals.open) return;
    const pressed = inp.padPressed;
    const released = inp.padReleased;
    if (!radial.isOpen) padRadial = false;
    if (menuPaused) {
      if (pressed.includes(PAD.A)) { // × confirms the highlighted row
        $(pauseItems[pauseIndex]).click();
        return;
      }
      if (pressed.includes(PAD.B)) { // ○ back / exit
        resumeFromMenu();
        return;
      }
      if (pressed.includes(PAD.DOWN)) movePause(1);
      else if (pressed.includes(PAD.UP)) movePause(-1);
      const ly = inp.stickLY || 0;
      const stickDir = ly > 0.55 ? 1 : ly < -0.55 ? -1 : 0;
      if (pauseStick === null) pauseStick = stickDir;
      else if (stickDir !== pauseStick) {
        pauseStick = stickDir;
        movePause(stickDir);
      }
      return;
    }
    if (pressed.includes(PAD.MENU)) {
      if (radial.isOpen) { radial.close(); padRadial = false; }
      else setMenuPaused(true);
      return;
    }
    if (pressed.includes(PAD.RB)) {
      radial.open();
      padRadial = true;
    }
    if (radial.isOpen && padRadial) {
      const releasing = released.includes(PAD.RB);
      const centered = !inp.stickRX && !inp.stickRY;
      // Letting go of R1 often flicks the right stick into the deadzone on that
      // same frame. Keep the slice already highlighted; a stick that was already
      // centered still releases with nothing selected.
      if (!(releasing && centered)) radial.pointAt(inp.stickRX || 0, inp.stickRY || 0);
      if (releasing) {
        radial.release();
        padRadial = false;
      }
    }
    if (radial.isOpen) return;
    if (!fly.enabled && (pressed.includes(PAD.Y) || inp.switchGun || inp.zoom)) switchMainGun();
    if (!fly.enabled && pressed.includes(PAD.A) && tank.unflipJump(heightAt)) input.rumble(0.55, 0.35, 160);
    if (!fly.enabled && pressed.includes(PAD.VIEW)) { tank.reset(heightAt); snapCam(); }
    if (pressed.includes(PAD.UP)) useSmoke();
    if (pressed.includes(PAD.RIGHT)) useAir();
    if (pressed.includes(PAD.DOWN)) useRepair();
    if (pressed.includes(PAD.LEFT)) useShip();
  }

  /** Crosshair on the sea, or the first solid hit when that is closer. */
  function reticlePoint() {
    const origin = camera.position;
    const dy = viewDir.y;
    const solid = Math.hypot(aimPoint.x - origin.x, aimPoint.y - origin.y, aimPoint.z - origin.z);
    if (dy < -1e-4) {
      const t = (WATER_Y - origin.y) / dy;
      if (t > 0.5 && t < solid - 0.05) {
        return {
          x: origin.x + viewDir.x * t,
          y: WATER_Y,
          z: origin.z + viewDir.z * t,
        };
      }
    }
    return { x: aimPoint.x, y: aimPoint.y, z: aimPoint.z };
  }

  function castFrom(origin, dir, maxDist, out) {
    const hit = world.castRay(new RAPIER.Ray(origin, dir), maxDist, true, undefined, undefined, undefined, tank.body);
    return out.copy(origin).addScaledVector(dir, hit ? hit.timeOfImpact : maxDist);
  }

  function updateCamera(dt, inp) {
    if (fly.enabled) {
      fly.update(dt, inp);
      camera.getWorldDirection(viewDir);
      focusBlend = 0;
      return;
    }

    // Focus (hold F, or gamepad LT): zoom the chase cam. Aim rate eases down
    // with the zoom — full zoom is half stick/mouse speed. Drive and guns
    // still read the same input; the turret follows the slower reticle.
    focusBlend = THREE.MathUtils.damp(focusBlend, inp.zoomHold ? 1 : 0, 8, dt);
    const aimScale = THREE.MathUtils.lerp(1, FOCUS_AIM_SCALE, focusBlend);

    // Soft lead: free within ±LEAD of the barrel; held turn slides the window
    // at traverse speed as the gun chases the reticle.
    lookYaw = wrapYaw(lookYaw - THREE.MathUtils.clamp(inp.aimX * aimScale, -Math.PI, Math.PI));
    lookPitch = THREE.MathUtils.clamp(lookPitch - inp.aimY * aimScale, -0.75, THREE.MathUtils.degToRad(45));
    const gunYaw = turretAimYaw();
    if (gunYaw != null) {
      lookYaw = gunYaw + THREE.MathUtils.clamp(wrapYaw(lookYaw - gunYaw), -TURRET_CAM_LEAD, TURRET_CAM_LEAD);
    }

    // Camera lean from real turret motion (prev frame), not raw mouse delta.
    const turretTurn = THREE.MathUtils.clamp(tank.turretSlew / 2.6, -1, 1);

    tankCam.update(dt, camState(turretTurn));

    if (focusBlend > 0.001) {
      camera.fov = THREE.MathUtils.lerp(camera.fov, FOCUS_FOV, focusBlend);
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
    } else if (radial.isOpen) {
      gunMarker.style.display = 'none';
      $('crosshair').style.display = '';
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
    hud.setNitro(tank.nitroCharge, tank.nitroActive);
    hud.setWeapon(MAIN_GUNS[mainGun].label, MAIN_GUNS[mainGun].id);
    hud.setReload(tank.alive ? tank.reload : 0, RELOAD);
    hud.setOverheat(tank.mgHeat, tank.mgLock, MG_HEAT_TIME, tank.mgFiring);
    const gadgetCd = activeGadget === 'smoke' ? tank.smokeCd
      : activeGadget === 'air' ? airSupport.cd
      : activeGadget === 'ship' ? shipSupport.cd
      : 0;
    hud.setGadget(activeGadget, gadgetCd, activeGadget === 'repair' ? {
      repairing: tank.repairing,
      repairLeft: tank.repairT,
      charges: tank.repairs,
    } : null);
    radial.setActive(activeGadget);
    radial.setDetails({
      smoke: { text: tank.smokeCd > 0.05 ? `${tank.smokeCd.toFixed(1)}s` : '', cooling: tank.smokeCd > 0.05 },
      air: { text: airSupport.cd > 0.05 ? `${airSupport.cd.toFixed(1)}s` : '', cooling: airSupport.cd > 0.05 },
      ship: { text: shipSupport.cd > 0.05 ? `${shipSupport.cd.toFixed(1)}s` : '', cooling: shipSupport.cd > 0.05 },
      repair: {
        text: tank.repairing ? `${tank.repairT.toFixed(1)}s` : `×${tank.repairs}`,
        cooling: !tank.repairing && tank.repairs <= 0,
      },
    });
    hud.setRepair(tank.repairT, REPAIR_TIME);
    hud.setPickup(crates.timeToDrop());
    // HIT% = stress jitter + smoke (−10% when either tank is in a cloud)
    const pPos = tank.position;
    const near = game.solo ? null : nearestLivingFoe();
    const ePos = near ? near.tank.position : enemy.position;
    const pSmoke = tank.alive ? smoke.missBonus(pPos.x, pPos.z, ePos.x, ePos.z) : 0;
    const eSmoke = near ? smoke.missBonus(ePos.x, ePos.z, pPos.x, pPos.z) : 0;
    hud.setHitRate(
      tank.alive ? tank.hitRate(pSmoke) : 1,
      near ? near.tank.hitRate(eSmoke) : 1,
      pSmoke > 0,
      eSmoke > 0,
    );
    overlayEl.classList.toggle('hidden', !menuPaused || visuals.open);
  }

  // ---------------------------------------------------------------- loop
  match.restart();
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
  const BURN_LOCAL = new THREE.Vector3(-1.7, 1.8, 0.35);   // engine deck behind the turret
  // Dark grille on the rear deck (Hull_Details, metal). Flame base sits into the deck, not on top.
  const FIRE_LOCAL = new THREE.Vector3(-2.02, 1.55, 0);
  const burnPoint = new THREE.Vector3();
  const firePoint = new THREE.Vector3();

  /** 0 off, 1–3 = 25/50/75% damage, 4 = wreck. */
  function damageStage(t) {
    if (!t.alive) return 4;
    if (t.hp >= t.maxHp) return 0;
    if (t.hp > t.maxHp * 0.5) return 1;
    if (t.hp > t.maxHp * 0.25) return 2;
    return 3;
  }

  function setTankFire(t, stage, fade = 1) {
    const slot = t === tank ? 0 : (foes.find((f) => f.tank === t)?.fireSlot ?? 1);
    const k = stage > 0 ? fade : 0;
    if (t === tank) {
      heatHaze.visible = k > 0.02;
      heatHaze.userData.heatStrength.value = HEAT_HAZE * k;
    }
    if (k <= 0.02) {
      fx.setDamageFire(null, 0, slot);
      return;
    }
    t.model.updateMatrixWorld();
    firePoint.copy(FIRE_LOCAL).applyMatrix4(t.model.matrixWorld);
    fx.setDamageFire(firePoint, stage, slot, k);
  }

  /** Track dust, diesel exhaust and track kick for one tank; damaged tanks burn, wrecks smoke. */
  function tankFx(t, dt) {
    const mw = t.model.matrixWorld;
    if (!t.alive) {
      // Wreck burns about a minute, fades, then only the destroyed mesh is left.
      t.wreckBurn = (t.wreckBurn || 0) + dt;
      const k = wreckFireFade(t.wreckBurn);
      if (k <= 0) {
        setTankFire(t, 0);
        return;
      }
      const p = t.body.translation();
      burnPoint.set(p.x - 0.4, p.y + 1.8, p.z);
      fx.burn(burnPoint, dt, 1.6 * k, true);
      exhaustPoint.set(p.x, p.y + 2.4, p.z);
      exhaustUp.set(0, 1, 0);
      exhaustBack.set(-1, 0, 0).transformDirection(mw);
      if (exhaustBack.lengthSq() < 1e-6) exhaustBack.set(0, 0, 1);
      fx.engineSmoke(exhaustPoint, k, exhaustBack, exhaustUp);
      setTankFire(t, 4, k);
      return;
    }
    t.wreckBurn = 0;
    if (t.hp < t.maxHp) fx.burn(burnPoint.copy(BURN_LOCAL).applyMatrix4(mw), dt, 1, true);
    setTankFire(t, damageStage(t));
    for (const s of t.sides) {
      const amount = Math.min(1, Math.abs(s.speed) / 8) * 0.5;
      if (t.grounded && amount > 0.05) {
        dustPoint.set(-2.4 * Math.sign(s.speed || 1), 0.15, s.z).applyMatrix4(mw);
        fx.dust(dustPoint, amount);
      }
    }
    // Rip yellow grass behind the hull while driving on meadows
    if (t.grounded) {
      const grassAmt = Math.min(1, Math.abs(t.forwardSpeed()) / 7);
      if (grassAmt > 0.1) {
        const sign = Math.sign(t.forwardSpeed() || t.cmd.throttle || 1);
        kickBack.set(-sign, 0, 0).transformDirection(mw);
        for (const s of t.sides) {
          dustPoint.set(-2.5 * sign, 0.08, s.z).applyMatrix4(mw);
          if (!isGrassable(dustPoint.x, dustPoint.z)) continue;
          kickOut.set(0, 0, Math.sign(s.z || 1)).transformDirection(mw);
          fx.grassRip(dustPoint, grassAmt, { back: kickBack, out: kickOut });
        }
      }
    }
    // Nitro: thick diesel belch that follows the rev envelope
    const nitroP = t.nitro?.power ?? 0;
    if (nitroP > 0.04) {
      exhaustPoint.copy(EXHAUST_LOCAL).applyMatrix4(mw);
      exhaustBack.set(-1, 0, 0).transformDirection(mw);
      exhaustUp.set(0, 1, 0).transformDirection(mw);
      const nAmt = (0.45 + nitroP * 1.25) * 1.5;
      fx.engineSmoke(exhaustPoint, nAmt, exhaustBack, exhaustUp);
      if (nitroP > 0.55) fx.engineSmoke(exhaustPoint, nAmt * 0.9, exhaustBack, exhaustUp);
    }

    // Diesel exhaust + track dust while accelerating (throttle on, speed catching up)
    const thr = Math.abs(t.cmd.throttle);
    if (thr <= 0.08) return;
    const spd = Math.abs(t.forwardSpeed());
    const top = t.cmd.throttle >= 0 ? 12.5 : 4.0;
    const deficit = Math.max(0, thr * top - spd);
    const accel = thr * (0.25 + 0.75 * Math.min(1, deficit / 5));
    if (accel > 0.05 && nitroP < 0.35) {
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
        fx.trackKick(dustPoint, accel, { back: kickBack, out: kickOut });
      }
    }
  }

  const playerPose = tankPose(tank);
  const foeGunners = foes.map((f) => ({ foe: f, pose: tankPose(f.tank) }));
  const boatPoses = patrolBoat.boats.map((b) => boatPose(b));
  const ramBodies = [];

  function simTick(dt, inp, paused, versus, flying) {
    if (versus && !paused) {
      for (const f of foes) f.ai.update(dt, { halt: game.overT > 0 });
    }
    const playerDrive = (!flying && tank.alive) ? inp : IDLE;

    if (!paused && tank.alive && !flying) {
      tank.updateNitro(dt, playerDrive.boost);
      if (tank.nitro.justStarted) {
        sfx.nitro();
        tankCam.nitroFov();
        input.rumble(0.35, 0.55, 180);
        tank.model.updateMatrixWorld(true);
        const mw = tank.model.matrixWorld;
        exhaustPoint.copy(EXHAUST_LOCAL).applyMatrix4(mw);
        exhaustBack.set(-1, 0, 0).transformDirection(mw);
        exhaustUp.set(0, 1, 0).transformDirection(mw);
        for (let i = 0; i < 8; i++) fx.engineSmoke(exhaustPoint, 1.15 * 1.5, exhaustBack, exhaustUp);
      }
    } else if (!paused) {
      tank.updateNitro(dt, false);
    }
    if (versus && !paused) {
      for (const f of foes) {
        if (f.tank.alive) f.tank.updateNitro(dt, f.ai.drive.boost);
      }
    }

    if (!paused) {
      acc += dt;
      let steps = 0;
      while (acc >= FIXED_DT && steps < MAX_SUBSTEPS) {
        tank.physicsStep(FIXED_DT, playerDrive);
        if (versus) {
          for (const f of foes) f.tank.physicsStep(FIXED_DT, f.tank.alive ? f.ai.drive : IDLE);
        }
        world.step();
        acc -= FIXED_DT;
        steps++;
      }
      patrolBoat.update(dt, {
        player: tank,
        fx,
        onContact: versus ? (pos) => {
          for (const f of foes) f.ai.alert(pos.x, pos.z);
        } : null,
      });
      if (steps === MAX_SUBSTEPS) acc = Math.min(acc, FIXED_DT);
      ramBodies.length = 0;
      ramBodies.push(tank.body);
      if (versus) {
        for (const f of foes) if (f.tank.alive) ramBodies.push(f.tank.body);
      }
      vegetation?.checkRams?.(ramBodies);
    }
    barrels.sync();
    vegetation?.sync?.();
    if (!paused) {
      clouds.update(dt);
      planes.update(dt);
    }
  }

  let playerMgLocked = false;

  function combatTick(dt, inp, paused, versus, flying) {
    if (!menuPaused) updateCamera(dt, inp);
    else camera.getWorldDirection(viewDir);
    castFrom(camera.position, viewDir, 1200, aimPoint);
    if (!paused) tank.update(dt, tank.alive ? aimPoint : null);
    if (tank.repairCancelled) sfx.repairStop();
    if (tank.repairDone) {
      sfx.repairStop();
      sfx.repairComplete();
      input.rumble(0.12, 0.38, 120);
    }
    tank.repairDone = false;
    tank.repairCancelled = false;
    if (tank.reloadDone && tank.alive) {
      sfx.reload();
      input.rumble(0.04, 0.32, 50);
    }
    tank.reloadDone = false;
    const m = tank.muzzle();
    castFrom(m.pos, m.dir, 1200, gunPoint);

    const useMg = MAIN_GUNS[mainGun].id === 'mg';
    if (!useMg && inp.fire && tank.alive && !flying) {
      const aimed = versus ? nearestLivingFoe() : null;
      const tp = aimed ? aimed.tank.position : gunPoint;
      const p = tank.position;
      const shot = tank.tryFire(smoke.missBonus(p.x, p.z, tp.x, tp.z));
      if (shot) {
        fx.fire({ ...shot, owner: tank.body });
        fx.muzzleFlash(shot.pos, shot.dir);
        tankCam.kick(0.5, RELOAD);
        sfx.fire();
        input.rumble(1, 0.92, 340);
        if (versus) for (const f of foes) f.ai.hearShot(shot.pos);
      }
    }

    if (versus && !paused) {
      for (const { foe, pose } of foeGunners) {
        const e = foe.tank;
        e.update(dt, e.alive ? foe.ai.aimPoint : null);
        if (foe.ai.wantsSmoke) {
          const poseSmoke = e.trySmoke();
          if (poseSmoke) {
            smoke.deploy(poseSmoke);
            sfx.smokeBomb(0.85 * distGain(pose.position.distanceTo(playerPose.position), 120));
          }
        }
        if (foe.ai.wantsFire) {
          const ep = pose.position;
          const pp = playerPose.position;
          const shot = e.tryFire(smoke.missBonus(ep.x, ep.z, pp.x, pp.z));
          if (shot) {
            fx.fire({ ...shot, owner: pose.body });
            fx.muzzleFlash(shot.pos, shot.dir);
            foe.ai.onFired();
            const hearD = shot.pos.distanceTo(playerPose.position);
            sfx.fire(0.9 * distGain(hearD, 160), hearD);
          }
        }
        tankFx(e, dt);
      }
    } else if (!versus) {
      for (const f of foes) fx.setDamageFire(null, 0, f.fireSlot);
    }

    let hostileMgDist = null;
    const hearFrom = (p) => {
      const d = p.distanceTo(playerPose.position);
      if (hostileMgDist == null || d < hostileMgDist) hostileMgDist = d;
    };
    const mgDt = paused ? 0 : dt;
    const mgFire = tank.tickMg(mgDt, !paused && useMg && inp.fire && playerPose.alive && !flying);
    for (const { foe, pose } of foeGunners) {
      const want = versus && !paused && pose.alive && foe.ai.wantsMg;
      const on = foe.tank.tickMg(versus ? mgDt : 0, want);
      if (on) {
        hearFrom(pose.position);
        fx.setMgFlash(pose.mgMuzzle(), pose.body, foe.mgId);
      } else {
        fx.setMgFlash(null, null, foe.mgId);
      }
    }
    let boatMg = false;
    if (!paused) {
      for (const pose of boatPoses) {
        if (!pose.mgMuzzle()) continue;
        boatMg = true;
        hearFrom(pose.position);
      }
    }
    sfx.setMgFire(mgFire);
    sfx.setHostileMg(hostileMgDist);
    const mgLocked = tank.mgLock > 0.05;
    if (mgLocked && !playerMgLocked) input.rumble(0.72, 0.4, 280);
    playerMgLocked = mgLocked;
    if (mgFire) {
      fx.setMgFlash(playerPose.mgMuzzle(), playerPose.body, 'player');
      input.rumble(0.18, 0.53, 50);
    } else {
      fx.setMgFlash(null, null, 'player');
    }
    if (boatMg) fx.setMgFlash(patrolBoat.mgMuzzle(), patrolBoat.firingBody(), 'boat');
    else fx.setMgFlash(null, null, 'boat');
    if (!paused) tankFx(tank, dt);

    if (!paused) match.tick(dt);
  }

  function ambientTick(dt, paused) {
    updatePathLine();
    debug.update();
    grass.updateLod(camera.position);
    vegetation?.updateLod?.(camera.position);
    barrels.updateLod(camera.position);
    trucks.updateLod(camera.position);
    patrolBoat.updateLod(camera.position);
    for (const f of foes) updateTankLod(f.tank, camera.position);
    if (!paused) {
      smoke.update(dt);
      airSupport.update(dt);
      shipSupport.update(dt);
      fx.update(dt, (x, z) => nav.sampleHeight(x, z));
      barrels.update(dt, fx);
      crates.update(dt);
      waterTower.update(dt, fx);
      trucks.update(dt, fx);
      airfield.update?.(dt);
      grass.update(elapsed);
      vegetation?.update?.(elapsed);
      flag.update(elapsed, vegetation?.getWind?.());
      {
        const sp = planes.scoutPos?.();
        const orbit = sp
          ? distGain(sp.distanceTo(playerPose.position), 200)
          : 0;
        sfx.setP51Orbit(orbit);
      }
      sfx.setFire(distGain(fx.nearestDamageFireDist(playerPose.position), FIRE_HEAR));
      sfx.update(dt, {
        speed: tank.forwardSpeed(),
        throttle: tank.cmd.throttle,
        maxSpeed: 12.5,
        turretSlew: tank.turretSlew,
      });
    } else if (!menuPaused) {
      sfx.setP51Orbit(0);
      sfx.setFire(distGain(fx.nearestDamageFireDist(playerPose.position), FIRE_HEAR));
      sfx.update(dt, { speed: 0, throttle: 0, maxSpeed: 12.5, turretSlew: 0 });
    }
  }

  function presentTick(dt, inp) {
    updateSun();
    updateHud(inp);
    const freezeDt = menuPaused ? 0 : dt;
    hud.update(freezeDt, camera);
    let bright = fx.emissiveHot() || tank.emissiveHot();
    if (!bright) {
      for (const f of foes) if (f.tank.emissiveHot()) { bright = true; break; }
    }
    post.render(freezeDt, bright);
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    input.setEnabled(!visuals.open && !menuPaused);
    const inp = input.read(dt);
    if (radial.isOpen) radial.pointer(inp.mouseX || 0, inp.mouseY || 0);
    radial.update(dt);
    applyGamepad(inp);
    if (radial.isOpen) {
      inp.aimX = 0;
      inp.aimY = 0;
      inp.fire = false;
      inp.zoom = 0;
    }

    const versus = !game.solo;
    const flying = fly.enabled;
    const paused = flying || menuPaused;
    if (!paused) elapsed += dt;

    simTick(dt, inp, paused, versus, flying);
    combatTick(dt, inp, paused, versus, flying);
    ambientTick(dt, paused);
    presentTick(dt, inp);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  $('loading').remove();
  window.__sherman = { renderer, tank, enemy, foes, ai, nav, game, match, input, fx, smoke, airSupport, shipSupport, radial, tankCam, sfx, world, grass, vegetation, terrain, visuals, debug, fly, lightProbe, sky, planes, flag, barrels, crates, clouds, patrolBoat };
}

main().catch((e) => {
  console.error(e);
  $('loading').textContent = `Error: ${e.message}`;
});
