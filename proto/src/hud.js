// Health bars (bottom-left), hit-rate (stress + smoke), active gadget, round banner, hit flash.
export const GADGETS = [
  { id: 'smoke', key: '1', label: 'SMOKE' },
  { id: 'air', key: '2', label: 'AIR SUPPORT' },
  { id: 'repair', key: '3', label: 'REPAIR' },
];

export function createHud() {
  const root = document.createElement('div');
  root.id = 'hud';
  root.innerHTML = `
    <div class="hp" data-who="player"><span>YOU</span><div class="hp-bar"><i></i></div><b>100%</b></div>
    <div class="repair hidden" data-who="repair"><span>REPAIRING</span><div class="repair-bar"><i></i></div><b>5.0s</b></div>
    <div class="hit hidden" data-who="player-hit"><span>HIT</span><div class="hit-bar"><i></i></div><b>100%</b></div>
    <div class="nitro" data-who="nitro"><span>NITRO</span><div class="nitro-bar"><i></i></div><b>100%</b></div>
    <div class="reload hidden" data-who="reload"><span>RELOAD</span><div class="reload-bar"><i></i></div><b>0.0s</b></div>
    <div class="overheat hidden" data-who="overheat"><span>HEAT</span><div class="overheat-bar"><i></i></div><b>0.0s</b></div>
    <div class="gadget" data-who="gadget"><span>GADGET</span><b>1 SMOKE</b></div>
    <div class="pickup" data-who="pickup"><span>PICKUP IN</span><b>2:00</b></div>
    <div class="hp enemy" data-who="enemy"><span>ENEMY</span><div class="hp-bar"><i></i></div><b>100%</b></div>
    <div class="hp enemy" data-who="enemy2"><span>ENEMY 2</span><div class="hp-bar"><i></i></div><b>100%</b></div>
    <div class="hit hidden" data-who="enemy-hit"><span>HIT</span><div class="hit-bar"><i></i></div><b>100%</b></div>
    <div class="ai-debug hidden"></div>`;
  const banner = document.createElement('div');
  banner.id = 'banner';
  banner.className = 'hidden';
  const BANNER_FADE = 0.4;
  let bannerTimer = null; // { t, fading } while a callout should dismiss itself
  const flash = document.createElement('div');
  flash.id = 'hit-flash';
  const dirRoot = document.createElement('div');
  dirRoot.id = 'hit-dirs';
  document.body.append(root, banner, flash, dirRoot);

  // Directional hit markers: a red arc around the screen centre, turned toward the shooter.
  // Kept as world positions so they keep pointing the right way while you turn.
  const HIT_DIR_LIFE = 2.6;
  const ARC_R = 150, ARC_HALF = 0.42;
  const ax = (a, r = ARC_R) => (Math.sin(a) * r).toFixed(1);
  const ay = (a, r = ARC_R) => (-Math.cos(a) * r).toFixed(1);
  const arcSvg = `<svg viewBox="-200 -200 400 400">
    <path class="arc" d="M${ax(-ARC_HALF)} ${ay(-ARC_HALF)} A${ARC_R} ${ARC_R} 0 0 1 ${ax(ARC_HALF)} ${ay(ARC_HALF)}"/>
    <path class="tip" d="M-11 ${-ARC_R - 9} L0 ${-ARC_R - 26} L11 ${-ARC_R - 9} Z"/></svg>`;
  const hitDirs = [];

  const rows = {
    player: root.querySelector('[data-who="player"]'),
    enemies: [...root.querySelectorAll('.hp.enemy')],
    nitro: root.querySelector('[data-who="nitro"]'),
    reload: root.querySelector('[data-who="reload"]'),
    overheat: root.querySelector('[data-who="overheat"]'),
    gadget: root.querySelector('[data-who="gadget"]'),
    pickup: root.querySelector('[data-who="pickup"]'),
    repair: root.querySelector('[data-who="repair"]'),
    playerHit: root.querySelector('[data-who="player-hit"]'),
    enemyHit: root.querySelector('[data-who="enemy-hit"]'),
  };
  const debug = root.querySelector('.ai-debug');

  function setBar(row, frac) {
    const pct = Math.round(Math.max(0, frac) * 100);
    row.querySelector('i').style.width = `${pct}%`;
    row.querySelector('b').textContent = `${pct}%`;
    row.classList.toggle('hurt', pct > 0 && pct < 100);
    row.classList.toggle('dead', pct <= 0);
  }

  /** Hit rate 0..1 (stress + smoke). Hidden at 100%. */
  function setHitRow(row, frac, inSmoke = false) {
    const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
    const on = pct < 100;
    row.classList.toggle('hidden', !on);
    row.classList.toggle('smoke', on && inSmoke);
    if (!on) return;
    row.querySelector('i').style.width = `${pct}%`;
    row.querySelector('b').textContent = `${pct}%`;
  }

  return {
    setHealth(player, enemy) {
      setBar(rows.player, player);
      const list = Array.isArray(enemy) ? enemy : (enemy == null ? [] : [enemy]);
      rows.enemies.forEach((row, i) => {
        if (i < list.length) setBar(row, list[i]);
      });
    },
    /**
     * Effective direct-hit rate 0..1 (1 − stress miss − smoke miss).
     * Hidden while at 100% so the meter only appears when aim is degraded.
     * `*Smoke` tints the meter grey when the smoke penalty is active.
     */
    setHitRate(player, enemy, playerSmoke = false, enemySmoke = false) {
      setHitRow(rows.playerHit, player, playerSmoke);
      setHitRow(rows.enemyHit, enemy ?? 1, enemySmoke);
    },
    /**
     * Roof-gun heat 0..1. Hidden when cold.
     * While firing, the number is seconds until cook-off. While locked, seconds of cooldown left.
     */
    setOverheat(heat, lock, heatTime, firing = false) {
      const row = rows.overheat;
      const on = heat > 0.03 || lock > 0.05;
      row.classList.toggle('hidden', !on);
      row.classList.toggle('locked', lock > 0.05);
      if (!on) return;
      row.querySelector('i').style.width = `${Math.round(Math.max(0, Math.min(1, heat)) * 100)}%`;
      if (lock > 0.05) {
        row.querySelector('span').textContent = 'COOL';
        row.querySelector('b').textContent = `${lock.toFixed(1)}s`;
      } else if (firing) {
        row.querySelector('span').textContent = 'HEAT';
        row.querySelector('b').textContent = `${Math.max(0, (1 - heat) * heatTime).toFixed(1)}s`;
      } else {
        row.querySelector('span').textContent = 'HEAT';
        row.querySelector('b').textContent = `${Math.round(heat * 100)}%`;
      }
    },
    /** Seconds left on the main gun. Hidden when the gun is ready. */
    setReload(remaining, total) {
      const on = remaining > 0.05 && total > 0;
      rows.reload.classList.toggle('hidden', !on);
      if (!on) return;
      const ready = 1 - remaining / total;
      rows.reload.querySelector('i').style.width = `${Math.round(Math.max(0, ready) * 100)}%`;
      rows.reload.querySelector('b').textContent = `${remaining.toFixed(1)}s`;
    },
    setNitro(frac, active = false) {
      const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
      rows.nitro.querySelector('i').style.width = `${pct}%`;
      rows.nitro.querySelector('b').textContent = `${pct}%`;
      rows.nitro.classList.toggle('empty', pct <= 0);
      rows.nitro.classList.toggle('active', !!active);
    },
    /** Seconds until the next supply drop. Shown as m:ss. */
    setPickup(seconds) {
      const s = Math.max(0, Math.ceil(seconds));
      const m = Math.floor(s / 60);
      const r = s % 60;
      rows.pickup.querySelector('b').textContent = `${m}:${String(r).padStart(2, '0')}`;
    },
    /**
     * Active gadget slot (1 smoke / 2 air / 3 repair).
     * Repair shows charges left, or REPAIRING plus the channel timer.
     * @param {'smoke'|'air'|'repair'} id
     * @param {number} [cd=0]
     * @param {{ repairing?: boolean, repairLeft?: number, charges?: number }|null} [info]
     */
    setGadget(id, cd = 0, info = null) {
      const g = GADGETS.find((x) => x.id === id) || GADGETS[0];
      const repairing = id === 'repair' && !!info?.repairing;
      const empty = id === 'repair' && !repairing && (info?.charges ?? 0) <= 0;
      const cooling = !repairing && (cd > 0.05 || empty);
      let text;
      if (repairing) text = `REPAIRING  ${info.repairLeft.toFixed(1)}s`;
      else if (id === 'repair') text = `${g.key} ${g.label}  ×${info?.charges ?? 0}`;
      else text = cooling ? `${g.key} ${g.label}  ${cd.toFixed(1)}s` : `${g.key} ${g.label}`;
      rows.gadget.querySelector('b').textContent = text;
      rows.gadget.classList.toggle('cooling', cooling);
      rows.gadget.classList.toggle('repairing', repairing);
    },
    /** Repair channel. Hidden when idle. Bar fills over `total` seconds; label stays REPAIRING. */
    setRepair(remaining, total) {
      const on = remaining > 0.02 && total > 0;
      rows.repair.classList.toggle('hidden', !on);
      if (!on) return;
      const done = 1 - remaining / total;
      rows.repair.querySelector('i').style.width = `${Math.round(Math.max(0, Math.min(1, done)) * 100)}%`;
      rows.repair.querySelector('b').textContent = `${remaining.toFixed(1)}s`;
    },
    showEnemy(on) {
      for (const row of rows.enemies) row.classList.toggle('hidden', !on);
      if (!on) rows.enemyHit.classList.add('hidden');
    },
    /**
     * Round callout. `hold` > 0 dismisses itself (remaining-enemy notices);
     * 0 stays up until the next banner() (win / lose).
     */
    banner(title, sub = '', tone = 'win', hold = 0) {
      banner.classList.remove('in', 'out', 'win', 'lose');
      bannerTimer = null;
      if (!title) {
        banner.classList.add('hidden');
        banner.innerHTML = '';
        return;
      }
      banner.classList.remove('hidden');
      banner.classList.add(tone === 'lose' ? 'lose' : 'win');
      banner.innerHTML = `<div class="banner-inner"><strong>${title}</strong>${sub ? `<span>${sub}</span>` : ''}</div>`;
      void banner.offsetWidth;
      banner.classList.add('in');
      if (hold > 0) bannerTimer = { t: hold, fading: false };
    },
    flash() {
      flash.classList.remove('on');
      void flash.offsetWidth;   // restart the CSS animation
      flash.classList.add('on');
    },
    /** Show where a hit came from (world-space source position). */
    hitFrom(pos) {
      let h = hitDirs.find((d) => Math.hypot(d.x - pos.x, d.z - pos.z) < 8);
      if (!h) {
        if (hitDirs.length >= 4) hitDirs.shift().el.remove();
        const el = document.createElement('div');
        el.className = 'hit-dir';
        el.innerHTML = arcSvg;
        dirRoot.append(el);
        h = { el };
        hitDirs.push(h);
      }
      Object.assign(h, { x: pos.x, z: pos.z, t: HIT_DIR_LIFE });
    },
    /** Per frame: re-aim the markers relative to the camera's heading and fade them out. */
    update(dt, camera) {
      if (bannerTimer) {
        bannerTimer.t -= dt;
        if (!bannerTimer.fading && bannerTimer.t <= 0) {
          banner.classList.remove('in');
          banner.classList.add('out');
          bannerTimer.fading = true;
          bannerTimer.t = BANNER_FADE + bannerTimer.t;
        }
        if (bannerTimer?.fading && bannerTimer.t <= 0) {
          bannerTimer = null;
          banner.classList.add('hidden');
          banner.classList.remove('out', 'win', 'lose');
          banner.innerHTML = '';
        }
      }
      if (!hitDirs.length) return;
      const e = camera.matrixWorld.elements;
      const fx = -e[8], fz = -e[10], fl = Math.hypot(fx, fz) || 1;
      const cx = e[12], cz = e[14];
      for (let i = hitDirs.length - 1; i >= 0; i--) {
        const h = hitDirs[i];
        h.t -= dt;
        if (h.t <= 0) { h.el.remove(); hitDirs.splice(i, 1); continue; }
        const vx = h.x - cx, vz = h.z - cz;
        const ahead = (vx * fx + vz * fz) / fl, right = (vx * -fz + vz * fx) / fl;
        h.el.style.transform = `translate(-50%, -50%) rotate(${Math.atan2(right, ahead)}rad)`;
        h.el.style.opacity = Math.min(1, h.t / 0.8).toFixed(3);
      }
    },
    clearHits() {
      for (const h of hitDirs) h.el.remove();
      hitDirs.length = 0;
    },
    debug(text) {
      debug.classList.toggle('hidden', !text);
      if (text) debug.textContent = text;
    },
  };
}
