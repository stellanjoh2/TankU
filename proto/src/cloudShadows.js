// Drifting cloud shadows — the sun's colour is masked by a scrolling world-space cloud field,
// so every lit material (terrain, grass, props, tanks) darkens as a cloud passes.
import * as THREE from 'three/webgpu';
import { texture, uniform, float, renderGroup, clipSpace, cameraProjectionMatrixInverse, cameraWorldMatrix } from 'three/tsl';

const TILE = 420;          // world metres covered by one (wrapping) field tile
const RES = 1024;
const COUNT = 45;          // clouds per tile (~30% ground coverage)
const LENGTH = [50, 110];  // cloud length range, metres — keep well under fog range so edges read
const BLUR_PX = 2;         // ~1 m soft edge
// Virtual height of the SkyMesh cloud layer: converts its sky-plane drift into ground metres.
// ~60 m also roughly matches the sky's cloud feature size to the shadow shapes.
const CLOUD_HEIGHT = 60;

async function loadImage(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

/** White-on-black mask; cloud01 contributes via alpha, cloud02 via luminance (opaque RGB). */
function buildField(images) {
  const raw = document.createElement('canvas');
  raw.width = raw.height = RES;
  const ctx = raw.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, RES, RES);
  ctx.globalCompositeOperation = 'lighter';

  const pxPerM = RES / TILE;
  for (let i = 0; i < COUNT; i++) {
    const img = images[i % images.length];
    const w = THREE.MathUtils.lerp(LENGTH[0], LENGTH[1], Math.random()) * pxPerM;
    const h = w * (img.height / img.width) * THREE.MathUtils.lerp(0.8, 1.2, Math.random());
    const x = Math.random() * RES;
    const y = Math.random() * RES;
    const rot = Math.random() * Math.PI * 2;
    const flip = Math.random() < 0.5 ? -1 : 1;
    // Draw neighbouring copies so clouds crossing the tile edge wrap seamlessly.
    for (const ox of [-RES, 0, RES]) {
      for (const oy of [-RES, 0, RES]) {
        ctx.save();
        ctx.translate(x + ox, y + oy);
        ctx.rotate(rot);
        ctx.scale(flip, 1);
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.restore();
      }
    }
  }

  // Single blur pass (per-draw filters are slow); wrapped copies keep the tile seamless.
  const cv = document.createElement('canvas');
  cv.width = cv.height = RES;
  const out = cv.getContext('2d');
  out.filter = `blur(${BLUR_PX}px)`;
  for (const ox of [-RES, 0, RES]) {
    for (const oy of [-RES, 0, RES]) out.drawImage(raw, ox, oy);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * `lights`: [light, share] pairs — share scales how much of the cloud darkening that light takes
 * (sun 1, fill lights less). Drift follows `sky` (SkyMesh) cloud uniforms. Must run before the
 * first scene render: light nodes read `light.colorNode` when they're created.
 */
export async function createCloudShadows(lights, sky) {
  const images = await Promise.all([
    loadImage('./textures/clouds/cloud01.png'),
    loadImage('./textures/clouds/cloud02.png'),
  ]);
  const field = buildField(images);

  // renderGroup, not the default objectGroup: static materials without animated nodes (terrain,
  // props) only refresh shared uniform buffers after their first frame, so per-object uniforms freeze.
  const uOffset = uniform(new THREE.Vector2()).setGroup(renderGroup);
  const uStrength = uniform(1).setGroup(renderGroup);
  // Reconstruct world XZ from the clip position that was actually rasterized.
  // positionWorld / positionView run in a VERTEX sub-build that does not see InstancedMesh
  // assigns, so grass and other instances were sampling the field at the mesh origin.
  const viewPos = cameraProjectionMatrixInverse.mul(clipSpace);
  const worldPos = cameraWorldMatrix.mul(viewPos);
  const worldXZ = worldPos.xyz.div(worldPos.w).xz;
  const mask = texture(field, worldXZ.add(uOffset).div(TILE)).r.clamp(0, 1).mul(uStrength);

  // colorNode replaces the light's own colour × intensity uniform, so mirror it each frame.
  const masked = lights.map(([light, share]) => {
    const uColor = uniform(new THREE.Color()).setGroup(renderGroup);
    light.colorNode = uColor.mul(float(1).sub(mask.mul(share)));
    return { light, uColor };
  });

  const state = {
    field,
    offset: uOffset.value,
    get strength() { return uStrength.value; },
    set strength(v) { uStrength.value = v; },
    update(dt) {
      for (const { light, uColor } of masked) uColor.value.copy(light.color).multiplyScalar(light.intensity);
      // SkyMesh: cloudUV = dir.xz / (dir.y * elev) * cloudScale + time * cloudSpeed, so its clouds
      // drift toward -x/-z at cloudSpeed / cloudScale * elev sky-plane units per second per axis.
      const elev = THREE.MathUtils.lerp(1, 0.1, sky.cloudElevation.value);
      const k = (sky.cloudSpeed.value / sky.cloudScale.value) * elev * CLOUD_HEIGHT * dt;
      uOffset.value.x += k;
      uOffset.value.y += k;
      uOffset.value.x %= TILE;
      uOffset.value.y %= TILE;
      // Static meshes (terrain, props) only upload shared UBOs when the group version
      // changes. Grass has nodes so it refreshes every frame; without this the ground
      // keeps the first-frame offset and the cloud appears to skip it.
      renderGroup.needsUpdate = true;
    },
  };
  state.update(0);
  return state;
}
