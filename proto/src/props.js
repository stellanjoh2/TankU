// Dynamic barrels + a static climb wall (brown crates removed).
import * as THREE from 'three';
import { heightAt, shoreSigned, WATER_Y } from './terrain.js';

export function buildProps(RAPIER, world, scene) {
  const dynamic = [];
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x4a1d14, roughness: 0.5, metalness: 0.6 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 0.95 });

  const onLand = (x, z) => shoreSigned(x, z) > 8 && heightAt(x, z) > WATER_Y + 1.2;

  const addMesh = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    return m;
  };

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

  for (let i = 0; i < 12; i++) barrel(12 + (i % 4) * 0.8, 14 + Math.floor(i / 4) * 0.8);

  // low wall to test climbing
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
