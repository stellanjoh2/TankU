// Things to drive into and shoot at: dynamic crates/barrels, static ramps.
import * as THREE from 'three';
import { heightAt, shoreSigned, WATER_Y } from './terrain.js';

export function buildProps(RAPIER, world, scene) {
  const dynamic = [];
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.8 });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x4a1d14, roughness: 0.5, metalness: 0.6 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 0.95 });

  const onLand = (x, z) => shoreSigned(x, z) > 8 && heightAt(x, z) > WATER_Y + 1.2;

  const addMesh = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    return m;
  };

  // Light + slippery so the 30t tank knocks them clear instead of wedging.
  function crate(x, z, y = 0, s = 1) {
    if (!onLand(x, z)) return;
    const mesh = addMesh(new THREE.BoxGeometry(s, s, s), crateMat);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, heightAt(x, z) + y + s / 2 + 0.02, z)
      .setLinearDamping(0.04).setAngularDamping(0.08)
      .setCcdEnabled(true));
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(s / 2, s / 2, s / 2)
        .setDensity(35)
        .setFriction(0.15)
        .setRestitution(0.35),
      body,
    );
    dynamic.push({ mesh, body });
  }

  function barrel(x, z) {
    if (!onLand(x, z)) return;
    const mesh = addMesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 16), barrelMat);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, heightAt(x, z) + 0.47, z)
      .setLinearDamping(0.05).setAngularDamping(0.12)
      .setCcdEnabled(true));
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(0.45, 0.3)
        .setDensity(55)
        .setFriction(0.18)
        .setRestitution(0.4),
      body,
    );
    dynamic.push({ mesh, body });
  }

  function fixedBox(x, z, size, rotY = 0, tiltZ = 0, lift = 0) {
    if (!onLand(x, z)) return;
    const mesh = addMesh(new THREE.BoxGeometry(...size), concrete);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, tiltZ, 'YXZ'));
    const y = heightAt(x, z) + lift;
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(q);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z).setRotation(q));
    world.createCollider(RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2).setFriction(0.9), body);
  }

  /** 3×3 stack of unit crates (9). */
  function crateStack(cx, cz) {
    if (!onLand(cx, cz)) return;
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3; col++)
        crate(cx + (col - 1) * 1.05, cz, row * 1.0);
  }

  // crate wall + pyramid ahead of the spawn (west-central meadow)
  for (let row = 0; row < 3; row++)
    for (let i = 0; i < 6; i++) crate(18, -6 + i * 1.05 + (row % 2) * 0.5, row * 1.0);
  for (let lvl = 0; lvl < 4; lvl++)
    for (let i = 0; i <= 3 - lvl; i++) crate(24 + lvl * 0.02, 8 + i * 1.05 + lvl * 0.52, lvl * 1.0);
  for (let i = 0; i < 12; i++) barrel(12 + (i % 4) * 0.8, 14 + Math.floor(i / 4) * 0.8);
  for (let i = 0; i < 28; i++) {
    const a = i * 2.399, r = 22 + (i * 37 % 55);
    crate(Math.cos(a) * r - 8, Math.sin(a) * r - 5, 0, 0.8 + (i % 3) * 0.4);
  }

  // a few 9-crate stacks scattered across the meadow
  for (const [x, z] of [
    [32, -28], [-28, 32], [42, 18], [-38, -18], [8, 38], [-22, -40], [36, 4],
  ]) crateStack(x, z);

  // ramps and a low wall to test climbing
  fixedBox(8, -22, [10, 0.6, 5], 0, 0.22, 0.6);
  fixedBox(18, -22, [10, 0.6, 5], 0, -0.22, 0.6);
  fixedBox(-18, 16, [0.6, 0.5, 12], 0.3, 0, 0.2);

  return {
    dynamic,
    sync() {
      for (const { mesh, body } of dynamic) {
        mesh.position.copy(body.translation());
        mesh.quaternion.copy(body.rotation());
      }
    },
  };
}
