// Distance steps for enemy Shermans. The player tank stays on the full rig.
//
// Sight is 170m and the far spawn sits ~225m out, so the full rig holds past a fight.
// LOD1 merges the hull, turret, and guns (turret, main gun, and .50 still aim; wheels
// still spin; tracks keep crawling as one instanced mesh per side).
// LOD2 is a static hull plus a turret that only yaws.
// Nominal edges are 300m and 420m; pickLod adds a little hysteresis so a tank sitting
// on the line doesn't flicker. The visuals slider scales both edges.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
import { pickLod } from './lod.js';

const LOD_EDGES = [300, 420];
// Keep ratio is a target; targetError (fraction of the part's size) stops the
// collapse before the silhouette moves. LOD1 is tight so a closer step still reads.
const MID = { keep: 0.45, error: 0.012, flags: ['LockBorder'], shadow: true };
// Far step targets ~12% of the triangles. error 1 lets the collapse reach that;
// split vertices are welded first so the outline (barrel, tracks, antenna) stays.
const FAR = { keep: 0.12, error: 1, positional: true, shadow: false };

let lodScale = 1;

export function getTankLodScale() {
  return lodScale;
}

export function setTankLodScale(v) {
  lodScale = THREE.MathUtils.clamp(v, 0.25, 4);
}

function hasAncestor(obj, name) {
  for (let p = obj.parent; p; p = p.parent) {
    if (p.name === name) return true;
  }
  return false;
}

function isWreck(obj) {
  return hasAncestor(obj, 'Sherman_Destroyed') || hasAncestor(obj, 'Sherman_Destroyed_Turret');
}

function kindOf(mesh) {
  const n = mesh.name;
  if (n.startsWith('TrackLink') || mesh.userData.track_s != null) return 'track';
  if (/^(RoadWheel|ReturnRoller|Sprocket|Idler)/.test(n)) return 'wheel';
  return 'body';
}

// Gun and MG stay on their rig nodes so they still aim. Everything else on the
// turret (including the barrel, which lives under Gun_Mount) is split below.
function partOf(mesh) {
  if (hasAncestor(mesh, 'Gun_Mount')) return 'gun';
  if (hasAncestor(mesh, 'MG50_Elevation')) return 'mg';
  if (hasAncestor(mesh, 'MG50_Mount')) return 'mgMount';
  if (hasAncestor(mesh, 'Turret')) return 'turret';
  return 'hull';
}

function groupsOf(geo) {
  const index = geo.getIndex();
  if (!index) return [];
  if (geo.groups.length) return geo.groups;
  return [{ start: 0, count: index.count, materialIndex: 0 }];
}

/** Indexed triangles of one material, baked into `parent` local space. */
function extract(mesh, parent, group) {
  const src = mesh.geometry;
  const index = src.getIndex();
  const start = group.start;
  const count = group.count;
  const remap = new Map();
  const seq = [];
  const newIndex = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const v = index.getX(start + i);
    let n = remap.get(v);
    if (n === undefined) {
      n = seq.length;
      remap.set(v, n);
      seq.push(v);
    }
    newIndex[i] = n;
  }
  const geo = new THREE.BufferGeometry();
  for (const name of Object.keys(src.attributes)) {
    if (name === 'skinIndex' || name === 'skinWeight') continue;
    const attr = src.getAttribute(name);
    if (attr.isInterleavedBufferAttribute) {
      throw new Error(`[tank lod] interleaved ${name} on ${mesh.name}`);
    }
    const item = attr.itemSize;
    const arr = new attr.array.constructor(seq.length * item);
    const srcArr = attr.array;
    for (let d = 0; d < seq.length; d++) {
      const s = seq[d] * item;
      for (let k = 0; k < item; k++) arr[d * item + k] = srcArr[s + k];
    }
    geo.setAttribute(name, new THREE.BufferAttribute(arr, item, attr.normalized));
  }
  geo.setIndex(new THREE.BufferAttribute(newIndex, 1));
  const xform = new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(mesh.matrixWorld);
  geo.applyMatrix4(xform);
  return geo;
}

