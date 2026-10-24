// Fixed pools for combat VFX. One material per billboard batch; meshes share the
// geometry and material they were built with. Slots are reused, never disposed.
import * as THREE from 'three/webgpu';
import { instanceColor, instancedDynamicBufferAttribute, texture, vec3 } from 'three/tsl';

const GRAVITY = 9.81;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _roll = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _color = new THREE.Color();
const _streak = new THREE.Vector3();

function takeFree(pool) {
  const free = pool.free;
  let s = free.pop();
  if (!s) {
    s = pool.slots[0];
    for (let i = 1; i < pool.slots.length; i++) {
      if (pool.slots[i].age > s.age) s = pool.slots[i];
    }
  }
  s.alive = true;
  s.age = 0;
  return s;
}

export function releaseSlot(pool, s) {
  if (!s.alive) return;
  s.alive = false;
  if (s.mesh) s.mesh.visible = false;
  pool.free.push(s);
}

/**
 * Camera-facing quads. `emissive` writes HDR through instanceColor (albedo stays black).
 * Smoke tints albedo with instanceColor and fades with the per-instance attribute.
 */
export function createBillboard(scene, map, capacity, { emissive = false, renderOrder = 2, depthTest = true } = {}) {
  const geo = new THREE.PlaneGeometry(1, 1);
  const fadeAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  fadeAttr.setUsage(THREE.DynamicDrawUsage);
  const fadeNode = instancedDynamicBufferAttribute(fadeAttr, 'float');
  const mapNode = texture(map);
  const mat = new THREE.MeshBasicNodeMaterial({
    color: new THREE.Color(0, 0, 0),
    transparent: true,
    depthWrite: false,
    depthTest,
    fog: false,
    side: THREE.DoubleSide,
    blending: emissive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  if (emissive) {
    mat.colorNode = vec3(0, 0, 0);
    // Alpha carries the fade. Emissive stays the tinted texel, same as the old sprites.
    mat.emissiveNode = mapNode.rgb.mul(instanceColor);
    mat.opacityNode = mapNode.a.mul(fadeNode);
  } else {
    mat.colorNode = mapNode.rgb;
    mat.opacityNode = mapNode.a.mul(fadeNode);
  }
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = renderOrder;
  scene.add(mesh);

  const slots = [];
  const free = [];
  for (let i = 0; i < capacity; i++) {
    const s = {
      alive: false,
      age: 0,
      life: 1,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      size: 1,
      grow: 1,
      opacity: 1,
      drag: 1.5,
      rise: 0,
      mode: 'puff',
      color: new THREE.Color(1, 1, 1),
      sparkTo: new THREE.Color(1, 1, 1),
      hasSparkTo: false,
      streak: false,
      pivotX: 0.5,
      pivotY: 0.5,
      rot: 0,
      scaleToZero: false,
      fadeLinear: false,
    };
    slots.push(s);
    free.push(s);
  }
  return { mesh, fadeAttr, slots, free, emissive };
}

export function takeBillboard(board) {
  const s = takeFree(board);
  s.mode = 'puff';
  s.grow = 1;
  s.opacity = 1;
  s.drag = 1.5;
  s.rise = 0;
  s.streak = false;
  s.hasSparkTo = false;
  s.pivotX = 0.5;
  s.pivotY = 0.5;
  s.rot = 0;
  s.scaleToZero = false;
  s.fadeLinear = false;
  s.vel.set(0, 0, 0);
  return s;
}

export function createMeshPool(scene, geo, mat, capacity) {
  const slots = [];
  const free = [];
  for (let i = 0; i < capacity; i++) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    scene.add(mesh);
    const s = {
      mesh,
      alive: false,
      age: 0,
      life: 1,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      owner: null,
      traveled: 0,
      maxDist: 0,
      brass: false,
    };
    slots.push(s);
    free.push(s);
  }
  return { slots, free };
}

export function takeMesh(pool) {
  const s = takeFree(pool);
  s.brass = false;
  s.owner = null;
  s.traveled = 0;
  s.maxDist = 0;
  s.mesh.visible = true;
  return s;
}

function writeQuad(board, index, pos, rot, sx, sy, pivotX, pivotY, color, fade, camQ) {
  _q.copy(camQ);
  if (rot) {
    _roll.setFromAxisAngle(_z, rot);
    _q.multiply(_roll);
  }
  const ox = (pivotX - 0.5) * sx;
  const oy = (pivotY - 0.5) * sy;
  _right.set(1, 0, 0).applyQuaternion(_q);
  _up.set(0, 1, 0).applyQuaternion(_q);
  _p.copy(pos).addScaledVector(_right, -ox).addScaledVector(_up, -oy);
  _s.set(sx, sy, 1);
  _m.compose(_p, _q, _s);
  const mesh = board.mesh;
  mesh.setMatrixAt(index, _m);
  mesh.setColorAt(index, color);
  board.fadeAttr.setX(index, fade);
}

/** Simulate and pack every live slot into the instanced draw. */
export function stepBillboards(boards, dt, heightAt, camQ, camQInv) {
  for (const board of boards) {
    if (!board) continue;
    let n = 0;
    for (const p of board.slots) {
      if (!p.alive) continue;
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        releaseSlot(board, p);
        continue;
      }
      let sx = p.size;
      let sy = p.size;
      let fade = 1;
      let rot = p.rot;
      if (p.mode === 'spark') {
        p.vel.y -= GRAVITY * dt;
        p.pos.addScaledVector(p.vel, dt);
        const g = heightAt(p.pos.x, p.pos.z) + 0.04;
        if (p.pos.y < g) {
          p.pos.y = g;
          p.vel.x *= 0.55;
          p.vel.z *= 0.55;
          p.vel.y = Math.abs(p.vel.y) * 0.5;
        }
        const to = p.hasSparkTo ? p.sparkTo : p.color;
        _color.r = THREE.MathUtils.lerp(p.color.r, to.r, k);
        _color.g = THREE.MathUtils.lerp(p.color.g, to.g, k);
        _color.b = THREE.MathUtils.lerp(p.color.b, to.b, k);
        const w = p.size * (1 - k * 0.65);
        if (p.streak && camQInv) {
          const v = _streak.copy(p.vel).applyQuaternion(camQInv);
          const across = Math.hypot(v.x, v.y);
          rot = Math.atan2(v.y, v.x) - Math.PI / 2;
          sx = w;
          sy = w * 2.5 + across * 0.044;
        } else {
          sx = w;
          sy = w;
        }
        fade = (1 - k) * (1 - k);
      } else if (p.mode === 'burst') {
        sx = p.size * (1 + 0.6 * Math.sqrt(k));
        sy = sx * 0.5;
        fade = 1 - k * k;
        _color.copy(p.color);
      } else {
        p.vel.multiplyScalar(Math.exp(-p.drag * dt));
        p.vel.y += p.rise * dt;
        p.pos.addScaledVector(p.vel, dt);
        const scale = p.scaleToZero
          ? p.size * (1 - k)
          : p.size * (1 + (p.grow - 1) * Math.sqrt(k));
        sx = scale;
        sy = scale;
        const lifeFade = p.fadeLinear ? (1 - k) : (1 - k) * (1 - k);
        fade = p.opacity * lifeFade;
        _color.copy(p.color);
      }
      writeQuad(board, n, p.pos, rot, sx, sy, p.pivotX, p.pivotY, p.mode === 'spark' ? _color : p.color, fade, camQ);
      n++;
    }
    board.mesh.count = n;
    board.mesh.visible = n > 0;
    if (n > 0) {
      board.mesh.instanceMatrix.needsUpdate = true;
      board.mesh.instanceColor.needsUpdate = true;
      board.fadeAttr.needsUpdate = true;
    }
  }
}

/** Debris, brass, and torn grass. Shared materials, no shadow casters. */
export function stepMeshPool(pool, dt, heightAt) {
  for (const p of pool.slots) {
    if (!p.alive) continue;
    p.age += dt;
    if (p.age >= p.life) {
      releaseSlot(pool, p);
      continue;
    }
    p.vel.y -= GRAVITY * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    const groundPad = p.brass ? 0.05 : 0.07;
    const g = heightAt(p.mesh.position.x, p.mesh.position.z) + groundPad;
    if (p.mesh.position.y < g) {
      p.mesh.position.y = g;
      p.vel.multiplyScalar(p.brass ? 0.35 : 0.4);
      p.vel.y = Math.abs(p.vel.y) * (p.brass ? 0.25 : 0.3);
      if (p.brass) p.spin.multiplyScalar(0.55);
    }
    p.mesh.rotation.x += p.spin.x * dt;
    p.mesh.rotation.y += p.spin.y * dt;
    if (p.brass) p.mesh.rotation.z += p.spin.z * dt;
  }
}
