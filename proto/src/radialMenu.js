// Pie wheel driven entirely by its item list. Add or remove entries and the
// slices, icon positions, and hit areas rebuild. Angles use screen space
// (y grows downward): 0 is east, the first slice is centered on 12 o'clock.

const SIZE = 400;
const CX = 200;
const CY = 200;
const R_OUT = 172;
const R_IN = 86;
const TAU = Math.PI * 2;
const BLINK = 0.22;

/**
 * Slice under a point relative to the wheel center, or -1 inside the hole.
 * @param {number} x
 * @param {number} y
 * @param {number} count
 * @param {number} rIn
 */
export function sliceAt(x, y, count, rIn) {
  if (count <= 0) return -1;
  if (Math.hypot(x, y) < rIn) return -1;
  const step = TAU / count;
  const start = -Math.PI / 2 - step / 2;
  let rel = Math.atan2(y, x) - start;
  rel = ((rel % TAU) + TAU) % TAU;
  return Math.min(count - 1, Math.floor(rel / step));
}

function polar(r, a) {
  return [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
}

function sectorPath(a0, a1) {
  const f = (n) => n.toFixed(2);
  const sweep = a1 - a0;
  if (sweep >= TAU - 1e-4) {
    return `M ${CX + R_OUT} ${CY} A ${R_OUT} ${R_OUT} 0 1 1 ${CX - R_OUT} ${CY} A ${R_OUT} ${R_OUT} 0 1 1 ${CX + R_OUT} ${CY} M ${CX + R_IN} ${CY} A ${R_IN} ${R_IN} 0 1 0 ${CX - R_IN} ${CY} A ${R_IN} ${R_IN} 0 1 0 ${CX + R_IN} ${CY} Z`;
  }
  const large = sweep > Math.PI ? 1 : 0;
  const [x0, y0] = polar(R_OUT, a0);
  const [x1, y1] = polar(R_OUT, a1);
  const [x2, y2] = polar(R_IN, a1);
  const [x3, y3] = polar(R_IN, a0);
  return `M ${f(x0)} ${f(y0)} A ${R_OUT} ${R_OUT} 0 ${large} 1 ${f(x1)} ${f(y1)} L ${f(x2)} ${f(y2)} A ${R_IN} ${R_IN} 0 ${large} 0 ${f(x3)} ${f(y3)} Z`;
}

function normalize(item) {
  return {
    id: item.id,
    label: item.label || item.id,
    svg: item.svg || '',
    detail: '',
    cooling: false,
  };
}

/**
 * @param {{ id: string, label: string, svg: string }[]} list phosphor fill SVG markup in `svg`
 * @param {{ onSelect?: (item: { id: string, label: string }) => void }} [opts]
 */
export function createRadialMenu(list, opts = {}) {
  const onSelect = opts.onSelect || (() => {});
  let items = (list || []).map(normalize);

  const root = document.createElement('div');
  root.id = 'radial';
  root.className = 'hidden';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="radial-wheel">
      <svg class="radial-svg" viewBox="0 0 ${SIZE} ${SIZE}"></svg>
      <div class="radial-icons"></div>
      <div class="radial-cursor"></div>
      <div class="radial-center"><b></b><em></em></div>
    </div>`;
  document.body.append(root);

  const wheel = root.querySelector('.radial-wheel');
  const svg = root.querySelector('.radial-svg');
  const iconsEl = root.querySelector('.radial-icons');
  const cursorEl = root.querySelector('.radial-cursor');
  const labelEl = root.querySelector('.radial-center b');
  const subEl = root.querySelector('.radial-center em');

  let sliceEls = [];
  let iconEls = [];
  let isOpen = false;
  let cx = 0;
  let cy = 0;
  let hover = -1;
  let blinking = false;
  let blinkIndex = -1;
  let blinkT = 0;
  let activeId = '';

  function rebuild() {
    const n = items.length;
    const step = n ? TAU / n : 0;
    const start = -Math.PI / 2 - step / 2;
    let paths = '';
    let lines = '';
    for (let i = 0; i < n; i++) {
      const a0 = start + i * step;
      paths += `<path class="radial-slice" fill-rule="evenodd" d="${sectorPath(a0, a0 + step)}"/>`;
      if (n > 1) {
        const [x0, y0] = polar(R_IN + 1.25, a0);
        const [x1, y1] = polar(R_OUT - 1.25, a0);
        lines += `<line x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}"/>`;
      }
    }
    const hole = `M ${CX + R_OUT} ${CY} A ${R_OUT} ${R_OUT} 0 1 1 ${CX - R_OUT} ${CY} A ${R_OUT} ${R_OUT} 0 1 1 ${CX + R_OUT} ${CY} M ${CX + R_IN} ${CY} A ${R_IN} ${R_IN} 0 1 0 ${CX - R_IN} ${CY} A ${R_IN} ${R_IN} 0 1 0 ${CX + R_IN} ${CY} Z`;
    svg.innerHTML = `
      <path class="radial-disc" fill-rule="evenodd" d="${hole}"/>
      ${paths}
      <g class="radial-rings">
        <circle cx="${CX}" cy="${CY}" r="${R_OUT}"/>
        <circle cx="${CX}" cy="${CY}" r="${R_IN}"/>
      </g>
      <g class="radial-dividers">${lines}</g>`;
    iconsEl.replaceChildren();
    const iconR = (R_IN + R_OUT) / 2;
    for (let i = 0; i < n; i++) {
      const a = start + (i + 0.5) * step;
      const [x, y] = polar(iconR, a);
      const el = document.createElement('div');
      el.className = 'radial-icon';
      el.style.left = `${(x / SIZE) * 100}%`;
      el.style.top = `${(y / SIZE) * 100}%`;
      el.innerHTML = items[i].svg;
      iconsEl.append(el);
    }
    sliceEls = [...svg.querySelectorAll('.radial-slice')];
    iconEls = [...iconsEl.children];
    const pct = Math.max(4.5, Math.min(9, 36 / Math.max(1, n)));
    wheel.style.setProperty('--icon', `${pct}%`);
    if (hover >= n) hover = -1;
    if (blinkIndex >= n) {
      blinking = false;
      blinkIndex = -1;
    }
    if (isOpen) paint();
  }

  function placeCursor() {
    cursorEl.style.left = `${((CX + cx) / SIZE) * 100}%`;
    cursorEl.style.top = `${((CY + cy) / SIZE) * 100}%`;
    cursorEl.classList.toggle('hidden', Math.hypot(cx, cy) < R_IN);
  }

  function paint() {
    const hot = blinkIndex >= 0 ? blinkIndex : hover;
    const aim = blinkIndex < 0 ? hover : -1;
    sliceEls.forEach((el, i) => {
      const cooling = !!items[i].cooling;
      el.classList.toggle('hot', i === hot && !cooling);
      el.classList.toggle('aim', i === aim);
      el.classList.toggle('blink', i === blinkIndex);
      el.classList.toggle('cooling', cooling);
    });
    iconEls.forEach((el, i) => {
      const item = items[i];
      const cooling = !!item.cooling;
      el.classList.toggle('hot', i === hot && !cooling);
      el.classList.toggle('aim', i === aim);
      el.classList.toggle('blink', i === blinkIndex);
      el.classList.toggle('is-on', item.id === activeId);
      el.classList.toggle('cooling', cooling);
      let badge = el.querySelector('.radial-cd');
      if (cooling && item.detail) {
        if (!badge) {
          badge = document.createElement('em');
          badge.className = 'radial-cd';
          el.append(badge);
        }
        if (badge.textContent !== item.detail) badge.textContent = item.detail;
      } else if (badge) badge.remove();
    });
    wheel.classList.toggle('armed', blinkIndex >= 0 || hover >= 0);

    let title = 'GADGETS';
    let sub = 'RELEASE TO CLOSE';
    let cooling = false;
    if (blinkIndex >= 0) {
      title = items[blinkIndex].label;
      sub = items[blinkIndex].detail;
    } else if (hover >= 0) {
      const item = items[hover];
      title = item.label;
      sub = item.detail ? `${item.detail}  ·  RELEASE` : 'RELEASE';
      cooling = !!item.cooling;
    } else {
      const cur = items.find((it) => it.id === activeId);
      if (cur) title = cur.label;
    }
    labelEl.textContent = title;
    subEl.textContent = sub;
    subEl.classList.toggle('cooling', cooling);
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    cx = cy = 0;
    hover = -1;
    blinking = false;
    blinkIndex = -1;
    root.classList.remove('hidden');
    wheel.classList.remove('in');
    void wheel.offsetWidth;
    wheel.classList.add('in');
    placeCursor();
    paint();
  }

  function close() {
    if (!isOpen && !blinking) {
      root.classList.add('hidden');
      return;
    }
    isOpen = false;
    blinking = false;
    blinkIndex = -1;
    hover = -1;
    root.classList.add('hidden');
  }

  function confirm(index) {
    blinkIndex = index;
    hover = index;
    blinking = true;
    blinkT = BLINK;
    paint();
    onSelect(items[index]);
  }

  rebuild();

  return {
    get isOpen() { return isOpen; },
    toggle() { if (isOpen) close(); else open(); },
    open,
    close,
    /** Highlighted slice, or close if the cursor is still in the hole. */
    release() {
      if (!isOpen || blinking) return;
      if (hover >= 0 && !items[hover].cooling) confirm(hover);
      else close();
    },
    add(item) {
      if (!item?.id || items.some((it) => it.id === item.id)) return;
      items.push(normalize(item));
      rebuild();
    },
    remove(id) {
      const next = items.filter((it) => it.id !== id);
      if (next.length === items.length) return;
      items = next;
      rebuild();
    },
    setItems(list) {
      items = (list || []).map(normalize);
      rebuild();
    },
    setActive(id) {
      if (activeId === id) return;
      activeId = id;
      if (isOpen) paint();
    },
    /** @param {Record<string, { text?: string, cooling?: boolean }>} map */
    setDetails(map) {
      let changed = false;
      for (const item of items) {
        const d = map[item.id];
        if (!d) continue;
        const text = d.text || '';
        const cooling = !!d.cooling;
        if (item.detail !== text || item.cooling !== cooling) {
          item.detail = text;
          item.cooling = cooling;
          changed = true;
        }
      }
      if (changed && isOpen) paint();
    },
    /** Stick, −1..1, y-down. Absolute, so a held direction stays on that slice. */
    pointAt(x, y) {
      if (!isOpen || blinking) return;
      const mag = Math.hypot(x, y);
      const reach = R_OUT - 16;
      if (mag < 1e-4) {
        cx = cy = 0;
      } else {
        cx = (x / mag) * reach;
        cy = (y / mag) * reach;
      }
      hover = sliceAt(cx, cy, items.length, R_IN);
      placeCursor();
      paint();
    },
    /** Pixel deltas from the locked pointer. Highlight follows; release confirms. */
    pointer(dx, dy) {
      if (!isOpen || blinking) return;
      const rect = wheel.getBoundingClientRect();
      const k = rect.width > 0 ? SIZE / rect.width : 1;
      cx += dx * k;
      cy += dy * k;
      const mag = Math.hypot(cx, cy);
      const max = R_OUT - 10;
      if (mag > max) {
        cx = (cx / mag) * max;
        cy = (cy / mag) * max;
      }
      hover = sliceAt(cx, cy, items.length, R_IN);
      placeCursor();
      paint();
    },
    update(dt) {
      if (!blinking) return;
      blinkT -= dt;
      if (blinkT <= 0) close();
    },
  };
}
