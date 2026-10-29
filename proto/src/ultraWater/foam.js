// Tileable foam lace + billow height. Same pattern as Ultra-Water's bake (MIT, Humpalumps),
// evaluated on the CPU so it doesn't need a WebGL pass.
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, RGBAFormat, UnsignedByteType } from 'three/webgpu';

function fract(x) {
  return x - Math.floor(x);
}

function gmod(x, y) {
  return x - y * Math.floor(x / y);
}

function hash22(px, py) {
  let x = fract(px * 0.1031);
  let y = fract(py * 0.1030);
  let z = fract(px * 0.0973);
  const dot = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  x = fract(x + dot);
  y = fract(y + dot);
  z = fract(z + dot);
  return [fract((x + y) * z), fract((x + z) * y)];
}

function voronoi(px, py, period) {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  let f1 = 8;
  let f2 = 8;
  for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) {
      const cx = gmod(ix + x, period);
      const cy = gmod(iy + y, period);
      const o = hash22(cx, cy);
      const dx = x + o[0] - fx;
      const dy = y + o[1] - fy;
      const d = Math.hypot(dx, dy);
      if (d < f1) { f2 = f1; f1 = d; }
      else if (d < f2) f2 = d;
    }
  }
  return [f1, f2];
}

function billow(u, v) {
  const a = voronoi(u * 7 + 0.3, v * 7 + 0.3, 7);
  const b = voronoi(u * 17 + 0.7, v * 17 + 0.7, 17);
  const c = voronoi(u * 41 + 0.1, v * 41 + 0.1, 41);
  const edge = (f) => Math.sqrt(Math.min(1, Math.max(0, (f[1] - f[0]) * 2.2)));
  return 0.5 * edge(a) + 0.32 * edge(b) + 0.18 * edge(c);
}

export function bakeFoamTexture(size = 512) {
  const data = new Uint8Array(size * size * 4);
  const e = 1 / 1024;
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const a = voronoi(u * 9, v * 9, 9);
      const b = voronoi(u * 23 + 0.5, v * 23 + 0.5, 23);
      const c = voronoi(u * 61, v * 61, 61);
      const lace = 1 - smooth(a[1] - a[0], 0, 0.22);
      const fine = 1 - smooth(b[1] - b[0], 0, 0.16);
      const bubbles = smooth(c[0], 0.55, 0.15);
      const val = Math.min(1, Math.max(0, (lace * 0.55 + fine * 0.3 + bubbles * 0.25 + (1 - a[0]) * 0.25) * 0.85));
      const h = billow(u, v);
      const gx = (billow(u + e, v) - billow(u - e, v)) / (2 * e);
      const gy = (billow(u, v + e) - billow(u, v - e)) / (2 * e);
      const o = (y * size + x) * 4;
      data[o] = Math.round(val * 255);
      data[o + 1] = Math.round(Math.min(1, Math.max(0, h)) * 255);
      data[o + 2] = Math.round(Math.min(1, Math.max(0, 0.5 + gx / 64)) * 255);
      data[o + 3] = Math.round(Math.min(1, Math.max(0, 0.5 + gy / 64)) * 255);
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.colorSpace = NoColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function smooth(x, e0, e1) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
