/** Fraction of a band edge the camera must pass before an object switches level (no flicker at edges). */
const HYSTERESIS = 0.12;
const HYSTERESIS_MIN = 2;

/**
 * Distance LOD level: 0 below edges[0]·scale, 1 below edges[1]·scale, … edges.length beyond.
 * Holds `cur` until `d` is clearly outside its band.
 */
export function pickLod(d, edges, scale, cur) {
  let level = 0;
  while (level < edges.length && d >= edges[level] * scale) level++;
  if (cur < 0 || cur > edges.length || level === cur) return level;
  const lo = cur > 0 ? edges[cur - 1] * scale : -Infinity;
  const hi = cur < edges.length ? edges[cur] * scale : Infinity;
  const pad = (e) => Math.max(HYSTERESIS_MIN, e * HYSTERESIS);
  if (d > lo - pad(lo) && d < hi + pad(hi)) return cur;
  return level;
}
