import { obstacleTop } from '../world/structures.ts';
import { Autopilot, HoverPilot, type PlaneCommand } from './autopilot.ts';
import type { ControlInputs, ControlSource } from './controls.ts';
import { relativePosition, type LockTarget } from './lock.ts';
import * as THREE from 'three';
import { wrapCoord, type LandingSite } from './layout.ts';
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
  runwayHeadings,
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
import { GroundDriver, type DriveStatus } from './groundPilot.ts';
import { NavAdvisor, type BrainDecision, type BrainOption } from './navBrain.ts';
import { airDecision, groundDecision, landingDecision, type AdvisorWorld, type BuiltDecision } from './navDecisions.ts';

export type AutopilotKind = 'airplane' | 'rotorcraft' | 'ground';
export type AutopilotMode = 'hold' | 'takeoff' | 'land' | 'goto' | 'orbit' | 'level' | 'ascent' | 'chase';
export type AutopilotPhase =
  | 'hold' | 'takeoff' | 'climb' | 'cruise' | 'orbit' | 'level'
  | 'join' | 'final' | 'flare' | 'rollout'
  | 'transit' | 'approach' | 'descend'
  | 'landed'
  | 'drive' | 'arrived' | 'parked'
  | 'boost' | 'coast' | 'circularize' | 'orbiting'
  | 'pursuit' | 'station';

