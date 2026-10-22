// Keyboard + mouse (pointer lock) + gamepad. Gamepads use the browser's "standard" mapping, which is
// what Chrome/Edge/Safari give a DualSense (PS5) or Xbox pad:
//   axes 0/1 left stick, 2/3 right stick; buttons 4 L1, 5 R1, 6 L2, 7 R2, 9 Options, 10 L3, 11 R3.
const DEADZONE = 0.14;
const PAD_AIM_SPEED = 2.6;        // rad/s at full right-stick deflection
const MOUSE_SENS = 0.0022;        // rad per pixel

function stick(x, y) {
  const m = Math.hypot(x, y);
  if (m < DEADZONE) return [0, 0];
  const k = (m - DEADZONE) / (1 - DEADZONE) / m;
  return [x * k, y * k];
}

const NEUTRAL = Object.freeze({
  throttle: 0, turn: 0, boost: false,
  aimX: 0, aimY: 0, fire: false, mgFire: false, zoom: 0, zoomHold: false,
  padPressed: Object.freeze([]), pad: null,
});

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.mouseFire = false;
    this.mouseMg = false;
    this.locked = false;
    this.enabled = true; // false while Visuals editor (V) owns the cursor
    this.pad = null;
    this._padButtons = [];
    this.onPress = () => {};

    addEventListener('keydown', (e) => {
      if (!e.repeat) this.onPress(e.code);
      if (this.enabled) this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouseFire = false; this.mouseMg = false; });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.locked) { canvas.requestPointerLock(); return; }
      if (e.button === 0) this.mouseFire = true;
      if (e.button === 2) this.mouseMg = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseFire = false;
      if (e.button === 2) this.mouseMg = false;
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
      if (!this.locked) { this.mouseFire = false; this.mouseMg = false; }
    });
    addEventListener('gamepadconnected', (e) => { this.pad = e.gamepad.index; });
    addEventListener('gamepaddisconnected', (e) => { if (this.pad === e.gamepad.index) this.pad = null; });
  }

  /** Disconnect turret / drive / fire so UI (e.g. Visuals) can use the mouse. */
  setEnabled(on) {
    on = !!on;
    if (this.enabled === on) return;
    this.enabled = on;
    this.keys.clear();
    this.mouseFire = false;
    this.mouseMg = false;
    this.mouseDX = this.mouseDY = this.wheel = 0;
    if (!on && document.pointerLockElement) document.exitPointerLock();
  }

  gamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (this.pad != null && pads[this.pad]) return pads[this.pad];
    for (const p of pads) if (p && p.connected) { this.pad = p.index; return p; }
    return null;
  }

  rumble(strong, weak, ms) {
    const p = this.gamepad();
    p?.vibrationActuator?.playEffect?.('dual-rumble', {
      duration: ms, strongMagnitude: strong, weakMagnitude: weak,
    }).catch?.(() => {});
  }

  /** Sample everything once per frame. Aim deltas are in radians (yaw right = positive). */
  read(dt) {
    if (!this.enabled) {
      this.mouseDX = this.mouseDY = this.wheel = 0;
      return NEUTRAL;
    }
    const k = (c) => this.keys.has(c);
    let throttle = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
    let turn = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    let boost = k('ShiftLeft') || k('ShiftRight');
    let aimX = this.mouseDX * MOUSE_SENS;
    let aimY = this.mouseDY * MOUSE_SENS;
    let fire = this.mouseFire;
    let mgFire = this.mouseMg;
    let zoom = this.wheel;
    let zoomHold = false;
    this.mouseDX = this.mouseDY = this.wheel = 0;

    const pad = this.gamepad();
    const pressed = [];
    if (pad) {
      const [lx, ly] = stick(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      const [rx, ry] = stick(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
      const b = (i) => pad.buttons[i] ? pad.buttons[i].value : 0;
      if (Math.abs(ly) > Math.abs(throttle)) throttle = -ly;
      if (Math.abs(lx) > Math.abs(turn)) turn = lx;
      aimX += rx * PAD_AIM_SPEED * dt;
      aimY += ry * PAD_AIM_SPEED * dt;
      boost ||= b(4) > 0.5 || b(10) > 0.5;
      fire ||= b(7) > 0.5;
      mgFire ||= b(5) > 0.5; // R1
      zoomHold = b(6) > 0.5;
      pad.buttons.forEach((btn, i) => {
        if (btn.pressed && !this._padButtons[i]) pressed.push(i);
        this._padButtons[i] = btn.pressed;
      });
    }
    return { throttle, turn, boost, aimX, aimY, fire, mgFire, zoom, zoomHold, padPressed: pressed, pad };
  }
}
