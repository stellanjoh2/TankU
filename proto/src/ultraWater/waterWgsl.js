// Surface displacement + shading. WebGPU port of Ultra-Water's OceanSurface
// (MIT, Copyright (c) 2026 Humpalumps). Helpers are appended after the entry
// point so three's WGSL parser keeps that function as the callable.

const HELPERS = /* wgsl */`
fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  p3 = p3 + dot(p3, p3.yzx + vec3f(33.33));
  return fract((p3.x + p3.y) * p3.z);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(hash12(i), hash12(i + vec2f(1.0, 0.0)), u.x);
  let b = mix(hash12(i + vec2f(0.0, 1.0)), hash12(i + vec2f(1.0, 1.0)), u.x);
  return mix(a, b, u.y);
}
fn gmod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn mapSample(xz: vec2f, map: texture_2d<f32>, samp: sampler, extent: f32) -> vec4f {
  let uv = xz / extent + vec2f(0.5);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { return vec4f(-60.0, 10000.0, 0.0, 0.0); }
  return textureSampleLevel(map, samp, uv, 0.0);
}
fn travelSample(xz: vec2f, map: texture_2d<f32>, samp: sampler, extent: f32) -> vec4f {
  let uv = xz / extent + vec2f(0.5);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { return vec4f(0.0); }
  return textureSampleLevel(map, samp, uv, 0.0);
}
fn cascadeDamp(depth: f32, waveDamp: vec2f) -> vec3f {
  let swell = smoothstep(2.0, waveDamp.x, depth);
  let chop = smoothstep(-0.4, 2.0, depth) * mix(waveDamp.y, 1.0, smoothstep(0.0, 10.0, depth));
  return vec3f(swell, chop, chop);
}
fn shoreDir(sh: vec4f, tr: vec4f) -> vec2f {
  if (dot(tr.yz, tr.yz) > 0.25) { return normalize(tr.yz); }
  return -sh.zw / max(length(sh.zw), 1e-3);
}
fn shoreExposure(dir: vec2f, swellDir: vec2f) -> f32 {
  return mix(0.25, 1.0, smoothstep(-0.3, 0.7, dot(dir, swellDir)));
}
fn shorePhase(xz: vec2f) -> f32 {
  return vnoise(xz * 0.0042) * 9.0 + vnoise(xz * 0.011 + vec2f(7.0)) * 2.5;
}
fn shoreGroup(xz: vec2f, time: f32) -> f32 {
  return 0.45 + 0.55 * vnoise(xz * 0.004 + vec2f(time * 0.021, -time * 0.017));
}
fn shorePack(xz: vec2f, sh: vec4f, time: f32, shoreWave: vec4f, swellDir: vec2f, trMap: texture_2d<f32>, trS: sampler, extent: f32) -> mat4x4f {
  let PI = 3.14159265359;
  var disp = vec3f(0.0);
  var slope = vec2f(0.0);
  var foam = 0.0;
  var wave0 = vec4f(0.0);
  var breaking0 = 0.0;
  var dir = vec2f(1.0, 0.0);
  var lip = 0.0;
  var residual = 0.0;
  let depth = -sh.x;
  let sdf = sh.y;
  let gl = length(sh.zw);
  var env = smoothstep(180.0, 70.0, sdf) * smoothstep(0.35, 0.8, gl) * smoothstep(-0.9, 0.5, depth);
  if (env <= 0.0 || shoreWave.x <= 0.0) {
    return mat4x4f(vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0));
  }
  let tr = travelSample(xz, trMap, trS, extent);
  dir = shoreDir(sh, tr);
  env = env * shoreExposure(dir, swellDir);
  let shoal = select(
    pow(clamp(max(depth, 0.6) / 14.0, 0.04, 1.0), -0.25),
    tr.w,
    dot(tr.yz, tr.yz) > 0.25
  );
  let cel = sqrt(9.81 * clamp(depth, 0.3, 14.0));
  let amax = 0.42 * max(depth, 0.0) + 0.14;
  let noisePhase = shorePhase(xz);
  let group = shoreGroup(xz, time);
  var pinch = 0.85;
  for (var i = 0; i < 2; i = i + 1) {
    let primary = i == 0;
    let lambda = shoreWave.y * select(0.61, 1.0, primary);
    let w = sqrt(9.81 * 2.0 * PI / max(lambda, 1.0)) * shoreWave.z;
    let k = w / cel;
    let aScale = select(0.45, 1.0, primary);
    let aCap = select(0.5, 1.0, primary);
    let a = min(shoreWave.x * aScale * env * shoal * group, amax * aCap);
    let ph = w * (tr.x + time) + noisePhase * select(1.37, 1.0, primary) + f32(i) * 2.1;
    let c = 0.5 + 0.5 * cos(ph);
    let s = sin(ph);
    let P = 1.6;
    let cp = pow(max(c, 0.0), P - 1.0);
    let rel = a / max(depth, 0.05);
    let cycle = floor((ph + PI) / (2.0 * PI));
    let early = vnoise(xz * 0.03 + vec2f(cycle * 7.3, cycle * 3.1 + f32(i) * 31.0));
    let breaking = smoothstep(0.12 + 0.14 * early, 0.3 + 0.2 * early, rel);
    var pitch = 0.0;
    if (primary) {
      pitch = 2.0 * shoreWave.w * a * smoothstep(0.16, 0.28, rel) * (1.0 - smoothstep(0.4, 0.6, rel));
    }
    pitch = min(pitch, 0.35 / (1.08 * max(k, 1e-3)));
    pinch = pinch - 1.08 * pitch * k;
    let qak = min(pinch, shoreWave.w * a * k * 8.0);
    pinch = pinch - qak;
    let c5 = c * c * c * c * c;
    disp.y = disp.y + a * (2.0 * cp * c - 0.78);
    let horiz = dir * ((qak / max(k, 1e-3)) * s + pitch * c5 * c);
    disp = vec3f(disp.x + horiz.x, disp.y, disp.z + horiz.y);
    slope = slope + dir * (a * k * P * cp * s / max(1.0 - qak * cos(ph) + 3.0 * pitch * k * c5 * s, 0.2));
    let psi = gmod(ph + PI, 2.0 * PI) - PI;
    foam = foam + breaking * smoothstep(-0.45, 0.0, psi) * exp(-max(psi, 0.0) * 0.8);
    if (primary) {
      wave0 = vec4f(a, k, w, ph);
      breaking0 = breaking;
      lip = breaking * c5 * smoothstep(0.6, -0.2, psi);
      residual = smoothstep(0.18, 0.4, rel) * (0.3 + 0.45 * exp(-gmod(ph, 2.0 * PI) * 0.4));
    }
  }
  return mat4x4f(vec4f(disp, foam), vec4f(slope, lip, residual), wave0, vec4f(dir, breaking0, 0.0));
}
fn skyAt(dirIn: vec3f, lod: f32, sky: texture_cube<f32>, samp: sampler, maxLod: f32) -> vec3f {
  var dir = dirIn;
  dir.y = max(dir.y, 0.0);
  if (dot(dir, dir) < 1e-6) { dir = vec3f(0.0, 1.0, 0.0); }
  return textureSampleLevel(sky, samp, normalize(dir), clamp(lod, 0.0, maxLod)).rgb;
}
fn sceneAt(map: texture_2d<f32>, uv: vec2f) -> vec3f {
  let dim = vec2f(textureDimensions(map));
  let p = clamp(uv, vec2f(0.0), vec2f(0.999)) * dim - vec2f(0.5);
  let i = vec2i(floor(p));
  let f = fract(p);
  let s = vec2i(dim) - vec2i(1, 1);
  let c00 = textureLoad(map, vec2u(clamp(i, vec2i(0), s)), 0).rgb;
  let c10 = textureLoad(map, vec2u(clamp(i + vec2i(1, 0), vec2i(0), s)), 0).rgb;
  let c01 = textureLoad(map, vec2u(clamp(i + vec2i(0, 1), vec2i(0), s)), 0).rgb;
  let c11 = textureLoad(map, vec2u(clamp(i + vec2i(1, 1), vec2i(0), s)), 0).rgb;
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.y), f.y);
}
fn depthAt(map: DEPTH_TEX, uv: vec2f) -> f32 {
  let dim = vec2f(textureDimensions(map));
  let c = vec2u(clamp(uv, vec2f(0.0), vec2f(0.999)) * dim);
  return DEPTH_LOAD;
}
fn linDepth(d: f32, near: f32, far: f32) -> f32 {
  let viewZ = near * far / ((far - near) * d - far);
  return -viewZ;
}
fn poisson(lam: f32, u: f32) -> f32 {
  if (lam > 6.0) { return max(0.0, lam + sqrt(lam) * log(u / (1.0 - u)) / 1.702); }
  var p = exp(-lam);
  var F = p;
  var n = 0.0;
  for (var k = 0; k < 14; k = k + 1) {
    if (u <= F) { break; }
    n = n + 1.0;
    p = p * lam / n;
    F = F + p;
  }
  return n;
}
`;

