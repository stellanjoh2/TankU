// Round lifecycle + combat resolution (shell / MG hits → HP → wreck → auto-restart).
import * as THREE from 'three';
import { RELOAD, MG_DAMAGE } from './tank.js';
import { pickSpawn } from './ai.js';
import { distGain } from './sfx.js';

export const MIN_SPAWN_GAP = 75;        // metres between the two tanks at round start
const ROUND_RESTART_DELAY = 4;          // seconds the wreck burns before the next round
const BARREL_BLAST_FULL = 3;            // m from a fuel drum blast: 1 HP (same as a shell hit)
const BARREL_BLAST_EDGE = 5.5;          // m: chip damage out to here
const SOLO_KEY = 'sherman.solo';

/**
 * @param {object} deps
 * @param {() => void} [deps.onRestart]  main resets look / cam / path / freefly after entity reset
 */
export function createMatch({
  tank, enemy, ai, nav, fx, hud, sfx, tankCam, input,
  vegetation, airfield, port, waterTower, barrels, spawn,
  onRestart = () => {},
}) {
  const game = {
    solo: localStorage.getItem(SOLO_KEY) === '1',
    showPath: false,
    debug: false,
    overT: 0,          // > 0 while a wreck burns before the auto-restart
    wreck: null,       // the destroyed tank
  };

  function restart({ resetCam = true } = {}) {
    tank.respawn(spawn);
    fx.clearShells();
    barrels.reset();
    nav.setObstacles([   // palm slider may have changed
      ...vegetation.navObstacles(), ...airfield.navObstacles(),
      ...port.navObstacles(), ...waterTower.navObstacles(),
    ]);
    enemy.setActive(!game.solo);
    if (!game.solo) {
      enemy.respawn(pickSpawn(nav, spawn, MIN_SPAWN_GAP));
      ai.reset();
    }
    game.overT = 0;
    game.wreck = null;
    hud.banner(null);
    hud.clearHits();
    hud.showEnemy(!game.solo);
    hud.setHealth(1, 1);
    hud.setNitro(1, false);
    onRestart({ resetCam });
  }

  function setSolo(v) {
    game.solo = v;
    localStorage.setItem(SOLO_KEY, v ? '1' : '0');
    restart({ resetCam: false });
  }

  function onTankDestroyed(victim, hit = {}) {
    const origin = new THREE.Vector3().copy(victim.body.translation()).add(new THREE.Vector3(0, 1.2, 0));
    fx.wreck(origin);
    victim.obliterate({
      point: hit.point ? new THREE.Vector3().copy(hit.point) : origin,
      dir: hit.dir ? new THREE.Vector3().copy(hit.dir) : undefined,
    });
    tankCam.addShake(victim === tank ? 1 : 0.4);
    game.overT = ROUND_RESTART_DELAY;
    game.wreck = victim;
    hud.banner(
      victim === tank ? 'YOU WERE DESTROYED' : 'ENEMY DESTROYED',
      'next round in a moment',
      victim === tank ? 'lose' : 'win',
    );
  }

  /** Fuel-drum blast: full shell hit point-blank, a graze further out. */
  function onBarrelExplode(point) {
    sfx.fire(distGain(point.distanceTo(tank.model.position), 160));
    if (game.overT > 0) return;
    for (const victim of [tank, enemy]) {
      if (!victim.alive || (victim === enemy && game.solo) || game.overT > 0) continue;
      const d = point.distanceTo(victim.body.translation());
      const dmg = d < BARREL_BLAST_FULL ? 1 : d < BARREL_BLAST_EDGE ? 0.35 : 0;
      if (!dmg) continue;
      victim.hp = Math.max(0, victim.hp - dmg);
      if (victim === tank) {
        hud.flash();
        input.rumble(1, 1, 450);
      } else if (victim.alive) {
        victim.flashHit();
      }
      hud.setHealth(tank.hp / tank.maxHp, enemy.hp / enemy.maxHp);
      if (!victim.alive) onTankDestroyed(victim, { point });
    }
  }

  function wireFx() {
    fx.onImpact = (p) => {
      barrels.blastAt(p);
      const d = p.distanceTo(tank.model.position);
      if (d < 40) {
        input.rumble(0.6 * (1 - d / 40), 0.3, 160);
        tankCam.addShake(0.45 * (1 - d / 40));
      }
    };
    barrels.onExplode = onBarrelExplode;
    fx.onMgShot = ({ owner } = {}) => {
      if (owner === tank.body) tankCam.pulseMgShake();
    };

    fx.onShellHit = ({ collider, owner, point, dir }) => {
      const body = collider?.parent();
      if (!body || game.overT > 0) return;
      const victim = [tank, enemy].find((t) => t.body.handle === body.handle);
      if (!victim || victim.body === owner || !victim.alive) return;
      victim.hp -= 1;
      // Clank at the impact — audible ~140 m, squared falloff (no distant floor)
      {
        const d = (point ?? victim.model.position).distanceTo(tank.model.position);
        sfx.hit(distGain(d, 140));
      }
      if (victim === tank) {
        hud.flash();
        if (owner) hud.hitFrom(owner.translation());
        if (owner === enemy.body) ai.onScored();
        input.rumble(1, 1, 450);
        // Same fire-kick envelope, shoved along the shell's travel (away from where it came)
        tankCam.kick(1.0, RELOAD, dir);
      } else {
        if (victim.alive) victim.flashHit();
        ai.onHit();
      }
      hud.setHealth(tank.hp / tank.maxHp, enemy.hp / enemy.maxHp);
      if (!victim.alive) onTankDestroyed(victim, { point, dir });
    };

    // Traced .50 hits: metal ricochet SFX (body.userData.mat === 'metal') + chip damage on tanks.
    fx.onMgHit = ({ collider, owner, point, dir }) => {
      const body = collider?.parent();
      if (!body || game.overT > 0) return;
      const victim = [tank, enemy].find((t) => t.body.handle === body.handle);
      const isTank = !!victim && victim.body !== owner && victim.alive;
      const isMetal = body.userData?.mat === 'metal';
      if (!isTank && !isMetal) return;

      // Local impact SFX — fades by ~90 m (was linear to 180 m with a 0.12 floor).
      sfx.ricochet(distGain(point.distanceTo(tank.model.position), 90));

      if (!isTank) {
        barrels.mgHit(body);
        return;
      }
      const wasAlive = victim.alive;
      victim.hp = Math.max(0, victim.hp - MG_DAMAGE);
      if (victim === tank) {
        if (owner) hud.hitFrom(owner.translation());
        input.rumble(0.08, 0.18, 40);
      }
      hud.setHealth(tank.hp / tank.maxHp, enemy.hp / enemy.maxHp);
      if (wasAlive && !victim.alive) {
        if (victim === tank && owner === enemy.body) ai.onScored();
        if (victim === enemy) ai.onHit();
        onTankDestroyed(victim, { point, dir });
      }
    };
  }

  function tick(dt) {
    if (game.overT <= 0) return;
    game.overT -= dt;
    if (game.overT <= 0) restart({ resetCam: false });
  }

  return { game, restart, tick, setSolo, wireFx };
}
