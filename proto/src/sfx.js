// Main-gun one-shots (chopped from Sounds/239135__qubodup__tank-shots.flac)
// + looping drive (Sounds/187676__qubodup__driving-tank-engine.flac)
// + .50 cal loop (Sounds/151556__tcpp__machinegun-ish-9.wav, 2nd burst, period-crossfaded, −25% pitch keep tempo)
// + turret traverse (Sounds/171657__qubodup__tank-or-tower-turret-moving-and-turning.flac)
// + first-hit armor clang (Sounds/435681__eben-frostey__metallic-clang.mp3)
// + MG metal hit (Sounds/446128__justinvoke__metal-clank-4.wav — pitched-down variants)
// + in-game music (Sounds/Steel and Silence.mp3).
// + reload ready (Sounds/418882__kierankeegan__tank-reload.wav).
// + burning wreck loop (Sounds/612277__robinhood76__10835-big-fire-loop.wav → 2s, +2 dB).
// + P-51 pass (Sounds/161121__fight2flyphoto__two-p-51-mustangs-pass-overhead.wav).
// + P-51 MG (Sounds/581771__hz37__machine-gun-hza-01-08-2021.wav).
// + P-51 orbit loop (Sounds/161117__fight2flyphoto__t-6-texans-p-51-mustangs-b-25-mitchell-runup.wav).
// + dirt thump (Sounds/48170__hy96__thump.wav) — air-raid ground strikes.
// + smoke bomb (Sounds/583262__pfranzen__dropping-a-smoke-bomb-on-the-ground.ogg).
// + MG near-miss flyby (Sounds/394208__saturdaysoundguy__slingshot-flyby.wav, peak-normalized).
// + MG bass thump (Sounds/630030__el_boss__deep-bass-thump.wav) — layered per .50 round.
// + repair wrench (Sounds/591528__rudmer_rotteveel__ratchet-wrench-slow-multiple.wav).
// + repair complete (Sounds/242501__gabrielaraujo__powerupsuccess.wav).
// + victory fanfare (Sounds/161984__robinhood76__03599-majestic-foreboding-fanfare.wav).
// + C-47 supply pass (Sounds/515293__breviceps__propeller-plane.wav, +5 dB).
const SHOT_URLS = [
  './sounds/tank_shot_1.wav',
  './sounds/tank_shot_2.wav',
  './sounds/tank_shot_3.wav',
];
const ENGINE_URL = './sounds/tank_engine.wav';
const MG50_URL = './sounds/mg50_loop.wav';
const TURRET_URL = './sounds/turret_loop.wav';
const HIT_URL = './sounds/metallic_clang.mp3';
const MG_CLANK_URL = './sounds/mg_metal_clank.wav';
const P51_PASS_URL = './sounds/p51_pass.wav';
const P51_MG_URL = './sounds/p51_mg.wav';
const P51_ORBIT_URL = './sounds/p51_orbit.wav';
const C47_URL = './sounds/515293__breviceps__propeller-plane.wav';
const C47_DB = Math.pow(10, 5 / 20); // +5 dB
const P51_ORBIT_VOL = 0.55 * Math.pow(10, 10 / 20); // +10 dB; peak when overhead / very close
const DIRT_THUMP_URL = './sounds/dirt_thump.wav';
const MG_BASS_URL = './sounds/mg_bass_thump.wav';
const MG_BASS_DB = Math.pow(10, 10 / 20); // +10 dB
const SMOKE_BOMB_URL = './sounds/smoke_bomb.ogg';
const FLYBY_URL = './sounds/bullet_flyby.wav';
const REPAIR_URL = './sounds/repair_wrench.wav';
const REPAIR_DONE_URL = './sounds/repair_done.wav';
const FANFARE_URL = './sounds/161984__robinhood76__03599-majestic-foreboding-fanfare.wav';
// Source peaks at ~0 dBFS; leave headroom so it sits over a ducked music bed.
const FANFARE_GAIN = 0.72;
const FANFARE_MUSIC_DUCK = 0.32;
// Source wrench is 4.88s; slow it so the clip fills the 5s repair channel.
const REPAIR_WRENCH_RATE = 4.880295 / 5;
// Success sample peaks at −11.5 dBFS; +12 dB puts it up with the wrench clicks.
const REPAIR_DONE_DB = Math.pow(10, 12 / 20);
const FLYBY_DB = Math.pow(10, 15 / 20); // +15 dB vs normalized sample
// Four pitched-down rates (−1 / −2.5 / −4 / −6 semitones) × 0.45 (−55% total) + tiny jitter
const MG_CLANK_RATES = [
  Math.pow(2, -1 / 12) * 0.45,
  Math.pow(2, -2.5 / 12) * 0.45,
  Math.pow(2, -4 / 12) * 0.45,
  Math.pow(2, -6 / 12) * 0.45,
];
const MG_CLANK_DB = Math.pow(10, -6 / 20); // −6 dB vs raw sample
const MUSIC_URL = './sounds/steel_and_silence.mp3';
const NITRO_URL = './sounds/nitro_rev.wav';
const RELOAD_URL = './sounds/418882__kierankeegan__tank-reload.wav';
const RELOAD_DB = Math.pow(10, 5 / 20); // +5 dB
const FIRE_URL = './sounds/fire_loop.wav';
const FIRE_VOL = 0.62; // sample already +2 dB vs source
/** Burn loop is silent past this. Squared falloff, same as other world sounds. */
export const FIRE_HEAR = 70;
const MUSIC_VOL_DEFAULT = 0.35; // ~25% above prior 0.28
// Base rate (+20% vs sample); L/R offset ~1.5 semitones each way
const TURRET_BASE = 1.2;
const TURRET_PITCH = 0.09;

