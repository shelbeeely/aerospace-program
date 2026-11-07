import type { Telemetry } from './telemetry.ts';

/**
 * Pilot commands, independent of where they come from. Keyboard, gamepad, a replay file, an
 * autopilot, or (later) an LLM pilot all produce one of these per physics step.
 */
export interface ControlInputs {
  /** -1..1, +1 = nose up. */
  pitch: number;
  /** -1..1, +1 = roll right. */
  roll: number;
  /** -1..1, +1 = nose right (also steers the nose wheel). */
  yaw: number;
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
}

export function neutralControls(): ControlInputs {
  return { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 };
}

/**
 * Anything that can fly the craft. `sample` is called once per physics step with the latest
 * telemetry so closed-loop sources (autopilots, AI pilots) can react.
 */
export interface ControlSource {
  sample(dt: number, telemetry: Telemetry): ControlInputs;
}

export function sanitizeControls(c: ControlInputs): ControlInputs {
  const clamp = (v: number, lo: number, hi: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
  return {
    pitch: clamp(c.pitch, -1, 1),
    roll: clamp(c.roll, -1, 1),
    yaw: clamp(c.yaw, -1, 1),
    throttle: clamp(c.throttle, 0, 1),
    brake: clamp(c.brake, 0, 1),
  };
}
