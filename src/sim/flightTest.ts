import * as THREE from 'three';
import type { CraftDef } from '../craft/types.ts';
import { TUNING } from '../tuning.ts';
import type { WeatherSettings } from './atmosphere.ts';
import { Autopilot } from './autopilot.ts';
import { LAYOUT } from './layout.ts';
import { Simulation } from './Simulation.ts';
import type { Telemetry } from './telemetry.ts';
import { groundCard, lighterThanAirCard, rotorcraftCard, vehicleKind, type VehicleKind } from './vehicleTests.ts';

/** Numbers computed from the design itself, before flying. */
/** Human-readable failure line (structural overload or impact damage). */
export function describeFailure(f: { partId: string; load: number; strength: number; cause?: string }, advice: string): string {
  if (f.cause === 'impact') return `Impact damage: "${f.partId}" broke off in a collision (${(f.load / 1000).toFixed(1)} kN). Avoid hitting the ground or obstacles, or give the part more "hp".`;
  return `Structural failure: "${f.partId}" broke off at ${(f.load / 1000).toFixed(1)} kN (strength ${(f.strength / 1000).toFixed(1)} kN). ${advice}`;
}

export interface DesignMetrics {
  mass: number;
  /** Positive = CoM ahead of CoL (pitch-stable), as a fraction of mean wing chord. */
  staticMargin: number;
  thrustToWeight: number;
  wingArea: number;
  /** kg/m^2 */
  wingLoading: number;
  /** Rough 1g stall speed estimate (m/s). */
  stallSpeed: number;
  controls: { pitch: boolean; roll: boolean; yaw: boolean; flaps: boolean };
  wheels: number;
}

export interface FlightReport {
  /** Which test card was flown. */
  vehicle: VehicleKind;
  /** 0..100 */
  score: number;
  passed: boolean;
  design: DesignMetrics;
  /** Results of each phase. */
  restsLevel: boolean;
  tookOff: boolean;
  liftoffSpeed?: number;
  liftoffDistance?: number;
  reachedAltitude: boolean;
  maxAltitude: number;
  turned: boolean;
  handsOffStable: boolean;
  crashed: boolean;
  /** Parts that broke off during the test. */
  failures: Array<{ partId: string; load: number; strength: number; cause?: string }>;
  /** Actionable problems, phrased so a designer (human or model) can fix them. */
  issues: string[];
  /** Short timeline of what happened. */
  log: string[];
}

