import * as THREE from 'three';

/* ============================================================
   TANK CAMERA CONFIG: every tweakable value lives here.
   Units: metres, seconds, radians unless noted (deg = degrees,
   converted internally). "lambda" values are damping rates:
   higher = snappier, lower = lazier/floatier (frame-rate independent).
   ============================================================ */
export const CAMERA_CONFIG = {
  // ---------- Base rig (where the camera sits) ----------
  pivotHeight: 1.6,          // height above tank origin the camera orbits/looks around
  distanceMin: 7.0,          // distance behind the hull (standstill and at speed)
  distanceMax: 7.0,          // do not reel the camera backward as speed builds
  heightMin: 2.8,            // camera height above pivot at standstill
  heightMax: 2.2,            // camera height at top speed (lower = more "racing")
  lookAheadStatic: 6.0,      // how far in front of the tank the camera aims at rest
  lookAheadSpeed: 0.35,      // extra look-ahead per m/s of speed
  lookAtHeight: 0.6,         // vertical offset of the look target (raise to see more sky)

  // ---------- Follow (stay on the hull) ----------
  // XZ is copied from the vehicle every frame. Damping it trails at ~speed/lambda
  // and, once you're moving, cuts corners so the rig strays off the tank.
  followLambdaY: 8.0,        // vertical only (smooths bumps)
  maxPivotLagY: 1.25,        // metres — Y smooth can't leave the camera hanging
  yawLambda: 12.0,           // heading follow. High = camera stays behind the hull
  yawLambdaFast: 16.0,       // tighter at speed. A lazy fast yaw swings the cam off the tank
  maxYawLagDeg: 8,           // hard cap on smoothed heading error
  maxAimLagDeg: 10,          // hard cap on look-target smoothing
  steerYawOffsetDeg: 14,     // camera swings toward outside of a turn by this much at full steer + speed
  reverseFlip: false,        // true: camera swings to look the other way when reversing
  reverseThreshold: 1.5,     // m/s before reverse counts as reversing

  // ---------- Turret influence ----------
  // Hull-locked chase: cam stays mostly behind the hull so big mouse turns don't orbit the world.
  // Look still tracks the gun (soft lag). Tiny follow + light slew cues keep it from feeling bolted on.
  turretFollowWeight: 0.1,   // 0 = camera ignores turret, 1 = camera fully follows turret yaw
  turretLookWeight: 0.92,    // how much the LOOK target aims along the turret (0 = tank heading)
  turretYawLambda: 4.8,      // smoothing for turret-driven aim (lower = floatier)
  turretSwingRollDeg: 1.1,   // extra roll when turret slews quickly
  turretSwingOffset: 0.28,   // sideways camera shift (m) while turret slews
  // Gun elev (lookPitch): gentle vertical react — raise look when aiming up, drop cam slightly
  turretPitchFollow: 0.32,   // 0..1 how much gun pitch tilts the view after lookAt
  turretPitchLookWeight: 0.55,// how strongly look-at Y follows gun elev (× lookAhead)
  turretPitchHeight: 0.55,   // metres of camera Y shift per radian of gun elev (down when aiming up)
  turretPitchLambda: 4.0,    // damp rate for gun-elev follow (lower = floatier)

  // ---------- Steering tilt / lean ----------
  maxRollDeg: 4.5,           // horizon roll into turns at full steer + speed
  rollMinSpeedFactor: 0.25,  // fraction of roll kept at standstill (0 = none when stopped)
  rollLambda: 5.0,           // how quickly roll follows
  invertRoll: false,         // flip if the lean feels wrong-way
  steerLateralOffset: 0.9,   // camera slides sideways (m) on steer, like racing cams
  lateralLambda: 4.0,

  // ---------- Speed zoom ----------
  fovBase: 62,               // deg default (standstill / cruising)
  fovDelta: 10,              // ±deg: + at top speed, − when braking
  fovLambda: 4.0,
  speedCurve: 1.4,           // >1 = zoom effect kicks in late, <1 = early
  maxSpeed: 12.5,            // m/s that counts as "100% speed" (Sherman boost top speed)
  brakeThrottle: 0.08,       // throttle below this while moving = braking (matches taillights)

  // ---------- Nitro FOV punch ----------
  nitroFovDeg: 10,           // extra degrees at peak
  nitroFovDuration: 2.0,     // total widen→settle window
  nitroFovPeakAt: 1.0,       // seconds in when FOV is widest

  // ---------- Fire kick-back ----------
  // Timed shove to peak, then ease-out return. Total window = kickReturnDuration
  // (keep in sync with tank RELOAD so the cam lands as the next shot is ready).
  kickDistance: 2.0,         // metres the camera is shoved back per unit kick
  kickPitchDeg: 5.5,         // camera nose-up on fire
  kickRollDeg: 2.4,          // bank/tilt on fire (sign flips per shot)
  kickFovDeg: 7.5,           // FOV punch on fire (cheap, effective)
  kickAttackDuration: 0.28,  // seconds to ease into peak shove (not a snap)
  kickReturnDuration: 4.0,   // total fire→rest window; match tank RELOAD
  kickShake: 0.45,           // trauma added to shake on fire (0..1)
  // Soft peak trauma refreshed each .50 round (snap, don’t stack — stacking becomes an earthquake).
  mgShake: 0.3,

  // ---------- Shake ----------
  shakeMaxAngleDeg: 2.0,     // rotation at trauma = 1
  shakeMaxOffset: 0.25,      // positional shake (m) at trauma = 1
  shakeFrequency: 22,        // Hz-ish
  shakeDecay: 1.6,           // trauma lost per second
  speedShake: 0.0,           // constant rumble at top speed (0..0.3). Try 0.05
  
  // ---------- Pitch / terrain ----------
  pitchFollowTilt: 0.35,     // 0..1 how much the camera tilts with terrain slope (needs state.pitch)
  pitchLambda: 4.0,
  basePitchDeg: 0,           // constant extra pitch up/down on the view

  // ---------- Collision ----------
  collisionEnabled: true,
  collisionMargin: 0.4,      // gap kept from walls (m)
  collisionPullInLambda: 25, // snap in fast when blocked
  collisionReleaseLambda: 2.5, // ease out slowly after (avoids popping)
  minDistance: 2.0,          // never closer than this to pivot

  // ---------- Misc ----------
  // Match main's frame dt cap. Do NOT clamp tighter (e.g. 1/30): exp damping is
  // already stable for large dt, and under-damping on slow frames lets the chase
  // pivot trail the tank so the cam "drifts away" until FPS recovers.
  maxDt: 0.1,
  near: 0.1,
  far: 1000,
};