export const DISPLACE_WGSL = /* wgsl */`
fn displace(
  xz: vec2f, cell: f32, time: f32, wl: vec4f, waveDamp: vec2f, shoreWave: vec4f, swellDir: vec2f, extent: f32, wind: f32,
  d0: texture_2d<f32>, d0s: sampler, d1: texture_2d<f32>, d1s: sampler, d2: texture_2d<f32>, d2s: sampler,
  s0: texture_2d<f32>, s0s: sampler, s1: texture_2d<f32>, s1s: sampler, s2: texture_2d<f32>, s2s: sampler,
  shMap: texture_2d<f32>, shS: sampler, trMap: texture_2d<f32>, trS: sampler
) -> vec4f {
  let sh = mapSample(xz, shMap, shS, extent);
  let damp = cascadeDamp(-sh.x, waveDamp);
  let lod = max(log2(max(cell, 1e-3) * vec3f(128.0) / wl.xyz) + vec3f(1.0), vec3f(0.0));
  var d = textureSampleLevel(d0, d0s, xz / wl.x, lod.x).xyz * damp.x
    + textureSampleLevel(d1, d1s, xz / wl.y, lod.y).xyz * damp.y
    + textureSampleLevel(d2, d2s, xz / wl.z, lod.z).xyz * damp.z;
  let pack = shorePack(xz, sh, time, shoreWave, swellDir, trMap, trS, extent);
  d = d + pack[0].xyz;
  let m0 = textureSampleLevel(s0, s0s, vec2f(0.5), 8.0);
  let m1 = textureSampleLevel(s1, s1s, vec2f(0.5), 8.0);
  let m2 = textureSampleLevel(s2, s2s, vec2f(0.5), 8.0);
  let unresolved = max(0.003 + 0.00512 * wind - (m0.z + m0.w + m1.z + m1.w + m2.z + m2.w), 0.0);
  return vec4f(d, unresolved);
}
` + HELPERS;

