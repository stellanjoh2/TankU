// Height of the visible ocean at a world XZ, for hulls.
// FFT displacement is read back from the sim (a few frames late). Shore breakers
// are the same formula as the shader, sampled from the CPU shore maps.
// The shore textures are uploaded flipY, and the shader samples that image.

import { CASCADE_LENGTHS } from './oceanParams.js';

const N = 256;
const CASCADES = 3;
const ROW_BYTES = N * 8;
const BUF_SIZE = N * ROW_BYTES;

const SHORE_OUT = [-60, 10000, 0, 0];
const TRAVEL_OUT = [0, 0, 0, 0];

function fract(v) {
  return v - Math.floor(v);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function f16(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
}

function hash12(x, y) {
  let px = fract(x * 0.1031);
  let py = fract(y * 0.1030);
  let pz = fract(x * 0.0973);
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d;
  py += d;
  pz += d;
  return fract((px + py) * pz);
}

function vnoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash12(ix, iy) * (1 - ux) + hash12(ix + 1, iy) * ux;
  const b = hash12(ix, iy + 1) * (1 - ux) + hash12(ix + 1, iy + 1) * ux;
  return a * (1 - uy) + b * uy;
}

function bilerp(data, size, u, v) {
  const x = clamp(u, 0, size - 1.0001);
  const y = clamp(v, 0, size - 1.0001);
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const at = (ix, iy, c) => data[(iy * size + ix) * 4 + c];
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const a = at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx;
    const b = at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx;
    out[c] = a * (1 - ty) + b * ty;
  }
  return out;
}

function mapSample(data, size, extent, x, z, outside) {
  const u = x / extent + 0.5;
  const v = z / extent + 0.5;
  if (u < 0 || v < 0 || u > 1 || v > 1 || !data) return outside;
  return bilerp(data, size, u * size - 0.5, (1 - v) * size - 0.5);
}

function sampleCascade(field, length, x, z) {
  if (!field) return [0, 0, 0];
  let u = (x / length) % 1;
  let v = (z / length) % 1;
  if (u < 0) u += 1;
  if (v < 0) v += 1;
  const fx = u * N;
  const fy = v * N;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = (x0 + 1) % N;
  const y1 = (y0 + 1) % N;
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (ix, iy, c) => field[(iy * N + ix) * 3 + c];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = at(x0 % N, y0 % N, c) * (1 - tx) + at(x1, y0 % N, c) * tx;
    const b = at(x0 % N, y1, c) * (1 - tx) + at(x1, y1, c) * tx;
    out[c] = a * (1 - ty) + b * ty;
  }
  return out;
}

function dampOf(depth, waveDamp) {
  const swell = smoothstep(2, waveDamp.x, depth);
  const chop = smoothstep(-0.4, 2, depth) * (waveDamp.y + (1 - waveDamp.y) * smoothstep(0, 10, depth));
  return [swell, chop, chop];
}

function shoreDisp(x, z, time, shore, params, swellDir) {
  const sh = mapSample(shore.data, shore.size, shore.extent, x, z, SHORE_OUT);
  const depth = -sh[0];
  const sdf = sh[1];
  const gl = Math.hypot(sh[2], sh[3]);
  let env = smoothstep(180, 70, sdf) * smoothstep(0.35, 0.8, gl) * smoothstep(-0.9, 0.5, depth);
  const zero = { x: 0, y: 0, z: 0, depth };
  if (env <= 0 || params.shoreAmplitude <= 0) return zero;
  const tr = mapSample(shore.travelData, shore.size, shore.extent, x, z, TRAVEL_OUT);
  const trLen2 = tr[1] * tr[1] + tr[2] * tr[2];
  let dirx;
  let dirz;
  if (trLen2 > 0.25) {
    const inv = 1 / Math.sqrt(trLen2);
    dirx = tr[1] * inv;
    dirz = tr[2] * inv;
  } else {
    const g = Math.max(gl, 1e-3);
    dirx = -sh[2] / g;
    dirz = -sh[3] / g;
  }
  env *= 0.25 + 0.75 * smoothstep(-0.3, 0.7, dirx * swellDir.x + dirz * swellDir.y);
  const shoal = trLen2 > 0.25
    ? tr[3]
    : Math.pow(clamp(Math.max(depth, 0.6) / 14, 0.04, 1), -0.25);
  const cel = Math.sqrt(9.81 * clamp(depth, 0.3, 14));
  const amax = 0.42 * Math.max(depth, 0) + 0.14;
  const noisePhase = vnoise(x * 0.0042, z * 0.0042) * 9 + vnoise(x * 0.011 + 7, z * 0.011 + 7) * 2.5;
  const group = 0.45 + 0.55 * vnoise(x * 0.004 + time * 0.021, z * 0.004 - time * 0.017);
  let pinch = 0.85;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  const PI = Math.PI;
  for (let i = 0; i < 2; i++) {
    const primary = i === 0;
    const lambda = params.shoreWavelength * (primary ? 1 : 0.61);
    const w = Math.sqrt(9.81 * 2 * PI / Math.max(lambda, 1)) * params.shoreSpeed;
    const k = w / cel;
    const a = Math.min(
      params.shoreAmplitude * (primary ? 1 : 0.45) * env * shoal * group,
      amax * (primary ? 1 : 0.5),
    );
    const ph = w * (tr[0] + time) + noisePhase * (primary ? 1 : 1.37) + i * 2.1;
    const c = 0.5 + 0.5 * Math.cos(ph);
    const s = Math.sin(ph);
    const cp = Math.pow(Math.max(c, 0), 0.6);
    const rel = a / Math.max(depth, 0.05);
    let pitch = 0;
    if (primary) {
      pitch = 2 * params.shoreSteepness * a
        * smoothstep(0.16, 0.28, rel) * (1 - smoothstep(0.4, 0.6, rel));
    }
    pitch = Math.min(pitch, 0.35 / (1.08 * Math.max(k, 1e-3)));
    pinch -= 1.08 * pitch * k;
    const qak = Math.min(pinch, params.shoreSteepness * a * k * 8);
    pinch -= qak;
    const c5 = c ** 5;
    dy += a * (2 * cp * c - 0.78);
    const horiz = (qak / Math.max(k, 1e-3)) * s + pitch * c5 * c;
    dx += dirx * horiz;
    dz += dirz * horiz;
  }
  return { x: dx, y: dy, z: dz, depth };
}