/** Weld split normals so the simplifier can collapse edges. Position only. */
function weldPositions(geometry) {
  const src = geometry.getIndex();
  const pos = geometry.getAttribute('position');
  const count = src ? src.count : pos.count;
  const map = new Map();
  const order = [];
  const newIndex = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const vi = src ? src.getX(i) : i;
    const key = `${Math.round(pos.getX(vi) * 1e4)},${Math.round(pos.getY(vi) * 1e4)},${Math.round(pos.getZ(vi) * 1e4)}`;
    let n = map.get(key);
    if (n === undefined) {
      n = order.length;
      map.set(key, n);
      order.push(vi);
    }
    newIndex[i] = n;
  }
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.getAttribute(name);
    const item = attr.itemSize;
    const next = new THREE.BufferAttribute(new attr.array.constructor(order.length * item), item, attr.normalized);
    for (let d = 0; d < order.length; d++) {
      for (let k = 0; k < item; k++) next.setComponent(d, k, attr.getComponent(order[d], k));
    }
    out.setAttribute(name, next);
  }
  out.setIndex(new THREE.BufferAttribute(newIndex, 1));
  return out;
}

async function simplify(geometry, spec) {
  await MeshoptSimplifier.ready;
  if (!MeshoptSimplifier.supported) return geometry;
  const source = spec.positional ? weldPositions(geometry) : geometry;
  const dropSource = () => { if (source !== geometry) source.dispose(); };
  const index = source.getIndex();
  const position = source.getAttribute('position');
  if (!index || position.count < 32) {
    dropSource();
    return geometry;
  }
  const target = Math.max(24, Math.floor(index.count * spec.keep / 3) * 3);
  if (target >= index.count - 3) {
    if (spec.positional) source.computeVertexNormals();
    return source;
  }

  const positions = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }

  const normal = source.getAttribute('normal');
  const uv = source.getAttribute('uv');
  const useAttrs = !spec.positional && ((normal ? 3 : 0) + (uv ? 2 : 0)) > 0;
  const stride = (normal ? 3 : 0) + (uv ? 2 : 0);
  let indices;
  if (useAttrs) {
    const attrs = new Float32Array(position.count * stride);
    const weights = [];
    if (normal) weights.push(0.25, 0.25, 0.25);
    if (uv) weights.push(0.5, 0.5);
    for (let i = 0, o = 0; i < position.count; i++) {
      if (normal) {
        attrs[o++] = normal.getX(i);
        attrs[o++] = normal.getY(i);
        attrs[o++] = normal.getZ(i);
      }
      if (uv) {
        attrs[o++] = uv.getX(i);
        attrs[o++] = uv.getY(i);
      }
    }
    indices = MeshoptSimplifier.simplifyWithAttributes(
      index.array, positions, 3, attrs, stride, weights, null, target, spec.error, spec.flags,
    )[0];
  } else {
    indices = MeshoptSimplifier.simplify(
      index.array, positions, 3, target, spec.error, spec.flags,
    )[0];
  }
  if (!indices || indices.length < 24) {
    dropSource();
    return geometry;
  }

  const [remap, unique] = MeshoptSimplifier.compactMesh(indices);
  if (!unique) {
    dropSource();
    return geometry;
  }
  const out = new THREE.BufferGeometry();
  for (const name in source.attributes) {
    const attr = source.getAttribute(name);
    const item = attr.itemSize;
    const next = new THREE.BufferAttribute(new attr.array.constructor(unique * item), item, attr.normalized);
    for (let i = 0; i < remap.length; i++) {
      const dst = remap[i];
      if (dst === 0xffffffff) continue;
      for (let k = 0; k < item; k++) next.setComponent(dst, k, attr.getComponent(i, k));
    }
    out.setAttribute(name, next);
  }
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  dropSource();
  if (spec.positional) out.computeVertexNormals();
  return out;
}

function trisOf(geo) {
  const index = geo.getIndex();
  return index ? index.count / 3 : geo.getAttribute('position').count / 3;
}

async function buildPart(meshes, parent, name, spec) {
  if (!meshes.length) return null;
  const byMat = new Map();
  for (const mesh of meshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const group of groupsOf(mesh.geometry)) {
      if (!group.count) continue;
      const mat = mats[group.materialIndex] ?? mats[0];
      if (!mat) continue;
      const list = byMat.get(mat) ?? [];
      list.push(extract(mesh, parent, group));
      byMat.set(mat, list);
    }
  }
  if (!byMat.size) return null;

  const group = new THREE.Group();
  group.name = name;
  group.visible = false;
  for (const [mat, geos] of byMat) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos);
    if (geos.length > 1) for (const g of geos) g.dispose();
    if (!merged) {
      throw new Error(`[tank lod] merge failed for ${name} (${mat.name || 'material'})`);
    }
    const out = await simplify(merged, spec);
    if (out !== merged) merged.dispose();
    out.computeBoundingSphere();
    const m = new THREE.Mesh(out, mat);
    m.name = name;
    m.castShadow = spec.shadow;
    m.receiveShadow = spec.shadow;
    m.raycast = () => {};
    group.add(m);
  }
  parent.add(group);
  return group;
}

