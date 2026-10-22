// Health bars (bottom-left), round banner, hit flash and an optional AI debug readout.
export function createHud() {
  const root = document.createElement('div');
  root.id = 'hud';
  root.innerHTML = `
    <div class="hp" data-who="player"><span>YOU</span><div class="hp-bar"><i></i></div><b>100%</b></div>
    <div class="hp enemy" data-who="enemy"><span>ENEMY</span><div class="hp-bar"><i></i></div><b>100%</b></div>
    <div class="ai-debug hidden"></div>`;
  const banner = document.createElement('div');
  banner.id = 'banner';
  banner.className = 'hidden';
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
    enemy: root.querySelector('[data-who="enemy"]'),
  };
  const debug = root.querySelector('.ai-debug');

  function setBar(row, frac) {
    const pct = Math.round(Math.max(0, frac) * 100);
    row.querySelector('i').style.width = `${pct}%`;
    row.querySelector('b').textContent = `${pct}%`;
    row.classList.toggle('hurt', pct > 0 && pct < 100);
    row.classList.toggle('dead', pct <= 0);
  }

  return {
    setHealth(player, enemy) {
      setBar(rows.player, player);
      if (enemy != null) setBar(rows.enemy, enemy);
    },
    showEnemy(on) { rows.enemy.classList.toggle('hidden', !on); },
    banner(title, sub = '') {
      banner.classList.toggle('hidden', !title);
      banner.innerHTML = title ? `<strong>${title}</strong><span>${sub}</span>` : '';
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
