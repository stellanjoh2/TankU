// Round lifecycle + combat resolution (shell / MG hits → HP → wreck → auto-restart).
import * as THREE from 'three';
import { MG_DAMAGE } from './tank.js';
import { pickSpawn } from './ai.js';
import { distGain } from './sfx.js';

const ROUND_RESTART_DELAY = 4;          // seconds the wreck burns before the next round
const REMAIN_HOLD = 2.6;                // seconds "N ENEMIES REMAINING" stays up
const BARREL_BLAST_FULL = 3;            // m from a fuel drum blast: 1 HP (same as a shell hit)
const BARREL_BLAST_EDGE = 5.5;          // m: chip damage out to here
const SOLO_KEY = 'sherman.solo';
const HULL_FRONT_X = 1.4;               // local +X is forward; past this is the front plate
const HULL_REAR_X = -1.5;               // engine bay
const FRONT_DMG = 0.75;
const REAR_DMG = 1.25;
const STRESS_PER_SHELL = 55;           // side hit; scaled by shellDamage (rear hits harder)
const HIT_KICK_RETURN = 2;             // s, camera shove when a shell hits you
const MG_FLYBY_MAX = 9;               // m miss distance that still whooshes
const MG_TRACER_SPEED = 220 * 0.75;    // keep in sync with fx.js tracer travel

const _hitP = new THREE.Vector3();
const _hitQ = new THREE.Quaternion();
const _flybyEar = new THREE.Vector3();
const _flybyTo = new THREE.Vector3();
const _flybyClosest = new THREE.Vector3();

/** Front plate takes 25% less, a hit in the engine 25% more. Side and turret stay at 1. */
function shellDamage(victim, point) {
  if (!point) return 1;
  const t = victim.body.translation();
  _hitQ.copy(victim.body.rotation()).invert();
  _hitP.set(point.x - t.x, point.y - t.y, point.z - t.z).applyQuaternion(_hitQ);
  if (_hitP.x <= HULL_REAR_X) return REAR_DMG;
  if (_hitP.x >= HULL_FRONT_X) return FRONT_DMG;
  return 1;
}

/**
 * @param {object} deps
 * @param {() => void} [deps.onRestart]  main resets look / cam / path / freefly after entity reset
 */
