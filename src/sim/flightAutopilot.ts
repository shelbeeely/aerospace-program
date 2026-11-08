import { obstacleTop } from '../world/structures.ts';
import { Autopilot, HoverPilot } from './autopilot.ts';
import type { ControlInputs, ControlSource } from './controls.ts';
import type { Telemetry } from './telemetry.ts';

export type AutopilotKind = 'airplane' | 'rotorcraft';

export interface AutopilotState {
  engaged: boolean;
  kind: AutopilotKind;
  heading: number;
  /** Selected altitude (m) and the altitude actually commanded (raised to clear buildings). */
  altitude: number;
  commanded: number;
  /** Airspeed (airplane) or forward ground speed (rotorcraft), m/s. */
  speed: number;
}

const wrap360 = (a: number) => ((a % 360) + 360) % 360;

/**
 * The player's autopilot: wraps the human pilot. Off, it passes the human through. Engaged, it
 * flies to a selected heading / altitude / speed (taking off by itself from the runway), and
 * the human's stick and throttle become the autopilot's knobs: pitch dials altitude, roll dials
 * heading, the throttle lever dials speed. It looks up to ~900 m ahead along the heading and
 * climbs to clear the tallest building there by 60 m, so it never flies into the Grid.
 * Braking on the ground disengages it.
 */
export class FlightAutopilot implements ControlSource {
  readonly state: AutopilotState = { engaged: false, kind: 'airplane', heading: 0, altitude: 300, commanded: 300, speed: 50 };
  private plane = new Autopilot({ heading: 0, altitude: 300, airspeed: 50 });
  private hover = new HoverPilot({ altitude: 30, heading: 0, forwardSpeed: 0 });
  private lastHumanThrottle = 0;
  private lastOutput: ControlInputs | null = null;
  /** Called when the autopilot disengages itself (to sync the human throttle lever). */
  onDisengage: ((throttle: number) => void) | null = null;

  constructor(private readonly human: ControlSource & { throttle?: number }) {}

  engage(t: Telemetry, kind: AutopilotKind): void {
    const s = this.state;
    s.engaged = true;
    s.kind = kind;
    s.heading = wrap360(t.heading);
    const grounded = t.onGround || t.altitude < 5;
    if (kind === 'airplane') {
      s.altitude = grounded ? 300 : Math.max(60, Math.round(t.altitude / 10) * 10);
      s.speed = Math.max(40, Math.round(t.airspeed));
      this.plane = new Autopilot({ heading: s.heading, altitude: s.altitude, airspeed: s.speed });
    } else {
      s.altitude = grounded ? 30 : Math.max(10, Math.round(t.altitude));
      s.speed = 0;
      this.hover = new HoverPilot({ altitude: s.altitude, heading: s.heading, forwardSpeed: 0 });
    }
    s.commanded = s.altitude;
    this.lastHumanThrottle = t.controls.throttle;
  }

  disengage(): void {
    if (!this.state.engaged) return;
    this.state.engaged = false;
    this.onDisengage?.(this.lastOutput?.throttle ?? 0);
  }

  sample(dt: number, t: Telemetry): ControlInputs {
    const human = this.human.sample(dt, t);
    const s = this.state;
    if (!s.engaged) {
      this.lastHumanThrottle = human.throttle;
      return human;
    }
    if (t.onGround && human.brake > 0.5) {
      this.disengage();
      return human;
    }
    // Stick and throttle turn the knobs.
    s.altitude = Math.min(6000, Math.max(s.kind === 'airplane' ? 60 : 5, s.altitude + human.pitch * 20 * dt));
    s.heading = wrap360(s.heading + human.roll * 25 * dt);
    const dThr = human.throttle - this.lastHumanThrottle;
    this.lastHumanThrottle = human.throttle;
    s.speed = s.kind === 'airplane' ? Math.min(250, Math.max(30, s.speed + dThr * 120)) : Math.min(25, Math.max(0, s.speed + dThr * 40));

    // Clear the buildings ahead along the selected heading.
    const h = (s.heading * Math.PI) / 180;
    // Look ahead ~12 s of flight (at least 300 m) through a 60 m wide corridor.
    const reach = s.kind === 'airplane' ? Math.max(300, t.groundSpeed * 12) : 150;
    let top = 0;
    for (let d = 0; d <= reach; d += 20) {
      const x = t.position[0] + Math.sin(h) * d;
      const z = t.position[2] - Math.cos(h) * d;
      for (const off of [-30, 0, 30]) top = Math.max(top, obstacleTop(x + Math.cos(h) * off, z + Math.sin(h) * off));
    }
    const margin = s.kind === 'airplane' ? 60 : 25;
    s.commanded = Math.max(s.altitude, top > 0 ? top + margin : 0);

    let out: ControlInputs;
    if (s.kind === 'airplane') {
      this.plane.targets = { heading: s.heading, altitude: s.commanded, airspeed: s.speed };
      // Climb as steeply as the speed allows (about 12°), more gently for ordinary changes.
      const urgent = s.commanded > s.altitude + 1;
      this.plane.maxClimb = Math.min(30, Math.max(6, t.airspeed * (urgent ? 0.21 : 0.12)));
      out = this.plane.sample(dt, t);
    } else {
      this.hover.targets = { altitude: s.commanded, heading: s.heading, forwardSpeed: s.speed };
      out = this.hover.sample(dt, t);
    }
    out = { ...out, flaps: human.flaps };
    this.lastOutput = out;
    return out;
  }
}
