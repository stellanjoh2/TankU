// Tessendorf FFT ocean: 3 cascades of 128² in one 128×384 atlas.
// WebGPU port of Ultra-Water's OceanSim (MIT, Copyright (c) 2026 Humpalumps).
import { FloatType, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, NearestFilter, RepeatWrapping, StorageTexture, Vector4 } from 'three/webgpu';
import { instanceIndex, storageTexture, texture, uniform, wgslFn } from 'three/tsl';
import { CASCADE_LENGTHS } from './oceanParams.js';

const N = 128;
const LOG_N = 7;
const H = N * CASCADE_LENGTHS.length;
const NC = CASCADE_LENGTHS.length;
const LOOP = 300;
const G = 9.81;

const INIT_WGSL = /* wgsl */`
fn initSpectrum(
  outTex: texture_storage_2d<rgba16float, write>,
  idx: u32,
  specA0: vec4f, specB0: vec4f, specA1: vec4f, specB1: vec4f,
  wl: vec4f, cut: vec4f, capFade: f32, seed: f32
) -> void {
  let N: i32 = 128;
  let p = vec2i(i32(idx % 128u), i32(idx / 128u));
  let c = p.y / N;
  let id = vec2i(p.x, p.y - c * N);
  let a = h0(id, c, specA0, specB0, specA1, specB1, wl, cut, capFade, u32(seed));
  let nid = vec2i((N - id.x) % N, (N - id.y) % N);
  let b = h0(nid, c, specA0, specB0, specA1, specB1, wl, cut, capFade, u32(seed));
  textureStore(outTex, vec2u(u32(p.x), u32(p.y)), vec4f(a, b.x, -b.y));
}

fn pcg2d(v_in: vec2u) -> vec2u {
  var v = v_in * 1664525u + 1013904223u;
  v.x = v.x + v.y * 1664525u;
  v.y = v.y + v.x * 1664525u;
  v = v ^ (v >> vec2u(16u));
  v.x = v.x + v.y * 1664525u;
  v.y = v.y + v.x * 1664525u;
  v = v ^ (v >> vec2u(16u));
  return v;
}

fn gauss(id: vec2i, c: i32, seed: u32) -> vec2f {
  let h = pcg2d(vec2u(u32(id.x), u32(id.y)) + vec2u(u32(c) * 7919u, u32(c) * 104729u) + vec2u(seed, seed));
  let u1 = (f32(h.x) + 1.0) / 4294967296.0;
  let u2 = f32(h.y) / 4294967296.0;
  let r = sqrt(-2.0 * log(u1));
  return r * vec2f(cos(2.0 * 3.14159265359 * u2), sin(2.0 * 3.14159265359 * u2));
}

fn omega(k: f32) -> f32 {
  return sqrt(9.81 * k + 7.4e-5 * k * k * k);
}

fn jonswap(w: f32, a: vec4f, b: vec4f) -> f32 {
  let wp = b.y;
  let sigma = select(0.09, 0.07, w <= wp);
  let r = exp(-(w - wp) * (w - wp) / (2.0 * sigma * sigma * wp * wp));
  let iw = 1.0 / w;
  let q = wp * iw;
  return a.x * b.x * 9.81 * 9.81 * iw * iw * iw * iw * iw * exp(-1.25 * q * q * q * q) * pow(b.z, r);
}

fn normalisation(s: f32) -> f32 {
  let s2 = s * s;
  let s3 = s2 * s;
  let s4 = s3 * s;
  if (s < 5.0) { return -0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * s + 0.163; }
  return -4.80e-08 * s4 + 1.07e-05 * s3 - 9.53e-04 * s2 + 5.90e-02 * s + 3.93e-01;
}

fn directional(theta: f32, w: f32, a: vec4f, b: vec4f) -> f32 {
  let x = w / b.y;
  var s = 6.97 * pow(max(x, 1e-3), 5.0);
  if (x > 1.0) { s = 9.77 * pow(x, -2.5); }
  s = s + 16.0 * tanh(min(x, 20.0)) * a.w * a.w;
  let t = theta - a.y;
  let cosine2s = normalisation(s) * pow(abs(cos(0.5 * t)), 2.0 * s);
  return mix(2.0 / 3.14159265359 * cos(t) * cos(t), cosine2s, a.z);
}

fn spectrum(w: f32, theta: f32, kl: f32, c: i32, specA: vec4f, specB: vec4f, capFade: f32) -> f32 {
  if (specA.x <= 0.0) { return 0.0; }
  let fade = select(specB.w, capFade, c == 2);
  return jonswap(w, specA, specB) * directional(theta, w, specA, specB) * exp(-fade * fade * kl * kl);
}

fn h0(id: vec2i, c: i32, specA0: vec4f, specB0: vec4f, specA1: vec4f, specB1: vec4f, wl: vec4f, cut: vec4f, capFade: f32, seed: u32) -> vec2f {
  let L = wl[c];
  let dk = 2.0 * 3.14159265359 / L;
  let k = vec2f(f32(id.x - 64), f32(id.y - 64)) * dk;
  let kl = length(k);
  var lo = 1e-4;
  var hi = 1e4;
  if (c == 0) { hi = cut.x; }
  else if (c == 1) { lo = cut.x; hi = cut.y; }
  else { lo = cut.y; }
  if (kl < lo || kl > hi) { return vec2f(0.0); }
  let w = omega(kl);
  let dwdk = (9.81 + 3.0 * 7.4e-5 * kl * kl) / (2.0 * w);
  let theta = atan2(k.y, k.x);
  let S = spectrum(w, theta, kl, c, specA0, specB0, capFade) + spectrum(w, theta, kl, c, specA1, specB1, capFade);
  return gauss(id, c, seed) * sqrt(2.0 * S * dwdk / kl * dk * dk);
}
`;

