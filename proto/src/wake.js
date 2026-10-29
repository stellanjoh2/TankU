// Foam left on the water: a soft plume plus two Kelvin crests.
// Samples stay where they were shed, so the trail bends through turns.
import * as THREE from 'three/webgpu';
import { attribute, float, mix, smoothstep, texture, uv, vec3 } from 'three/tsl';
import { WATER_Y } from './terrain.js';
import { waveHeight } from './waves.js';

const KELVIN = Math.tan(THREE.MathUtils.degToRad(19.5));

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function wakeHash(ix, iy) {
  let n = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function wakeNoise(x, y, period) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const py = (i) => ((i % period) + period) % period;
  const h = (i, j) => wakeHash(i, py(j));
  const a = h(ix, iy);
  const b = h(ix + 1, iy);
  const c = h(ix, iy + 1);
  const d = h(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function bakeWakeNoise() {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const n = wakeNoise(u * 4, v * 8, 8) * 0.55
        + wakeNoise(u * 9 + 3.1, v * 16, 16) * 0.3
        + wakeNoise(u * 18 + 1.7, v * 32, 32) * 0.15;
      const byte = Math.round(clamp01(n) * 255);
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = byte;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

let wakeTex = null;

function sharedWakeTexture() {
  if (!wakeTex) wakeTex = bakeWakeNoise();
  return wakeTex;
}

function wakeMaterial(tex) {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
    side: THREE.DoubleSide,
  });
  const fade = attribute('aFade', 'float');
  const dist = attribute('aDist', 'float');
  const solidAmt = attribute('aSolid', 'float');
  const u = uv().x;
  const n = texture(tex).r;
  const env = smoothstep(float(0.5), float(0.06), u.sub(0.5).abs());
  const speck = smoothstep(float(0.34), float(0.68), n);
  const lace = env.mul(float(0.4).add(speck.mul(0.6)));
  const plume = mix(env, lace, smoothstep(float(0.4), float(6.5), dist));
  const body = mix(lace, plume, solidAmt);
  mat.colorNode = vec3(0.75, 0.9, 0.93);
  mat.opacityNode = body.mul(fade);
  return mat;
}

function makeRibbon(name, bands, material, max) {
  const stations = max + 1;
  const stride = bands * 2;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(stations * stride * 3);
  const uvs = new Float32Array(stations * stride * 2);
  const fades = new Float32Array(stations * stride);
  const dists = new Float32Array(stations * stride);
  const solids = new Float32Array(stations * stride);
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const uvAttr = new THREE.BufferAttribute(uvs, 2);
  const fadeAttr = new THREE.BufferAttribute(fades, 1);
  const distAttr = new THREE.BufferAttribute(dists, 1);
  const solidAttr = new THREE.BufferAttribute(solids, 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  uvAttr.setUsage(THREE.DynamicDrawUsage);
  fadeAttr.setUsage(THREE.DynamicDrawUsage);
  distAttr.setUsage(THREE.DynamicDrawUsage);
  solidAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('uv', uvAttr);
  geo.setAttribute('aFade', fadeAttr);
  geo.setAttribute('aDist', distAttr);
  geo.setAttribute('aSolid', solidAttr);
  const idx = [];
  for (let i = 0; i < stations - 1; i++) {
    for (let b = 0; b < bands; b++) {
      const a = i * stride + b * 2;
      const c = a + stride;
      const e = a + 1;
      const d = c + 1;
      idx.push(a, c, e, e, c, d);
    }
  }
  geo.setIndex(idx);
  geo.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, positions, uvs, fades, dists, solids, stride, bands };
}

/** Closed waterline ring (shore-style foam around a hull). */
function makeCollar(name, material, segs) {
  const stride = 2;
  const stations = segs + 1;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(stations * stride * 3);
  const uvs = new Float32Array(stations * stride * 2);
  const fades = new Float32Array(stations * stride);
  const dists = new Float32Array(stations * stride);
  const solids = new Float32Array(stations * stride);
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const uvAttr = new THREE.BufferAttribute(uvs, 2);
  const fadeAttr = new THREE.BufferAttribute(fades, 1);
  const distAttr = new THREE.BufferAttribute(dists, 1);
  const solidAttr = new THREE.BufferAttribute(solids, 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  uvAttr.setUsage(THREE.DynamicDrawUsage);
  fadeAttr.setUsage(THREE.DynamicDrawUsage);
  distAttr.setUsage(THREE.DynamicDrawUsage);
  solidAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('uv', uvAttr);
  geo.setAttribute('aFade', fadeAttr);
  geo.setAttribute('aDist', distAttr);
  geo.setAttribute('aSolid', solidAttr);
  const idx = [];
  for (let i = 0; i < segs; i++) {
    const a = i * stride;
    const c = a + stride;
    idx.push(a, c, a + 1, a + 1, c, c + 1);
  }
  geo.setIndex(idx);
  geo.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, positions, uvs, fades, dists, solids, stride, segs };
}

function smoothstep01(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/**
 * @param {THREE.Scene} scene
 * @param {object} [opts] size in metres. Defaults match the patrol boat.
 *   Pass `collar: { halfL, halfW, band? }` for shore-style foam around the hull.
 */
export function createWake(scene, opts = {}) {
  const stern = opts.stern ?? 5.49;
  const cruise = opts.cruise ?? 6.4;
  const step = opts.step ?? 1.15;
  const max = opts.max ?? 32;
  const life = opts.life ?? 8;
  const tile = opts.tile ?? 3.6;
  const half0 = opts.half ?? 1.2;
  const belly = opts.belly ?? 0.95;
  const bellyLen = opts.bellyLen ?? 14;
  const grow = opts.grow ?? 0.025;
  const growCap = opts.growCap ?? 24;
  const raggedA = opts.raggedA ?? 0.1;
  const raggedB = opts.raggedB ?? 0.16;
  const fadeStart = opts.fadeStart ?? 4;
  const fadeEnd = opts.fadeEnd ?? 34;
  const crestIn0 = opts.crestIn0 ?? 3;
  const crestIn1 = opts.crestIn1 ?? 8;
  const crestOut0 = opts.crestOut0 ?? 15;
  const crestOut1 = opts.crestOut1 ?? 32;
  const crestSpread0 = opts.crestSpread0 ?? 0.25;
  const crestThick = opts.crestThick ?? 0.4;
  const crestThickGrow = opts.crestThickGrow ?? 0.012;
  const wobble = opts.wobble ?? 0.22;
  const minSpeed = opts.minSpeed ?? 0.45;
  const collarOpts = opts.collar || null;
  const collarHalfL = collarOpts?.halfL ?? 3.1;
  const collarHalfW = collarOpts?.halfW ?? 1.75;
  const collarBand = collarOpts?.band ?? 0.85;
  const collarSegs = collarOpts?.segs ?? 28;
  const collarInset = collarOpts?.inset ?? 0.15;

  const group = new THREE.Group();
  group.name = opts.name ?? 'Wake';
  group.visible = false;
  const foamMat = wakeMaterial(sharedWakeTexture());
  const ribbon = makeRibbon(group.name, 3, foamMat, max);
  group.add(ribbon.mesh);
  const collar = collarOpts
    ? makeCollar(`${group.name}Collar`, foamMat, collarSegs)
    : null;
  if (collar) group.add(collar.mesh);
  if (scene) scene.add(group);

  const samples = [];
  const pts = [];
  let acc = 0;
  let travel = 0;
  let prevX = opts.x ?? null;
  let prevZ = opts.z ?? null;
  let foamAmt = 0;
  let animT = 0;

  function washHalf(dist) {
    const bulge = Math.sin(Math.min(dist, bellyLen) / bellyLen * Math.PI);
    const ragged = Math.sin(dist * 1.65) * raggedA + Math.sin(dist * 0.43 + 0.8) * raggedB;
    return half0 + bulge * belly + Math.min(dist, growCap) * grow + ragged;
  }

  function washFade(p, dist) {
    const tail = 1 - smoothstep01(fadeStart, fadeEnd, dist);
    const age = 1 - clamp01(p.age / life);
    return tail * tail * age * (0.28 + 0.36 * Math.min(p.k, 1.25));
  }

  function crestFade(p, dist) {
    const appear = smoothstep01(crestIn0, crestIn1, dist);
    const die = 1 - smoothstep01(crestOut0, crestOut1, dist);
    const age = 1 - clamp01(p.age / life);
    return appear * die * age * (0.16 + 0.28 * Math.min(p.k, 1.25));
  }

  function paint(time) {
    const n = Math.min(pts.length, max + 1);
    const { positions, uvs, fades, dists, solids, stride, bands, mesh } = ribbon;
    let run = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (i > 0) run += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      const y = WATER_Y + waveHeight(p.x, p.z, time) + 0.1;
      const half = washHalf(run);
      const fade = washFade(p, run);
      const spread = crestSpread0 + run * KELVIN;
      const thick = crestThick + Math.min(run, 16) * crestThickGrow;
      const crest = crestFade(p, run);
      const wobL = Math.sin(run * 0.62) * wobble;
      const wobR = Math.sin(run * 0.62 + 1.7) * wobble;
      const strips = [
        [0, half, fade, 1],
        [spread + wobL, thick, crest, 0],
        [-spread - wobR, thick, crest, 0],
      ];
      const base = i * stride;
      for (let b = 0; b < bands; b++) {
        const [center, halfW, alpha, solid] = strips[b];
        const o = (base + b * 2) * 3;
        positions[o] = p.x + p.rx * (center + halfW);
        positions[o + 1] = y;
        positions[o + 2] = p.z + p.rz * (center + halfW);
        positions[o + 3] = p.x + p.rx * (center - halfW);
        positions[o + 4] = y;
        positions[o + 5] = p.z + p.rz * (center - halfW);
        const uvb = (base + b * 2) * 2;
        const v = p.along / tile;
        uvs[uvb] = 0;
        uvs[uvb + 1] = v;
        uvs[uvb + 2] = 1;
        uvs[uvb + 3] = v;
        fades[base + b * 2] = alpha;
        fades[base + b * 2 + 1] = alpha;
        dists[base + b * 2] = run;
        dists[base + b * 2 + 1] = run;
        solids[base + b * 2] = solid;
        solids[base + b * 2 + 1] = solid;
      }
    }
    mesh.geometry.setDrawRange(0, Math.max(0, n - 1) * bands * 6);
    const attrs = mesh.geometry.attributes;
    attrs.position.needsUpdate = true;
    attrs.uv.needsUpdate = true;
    attrs.aFade.needsUpdate = true;
    attrs.aDist.needsUpdate = true;
    attrs.aSolid.needsUpdate = true;
  }

  function paintCollar(pose) {
    if (!collar || foamAmt < 0.02) {
      if (collar) collar.mesh.geometry.setDrawRange(0, 0);
      return;
    }
    const { positions, uvs, fades, dists, solids, stride, segs, mesh } = collar;
    const speedK = THREE.MathUtils.clamp(pose.speed / cruise, 0, 1.25);
    const scroll = animT * (0.35 + speedK * 0.55);
    const inL = Math.max(0.4, collarHalfL - collarInset);
    const inW = Math.max(0.4, collarHalfW - collarInset);
    const outL = collarHalfL + collarBand * (0.7 + 0.35 * speedK);
    const outW = collarHalfW + collarBand * (0.55 + 0.25 * speedK);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const ang = t * Math.PI * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      // Ellipse outward: stronger at the bow when moving.
      const bow = Math.max(0, ca);
      const ragged = Math.sin(ang * 3.2 + scroll * 2.1) * 0.08
        + Math.sin(ang * 7.1 - scroll * 1.4) * 0.05;
      const boost = 1 + bow * speedK * 0.35 + ragged;
      const ix = pose.x + pose.fx * (ca * inL) + pose.rx * (sa * inW);
      const iz = pose.z + pose.fz * (ca * inL) + pose.rz * (sa * inW);
      const ox = pose.x + pose.fx * (ca * outL * boost) + pose.rx * (sa * outW * boost);
      const oz = pose.z + pose.fz * (ca * outL * boost) + pose.rz * (sa * outW * boost);
      const yIn = WATER_Y + waveHeight(ix, iz, pose.time ?? 0) + 0.08;
      const yOut = WATER_Y + waveHeight(ox, oz, pose.time ?? 0) + 0.08;
      const o = i * stride * 3;
      positions[o] = ix;
      positions[o + 1] = yIn;
      positions[o + 2] = iz;
      positions[o + 3] = ox;
      positions[o + 4] = yOut;
      positions[o + 5] = oz;
      const uvb = i * stride * 2;
      const v = t * 4.2 + scroll;
      uvs[uvb] = 0;
      uvs[uvb + 1] = v;
      uvs[uvb + 2] = 1;
      uvs[uvb + 3] = v;
      const alpha = foamAmt * (0.42 + 0.28 * bow * Math.min(1, 0.35 + speedK)
        + 0.12 * Math.sin(ang * 5 + scroll * 3));
      fades[i * stride] = alpha * 0.85;
      fades[i * stride + 1] = alpha;
      dists[i * stride] = 0.6;
      dists[i * stride + 1] = 2.4;
      solids[i * stride] = 1;
      solids[i * stride + 1] = 0.55;
    }
    mesh.geometry.setDrawRange(0, segs * 6);
    const attrs = mesh.geometry.attributes;
    attrs.position.needsUpdate = true;
    attrs.uv.needsUpdate = true;
    attrs.aFade.needsUpdate = true;
    attrs.aDist.needsUpdate = true;
    attrs.aSolid.needsUpdate = true;
  }

  function clear(x, z) {
    samples.length = 0;
    acc = 0;
    travel = 0;
    foamAmt = 0;
    animT = 0;
    if (x != null) {
      prevX = x;
      prevZ = z;
    }
    ribbon.mesh.geometry.setDrawRange(0, 0);
    if (collar) collar.mesh.geometry.setDrawRange(0, 0);
    group.visible = false;
  }

  /**
   * @param {number} dt
   * @param {{ x: number, z: number, fx: number, fz: number, rx: number, rz: number,
   *   speed: number, emit: boolean, foam?: boolean, time: number }} pose hull centre, flat forward and right
   */
  function update(dt, pose) {
    animT += dt;
    if (prevX == null) {
      prevX = pose.x;
      prevZ = pose.z;
    }
    const nx = pose.x - prevX;
    const nz = pose.z - prevZ;
    const moved = Math.hypot(nx, nz);
    if (moved > 40) {
      samples.length = 0;
      acc = 0;
      prevX = pose.x;
      prevZ = pose.z;
    } else {
      for (const s of samples) s.age += dt;
      while (samples.length && samples[samples.length - 1].age > life) samples.pop();
      travel += moved;
      if (pose.emit && pose.speed > minSpeed && moved > 1e-4) {
        const k = THREE.MathUtils.clamp(pose.speed / cruise, 0, 1.25);
        const startAcc = acc;
        acc += moved;
        let next = step;
        let guard = 0;
        while (next <= acc && guard < max) {
          const alongSeg = next - startAcc;
          const u = alongSeg / moved;
          samples.unshift({
            x: prevX + nx * u - pose.fx * stern,
            z: prevZ + nz * u - pose.fz * stern,
            rx: pose.rx,
            rz: pose.rz,
            k,
            age: 0,
            along: travel - moved + alongSeg,
          });
          if (samples.length > max) samples.pop();
          next += step;
          guard++;
        }
        acc -= Math.floor(acc / step) * step;
        if (acc < 1e-4) acc = 0;
      } else {
        acc = 0;
      }
      prevX = pose.x;
      prevZ = pose.z;
    }

    pts.length = 0;
    if (pose.emit && pose.speed > minSpeed) {
      const live = {
        x: pose.x - pose.fx * stern,
        z: pose.z - pose.fz * stern,
        rx: pose.rx,
        rz: pose.rz,
        k: THREE.MathUtils.clamp(pose.speed / cruise, 0, 1.25),
        age: 0,
        along: travel,
      };
      const head = samples[0];
      const gap = head ? Math.hypot(live.x - head.x, live.z - head.z) : 0;
      if (!head || (gap >= 0.2 && gap <= step * 1.8)) pts.push(live);
    }
    for (let i = 0; i < samples.length; i++) pts.push(samples[i]);

    const wantFoam = !!(collar && pose.foam);
    const foamTarget = wantFoam ? 1 : 0;
    foamAmt += (foamTarget - foamAmt) * Math.min(1, (wantFoam ? 6 : 3.5) * dt);

    const showTrail = pts.length >= 2;
    if (showTrail) paint(pose.time);
    else ribbon.mesh.geometry.setDrawRange(0, 0);

    if (collar) paintCollar(pose);

    group.visible = showTrail || foamAmt > 0.02;
  }

  return { group, stern, update, clear };
}