function fftDisp(fields, x, z, depth, waveDamp) {
  const damp = dampOf(depth, waveDamp);
  let dx = 0;
  let dy = 0;
  let dz = 0;
  for (let c = 0; c < CASCADES; c++) {
    const s = sampleCascade(fields[c], CASCADE_LENGTHS[c], x, z);
    dx += s[0] * damp[c];
    dy += s[1] * damp[c];
    dz += s[2] * damp[c];
  }
  return { x: dx, y: dy, z: dz };
}

const CAPTURE_EVERY = 3; // frames between GPU→CPU FFT copies (hull bob)

export function createSurfaceHeight(renderer, { shore, sim, params, waveDamp, swellDir }) {
  const fields = [null, null, null];
  const bufs = [null, null, null];
  let busy = false;
  let captureAge = CAPTURE_EVERY; // capture on first call, then every CAPTURE_EVERY frames

  function decode(buf) {
    const src = new Uint16Array(buf.getMappedRange());
    const dst = new Float32Array(N * N * 3);
    for (let i = 0, p = 0; i < N * N; i++) {
      const o = i * 4;
      dst[p++] = f16(src[o]);
      dst[p++] = f16(src[o + 1]);
      dst[p++] = f16(src[o + 2]);
    }
    return dst;
  }

  let warned = false;
  function fail(err) {
    busy = false;
    for (let c = 0; c < CASCADES; c++) {
      if (bufs[c]?.mapState === 'mapped') bufs[c].unmap();
    }
    if (!warned) {
      warned = true;
      console.warn('[ocean] hull height readback failed', err);
    }
  }

  function capture() {
    if (++captureAge < CAPTURE_EVERY) return;
    captureAge = 0;
    if (busy) return;
    const device = renderer.backend?.device;
    if (!device) return;
    try {
      const gpus = [];
      for (let c = 0; c < CASCADES; c++) {
        const tex = sim.out[c][sim.parity].disp;
        const gpu = renderer.backend.get(tex)?.texture;
        if (!gpu) return;
        gpus.push(gpu);
        if (!bufs[c]) {
          bufs[c] = device.createBuffer({
            size: BUF_SIZE,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
        }
      }
      const encoder = device.createCommandEncoder();
      for (let c = 0; c < CASCADES; c++) {
        encoder.copyTextureToBuffer(
          { texture: gpus[c], mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
          { buffer: bufs[c], bytesPerRow: ROW_BYTES, rowsPerImage: N },
          { width: N, height: N, depthOrArrayLayers: 1 },
        );
      }
      device.queue.submit([encoder.finish()]);
      busy = true;
      Promise.all(bufs.map((b) => b.mapAsync(GPUMapMode.READ))).then(() => {
        for (let c = 0; c < CASCADES; c++) {
          fields[c] = decode(bufs[c]);
          bufs[c].unmap();
        }
        busy = false;
      }).catch(fail);
    } catch (err) {
      fail(err);
    }
  }

  function displacement(x, z) {
    const shoreD = shoreDisp(x, z, sim.time, shore, params, swellDir.value);
    const fft = fftDisp(fields, x, z, shoreD.depth, waveDamp.value);
    return { x: fft.x + shoreD.x, y: fft.y + shoreD.y, z: fft.z + shoreD.z };
  }

  function height(x, z) {
    const d = displacement(x, z);
    const shift = 12;
    const rx = x - clamp(d.x, -shift, shift);
    const rz = z - clamp(d.z, -shift, shift);
    return displacement(rx, rz).y;
  }

  return { capture, height };
}
