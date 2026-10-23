// Backdrop P-51: orbits the map and occasionally dives into a low swoop.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SIZE } from './terrain.js';

const GROUPS = 1;
const RADIUS = SIZE * 0.72;       // wide orbit outside most of the playable area
const ALT_CRUISE = 52;
const ALT_SWOOP = 22;
const SPEED = 36;                 // a bit slower so they pass less often
const BANK = THREE.MathUtils.degToRad(18);
const SWOOP_CHANCE = 0.15;
const SWOOP_COOLDOWN = 18;
const SCALE = 1.0;
const PROP_RPS = 28; // textured blur disk — still fast, not strobing

const _euler = new THREE.Euler();

function isPropName(name) {
  return /prop/i.test(name || '');
}

function findProp(root) {
  let prop = null;
  root.traverse((o) => {
    if (prop) return;
    if (isPropName(o.name)) prop = o;
  });
  return prop;
}

function prepModel(root, propMat) {
  root.scale.setScalar(SCALE);
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    const propMesh = isPropName(o.name)
      || (Array.isArray(o.material) ? o.material : [o.material]).some((m) => m && isPropName(m.name));
    if (propMesh) {
      o.material = propMat;
      o.renderOrder = 2;
      return;
    }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.flatShading = true;
      if (m.transparent || m.opacity < 1) {
        m.depthWrite = false;
        m.side = THREE.DoubleSide;
      }
    }
  });
  return root;
}

function smooth(t) {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
}

/**
 * @returns {Promise<{ root: THREE.Group, update: (dt: number) => void }>}
 */
export async function buildPlanes(scene) {
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const [gltf, propMap] = await Promise.all([
    loader.loadAsync('./models/p51.glb'),
    texLoader.loadAsync('./models/prop_blur.png'),
  ]);
  // Keep alpha linear; dark RGB is authored into the PNG.
  propMap.colorSpace = THREE.NoColorSpace;
  propMap.anisotropy = 4;
  propMap.wrapS = propMap.wrapT = THREE.ClampToEdgeWrapping;

  const propMat = new THREE.MeshBasicMaterial({
    map: propMap,
    color: 0x0e0e0c,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    alphaTest: 0.05,
    opacity: 0.92,
  });

  const proto = prepModel(gltf.scene, propMat);

  const root = new THREE.Group();
  root.name = 'Planes';
  scene.add(root);

  /** @type {{ mesh: THREE.Object3D, prop: THREE.Object3D | null, angle: number, dir: number, phase: number, alt: number, pitch: number, swoopT: number, cool: number, cx: number, cz: number }[]} */
  const planes = [];

  for (let i = 0; i < GROUPS; i++) {
    const mesh = proto.clone(true);
    root.add(mesh);
    planes.push({
      mesh,
      prop: findProp(mesh),
      angle: (i / GROUPS) * Math.PI * 2,
      dir: i % 2 === 0 ? 1 : -1,
      phase: i * 1.7,
      alt: ALT_CRUISE,
      pitch: 0,
      swoopT: 0,
      cool: 6 + i * 8,
      cx: Math.sin(i * 1.7) * 12,
      cz: Math.cos(i * 1.7) * 12,
    });
  }

  function place(mesh, x, y, z, faceYaw, pitch, bank) {
    mesh.position.set(x, y, z);
    _euler.set(pitch, faceYaw, -bank, 'YXZ');
    mesh.quaternion.setFromEuler(_euler);
  }

  function update(dt) {
    const tBob = performance.now() * 0.0004;
    const propSpin = PROP_RPS * Math.PI * 2 * dt;
    for (const p of planes) {
      if (p.prop) p.prop.rotation.x += propSpin;
      p.cool = Math.max(0, p.cool - dt);

      if (p.swoopT <= 0) {
        if (p.cool <= 0 && Math.random() < SWOOP_CHANCE * dt) p.swoopT = 0.001;
      } else {
        p.swoopT += dt;
        const t = p.swoopT;
        if (t < 3) {
          const k = t / 3;
          p.alt = THREE.MathUtils.lerp(ALT_CRUISE, ALT_SWOOP, smooth(k));
          p.pitch = THREE.MathUtils.degToRad(-22) * Math.sin(k * Math.PI);
        } else if (t < 7) {
          const k = (t - 3) / 4;
          p.alt = THREE.MathUtils.lerp(ALT_SWOOP, ALT_CRUISE, smooth(k));
          p.pitch = THREE.MathUtils.degToRad(16) * Math.sin(k * Math.PI);
        } else {
          p.swoopT = 0;
          p.alt = ALT_CRUISE;
          p.pitch = 0;
          p.cool = SWOOP_COOLDOWN;
        }
      }

      const bob = p.swoopT > 0 ? 0 : Math.sin(p.phase + tBob) * 1.2;
      const alt = p.alt + bob;

      const omega = (SPEED / RADIUS) * p.dir;
      p.angle += omega * dt;

      const ca = Math.cos(p.angle);
      const sa = Math.sin(p.angle);
      const x = p.cx + RADIUS * ca;
      const z = p.cz + RADIUS * sa;
      const vx = -RADIUS * omega * sa;
      const vz = RADIUS * omega * ca;
      // +X-forward GLB: Ry(yaw)*(1,0,0)=(cos yaw, 0, -sin yaw) → yaw = atan2(-vz, vx)
      const faceYaw = Math.atan2(-vz, vx);
      const bank = BANK * p.dir;

      place(p.mesh, x, alt, z, faceYaw, p.pitch, bank);
    }
  }

  return { root, update };
}
