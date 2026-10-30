// Typographic callouts — big layered impact headlines + small toasts.
// Big entry mirrors Ultrapilled logotype reveal (stacked colour wipe + letter drop + scale settle).

const REVEAL_MASK_S = 0.3;
const REVEAL_STAGGER_S = 0.25;
const GLYPH_RISE_S = 0.5;
const GLYPH_DROP_PX = 72;
const GROUP_Y_PX = 48;
const OUT_S = 0.55;
const SCALE_FROM = 1.125; // was 1.25; half the settle range again
const SCALE_TO = 1;
const SMALL_HOLD = 2.6;
const SMALL_FADE = 0.35;

/** Enter window: staggered layer wipe + letter wave. */
function revealDurationS(charCount) {
  const wipe = REVEAL_STAGGER_S + REVEAL_MASK_S;
  if (charCount <= 1) return Math.max(wipe, GLYPH_RISE_S);
  const wave = GLYPH_RISE_S + (charCount - 1) * Math.min(0.045, (wipe - 0.15) / (charCount - 1));
  return Math.max(wipe, wave);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Per-glyph spans for the letter drop wave. Words stay atomic so flex wrap never splits them. */
function charsHtml(text) {
  let i = 0;
  return String(text).split(/(\s+)/).map((token) => {
    if (/^\s+$/.test(token)) return '<span class="msg-space"> </span>';
    const letters = [...token].map((ch) => {
      const html = `<span class="msg-char" style="--i:${i}"><i>${escapeHtml(ch)}</i></span>`;
      i += 1;
      return html;
    }).join('');
    return `<span class="msg-word">${letters}</span>`;
  }).join('');
}

function layerHtml(text) {
  return `<div class="msg-big__chars">${charsHtml(text)}</div>`;
}

function glyphCount(text) {
  return [...String(text)].filter((c) => c !== ' ').length;
}

export function createMessages() {
  const root = document.createElement('div');
  root.id = 'messages';
  root.innerHTML = `
    <div class="msg-big hidden" aria-live="assertive">
      <div class="msg-big__group">
        <div class="msg-big__scale">
          <div class="msg-big__layer msg-big__layer--flash"></div>
          <div class="msg-big__layer msg-big__layer--mid"></div>
          <div class="msg-big__layer msg-big__layer--final"></div>
        </div>
      </div>
      <div class="msg-big__sub"></div>
    </div>
    <div class="msg-small hidden" aria-live="polite"></div>`;
  document.body.append(root);

  const bigEl = root.querySelector('.msg-big');
  const groupEl = root.querySelector('.msg-big__group');
  const scaleEl = root.querySelector('.msg-big__scale');
  const layers = {
    flash: root.querySelector('.msg-big__layer--flash'),
    mid: root.querySelector('.msg-big__layer--mid'),
    final: root.querySelector('.msg-big__layer--final'),
  };
  const subEl = root.querySelector('.msg-big__sub');
  const smallEl = root.querySelector('.msg-small');

  /** @type {null | { phase: 'in'|'hold'|'out', t: number, hold: number, inS: number, onDone: null | (() => void) }} */
  let big = null;
  /** @type {null | { phase: 'in'|'hold'|'out', t: number, hold: number }} */
  let small = null;
  /** Queued small toast after the current big finishes its out. */
  let pendingSmall = null;

  function setScale(p) {
    const s = SCALE_FROM + (SCALE_TO - SCALE_FROM) * p;
    scaleEl.style.transform = `scale(${s})`;
  }

  function setGroupY(y) {
    groupEl.style.transform = `translateY(${y}px)`;
  }

  function hideBig() {
    big = null;
    bigEl.classList.add('hidden');
    bigEl.classList.remove('in', 'out', 'hold', 'win', 'lose');
    for (const el of Object.values(layers)) el.innerHTML = '';
    subEl.textContent = '';
    subEl.classList.add('hidden');
    scaleEl.style.transform = '';
    groupEl.style.transform = '';
  }

  function hideSmall() {
    small = null;
    smallEl.classList.add('hidden');
    smallEl.classList.remove('in', 'hold', 'out');
    smallEl.textContent = '';
  }

  function flushPendingSmall() {
    const next = pendingSmall;
    pendingSmall = null;
    if (next) showSmall(next.text, next.hold);
  }

  function showSmall(text, hold = SMALL_HOLD) {
    if (!text) { hideSmall(); return; }
    smallEl.textContent = text;
    smallEl.classList.remove('hidden', 'hold', 'out');
    void smallEl.offsetWidth;
    smallEl.classList.add('in');
    small = { phase: 'in', t: 0.28, hold };
  }

  /**
   * Big impact headline. `hold` ≤ 0 stays until clear() / next big().
   * `thenSmall` queues a toast that plays after this message animates out.
   */
  function showBig(title, {
    sub = '',
    tone = 'win',
    hold = 2.2,
    thenSmall = null,
    onDone = null,
  } = {}) {
    pendingSmall = thenSmall ? { text: thenSmall, hold: SMALL_HOLD } : null;
    if (!title) {
      hideBig();
      flushPendingSmall();
      onDone?.();
      return;
    }

    // Big owns the screen — dismiss any live toast so layers don't stack.
    hideSmall();

    const html = layerHtml(title);
    layers.flash.innerHTML = html;
    layers.mid.innerHTML = html;
    layers.final.innerHTML = html;
    const n = glyphCount(title);
    const inS = revealDurationS(n);
    bigEl.style.setProperty('--msg-chars', String(Math.max(1, n)));
    bigEl.style.setProperty('--msg-in', `${inS}s`);
    bigEl.style.setProperty('--msg-glyph-each', n > 1
      ? `${Math.min(0.045, (inS - GLYPH_RISE_S) / (n - 1))}s`
      : '0s');

    subEl.textContent = sub || '';
    subEl.classList.toggle('hidden', !sub);

    bigEl.classList.remove('hidden', 'in', 'out', 'hold', 'win', 'lose');
    bigEl.classList.add(tone === 'lose' ? 'lose' : 'win');
    setScale(0);
    setGroupY(-GROUP_Y_PX);
    void bigEl.offsetWidth;
    bigEl.classList.add('in');
    big = { phase: 'in', t: inS, hold, inS, onDone };
  }

  function beginBigOut() {
    if (!big || big.phase === 'out') return;
    bigEl.classList.remove('in', 'hold');
    bigEl.classList.add('out');
    big.phase = 'out';
    big.t = OUT_S;
  }

  return {
    /**
     * Layered impact callout (kills, death, round clear, objective).
     * @param {string|null} title
     * @param {{ sub?: string, tone?: 'win'|'lose', hold?: number, thenSmall?: string|null, onDone?: (() => void)|null }} [opts]
     */
    big: showBig,

    /** Compact toast (supply drop, enemies remaining, …). */
    small(text, hold = SMALL_HOLD) {
      // If a big is still playing, wait for it so remaining-count etc. never fights the headline.
      if (big && text) {
        pendingSmall = { text, hold };
        return;
      }
      showSmall(text, hold);
    },

    clear() {
      pendingSmall = null;
      hideBig();
      hideSmall();
    },

    setVisible(on) {
      root.classList.toggle('chrome-off', !on);
    },

    update(dt) {
      if (big) {
        const totalHold = Math.max(0, big.hold);
        const span = big.inS + (totalHold > 0 ? totalHold : 0) + (totalHold > 0 ? OUT_S : 0);
        // Scale settle across in + hold (+ out when auto-dismissing). Sticky banners ease during in only.
        if (big.phase === 'in' || big.phase === 'hold') {
          const elapsed = big.phase === 'in'
            ? big.inS - big.t
            : big.inS + (totalHold > 0 ? totalHold - big.t : 0);
          const scaleSpan = totalHold > 0 ? big.inS + totalHold : big.inS;
          setScale(Math.min(1, Math.max(0, elapsed / Math.max(0.01, scaleSpan))));
        } else if (big.phase === 'out' && span > 0) {
          setScale(1);
        }

        if (big.phase === 'in') {
          const u = 1 - big.t / big.inS;
          setGroupY(-GROUP_Y_PX * (1 - u) * (1 - u)); // ease toward 0
          big.t -= dt;
          if (big.t <= 0) {
            bigEl.classList.remove('in');
            bigEl.classList.add('hold');
            setGroupY(0);
            if (totalHold > 0) {
              big.phase = 'hold';
              big.t = totalHold;
            } else {
              big.phase = 'hold';
              big.t = Infinity; // sticky until clear / next big
            }
          }
        } else if (big.phase === 'hold') {
          if (big.t !== Infinity) {
            big.t -= dt;
            if (big.t <= 0) beginBigOut();
          }
        } else if (big.phase === 'out') {
          big.t -= dt;
          if (big.t <= 0) {
            const done = big.onDone;
            hideBig();
            flushPendingSmall();
            done?.();
          }
        }
      }

      if (!small) return;
      if (small.phase === 'in') {
        small.t -= dt;
        if (small.t <= 0) {
          smallEl.classList.remove('in');
          smallEl.classList.add('hold');
          small.phase = 'hold';
          small.t = small.hold;
        }
      } else if (small.phase === 'hold') {
        small.t -= dt;
        if (small.t <= 0) {
          smallEl.classList.remove('hold');
          smallEl.classList.add('out');
          small.phase = 'out';
          small.t = SMALL_FADE;
        }
      } else if (small.phase === 'out') {
        small.t -= dt;
        if (small.t <= 0) hideSmall();
      }
    },
  };
}
