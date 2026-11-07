import type { ControlInputs, ControlSource } from './controls.ts';
import type { Telemetry } from './telemetry.ts';

export interface AutopilotTargets {
  /** deg, 0 = -Z */
  heading: number;
  /** m above ground */
  altitude: number;
  /** m/s */
  airspeed: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/**
 * A deliberately simple PD/PI autopilot that turns high-level targets into stick inputs.
 * Used by the headless tests, and the intended bridge for slow, high-level pilots (e.g. an
 * LLM deciding "heading 090, 300 m, 50 m/s" every few seconds) to fly a fast physics sim.
 * It flies through the same controls as a human: no cheating forces.
 */
export class Autopilot implements ControlSource {
  targets: AutopilotTargets;
  rotateSpeed = 30;
  private prevPitch = 0;
  private prevRoll = 0;
  private speedIntegral = 0;
  private first = true;

  constructor(targets: AutopilotTargets) {
    this.targets = { ...targets };
  }

  sample(dt: number, t: Telemetry): ControlInputs {
    const pitchRate = this.first ? 0 : (t.pitch - this.prevPitch) / dt;
    const rollRate = this.first ? 0 : wrap180(t.roll - this.prevRoll) / dt;
    this.prevPitch = t.pitch;
    this.prevRoll = t.roll;
    this.first = false;

    // Speed: PI on throttle.
    const speedErr = this.targets.airspeed - t.airspeed;
    this.speedIntegral = clamp(this.speedIntegral + speedErr * dt, -20, 20);
    const throttle = t.onGround && t.airspeed < this.rotateSpeed ? 1 : clamp(0.5 + speedErr * 0.08 + this.speedIntegral * 0.02, 0, 1);

    let targetPitch: number;
    let targetRoll = 0;
    if (t.onGround && t.airspeed < this.rotateSpeed) {
      targetPitch = 0;
    } else if (t.altitude < 15 && t.verticalSpeed < 3) {
      targetPitch = 8; // initial climb-out
    } else {
      const altErr = this.targets.altitude - t.altitude;
      const desiredVs = clamp(altErr * 0.15, -6, 6);
      targetPitch = clamp(2 + (desiredVs - t.verticalSpeed) * 1.2, -10, 15);
      const hdgErr = wrap180(this.targets.heading - t.heading);
      targetRoll = clamp(hdgErr * 1.2, -30, 30);
    }

    const pitch = clamp((targetPitch - t.pitch) * 0.08 - pitchRate * 0.03, -1, 1);
    const roll = t.onGround ? 0 : clamp((targetRoll - t.roll) * 0.04 - rollRate * 0.01, -1, 1);
    // Keep the ball centred; on the ground, steer with the rudder/nosewheel toward heading.
    const yaw = t.onGround
      ? clamp(wrap180(this.targets.heading - t.heading) * 0.1, -1, 1)
      : clamp(-t.sideslip * 0.1, -1, 1);

    return { pitch, roll, yaw, throttle, brake: 0 };
  }
}