/* ---------------- helpers ---------------- */
const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, t) => a + (b - a) * t;
const deg = (d) => (d * Math.PI) / 180;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const dampAngle = (a, b, lambda, dt) => a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt));
const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;

// Convention: yaw 0 faces +X (Sherman / this project), forward = (cos yaw, 0, -sin yaw)
const fwd = (yaw, out) => out.set(Math.cos(yaw), 0, -Math.sin(yaw));
const right = (yaw, out) => out.set(-Math.sin(yaw), 0, -Math.cos(yaw)); // up × fwd

/**
 * Usage:
 *   const cam = new TankCamera(camera);                // or pass overrides: new TankCamera(camera, { fovDelta: 12 })
 *   // every frame:
 *   cam.update(dt, {
 *     position,      // THREE.Vector3, tank world position
 *     heading,       // tank body yaw (rad)
 *     turretYaw,     // turret WORLD yaw (rad)  (bodyYaw + localTurretYaw)
 *     speed,         // signed forward speed m/s (negative = reversing)
 *     throttle,      // optional -1..1 drive input (for brake FOV)
 *     steer,         // -1..1 (left negative, right positive: flip sign if needed)
 *     turretTurn,    // optional -1..1 turret slew input/rate
 *     turretPitch,   // optional gun elev / look pitch (rad, + = up)
 *     pitch,         // optional tank body pitch from terrain (rad)
 *   });
 *   // on main gun fire (pass reload duration so return lands as the gun is ready):
 *   cam.kick(1.0, RELOAD);  // strength, total fire→rest duration
 *   cam.addShake(0.4);      // explosions, impacts
 */
