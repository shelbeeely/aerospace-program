import { obstacleTop } from '../world/structures.ts';
import { Autopilot, HoverPilot, type PlaneCommand } from './autopilot.ts';
import type { ControlInputs, ControlSource } from './controls.ts';
import type { LandingSite } from './layout.ts';
import {
  approachFrame,
  approachPoint,
  bearing,
  chooseApproach,
  clamp,
  delta,
  destination as findDestination,
  distance,
  headingVector,
  IF_DISTANCE,
  initialFixHeight,
  glideslopeHeight,
  localizerTrack,
  makeApproach,
  nearestPad,
  nearestRunway,
  obstacleAhead,
  siteElevation,
  siteUsable,
  TAN_GS,
  turnRadius,
  wrap180,
  wrap360,
  landingDistanceNeeded,
  type Approach,
  type Destination,
} from './nav.ts';
import type { Telemetry } from './telemetry.ts';
import { terrainHeight } from './terrain.ts';

export type AutopilotKind = 'airplane' | 'rotorcraft';
export type AutopilotMode = 'hold' | 'takeoff' | 'land' | 'goto' | 'orbit' | 'level';
export type AutopilotPhase =
  | 'hold' | 'takeoff' | 'climb' | 'cruise' | 'orbit' | 'level'
  | 'join' | 'final' | 'flare' | 'rollout'
  | 'transit' | 'approach' | 'descend'
  | 'landed';

/** Airplane modes in panel order, and the rotorcraft subset. */
export const AIRPLANE_MODES: readonly AutopilotMode[] = ['hold', 'takeoff', 'land', 'goto', 'orbit', 'level'];
export const ROTORCRAFT_MODES: readonly AutopilotMode[] = ['hold', 'takeoff', 'goto', 'land'];
export const MODE_LABELS: Record<AutopilotMode, string> = { hold: 'Hold', takeoff: 'Takeoff', land: 'Land', goto: 'Go to', orbit: 'Orbit', level: 'Level' };

/** Approach guidance while landing (and distance/ETA while going somewhere). */
export interface AutopilotGuidance {
  /** To the touchdown point / destination (m). */
  distance: number;
  /** Height above (+) or below (-) the glideslope (m); null off the approach. */
  glideslopeDev: number | null;
  /** Right (+) or left (-) of the extended centreline (m); null off the approach. */
  localizerDev: number | null;
  /** Speed the computer is flying (m/s). */
  targetSpeed: number;
  /** Seconds to the touchdown point / destination at the current ground speed. */
  eta: number;
  siteName: string;
}

export interface AutopilotState {
  engaged: boolean;
  kind: AutopilotKind;
  mode: AutopilotMode;
  phase: AutopilotPhase;
  heading: number;
  /** Selected altitude (m) and the altitude actually commanded (raised to clear buildings). */
  altitude: number;
  commanded: number;
  /** Airspeed (airplane) or forward ground speed (rotorcraft), m/s. */
  speed: number;
  /** Vertical-speed hold (m/s) in Hold mode, or null to hold the altitude. */
  vs: number | null;
  /** Destination id (Go to / Land), or null for the nearest suitable site. */
  destination: string | null;
  /** Orbit radius (m). */
  orbitRadius: number;
  guidance: AutopilotGuidance | null;
  /** One line describing what the computer is doing. */
  status: string;
  /** Why the last request could not be flown as asked (e.g. no runway long enough), else ''. */
  notice: string;
}

/** What the panel (or a script) asks for when engaging. */
export interface AutopilotOptions {
  mode?: AutopilotMode;
  heading?: number;
  altitude?: number;
  speed?: number;
  vs?: number | null;
  destination?: string | null;
  orbitRadius?: number;
}

/** Performance numbers the computer needs (from analyzeDesign). */
export interface AutopilotPerf {
  stallSpeed: number;
}

