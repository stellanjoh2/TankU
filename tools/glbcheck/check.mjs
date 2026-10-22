// Headless three.js playback check: load a .glb, play its first clip, report which nodes actually move.
//   node check.mjs ../../exports/sherman_anim.glb [prefix]
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

globalThis.ProgressEvent ??= class extends Event {
  constructor(type, init = {}) { super(type); Object.assign(this, init); }
};

const [file, prefix = ""] = process.argv.slice(2);
const buf = readFileSync(file);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
// node has no image decoder: drop textures, keep everything else
delete gltf.images; delete gltf.textures; delete gltf.samplers;
for (const m of gltf.materials ?? []) {
  const p = m.pbrMetallicRoughness ?? {};
  delete p.baseColorTexture; delete p.metallicRoughnessTexture;
}
const bin = buf.subarray(20 + jsonLen + 8);
gltf.buffers[0] = { byteLength: bin.length, uri: "data:application/octet-stream;base64," + bin.toString("base64") };

new GLTFLoader().parse(JSON.stringify(gltf), "", (res) => {
  const clip = res.animations[0];
  console.log("clip", clip.name, clip.duration.toFixed(2), "s, tracks", clip.tracks.length);
  const mixer = new THREE.AnimationMixer(res.scene);
  mixer.clipAction(clip).play();
  const count = {};
  res.scene.traverse((o) => { count[o.name] = (count[o.name] ?? 0) + 1; });
  const targets = [...new Set(clip.tracks.map((t) => t.name.split(".")[0]))];
  const ambiguous = targets.filter((n) => count[n] !== 1);
  console.log("tracks bound to an ambiguous or missing name:", ambiguous.length ? ambiguous : "none");
  const nodes = [];
  res.scene.traverse((o) => { if (targets.includes(o.name) && o.name.startsWith(prefix) && /Wheel|Roller|Sprocket|Idler/.test(o.name)) nodes.push(o); });
  const snap = () => nodes.map((o) => o.quaternion.clone());
  mixer.setTime(0); const a = snap();
  mixer.setTime(0.5); const b = snap();
  nodes.forEach((o, i) => {
    const deg = THREE.MathUtils.radToDeg(a[i].angleTo(b[i]));
    console.log(o.name.padEnd(20), deg.toFixed(1), "deg in 0.5 s");
  });
}, (e) => { console.error(e); process.exit(1); });