const EVOLVE_WGSL = /* wgsl */`
fn evolveSpectrum(
  h0tex: texture_2d<f32>,
  out0: texture_storage_2d<rgba16float, write>,
  out1: texture_storage_2d<rgba16float, write>,
  idx: u32, wl: vec4f, time: f32
) -> void {
  let N: i32 = 128;
  let p = vec2i(i32(idx % 128u), i32(idx / 128u));
  let c = p.y / N;
  let local = vec2i(p.x, p.y - c * N);
  let L = wl[c];
  let k = vec2f(f32(local.x - N / 2), f32(local.y - N / 2)) * (2.0 * 3.14159265359 / L);
  let kl = length(k);
  let ik = select(1.0 / kl, 0.0, kl <= 1e-6);
  let W0 = 2.0 * 3.14159265359 / 300.0;
  let ph = 2.0 * 3.14159265359 * fract(floor(omegaK(kl) / W0) * (time / 300.0));
  let e = vec2f(cos(ph), sin(ph));
  let h0v = textureLoad(h0tex, vec2u(u32(p.x), u32(p.y)), 0);
  let h = cmul(h0v.xy, e) + cmul(h0v.zw, vec2f(e.x, -e.y));
  let ih = vec2f(-h.y, h.x);
  let dx = ih * k.x * ik;
  let dz = ih * k.y * ik;
  let dxdx = -h * k.x * k.x * ik;
  let dzdz = -h * k.y * k.y * ik;
  let dxdz = -h * k.x * k.y * ik;
  let dydx = ih * k.x;
  let dydz = ih * k.y;
  let coord = vec2u(u32(p.x), u32(p.y));
  textureStore(out0, coord, vec4f(pack2(dx, dz), pack2(h, dxdz)));
  textureStore(out1, coord, vec4f(pack2(dydx, dydz), pack2(dxdx, dzdz)));
}

fn omegaK(k: f32) -> f32 { return sqrt(9.81 * k + 7.4e-5 * k * k * k); }
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn pack2(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x - b.y, a.y + b.x); }
`;

