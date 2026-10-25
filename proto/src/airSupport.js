// Air Support gadget: spawns a separate P-51 for one strafe pass (scout orbit keeps flying).
// Raid length matches p51_pass.wav; MG window matches p51_mg.wav.

import { createGroundMark, placeGroundMark, pulseGroundMark, hideGroundMark, tickGroundMark } from './groundMark.js';

export const AIR_SUPPORT_COOLDOWN = 40; // s
/** Ground circle on the reticle spot painted at the call. Tighter than the naval zone. */
const MARK_R = 8;
/** Full raid timeline — keep in sync with `p51_pass.wav` (~10.81 s). */
export const AIR_RAID_DURATION = 10.81;
/** Gun window inside the pass — keep in sync with `p51_mg.wav` (~2.77 s). */
/** Opens around the Bezier trough over the tank (original timing). */
export const AIR_RAID_FIRE_START = 4.0;
export const AIR_RAID_FIRE_END = AIR_RAID_FIRE_START + 2.77;
/** Per-round tank chip; aim-spray hits average ~25% of MAX_HP (4). */
export const AIR_MG_DAMAGE = 0.04;
/** Cyclic rate during the strafe (slightly faster than roof .50 for a denser spray). */
export const AIR_MG_INTERVAL = 0.09;

/**
 * @param {{
 *   planes: {
 *     beginRaid: (x: number, z: number, y?: number) => boolean,
 *     setRaidAim: (x: number, z: number) => void,
 *     isRaiding: boolean,
 *     firing: boolean,
 *     gunPose: (side: number) => { pos: import('three').Vector3, dir: import('three').Vector3 } | null,
 *   },
 *   fx: { fireAirMg: Function },
 *   sfx: { p51Pass: Function, setP51Mg: Function },
 *   getTarget: () => { x: number, z: number } | null,
 *   getOwner: () => object | null,
 *   scene: import('three').Scene,
 *   heightAt: (x: number, z: number) => number,
 * }} deps
 */
export function createAirSupport({ planes, fx, sfx, getTarget, getOwner, scene, heightAt }) {
  let cd = 0;
  let shotT = 0;
  let wasFiring = false;
  let markT = 0;
  const mark = createGroundMark(scene, MARK_R, { thick: 0.4 });

  return {
    get cd() { return cd; },
    get ready() { return cd <= 0 && !planes.isRaiding; },

    /** Call from radial release. Returns true if the raid started. */
    call() {
      if (cd > 0 || planes.isRaiding) return false;
      const target = getTarget();
      if (!target) return false;
      if (!planes.beginRaid(target.x, target.z, target.y)) return false;
      placeGroundMark(mark, target.x, target.z, heightAt);
      markT = 0;
      cd = AIR_SUPPORT_COOLDOWN;
      shotT = AIR_MG_INTERVAL;
      wasFiring = false;
      sfx.p51Pass();
      return true;
    },

    update(dt) {
      if (cd > 0) cd = Math.max(0, cd - dt);

      if (planes.isRaiding) {
        markT += dt;
        pulseGroundMark(mark, markT, AIR_RAID_FIRE_START);
      } else if (mark.fill.visible) {
        hideGroundMark(mark);
      }
      tickGroundMark(mark, dt, heightAt);

      const firing = planes.firing;
      sfx.setP51Mg(firing);
      if (firing && !wasFiring) shotT = AIR_MG_INTERVAL;
      wasFiring = firing;
      if (!firing) return;

      shotT += dt;
      while (shotT >= AIR_MG_INTERVAL) {
        shotT -= AIR_MG_INTERVAL;
        for (const side of [-1, 1]) {
          const pose = planes.gunPose(side);
          if (!pose) continue;
          fx.fireAirMg(pose, { damage: AIR_MG_DAMAGE, owner: getOwner?.() ?? null });
        }
      }
    },
  };
}