function makeTrackInstances(side) {
  const link = side.links[0];
  if (!link) return null;
  const mat = Array.isArray(link.material) ? link.material[0] : link.material;
  const inst = new THREE.InstancedMesh(link.geometry, mat, side.links.length);
  inst.name = `Track_${side.side}_LOD1`;
  inst.castShadow = true;
  inst.receiveShadow = true;
  inst.frustumCulled = false;
  inst.raycast = () => {};
  inst.visible = false;
  inst.count = side.links.length;
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  link.parent.add(inst);
  for (let i = 0; i < side.links.length; i++) {
    side.links[i].updateMatrix();
    inst.setMatrixAt(i, side.links[i].matrix);
  }
  inst.instanceMatrix.needsUpdate = true;
  return { links: side.links, inst };
}

function syncTracks(lod) {
  for (const { links, inst } of lod.tracks) {
    for (let i = 0; i < links.length; i++) {
      links[i].updateMatrix();
      inst.setMatrixAt(i, links[i].matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
  }
}

function applyLod(lod, level) {
  lod.level = level;
  for (const rec of lod.base) {
    rec.mesh.visible = rec.kind === 'wheel' ? level < 2 : level === 0;
  }
  for (const node of lod.mid) node.visible = level === 1;
  for (const node of lod.far) node.visible = level === 2;
}

function draws(nodes) {
  let n = 0;
  let tris = 0;
  for (const node of nodes) {
    node.traverse((o) => {
      if (!o.isMesh) return;
      n += 1;
      const t = trisOf(o.geometry);
      tris += o.isInstancedMesh ? t * o.count : t;
    });
  }
  return { n, tris };
}

/**
 * Build LOD1 / LOD2 under the live rig. Call once after the tank exists.
 * Originals stay visible until the first updateTankLod.
 */
export async function installTankLods(tank) {
  const model = tank.model;
  model.updateMatrixWorld(true);
  const hull = model.getObjectByName('Hull');
  const parents = {
    hull,
    turret: tank.turret,
    gun: tank.gunMount,
    mg: tank.mgElev,
    mgMount: tank.mgMount,
  };
  for (const [key, node] of Object.entries(parents)) {
    if (!node) throw new Error(`[tank lod] missing ${key}`);
  }

  const base = [];
  model.traverse((o) => {
    if (!o.isMesh || isWreck(o) || o.userData.skipLod) return;
    base.push({ mesh: o, kind: kindOf(o), part: partOf(o) });
  });

  const body = (part) => base.filter((r) => r.kind === 'body' && r.part === part).map((r) => r.mesh);
  const mid = [];
  for (const part of ['hull', 'turret', 'gun', 'mg', 'mgMount']) {
    const g = await buildPart(body(part), parents[part], `${part}_LOD1`, MID);
    if (g) mid.push(g);
  }
  const tracks = [];
  for (const side of tank.sides) {
    const made = makeTrackInstances(side);
    if (!made) continue;
    tracks.push(made);
    mid.push(made.inst);
  }

  const farHull = base.filter((r) => !hasAncestor(r.mesh, 'Turret')).map((r) => r.mesh);
  const farTurret = base.filter((r) => hasAncestor(r.mesh, 'Turret')).map((r) => r.mesh);
  const far = [];
  for (const [meshes, parent, name] of [
    [farHull, hull, 'Hull_LOD2'],
    [farTurret, tank.turret, 'Turret_LOD2'],
  ]) {
    const g = await buildPart(meshes, parent, name, FAR);
    if (g) far.push(g);
  }

  const fullTris = base.reduce((s, r) => s + trisOf(r.mesh.geometry), 0);
  const wheels = base.filter((r) => r.kind === 'wheel');
  const wheelTris = wheels.reduce((s, r) => s + trisOf(r.mesh.geometry), 0);
  const midStats = draws(mid);
  const farStats = draws(far);
  console.info(
    `[tank lod] ${base.length} draws / ${fullTris} tris → `
    + `LOD1 ${wheels.length + midStats.n} draws / ${wheelTris + midStats.tris} tris, `
    + `LOD2 ${farStats.n} draws / ${farStats.tris} tris `
    + `(steps ${LOD_EDGES[0]}m / ${LOD_EDGES[1]}m)`,
  );

  tank._tankLod = { level: -1, base, mid, far, tracks };
}

export function updateTankLod(tank, camPos) {
  const lod = tank._tankLod;
  if (!lod || !tank.model) return;
  const d = tank.model.position.distanceTo(camPos);
  const level = pickLod(d, LOD_EDGES, lodScale, lod.level);
  if (level !== lod.level) applyLod(lod, level);
  if (level === 1) syncTracks(lod);
}
