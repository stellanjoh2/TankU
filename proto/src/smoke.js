// Battlefield 3/4-style tank smoke: ring of canisters → LOS cloud with a hit-rate penalty.
export const SMOKE_COOLDOWN = 10;   // s (dev); raise for shipping
/** Cloud life — keep in sync with `smoke_bomb.ogg` (~7.16 s). */
export const SMOKE_DURATION = 7.16;
export const SMOKE_RADIUS = 14 * 0.75; // m (−25% vs first pass)
export const SMOKE_MISS = 0.10;        // additive miss chance while in / near cloud
const SMOKE_DENSITY = 1.25;            // +25% emission / opacity

/**
 * World smoke volumes + FX drive. Call `deploy` from a tank gadget / AI panic.
 * @param {{ smokeScreen: Function, smokeBurst: Function }} fx
 */
export function createSmokeField(fx) {
  const clouds = [];

  return {
    get clouds() { return clouds; },

    /** Pop a ring at `pos` (tank world origin). */
    deploy(pos) {
      clouds.push({
        x: pos.x,
        y: pos.y + 1.4,
        z: pos.z,
        r: SMOKE_RADIUS,
        life: SMOKE_DURATION,
        age: 0,
      });
      fx.smokeBurst(pos, SMOKE_RADIUS);
    },

    update(dt) {
      for (let i = clouds.length - 1; i >= 0; i--) {
        const c = clouds[i];
        c.age += dt;
        if (c.age >= c.life) {
          clouds.splice(i, 1);
          continue;
        }
        const fade = 1 - c.age / c.life;
        fx.smokeScreen(c, dt, (0.45 + fade * 0.85) * SMOKE_DENSITY);
      }
    },

    clear() { clouds.length = 0; },

    /** True if (x,z) sits inside any live cloud. */
    covers(x, z) {
      for (const c of clouds) {
        if (Math.hypot(x - c.x, z - c.z) <= c.r) return true;
      }
      return false;
    },

    /**
     * Extra miss chance when either endpoint is in smoke
     * (shooter near cloud, or target / enemy in cloud).
     */
    missBonus(ax, az, bx, bz) {
      if (this.covers(ax, az) || this.covers(bx, bz)) return SMOKE_MISS;
      return 0;
    },
  };
}
