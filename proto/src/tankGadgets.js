// Nitro burst, stress, smoke launchers, and the repair channel. The hull still owns the fields.
import { SMOKE_COOLDOWN } from './smoke.js';
import { updateSweepLight } from './pickupLights.js';

export const REPAIR_CHARGES = 2;
export const REPAIR_TIME = 5;
export const REPAIR_HEAL = 0.5;
export const REPAIR_SWEEP = 1.15;

export const STRESS_MAX = 100;
const STRESS_DECAY = 10;
const STRESS_MISS_MAX = 0.5;

const NITRO = {
  duration: 2.313,
  cost: 0.5,
  rechargePerSec: 1 / 6.5,
  peakAt: 1.0,
  holdEnd: 1.45,
};

function nitroEnvelope(age) {
  if (age <= 0 || age >= NITRO.duration) return 0;
  if (age < NITRO.peakAt) {
    const u = age / NITRO.peakAt;
    return u * u;
  }
  if (age < NITRO.holdEnd) return 1;
  const u = (age - NITRO.holdEnd) / (NITRO.duration - NITRO.holdEnd);
  return Math.max(0, 1 - u * u);
}

export function tryNitro(tank) {
  const n = tank.nitro;
  if (n.t > 0) return false;
  if (n.needFull && n.charge < 1 - 1e-4) return false;
  if (n.charge < NITRO.cost - 1e-4) return false;
  n.charge = Math.max(0, n.charge - NITRO.cost);
  if (n.charge < 0.02) n.needFull = true;
  n.t = NITRO.duration;
  n.power = 0;
  return true;
}

export function updateNitro(tank, dt, wantBoost) {
  const n = tank.nitro;
  const pressed = !!wantBoost;
  n.justStarted = false;
  if (pressed && !n.held) n.justStarted = tryNitro(tank);
  n.held = pressed;

  if (n.t > 0) {
    n.t = Math.max(0, n.t - dt);
    n.power = nitroEnvelope(NITRO.duration - n.t);
  } else {
    n.power = 0;
    if (n.charge < 1) {
      n.charge = Math.min(1, n.charge + NITRO.rechargePerSec * dt);
      if (n.charge >= 1 - 1e-4) {
        n.charge = 1;
        n.needFull = false;
      }
    }
  }
}

export function stressMissChance(tank) {
  return (tank.stress / STRESS_MAX) * STRESS_MISS_MAX;
}

export function missChance(tank, smokeMiss = 0) {
  return Math.min(0.95, stressMissChance(tank) + Math.max(0, smokeMiss));
}

export function addStress(tank, amount) {
  if (amount <= 0 || !tank.alive) return;
  tank.stress = Math.min(STRESS_MAX, tank.stress + amount);
}

export function decayStress(tank, dt) {
  if (tank.stress > 0) tank.stress = Math.max(0, tank.stress - STRESS_DECAY * dt);
}

export function trySmoke(tank) {
  if (!tank.alive || tank.smokeCd > 0) return null;
  tank.smokeCd = SMOKE_COOLDOWN;
  const p = tank.body.translation();
  return { x: p.x, y: p.y, z: p.z };
}

export function smokeCdFraction(tank) {
  return tank.smokeCd <= 0 ? 1 : 1 - tank.smokeCd / SMOKE_COOLDOWN;
}

export function tryRepair(tank) {
  if (!tank.alive || tank.wrecked || tank.repairT > 0 || tank.repairs <= 0) return false;
  if (tank.hp >= tank.maxHp - 1e-3) return false;
  tank.repairs -= 1;
  tank.repairT = REPAIR_TIME;
  return true;
}

export function tickRepair(tank, dt) {
  tank.repairDone = false;
  tank.repairCancelled = false;
  if (tank.repairT <= 0) return;
  if (!tank.alive) {
    tank.repairT = 0;
    tank.repairCancelled = true;
    return;
  }
  tank.repairT = Math.max(0, tank.repairT - dt);
  if (tank.repairT > 0) return;
  tank.hp = Math.min(tank.maxHp, tank.hp + tank.maxHp * REPAIR_HEAL);
  tank.repairDone = true;
  // Shield-violet band (health pickup keeps the green via showHeal).
  if (tank._repairU) tank._repairU.color.value.setRGB(0.95, 0.42, 2.55);
  tank._sweepLit = true;
  tank._sweep = 0;
}

export function updateRepairSweep(tank, dt) {
  const u = tank._repairU;
  if (!u || tank._sweep < 0) {
    updateSweepLight(tank, 0, 0);
    return;
  }
  if (!tank.alive) {
    tank._sweep = -1;
    tank._sweepLit = false;
    u.amp.value = 0;
    updateSweepLight(tank, 0, 0);
    return;
  }
  tank._sweep += dt;
  const k = Math.min(1, tank._sweep / REPAIR_SWEEP);
  u.t.value = k;
  u.amp.value = k > 0.84 ? Math.max(0, (1 - k) / 0.16) : 1;
  u.origin.value.copy(tank.model.position);
  u.forward.value.set(1, 0, 0).transformDirection(tank.model.matrixWorld);
  updateSweepLight(tank, k, u.amp.value);
  if (k >= 1) {
    tank._sweep = -1;
    tank._sweepLit = false;
    u.amp.value = 0;
    updateSweepLight(tank, 0, 0);
  }
}
