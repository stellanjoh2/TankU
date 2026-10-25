// Shared ocean swell — CPU samples for boats/ships; WaterMesh mirrors the same sines in TSL.
// Long, low waves so a lightly subdivided plane reads as geometry without looking stormy.

export const WAVE = [
  { ax: 0.085, az: 0.04, w: 0.55, amp: 0.07 },
  { ax: -0.05, az: 0.09, w: 0.38, amp: 0.045 },
  { ax: 0.12, az: -0.07, w: 0.72, amp: 0.025 },
];

/** Surface height offset (m) above the mean waterline. */
export function waveHeight(x, z, t) {
  let h = 0;
  for (const c of WAVE) h += Math.sin(x * c.ax + z * c.az + t * c.w) * c.amp;
  return h;
}

/**
 * Height + attitude for +X-forward hulls using Euler order YXZ
 * (`rotation.set(eulerX, yaw, eulerZ, 'YXZ')`).
 * `sample` is the slope baseline in metres (longer for large ships).
 */
export function wavePose(x, z, t, yaw, sample = 1.2) {
  const h = waveHeight(x, z, t);
  const dhdx = (waveHeight(x + sample, z, t) - h) / sample;
  const dhdz = (waveHeight(x, z + sample, t) - h) / sample;
  const fx = Math.cos(yaw);
  const fz = -Math.sin(yaw);
  const rx = Math.sin(yaw);
  const rz = Math.cos(yaw);
  const dhFwd = dhdx * fx + dhdz * fz;
  const dhRight = dhdx * rx + dhdz * rz;
  // Local +X = forward, +Z = starboard: bank about X, pitch about Z.
  return {
    h,
    eulerX: -Math.atan(dhRight),
    eulerZ: Math.atan(dhFwd),
  };
}
