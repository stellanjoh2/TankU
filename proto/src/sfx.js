// Main-gun one-shots (chopped from Sounds/239135__qubodup__tank-shots.flac)
// + looping drive (Sounds/187676__qubodup__driving-tank-engine.flac)
// + .50 cal loop (Sounds/151556__tcpp__machinegun-ish-9.wav, 2nd burst, period-crossfaded loop)
// + turret traverse (Sounds/171657__qubodup__tank-or-tower-turret-moving-and-turning.flac)
// + first-hit armor clang (Sounds/435681__eben-frostey__metallic-clang.mp3)
// + MG metal hit (Sounds/446128__justinvoke__metal-clank-4.wav — pitched-down variants)
// + in-game music (Sounds/Steel and Silence.mp3).
// + reload ready (Sounds/418882__kierankeegan__tank-reload.wav).
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
const MUSIC_VOL_DEFAULT = 0.35; // ~25% above prior 0.28
// Base rate (+20% vs sample); L/R offset ~1.5 semitones each way
const TURRET_BASE = 1.2;
const TURRET_PITCH = 0.09;

const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));

/**
 * Distance → 0..1 gain. Squared so far hits drop fast (linear floors were keeping
 * MG clanks audible across the whole ~250 m island). Returns 0 beyond `maxDist`.
 */
export function distGain(d, maxDist) {
  const t = Math.max(0, Math.min(1, 1 - d / maxDist));
  return t * t;
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
    this.ready = false;
    this._last = -1;
    this._ricoLast = -1;
    this._hitCool = 0;
    this._ricoCool = 0;
    this._active = new Set(); // retain one-shots until onended (avoids GC cutting tails)
    this._engine = null;
    this._engineGain = null;
    this._rate = 1;
    this._vol = 0;
    this._mg = null;
    this._mgGain = null;
    this._mgVol = 0;
    this._mgWant = false;
    this._turret = null;
    this._turretGain = null;
    this._turretVol = 0;
    this._turretRate = TURRET_BASE;
    this._music = null;
    this._musicGain = null;
    this._musicMuted = false;
    this._musicVol = MUSIC_VOL_DEFAULT;
  }

  async load() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    const decode = async (url) => {
      const res = await fetch(url);
      return this.ctx.decodeAudioData(await res.arrayBuffer());
    };
    const [shots, engine, mg, turret, hit, mgClank, music, nitro, reload] = await Promise.all([
      Promise.all(SHOT_URLS.map(decode)),
      decode(ENGINE_URL),
      decode(MG50_URL),
      decode(TURRET_URL),
      decode(HIT_URL),
      decode(MG_CLANK_URL),
      decode(MUSIC_URL),
      decode(NITRO_URL),
      decode(RELOAD_URL),
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
    this._musicGain.gain.value = this._musicMuted ? 0 : this._musicVol;
  }

  _ensureMusic() {
    if (!this.ready || !this.musicBuf || this._music) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.musicBuf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = this._musicMuted ? 0 : this._musicVol;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    this._music = src;
    this._musicGain = g;
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

  /** Play a random main-gun shot (avoids repeating the same clip twice in a row). */
  fire(volume = 0.9) {
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
    src.connect(g).connect(this.ctx.destination);
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
    // −20% playback rate for a deeper .50 cal read
    src.playbackRate.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    this._mg = src;
    this._mgGain = g;
  }

  /** Hold-to-fire .50 cal loop. Call each frame with pressed state. */
  setMgFire(on) {
    this._mgWant = !!on;
    if (on) {
      this.unlock();
      this._ensureMg();
    }
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
    this._ensureEngine();
    if (this._engine && this._engineGain) {
      const absSpd = Math.abs(speed);
      const spdT = Math.min(1, absSpd / maxSpeed);
      const throttleT = Math.min(1, Math.abs(throttle));
      const reversing = speed < -0.4 || throttle < -0.15;

      // idle floor so the engine is always faintly there once unlocked
      const activity = Math.max(spdT, throttleT * 0.85);
      const targetVol = 0.12 + activity * 0.55;

      let targetRate;
      if (reversing) {
        targetRate = 0.72 + spdT * 0.12;
      } else {
        targetRate = 0.92 + spdT * 0.28 + throttleT * 0.06;
      }

      this._vol = damp(this._vol, targetVol, 6, dt);
      this._rate = damp(this._rate, targetRate, 5, dt);
      this._engineGain.gain.value = this._vol;
      this._engine.playbackRate.value = this._rate;
    }

    this._ensureMg();
    if (this._mg && this._mgGain) {
      const target = this._mgWant ? 0.72 : 0;
      this._mgVol = damp(this._mgVol, target, this._mgWant ? 18 : 10, dt);
      this._mgGain.gain.value = this._mgVol;
    }

    this._ensureTurret();
    if (this._turret && this._turretGain) {
      // +slew = left (CCW); TRAVERSE ≈ 0.73 rad/s → normalize
      const slewT = Math.max(-1, Math.min(1, turretSlew / 0.7));
      const moving = Math.abs(slewT) > 0.04;
      if (moving) this.unlock();
      // −4 dB vs prior levels (× 10^(−4/20) ≈ 0.631)
      const targetVol = moving ? 0.177 + Math.abs(slewT) * 0.139 : 0;
      // left (− pitch) / right (+ pitch)
      const targetRate = TURRET_BASE - slewT * TURRET_PITCH;
      this._turretVol = damp(this._turretVol, targetVol, moving ? 14 : 8, dt);
      this._turretRate = damp(this._turretRate, targetRate, 10, dt);
      this._turretGain.gain.value = this._turretVol;
      this._turret.playbackRate.value = this._turretRate;
    }
  }
}