export function createMatch({
  tank, foes, nav, fx, hud, sfx, tankCam, input,
  vegetation, airfield, port, waterTower, barrels, trucks, patrolBoat, spawn,
  smoke = null,
  onRestart = () => {},
}) {
  const game = {
    solo: localStorage.getItem(SOLO_KEY) === '1',
    showPath: false,
    debug: false,
    overT: 0,          // > 0 while a wreck burns before the auto-restart
    wreck: null,       // the destroyed tank that ended the round
  };
  const combatants = [tank, ...foes.map((f) => f.tank)];

  function foeOf(body) {
    if (!body) return null;
    return foes.find((f) => f.tank.body.handle === body.handle) ?? null;
  }

  /** Living enemy tanks (skipped in solo) plus patrol boats still afloat. */
  function hostileCount() {
    let n = 0;
    if (!game.solo) {
      for (const f of foes) if (f.tank.alive) n++;
    }
    const boats = patrolBoat?.boats;
    if (boats) for (const b of boats) if (b.alive) n++;
    return n;
  }

  function hostilesRemain() {
    return hostileCount() > 0;
  }

  function announceRemaining() {
    const n = hostileCount();
    if (n <= 0 || !tank.alive) return;
    hud.banner(n === 1 ? '1 ENEMY REMAINING' : `${n} ENEMIES REMAINING`, '', 'win', REMAIN_HOLD);
  }

  function pushHealth() {
    hud.setHealth(tank.hp / tank.maxHp, foes.map((f) => f.tank.hp / f.tank.maxHp));
  }

  function endRound(playerDead, victim = null) {
    if (game.overT > 0) return;
    game.overT = ROUND_RESTART_DELAY;
    game.wreck = victim;
    hud.banner(
      playerDead ? 'YOU WERE DESTROYED' : 'ENEMIES CLEARED',
      'next round in a moment',
      playerDead ? 'lose' : 'win',
    );
    if (!playerDead) sfx.victory();
  }

  function restart({ resetCam = true } = {}) {
    tank.respawn(spawn);
    fx.clearShells();
    smoke?.clear();
    barrels.reset();
    waterTower.reset();
    trucks.reset(fx);
    patrolBoat?.reset(fx);
    airfield.reset?.();
    vegetation.reset?.();
    nav.setObstacles([   // palm slider may have changed
      ...vegetation.navObstacles(), ...airfield.navObstacles(),
      ...port.navObstacles(), ...waterTower.navObstacles(),
      ...trucks.navObstacles(),
    ]);
    for (const f of foes) {
      f.tank.setActive(!game.solo);
      if (!game.solo) {
        f.tank.respawn(pickSpawn(nav, spawn, f.anchor, f.spawnR));
        f.ai.reset();
      }
    }
    game.overT = 0;
    game.wreck = null;
    hud.banner(null);
    hud.clearHits();
    hud.showEnemy(!game.solo);
    hud.setHealth(1, foes.map(() => 1));
    hud.setNitro(1, false);
    onRestart({ resetCam });
  }

  function setSolo(v) {
    game.solo = v;
    localStorage.setItem(SOLO_KEY, v ? '1' : '0');
    restart({ resetCam: false });
  }

  function onTankDestroyed(victim) {
    const origin = new THREE.Vector3().copy(victim.body.translation()).add(new THREE.Vector3(0, 1.2, 0));
    fx.wreck(origin);
    victim.obliterate();
    tankCam.addShake(victim === tank ? 1 : 0.4);
    if (victim === tank) endRound(true, victim);
    else if (!hostilesRemain()) endRound(false, victim);
    else announceRemaining();
  }

  /** Fuel-drum blast: full shell hit point-blank, a graze further out. */
  function onBarrelExplode(point) {
    sfx.fire(distGain(point.distanceTo(tank.model.position), 160));
    if (game.overT > 0) return;
    for (const victim of combatants) {
      if (!victim.alive || (victim !== tank && game.solo) || game.overT > 0) continue;
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
      pushHealth();
      if (!victim.alive) onTankDestroyed(victim);
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
    fx.onMgShot = ({ owner, pos, dir, reach, hitBody } = {}) => {
      if (owner === tank.body) tankCam.pulseMgShake();
      // Bass thump under the .50 loop. Player is dry; hostile rounds fade with range.
      const ownerFoe = foeOf(owner);
      if (owner === tank.body) sfx.mgBassThump();
      else if (ownerFoe || patrolBoat?.isBody(owner)) {
        const d = pos ? pos.distanceTo(tank.model.position) : 150;
        sfx.mgBassThump(0.42 * distGain(d, 150), d);
      }
      // Enemy .50 near-miss — skip if this round actually hit you
      const hostile = !!ownerFoe || patrolBoat?.isBody(owner);
      if (!hostile || !tank.alive || hitBody === tank.body) return;
      if (!pos || !dir) return;
      const len = dir.length();
      if (len < 1e-6) return;
      const t = tank.body.translation();
      _flybyEar.set(t.x, t.y + 1.4, t.z);
      _flybyTo.copy(_flybyEar).sub(pos);
      const along = _flybyTo.dot(dir) / (len * len);
      const maxAlong = reach == null ? 450 : reach;
      // Closest approach must lie on the fired segment (muzzle → impact)
      if (along < 1 || along > maxAlong) return;
      _flybyClosest.copy(pos).addScaledVector(dir, along);
      const miss = _flybyClosest.distanceTo(_flybyEar);
      if (miss > MG_FLYBY_MAX) return;
      const intensity = 1 - miss / MG_FLYBY_MAX;
      sfx.flyby(intensity, along / MG_TRACER_SPEED);
    };

    fx.onShellHit = ({ collider, owner, point, dir, naval }) => {
      const body = collider?.parent();
      if (!body || game.overT > 0) return;
      if (airfield.shellHit?.(body, dir, point, collider)) return;
      if (waterTower.shellHit(body, dir)) return;
      if (trucks.shellHit(body, dir)) return;
      const boat = patrolBoat?.boats?.find((b) => b.body.handle === body.handle);
      const boatWasAlive = !!boat?.alive;
      if (patrolBoat?.shellHit(body, dir)) {
        if (boatWasAlive && !boat.alive && tank.alive && game.overT <= 0) {
          if (!hostilesRemain()) endRound(false);
          else announceRemaining();
        }
        return;
      }
      if (vegetation.shellHit?.(body, dir, point)) return;
      const victim = combatants.find((t) => t.body.handle === body.handle);
      if (!victim || !victim.alive) return;
      // Naval shells are not "yours" — staying in the beaten zone kills you too.
      if (!naval && victim.body === owner) return;
      const ownerFoe = foeOf(owner);
      const victimFoe = victim === tank ? null : foeOf(victim.body);
      if (!naval && ownerFoe && victimFoe) return;
      const dmg = naval ? victim.hp : shellDamage(victim, point);
      victim.hp = Math.max(0, victim.hp - dmg);
      // Main-gun only — MG path never calls addStress. Rear hits spike harder.
      if (victim.alive) victim.addStress(STRESS_PER_SHELL * dmg);
      // Clank at the impact — audible ~140 m, squared falloff (no distant floor)
      {
        const d = (point ?? victim.model.position).distanceTo(tank.model.position);
        sfx.hit(distGain(d, 140));
      }
      if (victim === tank) {
        hud.flash();
        if (owner) hud.hitFrom(owner.translation());
        ownerFoe?.ai.onScored();
        input.rumble(1, 1, 450);
        // Fire-kick envelope, shoved along the shell's travel (away from where it came).
        tankCam.kick(1.0, HIT_KICK_RETURN, dir);
      } else {
        if (victim.alive) victim.flashHit();
        victimFoe?.ai.onHit();
      }
      pushHealth();
      if (!victim.alive) onTankDestroyed(victim);
    };

    // Traced .50 hits: metal ricochet SFX (body.userData.mat === 'metal') + chip damage on tanks.
    // `damage` overrides chip amount (Air Support strafe uses a heavier per-round).
    fx.onMgHit = ({ collider, owner, point, dir, damage, air }) => {
      const body = collider?.parent();
      if (!body || game.overT > 0) return;
      if (vegetation.mgHit?.(body, dir, point)) return;
      if (patrolBoat?.isBody(body) && body !== owner) {
        const sunk = air ? patrolBoat.airHit(body) : false;
        if (!air) patrolBoat.flashHit(body);
        if (sunk && tank.alive) {
          if (!hostilesRemain()) endRound(false);
          else announceRemaining();
        }
      }
      const victim = combatants.find((t) => t.body.handle === body.handle);
      const isTank = !!victim && victim.body !== owner && victim.alive;
      const isMetal = body.userData?.mat === 'metal';
      if (!isTank && !isMetal) return;
      const ownerFoe = foeOf(owner);
      const victimFoe = victim && victim !== tank ? foeOf(victim.body) : null;
      if (ownerFoe && victimFoe) return;

      // Local impact SFX — fades by ~90 m (was linear to 180 m with a 0.12 floor).
      sfx.ricochet(distGain(point.distanceTo(tank.model.position), 90));

      if (!isTank) {
        barrels.mgHit(body);
        return;
      }
      const wasAlive = victim.alive;
      const chip = damage != null ? damage : MG_DAMAGE;
      victim.hp = Math.max(0, victim.hp - chip);
      if (victim === tank) {
        if (owner) hud.hitFrom(owner.translation());
        else if (point) hud.hitFrom(point); // air raid — no rigid owner
        input.rumble(0.08, 0.18, 40);
      } else if (victim.alive) {
        victim.flashHit();
      }
      pushHealth();
      if (wasAlive && !victim.alive) {
        if (victim === tank) ownerFoe?.ai.onScored();
        else victimFoe?.ai.onHit();
        onTankDestroyed(victim);
      }
    };

    // Air-raid dirt impacts — thump synced to the strafe rate of fire.
    fx.onMgDirtHit = ({ point, air }) => {
      if (!air || !point) return;
      sfx.dirtThump(distGain(point.distanceTo(tank.model.position), 110));
    };
  }

  function tick(dt) {
    if (game.overT <= 0) return;
    game.overT -= dt;
    if (game.overT <= 0) restart({ resetCam: false });
  }

  /** Pickup heal: fill to max. No-op if dead, the round is over, or HP is already full. */
  function healFull(victim) {
    if (!victim?.alive || game.overT > 0) return false;
    if (victim.hp >= victim.maxHp - 1e-3) return false;
    victim.hp = victim.maxHp;
    if (victim === tank && victim.repairT > 0) {
      victim.repairT = 0;
      sfx.repairStop();
    }
    victim.showHeal();
    pushHealth();
    if (victim === tank) sfx.repairComplete();
    return true;
  }

  return { game, restart, tick, setSolo, wireFx, healFull };
}
