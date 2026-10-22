import * as THREE from 'three';

export const SIZE = 250;
export const WATER_Y = 0.2;
const SEGS = 220;

// Hills: [cx, cz, height, radius] — ~50% taller + tighter falloff than the old 500 m map.
const HILLS = [
  [-35, -20, 18, 20], [22, -58, 15, 16], [-58, 42, 20, 22],
  [8, 58, 12, 14], [-72, -48, 16, 18], [42, 18, 13, 12],
  [-22, 72, 11, 12], [2, -78, 17, 18], [-48, -8, 14, 15],
];

const smooth = (x, a, b) => THREE.MathUtils.smoothstep(x, a, b);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Signed distance-ish to shore: >0 inland, 0 at beach edge, <0 in water. */
export function shoreSigned(x, z) {
  // C / crescent: land mass shifted west, deep bay opening east (matches ref).
  const lx = x + 18;
  const lz = z * 0.92;
  const r = Math.hypot(lx, lz);
  const ang = Math.atan2(lz, lx);

  const bay = Math.max(0, Math.cos(ang));
  const bayCarve = bay * bay * (48 + 10 * Math.sin(ang * 3.0));

  // Irregular coastline
  const coastNoise =
    6.5 * Math.sin(ang * 5.2 + 0.4) +
    3.2 * Math.sin(ang * 11.0 - 1.1) +
    2.0 * Math.sin(ang * 19.0 + x * 0.04) +
    1.4 * Math.sin(x * 0.09 + z * 0.07);

  const landR = 98 - bayCarve + coastNoise;
  // Soft eastern inlet fingers
  const inlet = Math.exp(-((ang - 0.15) ** 2) / 0.18) * 14;
  return landR - inlet - r;
}

/** 0 at/beyond waterline → 1 deep inland (past beach). */
export function landFactor(x, z) {
  return clamp01(shoreSigned(x, z) / 22);
}

/** Mountain spine along the C arc (west/north-south wrap). */
function ridgeHeight(x, z) {
  const lx = x + 18;
  const lz = z * 0.92;
  const ang = Math.atan2(lz, lx);
  const r = Math.hypot(lx, lz);
  // Ridge sits mid-island, away from the bay mouth — tight radial = steep flanks
  const along = clamp01(1 - Math.abs(ang) / 2.4);
  const awayFromBay = clamp01((-Math.cos(ang) + 0.35) / 1.2);
  const radial = Math.exp(-((r - 55) ** 2) / (16 * 16));
  const jagged =
    1 +
    0.45 * Math.sin(ang * 7.0 + 0.6) +
    0.28 * Math.sin(ang * 15.0 - r * 0.08) +
    0.15 * Math.sin(ang * 23.0 + r * 0.12);
  return along * awayFromBay * radial * jagged * 28;
}

/**
 * Terrain height in metres.
 * Island interior with dramatic hills; beach shelf; seabed below WATER_Y offshore.
 */
export function heightAt(x, z) {
  const signed = shoreSigned(x, z);

  if (signed < -1.5) {
    // Seabed slopes away from shore
    const depth = -signed;
    return WATER_Y - 0.8 - Math.min(12, depth * 0.12) - 0.15 * Math.sin(x * 0.08) * Math.cos(z * 0.07);
  }

  const inland = clamp01(signed / 22);
  const beach = clamp01(signed / 8); // 0 at water → 1 a short way inland

  // Base rolling relief (50% stronger than old map's ~1.6/0.8/0.3)
  let h =
    2.4 * Math.sin(x * 0.028 + 0.4) * Math.cos(z * 0.024 - 0.3) +
    1.35 * Math.sin(x * 0.055 + 1.3) * Math.sin(z * 0.048 + 0.7) +
    0.7 * Math.sin(x * 0.13 + 2.1) * Math.cos(z * 0.15 + 0.4);

  for (const [cx, cz, hh, rad] of HILLS) {
    const d2 = (x - cx) ** 2 + (z - cz) ** 2;
    h += hh * Math.exp(-d2 / (rad * rad));
  }

  h += ridgeHeight(x, z);

  // Micro relief / natural roughness
  h += 0.18 * Math.sin(x * 0.31) * Math.cos(z * 0.27) + 0.1 * Math.sin(x * 0.72 + z * 0.55);

  // Calm pocket near spawn meadow (west-central) — keep a driveable yard
  const spawnR = Math.hypot(x + 8, z + 5);
  h *= 0.4 + 0.6 * smooth(spawnR, 6, 22);

  // Beach shelf: low, sandy, mild slope into the sea
  const beachH = 0.35 + beach * 1.4 + inland * 0.4;
  h = beachH + h * Math.pow(inland, 1.35);

  // Soft blend through the intertidal strip
  if (signed < 6) {
    const t = clamp01((signed + 1.5) / 7.5);
    const seabed = WATER_Y - 0.5;
    h = THREE.MathUtils.lerp(seabed, h, smooth(t, 0, 1));
  }

  return h;
}

