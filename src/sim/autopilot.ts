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
  /** Largest vertical speed it will command (m/s). 6 = gentle (test cards); raise for steep climbs. */
  maxClimb = 6;
  rotateSpeed = 30;
  private prevPitch = 0;
  private prevRoll = 0;
  private speedIntegral = 0;
  /** Integral on pitch error: supplies the steady elevator trim a P/D loop can't. */
  private pitchIntegral = 0;
  /** Integral on vertical-speed error, in degrees of extra pitch. */
  private vsIntegral = 0;
  private first = true;

  constructor(targets: AutopilotTargets) {
    this.targets = { ...targets };
  }

  /** Smoothed crab angle (heading minus ground track), deg. */
  private crab = 0;

  /**
   * Lower-level flying for navigation modes: hold a vertical speed, a ground track (or a bank)
   * and an airspeed (or a fixed throttle). Same inner loops and controls as sample().
   */
  fly(dt: number, t: Telemetry, cmd: PlaneCommand): ControlInputs {
    const pitchRate = this.first ? 0 : (t.pitch - this.prevPitch) / dt;
    const rollRate = this.first ? 0 : wrap180(t.roll - this.prevRoll) / dt;
    this.prevPitch = t.pitch;
    this.prevRoll = t.roll;
    this.first = false;

    let throttle: number;
    if (cmd.throttle !== undefined) throttle = clamp(cmd.throttle, 0, 1);
    else {
      const speedErr = (cmd.speed ?? 50) - t.airspeed;
      this.speedIntegral = clamp(this.speedIntegral + speedErr * dt, -20, 20);
      throttle = clamp(0.5 + speedErr * 0.08 + this.speedIntegral * 0.02, 0, 1);
    }

    if (cmd.rollout && t.onGround) {
      this.vsIntegral = 0;
      this.pitchIntegral = 0;
      const steer = clamp(wrap180(cmd.rollout.heading - t.heading) * 0.12, -1, 1);
      return { pitch: -0.3, roll: 0, yaw: steer, throttle: cmd.throttle ?? 0, brake: cmd.rollout.brake, flaps: cmd.flaps };
    }

    const vsErr = cmd.vs - t.verticalSpeed;
    this.vsIntegral = clamp(this.vsIntegral + vsErr * dt * 0.6, -8, 10);
    const targetPitch = clamp(2 + this.vsIntegral + vsErr * 1.2, cmd.pitchMin ?? -10, cmd.pitchMax ?? 15);

    let targetRoll = cmd.roll ?? 0;
    if (cmd.roll === undefined && cmd.track !== undefined) {
      // Ground track from the velocity; the crab (heading - track) is what the wind costs.
      if (t.groundSpeed > 5) {
        const track = (Math.atan2(t.velocity[0], -t.velocity[2]) * 180) / Math.PI;
        this.crab += (clamp(wrap180(t.heading - track), -30, 30) - this.crab) * Math.min(1, dt * 0.5);
      }
      const maxBank = cmd.maxBank ?? 30;
      targetRoll = clamp(wrap180(cmd.track + this.crab - t.heading) * 1.2, -maxBank, maxBank);
    }

    const pitchErr = targetPitch - t.pitch;
    if (t.onGround) this.pitchIntegral = 0;
    else this.pitchIntegral = clamp(this.pitchIntegral + pitchErr * dt * 0.03, -0.6, 0.6);
    const pitch = clamp(pitchErr * 0.08 - pitchRate * 0.03 + this.pitchIntegral, -1, 1);
    const roll = clamp((targetRoll - t.roll) * 0.04 - rollRate * 0.01, -1, 1);
    const yaw = clamp(t.sideslip * 0.1, -1, 1);
    return { pitch, roll, yaw, throttle, brake: 0, flaps: cmd.flaps };
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
    const climbing = this.targets.altitude - t.altitude > 25;
    // Full power on the takeoff roll and in climbs; otherwise hold speed with throttle.
    const throttle =
      (t.onGround && t.airspeed < this.rotateSpeed) || (climbing && speedErr > -8)
        ? 1
        : clamp(0.5 + speedErr * 0.08 + this.speedIntegral * 0.02, 0, 1);

    let targetPitch: number;
    let targetRoll = 0;
    if (t.onGround && t.airspeed < this.rotateSpeed) {
      targetPitch = 0;
    } else if (t.altitude < 15 && t.verticalSpeed < 3) {
      targetPitch = 8; // initial climb-out
    } else {
      const altErr = this.targets.altitude - t.altitude;
      const desiredVs = clamp(altErr * 0.25, -this.maxClimb, this.maxClimb);
      const vsErr = desiredVs - t.verticalSpeed;
      this.vsIntegral = clamp(this.vsIntegral + vsErr * dt * 0.6, -8, 10);
      targetPitch = clamp(2 + this.vsIntegral + vsErr * 1.2, -10, 15);
      const hdgErr = wrap180(this.targets.heading - t.heading);
      targetRoll = clamp(hdgErr * 1.2, -30, 30);
    }

    const pitchErr = targetPitch - t.pitch;
    if (t.onGround) this.pitchIntegral = 0;
    else this.pitchIntegral = clamp(this.pitchIntegral + pitchErr * dt * 0.03, -0.6, 0.6);
    const pitch = clamp(pitchErr * 0.08 - pitchRate * 0.03 + this.pitchIntegral, -1, 1);
    const roll = t.onGround ? 0 : clamp((targetRoll - t.roll) * 0.04 - rollRate * 0.01, -1, 1);
    // Keep the ball centred; on the ground, steer with the rudder/nosewheel toward heading.
    const yaw = t.onGround
      ? clamp(wrap180(this.targets.heading - t.heading) * 0.1, -1, 1)
      : clamp(t.sideslip * 0.1, -1, 1); // sideslip > 0: air from the right, so right rudder

    return { pitch, roll, yaw, throttle, brake: 0 };
  }
}