export class TankCamera {
  constructor(camera, overrides = {}) {
    this.camera = camera;
    this.cfg = Object.assign({}, CAMERA_CONFIG, overrides);
    this.colliders = [];                 // THREE.Object3D[] to raycast against
    this.raycaster = new THREE.Raycaster();

    // smoothed state
    this.yaw = 0;
    this.aimYaw = 0;
    this.pivot = new THREE.Vector3();
    this.roll = 0;
    this.lateral = 0;
    this.slew = 0;
    this.pitch = 0;
    this.gunPitch = 0;               // damped turret / look elev
    this.fov = this.cfg.fovBase;
    this.distance = this.cfg.distanceMin;
    this.collisionDist = Infinity;       // max allowed distance from collision
    this.initialised = false;

    // kick: timed ease into peak → ease-out return over reload
    this.kickX = 0;
    this.kickPhase = 'idle'; // 'idle' | 'attack' | 'return'
    this.kickPeak = 0;
    this.kickT = 0;
    this.kickAttackDur = 0;
    this.kickTotalDuration = 0;
    this.kickReturnStart = 0;
    this.kickReturnLen = 0;
    this.kickRollSign = 1;
    this.kickDirectional = false;
    this.kickPush = new THREE.Vector3(); // world XZ shove (hit impulse); fire kick leaves this unused

    // nitro FOV: timed ease to peak then settle (independent of fire kick)
    this.nitroFovT = 0;
    this.nitroFovAmt = 0; // 0..1 envelope
    this.nitroFovOn = false;

    this.trauma = 0;
    this.time = 0;

    // scratch vectors
    this._f = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._pivotWorld = new THREE.Vector3();
  }

  setColliders(objects) { this.colliders = objects; }

  /**
   * Ease into peak shove, then ease-out return landing at `returnDuration` (reload).
   * Pass `worldDir` (shell travel) to shove along the hit impulse instead of camera-back recoil.
   */
  kick(strength = 1, returnDuration = null, worldDir = null) {
    const total = Math.max(1e-4, returnDuration ?? this.cfg.kickReturnDuration);
    const attack = Math.min(this.cfg.kickAttackDuration, total * 0.45);
    this.kickPeak = strength;
    this.kickX = 0;
    this.kickPhase = 'attack';
    this.kickT = 0;
    this.kickAttackDur = Math.max(1e-4, attack);
    this.kickTotalDuration = total;
    this.kickReturnStart = 0;
    this.kickReturnLen = 0;
    this.kickRollSign = Math.random() < 0.5 ? -1 : 1;
    if (worldDir) {
      this.kickPush.copy(worldDir).setY(0);
      const len = this.kickPush.length();
      this.kickDirectional = len > 1e-6;
      if (this.kickDirectional) this.kickPush.multiplyScalar(1 / len);
    } else {
      this.kickDirectional = false;
      this.kickPush.set(0, 0, 0);
    }
    this.addShake(this.cfg.kickShake * strength);
  }

  addShake(amount) { this.trauma = clamp(this.trauma + amount, 0, 1); }

  /** Per-round MG punch: refresh to a soft peak instead of accumulating. */
  pulseMgShake() {
    this.trauma = Math.max(this.trauma, this.cfg.mgShake);
  }

  /** Nitro FOV widen: ease to +nitroFovDeg at peakAt, settle by duration. Retriggers restart the curve. */
  nitroFov() {
    this.nitroFovOn = true;
    this.nitroFovT = 0;
    this.nitroFovAmt = 0;
  }

  /** Restore cfg (incl. wheel-zoom distances) and runtime camera state to defaults. */
  resetDefaults() {
    Object.assign(this.cfg, CAMERA_CONFIG);
    this.distance = this.cfg.distanceMin;
    this.fov = this.cfg.fovBase;
    this.kickX = 0;
    this.kickPhase = 'idle';
    this.kickPeak = 0;
    this.kickT = 0;
    this.kickAttackDur = 0;
    this.kickTotalDuration = 0;
    this.kickReturnStart = 0;
    this.kickReturnLen = 0;
    this.kickDirectional = false;
    this.kickPush.set(0, 0, 0);
    this.nitroFovOn = false;
    this.nitroFovT = 0;
    this.nitroFovAmt = 0;
    this.trauma = 0;
    this.collisionDist = Infinity;
    this.roll = 0;
    this.lateral = 0;
    this.slew = 0;
    this.pitch = 0;
    this.gunPitch = 0;
    this.initialised = false;
  }

