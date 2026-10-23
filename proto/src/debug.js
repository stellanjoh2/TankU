// Physics / mesh debug overlay: Rapier collider outlines, scene wireframes, suspension rays.
import * as THREE from 'three';
import { RapierHelper } from 'three/examples/jsm/helpers/RapierHelper.js';

const RAY_UP = 0.4;
const SAG = 0.10;
const MAX_CONTACT_RAY = RAY_UP + SAG;
const CONTACT_CAP = 64; // enough for two Shermans' road wheels

function skipObject(o) {
  if (!o.visible && o.name !== 'FluffyGrass') return true;
  if (o.isLine || o.isLineSegments || o.isPoints || o.isSprite) return true;
  if (o.isLensflare || o.type === 'Lensflare') return true;
  // Walk parents for named skips (grass / sky / fx)
  for (let p = o; p; p = p.parent) {
    const n = p.name || '';
    if (n === 'FluffyGrass' || n === 'SkyDome' || n === 'DebugOverlay') return true;
  }
  return false;
}

export function createDebug(scene, world, { tanks = [], grass = null } = {}) {
  const root = new THREE.Group();
  root.name = 'DebugOverlay';
  scene.add(root);

  const colliders = new RapierHelper(world);
  colliders.material.fog = false;
  colliders.material.depthTest = false;
  colliders.renderOrder = 1000;
  colliders.visible = false;
  root.add(colliders);

  const contactGeo = new THREE.BufferGeometry();
  const contactPos = new Float32Array(CONTACT_CAP * 2 * 3);
  const contactCol = new Float32Array(CONTACT_CAP * 2 * 3);
  contactGeo.setAttribute('position', new THREE.BufferAttribute(contactPos, 3));
  contactGeo.setAttribute('color', new THREE.BufferAttribute(contactCol, 3));
  const contacts = new THREE.LineSegments(
    contactGeo,
    new THREE.LineBasicMaterial({ vertexColors: true, fog: false, depthTest: false }),
  );
  contacts.frustumCulled = false;
  contacts.renderOrder = 1001;
  contacts.visible = false;
  root.add(contacts);

  const matPrev = new Map(); // material → prior { wireframe, transparent, opacity, depthWrite }
  let enabled = false;
  let grassWasVisible = true;

  function applyWireframes(on) {
    if (!on) {
      for (const [m, prev] of matPrev) {
        m.wireframe = prev.wireframe;
        if (prev.transparent != null) m.transparent = prev.transparent;
        if (prev.opacity != null) m.opacity = prev.opacity;
        if (prev.depthWrite != null) m.depthWrite = prev.depthWrite;
      }
      matPrev.clear();
      return;
    }
    scene.traverse((o) => {
      if (!o.isMesh || skipObject(o)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || matPrev.has(m) || m.isShaderMaterial) continue;
        if (!('wireframe' in m)) continue;
        matPrev.set(m, {
          wireframe: m.wireframe,
          transparent: m.transparent,
          opacity: m.opacity,
          depthWrite: m.depthWrite,
        });
        m.wireframe = true;
        // See through solid fills so collider lines read clearly
        if (!m.transparent) {
          m.transparent = true;
          m.opacity = Math.min(m.opacity ?? 1, 0.35);
          m.depthWrite = false;
        }
      }
    });
  }

  function updateContacts() {
    const q = new THREE.Quaternion();
    const t = new THREE.Vector3();
    const up = new THREE.Vector3();
    const origin = new THREE.Vector3();
    const end = new THREE.Vector3();
    let i = 0;
    for (const tank of tanks) {
      if (!tank?.model?.visible) continue;
      t.copy(tank.body.translation());
      q.copy(tank.body.rotation());
      up.set(0, 1, 0).applyQuaternion(q);
      for (const c of tank.contacts) {
        if (i >= CONTACT_CAP) break;
        origin.copy(c.local).applyQuaternion(q).add(t);
        const hit = c.hitDist >= 0;
        const dist = hit ? c.hitDist : MAX_CONTACT_RAY;
        end.copy(origin).addScaledVector(up, -dist);
        const o = i * 6;
        contactPos[o] = origin.x; contactPos[o + 1] = origin.y; contactPos[o + 2] = origin.z;
        contactPos[o + 3] = end.x; contactPos[o + 4] = end.y; contactPos[o + 5] = end.z;
        // green = grounded, red = miss
        const r = hit ? 0.2 : 1, g = hit ? 1 : 0.25, b = hit ? 0.35 : 0.2;
        contactCol[o] = r; contactCol[o + 1] = g; contactCol[o + 2] = b;
        contactCol[o + 3] = r; contactCol[o + 4] = g; contactCol[o + 5] = b;
        i++;
      }
    }
    contactGeo.setDrawRange(0, i * 2);
    contactGeo.attributes.position.needsUpdate = true;
    contactGeo.attributes.color.needsUpdate = true;
  }

  function setEnabled(on) {
    on = !!on;
    if (enabled === on) return;
    enabled = on;
    colliders.visible = on;
    contacts.visible = on;
    applyWireframes(on);
    if (grass?.root) {
      if (on) {
        grassWasVisible = grass.root.visible;
        grass.root.visible = false;
      } else {
        grass.root.visible = grassWasVisible;
      }
    }
  }

  function update() {
    if (!enabled) return;
    colliders.update();
    updateContacts();
  }

  return {
    get enabled() { return enabled; },
    setEnabled,
    toggle() { setEnabled(!enabled); },
    update,
  };
}
