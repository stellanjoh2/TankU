// Keyboard + mouse (pointer lock) + gamepad.
// Standard mapping (Chrome / Edge / Safari: Xbox, DualSense, Switch Pro):
//   LS drive · RS aim
//   R2/RT fires the selected gun · Triangle/Y switches gun
//   R1/RB hold: gadget wheel (RS picks; last slice latches if stick recenters; never aimed = cancel)
//   LT focus · LB smoke · L3 nitro
//   A unflip (freefly up) · B freefly down
//   D-pad up/right/down/left = smoke / air / repair / ship
//   Menu pause · View reset tank
// Mouse: LMB fires the selected gun, RMB switches it, hold R opens the wheel.
// getGamepads() is only called while a pad index is known. No pad → no poll.

const DEADZONE = 0.14;
const PAD_AIM_SPEED = 2.6;        // rad/s at full right-stick deflection
const MOUSE_SENS = 0.0022;        // rad per pixel

export const PAD = Object.freeze({
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  VIEW: 8, MENU: 9,
  L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
});

function stick(x, y) {
  const m = Math.hypot(x, y);
  if (m < DEADZONE) return [0, 0];
  const k = (m - DEADZONE) / (1 - DEADZONE) / m;
  return [x * k, y * k];
}

const NEUTRAL = Object.freeze({
  throttle: 0, turn: 0, boost: false, ascend: 0,
  aimX: 0, aimY: 0, fire: false, switchGun: false, zoom: 0, zoomHold: false,
  mouseX: 0, mouseY: 0,
  stickRX: 0, stickRY: 0,
  padPressed: Object.freeze([]), padReleased: Object.freeze([]), pad: null,
});

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.mouseFire = false;
    this._switchEdge = false;
    this.locked = false;
    this.enabled = true; // false while Visuals editor (V) owns the cursor
    this.pad = null; // index from gamepadconnected, or null when nothing is plugged in
    this._padButtons = [];
    this._padBlock = []; // holds that were already down when gameplay input turned back on
    this._armPad = false;
    this._rumbleUntil = 0;
    this._rumbleMag = 0;
    this.onPress = () => {};
    this.onRelease = () => {};

    addEventListener('keydown', (e) => {
      if (!e.repeat) this.onPress(e.code);
      // Keep F3 from opening the browser Find UI when we use it as debug toggle
      if (e.code === 'F3') e.preventDefault();
      if (this.enabled) this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.onRelease(e.code);
    });
    addEventListener('blur', () => { this.keys.clear(); this.mouseFire = false; this._switchEdge = false; });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.locked) { canvas.requestPointerLock(); return; }
      if (e.button === 0) this.mouseFire = true;
      if (e.button === 2) this._switchEdge = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseFire = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    canvas.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.mouseFire = false;
    });
    addEventListener('gamepadconnected', (e) => { this.pad = e.gamepad.index; });
    addEventListener('gamepaddisconnected', (e) => {
      if (this.pad !== e.gamepad.index) return;
      this.pad = null;
      // One-shot handoff if another pad is still plugged in. Not a per-frame poll.
      const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : null;
      if (!pads) return;
      const dropped = e.gamepad.index;
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p?.connected && p.index !== dropped) {
          this.pad = p.index;
          this._padButtons.length = 0;
          break;
        }
      }
    });
  }

  /** Disconnect turret / drive / fire so UI (e.g. Visuals) can use the mouse. */
  setEnabled(on) {
    on = !!on;
    if (this.enabled === on) return;
    this.enabled = on;
    this.keys.clear();
    this.mouseFire = false;
    this._switchEdge = false;
    this.mouseDX = this.mouseDY = this.wheel = 0;
    // Buttons still held as the pause menu closes must not fire, boost, or zoom.
    if (on) this._armPad = true;
    if (!on && document.pointerLockElement) document.exitPointerLock();
  }

  /** Live pad, or null. Does not call getGamepads() unless a pad has connected. */
  gamepad() {
    if (this.pad == null || typeof navigator.getGamepads !== 'function') return null;
    const p = navigator.getGamepads()[this.pad];
    return p?.connected ? p : null;
  }

  /**
   * Dual-rumble. `strong` is the low-frequency motor, `weak` the high-frequency one (0..1).
   * No pad connected → no haptic call. A lighter effect does not cut off a heavier one.
   */
  rumble(strong, weak, ms) {
    if (this.pad == null) return;
    strong = Math.max(0, Math.min(1, strong));
    weak = Math.max(0, Math.min(1, weak));
    const duration = Math.max(0, ms | 0);
    if (!duration) return;
    const now = performance.now();
    const mag = Math.max(strong, weak);
    if (now < this._rumbleUntil && mag < this._rumbleMag - 0.04) return;
    const p = this.gamepad();
    const act = p?.vibrationActuator || p?.hapticActuators?.[0];
    if (!act) return;
    const params = { startDelay: 0, duration, strongMagnitude: strong, weakMagnitude: weak };
    const pulse = () => act.pulse?.(mag, duration);
    if (typeof act.playEffect === 'function') {
      try {
        const pending = act.playEffect('dual-rumble', params);
        pending?.catch?.((err) => {
          if (err?.name === 'NotSupportedError' || /not supported/i.test(err?.message || '')) pulse();
        });
      } catch {
        pulse();
      }
    } else {
      pulse();
    }
    this._rumbleUntil = now + duration;
    this._rumbleMag = mag;
  }

  _pollButtons(pad) {
    const pressed = [];
    const released = [];
    if (!pad) {
      for (let i = 0; i < this._padButtons.length; i++) {
        if (this._padButtons[i]) released.push(i);
      }
      this._padButtons.length = 0;
      this._padBlock.length = 0;
      this._armPad = false;
      return { pressed, released };
    }
    if (this._armPad) {
      this._armPad = false;
      for (let i = 0; i < pad.buttons.length; i++) {
        const down = pad.buttons[i]?.pressed === true;
        this._padButtons[i] = down;
        this._padBlock[i] = down;
      }
    }
    const n = pad.buttons.length;
    for (let i = 0; i < n; i++) {
      const down = pad.buttons[i]?.pressed === true;
      if (this._padBlock[i]) {
        if (!down) this._padBlock[i] = false;
        this._padButtons[i] = down;
        continue;
      }
      if (down && !this._padButtons[i]) pressed.push(i);
      else if (!down && this._padButtons[i]) released.push(i);
      this._padButtons[i] = down;
    }
    return { pressed, released };
  }

  /** Button edges plus left-stick Y. Used while gameplay input is off so the pause menu can move. */
  readPadPresses() {
    const pad = this.gamepad();
    const { pressed, released } = this._pollButtons(pad);
    const stickLY = pad ? stick(pad.axes[0] ?? 0, pad.axes[1] ?? 0)[1] : 0;
    return { padPressed: pressed, padReleased: released, pad, stickLY };
  }

  /** Sample everything once per frame. Aim deltas are in radians (yaw right = positive). */
  read(dt) {
    if (!this.enabled) {
      this.mouseDX = this.mouseDY = this.wheel = 0;
      this._switchEdge = false;
      return { ...NEUTRAL, ...this.readPadPresses() };
    }
    const k = (c) => this.keys.has(c);
    let throttle = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
    let turn = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    let ascend = (k('Space') || k('KeyE') ? 1 : 0) - (k('ControlLeft') || k('ControlRight') || k('KeyQ') ? 1 : 0);
    let boost = k('ShiftLeft') || k('ShiftRight');
    let aimX = this.mouseDX * MOUSE_SENS;
    let aimY = this.mouseDY * MOUSE_SENS;
    const mouseX = this.mouseDX;
    const mouseY = this.mouseDY;
    let fire = this.mouseFire;
    const switchGun = this._switchEdge;
    this._switchEdge = false;
    let zoom = this.wheel;
    let zoomHold = k('KeyF'); // Focus: hold to zoom. Drive and fire stay live.
    this.mouseDX = this.mouseDY = this.wheel = 0;

    const pad = this.gamepad();
    const { pressed, released } = this._pollButtons(pad);
    let stickRX = 0;
    let stickRY = 0;
    if (pad) {
      const [lx, ly] = stick(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      const [rx, ry] = stick(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
      stickRX = rx;
      stickRY = ry;
      const b = (i) => (this._padBlock[i] || !pad.buttons[i]) ? 0 : pad.buttons[i].value;
      if (Math.abs(ly) > Math.abs(throttle)) throttle = -ly;
      if (Math.abs(lx) > Math.abs(turn)) turn = lx;
      // A up, B down — freefly only (tank ignores ascend).
      const padUp = b(PAD.A) - b(PAD.B);
      if (Math.abs(padUp) > Math.abs(ascend)) ascend = padUp;
      aimX += rx * PAD_AIM_SPEED * dt;
      aimY += ry * PAD_AIM_SPEED * dt;
      boost ||= b(PAD.L3) > 0.5;
      fire ||= b(PAD.RT) > 0.5;
      zoomHold = zoomHold || b(PAD.LT) > 0.5;
    }
    return {
      throttle, turn, ascend, boost, aimX, aimY, fire, switchGun, zoom, zoomHold,
      mouseX, mouseY, stickRX, stickRY,
      padPressed: pressed, padReleased: released, pad,
    };
  }
}