  /** Snap straight to the target (use on spawn/respawn/teleport). */
  snap(state) { this.initialised = false; this.update(1 / 60, state); }

  update(dtRaw, s) {
    const c = this.cfg;
    const dt = Math.min(dtRaw, c.maxDt);
    this.time += dt;

    const speed = s.speed ?? 0;
    const throttle = s.throttle ?? 0;
    const steer = clamp(s.steer ?? 0, -1, 1);
    const turretTurn = clamp(s.turretTurn ?? 0, -1, 1);
    const speedT = Math.pow(clamp(Math.abs(speed) / c.maxSpeed, 0, 1), c.speedCurve);
    const reversing = speed < -c.reverseThreshold;
    // Braking: throttle released/reversed while still rolling forward (same idea as taillights)
    const braking = speed > 1.0 && throttle < c.brakeThrottle;
    const brakeT = braking
      ? speedT * clamp((c.brakeThrottle - throttle) / (c.brakeThrottle + 1), 0, 1)
      : 0;

    // ----- initialise -----
    if (!this.initialised) {
      this.pivot.copy(s.position);
      this.yaw = s.heading;
      this.aimYaw = s.turretYaw ?? s.heading;
      this.gunPitch = s.turretPitch ?? 0;
      this.fov = c.fovBase;
      this.distance = c.distanceMin;
      this.collisionDist = Infinity;
      this.initialised = true;
    }

    // ----- pivot: locked to the hull on XZ. Only Y is smoothed, and capped. -----
    this.pivot.x = s.position.x;
    this.pivot.z = s.position.z;
    this.pivot.y = damp(this.pivot.y, s.position.y, c.followLambdaY, dt);
    const yErr = this.pivot.y - s.position.y;
    if (Math.abs(yErr) > c.maxPivotLagY) this.pivot.y = s.position.y + Math.sign(yErr) * c.maxPivotLagY;

    // ----- yaw: heading blended with turret, lagged, steer-offset -----
    let baseYaw = s.heading;
    if (reversing && c.reverseFlip) baseYaw += Math.PI;
    const turretYaw = s.turretYaw ?? s.heading;
    let desiredYaw = lerpAngle(baseYaw, turretYaw, c.turretFollowWeight);
    desiredYaw += -steer * deg(c.steerYawOffsetDeg) * speedT; // swing to outside of turn
    const yawLambda = lerp(c.yawLambda, c.yawLambdaFast, speedT);
    this.yaw = dampAngle(this.yaw, desiredYaw, yawLambda, dt);
    const yawErr = wrapAngle(desiredYaw - this.yaw);
    const maxYawLag = deg(c.maxYawLagDeg);
    if (Math.abs(yawErr) > maxYawLag) this.yaw = wrapAngle(desiredYaw - Math.sign(yawErr) * maxYawLag);
    const desiredAim = lerpAngle(baseYaw, turretYaw, c.turretLookWeight);
    this.aimYaw = dampAngle(this.aimYaw, desiredAim, c.turretYawLambda, dt);
    const aimErr = wrapAngle(desiredAim - this.aimYaw);
    const maxAimLag = deg(c.maxAimLagDeg);
    if (Math.abs(aimErr) > maxAimLag) this.aimYaw = wrapAngle(desiredAim - Math.sign(aimErr) * maxAimLag);

    // ----- speed / brake FOV (±fovDelta around fovBase) -----
    const targetFov = braking
      ? c.fovBase - c.fovDelta * brakeT
      : c.fovBase + c.fovDelta * speedT;
    this.fov = damp(this.fov, targetFov, c.fovLambda, dt);
    // Boom stays at distanceMin. Lerping out to a longer distance at speed is
    // what reels the camera off the hull after you've been driving.
    const targetDist = c.distanceMin;
    this.distance = damp(this.distance, targetDist, c.fovLambda, dt);
    const height = lerp(c.heightMin, c.heightMax, speedT);

    // ----- kick: ease-out shove to peak, then ease-out return synced to reload -----
    if (this.kickPhase === 'attack') {
      this.kickT += dt;
      const u = clamp(this.kickT / this.kickAttackDur, 0, 1);
      // ease-out into peak: fast shove that decelerates into the kicked pose
      this.kickX = this.kickPeak * (1 - Math.pow(1 - u, 3));
      if (u >= 1) {
        this.kickPhase = 'return';
        this.kickX = this.kickPeak;
        this.kickReturnStart = this.kickT;
        this.kickReturnLen = Math.max(1e-4, this.kickTotalDuration - this.kickT);
      }
    } else if (this.kickPhase === 'return') {
      this.kickT += dt;
      const u = clamp((this.kickT - this.kickReturnStart) / this.kickReturnLen, 0, 1);
      // (1-u)^3: decelerates into rest (gentle land as next shot is ready)
      this.kickX = this.kickPeak * Math.pow(1 - u, 3);
      if (u >= 1) {
        this.kickPhase = 'idle';
        this.kickX = 0;
        this.kickPeak = 0;
      }
    }

    // ----- roll / lateral / slew -----
    const rollSign = c.invertRoll ? -1 : 1;
    const rollSpeedFactor = lerp(c.rollMinSpeedFactor, 1, speedT);
    const targetRoll = rollSign * (-steer * deg(c.maxRollDeg) * rollSpeedFactor - turretTurn * deg(c.turretSwingRollDeg));
    this.roll = damp(this.roll, targetRoll, c.rollLambda, dt);
    this.lateral = damp(this.lateral, steer * c.steerLateralOffset * rollSpeedFactor, c.lateralLambda, dt);
    this.slew = damp(this.slew, turretTurn, 6, dt);
    this.pitch = damp(this.pitch, (s.pitch ?? 0) * c.pitchFollowTilt, c.pitchLambda, dt);
    this.gunPitch = damp(this.gunPitch, s.turretPitch ?? 0, c.turretPitchLambda, dt);

    // ----- build desired camera position -----
    fwd(this.yaw, this._f);
    right(this.yaw, this._r);
    // Fire: shove back along view. Hit: shove along shell travel (away from where it came).
    const kickAmt = this.kickX * c.kickDistance;
    let dist = this.distance + (this.kickDirectional ? 0 : kickAmt);
    if (this.kickDirectional && this.kickX > 0) {
      const side = this.kickPush.dot(this._r);
      if (Math.abs(side) > 0.05) this.kickRollSign = Math.sign(side);
    }

    const pivotCopy = this._pivotWorld.copy(this.pivot);
    pivotCopy.y += c.pivotHeight;

    // collision: cast from pivot toward desired position
    this._desired.copy(pivotCopy)
      .addScaledVector(this._f, -dist)
      .addScaledVector(this._r, this.lateral + this.slew * c.turretSwingOffset);
    // Aim up → cam drops a touch; aim down → rises (keeps hull framed)
    this._desired.y += height - this.gunPitch * c.turretPitchHeight;
    if (this.kickDirectional && kickAmt > 0) {
      this._desired.addScaledVector(this.kickPush, kickAmt);
    }

    if (c.collisionEnabled && this.colliders.length) {
      this._dir.subVectors(this._desired, pivotCopy);
      const full = this._dir.length();
      this._dir.normalize();
      this.raycaster.set(pivotCopy, this._dir);
      this.raycaster.far = full;
      const hits = this.raycaster.intersectObjects(this.colliders, true);
      const allowed = hits.length ? Math.max(c.minDistance, hits[0].distance - c.collisionMargin) : Infinity;
      const lam = allowed < this.collisionDist ? c.collisionPullInLambda : c.collisionReleaseLambda;
      this.collisionDist = Number.isFinite(allowed) || Number.isFinite(this.collisionDist)
        ? damp(Number.isFinite(this.collisionDist) ? this.collisionDist : full, Number.isFinite(allowed) ? allowed : full + 1, lam, dt)
        : Infinity;
      if (this.collisionDist < full) {
        this._desired.copy(pivotCopy).addScaledVector(this._dir, this.collisionDist);
      }
    }

    // ----- shake -----
    const trauma = clamp(this.trauma + c.speedShake * speedT, 0, 1);
    const shake = trauma * trauma;
    const t = this.time * c.shakeFrequency;
    const n1 = Math.sin(t * 1.0) * Math.sin(t * 0.37 + 1.3);
    const n2 = Math.sin(t * 1.3 + 2.0) * Math.sin(t * 0.53);
    const n3 = Math.sin(t * 0.9 + 4.0) * Math.sin(t * 0.41 + 0.7);
    this.trauma = Math.max(0, this.trauma - c.shakeDecay * dt);

    this._desired.x += n1 * shake * c.shakeMaxOffset;
    this._desired.y += n2 * shake * c.shakeMaxOffset;

    // ----- apply to camera -----
    this.camera.position.copy(this._desired);

    // look target: ahead along aim direction
    fwd(this.aimYaw, this._f);
    const lookAhead = c.lookAheadStatic + Math.abs(speed) * c.lookAheadSpeed;
    this._look.copy(pivotCopy).addScaledVector(this._f, lookAhead);
    this._look.y = pivotCopy.y + c.lookAtHeight
      - this.pitch * lookAhead * 0.5
      + this.gunPitch * lookAhead * c.turretPitchLookWeight;
    this.camera.lookAt(this._look);

    // local rotations after lookAt: kick pitch + roll tilt, base pitch, gun elev, shake, steer roll
    this.camera.rotateX(
      this.kickX * deg(c.kickPitchDeg)
      + deg(c.basePitchDeg)
      + this.gunPitch * c.turretPitchFollow
      + n3 * shake * deg(c.shakeMaxAngleDeg),
    );
    this.camera.rotateY(n1 * shake * deg(c.shakeMaxAngleDeg));
    this.camera.rotateZ(
      this.roll
      + this.kickX * deg(c.kickRollDeg) * this.kickRollSign
      + n2 * shake * deg(c.shakeMaxAngleDeg),
    );

    // Nitro FOV: soft ease up to peak, soft ease back (default 2s, peak 1s, +10°)
    if (this.nitroFovOn) {
      this.nitroFovT += dt;
      const peak = Math.max(1e-4, c.nitroFovPeakAt);
      const dur = Math.max(peak + 1e-4, c.nitroFovDuration);
      if (this.nitroFovT >= dur) {
        this.nitroFovOn = false;
        this.nitroFovAmt = 0;
      } else if (this.nitroFovT < peak) {
        const u = this.nitroFovT / peak;
        this.nitroFovAmt = u * u;
      } else {
        const u = (this.nitroFovT - peak) / (dur - peak);
        this.nitroFovAmt = Math.max(0, 1 - u * u);
      }
    }

    // FOV (+ fire punch + nitro widen)
    const fov = this.fov + this.kickX * c.kickFovDeg + this.nitroFovAmt * c.nitroFovDeg;
    if (Math.abs(this.camera.fov - fov) > 0.001 || this.camera.near !== c.near) {
      this.camera.fov = fov;
      this.camera.near = c.near;
      this.camera.far = c.far;
      this.camera.updateProjectionMatrix();
    }
  }
}

/* ============================================================
   OPTIONAL: live tweak panel (npm i lil-gui)

   import GUI from 'lil-gui';
   const gui = new GUI();
   for (const [k, v] of Object.entries(tankCam.cfg)) {
     if (typeof v === 'number') gui.add(tankCam.cfg, k, v * 0 - Math.abs(v) * 2, Math.abs(v) * 3 + 1);
     if (typeof v === 'boolean') gui.add(tankCam.cfg, k);
   }
   // Test fire with a key:
   addEventListener('keydown', e => { if (e.code === 'Space') tankCam.kick(1); });
   ============================================================ */
