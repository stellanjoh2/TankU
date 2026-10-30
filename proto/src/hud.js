// Health bars (bottom-left), hit-rate (stress + smoke), turret compass, hit flash.
// Round callouts live in messages.js.
export function createHud() {
  const root = document.createElement('div');
  root.id = 'hud';
  root.innerHTML = `
    <div class="hp" data-who="player"><span>YOU</span><div class="hp-bar"><i></i></div><b>100%</b></div>
    <div class="repair hidden" data-who="repair"><span>REPAIRING</span><div class="repair-bar"><i></i></div><b>5.0s</b></div>
    <div class="hit hidden" data-who="player-hit"><span>HIT</span><div class="hit-bar"><i></i></div><b>100%</b></div>
    <div class="nitro" data-who="nitro"><span>NITRO</span><div class="nitro-bar"><i></i></div><b>100%</b></div>
    <div class="weapon" data-who="weapon"><span>GUN</span><b>MAIN GUN</b></div>
    <div class="reload hidden" data-who="reload"><span>RELOAD</span><div class="reload-bar"><i></i></div><b>0.0s</b></div>
    <div class="overheat hidden" data-who="overheat"><span>HEAT</span><div class="overheat-bar"><i></i></div><b>0.0s</b></div>
    <div id="turret-compass" aria-hidden="true">
      <svg viewBox="0 0 80 80">
        <circle class="ring" cx="40" cy="40" r="36"/>
        <g class="hull">
          <path d="M40 12 L54 36 L47 36 L47 58 L33 58 L33 36 L26 36 Z"/>
        </g>
        <g class="turret">
          <path class="barrel" d="M38 40 L38 14 L40 8 L42 14 L42 40 Z"/>
          <circle class="cupola" cx="40" cy="40" r="9"/>
        </g>
        <circle class="tick" cx="40" cy="6" r="2.2"/>
      </svg>
    </div>
    <div class="ai-debug hidden"></div>`;
  const flash = document.createElement('div');
  flash.id = 'hit-flash';
  const dirRoot = document.createElement('div');
  dirRoot.id = 'hit-dirs';
  const compass = root.querySelector('#turret-compass');
  const turretNeedle = compass.querySelector('.turret');
  document.body.append(root, flash, dirRoot);

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
    nitro: root.querySelector('[data-who="nitro"]'),
    weapon: root.querySelector('[data-who="weapon"]'),
    reload: root.querySelector('[data-who="reload"]'),
    overheat: root.querySelector('[data-who="overheat"]'),
    repair: root.querySelector('[data-who="repair"]'),
    playerHit: root.querySelector('[data-who="player-hit"]'),
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
    /** Photomode / pause: hide bars, compass, and hit markers. */
    setVisible(on) {
      root.classList.toggle('hidden', !on);
      flash.classList.toggle('chrome-off', !on);
      dirRoot.classList.toggle('chrome-off', !on);
    },
    setHealth(player) {
      setBar(rows.player, player);
    },
    /**
     * Effective direct-hit rate 0..1 (1 − stress miss − smoke miss).
     * Hidden while at 100% so the meter only appears when aim is degraded.
     * `inSmoke` tints the meter grey when the smoke penalty is active.
     */
    setHitRate(player, _enemy, playerSmoke = false) {
      setHitRow(rows.playerHit, player, playerSmoke);
    },
    /** Turret yaw relative to hull (rad). Hull stays fixed; needle rotates. */
    setTurretYaw(yaw, visible = true) {
      compass.classList.toggle('hidden', !visible);
      if (!visible) return;
      // Three +Y is CCW from above; SVG +rotate is CW — negate so left stays left.
      const deg = (-yaw * 180) / Math.PI;
      turretNeedle.setAttribute('transform', `rotate(${deg} 40 40)`);
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
    /** Selected main gun, written out. `id` is `cannon` or `mg`. */
    setWeapon(label, id) {
      rows.weapon.querySelector('b').textContent = label;
      rows.weapon.classList.toggle('mg', id === 'mg');
    },
    setNitro(frac, active = false) {
      const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
      rows.nitro.querySelector('i').style.width = `${pct}%`;
      rows.nitro.querySelector('b').textContent = `${pct}%`;
      rows.nitro.classList.toggle('empty', pct <= 0);
      rows.nitro.classList.toggle('active', !!active);
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