const FFT_WGSL = /* wgsl */`
fn fftStage(
  in0: texture_2d<f32>, in1: texture_2d<f32>,
  out0: texture_storage_2d<rgba16float, write>,
  out1: texture_storage_2d<rgba16float, write>,
  idx: u32, sub: f32, vertical: f32
) -> void {
  let N: i32 = 128;
  let p = vec2i(i32(idx % 128u), i32(idx / 128u));
  let uSub = i32(sub);
  let i = select(p.x, p.y % N, vertical > 0.5);
  let hs = uSub >> 1;
  let e = (i / uSub) * hs + (i & (hs - 1));
  var pe: vec2i;
  var po: vec2i;
  if (vertical > 0.5) {
    let base = p.y - i;
    pe = vec2i(p.x, base + e);
    po = vec2i(p.x, base + e + N / 2);
  } else {
    pe = vec2i(e, p.y);
    po = vec2i(e + N / 2, p.y);
  }
  let a = 2.0 * 3.14159265359 * f32(i & (uSub - 1)) / f32(uSub);
  let tw = vec2f(cos(a), sin(a));
  let e0 = textureLoad(in0, vec2u(u32(pe.x), u32(pe.y)), 0);
  let o0 = textureLoad(in0, vec2u(u32(po.x), u32(po.y)), 0);
  let e1 = textureLoad(in1, vec2u(u32(pe.x), u32(pe.y)), 0);
  let o1 = textureLoad(in1, vec2u(u32(po.x), u32(po.y)), 0);
  let coord = vec2u(u32(p.x), u32(p.y));
  textureStore(out0, coord, vec4f(e0.xy + cmul(tw, o0.xy), e0.zw + cmul(tw, o0.zw)));
  textureStore(out1, coord, vec4f(e1.xy + cmul(tw, o1.xy), e1.zw + cmul(tw, o1.zw)));
}
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
`;

const ASSEMBLE_WGSL = /* wgsl */`
fn assembleCascade(
  in0: texture_2d<f32>, in1: texture_2d<f32>, prev: texture_2d<f32>,
  outDisp: texture_storage_2d<rgba16float, write>,
  outSlope: texture_storage_2d<rgba16float, write>,
  idx: u32, cascade: f32, lambda: f32, dt: f32, foamRecovery: f32
) -> void {
  let N: i32 = 128;
  let id = vec2i(i32(idx % 128u), i32(idx / 128u));
  let p = vec2i(id.x, id.y + i32(cascade) * N);
  let s = select(-1.0, 1.0, ((id.x + id.y) & 1) == 0);
  let a = textureLoad(in0, vec2u(u32(p.x), u32(p.y)), 0) * s;
  let b = textureLoad(in1, vec2u(u32(p.x), u32(p.y)), 0) * s;
  let dxx = lambda * b.z;
  let dzz = lambda * b.w;
  let dxz = lambda * a.w;
  let jac = (1.0 + dxx) * (1.0 + dzz) - dxz * dxz;
  let slope = b.xy / max(vec2f(1.0 + dxx, 1.0 + dzz), vec2f(0.2));
  let prevT = textureLoad(prev, vec2u(u32(id.x), u32(id.y)), 0).w;
  let turb = min(jac, prevT + dt * foamRecovery / max(jac, 0.5));
  let coord = vec2u(u32(id.x), u32(id.y));
  textureStore(outDisp, coord, vec4f(lambda * a.x, a.z, lambda * a.y, turb));
  textureStore(outSlope, coord, vec4f(slope, slope * slope));
}
`;

const CLEAR_WGSL = /* wgsl */`
fn clearTex(outTex: texture_storage_2d<rgba16float, write>, idx: u32) -> void {
  textureStore(outTex, vec2u(idx % 128u, idx / 128u), vec4f(0.0, 0.0, 0.0, 1.0));
}
`;

