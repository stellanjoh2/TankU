// Grid navigation for the AI tank.
//  * Static cost field over the island: water, steep ground and solid obstacles (cover rocks, palm
//    trunks) are blocked. A chamfer distance transform inflates them by the hull radius and adds a
//    soft "keep clear" band so routes don't scrape along rocks or the waterline.
//  * A* (8-connected, octile) takes an optional per-cell extra cost. The AI feeds it a lazily
//    ray-cast exposure map ("can the enemy see this cell?") plus a proximity term, so one search
//    gives sneaky covered routes when outgunned and direct ones when it has the edge.
//  * String-pulling smooths the grid path but never cuts through blocked or more-exposed cells.
import { SIZE, WATER_Y, BRIDGE, heightAt, shoreSigned, bridgeLocal } from './terrain.js';

export const CELL = 2;
const N = Math.ceil(SIZE / CELL);
const HALF = SIZE / 2;
const HULL_R = 2.5;      // hull centre must stay this far from blocked cells (m)
const KEEP_CLEAR = 6;    // soft-penalty band beyond HULL_R (m) — keep routes inland of the waterline
const WET_SHORE = 3.5;   // metres inland of the waterline treated as undrivable
const MAX_GRADE = 0.8;   // rise/run steeper than this is undrivable
const STEEP_GRADE = 0.45; // above this, climbing gets expensive fast
const SQRT2 = Math.SQRT2;
// Bridge nav footprint: stretch a little onto each bank so the islands connect, but stay tight
// across the deck — a uniform margin was marking the seabed beside the planks as driveable.
const BRIDGE_ALONG = 4;
const BRIDGE_ACROSS = 0.5;

/** True on the roadway (and short bank ramps), not in the water beside the deck. */
function onNavBridge(x, z) {
  const { lx, lz } = bridgeLocal(x, z);
  return Math.abs(lx) < BRIDGE.length * 0.5 + BRIDGE_ALONG
    && Math.abs(lz) < BRIDGE.deckW * 0.5 + BRIDGE_ACROSS;
}

class MinHeap {
  constructor() { this.ids = []; this.keys = []; }
  get size() { return this.ids.length; }
  clear() { this.ids.length = 0; this.keys.length = 0; }
  push(id, key) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id); keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p];
      i = p;
    }
    ids[i] = id; keys[i] = key;
  }
  pop() {
    const { ids, keys } = this;
    const top = ids[0];
    const lastId = ids.pop(), lastKey = keys.pop();
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c]; keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId; keys[i] = lastKey;
    }
    return top;
  }
}

