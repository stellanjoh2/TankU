// Hull attitude. Patrol boats use the live ocean (FFT + shore breakers).
// Large ships pass ocean=false and keep the slow sine swell.

let oceanHeight = null;

export function bindOceanHeight(fn) {
  oceanHeight = fn;
}

export const WAVE = [
  // Long swell first — boats only need the slow set.
  { ax: 0.032, az: 0.018, w: 0.28, amp: 0.33 },
  { ax: 0.085, az: 0.04, w: 0.55, amp: 0.2953125 },
  { ax: -0.05, az: 0.09, w: 0.38, amp: 0.18984375 },
  { ax: 0.12, az: -0.07, w: 0.72, amp: 0.10546875 },
];

/** Surface height offset (m) above the mean waterline. */
export function waveHeight(x, z, t, ocean = true) {
  if (ocean && oceanHeight) return oceanHeight(x, z);
  let h = 0;
  for (const c of WAVE) h += Math.sin(x * c.ax + z * c.az + t * c.w) * c.amp;
  return h;
}

/**
 * Height + attitude for +X-forward hulls using Euler order YXZ
 * (`rotation.set(eulerX, yaw, eulerZ, 'YXZ')`).
 * `sample` is the slope baseline in metres (longer for large ships).
 */
export function wavePose(x, z, t, yaw, sample = 1.2, ocean = true) {
  const h = waveHeight(x, z, t, ocean);
  const dhdx = (waveHeight(x + sample, z, t, ocean) - h) / sample;
  const dhdz = (waveHeight(x, z + sample, t, ocean) - h) / sample;
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