function storage(w, h, { half = true, mip = false, repeat = false } = {}) {
  const tex = new StorageTexture(w, h);
  tex.type = half ? HalfFloatType : FloatType;
  tex.magFilter = mip ? LinearFilter : NearestFilter;
  tex.minFilter = mip ? LinearMipmapLinearFilter : NearestFilter;
  tex.wrapS = tex.wrapT = repeat ? RepeatWrapping : RepeatWrapping;
  tex.generateMipmaps = mip;
  tex.mipmapsAutoUpdate = mip;
  return tex;
}

function jonswapParams(windSpeed, fetchKm) {
  const fetch = fetchKm * 1000;
  const u2 = windSpeed * windSpeed;
  return {
    alpha: 0.076 * Math.pow((G * fetch) / u2, -0.22),
    peakOmega: 22 * Math.pow((windSpeed * fetch) / (G * G), -0.33),
  };
}

function pairTex() {
  return [storage(N, H, { half: true }), storage(N, H, { half: true })];
}

export class OceanSim {
  constructor(renderer) {
    this.renderer = renderer;
    this.params = {
      windSpeed: 9,
      windDirection: 20,
      fetchKm: 120,
      spreadBlend: 0.85,
      windSwell: 0.25,
      gamma: 3.3,
      shortWavesFade: 0.04,
      capillaryFade: 0.08,
      waveScale: 1,
      swellScale: 0.7,
      swellWindSpeed: 7,
      swellDirection: -15,
      swellFetchKm: 900,
      swellSwell: 1,
      choppiness: 0.85,
      foamRecovery: 0.7,
      timeScale: 1,
    };
    this.time = 0;
    this.dirty = true;
    this.parity = 0;
    this.lengths = CASCADE_LENGTHS;

    this.h0 = storage(N, H, { half: true });
    const ping = pairTex();
    const pong = pairTex();
    this.ping = ping;
    this.pong = pong;

    this.out = CASCADE_LENGTHS.map(() => [
      { disp: storage(N, N, { mip: true, repeat: true }), slope: storage(N, N, { mip: true, repeat: true }) },
      { disp: storage(N, N, { mip: true, repeat: true }), slope: storage(N, N, { mip: true, repeat: true }) },
    ]);

    this.specA0 = uniform(new Vector4());
    this.specB0 = uniform(new Vector4());
    this.specA1 = uniform(new Vector4());
    this.specB1 = uniform(new Vector4());
    this.wl = uniform(new Vector4(...CASCADE_LENGTHS, 0));
    this.cut = uniform(new Vector4(...CASCADE_LENGTHS.slice(1).map((L) => (2 * Math.PI / L) * 6), 0, 0));
    this.capFade = uniform(0.08);
    this.seed = uniform(1337);
    this.uTime = uniform(0);
    this.uSub = uniform(2);
    this.uVertical = uniform(0);
    this.uCascade = uniform(0);
    this.uLambda = uniform(1);
    this.uDt = uniform(0);
    this.uFoam = uniform(0.7);

    this.h0Node = texture(this.h0);
    this.in0 = texture(ping[0]);
    this.in1 = texture(ping[1]);
    this.out0 = storageTexture(pong[0]);
    this.out1 = storageTexture(pong[1]);
    this.prevNode = texture(this.out[0][0].disp);
    this.dispOut = storageTexture(this.out[0][0].disp);
    this.slopeOut = storageTexture(this.out[0][0].slope);
    this.clearOut = storageTexture(this.out[0][0].disp);

    const initFn = wgslFn(INIT_WGSL);
    const evolveFn = wgslFn(EVOLVE_WGSL);
    const fftFn = wgslFn(FFT_WGSL);
    const assembleFn = wgslFn(ASSEMBLE_WGSL);
    const clearFn = wgslFn(CLEAR_WGSL);

    this.initCompute = initFn({
      outTex: storageTexture(this.h0),
      idx: instanceIndex,
      specA0: this.specA0, specB0: this.specB0, specA1: this.specA1, specB1: this.specB1,
      wl: this.wl, cut: this.cut, capFade: this.capFade, seed: this.seed,
    }).compute(N * H);

    this.evolveCompute = evolveFn({
      h0tex: this.h0Node, out0: this.out0, out1: this.out1,
      idx: instanceIndex, wl: this.wl, time: this.uTime,
    }).compute(N * H);

    this.fftCompute = fftFn({
      in0: this.in0, in1: this.in1, out0: this.out0, out1: this.out1,
      idx: instanceIndex, sub: this.uSub, vertical: this.uVertical,
    }).compute(N * H);

    this.assembleCompute = assembleFn({
      in0: this.in0, in1: this.in1, prev: this.prevNode,
      outDisp: this.dispOut, outSlope: this.slopeOut,
      idx: instanceIndex, cascade: this.uCascade, lambda: this.uLambda, dt: this.uDt, foamRecovery: this.uFoam,
    }).compute(N * N);

    this.clearCompute = clearFn({ outTex: this.clearOut, idx: instanceIndex }).compute(N * N);

    this.dispNodes = CASCADE_LENGTHS.map((_, c) => texture(this.out[c][0].disp));
    this.slopeNodes = CASCADE_LENGTHS.map((_, c) => texture(this.out[c][0].slope));

    for (const pair of this.out) {
      for (const buf of pair) {
        this.clearOut.value = buf.disp;
        renderer.compute(this.clearCompute);
        this.clearOut.value = buf.slope;
        renderer.compute(this.clearCompute);
      }
    }
  }