const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));

/** One loop voice: damp gain (and optional playback rate) toward the targets `prep` just set. */
function stepVoice(v, dt) {
  if (v.run) {
    v.run(dt);
    return;
  }
  if (v.prep) v.prep(v, dt);
  if (!v.gain) return;
  v.vol = damp(v.vol, v.target, v.lambda, dt);
  v.gain.gain.value = v.vol;
  if (v.targetRate != null && v.src) {
    v.rate = damp(v.rate, v.targetRate, v.rateLambda, dt);
    v.src.playbackRate.value = v.rate;
  }
  if (v.after) v.after(v, dt);
}

/**
 * Distance → 0..1 gain. Squared so far hits drop fast (linear floors were keeping
 * MG clanks audible across the whole ~250 m island). Returns 0 beyond `maxDist`.
 */
export function distGain(d, maxDist) {
  const t = Math.max(0, Math.min(1, 1 - d / maxDist));
  return t * t;
}

/** Metres inside which a hostile gun stays full-band. Past this, highs fall off. */
const HEAR_OPEN_M = 22;
/** Enemy / boat .50 — silent past this (squared), lowpassed down to MG_FLOOR_HZ. */
const MG_HEAR = 150;
const MG_FLOOR_HZ = 480;
const HOSTILE_MG_VOL = 0.58;
/** Main-gun muffling matches the 160 m distGain used for enemy shots. */
const CANNON_HEAR = 160;
const CANNON_FLOOR_HZ = 260;
const BASS_FLOOR_HZ = 240;

/**
 * Lowpass (Hz) for a hostile weapon `d` metres away.
 * Open nearby, then air-absorption curve down to `floorHz` at `maxDist`.
 */
function distantCutoff(d, maxDist, floorHz) {
  const air = Math.max(0, Math.min(1, (d - HEAR_OPEN_M) / Math.max(1, maxDist - HEAR_OPEN_M)));
  const open = 12000;
  return open * Math.pow(floorHz / open, air);
}

