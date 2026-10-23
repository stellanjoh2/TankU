// US flag on a steel pole at the port deck, by the hangar's back corner
// (GLB from scripts/build_flag.py). The cloth is exported flat and waved in a TSL position node.
import * as THREE from 'three/webgpu';
import { Fn, positionLocal, normalLocal, uniform, vec3, float, sin, cos, cross } from 'three/tsl';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AIRFIELD_Y } from './terrain.js';
import { WIND_DEFAULT } from './vegetation.js';

const SLAB_T = 0.06;

// Must match scripts/build_flag.py (metres, Y up, origin at ground centre of the pole).
const PAD_HALF = 0.5;
const PAD_H = 0.2;
const POLE_R = 0.1;
const POLE_H = 9.0;
const FLAG_W = 3.0;
const FLAG_X0 = 0.045 + 0.035;

/** Just east of the hangar's back wall; the flag flies east over the deck, clear of the roof. */
export const FLAG = {
  x: 17.6,
  z: -16.5,
  yaw: 0, // local +X (fly end) = world +X (toward the quay)
};

/**
 * Flat flag in local XY (hoist at x = FLAG_X0, cloth normal +Z) → waved position.
 * Travelling waves run hoist → fly; amplitude grows away from the pole.
 */
function wave(p, { phase, amp, droop }) {
  const u = p.x.sub(FLAG_X0).div(FLAG_W).clamp(0, 1);
  const a = amp.mul(u.pow(1.15));
  const k1 = p.x.mul(2.4).sub(phase).add(p.y.mul(0.8));
  const k2 = p.x.mul(4.7).sub(phase.mul(1.6)).add(p.y.mul(1.9));
  const k3 = p.x.mul(9.1).sub(phase.mul(2.3)).sub(p.y.mul(2.7));
  const dz = a.mul(sin(k1).add(sin(k2).mul(0.45)).add(sin(k3).mul(0.2)));
  // Fly end pulled in while rippling (cloth doesn't stretch) + slight sag in light wind.
  const x = p.x.sub(a.mul(0.35).mul(float(1).sub(cos(k1))));
  const y = p.y.sub(droop.mul(u).mul(u));
  return vec3(x, y, p.z.add(dz));
}

function flagMaterial(src, w) {
  const m = new THREE.MeshStandardNodeMaterial({
    map: src.map,
    roughness: src.roughness,
    metalness: src.metalness,
    side: THREE.DoubleSide,
  });
  m.positionNode = Fn(() => {
    const p = positionLocal;
    const e = 0.03;
    const c = wave(p, w);
    const dx = wave(p.add(vec3(e, 0, 0)), w).sub(c);
    const dy = wave(p.add(vec3(0, e, 0)), w).sub(c);
    normalLocal.assign(cross(dx, dy).normalize());
    return c;
  })();
  return m;
}

/**
 * @returns {Promise<{ root: THREE.Object3D, update: (time: number, wind?: number) => void, navObstacles: () => object[] }>}
 */
export async function buildFlag(scene, { RAPIER, world }) {
  const gltf = await new GLTFLoader().loadAsync('./models/flag.glb');
  const root = gltf.scene;
  root.name = 'FlagPole';
  const y0 = AIRFIELD_Y + SLAB_T;
  root.position.set(FLAG.x, y0, FLAG.z);
  root.rotation.y = FLAG.yaw;

  const w = { phase: uniform(0), amp: uniform(0.2), droop: uniform(0.1) };
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    if (o.name !== 'Flag') return;
    o.material = flagMaterial(o.material, w);
    o.frustumCulled = false; // waved verts leave the flat bounding box
  });
  scene.add(root);

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation(FLAG.x, y0, FLAG.z)
      .setUserData({ mat: 'metal' }),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(PAD_HALF, PAD_H * 0.5, PAD_HALF).setTranslation(0, PAD_H * 0.5, 0).setFriction(0.8),
    body,
  );
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(POLE_H * 0.5, POLE_R).setTranslation(0, POLE_H * 0.5, 0).setFriction(0.8),
    body,
  );

  console.info(`[flag] @ (${FLAG.x.toFixed(1)}, ${FLAG.z.toFixed(1)}) y=${y0.toFixed(2)}`);

  let lastTime = 0;
  return {
    root,
    update(time, wind = WIND_DEFAULT) {
      const k = THREE.MathUtils.clamp(wind / WIND_DEFAULT, 0, 1.8);
      // Integrate phase so changing the wind slider doesn't jump the wave.
      const dt = THREE.MathUtils.clamp(time - lastTime, 0, 0.1);
      lastTime = time;
      w.phase.value += dt * (2.5 + 2.8 * k);
      w.amp.value = 0.05 + 0.14 * k;
      w.droop.value = 0.45 * Math.max(0, 1 - k) + 0.06;
    },
    navObstacles() {
      return [{ type: 'box', x: FLAG.x, z: FLAG.z, hx: PAD_HALF + 0.2, hz: PAD_HALF + 0.2, yaw: 0 }];
    },
  };
}