export const SHADE_WGSL = /* wgsl */`
fn shade(
  xz: vec2f, world: vec3f, cam: vec3f, facing: f32, camSide: f32, camFwd: vec3f, waterDepth: f32, uv: vec2f, unresolved: f32,
  time: f32, wl: vec4f, waveDamp: vec2f, shoreWave: vec4f, swellDir: vec2f, extent: f32,
  optics: vec4f, sss: vec4f, foamP: vec4f, absorption: vec3f, scatter: vec3f, foamTint: vec3f,
  sunDir: vec3f, sunCol: vec3f, fogCol: vec3f, glint: f32, seaY: f32, nearFar: vec2f, skyMaxLod: f32, viewM: mat4x4f,
  d0: texture_2d<f32>, d0s: sampler, d1: texture_2d<f32>, d1s: sampler, d2: texture_2d<f32>, d2s: sampler,
  s0: texture_2d<f32>, s0s: sampler, s1: texture_2d<f32>, s1s: sampler, s2: texture_2d<f32>, s2s: sampler,
  shMap: texture_2d<f32>, shS: sampler, trMap: texture_2d<f32>, trS: sampler,
  foamMap: texture_2d<f32>, foamS: sampler, sceneMap: texture_2d<f32>, depthMap: DEPTH_TEX,
  skyMap: texture_cube<f32>, skyS: sampler
) -> vec4f {
  let PI = 3.14159265359;
  let sh = mapSample(xz, shMap, shS, extent);
  let depthBelow = -sh.x;
  let damp = cascadeDamp(depthBelow, waveDamp);
  let fw = max(max(length(dpdx(xz)), length(dpdy(xz))), 1e-3);
  let lodS = max(log2(fw * vec3f(128.0) / wl.xyz) + vec3f(1.0), vec3f(0.0));
  var s0v = textureSampleLevel(s0, s0s, xz / wl.x, lodS.x) * damp.x;
  var s1v = textureSampleLevel(s1, s1s, xz / wl.y, lodS.y) * damp.y;
  var s2v = textureSampleLevel(s2, s2s, xz / wl.z, lodS.z) * damp.z;
  s0v = vec4f(s0v.xy, s0v.zw * damp.x);
  s1v = vec4f(s1v.xy, s1v.zw * damp.y);
  s2v = vec4f(s2v.xy, s2v.zw * damp.z);
  let pack = shorePack(xz, sh, time, shoreWave, swellDir, trMap, trS, extent);
  let shoreFoam = clamp(pack[0].w, 0.0, 1.0);
  let shoreSlope = pack[1].xy;
  let lip = pack[1].z;
  let residual = pack[1].w;
  let wave0 = pack[2];
  let dir = pack[3].xy;
  let slope = s0v.xy + s1v.xy + s2v.xy + shoreSlope;
  let variance = max(s0v.zw - s0v.xy * s0v.xy, vec2f(0.0)) + max(s1v.zw - s1v.xy * s1v.xy, vec2f(0.0))
    + max(s2v.zw - s2v.xy * s2v.xy, vec2f(0.0));
  let nrm = normalize(vec3f(-slope.x, 1.0, -slope.y));
  let dndx = dpdx(nrm);
  let dndy = dpdy(nrm);
  let geoVar = min(0.25 * (dot(dndx, dndx) + dot(dndy, dndy)), 0.18);
  let alpha2 = optics.x * optics.x + unresolved * damp.z * damp.z + variance.x + variance.y + geoVar;
  let alpha = sqrt(max(alpha2, 1e-6));
  let kill = select((camSide < -0.5), (camSide > 0.5), (facing > 0.5));
  if (kill) { discard; }

  let toCam = cam - world;
  let dist = length(toCam);
  let V = toCam / max(dist, 1e-3);
  let NoV = max(dot(nrm, V), 1e-4);
  let NoL = dot(nrm, sunDir);
  let vp = (viewM * vec4f(world, 1.0)).xyz;
  let rot = mat3x3f(viewM[0].xyz, viewM[1].xyz, viewM[2].xyz);
  let dv = rot * vec3f(nrm.x, 0.0, nrm.z);
  let nS = dv.xy - vp.xy / min(vp.z, -1e-3) * dv.z;
  let sun = sunCol;

  let t0 = textureSampleLevel(d0, d0s, xz / wl.x, lodS.x).w;
  let t1 = textureSampleLevel(d1, d1s, xz / wl.y, lodS.y).w;
  let t2 = textureSampleLevel(d2, d2s, xz / wl.z, lodS.z).w;
  let jac = mix(1.0, t0, damp.x) + mix(1.0, t1, damp.y) + mix(1.0, t2, damp.z) - 2.0;
  var foam = clamp((foamP.x - jac) * foamP.y, 0.0, 1.0);

  let viewCos = max(dot(-V, camFwd), 0.05);
  let sceneZ = linDepth(depthAt(depthMap, uv), nearFar.x, nearFar.y);
  var thick = max(sceneZ - waterDepth, 0.0) / viewCos;
  var ruv = uv + nS * optics.y * clamp(thick * 0.25, 0.0, 1.0) / max(waterDepth * 0.02, 1.0);
  let rZ = linDepth(depthAt(depthMap, ruv), nearFar.x, nearFar.y);
  let keep = smoothstep(waterDepth - 0.3, waterDepth + 0.3, rZ);
  ruv = mix(uv, ruv, keep);
  thick = mix(thick, max(rZ - waterDepth, 0.0) / viewCos, keep);
  let refracted = sceneAt(sceneMap, ruv);
  let T = exp(-absorption * thick);
  let contact = (1.0 - smoothstep(0.0, foamP.z, thick * viewCos)) * smoothstep(6.0, 2.0, depthBelow);
  foam = max(foam, contact * 0.9);

  let ambient = skyAt(vec3f(0.0, 1.0, 0.0), skyMaxLod, skyMap, skyS, skyMaxLod);
  let inscatter = scatter * (ambient + sun * (0.3 + 0.7) * max(sunDir.y, 0.0));
  let crest = max(world.y - seaY, 0.0);
  let k1 = sss.x * crest * pow(clamp(dot(sunDir, -V), 0.0, 1.0), 4.0) * pow(0.5 - 0.5 * NoL, 3.0);
  let k2 = sss.y * pow(NoV, 2.0);
  var sssCol = (k1 + k2) * scatter * sun + sss.z * max(NoL, 0.0) * scatter * sun;
  sssCol = sssCol + lip * sun * exp(-absorption * 2.0) * 0.06 * (0.3 + 2.5 * pow(clamp(dot(sunDir, -V), 0.0, 1.0), 3.0));
  let body = refracted * T + (inscatter + sssCol) * (1.0 - T);

  let F0 = 0.02;
  let F90 = max(1.0 - 0.7 * sqrt(alpha), F0);
  let F = F0 + (F90 - F0) * pow(1.0 - NoV, 5.0);
  var R = reflect(-V, nrm);
  R.y = abs(R.y);
  R = normalize(R + vec3f(nS.x, 0.0, nS.y) * optics.z * 4.0);
  let refl = skyAt(R, clamp(log2(alpha * 650.0), 0.0, skyMaxLod), skyMap, skyS, skyMaxLod);

  let aS = max(alpha, 0.015);
  let aS2 = aS * aS;
  let H = normalize(sunDir + V);
  let NoH = max(dot(nrm, H), 0.0);
  let nl = max(NoL, 0.0);
  let dd = NoH * NoH * (aS2 - 1.0) + 1.0;
  let D = aS2 / (PI * dd * dd);
  let vis = 0.5 / (nl * sqrt(NoV * NoV * (1.0 - aS2) + aS2) + NoV * sqrt(nl * nl * (1.0 - aS2) + aS2) + 1e-5);
  let Fs = F0 + (1.0 - F0) * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  var spec = sun * (PI * D * vis * Fs * nl);
  if (glint > 0.0 && dist < 40.0 && dot(spec, vec3f(1.0)) > 0.02) {
    let lf = log2(fw) + 1.0;
    let l0 = floor(lf);
    let per = 2e4 * D * NoH * 6.8e-5 / (4.0 * max(dot(V, H), 0.05));
    var m = 0.0;
    for (var j = 0; j < 2; j = j + 1) {
      let l = l0 + f32(j);
      let sz = exp2(l);
      let cell = floor(xz / sz);
      let lam = per * sz * sz;
      let tt = time * 3.0 + hash12(cell + vec2f(l * 17.17)) * 64.0;
      let it = floor(tt);
      let n0 = poisson(lam, clamp(hash12(cell * 1.31 + vec2f(it * 3.7)), 1e-4, 0.9999));
      let n1 = poisson(lam, clamp(hash12(cell * 1.31 + vec2f((it + 1.0) * 3.7)), 1e-4, 0.9999));
      let twk = min(mix(n0, n1, smoothstep(0.0, 1.0, tt - it)) / max(lam, 1e-4), 300.0);
      m = m + select(lf - l0, 1.0 - (lf - l0), j == 0) * twk;
    }
    spec = spec * mix(1.0, m, glint * smoothstep(4.0, 30.0, dist));
  }

  var col = mix(body, refl, F) + spec;

  var cover = 0.0;
  var pat = 0.0;
  var fh = 0.5;
  var dens = 0.0;
  var fg = vec2f(0.0);
  let nearFoam = dist < 100.0;
  if (foam > 0.0) {
    if (nearFoam) {
      let tA = textureSampleLevel(foamMap, foamS, xz * 0.11, 0.0);
      pat = tA.r * 0.65 + textureSampleLevel(foamMap, foamS, xz * 0.031 + vec2f(0.37), 0.0).r * 0.35;
      cover = smoothstep(1.05 - foam, 1.3 - foam, pat) * sqrt(foam);
      fh = tA.g;
      fg = (tA.ba - vec2f(0.5)) * 64.0 * 0.11;
      dens = foam;
    } else {
      cover = sqrt(foam) * 0.55;
      dens = foam;
      pat = foam;
    }
  }
  if (nearFoam && shoreFoam > 0.0) {
    let FLOW_T = 2.5;
    let vel = dir * wave0.z / max(wave0.y, 1e-3);
    let f0 = fract(time / FLOW_T);
    let f1 = fract(time / FLOW_T + 0.5);
    let wb = abs(2.0 * f0 - 1.0);
    let b0 = textureSampleLevel(foamMap, foamS, (world.xz - vel * (f0 * FLOW_T)) * 0.15, 0.0);
    let b1 = textureSampleLevel(foamMap, foamS, (world.xz - vel * (f1 * FLOW_T)) * 0.15 + vec2f(0.43), 0.0);
    let shh = mix(b0.g, b1.g, wb);
    let sPattern = mix(b0.r, b1.r, wb) * 0.3 + shh * 0.45 + textureSampleLevel(foamMap, foamS, world.xz * 0.023 + vec2f(0.5), 0.0).r * 0.25;
    let sCover = smoothstep(1.0 - shoreFoam * 1.1, 1.2 - shoreFoam * 1.1, sPattern) * sqrt(shoreFoam);
    if (sCover >= cover) {
      pat = sPattern;
      fh = shh;
      dens = shoreFoam;
      fg = mix(b0.ba, b1.ba, wb) * (64.0 * 0.15) - vec2f(32.0 * 0.15);
    }
    cover = max(cover, sCover);
  }
  if (nearFoam && residual > 0.0) {
    let fp = fract(time / 8.0);
    let drift = dir * 2.8;
    let r0 = textureSampleLevel(foamMap, foamS, (world.xz - drift * fp) * 0.06, 0.0).r;
    let r1 = textureSampleLevel(foamMap, foamS, (world.xz - drift * fract(fp + 0.5)) * 0.06 + vec2f(0.5), 0.0).r;
    let rp = mix(r0, r1, abs(2.0 * fp - 1.0));
    let rCover = smoothstep(1.2 - residual, 1.35 - residual, rp) * residual;
    if (rCover >= cover) { pat = rp; fh = 0.5; fg = vec2f(0.0); dens = residual * 0.5; }
    cover = max(cover, rCover);
  }
  if (cover > 0.0) {
    let fN = normalize(nrm - vec3f(fg.x, 0.0, fg.y) * (0.03 + 0.12 * dens));
    let fl = dot(fN, sunDir);
    let ao = mix(0.45, 1.0, smoothstep(0.15, 0.75, fh));
    let solid = smoothstep(0.2, 0.9, dens * (0.55 + 0.7 * fh));
    let foamAlbedo = mix(foamTint, vec3f(0.95), max(solid, smoothstep(0.3, 0.9, pat) * 0.6));
    var lit = sun * (0.15 + 0.85 * clamp(fl * 0.8 + 0.2, 0.0, 1.0)) * mix(ao, 1.0, 0.4) + ambient * 1.1 * ao;
    lit = lit + sun * pow(clamp(dot(sunDir, -V), 0.0, 1.0), 4.0) * 0.4 * (1.0 - solid);
    var foamCol = foamP.w * foamAlbedo * lit;
    foamCol = foamCol + sun * pow(max(dot(fN, H), 0.0), 90.0) * 0.5 * smoothstep(0.55, 0.85, fh) * solid;
    col = mix(col, foamCol, cover * mix(0.8, 1.0, solid));
  }

  let fog = 1.0 - exp(-dist * optics.w);
  col = mix(col, fogCol, fog);
  return vec4f(max(col, vec3f(0.0)), 1.0);
}
` + HELPERS;