export class Sfx {
  constructor() {
    this.ctx = null;
    this.shots = [];
    this.engineBuf = null;
    this.mgBuf = null;
    this.turretBuf = null;
    this.hitBuf = null;
    this.mgClankBuf = null;
    this.musicBuf = null;
    this.nitroBuf = null;
    this.reloadBuf = null;
    this.fireBuf = null;
    this.p51PassBuf = null;
    this.p51MgBuf = null;
    this.p51OrbitBuf = null;
    this.c47Buf = null;
    this.dirtThumpBuf = null;
    this.mgBassBuf = null;
    this.smokeBombBuf = null;
    this.flybyBuf = null;
    this.repairBuf = null;
    this.repairDoneBuf = null;
    this.fanfareBuf = null;
    this.ready = false;
    this._last = -1;
    this._ricoLast = -1;
    this._hitCool = 0;
    this._ricoCool = 0;
    this._thumpCool = 0;
    this._flybyCool = 0;
    this._active = new Set(); // retain one-shots until onended (avoids GC cutting tails)
    this._engine = null;
    this._engineGain = null;
    this._rate = 1;
    this._vol = 0;
    this._mg = null;
    this._mgGain = null;
    this._mgVol = 0;
    this._mgWant = false;
    this._hmg = null;
    this._hmgGain = null;
    this._hmgLp = null;
    this._hmgVol = 0;
    this._hmgCut = 12000;
    this._hmgDist = null;
    this._fire = null;
    this._fireGain = null;
    this._fireVol = 0;
    this._fireWant = false;
    this._p51Mg = null;
    this._p51MgGain = null;
    this._p51MgVol = 0;
    this._p51MgWant = false;
    this._p51Orbit = null;
    this._p51OrbitGain = null;
    this._p51OrbitVol = 0;
    this._p51OrbitWant = 0;
    this._turret = null;
    this._turretGain = null;
    this._turretVol = 0;
    this._turretRate = TURRET_BASE;
    this._music = null;
    this._musicGain = null;
    this._musicMuted = false;
    this._musicVol = MUSIC_VOL_DEFAULT;
    this._musicDuck = 1;
    this._musicDuckTarget = 1;
    this._fanfare = null;
    this._repair = null;
    this._c47 = null;
    this._drive = { speed: 0, throttle: 0, maxSpeed: 12.5, turretSlew: 0 };
    this._voices = [{
      run: (dt) => {
        if (!this._musicGain || this._musicDuck === this._musicDuckTarget) return;
        this._musicDuck = damp(this._musicDuck, this._musicDuckTarget, 4, dt);
        if (Math.abs(this._musicDuck - this._musicDuckTarget) < 0.001) this._musicDuck = this._musicDuckTarget;
        this._applyMusicGain();
      },
    }];
  }

  _track(voice) {
    this._voices.push(voice);
    return voice;
  }