export class NavGrid {
  constructor() {
    this.n = N;
    const cells = N * N;
    this.height = new Float32Array(cells);
    this.grade = new Float32Array(cells);
    this.terrainBlocked = new Uint8Array(cells);
    this.bridge = new Uint8Array(cells);       // roadway cells (exempt from hull-radius wipe)
    this.blocked = new Uint8Array(cells);
    this.clearance = new Float32Array(cells);  // metres to nearest blocked cell
    this.cost = new Float32Array(cells);       // per-metre cost; Infinity = hull can't sit here
    this.region = new Int32Array(cells);       // connected-component id of passable cells (0 = none)
    this.penalty = new Float32Array(cells);    // learned per-metre cost (spots the AI got stuck on)
    this.g = new Float32Array(cells);
    this.parent = new Int32Array(cells);
    this.seen = new Uint32Array(cells);
    this.closed = new Uint32Array(cells);
    this.epoch = 0;
    this.heap = new MinHeap();

    const e = CELL * 0.5;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const x = this.cx(i), z = this.cx(j);
        const h = heightAt(x, z);
        const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
        const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
        const grade = Math.hypot(gx, gz);
        this.height[k] = h;
        this.grade[k] = grade;
        const onB = onNavBridge(x, z);
        this.bridge[k] = onB ? 1 : 0;
        const edge = Math.max(Math.abs(x), Math.abs(z)) > HALF - 6;
        // Mid-span height is seabed (deck is a separate mesh) — bridge mask keeps the roadway open.
        const wet = !onB && (shoreSigned(x, z) < WET_SHORE || h < WATER_Y + 0.5);
        this.terrainBlocked[k] = edge || wet || (!onB && grade > MAX_GRADE) ? 1 : 0;
      }
    }
    this.setObstacles([]);
  }

  cx(i) { return -HALF + (i + 0.5) * CELL; }
  ci(x) { return Math.min(N - 1, Math.max(0, Math.floor((x + HALF) / CELL))); }
  index(x, z) { return this.ci(z) * N + this.ci(x); }
  xOf(k) { return this.cx(k % N); }
  zOf(k) { return this.cx((k / N) | 0); }
  passable(x, z) { return Number.isFinite(this.cost[this.index(x, z)]); }
  clearanceAt(x, z) { return this.clearance[this.index(x, z)]; }
  gradeAt(x, z) { return this.grade[this.index(x, z)]; }

  /**
   * @param {Array<{type:'circle',x:number,z:number,r:number}|{type:'box',x:number,z:number,hx:number,hz:number,yaw:number}>} list
   */
  setObstacles(list) {
    const { blocked, clearance, cost, grade } = this;
    blocked.set(this.terrainBlocked);
    for (const o of list) {
      const reach = o.type === 'circle' ? o.r : Math.hypot(o.hx, o.hz);
      const i0 = this.ci(o.x - reach), i1 = this.ci(o.x + reach);
      const j0 = this.ci(o.z - reach), j1 = this.ci(o.z + reach);
      const c = Math.cos(o.yaw ?? 0), s = Math.sin(o.yaw ?? 0);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = this.cx(i) - o.x, dz = this.cx(j) - o.z;
          let inside;
          if (o.type === 'circle') {
            inside = dx * dx + dz * dz <= (o.r + CELL * 0.5) ** 2;
          } else {
            // world → rock-local (inverse of a Y rotation by yaw)
            const lx = dx * c - dz * s, lz = dx * s + dz * c;
            inside = Math.abs(lx) <= o.hx + CELL * 0.5 && Math.abs(lz) <= o.hz + CELL * 0.5;
          }
          if (inside) blocked[j * N + i] = 1;
        }
      }
    }

    // Two-pass chamfer distance transform (metres).
    const D = CELL, DD = CELL * SQRT2;
    for (let k = 0; k < N * N; k++) clearance[k] = blocked[k] ? 0 : 1e9;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        let v = clearance[k];
        if (i > 0) v = Math.min(v, clearance[k - 1] + D);
        if (j > 0) {
          v = Math.min(v, clearance[k - N] + D);
          if (i > 0) v = Math.min(v, clearance[k - N - 1] + DD);
          if (i < N - 1) v = Math.min(v, clearance[k - N + 1] + DD);
        }
        clearance[k] = v;
      }
    }
    for (let j = N - 1; j >= 0; j--) {
      for (let i = N - 1; i >= 0; i--) {
        const k = j * N + i;
        let v = clearance[k];
        if (i < N - 1) v = Math.min(v, clearance[k + 1] + D);
        if (j < N - 1) {
          v = Math.min(v, clearance[k + N] + D);
          if (i < N - 1) v = Math.min(v, clearance[k + N + 1] + DD);
          if (i > 0) v = Math.min(v, clearance[k + N - 1] + DD);
        }
        clearance[k] = v;
      }
    }

    for (let k = 0; k < N * N; k++) {
      if (blocked[k]) { cost[k] = Infinity; continue; }
      const d = clearance[k];
      // Narrow deck: side-water is only ~2.5 m away, so hull inflation would erase the crossing.
      if (!this.bridge[k] && d < HULL_R) { cost[k] = Infinity; continue; }
      const band = !this.bridge[k] && d < HULL_R + KEEP_CLEAR
        ? 1.5 * (1 - (d - HULL_R) / KEEP_CLEAR) ** 2 : 0;
      const steep = Math.max(0, grade[k] - STEEP_GRADE) * 12;
      cost[k] = 1 + grade[k] * 3 + steep + band;
    }
    this.penalty.fill(0);
    this._labelRegions();
  }

  /** Make a patch more expensive (e.g. where the AI just got wedged) so replans route around it. */
  penalize(x, z, radius = 5, amount = 6) {
    const i0 = this.ci(x - radius), i1 = this.ci(x + radius);
    const j0 = this.ci(z - radius), j1 = this.ci(z + radius);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(this.cx(i) - x, this.cx(j) - z);
        if (d <= radius) this.penalty[j * N + i] += amount * (1 - d / radius);
      }
    }
  }

  /** Flood-fill passable cells so spawns can be kept off unreachable pockets (e.g. hilltops). */
  _labelRegions() {
    const { region, cost } = this;
    region.fill(0);
    const stack = [];
    let id = 0;
    for (let s = 0; s < N * N; s++) {
      if (region[s] || cost[s] === Infinity) continue;
      region[s] = ++id;
      stack.push(s);
      while (stack.length) {
        const k = stack.pop();
        const i = k % N, j = (k / N) | 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = i + di, nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
            const nk = nj * N + ni;
            if (region[nk] || cost[nk] === Infinity) continue;
            region[nk] = id;
            stack.push(nk);
          }
        }
      }
    }
  }

  regionAt(x, z) {
    const p = this.nearestOpen(x, z);
    return p ? this.region[p.k] : 0;
  }

  /** Closest passable cell to (x, z), searched in growing rings. Returns world centre or null. */
  nearestOpen(x, z, maxRing = 8) {
    const ci = this.ci(x), cj = this.ci(z);
    if (Number.isFinite(this.cost[cj * N + ci])) return { x: this.cx(ci), z: this.cx(cj), k: cj * N + ci };
    for (let r = 1; r <= maxRing; r++) {
      let best = -1, bestD = Infinity;
      for (let j = cj - r; j <= cj + r; j++) {
        for (let i = ci - r; i <= ci + r; i++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
          if (i < 0 || j < 0 || i >= N || j >= N) continue;
          const k = j * N + i;
          if (!Number.isFinite(this.cost[k])) continue;
          const d = (i - ci) ** 2 + (j - cj) ** 2;
          if (d < bestD) { bestD = d; best = k; }
        }
      }
      if (best >= 0) return { x: this.xOf(best), z: this.zOf(best), k: best };
    }
    return null;
  }

  _h(a, b) {
    const dx = Math.abs((a % N) - (b % N)), dz = Math.abs(((a / N) | 0) - ((b / N) | 0));
    return CELL * (Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz));
  }

  /**
   * Threat-aware A*. `extra(k)` adds per-metre cost for cell k (exposure, proximity, …).
   * Returns smoothed world waypoints; `reached` is false when the goal was unreachable and the
   * path ends at the closest explored cell instead.
   */
  findPath(sx, sz, gx, gz, { extra = null, maxIter = 9000 } = {}) {
    const s = this.nearestOpen(sx, sz), t = this.nearestOpen(gx, gz);
    if (!s || !t) return { points: [], reached: false };
    const start = s.k, goal = t.k;
    const { g, parent, seen, closed, cost, heap } = this;
    const ep = ++this.epoch;
    heap.clear();
    g[start] = 0; parent[start] = -1; seen[start] = ep;
    heap.push(start, this._h(start, goal));
    let best = start, bestH = this._h(start, goal), found = false, iter = 0;

    while (heap.size && iter < maxIter) {
      const cur = heap.pop();
      if (closed[cur] === ep) continue;
      closed[cur] = ep;
      iter++;
      if (cur === goal) { found = true; break; }
      const hc = this._h(cur, goal);
      if (hc < bestH) { bestH = hc; best = cur; }
      const ci = cur % N, cj = (cur / N) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        const nj = cj + dj;
        if (nj < 0 || nj >= N) continue;
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di;
          if (ni < 0 || ni >= N) continue;
          const nk = nj * N + ni;
          if (closed[nk] === ep) continue;
          const c = cost[nk];
          if (c === Infinity) continue;
          const diag = di && dj;
          if (diag && (cost[cj * N + ni] === Infinity || cost[nj * N + ci] === Infinity)) continue;
          let w = 0.5 * (cost[cur] + c) + this.penalty[nk];
          if (extra) w += extra(nk);
          const ng = g[cur] + (diag ? SQRT2 : 1) * CELL * w;
          if (seen[nk] !== ep || ng < g[nk]) {
            seen[nk] = ep;
            g[nk] = ng;
            parent[nk] = cur;
            heap.push(nk, ng + this._h(nk, goal));
          }
        }
      }
    }

    const cells = [];
    for (let k = found ? goal : best; k !== -1; k = parent[k]) cells.push(k);
    cells.reverse();
    return { points: this._smooth(cells, extra), reached: found };
  }

  _lineOk(ax, az, bx, bz, extra, cap) {
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
    for (let s = 1; s < steps; s++) {
      const k = this.index(ax + (bx - ax) * (s / steps), az + (bz - az) * (s / steps));
      if (this.cost[k] === Infinity) return false;
      if (extra && extra(k) > cap + 1e-3) return false;
    }
    return true;
  }

  _smooth(cells, extra) {
    const pts = cells.map((k) => ({ x: this.xOf(k), z: this.zOf(k), k }));
    if (pts.length <= 2) return pts.map(({ x, z }) => ({ x, z }));
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = i + 1;
      let cap = extra ? extra(pts[j].k) : 0;
      while (j + 1 < pts.length) {
        const nextCap = extra ? Math.max(cap, extra(pts[j + 1].k)) : 0;
        if (!this._lineOk(pts[i].x, pts[i].z, pts[j + 1].x, pts[j + 1].z, extra, nextCap)) break;
        cap = nextCap;
        j++;
      }
      out.push(pts[j]);
      i = j;
    }
    return out.map(({ x, z }) => ({ x, z }));
  }
}
