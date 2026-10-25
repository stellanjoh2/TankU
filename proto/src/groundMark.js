// Flat red circle on the ground. CircleGeometry (not a hand-built buffer) so it
// stays round — a position-only buffer was rendering as the zone's square bounds.
import * as THREE from 'three';
import { WATER_Y } from './terrain.js';

/**
 * @param {import('three').Scene} scene
 * @param {number} radius
 * @param {{ lift?: number, thick?: number, segments?: number }} [opts]
 */
export function createGroundMark(scene, radius, opts = {}) {
  const lift = opts.lift ?? 1.05;
  const thick = opts.thick ?? 0.6;
  const segments = opts.segments ?? 72;
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(radius, segments),
    new THREE.MeshBasicMaterial({
      color: 0xff2a18,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const band = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.15, radius - thick), radius, segments),
    new THREE.MeshBasicMaterial({
      color: 0xff6a3a,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  for (const mesh of [fill, band]) {
    mesh.geometry.rotateX(-Math.PI / 2);
    const pos = mesh.geometry.attributes.position;
    const xz = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      xz[i * 2] = pos.getX(i);
      xz[i * 2 + 1] = pos.getZ(i);
    }
    mesh.geometry.userData.xz = xz;
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    mesh.visible = false;
    scene.add(mesh);
  }
  return { fill, band, lift, t: 0, hiding: false };
}

const SCALE_S = 0.5;

function smooth(t) {
  return t * t * (3 - 2 * t);
}

/** Lay the circle on the terrain at the current scale (0 = point, 1 = full radius). */
function layout(mark, heightAt) {
  const s = smooth(mark.t);
  const x = mark.fill.position.x;
  const z = mark.fill.position.z;
  // Open water: one flat disk. Draping the shelf, or letting the beach clip it,
  // turns the zone into a blob.
  const onWater = heightAt(x, z) < WATER_Y;
  const flatY = WATER_Y + mark.lift;
  for (const mesh of [mark.fill, mark.band]) {
    mesh.material.depthTest = !onWater;
    const pos = mesh.geometry.attributes.position;
    const xz = mesh.geometry.userData.xz;
    for (let i = 0; i < pos.count; i++) {
      const lx = xz[i * 2] * s;
      const lz = xz[i * 2 + 1] * s;
      pos.setX(i, lx);
      pos.setZ(i, lz);
      pos.setY(i, onWater ? flatY : heightAt(x + lx, z + lz) + mark.lift);
    }
    pos.needsUpdate = true;
  }
}

/** Start a scale-up from the center. Plan shape stays a circle of the built radius. */
export function placeGroundMark(mark, x, z, heightAt) {
  mark.fill.position.set(x, 0, z);
  mark.band.position.set(x, 0, z);
  mark.t = 0;
  mark.hiding = false;
  layout(mark, heightAt);
  mark.fill.visible = true;
  mark.band.visible = true;
}

export function pulseGroundMark(mark, t, warn) {
  const urgent = t > warn - 1.2;
  const hz = urgent ? 9 : 3.5;
  const pulse = 0.65 + 0.35 * Math.sin(t * hz);
  mark.fill.material.opacity = (urgent ? 0.42 : 0.26) * pulse;
  mark.band.material.opacity = 0.75 + 0.25 * pulse;
}

/** Start a scale-down to the center. The mesh hides once it reaches zero. */
export function hideGroundMark(mark) {
  if (!mark.fill.visible) return;
  mark.hiding = true;
}

/** Advance the 0.5s scale in/out. Call every frame while a strike can be showing. */
export function tickGroundMark(mark, dt, heightAt) {
  if (!mark.fill.visible) return;
  const target = mark.hiding ? 0 : 1;
  if (mark.t === target) return;
  const step = dt / SCALE_S;
  mark.t = mark.hiding ? Math.max(0, mark.t - step) : Math.min(1, mark.t + step);
  if (mark.t === 0) {
    mark.fill.visible = false;
    mark.band.visible = false;
    return;
  }
  layout(mark, heightAt);
}