const r0 = (x: number) => Math.round(x);
/** Extra nose-up pitch (deg) the flare blends in by touchdown. */
const FLARE_PITCH = 4;
/** Extra elevator per degree of pitch error in the flare. */
const FLARE_GAIN = 0.1;
/** Flap setting on final, in the flare and on the ground. */
const LANDING_FLAPS = 1;
const hdg3 = (h: number) => r0(wrap360(h)).toString().padStart(3, '0');
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${r0(m)} m`);
/** Runway designator for a landing heading: 0 → "36", 90 → "09". */
export const runwayNumber = (h: number) => (r0(wrap360(h) / 10) || 36).toString().padStart(2, '0');

/**
 * The player's flight computer (MechJeb-style). Off, it passes the human through. Engaged, it
 * flies one of several modes through the same controls a human has (Autopilot.fly /
 * HoverPilot underneath):
 * - Hold: heading / altitude (or vertical speed) / speed; takes off by itself from a runway.
 *   The stick and throttle are its knobs: pitch dials altitude (or V/S), roll heading, the
 *   throttle lever speed.
 * - Takeoff: to the selected altitude, then Hold.
 * - Land: airplanes to a runway (join → initial fix → 3° glideslope with a localizer →
 *   flare → rollout → stopped); rotorcraft to any helipad, rooftops included.
 * - Go to: a named destination, climbing over buildings and terrain; airplanes then Orbit it.
 * - Orbit: a right-hand circle; Level: wings level, V/S 0, the human keeps the throttle.
 * It looks ahead along its track and climbs to clear the tallest obstacle there. Braking on
 * the ground disengages it; outside Hold, so does a firm stick input.
 */
export class FlightAutopilot implements ControlSource {
  readonly state: AutopilotState = {
    engaged: false, kind: 'airplane', mode: 'hold', phase: 'hold', heading: 0, altitude: 300, commanded: 300, speed: 50,
    vs: null, destination: null, orbitRadius: 500, guidance: null, status: 'Off', notice: '',
  };
  private plane = new Autopilot({ heading: 0, altitude: 300, airspeed: 50 });
  private hover = new HoverPilot({ altitude: 30, heading: 0, forwardSpeed: 0 });
  private lastHumanThrottle = 0;
  private lastOutput: ControlInputs | null = null;
  private stallSpeed = 30;
  private perfKnown = false;
  /** Landing / go-to target and its runway approach. */
  private dest: Destination | null = null;
  private approach: Approach | null = null;
  private ifHeight = 150;
  private joinFar = false;
  private touchdownAt = -1;
  private flarePitch = 0;
  /** On final: lined up with the runway (full flaps, approach speed). */
  private established = false;
  private flareThrottle = 0;
  private orbitCenter: [number, number] = [0, 0];
  private orbitFloor = 0;
  private padHeading = 0;
  /** Fractured structure groups (rooftop pads on them are unusable). */
  fractured: { has(group: number): boolean } | null = null;
  /** Called when the autopilot disengages itself (to sync the human throttle lever). */
  onDisengage: ((throttle: number) => void) | null = null;

  constructor(private readonly human: ControlSource & { throttle?: number }) {}

  /** The runway approach being flown (Land mode, airplanes), or null. */
  get landingApproach(): Approach | null {
    return this.approach;
  }

  /** Approach speed (m/s): 1.3 × the stall speed. */
  get approachSpeed(): number {
    return 1.3 * this.stallSpeed;
  }

  /**
   * Engage (or switch mode while engaged). Without options: Hold at the current heading,
   * altitude and speed (a climb to 300 m from the runway).
   */
  engage(t: Telemetry, kind: AutopilotKind, perf?: AutopilotPerf, opts: AutopilotOptions = {}): void {
    const s = this.state;
    const wasEngaged = s.engaged;
    s.engaged = true;
    s.kind = kind;
    if (perf && Number.isFinite(perf.stallSpeed) && perf.stallSpeed > 0) {
      this.stallSpeed = perf.stallSpeed;
      this.perfKnown = true;
    } else if (!wasEngaged && !this.perfKnown && kind === 'airplane' && !t.onGround) this.stallSpeed = clamp(t.airspeed / 1.7, 15, 80);
    s.mode = opts.mode ?? 'hold';
    if (kind === 'rotorcraft' && (s.mode === 'orbit' || s.mode === 'level')) s.mode = 'hold';
    s.heading = wrap360(opts.heading ?? t.heading);
    const grounded = t.onGround || t.altitude < 5;
    if (kind === 'airplane') {
      s.altitude = opts.altitude ?? (grounded ? 300 : Math.max(60, Math.round(t.altitude / 10) * 10));
      s.speed = opts.speed ?? Math.max(40, Math.round(t.airspeed));
      if (opts.speed === undefined && grounded && this.perfKnown) s.speed = Math.max(s.speed, Math.round(this.stallSpeed * 1.6));
      this.plane = new Autopilot({ heading: s.heading, altitude: s.altitude, airspeed: s.speed });
      this.plane.rotateSpeed = clamp(this.stallSpeed * 1.15, 12, 90);
    } else {
      s.altitude = opts.altitude ?? (grounded ? 30 : Math.max(10, Math.round(t.altitude)));
      s.speed = opts.speed ?? (s.mode === 'goto' || s.mode === 'land' ? 15 : 0);
      this.hover = new HoverPilot({ altitude: s.altitude, heading: s.heading, forwardSpeed: 0 });
    }
    s.vs = opts.vs === undefined ? (s.mode === 'hold' ? null : s.vs) : opts.vs;
    if (s.mode !== 'hold') s.vs = null;
    if (opts.destination !== undefined) s.destination = opts.destination;
    if (opts.orbitRadius !== undefined) s.orbitRadius = clamp(opts.orbitRadius, 150, 5000);
    s.commanded = s.altitude;
    s.guidance = null;
    s.notice = '';
    this.dest = null;
    this.approach = null;
    this.touchdownAt = -1;
    this.lastHumanThrottle = t.controls.throttle;
    this.startMode(t);
  }

  disengage(): void {
    if (!this.state.engaged) return;
    this.state.engaged = false;
    this.state.guidance = null;
    this.state.status = 'Off';
    this.onDisengage?.(this.lastOutput?.throttle ?? 0);
  }

  /** Set up the selected mode's targets and first phase. */
  private startMode(t: Telemetry): void {
    const s = this.state;
    const air = s.kind === 'airplane';
    const grounded = t.onGround || t.altitude < 5;
    switch (s.mode) {
      case 'hold':
        s.phase = grounded ? 'takeoff' : 'hold';
        break;
      case 'takeoff':
        s.phase = grounded ? 'takeoff' : 'climb';
        break;
      case 'level':
        s.phase = 'level';
        break;
      case 'orbit': {
        // Around the destination if one is set, else a circle starting where we are.
        const d = s.destination ? findDestination(s.destination) : undefined;
        if (d) this.orbitCenter = [d.x, d.z];
        else {
          const [fx, fz] = headingVector(t.heading + 90);
          this.orbitCenter = [t.position[0] + fx * s.orbitRadius, t.position[2] + fz * s.orbitRadius];
        }
        this.dest = d ?? null;
        this.orbitFloor = this.ringClearance(this.orbitCenter[0], this.orbitCenter[1], s.orbitRadius);
        s.phase = 'orbit';
        break;
      }
      case 'goto': {
        const d = s.destination ? findDestination(s.destination) : undefined;
        if (!d) {
          s.mode = 'hold';
          s.phase = grounded ? 'takeoff' : 'hold';
          s.notice = s.status = 'Go to: no destination selected';
          return;
        }
        this.dest = d;
        s.phase = grounded && air ? 'takeoff' : 'cruise';
        break;
      }
      case 'land':
        if (air) this.startAirplaneLanding(t);
        else this.startRotorLanding(t);
        break;
    }
  }

  private startAirplaneLanding(t: Telemetry): void {
    const s = this.state;
    const vapp = this.approachSpeed;
    let site: LandingSite | null = null;
    if (s.destination) {
      const d = findDestination(s.destination);
      if (d?.site?.kind === 'runway') site = d.site;
    }
    site ??= nearestRunway(t.position[0], t.position[2], vapp);
    if (!site) {
      s.mode = 'hold';
      s.phase = 'hold';
      s.notice = s.status = `Land: no runway long enough (needs ${r0(landingDistanceNeeded(vapp))} m)`;
      return;
    }
    if (t.onGround && t.groundSpeed < 1) {
      s.phase = 'landed';
      this.dest = { id: site.id, name: site.name, kind: 'runway', x: site.x, z: site.z, y: site.y, site };
      this.approach = makeApproach(site, t.heading);
      return;
    }
    this.dest = { id: site.id, name: site.name, kind: 'runway', x: site.x, z: site.z, y: site.y, site };
    this.approach = chooseApproach(site, t.position[0], t.position[2], t.wind);
    this.ifHeight = initialFixHeight(this.approach);
    this.joinFar = false;
    s.phase = 'join';
  }

  private startRotorLanding(t: Telemetry): void {
    const s = this.state;
    let site: LandingSite | null = null;
    if (s.destination) {
      const d = findDestination(s.destination);
      if (d?.site && siteUsable(d.site, this.fractured ?? undefined)) site = d.site;
    }
    site ??= nearestPad(t.position[0], t.position[2], this.fractured ?? undefined);
    if (!site) {
      s.mode = 'hold';
      s.phase = 'hold';
      s.notice = s.status = 'Land: no usable helipad';
      return;
    }
    this.dest = { id: site.id, name: site.name, kind: site.kind, x: site.x, z: site.z, y: site.y, site };
    this.padHeading = t.heading;
    s.phase = t.onGround && distance(t.position[0], t.position[2], site.x, site.z) < site.width ? 'landed' : 'transit';
  }

  sample(dt: number, t: Telemetry): ControlInputs {
    const human = this.human.sample(dt, t);
    const s = this.state;
    if (!s.engaged) {
      this.lastHumanThrottle = human.throttle;
      return human;
    }
    if (t.onGround && human.brake > 0.5 && s.phase !== 'landed') {
      this.disengage();
      return human;
    }
    // Outside Hold, a firm hand on the stick takes over.
    if (s.mode !== 'hold' && (Math.abs(human.pitch) > 0.6 || Math.abs(human.roll) > 0.6)) {
      this.disengage();
      return human;
    }
    const dThr = human.throttle - this.lastHumanThrottle;
    this.lastHumanThrottle = human.throttle;
    const air = s.kind === 'airplane';
    if (s.mode === 'hold' || s.mode === 'takeoff' || s.mode === 'goto' || s.mode === 'orbit') {
      // Stick and throttle turn the knobs (pitch: altitude or V/S; roll: heading; lever: speed).
      if (s.vs !== null) s.vs = clamp(s.vs + human.pitch * 2 * dt, -30, 30);
      else s.altitude = Math.min(6000, Math.max(air ? 60 : 5, s.altitude + human.pitch * 20 * dt));
      if (s.mode === 'hold' || s.mode === 'takeoff') s.heading = wrap360(s.heading + human.roll * 25 * dt);
      s.speed = air ? Math.min(250, Math.max(30, s.speed + dThr * 120)) : Math.min(25, Math.max(0, s.speed + dThr * 40));
    }

    let out: ControlInputs;
    if (air) out = this.flyAirplane(dt, t, human);
    else out = this.flyRotorcraft(dt, t);
    this.lastOutput = out;
    return out;
  }

  // ---------------------------------------------------------------- airplane

  private flyAirplane(dt: number, t: Telemetry, human: ControlInputs): ControlInputs {
    const s = this.state;
    switch (s.mode) {
      case 'land':
        return this.flyLanding(dt, t);
      case 'level': {
        s.guidance = null;
        s.status = 'Level · wings level, V/S 0';
        return this.plane.fly(dt, t, { vs: 0, roll: 0, throttle: human.throttle, flaps: human.flaps });
      }
      case 'orbit':
        return this.flyOrbit(dt, t, human);
      case 'goto':
        if (s.phase !== 'takeoff') return this.flyGoto(dt, t, human);
      // fallthrough: take off first
      default:
        return this.flyHold(dt, t, human);
    }
  }

  /** Hold / Takeoff: heading, altitude (or V/S) and speed, from the runway if need be. */
  private flyHold(dt: number, t: Telemetry, human: ControlInputs): ControlInputs {
    const s = this.state;
    if (s.phase === 'takeoff' && !t.onGround && t.altitude > 30) s.phase = 'climb';
    if (s.mode === 'goto' && s.phase === 'climb') s.phase = 'cruise';
    if (s.phase === 'climb' && s.mode === 'hold') s.phase = 'hold';
    const top = this.clearance(t, s.heading, Math.max(300, t.groundSpeed * 12), 30);
    s.commanded = Math.max(s.altitude, top > 0 ? top + 60 : 0);
    if (s.mode === 'takeoff' && s.phase === 'climb' && Math.abs(t.altitude - s.altitude) < 15) {
      s.mode = 'hold';
      s.phase = 'hold';
    }
    s.guidance = null;
    let out: ControlInputs;
    if (s.vs !== null && !t.onGround && s.commanded <= s.altitude + 1) {
      out = this.plane.fly(dt, t, { vs: s.vs, track: s.heading, speed: s.speed, pitchMin: -15, pitchMax: 18 });
      s.status = `Hold · HDG ${hdg3(s.heading)} · V/S ${s.vs >= 0 ? '+' : ''}${s.vs.toFixed(1)} m/s · ${(s.speed * 1.944).toFixed(0)} kt`;
    } else {
      this.plane.targets = { heading: s.heading, altitude: s.commanded, airspeed: s.speed };
      // Climb as steeply as the speed allows (about 12°), more gently for ordinary changes.
      const urgent = s.commanded > s.altitude + 1;
      this.plane.maxClimb = Math.min(30, Math.max(6, t.airspeed * (urgent ? 0.21 : 0.12)));
      out = this.plane.sample(dt, t);
      const label = s.mode === 'takeoff' ? 'Takeoff' : s.mode === 'goto' ? 'Go to' : 'Hold';
      s.status = `${label} · ${s.phase === 'takeoff' ? 'take-off roll · ' : ''}HDG ${hdg3(s.heading)} · ${r0(s.altitude)} m · ${(s.speed * 1.944).toFixed(0)} kt`;
    }
    return { ...out, flaps: human.flaps };
  }

  /** Vertical speed toward an absolute target height (m above the street). */
  private vsToward(t: Telemetry, target: number, maxClimb: number, maxDescent = 8): number {
    const h = t.altitude + terrainHeight(t.position[0], t.position[2]);
    return clamp((target - h) * 0.25, -maxDescent, maxClimb);
  }

  private climbLimit(t: Telemetry, urgent: boolean): number {
    return Math.min(30, Math.max(5, t.airspeed * (urgent ? 0.21 : 0.12)));
  }

  /** Go to: direct to the destination over the obstacles, then Orbit it. */
  private flyGoto(dt: number, t: Telemetry, human: ControlInputs): ControlInputs {
    const s = this.state;
    const d = this.dest!;
    const dist = distance(t.position[0], t.position[2], d.x, d.z);
    const brg = bearing(t.position[0], t.position[2], d.x, d.z);
    if (dist < s.orbitRadius + 150) {
      s.mode = 'orbit';
      this.orbitCenter = [d.x, d.z];
      this.orbitFloor = this.ringClearance(d.x, d.z, s.orbitRadius);
      s.phase = 'orbit';
      return this.flyOrbit(dt, t, human);
    }
    const top = this.clearance(t, brg, Math.max(800, t.groundSpeed * 25), 60);
    s.commanded = Math.max(s.altitude, top + 70);
    const urgent = s.commanded > s.altitude + 1;
    s.heading = brg;
    const vs = this.vsToward(t, s.commanded, this.climbLimit(t, urgent));
    s.guidance = { distance: dist, glideslopeDev: null, localizerDev: null, targetSpeed: s.speed, eta: dist / Math.max(1, t.groundSpeed), siteName: d.name };
    s.status = `Go to · ${d.name} · ${km(dist)} · ${r0(s.commanded)} m`;
    return this.plane.fly(dt, t, { vs, track: brg, speed: s.speed, pitchMin: -12, pitchMax: 18, flaps: 0 });
  }

  /** Right-hand circle around orbitCenter at orbitRadius. */
  private flyOrbit(dt: number, t: Telemetry, human: ControlInputs): ControlInputs {
    const s = this.state;
    const [cx, cz] = this.orbitCenter;
    const R = s.orbitRadius;
    const dist = distance(t.position[0], t.position[2], cx, cz);
    const toCenter = bearing(t.position[0], t.position[2], cx, cz);
    // Tangent for a clockwise (right-hand) circle, bent in toward the circle when off it.
    const radialErr = dist - R;
    const desiredTrack = toCenter - 90 + clamp(radialErr * 0.15, -60, 60);
    const gs = Math.max(10, t.groundSpeed);
    const track = gs > 5 ? Math.atan2(t.velocity[0], -t.velocity[2]) * (180 / Math.PI) : t.heading;
    const onCircle = Math.abs(radialErr) < R * 0.6;
    const ff = onCircle ? Math.atan((gs * gs) / (9.81 * R)) * (180 / Math.PI) : 0;
    const roll = clamp(ff + wrap180(desiredTrack - track) * 1.2, -35, 35);
    s.commanded = Math.max(s.altitude, this.orbitFloor);
    const vs = this.vsToward(t, s.commanded, this.climbLimit(t, s.commanded > s.altitude + 1));
    s.guidance = this.dest ? { distance: dist, glideslopeDev: null, localizerDev: null, targetSpeed: s.speed, eta: 0, siteName: this.dest.name } : null;
    s.status = `Orbit · ${this.dest ? this.dest.name : 'here'} · r ${r0(R)} m · ${r0(s.commanded)} m`;
    return this.plane.fly(dt, t, { vs, roll, speed: s.speed, pitchMin: -12, pitchMax: 18, flaps: human.flaps });
  }

  /** Runway landing: join → final (glideslope + localizer) → flare → rollout → landed. */
  private flyLanding(dt: number, t: Telemetry): ControlInputs {
    const s = this.state;
    const ap = this.approach;
    if (!ap) return this.plane.fly(dt, t, { vs: 0, roll: 0, speed: s.speed });
    const vapp = this.approachSpeed;
    const { along, cross } = approachFrame(ap, t.position[0], t.position[2]);
    const h = t.altitude + terrainHeight(t.position[0], t.position[2]) - ap.elevation;
    const gsH = glideslopeHeight(ap, along);
    const distToGo = ap.aim - along;
    const gs = Math.max(1, t.groundSpeed);
    const name = `${ap.site.name} ${runwayNumber(ap.heading)}`;
    const flareH = Math.max(7, Math.min(12, 0.2 * vapp));
    const runwayEnd = ap.site.length;
    let cmd: PlaneCommand;
    let yawOverride: number | null = null;

    if (s.phase === 'join') {
      const R = turnRadius(Math.max(gs, vapp * 1.3), 25);
      const far = approachPoint(ap, -IF_DISTANCE - 2 * R - 600);
      const fix = approachPoint(ap, -IF_DISTANCE);
      const brgFix = bearing(t.position[0], t.position[2], fix[0], fix[1]);
      const dFix = distance(t.position[0], t.position[2], fix[0], fix[1]);
      const fixAligned = Math.abs(wrap180(brgFix - ap.heading)) < 70;
      if (!fixAligned && !this.joinFar && dFix > R) this.joinFar = true;
      if (this.joinFar && fixAligned && along < -IF_DISTANCE) this.joinFar = false;
      const wp = this.joinFar ? far : fix;
      const dWp = distance(t.position[0], t.position[2], wp[0], wp[1]);
      const headingOk = Math.abs(wrap180(t.heading - ap.heading)) < 100;
      const captured = along < -600 && along > -(IF_DISTANCE + 4 * R + 4000) && Math.abs(cross) < Math.max(1.2 * R, 900) && headingOk && (!this.joinFar || along < -IF_DISTANCE);
      if (captured || dWp < Math.max(0.8 * R, 400)) {
        s.phase = 'final';
        this.established = false;
        this.joinFar = false;
      } else {
        const brg = bearing(t.position[0], t.position[2], wp[0], wp[1]);
        const top = this.clearance(t, brg, Math.max(800, gs * 25), 60);
        s.commanded = Math.max(ap.elevation + this.ifHeight, top > 0 ? top + 70 : 0);
        const vs = this.vsToward(t, s.commanded, this.climbLimit(t, top + 70 > h + ap.elevation), 6);
        cmd = { vs, track: brg, speed: vapp * 1.25, pitchMin: -10, pitchMax: 15, flaps: 0.34 };
        s.status = `Land · ${name} · joining ${this.joinFar ? 'outbound' : 'initial fix'} · ${km(dWp)}`;
        this.setLandingGuidance(ap, distToGo, h - gsH, cross, vapp * 1.25, gs, name);
        return this.plane.fly(dt, t, cmd);
      }
    }

    if (s.phase === 'final') {
      // Go around if badly off on short final.
      if (distToGo < 500 && (Math.abs(cross) > 45 || h > gsH + 35) && h > flareH) {
        s.phase = 'join';
        this.joinFar = true;
        s.status = `Land · ${name} · going around`;
        return this.plane.fly(dt, t, { vs: 4, track: ap.heading, speed: vapp * 1.25, pitchMax: 15, flaps: 0.34 });
      }
      if (h < flareH && along > -150) {
        s.phase = 'flare';
        this.flarePitch = t.pitch;
        this.flareThrottle = t.throttle;
      }
      else {
        const track = localizerTrack(ap, cross, distToGo);
        // Level at the initial-fix height until the glideslope comes down to meet it.
        const onSlope = gsH <= this.ifHeight;
        const target = onSlope ? gsH : this.ifHeight;
        const top = this.clearance(t, track, Math.max(400, gs * 10), 40) - ap.elevation;
        const floor = along < -400 && top > 0 ? top + 30 : 0;
        const vsFF = onSlope ? -gs * TAN_GS : 0;
        let vs = clamp(vsFF + 0.3 * (Math.max(target, floor) - h), -gs * TAN_GS - 3, 2);
        if (floor > h) vs = clamp((floor - h) * 0.3, 0, 6);
        // Slow to the approach speed with full flaps only once established on the localizer:
        // turning onto final at 1.3 × stall would risk a stall in the bank.
        const aligned = Math.abs(cross) < 120 && Math.abs(wrap180(t.heading - ap.heading)) < 20;
        if (aligned && distToGo < IF_DISTANCE + 1500) this.established = true;
        else if (!aligned && distToGo > 1200 && (Math.abs(cross) > 250 || Math.abs(wrap180(t.heading - ap.heading)) > 35)) this.established = false;
        const flaps = this.established ? LANDING_FLAPS : 0.34;
        const speed = this.established ? vapp : vapp * 1.25;
        cmd = { vs, track, speed, maxBank: this.established ? 15 : 25, pitchMin: -8, pitchMax: 12, flaps };
        s.status = `Land · ${name} · final · ${km(distToGo)}`;
        this.setLandingGuidance(ap, distToGo, h - gsH, cross, speed, gs, name);
        return this.plane.fly(dt, t, cmd);
      }
    }

    if (s.phase === 'flare') {
      if (t.onGround) {
        s.phase = 'rollout';
        this.touchdownAt = t.time;
      } else {
        const vs = -Math.max(0.5, 0.25 * h);
        const hdgErr = wrap180(ap.heading - t.heading);
        // Raise the nose progressively (the V/S loop alone reacts too late), never past 8° so the
        // tail stays clear. Wings level; rudder lines the nose up with the runway.
        const pitchMin = Math.min(7, this.flarePitch + FLARE_PITCH * clamp(1 - h / flareH, 0, 1));
        // Ease the power off to idle by the last metre (cutting it at once drops the nose).
        const throttle = this.flareThrottle * clamp((h - 1) / (flareH - 1), 0, 1);
        cmd = { vs, roll: clamp(-cross * 0.3, -4, 4), throttle, pitchMin, pitchMax: 8, flaps: LANDING_FLAPS };
        yawOverride = clamp(hdgErr * 0.08, -1, 1);
        s.status = `Land · ${name} · flare · ${h.toFixed(1)} m`;
        this.setLandingGuidance(ap, distToGo, h - gsH, cross, vapp, gs, name);
        const out = this.plane.fly(dt, t, cmd);
        // The attitude loop is gentle for cruise; the flare needs a firmer hand on the elevator.
        const want = clamp(Math.max(pitchMin, this.flarePitch + 2 * (vs - t.verticalSpeed)), -2, 8);
        const pitch = clamp(out.pitch + FLARE_GAIN * (want - t.pitch), -1, 1);
        return { ...out, pitch, yaw: yawOverride };
      }
    }

    if (s.phase === 'rollout') {
      if (t.groundSpeed < 0.5 && t.onGround) s.phase = 'landed';
      else {
        const steer = wrap360(ap.heading - clamp(cross * 1.5, -10, 10));
        const brake = t.time - this.touchdownAt > 1 ? 1 : 0;
        cmd = { vs: -0.5, roll: 0, throttle: 0, pitchMax: 8, rollout: { heading: steer, brake }, flaps: LANDING_FLAPS };
        s.status = `Land · ${name} · rollout · ${km(Math.max(0, runwayEnd - along))} left`;
        this.setLandingGuidance(ap, Math.max(0, runwayEnd - along), null, cross, 0, gs, name);
        return this.plane.fly(dt, t, cmd);
      }
    }

    // Landed: hold the brakes.
    s.status = `Land · ${name} · landed`;
    s.guidance = { distance: 0, glideslopeDev: null, localizerDev: cross, targetSpeed: 0, eta: 0, siteName: name };
    return { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1, flaps: LANDING_FLAPS };
  }

  private setLandingGuidance(ap: Approach, dist: number, gsDev: number | null, cross: number, speed: number, gs: number, name: string): void {
    void ap;
    this.state.guidance = { distance: Math.max(0, dist), glideslopeDev: gsDev, localizerDev: cross, targetSpeed: speed, eta: Math.max(0, dist) / Math.max(1, gs), siteName: name };
  }

  // ---------------------------------------------------------------- rotorcraft

  private flyRotorcraft(dt: number, t: Telemetry): ControlInputs {
    const s = this.state;
    if (s.mode === 'land') return this.flyPadLanding(dt, t);
    if (s.mode === 'goto' && this.dest) {
      const d = this.dest;
      const dist = distance(t.position[0], t.position[2], d.x, d.z);
      s.guidance = { distance: dist, glideslopeDev: null, localizerDev: null, targetSpeed: s.speed, eta: dist / Math.max(1, t.groundSpeed), siteName: d.name };
      if (dist < 25 && t.groundSpeed < 2) {
        s.phase = 'hold';
        s.status = `Go to · over ${d.name}`;
      } else {
        s.phase = 'transit';
        s.status = `Go to · ${d.name} · ${km(dist)}`;
      }
      return this.hoverTo(dt, t, d.x, d.z, s.altitude, s.speed, 25);
    }
    if (s.mode === 'takeoff' && Math.abs(t.altitude - s.altitude) < 3) {
      s.mode = 'hold';
      s.phase = 'hold';
    }
    if (s.phase === 'takeoff' && t.altitude > 3) s.phase = s.mode === 'takeoff' ? 'climb' : 'hold';
    const top = this.clearance(t, s.heading, 150, 30);
    s.commanded = Math.max(s.altitude, top > 0 ? top + 25 : 0);
    this.hover.targets = { altitude: s.commanded, heading: s.heading, forwardSpeed: s.speed };
    s.guidance = null;
    s.status = `${s.mode === 'takeoff' ? 'Takeoff' : 'Hold'} · HDG ${hdg3(s.heading)} · ${r0(s.altitude)} m · ${s.speed.toFixed(0)} m/s`;
    return { ...this.hover.sample(dt, t), flaps: 0 };
  }

  /**
   * Fly a rotorcraft toward (x, z) at a cruise height clearing obstacles by `margin`, slowing
   * down on arrival and holding position over it. Heading points along the way while moving.
   */
  private hoverTo(dt: number, t: Telemetry, x: number, z: number, cruiseAlt: number, maxSpeed: number, margin: number, fixedHeading?: number, vsTarget?: number, minHeight = 0): ControlInputs {
    const s = this.state;
    const [dx, dz] = delta(t.position[0], t.position[2], x, z);
    const dist = Math.hypot(dx, dz);
    const brg = bearing(t.position[0], t.position[2], x, z);
    const terrain = terrainHeight(t.position[0], t.position[2]);
    const h = t.altitude + terrain;
    // Look far enough ahead to climb over whatever is coming at a few m/s.
    const reach = Math.min(dist + 40, 200 + maxSpeed * 25);
    const top = Math.max(this.clearance(t, brg, reach, 25), obstacleTop(t.position[0], t.position[2]));
    const targetH = Math.max(cruiseAlt, minHeight, top > 0 ? top + margin : 0);
    s.commanded = targetH;
    // Hold off forward speed while still well below the height needed.
    const climbFactor = clamp(1 - (targetH - h - 10) / 40, 0.1, 1);
    const speed = Math.min(maxSpeed * climbFactor, 0.25 * dist + 0.3, maxSpeed);
    const vx = dist > 0.01 ? (dx / dist) * speed : 0;
    const vz = dist > 0.01 ? (dz / dist) * speed : 0;
    const heading = fixedHeading ?? (dist > 30 ? brg : t.heading);
    const hr = heading * (Math.PI / 180);
    // Body-frame velocity targets (forward = (sin h, -cos h), right = (cos h, sin h)).
    const forward = vx * Math.sin(hr) - vz * Math.cos(hr);
    const right = vx * Math.cos(hr) + vz * Math.sin(hr);
    this.hover.targets = { altitude: targetH - terrain, heading, forwardSpeed: forward, rightSpeed: right, vsTarget };
    s.heading = wrap360(heading);
    return { ...this.hover.sample(dt, t), flaps: 0 };
  }

  /** Rotorcraft landing on a helipad (rooftops too): transit → approach → descend → landed. */
  private flyPadLanding(dt: number, t: Telemetry): ControlInputs {
    const s = this.state;
    let d = this.dest;
    if (d?.site && !siteUsable(d.site, this.fractured ?? undefined) && s.phase !== 'landed') {
      // The tower under the pad came down: pick another.
      s.destination = null;
      this.startRotorLanding(t);
      d = this.dest;
      if (!d) return this.flyRotorcraft(dt, t);
    }
    if (!d) return this.flyRotorcraft(dt, t);
    const pad = siteElevation(d);
    const hp = t.altitude + terrainHeight(t.position[0], t.position[2]) - pad;
    const dist = distance(t.position[0], t.position[2], d.x, d.z);
    s.guidance = { distance: dist, glideslopeDev: null, localizerDev: null, targetSpeed: s.speed, eta: dist / Math.max(1, t.groundSpeed), siteName: d.name };
    if (s.phase === 'landed') {
      s.status = `Land · ${d.name} · landed`;
      return { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1, flaps: 0 };
    }
    if (s.phase === 'transit') {
      if (dist < 60) {
        s.phase = 'approach';
        this.padHeading = t.heading;
      }
      s.status = `Land · ${d.name} · transit · ${km(dist)}`;
      return this.hoverTo(dt, t, d.x, d.z, Math.max(s.altitude, pad + 20), Math.max(5, s.speed), 25, undefined, undefined, pad + 15);
    }
    if (s.phase === 'approach') {
      // Settle over the pad 12 m above it.
      if (dist < 2 && t.groundSpeed < 0.8) s.phase = 'descend';
      s.status = `Land · ${d.name} · over the pad · ${r0(dist)} m`;
      return this.hoverTo(dt, t, d.x, d.z, pad + 12, 6, 0, this.padHeading, undefined, pad + 12);
    }
    // Descend: slower as the pad comes up; throttle off on touchdown.
    if ((hp < 0.35 && Math.abs(t.verticalSpeed) < 1) || (t.onGround && hp < 1.5)) {
      s.phase = 'landed';
      s.status = `Land · ${d.name} · landed`;
      return { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1, flaps: 0 };
    }
    const vsTarget = -clamp(0.35 * hp, 0.4, 2.5);
    s.status = `Land · ${d.name} · descending · ${hp.toFixed(1)} m`;
    return this.hoverTo(dt, t, d.x, d.z, pad, 3, -1e9, this.padHeading, vsTarget);
  }

  // ---------------------------------------------------------------- helpers

  private clearanceCache = new Map<string, { time: number; value: number }>();

  /**
   * Tallest obstacle along a heading (absolute m). Scanning is costly at 120 Hz, so a result
   * is reused for a tenth of a second for the same heading, reach and width.
   */
  private clearance(t: Telemetry, heading: number, reach: number, halfWidth: number): number {
    const key = `${Math.round(heading)}|${Math.round(reach / 25)}|${halfWidth}`;
    const hit = this.clearanceCache.get(key);
    if (hit && t.time >= hit.time && t.time - hit.time < 0.1) return hit.value;
    if (this.clearanceCache.size > 64) this.clearanceCache.clear();
    const value = obstacleAhead(t.position[0], t.position[2], heading, reach, halfWidth);
    this.clearanceCache.set(key, { time: t.time, value });
    return value;
  }

  /** Height (absolute m) that clears everything within an orbit ring by 70 m. */
  private ringClearance(cx: number, cz: number, R: number): number {
    let top = 0;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      for (const r of [R - 120, R, R + 120]) top = Math.max(top, obstacleTop(cx + Math.sin(a) * r, cz - Math.cos(a) * r));
    }
    return top > 0 ? top + 70 : 0;
  }
}
