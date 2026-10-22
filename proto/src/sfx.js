// Main-gun one-shots (chopped from Sounds/239135__qubodup__tank-shots.flac)
// + looping drive (Sounds/187676__qubodup__driving-tank-engine.flac)
// + .50 cal loop (Sounds/581771__hz37__machine-gun-hza-01-08-2021.wav, silence trimmed)
// + turret traverse (Sounds/171657__qubodup__tank-or-tower-turret-moving-and-turning.flac)
// + tank-on-tank hit (Sounds/337875__newagesoup__small-metal-hit-12.wav).
const SHOT_URLS = [
  './sounds/tank_shot_1.wav',
  './sounds/tank_shot_2.wav',
  './sounds/tank_shot_3.wav',
];
const ENGINE_URL = './sounds/tank_engine.wav';
const MG50_URL = './sounds/mg50_loop.wav';
const TURRET_URL = './sounds/turret_loop.wav';
const HIT_URL = './sounds/metal_hit.wav';
// Playback rate offset for left (−) / right (+); ~1.5 semitones each way
const TURRET_PITCH = 0.09;

const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));

export class Sfx {
  constructor() {
    this.ctx = null;
    this.shots = [];
    this.engineBuf = null;
    this.mgBuf = null;
    this.turretBuf = null;
    this.hitBuf = null;
    this.ready = false;
    this._last = -1;
    this._hitCool = 0;
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
    this._turretRate = 1;
  }

  async load() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    const decode = async (url) => {
      const res = await fetch(url);
      return this.ctx.decodeAudioData(await res.arrayBuffer());
    };
    const [shots, engine, mg, turret, hit] = await Promise.all([
      Promise.all(SHOT_URLS.map(decode)),
      decode(ENGINE_URL),
      decode(MG50_URL),
      decode(TURRET_URL),
      decode(HIT_URL),
    ]);
    this.shots = shots;
    this.engineBuf = engine;
    this.mgBuf = mg;
    this.turretBuf = turret;
    this.hitBuf = hit;
    this.ready = true;
  }

  /** Browsers block audio until a user gesture — call from click / pointer-lock. */
  unlock() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this._ensureEngine();
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

  /** Play a random main-gun shot (avoids repeating the same clip twice in a row). */
  fire(volume = 0.9) {
    if (!this.ready || !this.shots.length) return;
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
   * Tank-on-tank (or similar) metal hit. Call when you hit another tank or get hit.
   * `intensity` 0..1 scales volume; light pitch variance so repeats don't machine-gun.
   */
  hit(intensity = 1) {
    if (!this.ready || !this.hitBuf) return;
    if (this._hitCool > 0) return;
    this.unlock();
    const t = Math.max(0, Math.min(1, intensity));
    const src = this.ctx.createBufferSource();
    src.buffer = this.hitBuf;
    src.playbackRate.value = 0.94 + Math.random() * 0.12;
    const g = this.ctx.createGain();
    g.gain.value = 0.35 + t * 0.55;
    src.connect(g).connect(this.ctx.destination);
    this._active.add(src);
    src.onended = () => this._active.delete(src);
    src.start();
    this._hitCool = 0.08; // short debounce for contact chatter
  }

  _ensureMg() {
    if (!this.ready || !this.mgBuf || this._mg) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.mgBuf;
    src.loop = true;
    // ~3 semitones down for a deeper .50 cal read
    src.playbackRate.value = Math.pow(2, -3 / 12);
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    this._mg = src;
    this._mgGain = g;
  }

  /** Hold-to-fire .50 cal loop (chopped first burst). Call each frame with pressed state. */
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
      const targetVol = moving ? 0.28 + Math.abs(slewT) * 0.22 : 0;
      // left (− pitch) / right (+ pitch)
      const targetRate = 1 - slewT * TURRET_PITCH;
      this._turretVol = damp(this._turretVol, targetVol, moving ? 14 : 8, dt);
      this._turretRate = damp(this._turretRate, targetRate, 10, dt);
      this._turretGain.gain.value = this._turretVol;
      this._turret.playbackRate.value = this._turretRate;
    }
  }
}
