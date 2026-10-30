// Kill-shot swap: freeze the hull, show the destroyed mesh, and pop the turret as a rigid body.
import * as THREE from 'three';
import { applyWreckMeshFade } from './fx.js';
import { clearPickupLights } from './pickupLights.js';

const WRECK_TURRET_LOCAL = new THREE.Vector3(-0.16, 2.35, 0);
const WRECK_TURRET_HALF = { x: 0.9, y: 0.42, z: 0.72 };
const WRECK_TURRET_MASS = 2200;
const WRECK_TURRET_UP = 9.5;
const WRECK_TURRET_SIDE = 2.8;

const _q = new THREE.Quaternion();

export function obliterateTank(tank) {
  if (tank.wrecked) return;
  tank.model.position.copy(tank.body.translation());
  tank.model.quaternion.copy(tank.body.rotation());
  tank.model.updateMatrixWorld(true);
  for (const c of tank.intactRoots) c.visible = false;
  if (tank.wreck) {
    applyWreckMeshFade(tank.wreck, 1);
    tank.wreck.visible = true;
  }
  tank.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  tank.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  tank.body.setBodyType(tank.RAPIER.RigidBodyType.Fixed, true);
  tank.turretCollider?.setEnabled(false);
  tank.wrecked = true;
  tank.wreckGone = false;
  tank.wreckBurn = 0;
  clearPickupLights(tank);
  spawnWreckTurret(tank);
}

export function restoreTankWreck(tank) {
  if (!tank.wrecked) return;
  clearWreckTurret(tank);
  for (const c of tank.intactRoots) c.visible = true;
  if (tank.wreck) {
    applyWreckMeshFade(tank.wreck, 1);
    tank.wreck.visible = false;
  }
  tank.turretCollider?.setEnabled(true);
  tank.body.setBodyType(tank.RAPIER.RigidBodyType.Dynamic, true);
  if (!tank.body.isEnabled()) tank.body.setEnabled(true);
  tank.wrecked = false;
  tank.wreckGone = false;
  tank.wreckBurn = 0;
}

export function spawnWreckTurret(tank) {
  if (!tank.wreckTurretSrc || tank.wreckTurret) return;
  const R = tank.RAPIER;
  const mesh = tank.wreckTurretSrc.clone(true);
  mesh.visible = true;
  const hullQ = _q.copy(tank.model.quaternion);
  const pos = WRECK_TURRET_LOCAL.clone().applyQuaternion(hullQ).add(tank.model.position);
  mesh.position.copy(pos);
  mesh.quaternion.copy(hullQ);
  (tank.model.parent || tank.model).add(mesh);

  const rb = tank.world.createRigidBody(R.RigidBodyDesc.dynamic()
    .setTranslation(pos.x, pos.y, pos.z)
    .setRotation(hullQ)
    .setLinearDamping(0.12)
    .setAngularDamping(0.18)
    .setCcdEnabled(true)
    .setUserData({ mat: 'metal' }));
  const { x: hx, y: hy, z: hz } = WRECK_TURRET_HALF;
  tank.world.createCollider(
    R.ColliderDesc.cuboid(hx, hy, hz)
      .setMass(WRECK_TURRET_MASS)
      .setFriction(0.6)
      .setRestitution(0.15),
    rb,
  );
  const side = WRECK_TURRET_SIDE;
  rb.setLinvel({
    x: (Math.random() - 0.5) * 2 * side,
    y: WRECK_TURRET_UP + Math.random() * 2.5,
    z: (Math.random() - 0.5) * 2 * side,
  }, true);
  rb.setAngvel({
    x: (Math.random() - 0.5) * 8,
    y: (Math.random() - 0.5) * 6,
    z: (Math.random() - 0.5) * 8,
  }, true);
  tank.wreckTurret = mesh;
  tank.wreckTurretBody = rb;
}

export function syncWreckTurret(tank) {
  if (!tank.wreckTurret || !tank.wreckTurretBody) return;
  const t = tank.wreckTurretBody.translation();
  tank.wreckTurret.position.set(t.x, t.y, t.z);
  tank.wreckTurret.quaternion.copy(tank.wreckTurretBody.rotation());
}

export function clearWreckTurret(tank) {
  if (tank.wreckTurretBody) {
    tank.world.removeRigidBody(tank.wreckTurretBody);
    tank.wreckTurretBody = null;
  }
  if (tank.wreckTurret) {
    tank.wreckTurret.parent?.remove(tank.wreckTurret);
    tank.wreckTurret = null;
  }
}
