// Supply C-47. One straight level pass at a time, constant speed, no bank.
// Altitude matches the backdrop P-51 cruise (planes.js ALT_CRUISE).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const ALT = 52;
const SPEED = 30;
// Pass length matches Sounds/515293__breviceps__propeller-plane.wav.
// The crate leaves at the halfway point so the recording and the drop line up.
const PASS_S = 30;
const DROP_S = 15;
const APPROACH = SPEED * DROP_S;
const DEPART = SPEED * (PASS_S - DROP_S);
/** Crate origin sits this far under the fuselage centre so it clears the belly. */
const DROP_CLEAR = 3.2;
const PROP_RPS = 18;

const Y = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _u0 = new THREE.Vector3();
const _r = new THREE.Vector3();
const _up = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

function findProps(root) {
  const props = [];
  root.traverse((o) => {
    if (o.isMesh && /prop/i.test(o.name)) props.push(o);
  });
  return props;
}

function prep(root, propMat) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const propMesh = /prop/i.test(o.name)
      || mats.some((m) => m && /prop/i.test(m.name));
    if (propMesh) {
      o.material = propMat;
      o.renderOrder = 2;
      return;
    }
    for (const m of mats) {
      if (!m) continue;
      m.flatShading = true;
      if (m.transparent || m.opacity < 1) {
        m.transparent = true;
        m.depthWrite = false;
        m.side = THREE.DoubleSide;
      }
    }
  });
  return root;
}

/** Nose (+X) along the flight direction. Level — no bank. */
function orientAlong(mesh, tanX, tanY, tanZ) {
  _fwd.set(tanX, tanY, tanZ);
  if (_fwd.lengthSq() < 1e-10) _fwd.set(1, 0, 0);
  else _fwd.normalize();
  _u0.copy(Y).addScaledVector(_fwd, -Y.dot(_fwd));
  if (_u0.lengthSq() < 1e-8) _u0.set(0, 1, 0);
  else _u0.normalize();
  _r.crossVectors(_fwd, _u0);
  _up.copy(_u0);
  _z.crossVectors(_fwd, _up);
  _m.makeBasis(_fwd, _up, _z);
  mesh.quaternion.setFromRotationMatrix(_m);
}

/**
 * @returns {Promise<{
 *   update: (dt: number) => void,
 *   beginPass: (x: number, z: number, onRelease: (dropY: number) => void) => boolean,
 *   abort: () => void,
 * }>}
 */
export async function buildTransport(scene) {
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const [gltf, propMap] = await Promise.all([
    loader.loadAsync('./models/c47.glb'),
    texLoader.loadAsync('./models/prop_blur.png'),
  ]);
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

  const mesh = prep(gltf.scene, propMat);
  mesh.name = 'C47';
  mesh.visible = false;
  scene.add(mesh);
  const props = findProps(mesh);

  /** @type {null | {
   *   x: number, z: number, dx: number, dz: number,
   *   dist: number, released: boolean,
   *   onRelease: (dropY: number) => void,
   * }} */
  let run = null;

  function place() {
    const px = run.x + run.dx * run.dist;
    const pz = run.z + run.dz * run.dist;
    mesh.position.set(px, ALT, pz);
    orientAlong(mesh, run.dx, 0, run.dz);
  }

  function beginPass(x, z, onRelease) {
    if (run) return false;
    const ang = Math.random() * Math.PI * 2;
    run = {
      x, z,
      dx: Math.cos(ang),
      dz: Math.sin(ang),
      dist: -APPROACH,
      released: false,
      onRelease,
    };
    mesh.visible = true;
    place();
    return true;
  }

  function update(dt) {
    if (!run) return;
    const spin = PROP_RPS * Math.PI * 2 * dt;
    for (const p of props) p.rotation.x += spin;

    run.dist += SPEED * dt;
    place();
    if (!run.released && run.dist >= 0) {
      run.released = true;
      run.onRelease(ALT - DROP_CLEAR);
    }
    if (run.dist > DEPART) {
      mesh.visible = false;
      run = null;
    }
  }

  /** End the pass before release so a reset cannot drop the previous crate. */
  function abort() {
    run = null;
    mesh.visible = false;
  }

  return {
    update,
    beginPass,
    abort,
    /** Seconds of straight flight before the crate leaves the plane. */
    inbound: APPROACH / SPEED,
    /** Seconds until release while a pass is inbound, otherwise null. */
    untilRelease() {
      if (!run || run.released) return null;
      return Math.max(0, -run.dist / SPEED);
    },
  };
}