/** Low-level command for {@link Autopilot.fly}: what to hold this step. */
export interface PlaneCommand {
  /** Vertical speed to hold (m/s, + up). */
  vs: number;
  /** Ground track to hold (deg); the current crab angle is added so wind doesn't push it off. */
  track?: number;
  /** Or an explicit bank angle (deg, + right). */
  roll?: number;
  /** Bank limit for track holding (deg, default 30). */
  maxBank?: number;
  /** Airspeed to hold with the throttle (m/s)... */
  speed?: number;
  /** ...or a fixed throttle 0..1. */
  throttle?: number;
  /** Pitch attitude limits (deg). */
  pitchMin?: number;
  pitchMax?: number;
  /** On the ground: hold the nose down and steer this heading with the rudder/nose wheel. */
  rollout?: { heading: number; brake: number };
  flaps?: number;
}

export interface HoverTargets {
  altitude: number;
  heading: number;
  /** Desired ground speed along the nose (m/s). Sideways speed is held at zero. */
  forwardSpeed: number;
}

/**
 * Autopilot for rotorcraft (with a flight controller in angle mode): throttle holds altitude
 * (0.5 ≈ hover), the stick holds velocity in the body frame, yaw holds heading. Same controls
 * a player uses.
 */
export class HoverPilot implements ControlSource {
  targets: HoverTargets;
  private altIntegral = 0;
  private prevHeading: number | null = null;

  constructor(targets: HoverTargets) {
    this.targets = { ...targets };
  }

  sample(dt: number, t: Telemetry): ControlInputs {
    const altErr = this.targets.altitude - t.altitude;
    this.altIntegral = clamp(this.altIntegral + altErr * dt * 0.01, -0.25, 0.25);
    const desiredVs = clamp(altErr * 0.5, -3, 4);
    const throttle = clamp(0.5 + (desiredVs - t.verticalSpeed) * 0.12 + this.altIntegral, 0, 1);

    const h = (t.heading * Math.PI) / 180;
    // Heading 0 = -Z. Forward = (sin h, -cos h), right = (cos h, sin h) in (x, z).
    const vx = t.velocity[0];
    const vz = t.velocity[2];
    const vFwd = vx * Math.sin(h) - vz * Math.cos(h);
    const vRight = vx * Math.cos(h) + vz * Math.sin(h);
    const pitch = clamp(-(this.targets.forwardSpeed - vFwd) * 0.12, -1, 1); // forward = nose down
    const roll = clamp(-vRight * 0.15, -1, 1);
    // Heading loop with rate damping (yaw rate from successive samples), so it settles instead
    // of swinging past the target.
    const yawRate = this.prevHeading === null ? 0 : wrap180(t.heading - this.prevHeading) / dt;
    this.prevHeading = t.heading;
    const yaw = clamp(wrap180(this.targets.heading - t.heading) * 0.03 - yawRate * 0.012, -1, 1);
    return { pitch, roll, yaw, throttle, brake: 0 };
  }
}
