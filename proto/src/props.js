// Static test props: a low climb wall (dynamic barrels live in barrels.js).
import * as THREE from 'three';
import { heightAt, shoreSigned, WATER_Y } from './terrain.js';

export function buildProps(RAPIER, world, scene) {
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 0.95 });

  const onLand = (x, z) => shoreSigned(x, z) > 8 && heightAt(x, z) > WATER_Y + 1.2;

  const addMesh = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    return m;
  };

  function fixedBox(x, z, size, rotY = 0, tiltZ = 0, lift = 0) {
    if (!onLand(x, z)) return;
    const mesh = addMesh(new THREE.BoxGeometry(...size), concrete);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, tiltZ, 'YXZ'));
    const y = heightAt(x, z) + lift;
    mesh.position.set(x, y, z);
    mesh.quaternion.copy(q);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z).setRotation(q));
    world.createCollider(RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2).setFriction(0.9), body);
  }

  // low wall to test climbing
  fixedBox(-18, 16, [0.6, 0.5, 12], 0.3, 0, 0.2);
}