  async load() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    const decode = async (url) => {
      const res = await fetch(url);
      return this.ctx.decodeAudioData(await res.arrayBuffer());
    };
    const [shots, engine, mg, turret, hit, mgClank, music, nitro, reload, fire, p51Pass, p51Mg, p51Orbit, c47, dirtThump, mgBass, smokeBomb, flyby, repair, repairDone, fanfare] = await Promise.all([
      Promise.all(SHOT_URLS.map(decode)),
      decode(ENGINE_URL),
      decode(MG50_URL),
      decode(TURRET_URL),
      decode(HIT_URL),
      decode(MG_CLANK_URL),
      decode(MUSIC_URL),
      decode(NITRO_URL),
      decode(RELOAD_URL),
      decode(FIRE_URL),
      decode(P51_PASS_URL),
      decode(P51_MG_URL),
      decode(P51_ORBIT_URL),
      decode(C47_URL),
      decode(DIRT_THUMP_URL),
      decode(MG_BASS_URL),
      decode(SMOKE_BOMB_URL),
      decode(FLYBY_URL),
      decode(REPAIR_URL),
      decode(REPAIR_DONE_URL),
      decode(FANFARE_URL),
    ]);
    this.shots = shots;
    this.engineBuf = engine;
    this.mgBuf = mg;
    this.turretBuf = turret;
    this.hitBuf = hit;
    this.mgClankBuf = mgClank;
    this.musicBuf = music;
    this.nitroBuf = nitro;
    this.reloadBuf = reload;
    this.fireBuf = fire;
    this.p51PassBuf = p51Pass;
    this.p51MgBuf = p51Mg;
    this.p51OrbitBuf = p51Orbit;
    this.c47Buf = c47;
    this.dirtThumpBuf = dirtThump;
    this.mgBassBuf = mgBass;
    this.smokeBombBuf = smokeBomb;
    this.flybyBuf = flyby;
    this.repairBuf = repair;
    this.repairDoneBuf = repairDone;
    this.fanfareBuf = fanfare;
    this.ready = true;
  }

  /** Browsers block audio until a user gesture — call from click / pointer-lock. */
  unlock() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this._ensureEngine();
    this._ensureMusic();
  }

  get musicMuted() { return this._musicMuted; }
  get musicVolume() { return this._musicVol; }

  setMusicMuted(on) {
    this._musicMuted = !!on;
    this._applyMusicGain();
  }

  setMusicVolume(v) {
    this._musicVol = Math.max(0, Math.min(1, Number(v) || 0));
    this._applyMusicGain();
  }

  _applyMusicGain() {
    if (!this._musicGain) return;
    const bed = this._musicMuted ? 0 : this._musicVol;
    this._musicGain.gain.value = bed * this._musicDuck;
  }

  _ensureMusic() {
    if (!this.ready || !this.musicBuf || this._music) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.musicBuf;
    src.loop = true;
    const g = this.ctx.createGain();
    src.connect(g).connect(this.ctx.destination);
    src.start();
    this._music = src;
    this._musicGain = g;
    this._applyMusicGain();
  }

  _ensureEngine() {
    if (!this.ready || !this.engineBuf || this._engine) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.engineBuf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    this._engine = src;
    this._engineGain = g;
    this._track({
      src, gain: g, vol: 0, rate: 1, target: 0, lambda: 6, targetRate: 1, rateLambda: 5,
      prep: (v) => {
        const { speed, throttle, maxSpeed } = this._drive;
        const absSpd = Math.abs(speed);
        const spdT = Math.min(1, absSpd / maxSpeed);
        const throttleT = Math.min(1, Math.abs(throttle));
        const reversing = speed < -0.4 || throttle < -0.15;
        const activity = Math.max(spdT, throttleT * 0.85);
        v.target = 0.12 + activity * 0.55;
        v.lambda = 6;
        v.targetRate = reversing ? 0.72 + spdT * 0.12 : 0.92 + spdT * 0.28 + throttleT * 0.06;
        v.rateLambda = 5;
      },
    });
  }

  /** One-shot engine rev for a nitro burst (matches tank nitro envelope). */
  nitro(volume = 0.85) {
    if (!this.ready || !this.nitroBuf) return;
    this.unlock();
    const src = this.ctx.createBufferSource();
    src.buffer = this.nitroBuf;
    src.playbackRate.value = 0.98 + Math.random() * 0.04;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    src.onended = () => this._active.delete(src);
    src.start();
  }

  /** Breech click when the main gun finishes reloading. */
  reload(volume = 0.9) {
    if (!this.ready || !this.reloadBuf) return;
    this.unlock();
    const src = this.ctx.createBufferSource();
    src.buffer = this.reloadBuf;
    const g = this.ctx.createGain();
    g.gain.value = volume * RELOAD_DB;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    src.onended = () => this._active.delete(src);
    src.start();
  }

  /**
   * Play a random main-gun shot (avoids repeating the same clip twice in a row).
   * `dist` (metres) lowpasses a hostile shot; omit it for the player's own gun.
   */
  fire(volume = 0.9, dist = null) {
    if (!this.ready || !this.shots.length) return;
    if (volume < 0.03) return;
    this.unlock();
    let i = Math.floor(Math.random() * this.shots.length);
    if (this.shots.length > 1 && i === this._last) i = (i + 1) % this.shots.length;
    this._last = i;

    const src = this.ctx.createBufferSource();
    src.buffer = this.shots[i];
    src.playbackRate.value = 0.97 + Math.random() * 0.06;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    this._connectShot(src, g, dist, CANNON_HEAR, CANNON_FLOOR_HZ);
    this._active.add(src);
    src.onended = () => this._active.delete(src);
    src.start();
  }

  /**
   * Armor clang on a main-gun tank hit. `intensity` 0..1 scales volume
   * (pass distGain from the listener); light pitch variance so repeats don't stack.
   */
  hit(intensity = 1) {
    if (!this.ready || !this.hitBuf) return;
    if (this._hitCool > 0) return;
    const t = Math.max(0, Math.min(1, intensity));
    if (t < 0.03) return;
    this.unlock();
    const src = this.ctx.createBufferSource();
    src.buffer = this.hitBuf;
    src.playbackRate.value = 0.96 + Math.random() * 0.08;
    const g = this.ctx.createGain();
    // No volume floor — distant hits must go silent (was 0.25 + t*0.75).
    g.gain.value = t * 0.9;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    src.onended = () => this._active.delete(src);
    src.start();
    this._hitCool = 0.08;
  }

  /**
   * .50 cal metal clank — one source, 4 pitched-down variants (avoid repeat),
   * short cool so traced MG hits still read as a spray.
   */
  ricochet(intensity = 1) {
    if (!this.ready || !this.mgClankBuf) return;
    if (this._ricoCool > 0) return;
    const t = Math.max(0, Math.min(1, intensity));
    if (t < 0.03) return;
    this.unlock();
    let i = Math.floor(Math.random() * MG_CLANK_RATES.length);
    if (i === this._ricoLast) i = (i + 1) % MG_CLANK_RATES.length;
    this._ricoLast = i;
    const src = this.ctx.createBufferSource();
    src.buffer = this.mgClankBuf;
    // Base variant + tiny jitter so identical picks still differ slightly
    src.playbackRate.value = MG_CLANK_RATES[i] * (0.98 + Math.random() * 0.04);
    const g = this.ctx.createGain();
    // Scale with intensity only (old 0.28 floor kept far sprays loud).
    g.gain.value = t * 0.55 * MG_CLANK_DB;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    src.onended = () => this._active.delete(src);
    src.start();
    this._ricoCool = 0.035;
  }

  _ensureMg() {
    if (!this.ready || !this.mgBuf || this._mg) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.mgBuf;
    src.loop = true;
    src.playbackRate.value = 1;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    this._mg = src;
    this._mgGain = g;
    this._track({
      src, gain: g, vol: 0, rate: 1, target: 0, lambda: 10, targetRate: null, rateLambda: 5,
      prep: (v) => {
        v.target = this._mgWant ? 0.72 : 0;
        v.lambda = this._mgWant ? 18 : 10;
      },
    });
  }

  /** Hold-to-fire .50 cal loop for the player. Call each frame with pressed state. */
  setMgFire(on) {
    this._mgWant = !!on;
    if (on) {
      this.unlock();
      this._ensureMg();
    }
  }

  /**
   * Enemy-tank / boat .50. `dist` is metres to the nearest shooter, or null
   * when none are firing. Far bursts drop in level and lose their crack.
   */
  setHostileMg(dist) {
    if (dist == null || !Number.isFinite(dist)) {
      this._hmgDist = null;
      return;
    }
    this._hmgDist = dist;
    if ((this._hmgVoice?.vol ?? 0) < 0.02) this._hmgCut = distantCutoff(dist, MG_HEAR, MG_FLOOR_HZ);
    this.unlock();
    this._ensureHostileMg();
  }

  _ensureHostileMg() {
    if (!this.ready || !this.mgBuf || this._hmg) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.mgBuf;
    src.loop = true;
    src.playbackRate.value = 1;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.value = this._hmgCut;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(lp).connect(g).connect(this.ctx.destination);
    src.start();
    this._hmg = src;
    this._hmgLp = lp;
    this._hmgGain = g;
    this._hmgVoice = this._track({
      src, gain: g, vol: 0, rate: 1, target: 0, lambda: 8, targetRate: null, rateLambda: 5,
      prep: (v) => {
        const d = this._hmgDist;
        const on = d != null;
        v.target = on ? HOSTILE_MG_VOL * distGain(d, MG_HEAR) : 0;
        v.lambda = on ? 14 : 8;
        v._on = on;
        v._dist = d;
      },
      after: (v, dt) => {
        if (!v._on) return;
        this._hmgCut = damp(this._hmgCut, distantCutoff(v._dist, MG_HEAR, MG_FLOOR_HZ), 8, dt);
        this._hmgLp.frequency.value = this._hmgCut;
      },
    });
  }

  /** One-shot → destination. Lowpass when `dist` is a metre value past HEAR_OPEN_M. */
  _connectShot(src, gainNode, dist, maxDist, floorHz) {
    if (typeof dist === 'number' && dist > HEAR_OPEN_M) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.7;
      lp.frequency.value = distantCutoff(dist, maxDist, floorHz);
      src.connect(lp).connect(gainNode);
    } else {
      src.connect(gainNode);
    }
    gainNode.connect(this.ctx.destination);
  }

  /** Soft-mute everything (pause menu). Suspends the AudioContext so loops freeze mid-note. */
  setPaused(on) {
    if (!this.ctx) return;
    if (on) {
      this._mgWant = false;
      this._hmgDist = null;
      this._fireWant = false;
      this._p51OrbitWant = 0;
      if (this.ctx.state === 'running') this.ctx.suspend().catch?.(() => {});
    } else if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch?.(() => {});
    }
  }

  /**
   * Backdrop scout engine loop. Call each frame with 0..1 intensity
   * (usually distGain from listener → plane).
   */
  setP51Orbit(intensity = 0) {
    const t = Math.max(0, Math.min(1, Number(intensity) || 0));
    this._p51OrbitWant = t;
    if (t > 0.02) {
      this.unlock();
      this._ensureP51Orbit();
    }
  }

  _ensureP51Orbit() {
    if (!this.ready || !this.p51OrbitBuf || this._p51Orbit) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.p51OrbitBuf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    this._p51Orbit = src;
    this._p51OrbitGain = g;
    this._track({
      src, gain: g, vol: 0, rate: 1, target: 0, lambda: 3, targetRate: null, rateLambda: 5,
      prep: (v) => {
        v.target = this._p51OrbitWant * P51_ORBIT_VOL;
        v.lambda = v.target > v.vol ? 5 : 3;
      },
    });
  }

  /**
   * Fire-gif burn loop (tanks, trucks, …). `gain` is 0..1 loudness at the listener
   * (already distance-scaled). Call each frame.
   */
  setFire(gain = 0) {
    const t = Math.max(0, Math.min(1, Number(gain) || 0));
    this._fireWant = t;
    if (t > 0.02) {
      this.unlock();
      this._ensureFire();
    }
  }

  /** Supply C-47 flyby. The clip is the whole pass; the crate drops at 15s. */
  c47Pass() {
    this.c47Stop();
    if (!this.ready || !this.c47Buf) return;
    this.unlock();
    const src = this.ctx.createBufferSource();
    src.buffer = this.c47Buf;
    const g = this.ctx.createGain();
    g.gain.value = C47_DB;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    src.onended = () => {
      this._active.delete(src);
      if (this._c47 === src) this._c47 = null;
    };
    src.start();
    this._c47 = src;
  }

  /** Cut the flyby when the round resets before the crate is gone. */
  c47Stop() {
    const src = this._c47;
    if (!src) return;
    this._c47 = null;
    try { src.stop(); } catch (_) { /* already ended */ }
    this._active.delete(src);
  }

  /** One-shot P-51 overhead pass — length drives the air-raid timeline. */
  p51Pass(volume = 0.85) {
    if (!this.ready || !this.p51PassBuf) return;
    this.unlock();
    const src = this.ctx.createBufferSource();
    src.buffer = this.p51PassBuf;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    src.onended = () => this._active.delete(src);
    src.start();
  }

  /** P-51 strafe MG — plays the burst clip once per gun window (not looped). */
  setP51Mg(on) {
    const want = !!on;
    if (want === this._p51MgWant) return;
    this._p51MgWant = want;
    if (!want) {
      if (this._p51Mg) {
        try { this._p51Mg.stop(); } catch (_) { /* already ended */ }
        this._active.delete(this._p51Mg);
        this._p51Mg = null;
        this._p51MgGain = null;
        this._p51MgVol = 0;
      }
      return;
    }
    if (!this.ready || !this.p51MgBuf) return;
    this.unlock();
    if (this._p51Mg) {
      try { this._p51Mg.stop(); } catch (_) { /* already ended */ }
      this._active.delete(this._p51Mg);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.p51MgBuf;
    const g = this.ctx.createGain();
    g.gain.value = 0.78;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    src.onended = () => {
      this._active.delete(src);
      if (this._p51Mg === src) {
        this._p51Mg = null;
        this._p51MgGain = null;
      }
    };
    src.start();
    this._p51Mg = src;
    this._p51MgGain = g;
    this._p51MgVol = 0.78;
  }

  /** Wrench through the repair channel. Stretched to 5s; stop() on cancel or completion. */
  repairStart(volume = 0.85) {
    this.repairStop();
    if (!this.ready || !this.repairBuf) return;
    this.unlock();
    const src = this.ctx.createBufferSource();
    src.buffer = this.repairBuf;
    src.playbackRate.value = REPAIR_WRENCH_RATE;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    src.onended = () => {
      this._active.delete(src);
      if (this._repair === src) this._repair = null;
    };
    src.start();
    this._repair = src;
  }

  repairStop() {
    const src = this._repair;
    if (!src) return;
    this._repair = null;
    try { src.stop(); } catch (_) { /* already ended */ }
    this._active.delete(src);
  }

  /** Sting when the repair channel finishes and the HP lands. */
  repairComplete(volume = 1) {
    if (!this.ready || !this.repairDoneBuf) return;
    this.unlock();
    const src = this.ctx.createBufferSource();
    src.buffer = this.repairDoneBuf;
    const g = this.ctx.createGain();
    g.gain.value = volume * REPAIR_DONE_DB;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    src.onended = () => this._active.delete(src);
    // A few ms after the wrench is cut, so the attack isn't lost in that stop.
    src.start(this.ctx.currentTime + 0.05);
  }

  /** Match-won sting. Music ducks for the clip (~8s), including into the next round. */
  victory() {
    if (!this.ready || !this.fanfareBuf) return;
    this.unlock();
    const prev = this._fanfare;
    const src = this.ctx.createBufferSource();
    src.buffer = this.fanfareBuf;
    const g = this.ctx.createGain();
    g.gain.value = FANFARE_GAIN;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    this._fanfare = src;
    this._musicDuckTarget = FANFARE_MUSIC_DUCK;
    src.onended = () => {
      this._active.delete(src);
      if (this._fanfare !== src) return;
      this._fanfare = null;
      this._musicDuckTarget = 1;
    };
    if (prev) {
      try { prev.stop(); } catch (_) { /* already ended */ }
      this._active.delete(prev);
    }
    src.start();
  }

  /** Smoke launchers — length matches cloud life (`SMOKE_DURATION`). */
  smokeBomb(volume = 0.9) {
    if (!this.ready || !this.smokeBombBuf) return;
    this.unlock();
    const src = this.ctx.createBufferSource();
    src.buffer = this.smokeBombBuf;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    src.onended = () => this._active.delete(src);
    src.start();
  }

  /**
   * Extra bass thump layered on each .50 round (on top of the MG loop).
   * Pass `dist` (metres) for a hostile shooter so far rounds fade and dull.
   */
  mgBassThump(volume = 0.42, dist = null) {
    if (!this.ready || !this.mgBassBuf) return;
    if (volume < 0.025) return;
    this.unlock();
    const src = this.ctx.createBufferSource();
    src.buffer = this.mgBassBuf;
    src.playbackRate.value = 0.97 + Math.random() * 0.06;
    const g = this.ctx.createGain();
    g.gain.value = volume * MG_BASS_DB;
    this._connectShot(src, g, dist, MG_HEAR, BASS_FLOOR_HZ);
    this._active.add(src);
    src.onended = () => this._active.delete(src);
    src.start();
  }

  /** Short dirt thump for air-raid ground strikes (rate-limited to the strafe RoF). */
  dirtThump(intensity = 1) {
    if (!this.ready || !this.dirtThumpBuf) return;
    if (this._thumpCool > 0) return;
    const t = Math.max(0, Math.min(1, intensity));
    if (t < 0.03) return;
    this.unlock();
    const src = this.ctx.createBufferSource();
    src.buffer = this.dirtThumpBuf;
    src.playbackRate.value = 0.92 + Math.random() * 0.16;
    const g = this.ctx.createGain();
    g.gain.value = t * 0.55;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    src.onended = () => this._active.delete(src);
    src.start();
    this._thumpCool = 0.04;
  }

  /**
   * Enemy .50 near-miss whoosh. `delay` syncs to tracer closest-approach
   * (sample peak-normalized so it cuts through the MG loop).
   */
  flyby(intensity = 1, delay = 0) {
    if (!this.ready || !this.flybyBuf) return;
    if (this._flybyCool > 0) return;
    const t = Math.max(0, Math.min(1, intensity));
    if (t < 0.05) return;
    this.unlock();
    const src = this.ctx.createBufferSource();
    src.buffer = this.flybyBuf;
    src.playbackRate.value = 0.94 + Math.random() * 0.12;
    const g = this.ctx.createGain();
    // Loud enough to read over the shared .50 loop (~0.72)
    g.gain.value = (0.55 + t * 0.7) * FLYBY_DB;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    src.onended = () => this._active.delete(src);
    const when = this.ctx.currentTime + Math.max(0, delay);
    src.start(when);
    this._flybyCool = 0.055;
  }

  _ensureFire() {
    if (!this.ready || !this.fireBuf || this._fire) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.fireBuf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    this._fire = src;
    this._fireGain = g;
    this._track({
      src, gain: g, vol: 0, rate: 1, target: 0, lambda: 4, targetRate: null, rateLambda: 5,
      prep: (v) => {
        const want = this._fireWant || 0;
        v.target = want * FIRE_VOL;
        v.lambda = want > 0.02 ? 6 : 4;
      },
    });
  }

  _ensureTurret() {
    if (!this.ready || !this.turretBuf || this._turret) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.turretBuf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    this._turret = src;
    this._turretGain = g;
    this._track({
      src, gain: g, vol: 0, rate: TURRET_BASE, target: 0, lambda: 8, targetRate: TURRET_BASE, rateLambda: 10,
      prep: (v) => {
        const slewT = Math.max(-1, Math.min(1, this._drive.turretSlew / 0.7));
        const moving = Math.abs(slewT) > 0.04;
        if (moving) this.unlock();
        v.target = moving ? 0.177 + Math.abs(slewT) * 0.139 : 0;
        v.lambda = moving ? 14 : 8;
        v.targetRate = TURRET_BASE - slewT * TURRET_PITCH;
        v.rateLambda = 10;
      },
    });
  }

  /**
   * Drive loop + MG gain + turret traverse.
   * Volume from motion/throttle; pitch up with forward speed,
   * pitch down when reversing (same clip).
   * Turret: fades with |slew|; pitch down left / up right.
   */
  update(dt, { speed = 0, throttle = 0, maxSpeed = 12.5, turretSlew = 0 } = {}) {
    if (!this.ready) return;
    if (this._hitCool > 0) this._hitCool = Math.max(0, this._hitCool - dt);
    if (this._ricoCool > 0) this._ricoCool = Math.max(0, this._ricoCool - dt);
    if (this._thumpCool > 0) this._thumpCool = Math.max(0, this._thumpCool - dt);
    if (this._flybyCool > 0) this._flybyCool = Math.max(0, this._flybyCool - dt);
    this._drive.speed = speed;
    this._drive.throttle = throttle;
    this._drive.maxSpeed = maxSpeed;
    this._drive.turretSlew = turretSlew;
    this._ensureEngine();
    this._ensureMg();
    this._ensureFire();
    this._ensureP51Orbit();
    this._ensureTurret();
    for (const v of this._voices) stepVoice(v, dt);
  }
}
