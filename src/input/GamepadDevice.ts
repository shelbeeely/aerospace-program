import { TUNING } from '../tuning.ts';
import { applyExpo, type Action, type InputContext, type InputDevice, type RawInput } from './types.ts';

/** Standard Gamepad API button indices (https://w3c.github.io/gamepad/#remapping). */
const B = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
} as const;

/** Human-readable mapping per profile, shown in the help panel. */
export const GAMEPAD_HELP: Record<'airplane' | 'rotorcraft', Array<[string, string]>> = {
  airplane: [
    ['Left stick', 'pitch / roll'],
    ['Right stick ↔ or LB/RB', 'yaw'],
    ['RT / LT', 'throttle up / down'],
    ['A (hold)', 'brakes'],
    ['D-pad ↑/↓', 'trim nose down / up'],
    ['L3', 'reset trim'],
    ['X', 'flaps (cycle detents)'],
  ],
  rotorcraft: [
    ['Left stick ↕', 'collective (centred = hover)'],
    ['Left stick ↔', 'yaw'],
    ['Right stick', 'tilt (pitch / roll)'],
    ['RT / LT', 'fine collective up / down'],
    ['A (hold)', 'brakes'],
  ],
};
export const GAMEPAD_COMMON: Array<[string, string]> = [
  ['Y', 'reset'],
  ['B', 'camera'],
  ['D-pad ←/→', 'previous / next craft'],
  ['Start', 'Studio'],
  ['Back / View', 'help'],
];

export interface PadInfo {
  id: string;
  index: number;
  standard: boolean;
}

/**
 * Gamepad API device. Uses the first connected pad with the "standard" mapping (Xbox,
 * PlayStation, Switch Pro, most Android/iOS pads in Chrome/Safari/Firefox). Profiles:
 * airplane (left stick flies), rotorcraft (mode 2: left stick collective/yaw, right stick
 * cyclic, like an RC transmitter).
 */
export class GamepadDevice implements InputDevice {
  private prevButtons: boolean[] = [];
  private actions: Action[] = [];
  private lastCollective: number | null = null;
  /** Called when a pad connects/disconnects (for UI toasts). */
  onChange: ((pad: PadInfo | null, connected: boolean) => void) | null = null;
  active: PadInfo | null = null;

  constructor(target: Window = window) {
    target.addEventListener('gamepadconnected', (e) => {
      const p = (e as GamepadEvent).gamepad;
      this.active = { id: p.id, index: p.index, standard: p.mapping === 'standard' };
      this.onChange?.(this.active, true);
    });
    target.addEventListener('gamepaddisconnected', (e) => {
      const p = (e as GamepadEvent).gamepad;
      if (this.active?.index === p.index) this.active = null;
      this.onChange?.({ id: p.id, index: p.index, standard: p.mapping === 'standard' }, false);
      this.prevButtons = [];
    });
  }

  private pad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    // Prefer the pad that announced itself, then any standard-mapped one, then anything.
    const list = Array.from(pads).filter((p): p is Gamepad => !!p && p.connected);
    const pick =
      list.find((p) => p.index === this.active?.index) ?? list.find((p) => p.mapping === 'standard') ?? list[0] ?? null;
    if (pick && !this.active) this.active = { id: pick.id, index: pick.index, standard: pick.mapping === 'standard' };
    return pick;
  }

  /** Radial deadzone on a stick (no square "cross" artefacts), then expo. */
  private stick(x: number | undefined, y: number | undefined, expo: number): [number, number] {
    const sx = x ?? 0;
    const sy = y ?? 0;
    const mag = Math.hypot(sx, sy);
    const dz = TUNING.gamepadDeadzone;
    if (mag < dz) return [0, 0];
    const scaled = Math.min(1, (mag - dz) / (1 - dz)) / mag;
    return [applyExpo(sx * scaled, expo), applyExpo(sy * scaled, expo)];
  }

  read(raw: RawInput, ctx: InputContext): void {
    const p = this.pad();
    if (!p) return;
    const pressed = (i: number) => p.buttons[i]?.pressed ?? false;
    const value = (i: number) => p.buttons[i]?.value ?? 0;
    const expo = ctx.settings.expo;
    const inv = ctx.settings.invertPitch ? -1 : 1;
    const [lx, ly] = this.stick(p.axes[0], p.axes[1], expo);
    const [rx, ry] = this.stick(p.axes[2], p.axes[3], expo);

    if (ctx.profile === 'rotorcraft') {
      // Mode 2. Left stick vertical is absolute collective, centred = hover. Only applied when
      // it changes, so the keyboard can still set throttle while the stick rests.
      const [, rawLy] = this.stick(0, p.axes[1], 0);
      const collective = Math.min(1, Math.max(0, 0.5 - 0.5 * rawLy));
      if (this.lastCollective === null || Math.abs(collective - this.lastCollective) > 0.01) {
        raw.throttleSet = collective;
        this.lastCollective = collective;
      }
      raw.yaw += lx;
      raw.roll += rx;
      raw.pitch += ry * inv; // stick back (down, +) = nose up
      raw.throttleRate += (value(B.RT) - value(B.LT)) * 0.5;
    } else {
      raw.roll += lx;
      raw.pitch += ly * inv; // stick back (down, +) = nose up
      raw.yaw += rx;
      raw.yaw += (pressed(B.RB) ? 1 : 0) - (pressed(B.LB) ? 1 : 0);
      raw.throttleRate += value(B.RT) - value(B.LT);
      raw.trimRate += (pressed(B.UP) ? -1 : 0) + (pressed(B.DOWN) ? 1 : 0);
      this.lastCollective = null;
    }
    if (pressed(B.A)) raw.brake = Math.max(raw.brake, value(B.A) || 1);

    const edge = (i: number, a: Action) => {
      if (pressed(i) && !this.prevButtons[i]) this.actions.push(a);
    };
    edge(B.Y, 'reset');
    edge(B.B, 'camera');
    // X cycles flaps (airplanes); craft cycling stays on the D-pad.
    if (pressed(B.X) && !this.prevButtons[B.X]) raw.flapCycle = true;
    edge(B.RIGHT, 'nextVehicle');
    edge(B.LEFT, 'prevVehicle');
    edge(B.START, 'studio');
    edge(B.BACK, 'help');
    edge(B.L3, 'trimReset');
    edge(B.R3, 'debug');
    this.prevButtons = p.buttons.map((x) => x.pressed);
  }

  drainActions(out: Action[]): void {
    out.push(...this.actions);
    this.actions = [];
  }

  rumble(strength: number, durationMs: number): void {
    const p = this.pad();
    if (!p) return;
    const s = Math.min(1, Math.max(0, strength));
    try {
      // Chrome/Edge/Safari: vibrationActuator. Firefox: hapticActuators.
      const act = (p as Gamepad & { vibrationActuator?: { playEffect: (t: string, o: object) => Promise<unknown> } }).vibrationActuator;
      if (act?.playEffect) {
        void act.playEffect('dual-rumble', { duration: durationMs, strongMagnitude: s, weakMagnitude: Math.min(1, s * 1.2) }).catch(() => {});
        return;
      }
      const h = (p as Gamepad & { hapticActuators?: Array<{ pulse: (v: number, d: number) => Promise<unknown> }> }).hapticActuators;
      void h?.[0]?.pulse(s, durationMs).catch(() => {});
    } catch {
      /* no haptics on this pad */
    }
  }
}