  updateSpectrum() {
    const p = this.params;
    const wind = jonswapParams(Math.max(p.windSpeed, 0.5), Math.max(p.fetchKm, 1));
    const swell = jonswapParams(p.swellWindSpeed, p.swellFetchKm);
    const rad = (d) => d * Math.PI / 180;
    this.specA0.value.set(p.waveScale, rad(p.windDirection), p.spreadBlend, p.windSwell);
    this.specB0.value.set(wind.alpha, wind.peakOmega, p.gamma, p.shortWavesFade);
    this.specA1.value.set(p.swellScale * p.waveScale, rad(p.swellDirection), 1, p.swellSwell);
    this.specB1.value.set(swell.alpha, swell.peakOmega, p.gamma, p.shortWavesFade);
    this.capFade.value = p.capillaryFade;
    this.renderer.compute(this.initCompute);
    this.dirty = false;
  }

  update(dt) {
    const p = this.params;
    if (this.dirty) this.updateSpectrum();
    const step = Math.min(Math.max(dt, 0), 0.1) * p.timeScale;
    this.time = (this.time + step) % LOOP;
    this.uTime.value = this.time;
    const r = this.renderer;

    this.out0.value = this.ping[0];
    this.out1.value = this.ping[1];
    r.compute(this.evolveCompute);

    let src = this.ping;
    let dst = this.pong;
    for (let dir = 0; dir < 2; dir++) {
      this.uVertical.value = dir;
      for (let s = 1; s <= LOG_N; s++) {
        this.uSub.value = 1 << s;
        this.in0.value = src[0];
        this.in1.value = src[1];
        this.out0.value = dst[0];
        this.out1.value = dst[1];
        r.compute(this.fftCompute);
        const tmp = src;
        src = dst;
        dst = tmp;
      }
    }

    this.in0.value = src[0];
    this.in1.value = src[1];
    this.uLambda.value = p.choppiness;
    this.uDt.value = step;
    this.uFoam.value = p.foamRecovery;
    const next = this.parity ^ 1;
    for (let c = 0; c < NC; c++) {
      this.uCascade.value = c;
      this.prevNode.value = this.out[c][this.parity].disp;
      this.dispOut.value = this.out[c][next].disp;
      this.slopeOut.value = this.out[c][next].slope;
      r.compute(this.assembleCompute);
      this.dispNodes[c].value = this.out[c][next].disp;
      this.slopeNodes[c].value = this.out[c][next].slope;
    }
    this.parity = next;
  }
}