/** True where fluffy grass should grow (meadow, not beach / rock / water). */
export function isGrassable(x, z) {
  if (shoreSigned(x, z) < 10) return false;
  if (heightAt(x, z) < WATER_Y + 1.6) return false;
  const e = 0.75;
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  const ny = (2 * e) / Math.hypot(dx, 2 * e, dz);
  const slope = 1 - ny;
  if (slope > 0.2) return false;
  // Keep mountain crest clear
  if (ridgeHeight(x, z) > 8 && slope > 0.08) return false;
  return true;
}

function detailTexture() {
  const n = 256;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  const img = g.createImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const v = 200 + Math.random() * 55;
    img.data.set([v, v, v * 0.97, 255], i * 4);
  }
  g.putImageData(img, 0, 0);
  for (let k = 0; k < 900; k++) {
    g.fillStyle = `rgba(${90 + Math.random() * 60},${80 + Math.random() * 50},60,${0.08 + Math.random() * 0.12})`;
    const s = 2 + Math.random() * 10;
    g.fillRect(Math.random() * n, Math.random() * n, s, s * (0.3 + Math.random()));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(SIZE / 5, SIZE / 5);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function waterTexture() {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  g.fillStyle = '#3a7a9a';
  g.fillRect(0, 0, n, n);
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(220,240,255,${0.04 + Math.random() * 0.08})`;
    g.fillRect(Math.random() * n, Math.random() * n, 4 + Math.random() * 18, 1 + Math.random() * 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(40, 40);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export const DEFAULT_GROUND_PALETTE = {
  grass: '#2e4717',
  dry: '#524c24',
  dirt: '#47331f',
  sand: '#c2b385',
  wetSand: '#8c8061',
  rock: '#6b6661',
  water: '#2a6a88',
};

export function buildTerrain(RAPIER, world, scene) {
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();

  const nrm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  geo.setAttribute('color', colorAttr);

  const palette = {
    grass: new THREE.Color(DEFAULT_GROUND_PALETTE.grass),
    dry: new THREE.Color(DEFAULT_GROUND_PALETTE.dry),
    dirt: new THREE.Color(DEFAULT_GROUND_PALETTE.dirt),
    sand: new THREE.Color(DEFAULT_GROUND_PALETTE.sand),
    wetSand: new THREE.Color(DEFAULT_GROUND_PALETTE.wetSand),
    rock: new THREE.Color(DEFAULT_GROUND_PALETTE.rock),
    water: new THREE.Color(DEFAULT_GROUND_PALETTE.water),
  };
  const c = new THREE.Color();

  function applyPalette() {
    const grass = palette.grass, dry = palette.dry, dirt = palette.dirt;
    const sand = palette.sand, wetSand = palette.wetSand, rock = palette.rock;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const signed = shoreSigned(x, z);
      const slope = 1 - nrm.getY(i);
      const patch = 0.5 + 0.5 * Math.sin(x * 0.07 + Math.sin(z * 0.05) * 2.0) * Math.cos(z * 0.06);
      const ridge = ridgeHeight(x, z);

      if (y < WATER_Y + 0.05 || signed < 0) {
        c.copy(wetSand).lerp(sand, clamp01((y - (WATER_Y - 1)) / 1.5));
      } else if (signed < 9) {
        const t = clamp01(signed / 9);
        c.copy(sand).lerp(grass, t * t);
        c.lerp(dry, patch * 0.25 * t);
      } else {
        c.copy(grass).lerp(dry, patch * 0.75).lerp(dirt, Math.min(1, slope * 5));
        const rockAmt = clamp01(slope * 4.5 + ridge * 0.045 - 0.15);
        c.lerp(rock, rockAmt);
        if (ridge > 10 && slope > 0.12) c.lerp(rock, 0.55);
      }
      if (y < WATER_Y) c.multiplyScalar(0.65);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    colorAttr.needsUpdate = true;
  }
  applyPalette();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detailTexture(), roughness: 0.97 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'IslandTerrain';
  scene.add(mesh);

  // Ocean plane (visual); seabed collider is the terrain mesh.
  const waterGeo = new THREE.PlaneGeometry(SIZE * 1.6, SIZE * 1.6, 1, 1);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = new THREE.MeshStandardMaterial({
    color: palette.water,
    map: waterTexture(),
    transparent: true,
    opacity: 0.82,
    roughness: 0.25,
    metalness: 0.1,
    depthWrite: false,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.y = WATER_Y;
  water.receiveShadow = true;
  water.name = 'Ocean';
  scene.add(water);

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const verts = new Float32Array(pos.array);
  const idx = new Uint32Array(geo.index.array);
  world.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx).setFriction(0.9), body);

  return {
    mesh,
    water,
    palette,
    setPalette( partial ) {
      for (const [k, v] of Object.entries(partial)) {
        if (!palette[k]) continue;
        palette[k].set(v);
        if (k === 'water') waterMat.color.copy(palette.water);
      }
      applyPalette();
    },
  };
}
