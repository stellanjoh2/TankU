// Point lights for health / repair pickups and the repair-finish hull streak.
// Strength, radius and fade live here so all three share one tweak surface.
import * as THREE from 'three';

/** Grab pulse (health / repair pickup). Base was MAIN_GUN_LIGHT; −25% intensity.
 *  Tight radius — HDR-ish spill used to tint nearby orange explosion flashes green. */
export const PICKUP_LIGHT = {
  intensity: 928.5,
  distance: 7,
  decay: 2,
  rise: 0.08,   // s to peak
  fade: 1.2,    // s peak → 0
  y: 1.5,       // hull-local height
  pool: 3,
};

/** Floating icon light while the pickup sits in the world — 6.25% intensity, short reach. */
export const WORLD_PICKUP_LIGHT = {
  intensity: PICKUP_LIGHT.intensity * 0.0625,
  distance: 5,
  decay: PICKUP_LIGHT.decay,
};

/** Repair-finish / heal streak follower — same tight reach as the grab pulse. */
export const STREAK_LIGHT = {
  intensity: 154.75,
  distance: 7,
  decay: 2,
  y: 1.5,
};

/** Unit-peak hues for PointLights only. Emissive bands keep their own HDR in tank/crates. */
export const PICKUP_LIGHT_HEALTH = new THREE.Color().setRGB(0.15, 1.0, 0.28);
export const PICKUP_LIGHT_REPAIR = new THREE.Color().setRGB(0.85, 0.35, 1.0);

/** Force unit-peak so an HDR emissive uniform never becomes a wash light colour. */
function unitPeak(dst, src) {
  dst.copy(src);
  const peak = Math.max(dst.r, dst.g, dst.b, 1e-6);
  if (peak > 1) dst.multiplyScalar(1 / peak);
  return dst;
}

// Match the TSL band in tank._installRepairGlow (rear → front).
const SWEEP_X0 = -4.2;
const SWEEP_X1 = 4.6;

/**
 * @param {import('./tank.js').Tank} tank
 */
export function installPickupLights(tank) {
  const make = (color, cfg) => {
    const l = new THREE.PointLight(color, 0, cfg.distance, cfg.decay);
    l.castShadow = false;
    l.position.set(0, cfg.y, 0);
    tank.model.add(l);
    return l;
  };
  const pulses = Array.from({ length: PICKUP_LIGHT.pool }, () => ({
    light: make(0xffffff, PICKUP_LIGHT),
    age: -1,
  }));
  tank._pickupLights = {
    pulses,
    streak: make(PICKUP_LIGHT_REPAIR.clone(), STREAK_LIGHT),
    _i: 0,
  };
  tank._sweepLit = false;
}

/**
 * Fast rise, then fade over PICKUP_LIGHT.fade. Light rides the hull.
 * @param {import('./tank.js').Tank} tank
 * @param {THREE.Color} color
 */
export function pulsePickupLight(tank, color) {
  const sys = tank._pickupLights;
  if (!sys) return;
  const slot = sys.pulses[sys._i++ % sys.pulses.length];
  unitPeak(slot.light.color, color);
  slot.light.intensity = 0;
  slot.age = 0;
}

/** @param {import('./tank.js').Tank} tank */
export function updatePickupLights(tank, dt) {
  const sys = tank._pickupLights;
  if (!sys) return;
  const { intensity: peak, rise, fade } = PICKUP_LIGHT;
  for (const slot of sys.pulses) {
    if (slot.age < 0) continue;
    slot.age += dt;
    const t = slot.age;
    if (t < rise) {
      slot.light.intensity = peak * (t / rise);
    } else if (t < rise + fade) {
      const u = (t - rise) / fade;
      slot.light.intensity = peak * (1 - u) * (1 - u);
    } else {
      slot.light.intensity = 0;
      slot.light.color.setRGB(0, 0, 0);
      slot.age = -1;
    }
  }
}

/**
 * World light locked to the hull sweep band (green heal / purple repair finish).
 * @param {import('./tank.js').Tank} tank
 * @param {number} k  0..1 sweep progress
 * @param {number} amp  0..1 band strength (already fades out at the end)
 */
export function updateSweepLight(tank, k, amp) {
  const sys = tank._pickupLights;
  if (!sys) return;
  const streak = sys.streak;
  if (!tank._sweepLit || amp <= 0) {
    streak.intensity = 0;
    streak.color.setRGB(0, 0, 0);
    return;
  }
  // Band uniform is HDR for bloom; illumination must stay unit-peak.
  const sweepColor = tank._repairU?.color?.value;
  if (sweepColor) unitPeak(streak.color, sweepColor);
  else streak.color.copy(PICKUP_LIGHT_REPAIR);
  // Hull-local +X tracks the same rear→front band as the TSL sweep.
  streak.position.set(
    THREE.MathUtils.lerp(SWEEP_X0, SWEEP_X1, k),
    STREAK_LIGHT.y,
    0,
  );
  streak.intensity = STREAK_LIGHT.intensity * amp;
}

/** @param {import('./tank.js').Tank} tank */
export function clearPickupLights(tank) {
  const sys = tank._pickupLights;
  if (!sys) return;
  for (const slot of sys.pulses) {
    slot.age = -1;
    slot.light.intensity = 0;
    slot.light.color.setRGB(0, 0, 0);
  }
  sys.streak.intensity = 0;
  sys.streak.color.setRGB(0, 0, 0);
  tank._sweepLit = false;
}

/** @param {import('./tank.js').Tank} tank */
export function pickupLightsHot(tank) {
  const sys = tank._pickupLights;
  if (!sys) return false;
  for (const slot of sys.pulses) {
    if (slot.light.intensity > 1) return true;
  }
  return sys.streak.intensity > 1;
}