export interface FlightTestOptions {
  /** Yield to the event loop every N steps so a browser UI stays responsive. */
  yieldEvery?: number;
  /** Weather to fly the card in (default: calm). */
  weather?: WeatherSettings;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** scheduler.yield() where available (Chrome: resumes ahead of other tasks), else setTimeout. */
function yieldToEventLoop(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return s?.yield ? s.yield() : new Promise((r) => setTimeout(r, 0));
}

export function analyzeDesign(sim: Simulation): DesignMetrics {
  const craft = sim.craft;
  const mp = craft.massProps;
  const n = new THREE.Vector3();
  let area = 0;
  let chordSum = 0;
  let clMaxArea = 0;
  for (const s of craft.aeroSurfaces) {
    const horiz = Math.abs(s.localNormal(n).y);
    // Main lifting surfaces: count horizontal area; the tail adds little lift at trim.
    area += s.area * horiz;
    chordSum += s.def.chord * s.area * horiz;
    clMaxArea += s.liftSlope * s.stallAngle * s.area * horiz;
  }
  const meanChord = area > 0 ? chordSum / area : 1;
  const col = craft.centerOfLift();
  const weight = mp.mass * TUNING.gravity;
  const thrust = craft.engines.reduce((t, e) => t + e.def.maxThrust, 0);
  const clMax = area > 0 ? clMaxArea / area : 1;
  const ctl = { pitch: false, roll: false, yaw: false, flaps: false };
  for (const s of craft.aeroSurfaces) if (s.def.control) ctl[s.def.control.channel] = true;
  return {
    mass: Math.round(mp.mass),
    staticMargin: Math.round(((col.z - mp.com.z) / meanChord) * 100) / 100,
    thrustToWeight: Math.round((thrust / weight) * 100) / 100,
    wingArea: r1(area),
    wingLoading: r1(area > 0 ? mp.mass / area : Infinity),
    stallSpeed: r1(area > 0 ? Math.sqrt((2 * weight) / (TUNING.seaLevelDensity * area * clMax * 0.85)) : Infinity),
    controls: ctl,
    wheels: craft.wheels.length,
  };
}

/**
 * Flies a craft through a scripted test card with the autopilot (the same controls a player
 * has): rest on the runway, take off, climb to 150 m, turn 90 degrees, then fly hands-off.
 * Runs headless, ~150 simulated seconds in well under a second.
 */
export async function flightTest(def: CraftDef, opts: FlightTestOptions = {}): Promise<FlightReport> {
  const sim = new Simulation(def, opts.weather);
  const design = analyzeDesign(sim);
  const kind = vehicleKind(sim);
  const issues: string[] = [];
  const log: string[] = [];
  const yieldEvery = opts.yieldEvery ?? 0;
  let stepsSinceYield = 0;
  let crashed = false;
  let crashNote = '';
  let airborne = false;

  // Static checks (airplanes; other vehicles have their own in vehicleTests.ts)
  if (kind === 'airplane' && !design.controls.pitch) issues.push('No pitch control: add an elevator (control channel "pitch") on a tail surface.');
  if (kind === 'airplane' && !design.controls.roll) issues.push('No roll control: add ailerons (channel "roll", opposite gains on left/right wings).');
  if (kind === 'airplane' && !design.controls.yaw) issues.push('No yaw control: add a rudder (channel "yaw") on the vertical fin.');
  if (kind !== 'airplane') {
    /* skip wing-based checks */
  } else if (design.staticMargin < 0)
    issues.push(`Pitch-unstable: centre of mass is ${-design.staticMargin} mean chords BEHIND the centre of lift. Move heavy parts forward, move wings aft, or enlarge the horizontal tail.`);
  else if (design.staticMargin > 0.6)
    issues.push(`Very nose-heavy (static margin ${design.staticMargin} chords): elevator may lack authority to rotate. Move mass aft or wings forward slightly.`);
  if (kind === 'airplane' && design.thrustToWeight < 0.25)
    issues.push(`Underpowered: thrust/weight ${design.thrustToWeight}. Aim for 0.35-0.6 for a prop plane.`);
  if (kind === 'airplane' && design.wheels === 0) issues.push('No wheels: the craft cannot take off from the runway.');
  const strike = sim.craft.tailStrikeAngle();
  if (kind === 'airplane' && strike !== null && strike < 10)
    issues.push(`Tail-strike angle only ${r1(strike)}°: the tail drags if the nose rotates past that on take-off or landing (tail-strike protection then limits rotation). Aim for 12-15°: lengthen the main gear, move it aft, or raise the tail.`);

  const v = new THREE.Vector3();
  const step = async (pilot: (t: Telemetry) => Parameters<Simulation['step']>[0], seconds: number, until?: (t: Telemetry) => boolean) => {
    const n = Math.round(seconds / sim.dt);
    let t = sim.telemetry();
    for (let i = 0; i < n; i++) {
      sim.step(pilot(t));
      t = sim.telemetry();
      if (sim.explosionResets > 0 && !crashed) {
        crashed = true;
        crashNote = 'physics blew up (NaN guard reset the craft)';
      }
      if ((airborne || (kind !== 'airplane' && t.altitude > 2)) && !crashed && sim.airframeTouchingGround()) {
        const s = sim.craft.body.linvel();
        v.set(s.x, s.y, s.z);
        // Airplanes must never touch the airframe once airborne. Rotorcraft/blimps land on
        // skids, so only a fast or tumbling contact counts.
        const hard = kind === 'airplane' || v.length() > 6 || Math.abs(t.roll) > 45 || Math.abs(t.pitch) > 45;
        if (hard) {
          crashed = true;
          crashNote = `airframe hit the ground at ${r1(v.length())} m/s (t=${r1(t.time)}s, pitch ${t.pitch}°, roll ${t.roll}°)`;
        }
      }
      if (kind !== 'airplane' && t.altitude > 2) airborne = true;
      if (until?.(t) || crashed) return t;
      if (yieldEvery && ++stepsSinceYield >= yieldEvery) {
        stepsSinceYield = 0;
        await yieldToEventLoop();
      }
    }
    return t;
  };
  const neutral = () => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 });

  if (kind !== 'airplane') {
    const state = {
      get crashed() {
        return crashed;
      },
    };
    const card = kind === 'rotorcraft' ? await rotorcraftCard(sim, step, state) : kind === 'ground' ? await groundCard(sim, step, state) : await lighterThanAirCard(sim, step, state);
    issues.push(...card.issues);
    log.push(...card.log);
    const failures = sim.failures.map(({ partId, load, strength, cause }) => ({ partId, load, strength, cause }));
    for (const f of failures) issues.push(describeFailure(f, 'Strengthen it or reduce the load on it.'));
    if (sim.craft.fuelCapacity > 0 && sim.craft.fuel <= 0) issues.push('Ran out of fuel during the test: add tank capacity.');
    if (crashed) {
      log.push(`CRASH: ${crashNote}`);
      issues.push(`Crashed: ${crashNote}.`);
    }
    let score = card.phases.reduce((a, p) => a + (p.passed ? p.points : 0), 0);
    if (crashed) score = Math.max(0, score - 15);
    if (failures.length) score = Math.max(0, score - 10);
    const passedNamed = (n: string) => card.phases.some((p) => p.name.startsWith(n) && p.passed);
    return {
      vehicle: kind,
      score,
      passed: score === 100,
      design,
      restsLevel: passedNamed('rest'),
      tookOff: passedNamed('lift-off') || passedNamed('climb'),
      reachedAltitude: passedNamed('climb'),
      maxAltitude: card.maxAltitude,
      turned: passedNamed('yaw') || passedNamed('turn'),
      handsOffStable: passedNamed('hover') || passedNamed('hands-off'),
      crashed,
      failures,
      issues,
      log,
    };
  }

  // 1. Rest on the runway
  let t = await step(neutral, 3);
  const scraping = sim.airframeTouchingGround();
  const restsLevel = t.onGround && Math.abs(t.roll) < 8 && Math.abs(t.pitch) < 12 && !scraping;
  log.push(`rest: pitch ${t.pitch}°, roll ${t.roll}°, on wheels ${t.onGround}${scraping ? ', airframe touching ground' : ''}`);
  if (!t.onGround) issues.push('At rest the wheels do not touch the ground: wheel offsets/restLength/radius are too short or misplaced.');
  if (scraping) issues.push('At rest part of the airframe touches the ground: make the landing gear longer or lower the wheels.');
  if (Math.abs(t.roll) >= 8) issues.push(`Craft tips over sideways at rest (roll ${t.roll}°): main wheels need wider lateral spacing.`);
  if (Math.abs(t.pitch) >= 12) issues.push(`Craft sits at ${t.pitch}° pitch on the ground: balance the wheel heights or move wheels relative to the CoM.`);

  // 2. Takeoff (distances measured from where the craft came to rest)
  const startZ = t.position[2];
  const cruise = THREE.MathUtils.clamp(design.stallSpeed * 1.6, 25, 120);
  const ap = new Autopilot({ heading: 0, altitude: 150, airspeed: cruise });
  ap.rotateSpeed = THREE.MathUtils.clamp(design.stallSpeed * 1.15, 12, 90);
  let maxSpeed = 0;
  let liftoffSpeed: number | undefined;
  let liftoffDistance: number | undefined;
  t = await step((tt) => {
    maxSpeed = Math.max(maxSpeed, tt.airspeed);
    if (!airborne && !tt.onGround && tt.altitude > 1.5) {
      airborne = true;
      liftoffSpeed = tt.airspeed;
      liftoffDistance = Math.round(startZ - tt.position[2]);
    }
    return ap.sample(sim.dt, tt);
  }, 70, (tt) => tt.altitude > 20);
  const tookOff = airborne && t.altitude > 20 && !crashed;
  if (tookOff) log.push(`takeoff: lift-off at ${r1(liftoffSpeed!)} m/s after ${liftoffDistance} m`);
  else if (!crashed) {
    log.push(`takeoff: failed, top speed ${r1(maxSpeed)} m/s`);
    issues.push(
      maxSpeed < design.stallSpeed
        ? `Did not take off: top ground speed ${r1(maxSpeed)} m/s is below the estimated stall speed ${design.stallSpeed} m/s. Add wing area or thrust, or reduce mass.`
        : `Did not take off despite reaching ${r1(maxSpeed)} m/s (est. stall ${design.stallSpeed} m/s): the elevator likely cannot raise the nose. Check the elevator gain sign (-1 on a rear tail with normal +Y), enlarge the tail, or move main wheels closer behind the CoM.`,
    );
  }
  const runwayLeft = Math.round(startZ - (LAYOUT.runway.centerZ - LAYOUT.runway.length / 2));
  if (liftoffDistance !== undefined && liftoffDistance > runwayLeft)
    issues.push(`Needed ${liftoffDistance} m of ground roll but the runway only has ${runwayLeft} m.`);

  // 3. Climb
  let maxAltitude = t.altitude;
  let reachedAltitude = false;
  if (tookOff) {
    t = await step((tt) => {
      maxAltitude = Math.max(maxAltitude, tt.altitude);
      return ap.sample(sim.dt, tt);
    }, 60, (tt) => tt.altitude >= 140);
    reachedAltitude = t.altitude >= 140 && !crashed;
    log.push(`climb: ${reachedAltitude ? 'reached' : 'did not reach'} 140 m (max ${r1(maxAltitude)} m)`);
    if (!reachedAltitude && !crashed) issues.push(`Weak climb: only reached ${r1(maxAltitude)} m in 60 s. Add thrust or wing area, or reduce drag/mass.`);
  }

  // 4. Turn to heading 090
  let turned = false;
  if (reachedAltitude) {
    ap.targets.heading = 90;
    let maxRoll = 0;
    const alt0 = t.altitude;
    t = await step((tt) => {
      maxRoll = Math.max(maxRoll, Math.abs(tt.roll));
      maxAltitude = Math.max(maxAltitude, tt.altitude);
      return ap.sample(sim.dt, tt);
    }, 35);
    const hdgErr = Math.abs(((t.heading - 90 + 540) % 360) - 180);
    turned = hdgErr < 15 && !crashed;
    log.push(`turn: heading ${Math.round(t.heading)}° (target 90), max bank ${Math.round(maxRoll)}°, altitude change ${Math.round(t.altitude - alt0)} m`);
    if (!turned && !crashed) issues.push(`Could not complete a 90° turn (ended at ${Math.round(t.heading)}°). Ailerons may be too small, reversed (left wing gain +1, right wing gain -1), or the craft lacks directional stability (fin too small).`);
  }

  // 5. Hands off: level out, then freeze the elevator at its trimmed position (like a pilot
  //    trimming and letting go). Stable craft hold their attitude; unstable ones diverge.
  let handsOffStable = false;
  if (turned) {
    ap.targets.heading = t.heading;
    let trimPitch = 0;
    t = await step((tt) => {
      const c = ap.sample(sim.dt, tt);
      trimPitch += (c.pitch - trimPitch) * 0.02; // low-pass the autopilot's elevator = trim
      return c;
    }, 8);
    const thr = t.throttle;
    let worstPitch = 0;
    let worstRoll = 0;
    let stalled = false;
    t = await step((tt) => {
      worstPitch = Math.max(worstPitch, Math.abs(tt.pitch));
      worstRoll = Math.max(worstRoll, Math.abs(tt.roll));
      if (tt.stall > 0.6) stalled = true;
      return { pitch: trimPitch, roll: 0, yaw: 0, throttle: thr, brake: 0 };
    }, 12);
    handsOffStable = !crashed && worstPitch < 45 && worstRoll < 60 && !stalled;
    log.push(`hands-off 12 s: max |pitch| ${Math.round(worstPitch)}°, max |roll| ${Math.round(worstRoll)}°${stalled ? ', stalled' : ''}`);
    if (!handsOffStable && !crashed)
      issues.push(`Unstable hands-off (max pitch ${Math.round(worstPitch)}°, roll ${Math.round(worstRoll)}°${stalled ? ', stalled' : ''}). Increase static margin, horizontal tail area/arm, dihedral, or fin area.`);
  }

  if (crashed) {
    log.push(`CRASH: ${crashNote}`);
    issues.push(`Crashed: ${crashNote}.`);
  }

  const failures = sim.failures.map(({ partId, load, strength, cause }) => ({ partId, load, strength, cause }));
  for (const f of failures) issues.push(describeFailure(f, 'Strengthen it (part "strength") or reduce the load (e.g. limit control throws).'));
  if (sim.craft.fuelCapacity > 0 && sim.craft.fuel <= 0) issues.push('Ran out of fuel during the test: add tank capacity.');

  let score = 0;
  if (restsLevel) score += 10;
  if (tookOff) score += 30;
  if (reachedAltitude) score += 20;
  if (turned) score += 20;
  if (handsOffStable) score += 20;
  if (crashed) score = Math.max(0, score - 15);
  if (failures.length) score = Math.max(0, score - 10);

  return {
    vehicle: kind,
    score,
    passed: score === 100,
    design,
    restsLevel,
    tookOff,
    liftoffSpeed: liftoffSpeed !== undefined ? r1(liftoffSpeed) : undefined,
    liftoffDistance,
    reachedAltitude,
    maxAltitude: r1(maxAltitude),
    turned,
    handsOffStable,
    crashed,
    failures,
    issues,
    log,
  };
}

/** Plain-text report, used both in the UI and as feedback to a designer model. */
export function formatReport(r: FlightReport): string {
  const d = r.design;
  return [
    `Score ${r.score}/100 ${r.passed ? '(PASS)' : ''} (${r.vehicle} test card)`,
    r.vehicle !== 'airplane' ? `Design: mass ${d.mass} kg` : `Design: mass ${d.mass} kg, wing area ${d.wingArea} m², loading ${d.wingLoading} kg/m², T/W ${d.thrustToWeight}, static margin ${d.staticMargin} chords, est. stall ${d.stallSpeed} m/s`,
    ...r.log.map((l) => `- ${l}`),
    ...(r.issues.length ? ['Issues:', ...r.issues.map((i) => `* ${i}`)] : ['No issues found.']),
  ].join('\n');
}
