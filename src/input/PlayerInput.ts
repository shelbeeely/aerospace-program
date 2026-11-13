import type { ControlInputs, ControlSource } from '../sim/controls.ts';
import type { Telemetry } from '../sim/telemetry.ts';
import { TUNING } from '../tuning.ts';
import {
  loadInputSettings,
  saveInputSettings,
  type Action,
  type ControlProfile,
  type InputDevice,
  type InputSettings,
  type RawInput,
} from './types.ts';

export { GamepadDevice } from './GamepadDevice.ts';
export { KeyboardDevice } from './KeyboardDevice.ts';
export { TouchDevice } from './TouchDevice.ts';
export type { Action, ControlProfile, InputDevice, InputSettings, RawInput } from './types.ts';

/**
 * Human pilot: merges keyboard, gamepad and touch, smooths stick inputs, integrates throttle
 * and trim, and exposes the result as a `ControlSource` (same interface an AI pilot implements).
 */
export class PlayerInput implements ControlSource {
  readonly devices: InputDevice[];
  throttle = 0;
  trim = 0;
  /** Flap detent 0..FLAP_DETENTS (0 = up). */
  flapNotch = 0;
  static readonly FLAP_DETENTS = 3;
  /** Control layout for the current craft (rotorcraft use mode-2 sticks). */
  profile: ControlProfile = 'airplane';
  settings: InputSettings = loadInputSettings();
  private readonly smoothed = { pitch: 0, roll: 0, yaw: 0 };
  private raw: RawInput = PlayerInput.emptyRaw();

  constructor(devices: InputDevice[]) {
    this.devices = devices;
  }

  static emptyRaw(): RawInput {
    return { pitch: 0, roll: 0, yaw: 0, throttleRate: 0, throttleSet: null, brake: 0, trimRate: 0, flapSteps: 0, flapCycle: false, fire: false, fireAlt: false, hack: false, aimYaw: 0, aimPitch: 0 };
  }

  updateSettings(patch: Partial<InputSettings>): void {
    this.settings = { ...this.settings, ...patch };
    saveInputSettings(this.settings);
  }

  /** Poll devices once per rendered frame. */
  poll(): Action[] {
    this.raw = PlayerInput.emptyRaw();
    const ctx = { profile: this.profile, throttle: this.throttle, settings: this.settings };
    for (const d of this.devices) d.read(this.raw, ctx);
    if (this.raw.throttleSet !== null) this.throttle = this.raw.throttleSet;
    const max = PlayerInput.FLAP_DETENTS;
    if (this.raw.flapCycle) this.flapNotch = (this.flapNotch + 1) % (max + 1);
    this.flapNotch = Math.max(0, Math.min(max, this.flapNotch + this.raw.flapSteps));
    const actions: Action[] = [];
    for (const d of this.devices) d.drainActions(actions);
    return actions;
  }

  /** Weapon triggers held (from the last poll). */
  firing(): { primary: boolean; secondary: boolean; hack: boolean } {
    return { primary: this.raw.fire, secondary: this.raw.fireAlt, hack: this.raw.hack };
  }

  /** On foot (from the last sample): forward on W/stick-forward, turn on A/D, sidestep on Q/E. */
  walk(): { forward: number; turn: number; strafe: number } {
    return { forward: -this.smoothed.pitch, turn: this.smoothed.roll, strafe: this.smoothed.yaw };
  }

  /** Turret aim inputs (from the last poll), each -1..1. */
  aim(): { yaw: number; pitch: number } {
    const c = (v: number) => Math.max(-1, Math.min(1, v));
    return { yaw: c(this.raw.aimYaw), pitch: c(this.raw.aimPitch) };
  }

  /** Haptic feedback on every device that supports it (gamepad rumble, phone vibration). */
  rumble(strength: number, durationMs: number): void {
    if (!this.settings.haptics) return;
    for (const d of this.devices) d.rumble?.(strength, durationMs);
  }

  reset(): void {
    // Rotorcraft start with the collective lever down too; they spin up as you raise it.
    this.throttle = 0;
    this.flapNotch = 0;
    this.smoothed.pitch = this.smoothed.roll = this.smoothed.yaw = 0;
  }

  /** Ground vehicles: reversing (S held from a stop) until W or a forward roll ends it. */
  private reversing = false;

  /** `t` (optional): telemetry, so a ground vehicle's S can switch from braking to reverse. */
  sample(dt: number, t?: Telemetry): ControlInputs {
    const r = this.raw;
    const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
    const k = 1 - Math.exp(-TUNING.inputSmoothing * dt);
    this.smoothed.pitch += (clamp1(r.pitch) - this.smoothed.pitch) * k;
    this.smoothed.roll += (clamp1(r.roll) - this.smoothed.roll) * k;
    this.smoothed.yaw += (clamp1(r.yaw) - this.smoothed.yaw) * k;
    this.throttle = Math.max(0, Math.min(1, this.throttle + clamp1(r.throttleRate) * TUNING.throttleRate * dt));
    this.trim = Math.max(-0.5, Math.min(0.5, this.trim + clamp1(r.trimRate) * TUNING.trimRate * dt));
    if (this.profile === 'ground') {
      // Ground vehicles: W/stick-forward accelerates, S/stick-back brakes, A/D (or Q/E) steer;
      // the throttle lever still sets a cruise power.
      // S brakes while rolling forward; held from (nearly) a stop it drives backwards.
      const fwd = Math.max(0, -this.smoothed.pitch), back = Math.max(0, this.smoothed.pitch);
      const h = ((t?.heading ?? 0) * Math.PI) / 180;
      const vFwd = t ? t.velocity[0] * Math.sin(h) - t.velocity[2] * Math.cos(h) : 0;
      if (back > 0.3 && vFwd < 1.0 && r.brake === 0) this.reversing = true;
      if (back < 0.05 || fwd > 0.05) this.reversing = false;
      if (this.reversing) {
        return { pitch: 0, roll: 0, yaw: clamp1(this.smoothed.roll + this.smoothed.yaw), throttle: 0, brake: r.brake, flaps: 0, reverse: back };
      }
      return {
        pitch: 0,
        roll: 0,
        yaw: clamp1(this.smoothed.roll + this.smoothed.yaw),
        throttle: Math.max(this.throttle, fwd),
        brake: Math.min(1, Math.max(r.brake, back)),
        flaps: 0,
      };
    }
    return {
      pitch: clamp1(this.smoothed.pitch + this.trim),
      roll: this.smoothed.roll,
      yaw: this.smoothed.yaw,
      throttle: this.throttle,
      brake: Math.min(1, r.brake),
      flaps: this.flapNotch / PlayerInput.FLAP_DETENTS,
    };
  }
}
