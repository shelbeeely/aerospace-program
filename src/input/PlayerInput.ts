import type { ControlInputs, ControlSource } from '../sim/controls.ts';
import { TUNING } from '../tuning.ts';

/**
 * Raw per-device intent, all devices write into the same shape. A future touch device just
 * needs to implement `InputDevice` too.
 */
export interface RawInput {
  pitch: number; // -1..1, +1 = nose up
  roll: number;
  yaw: number;
  /** Throttle rate: -1 (decrease) .. +1 (increase) */
  throttleRate: number;
  /** If set, jump the throttle to this value (Z/X keys). */
  throttleSet: number | null;
  brake: number;
  trimRate: number; // -1 nose down .. +1 nose up
}

export type Action = 'reset' | 'camera' | 'debug' | 'help' | 'trimReset';

export interface InputDevice {
  /** Accumulate this device's intent into `raw` (devices are summed then clamped). */
  read(raw: RawInput): void;
  /** Edge-triggered actions since the last call. */
  drainActions(out: Action[]): void;
}

const GAME_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyB', 'KeyR', 'KeyC', 'KeyZ', 'KeyX',
  'KeyT', 'KeyG', 'KeyH', 'KeyY', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'F3',
  'Space',
]);

export class KeyboardDevice implements InputDevice {
  private readonly down = new Set<string>();
  private actions: Action[] = [];
  private throttleSet: number | null = null;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
      if (GAME_CODES.has(e.code)) e.preventDefault(); // stops Ctrl+S, F3 search, etc. where allowed
      if (e.repeat) return;
      this.down.add(e.code);
      switch (e.code) {
        case 'KeyR': this.actions.push('reset'); break;
        case 'KeyC': this.actions.push('camera'); break;
        case 'F3': this.actions.push('debug'); break;
        case 'KeyH': this.actions.push('help'); break;
        case 'KeyY': this.actions.push('trimReset'); break;
        case 'KeyZ': this.throttleSet = 1; break;
        case 'KeyX': this.throttleSet = 0; break;
      }
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    // Losing focus would otherwise leave keys "stuck".
    target.addEventListener('blur', () => this.down.clear());
  }

  private axis(neg: string, pos: string): number {
    return (this.down.has(pos) ? 1 : 0) - (this.down.has(neg) ? 1 : 0);
  }

  read(raw: RawInput): void {
    raw.pitch += this.axis('KeyW', 'KeyS'); // W = nose down, S = nose up (KSP / flight-sim style)
    raw.roll += this.axis('KeyA', 'KeyD');
    raw.yaw += this.axis('KeyQ', 'KeyE');
    const up = this.down.has('ShiftLeft') || this.down.has('ShiftRight');
    const dn = this.down.has('ControlLeft') || this.down.has('ControlRight');
    raw.throttleRate += (up ? 1 : 0) - (dn ? 1 : 0);
    if (this.down.has('KeyB') || this.down.has('Space')) raw.brake = 1;
    raw.trimRate += this.axis('KeyT', 'KeyG'); // T = nose-down trim, G = nose-up trim
    if (this.throttleSet !== null) {
      raw.throttleSet = this.throttleSet;
      this.throttleSet = null;
    }
  }

  drainActions(out: Action[]): void {
    out.push(...this.actions);
    this.actions = [];
  }
}

/** Standard-mapping gamepad (Xbox/PS layouts). */
export class GamepadDevice implements InputDevice {
  private prevButtons: boolean[] = [];
  private actions: Action[] = [];

  private pad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    for (const p of navigator.getGamepads()) if (p && p.connected) return p;
    return null;
  }

  private dz(v: number | undefined): number {
    if (v === undefined) return 0;
    const d = TUNING.gamepadDeadzone;
    return Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d);
  }

  read(raw: RawInput): void {
    const p = this.pad();
    if (!p) return;
    const b = (i: number) => p.buttons[i]?.pressed ?? false;
    const bv = (i: number) => p.buttons[i]?.value ?? 0;
    raw.roll += this.dz(p.axes[0]);
    raw.pitch += this.dz(p.axes[1]); // stick back (+) = nose up
    raw.yaw += this.dz(p.axes[2]);
    raw.yaw += bv(5) - bv(4) > 0.5 ? 1 : bv(4) - bv(5) > 0.5 ? -1 : 0; // bumpers
    raw.throttleRate += bv(7) - bv(6); // triggers
    if (b(0)) raw.brake = 1; // A / Cross
    raw.trimRate += (b(12) ? -1 : 0) + (b(13) ? 1 : 0); // d-pad up = nose-down trim

    const edge = (i: number, a: Action) => {
      if (b(i) && !this.prevButtons[i]) this.actions.push(a);
    };
    edge(3, 'reset'); // Y / Triangle
    edge(8, 'camera'); // Back / Select
    edge(9, 'help'); // Start
    this.prevButtons = p.buttons.map((x) => x.pressed);
  }

  drainActions(out: Action[]): void {
    out.push(...this.actions);
    this.actions = [];
  }
}

/**
 * Human pilot: merges devices, smooths stick inputs, integrates throttle and trim, and
 * exposes the result as a `ControlSource` (same interface an AI pilot implements).
 */
export class PlayerInput implements ControlSource {
  readonly devices: InputDevice[];
  throttle = 0;
  trim = 0;
  private readonly smoothed = { pitch: 0, roll: 0, yaw: 0 };
  private raw: RawInput = PlayerInput.emptyRaw();

  constructor(devices: InputDevice[]) {
    this.devices = devices;
  }

  static emptyRaw(): RawInput {
    return { pitch: 0, roll: 0, yaw: 0, throttleRate: 0, throttleSet: null, brake: 0, trimRate: 0 };
  }

  /** Poll devices once per rendered frame. */
  poll(): Action[] {
    this.raw = PlayerInput.emptyRaw();
    for (const d of this.devices) d.read(this.raw);
    if (this.raw.throttleSet !== null) this.throttle = this.raw.throttleSet;
    const actions: Action[] = [];
    for (const d of this.devices) d.drainActions(actions);
    return actions;
  }

  reset(): void {
    this.throttle = 0;
    this.smoothed.pitch = this.smoothed.roll = this.smoothed.yaw = 0;
  }

  sample(dt: number): ControlInputs {
    const r = this.raw;
    const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
    const k = 1 - Math.exp(-TUNING.inputSmoothing * dt);
    this.smoothed.pitch += (clamp1(r.pitch) - this.smoothed.pitch) * k;
    this.smoothed.roll += (clamp1(r.roll) - this.smoothed.roll) * k;
    this.smoothed.yaw += (clamp1(r.yaw) - this.smoothed.yaw) * k;
    this.throttle = Math.max(0, Math.min(1, this.throttle + clamp1(r.throttleRate) * TUNING.throttleRate * dt));
    this.trim = Math.max(-0.5, Math.min(0.5, this.trim + clamp1(r.trimRate) * TUNING.trimRate * dt));
    return {
      pitch: clamp1(this.smoothed.pitch + this.trim),
      roll: this.smoothed.roll,
      yaw: this.smoothed.yaw,
      throttle: this.throttle,
      brake: Math.min(1, r.brake),
    };
  }
}
