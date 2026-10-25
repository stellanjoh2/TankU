/** Fraction of a band edge the camera must pass before an object switches level (no flicker at edges). */
const HYSTERESIS = 0.12;
const HYSTERESIS_MIN = 2;

/**
 * Scales world distance for LOD / distance cull. <1 when FOV is tighter than base
 * (Focus / freeflight zoom), so on-screen size drives detail instead of raw metres.
 */
let distMul = 1;

/** Match chase-cam standstill FOV so zoom pulls in higher detail. */
export function setLodFov(fov, baseFov = 62) {
  distMul = Math.max(0.05, fov / baseFov);
}

/** World distance as LOD sees it (shorter when zoomed). */
export function lodDist(d) {
  return d * distMul;
}

/**
 * Distance LOD level: 0 below edges[0]·scale, 1 below edges[1]·scale, … edges.length beyond.
 * Holds `cur` until `d` is clearly outside its band.
 */
export function pickLod(d, edges, scale, cur) {
  d *= distMul;
  let level = 0;
  while (level < edges.length && d >= edges[level] * scale) level++;
  if (cur < 0 || cur > edges.length || level === cur) return level;
  const lo = cur > 0 ? edges[cur - 1] * scale : -Infinity;
  const hi = cur < edges.length ? edges[cur] * scale : Infinity;
  const pad = (e) => Math.max(HYSTERESIS_MIN, e * HYSTERESIS);
  if (d > lo - pad(lo) && d < hi + pad(hi)) return cur;
  return level;
}