/** Airplane modes in panel order, and the rotorcraft subset. */
export const AIRPLANE_MODES: readonly AutopilotMode[] = ['hold', 'takeoff', 'land', 'goto', 'orbit', 'chase', 'level', 'ascent'];
export const ROTORCRAFT_MODES: readonly AutopilotMode[] = ['hold', 'takeoff', 'goto', 'chase', 'land'];
/** Ground vehicles: stop and hold, or drive to a destination on the road network. */
export const GROUND_MODES: readonly AutopilotMode[] = ['hold', 'goto'];
export const MODE_LABELS: Record<AutopilotMode, string> = { hold: 'Hold', takeoff: 'Takeoff', land: 'Land', goto: 'Go to', orbit: 'Orbit', level: 'Level', ascent: 'To orbit', chase: 'Chase lock' };

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
  /** Chase: the vehicle to chase (the current lock). */
  target?: LockTarget | null;
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
 *
 * It can take an outside brain (`advisor`, src/sim/navBrain.ts: an OpenRouter model) for the
 * navigation choices: route and pace on the road, cruise height and speed on a Go to, which
 * runway or helipad to land on. The brain picks among options this computer has checked and
 * this computer still does all the flying; its picks are overrides on top of the player's
 * settings (touching a knob hands that knob back to the player).
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
  private joinSide = 1;
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
  /** Ground vehicles: the road driver (route, lane following, speed). */
  readonly driver = new GroundDriver();
  /** Chase: the vehicle being chased, and how long it has been out of reach (s). */
  chaseTarget: LockTarget | null = null;
  private chaseLost = 0;
  private chaseElevator = 0;
  private chaseTrim = 1;
  private readonly _rel = new THREE.Vector3();
  private readonly _tv = new THREE.Vector3();
  private readonly _own = new THREE.Vector3();
  /** Called when the autopilot disengages itself (to sync the human throttle lever). */
  onDisengage: ((throttle: number) => void) | null = null;
  /** The outside brain's scheduler (no brain: the built-in computer decides alone). */
  readonly advisor = new NavAdvisor();
  /** Territory and diplomacy for the brain's situation report (set by the host). */
  world: AdvisorWorld | null = null;
  /** Bumped by every engage: an answer to an earlier engagement is never applied. */
  private engageSeq = 0;
  /** The brain's picks, on top of the player's settings (null: the player's setting stands). */
  private brainAltitude: number | null = null;
  private brainSpeed: number | null = null;
  private brainPace: number | null = null;
  private built: BuiltDecision | null = null;
  private seenPlanSeq = 0;
  private lastDrive: DriveStatus | null = null;
  private routeAskedAt = -Infinity;
  private blockedSeen = false;
  private stuckSeen = false;

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
    this.engageSeq++;
    this.brainAltitude = this.brainSpeed = this.brainPace = null;
    this.routeAskedAt = -Infinity;
    if (perf && Number.isFinite(perf.stallSpeed) && perf.stallSpeed > 0) {
      this.stallSpeed = perf.stallSpeed;
      this.perfKnown = true;
    } else if (!wasEngaged && !this.perfKnown && kind === 'airplane' && !t.onGround) this.stallSpeed = clamp(t.airspeed / 1.7, 15, 80);
    s.mode = opts.mode ?? 'hold';
    if (kind === 'rotorcraft' && (s.mode === 'orbit' || s.mode === 'level')) s.mode = 'hold';
    let chaseNotice = '';
    if (s.mode === 'chase') {
      if (kind === 'ground' || !opts.target || !opts.target.alive()) {
        s.mode = 'hold';
        chaseNotice = 'Chase: nothing locked (fly the nose onto a vehicle until it locks)';
      } else {
        this.chaseTarget = opts.target;
        this.chaseLost = 0;
        this.chaseElevator = clamp(t.controls.pitch, -0.3, 0.3);
        this.chaseTrim = clamp(t.gForce * Math.cos(t.roll * (Math.PI / 180)), 0.5, 1.2);
      }
    }
    if (s.mode !== 'chase') this.chaseTarget = null;
    s.heading = wrap360(opts.heading ?? t.heading);
    const grounded = t.onGround || t.altitude < 5;
    if (kind === 'ground') {
      if (s.mode !== 'goto') s.mode = 'hold';
      s.speed = clamp(opts.speed ?? 20, 3, 60);
      if (opts.destination !== undefined) s.destination = opts.destination;
      s.guidance = null;
      s.notice = '';
      this.dest = null;
      if (s.mode === 'goto') {
        const d = s.destination ? findDestination(s.destination) : undefined;
        if (!d) {
          s.mode = 'hold';
          s.notice = 'Go to: no destination selected';
        } else if (!this.driver.plan(t.position[0], t.position[2], d.x, d.z)) {
          s.mode = 'hold';
          s.notice = `No road reaches ${d.name}`;
        } else this.dest = d;
      }
      this.seenPlanSeq = this.driver.planSeq;
      this.lastDrive = null;
      s.phase = s.mode === 'goto' ? 'drive' : 'parked';
      s.status = s.mode === 'goto' && this.dest ? `Driving to ${this.dest.name}: ${km(this.driver.length)} by road` : 'Stopped, brakes on';
      return;
    }
    if (kind === 'airplane' && s.mode === 'ascent') {
      // Reach orbit: the selected altitude is the circular orbit's height.
      s.altitude = clamp(opts.altitude ?? 30000, 12000, 90000);
      s.speed = 0;
      this.plane = new Autopilot({ heading: s.heading, altitude: 600, airspeed: 120 });
      this.plane.rotateSpeed = clamp(this.stallSpeed * 1.15, 12, 90);
    } else if (kind === 'airplane') {
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
    s.notice = chaseNotice;
    this.dest = null;
    this.approach = null;
    this.touchdownAt = -1;
    if (!wasEngaged) this.lastHumanThrottle = t.controls.throttle;
    this.startMode(t);
  }

  disengage(): void {
    if (!this.state.engaged) return;
    this.advisor.reset();
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
      case 'ascent':
        s.phase = grounded ? 'takeoff' : 'boost';
        break;
      case 'chase':
        s.phase = grounded && air ? 'takeoff' : 'pursuit';
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
      if (d?.site?.kind === 'runway') {
        if (d.site.length >= landingDistanceNeeded(vapp)) site = d.site;
        else s.notice = `${d.site.name} is too short (${d.site.length} m, needs ${r0(landingDistanceNeeded(vapp))} m): nearest long enough instead`;
      }
    }
    site ??= nearestRunway(t.position[0], t.position[2], vapp);
    if (!site) {
      s.mode = 'hold';
      s.phase = 'hold';
      s.notice = s.status = `Land: no runway long enough (needs ${r0(landingDistanceNeeded(vapp))} m)`;
      return;
    }
    if (t.onGround) {
      // Rolling (or stopped) on the ground: hold the centreline of the runway we are on and stop.
      const [h0, h1] = runwayHeadings(site);
      const along = Math.abs(wrap180(t.heading - h0)) <= 90 ? h0 : h1;
      this.dest = { id: site.id, name: site.name, kind: 'runway', x: site.x, z: site.z, y: site.y, site };
      this.approach = makeApproach(site, along);
      this.touchdownAt = t.time - 2;
      s.phase = t.groundSpeed < 1 ? 'landed' : 'rollout';
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
    if (s.kind === 'ground') {
      this.advise(t);
      const out = this.flyGround(dt, t, human);
      this.lastOutput = out;
      return out;
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
      // Turning a knob hands it back from the brain until its next pick.
      if (Math.abs(human.pitch) > 0.1) this.brainAltitude = null;
      if (Math.abs(dThr) > 0.01) this.brainSpeed = null;
    }
    this.advise(t);

    let out: ControlInputs;
    if (air) out = this.flyAirplane(dt, t, human);
    else out = this.flyRotorcraft(dt, t);
    this.lastOutput = out;
    return out;
  }

  // ---------------------------------------------------------------- ground

  /** Drive a ground vehicle: Go to follows the road route; Hold stops and keeps the brakes on. */
  private flyGround(dt: number, t: Telemetry, human: ControlInputs): ControlInputs {
    const s = this.state;
    // The human takes over by steering hard or braking.
    if (Math.abs(human.yaw) > 0.6 || human.brake > 0.5) {
      this.disengage();
      return human;
    }
    const dThr = human.throttle - this.lastHumanThrottle;
    this.lastHumanThrottle = human.throttle;
    s.speed = clamp(s.speed + dThr * 40, 3, 60);
    if (Math.abs(dThr) > 0.01) this.brainPace = null;
    if (s.mode !== 'goto' || !this.dest) {
      s.phase = 'parked';
      s.guidance = null;
      return { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };
    }
    // The brain's pace, never above the player's own cruise speed (their limit).
    const { controls, status } = this.driver.drive(dt, t, Math.min(this.brainPace ?? s.speed, s.speed));
    this.lastDrive = status;
    s.guidance = {
      distance: status.remaining, glideslopeDev: null, localizerDev: null, targetSpeed: status.target,
      eta: status.remaining / Math.max(3, t.groundSpeed), siteName: this.dest.name,
    };
    if (status.arrived) {
      s.phase = 'arrived';
      s.status = this.driver.endsAtRoad ? `Arrived at the road nearest ${this.dest.name}` : `Arrived at ${this.dest.name}`;
    } else {
      s.phase = 'drive';
      s.status = this.driver.wallAhead < 30 && t.groundSpeed < 1 ? `Light wall ahead: waiting or finding another road to ${this.dest.name}` : status.stuck ? `Stuck: ${km(status.remaining)} to ${this.dest.name}. Steer or reverse out, then re-engage` : `Driving to ${this.dest.name}: ${km(status.remaining)} by road`;
    }
    return controls;
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
      case 'ascent':
        return this.flyAscent(dt, t);
      case 'chase':
        if (s.phase !== 'takeoff') return this.flyChase(dt, t, human);
        if (t.altitude > 60) s.phase = 'pursuit';
        return this.flyHold(dt, t, human);
      case 'goto':
        if (s.phase !== 'takeoff') return this.flyGoto(dt, t, human);
      // fallthrough: take off first
      default:
        return this.flyHold(dt, t, human);
    }
  }

  /**
   * To orbit: take off if on the runway; a gravity turn at full thrust (pitch easing from 35° to
   * 8° through the lower air) until the apoapsis reaches the selected altitude; coast to the
   * apoapsis holding the flight path; burn level until the periapsis comes up to meet it; then
   * hold the orbit, engine off. Attitude comes from the surfaces in air and the RCS in vacuum.
   */
  private flyAscent(dt: number, t: Telemetry): ControlInputs {
    const s = this.state;
    const target = s.altitude;
    const ap = t.orbit?.apoapsis ?? Infinity, pe = t.orbit?.periapsis ?? -Infinity;
    const gamma = Math.atan2(t.verticalSpeed, Math.max(1, t.groundSpeed)) * (180 / Math.PI);
    const hold = (pitch: number, throttle: number) => this.plane.fly(dt, t, { vs: pitch >= t.pitch ? 9999 : -9999, track: s.heading, throttle, pitchMin: pitch, pitchMax: pitch, maxBank: 0 });
    const orbitText = `Ap ${km(Number.isFinite(ap) ? ap : 0)} · Pe ${km(Math.max(0, pe))}`;
    s.guidance = null;
    if (s.phase === 'takeoff') {
      if (!t.onGround && t.altitude > 150) s.phase = 'boost';
      this.plane.targets = { heading: s.heading, altitude: 600, airspeed: 140 };
      this.plane.maxClimb = 20;
      s.status = 'To orbit · take-off';
      return { ...this.plane.sample(dt, t), throttle: 1 };
    }
    if (s.phase === 'boost' && ap >= target) s.phase = 'coast';
    if (s.phase === 'coast' && (t.verticalSpeed < 4 || t.altitude > target * 0.97)) s.phase = 'circularize';
    // Circularise for the height actually reached (drag may have cost some of the target).
    if (s.phase === 'circularize' && (pe >= Math.min(target, t.altitude) * 0.92 || ap === Infinity)) s.phase = 'orbiting';
    if (s.phase === 'orbiting' && pe < Math.min(target, t.altitude) * 0.7) s.phase = 'circularize';
    switch (s.phase) {
      case 'boost': {
        const k = clamp((t.altitude - 1000) / 14000, 0, 1);
        s.status = `To orbit · gravity turn · ${orbitText} (target ${km(target)})`;
        return hold(35 + (8 - 35) * k, 1);
      }
      case 'coast': {
        // In the lower air drag eats the apoapsis: top it up along the flight path.
        const topUp = ap < target * 0.98 ? clamp((target - ap) / (target * 0.05), 0.2, 1) : 0;
        s.status = `To orbit · coasting to apoapsis${topUp ? ' (drag: topping up)' : ''} · ${orbitText}`;
        return hold(clamp(gamma, -10, 30), topUp);
      }
      case 'circularize':
        s.status = `To orbit · circularising · ${orbitText}`;
        // Keep the climb near zero while the burn adds horizontal speed.
        return hold(clamp(-t.verticalSpeed * 0.6, -6, 12), t.fuel !== null && t.fuel <= 0 ? 0 : 1);
      default:
        s.status = `In orbit · ${orbitText}`;
        return hold(clamp(gamma, -5, 5), 0);
    }
  }

  /** Hold / Takeoff: heading, altitude (or V/S) and speed, from the runway if need be. */
  private flyHold(dt: number, t: Telemetry, human: ControlInputs): ControlInputs {
    const s = this.state;
    if (s.phase === 'takeoff' && !t.onGround && t.altitude > 30) s.phase = 'climb';
    if (s.mode === 'goto' && s.phase === 'climb') s.phase = 'cruise';
    if (s.phase === 'climb' && s.mode === 'hold') s.phase = 'hold';
    const terrain = terrainHeight(t.position[0], t.position[2]);
    const top = this.clearance(t, s.heading, Math.max(300, t.groundSpeed * 12), 30);
    const need = top > 0 ? top + 60 - terrain : 0;
    // With a V/S hold the selected altitude is stale: compare the obstacle with where we are.
    s.commanded = Math.max(s.vs !== null ? Math.min(s.altitude, t.altitude) : s.altitude, need);
    if (s.mode === 'takeoff' && s.phase === 'climb' && Math.abs(t.altitude - s.altitude) < 15) {
      s.mode = 'hold';
      s.phase = 'hold';
    }
    s.guidance = null;
    let out: ControlInputs;
    if (s.vs !== null && !t.onGround && need < t.altitude - 5) {
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
    const alt = this.brainAltitude ?? s.altitude, speed = this.brainSpeed ?? s.speed;
    s.commanded = Math.max(alt + terrainHeight(t.position[0], t.position[2]), top + 70);
    const urgent = s.commanded > alt + 1;
    s.heading = brg;
    const vs = this.vsToward(t, s.commanded, this.climbLimit(t, urgent));
    s.guidance = { distance: dist, glideslopeDev: null, localizerDev: null, targetSpeed: speed, eta: dist / Math.max(1, t.groundSpeed), siteName: d.name };
    s.status = `Go to · ${d.name} · ${km(dist)} · ${r0(s.commanded)} m`;
    return this.plane.fly(dt, t, { vs, track: brg, speed, pitchMin: -12, pitchMax: 18, flaps: 0 });
  }

  /** Where the chased vehicle is from the craft (into _rel) and how fast it goes (into _tv); null once it is gone or lost. */
  private chaseFix(dt: number, t: Telemetry): number | null {
    const tg = this.chaseTarget;
    if (!tg || !tg.alive()) return this.endChase(t, 'target gone');
    this._own.set(t.position[0], t.position[1], t.position[2]);
    relativePosition(this._own, tg, this._rel);
    tg.velocity(this._tv);
    const range = this._rel.length();
    this.chaseLost = range > 6000 ? this.chaseLost + dt : 0;
    if (this.chaseLost > 5) return this.endChase(t, 'target out of reach');
    return range;
  }

  /** The chase is over: back to Hold where the craft is, with a word why. */
  private endChase(t: Telemetry, why: string): null {
    const kind = this.state.kind;
    const name = this.chaseTarget?.name ?? 'target';
    this.engage(t, kind, undefined, { mode: 'hold', heading: t.heading });
    this.state.notice = `Chase ended: ${name} ${why}`;
    return null;
  }

  /**
   * Chase the locked vehicle. An aeroplane flies lead pursuit (toward where the target will be
   * when it gets there), banking up to 60°, climbing or diving to its height but never below the
   * terrain and structures ahead, faster than the target while it is far and matching its speed
   * close in, holding station a couple of hundred metres behind instead of overshooting. A
   * rotorcraft holds 250 m behind and 30 m above it, nose on. It never fires.
   */
  private flyChase(dt: number, t: Telemetry, human: ControlInputs | null): ControlInputs {
    const s = this.state;
    const range = this.chaseFix(dt, t);
    if (range === null) return s.kind === 'airplane' ? this.flyHold(dt, t, human ?? t.controls) : this.flyRotorcraft(dt, t);
    const rel = this._rel, tv = this._tv;
    const tg = this.chaseTarget!;
    const tSpeed = Math.hypot(tv.x, tv.z);
    const terrain = terrainHeight(t.position[0], t.position[2]);
    const targetY = t.position[1] + rel.y;
    if (s.kind !== 'airplane') {
      // Rotorcraft: 250 m behind it (along its track), 30 m above, nose on it.
      const back = tSpeed > 2 ? 250 / tSpeed : 0;
      const x = t.position[0] + rel.x - tv.x * back, z = t.position[2] + rel.z - tv.z * back;
      const brg = wrap360(Math.atan2(rel.x, -rel.z) / (Math.PI / 180));
      s.phase = range < 400 ? 'station' : 'pursuit';
      s.guidance = { distance: range, glideslopeDev: null, localizerDev: null, targetSpeed: s.speed, eta: range / Math.max(1, t.groundSpeed), siteName: tg.name };
      s.status = `Chase · ${tg.name} · ${km(range)}`;
      return this.hoverTo(dt, t, x, z, targetY + 30, 45, 25, brg);
    }
    // How fast the two are closing, and the lead point.
    const ownV = this._own.set(t.velocity[0], t.velocity[1], t.velocity[2]);
    const closure = -((tv.x - ownV.x) * rel.x + (tv.y - ownV.y) * rel.y + (tv.z - ownV.z) * rel.z) / Math.max(1, range);
    const close = range < 350;
    // Lead: where the target will be by the time the craft gets there (no more than 10 s on).
    const tgo = close ? 0 : Math.min(10, range / Math.max(80, closure, t.groundSpeed));
    let ax = rel.x + tv.x * tgo, az = rel.z + tv.z * tgo;
    if (close && tSpeed > 5) {
      // Station: fly at a point 200 m behind it on its track (it stays ahead).
      ax = rel.x + (tv.x / tSpeed) * 50;
      az = rel.z + (tv.z / tSpeed) * 50;
    }
    const track = wrap360(Math.atan2(ax, -az) / (Math.PI / 180));
    const vmin = 1.3 * this.stallSpeed;
    // Faster than the target while far, bleeding off on the way in so it arrives at its speed
    // a couple of hundred metres behind: the speed it can still lose over the distance left.
    const spare = Math.sqrt(Math.max(0, range - 220) * 2 * 3);
    const want = tSpeed + clamp(Math.min(spare, 15 + range * 0.03), -40, 70) - (range < 220 ? (220 - range) * 0.2 : 0);
    const speed = clamp(want, vmin, 280);
    // Height: the target's, but clear of everything ahead (and of the ground by 60 m).
    const top = this.clearance(t, track, Math.max(800, t.groundSpeed * 20), 60);
    s.commanded = Math.max(targetY, terrain + 60, top + 60);
    const vs = this.vsToward(t, s.commanded, this.climbLimit(t, s.commanded > t.altitude + terrain + 1) * 1.5, 25);
    s.heading = track;
    s.speed = speed;
    s.phase = close ? 'station' : 'pursuit';
    s.guidance = { distance: range, glideslopeDev: null, localizerDev: null, targetSpeed: speed, eta: closure > 1 ? range / closure : 0, siteName: tg.name };
    s.status = `Chase · ${tg.name} · ${km(range)} · ${closure >= 0 ? '+' : ''}${r0(closure)} m/s`;
    // Bank straight into the turn (a track hold banks too gently for a dogfight): up to 60°,
    // proportional to how far the track is off.
    const gs = Math.max(10, t.groundSpeed);
    const own = gs > 5 ? Math.atan2(t.velocity[0], -t.velocity[2]) * (180 / Math.PI) : t.heading;
    const off = wrap180(track - own);
    const roll = clamp(off * 2, -75, 75);
    const out = this.plane.fly(dt, t, { vs, roll, speed, pitchMin: -25, pitchMax: 25, flaps: 0 });
    // Elevator by load factor (an attitude hold won't pull a hard turn): the g whose vertical
    // part holds the wanted vertical speed in this bank, so the steeper the bank the harder it
    // pulls and the faster it turns. The trim learns what level flight takes (lift from speed
    // round the planet makes it less than 1 g); kept off the stall and under 5 g.
    const bank = clamp(Math.abs(t.roll), 0, 80) * (Math.PI / 180);
    const vsErr = clamp(vs - t.verticalSpeed, -20, 20);
    this.chaseTrim = clamp(this.chaseTrim + vsErr * 0.01 * dt, 0.3, 1.5);
    let n = (this.chaseTrim + vsErr * 0.04) / Math.max(0.2, Math.cos(bank));
    n = clamp(n, -0.5, t.stall > 0.25 ? 1 : 5);
    const err = n - t.gForce;
    this.chaseElevator = clamp(this.chaseElevator + err * 0.12 * dt, -0.6, 0.8);
    return { ...out, pitch: clamp(this.chaseElevator + err * 0.06, -1, 1) };
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
    s.commanded = Math.max(s.altitude + terrainHeight(t.position[0], t.position[2]), this.orbitFloor);
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
      // Turn radius at the join speed: everything about the join scales with it.
      const R = turnRadius(Math.max(gs, vapp * 1.3), 25);
      const fix = approachPoint(ap, -IF_DISTANCE);
      const brgFix = bearing(t.position[0], t.position[2], fix[0], fix[1]);
      const dFix = distance(t.position[0], t.position[2], fix[0], fix[1]);
      // Direct to the initial fix only when that arrives roughly lined up; otherwise fly an
      // outbound leg offset 2R to our side of the centreline, whose 180° turn back ends on it.
      const fixAligned = Math.abs(wrap180(brgFix - ap.heading)) < 45;
      if (!fixAligned && !this.joinFar && dFix > 0.5 * R) {
        this.joinFar = true;
        this.joinSide = cross >= 0 ? 1 : -1;
      }
      if (this.joinFar && fixAligned && along < -(IF_DISTANCE + R)) this.joinFar = false;
      const wp = this.joinFar ? approachPoint(ap, -(IF_DISTANCE + R + 500), this.joinSide * 2 * R) : fix;
      const dWp = distance(t.position[0], t.position[2], wp[0], wp[1]);
      const headingOk = Math.abs(wrap180(t.heading - ap.heading)) < 60;
      const captured = !this.joinFar && along < -0.8 * IF_DISTANCE && along > -(IF_DISTANCE + 3 * R + 4000) && Math.abs(cross) < Math.max(R, 800) && headingOk;
      if (captured || dWp < Math.max(0.6 * R, 400)) {
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
        this.advisor.notify('go-around');
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
    if (s.mode === 'chase') return this.flyChase(dt, t, null);
    if (s.mode === 'goto' && this.dest) {
      const d = this.dest;
      const dist = distance(t.position[0], t.position[2], d.x, d.z);
      const alt = this.brainAltitude ?? s.altitude, speed = this.brainSpeed ?? s.speed;
      s.guidance = { distance: dist, glideslopeDev: null, localizerDev: null, targetSpeed: speed, eta: dist / Math.max(1, t.groundSpeed), siteName: d.name };
      if (dist < 25 && t.groundSpeed < 2) {
        s.phase = 'hold';
        s.status = `Go to · over ${d.name}`;
      } else {
        s.phase = 'transit';
        s.status = `Go to · ${d.name} · ${km(dist)}`;
      }
      return this.hoverTo(dt, t, d.x, d.z, alt, speed, 25);
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

  // ---------------------------------------------------------------- brain

  /** The outside brain, if any: notice what happened, ask when due, apply answers (inside this step). */
  private advise(t: Telemetry): void {
    const a = this.advisor;
    const s = this.state;
    if (!a.brain) {
      // No brain (the usual case): its picks go, back to the player's settings; nothing to ask.
      this.brainAltitude = this.brainSpeed = this.brainPace = null;
      if (a.status.state !== 'off') a.reset();
      return;
    }
    if (s.kind === 'ground') {
      if (this.driver.planSeq !== this.seenPlanSeq) {
        this.seenPlanSeq = this.driver.planSeq;
        a.notify('reroute');
      }
      const blocked = this.driver.wallAhead < 30 && t.groundSpeed < 1;
      if (blocked && !this.blockedSeen) a.notify('blocked');
      this.blockedSeen = blocked;
      const stuck = !!this.lastDrive?.stuck;
      if (stuck && !this.stuckSeen) a.notify('stuck');
      this.stuckSeen = stuck;
    }
    a.step(t.time, this.brainContext, (trigger) => this.buildDecision(t, trigger), (d, picks) => this.applyPicks(t, d, picks));
  }

  private get brainContext(): string {
    return `${this.engageSeq}|${this.state.kind}|${this.state.mode}`;
  }

  /** The decision worth asking now for this vehicle and mode (null: nothing to choose). */
  private buildDecision(t: Telemetry, trigger: string): BrainDecision | null {
    const s = this.state;
    const ground = s.kind === 'ground';
    const view = {
      kind: s.kind, mode: s.mode, phase: s.phase, t, dest: this.dest,
      userSpeed: s.speed, userAltitude: s.altitude,
      speed: ground ? Math.min(this.brainPace ?? s.speed, s.speed) : this.brainSpeed ?? s.speed,
      altitude: this.brainAltitude ?? s.altitude,
      stallSpeed: this.stallSpeed, approachSpeed: this.approachSpeed,
      driver: this.driver, drive: this.lastDrive, fractured: this.fractured ?? undefined, world: this.world,
      seq: this.advisor.nextSeq(), context: this.brainContext,
    };
    let b: BuiltDecision | null;
    if (s.mode === 'land') b = landingDecision(view, trigger);
    else if (ground) {
      // Routes only when something happened: asked on a timer, "another route" every few seconds
      // is how a car goes round in circles. A reroute asks at most every 20 s.
      const routes = trigger === 'engage' || trigger === 'instructions' || trigger === 'blocked' || trigger === 'stuck' || (trigger === 'reroute' && t.time - this.routeAskedAt > 20);
      b = groundDecision(view, trigger, routes);
      if (b && routes) this.routeAskedAt = t.time;
    } else b = airDecision(view, trigger);
    this.built = b;
    return b?.decision ?? null;
  }

  /** Carry out the brain's picks; says what was done, for the panel. */
  private applyPicks(t: Telemetry, d: BrainDecision, picks: Record<string, BrainOption>): string {
    const b = this.built;
    if (!b || b.decision.seq !== d.seq) return '';
    const s = this.state;
    const done: string[] = [];
    for (const [q, opt] of Object.entries(picks)) {
      const act = b.actions[q]?.[opt.id];
      if (!act) continue;
      switch (act.kind) {
        case 'keep-route':
          done.push('same route');
          break;
        case 'route':
          if (this.driver.adoptFrom(act.route, t.position[0], t.position[2])) {
            this.seenPlanSeq = this.driver.planSeq;
            done.push(`${opt.label} (${km(this.driver.length)})`);
          } else done.push(`too late for ${opt.label}: kept the route`);
          break;
        case 'pace':
          this.brainPace = act.speed;
          done.push(`${r0(act.speed)} m/s`);
          break;
        case 'altitude':
          this.brainAltitude = act.altitude;
          done.push(`${r0(act.altitude)} m`);
          break;
        case 'speed':
          this.brainSpeed = act.speed;
          done.push(s.kind === 'airplane' ? `${r0(act.speed * 1.944)} kt` : `${r0(act.speed)} m/s`);
          break;
        case 'site':
          if (act.id === this.dest?.id) done.push(`land at ${opt.label}`);
          else if (s.mode === 'land' && s.phase === (s.kind === 'airplane' ? 'join' : 'transit')) {
            s.destination = act.id;
            if (s.kind === 'airplane') this.startAirplaneLanding(t);
            else this.startRotorLanding(t);
            done.push(`land at ${this.dest?.name ?? opt.label}`);
          } else done.push(`too late for ${opt.label}`);
          break;
      }
    }
    return done.join(' · ');
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
      for (const r of [R - 120, R, R + 120]) top = Math.max(top, obstacleTop(wrapCoord(cx + Math.sin(a) * r), wrapCoord(cz - Math.cos(a) * r)));
    }
    return top > 0 ? top + 70 : 0;
  }
}
