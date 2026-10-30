// Noclip freefly / photomode camera: WASD + mouse, Space/E up, Ctrl/Q down,
// Shift boost, wheel = speed. FOV + tilt (dutch roll) via the Game (V) menu.
import * as THREE from 'three';

const BASE_SPEED = 28;       // m/s
const BOOST_MUL = 3.5;
const MIN_SPEED = 2;
const MAX_SPEED = 220;
const PITCH_LIM = 1.45;      // ~83°
const DEFAULT_FOV = 70;      // deg
const MIN_FOV = 15;
const MAX_FOV = 120;
const TILT_LIM = THREE.MathUtils.degToRad(45);

export class FreeFlight {
  constructor(camera) {
    this.camera = camera;
    this.enabled = false;
    this.speed = BASE_SPEED;
    this.yaw = 0;
    this.pitch = 0;
    this.tilt = 0;           // roll rad (photomode dutch angle)
    this.fov = DEFAULT_FOV;  // deg
    this.pos = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  setFov(deg) {
    this.fov = THREE.MathUtils.clamp(deg, MIN_FOV, MAX_FOV);
    if (this.enabled) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  setTiltDeg(deg) {
    this.tilt = THREE.MathUtils.clamp(THREE.MathUtils.degToRad(deg), -TILT_LIM, TILT_LIM);
    if (this.enabled) this._applyOrientation();
  }

  getTiltDeg() {
    return THREE.MathUtils.radToDeg(this.tilt);
  }

  setSpeed(v) {
    this.speed = THREE.MathUtils.clamp(v, MIN_SPEED, MAX_SPEED);
  }

  /** Steal the current view so the handoff doesn't jump. */
  enter() {
    const cam = this.camera;
    this.pos.copy(cam.position);
    this._euler.setFromQuaternion(cam.quaternion, 'YXZ');
    this.yaw = this._euler.y;
    this.pitch = this._euler.x;
    // Keep photomode tilt; ignore stolen roll so freefly stays level unless dialed in.
    this.enabled = true;
    cam.fov = this.fov;
    cam.updateProjectionMatrix();
    this._applyOrientation();
  }

  exit() {
    this.enabled = false;
  }

  toggle() {
    if (this.enabled) this.exit();
    else this.enter();
    return this.enabled;
  }

  _applyOrientation() {
    this._euler.set(this.pitch, this.yaw, this.tilt, 'YXZ');
    this.camera.quaternion.setFromEuler(this._euler);
  }

  /**
   * @param {number} dt
   * @param {{ aimX: number, aimY: number, throttle: number, turn: number, boost: boolean, zoom: number, ascend?: number }} inp
   */
  update(dt, inp) {
    if (!this.enabled) return;

    this.yaw -= inp.aimX;
    this.pitch = THREE.MathUtils.clamp(this.pitch - inp.aimY, -PITCH_LIM, PITCH_LIM);

    if (inp.zoom) {
      const k = 1 - inp.zoom * 0.12;
      this.speed = THREE.MathUtils.clamp(this.speed * k, MIN_SPEED, MAX_SPEED);
    }

    // Move on untilted look basis so dutch-angle tilt is visual-only (photomode).
    this._euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this._euler);
    this._fwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this._right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);

    const spd = this.speed * (inp.boost ? BOOST_MUL : 1) * dt;
    // throttle = W/S (forward in look dir), turn = A/D (strafe)
    this.pos.addScaledVector(this._fwd, inp.throttle * spd);
    this.pos.addScaledVector(this._right, inp.turn * spd);
    const up = inp.ascend ?? 0;
    if (up) this.pos.y += up * spd;

    this.camera.position.copy(this.pos);
    this._applyOrientation();
  }
}
