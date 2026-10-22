// Checks that the runtime track maths in src/tank.js reproduces the rest pose baked into the GLB.
//   node tools/rigcheck.mjs
import { readFileSync } from 'node:fs';

const buf = readFileSync(new URL('../public/models/sherman.glb', import.meta.url));
const n = buf.readUInt32LE(12);
const g = JSON.parse(buf.subarray(20, 20 + n).toString());
const byName = Object.fromEntries(g.nodes.map((nd, i) => [nd.name, { ...nd, i }]));

function loop(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  const segs = [];
  let L = 0;
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ s0: L, a, t: [(b[0] - a[0]) / len, (b[1] - a[1]) / len] });
    L += len;
  });
  return { segs, L };
}

function at({ segs, L }, d) {
  d = ((d % L) + L) % L;
  let s = segs[0];
  for (const x of segs) if (x.s0 <= d) s = x;
  return { p: [s.a[0] + s.t[0] * (d - s.s0), s.a[1] + s.t[1] * (d - s.s0)], t: s.t };
}

let worstPos = 0, worstRot = 0;
for (const side of ['L', 'R']) {
  const track = byName[`Track_${side}`];
  const lp = loop(track.extras.path_xz);
  for (const ci of track.children) {
    const link = g.nodes[ci];
    const { p, t } = at(lp, link.extras.track_s);
    const [x, y] = link.translation;
    worstPos = Math.max(worstPos, Math.hypot(x - p[0], y - p[1]));
    const q = link.rotation ?? [0, 0, 0, 1];
    const angGlb = 2 * Math.atan2(q[2], q[3]);
    const angJs = Math.atan2(t[1], t[0]);
    worstRot = Math.max(worstRot, Math.abs(Math.atan2(Math.sin(angGlb - angJs), Math.cos(angGlb - angJs))));
  }
}
console.log(`max link position error ${worstPos.toExponential(2)} m, rotation error ${(worstRot * 180 / Math.PI).toFixed(4)} deg`);
process.exit(worstPos < 1e-3 && worstRot < 1e-3 ? 0 : 1);
