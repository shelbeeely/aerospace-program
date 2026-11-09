import * as THREE from 'three';
import { TUNING } from '../tuning.ts';
import { HoverPilot } from './autopilot.ts';
import type { ControlInputs } from './controls.ts';
import type { Simulation } from './Simulation.ts';
import type { Telemetry } from './telemetry.ts';

export type VehicleKind = 'airplane' | 'rotorcraft' | 'lighter-than-air' | 'ground';

/** What kind of test card fits this craft. */
export function vehicleKind(sim: Simulation): VehicleKind {
  const craft = sim.craft;
  const weight = craft.massProps.mass * TUNING.gravity;
  const buoyancy = craft.gasCells.reduce((a, c) => a + c.seaLevelLift(), 0);
  if (buoyancy > 0.7 * weight) return 'lighter-than-air';
  if (craft.wheels.some((w) => (w.def.drive ?? 0) > 0)) return 'ground';
  if (craft.rotors.length && craft.flightController) return 'rotorcraft';
  if (craft.rotors.length && !craft.engines.length) return 'rotorcraft';
  return 'airplane';
}

export interface CardResult {
  phases: Array<{ name: string; passed: boolean; points: number }>;
  maxAltitude: number;
  crashed: boolean;
  issues: string[];
  log: string[];
}

type Step = (pilot: (t: Telemetry) => ControlInputs, seconds: number, until?: (t: Telemetry) => boolean) => Promise<Telemetry>;

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Rotorcraft card: rest on skids/wheels, lift off to a 10 m hover and hold it, climb to 50 m,
 * fly forward 150 m, yaw 90°, then descend and touch down gently.
 */
export async function rotorcraftCard(sim: Simulation, step: Step, state: { crashed: boolean }): Promise<CardResult> {
  const issues: string[] = [];
  const log: string[] = [];
  const phases: CardResult['phases'] = [];
  const craft = sim.craft;
  const weight = craft.massProps.mass * TUNING.gravity;
  const liftRotors = craft.rotors.filter((r) => r.def.inputs?.collective !== 'yaw');
  const maxThrust = liftRotors.reduce((a, r) => a + Math.abs(r.staticThrust()), 0);
  const ratio = maxThrust / weight;
  log.push(`rotors: ${craft.rotors.length}, static thrust/weight ${r1(ratio)}`);
  if (!craft.flightController) issues.push('No flight controller: add a "flightController" module (mode "multirotor" or "helicopter"). Rotorcraft are not flyable without one.');
  if (ratio < 1.2) issues.push(`Rotor thrust/weight is only ${r1(ratio)}: needs at least 1.5-2 to hover and climb. Bigger radius, more blades/chord, more rpm or pitch, or less mass.`);
  if (craft.flightController?.def.mode === 'helicopter' && !craft.rotors.some((r) => r.def.inputs?.collective === 'yaw'))
    issues.push('Helicopter has no tail rotor (a collective rotor with inputs.collective "yaw"): the main rotor torque will spin the fuselage.');

  // 1. Rest
  let t = await step(() => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 }), 2);
  const restOk = t.onGround && Math.abs(t.roll) < 10 && Math.abs(t.pitch) < 12;
  phases.push({ name: 'rest', passed: restOk, points: 10 });
  log.push(`rest: pitch ${t.pitch}°, roll ${t.roll}°, on ground ${t.onGround}`);
  if (!restOk) issues.push(`Does not rest level on its skids/wheels (pitch ${t.pitch}°, roll ${t.roll}°): add skid parts under the CoM, spread apart.`);

  // 2. Lift off and hover at 10 m for 10 s
  const pilot = new HoverPilot({ altitude: 10, heading: t.heading, forwardSpeed: 0 });
  const x0 = t.position[0];
  const z0 = t.position[2];
  t = await step((tt) => pilot.sample(sim.dt, tt), 20, (tt) => tt.altitude > 9);
  const liftedOff = t.altitude > 9 && !state.crashed;
  let hoverOk = false;
  let maxAltitude = t.altitude;
  if (liftedOff) {
    let drift = 0;
    let altDev = 0;
    let maxTilt = 0;
    t = await step((tt) => {
      drift = Math.max(drift, Math.hypot(tt.position[0] - x0, tt.position[2] - z0));
      altDev = Math.max(altDev, Math.abs(tt.altitude - 10));
      maxTilt = Math.max(maxTilt, Math.abs(tt.pitch), Math.abs(tt.roll));
      return pilot.sample(sim.dt, tt);
    }, 10);
    hoverOk = !state.crashed && altDev < 3 && maxTilt < 35;
    log.push(`hover 10 s: altitude ±${r1(altDev)} m, drift ${r1(drift)} m, max tilt ${Math.round(maxTilt)}°`);
    if (!hoverOk && !state.crashed)
      issues.push(`Unsteady hover (altitude ±${r1(altDev)} m, tilt up to ${Math.round(maxTilt)}°): check the CoM is centred under the rotors and the flight controller gains.`);
  } else {
    log.push(`lift-off: failed (max altitude ${t.altitude} m)`);
    if (!state.crashed) issues.push(`Could not lift off to 10 m (reached ${t.altitude} m). More rotor thrust or less mass.`);
  }
  phases.push({ name: 'lift-off', passed: liftedOff, points: 20 });
  phases.push({ name: 'hover', passed: hoverOk, points: 15 });

  // 3. Climb to 50 m
  let climbed = false;
  if (hoverOk) {
    pilot.targets.altitude = 50;
    t = await step((tt) => {
      maxAltitude = Math.max(maxAltitude, tt.altitude);
      return pilot.sample(sim.dt, tt);
    }, 30, (tt) => tt.altitude > 47);
    climbed = t.altitude > 47 && !state.crashed;
    log.push(`climb: ${climbed ? 'reached' : 'did not reach'} 50 m`);
    if (!climbed && !state.crashed) issues.push('Weak climb: could not reach 50 m in 30 s.');
  }
  phases.push({ name: 'climb', passed: climbed, points: 15 });

  // 4. Forward flight 150 m
  let cruised = false;
  if (climbed) {
    pilot.targets.forwardSpeed = 12;
    const sx = t.position[0];
    const sz = t.position[2];
    let maxSpeed = 0;
    t = await step((tt) => {
      maxSpeed = Math.max(maxSpeed, tt.groundSpeed);
      maxAltitude = Math.max(maxAltitude, tt.altitude);
      return pilot.sample(sim.dt, tt);
    }, 40, (tt) => Math.hypot(tt.position[0] - sx, tt.position[2] - sz) > 150);
    const dist = Math.hypot(t.position[0] - sx, t.position[2] - sz);
    cruised = dist > 150 && !state.crashed && Math.abs(t.altitude - 50) < 15;
    log.push(`forward flight: ${Math.round(dist)} m, top speed ${r1(maxSpeed)} m/s, altitude ${Math.round(t.altitude)} m`);
    if (!cruised && !state.crashed) issues.push(`Poor forward flight (${Math.round(dist)} m in 40 s): needs more tilt authority or thrust margin.`);
  }
  phases.push({ name: 'forward flight', passed: cruised, points: 15 });

  // 5. Yaw 90°
  let yawed = false;
  if (cruised) {
    pilot.targets.forwardSpeed = 0;
    pilot.targets.heading = (t.heading + 90) % 360;
    t = await step((tt) => pilot.sample(sim.dt, tt), 15);
    const err = Math.abs(((t.heading - pilot.targets.heading + 540) % 360) - 180);
    yawed = err < 15 && !state.crashed;
    log.push(`yaw 90°: ended ${Math.round(err)}° off`);
    if (!yawed && !state.crashed) issues.push('Weak yaw control: could not turn 90° in 15 s (more rotor torque difference, or a stronger tail rotor).');
  }
  phases.push({ name: 'yaw', passed: yawed, points: 10 });

  // 6. Land
  let landed = false;
  if (yawed) {
    pilot.targets.altitude = -2; // descend until contact
    let touchdownVs = 0;
    t = await step((tt) => {
      const p = pilot.sample(sim.dt, tt);
      // Slow down near the ground.
      if (tt.altitude < 8) p.throttle = Math.min(1, Math.max(0, 0.5 + (-1 - tt.verticalSpeed) * 0.15));
      touchdownVs = tt.verticalSpeed;
      return p;
    }, 60, (tt) => tt.onGround);
    landed = t.onGround && !state.crashed && touchdownVs > -3;
    log.push(`landing: ${landed ? 'soft' : 'failed'} touchdown at ${r1(touchdownVs)} m/s`);
  }
  phases.push({ name: 'landing', passed: landed, points: 15 });

  return { phases, maxAltitude: r1(maxAltitude), crashed: state.crashed, issues, log };
}

/**
 * Lighter-than-air card: rest moored, take off under power (buoyancy + hull lift), reach 60 m,
 * turn 90°, and show it is pendulum-stable hands-off.
 */
export async function lighterThanAirCard(sim: Simulation, step: Step, state: { crashed: boolean }): Promise<CardResult> {
  const issues: string[] = [];
  const log: string[] = [];
  const phases: CardResult['phases'] = [];
  const craft = sim.craft;
  const weight = craft.massProps.mass * TUNING.gravity;
  const buoyancy = craft.gasCells.reduce((a, c) => a + c.seaLevelLift(), 0);
  const ratio = buoyancy / weight;
  log.push(`buoyancy/weight ${(ratio * 100).toFixed(1)}%`);
  if (ratio > 1.03) issues.push(`${((ratio - 1) * 100).toFixed(0)}% lighter than air: it will float away uncontrolled. Add mass (ballast) or reduce gas volume to ~98-100% of weight.`);
  if (ratio < 0.9) issues.push(`Only ${(ratio * 100).toFixed(0)}% of the weight is carried by gas: add volume or lose mass (aim for 98-100%).`);
  // Centre of buoyancy should be above the CoM, not ahead/behind it.
  const cob = new THREE.Vector3();
  for (const c of craft.gasCells) cob.addScaledVector(c.localPosition, c.seaLevelLift());
  if (buoyancy > 0) cob.divideScalar(buoyancy);
  const com = craft.massProps.com;
  if (Math.abs(cob.z - com.z) > 0.6)
    issues.push(`Centre of buoyancy is ${r1(com.z - cob.z)} m ${cob.z < com.z ? 'ahead of' : 'behind'} the CoM: it will hang nose-${cob.z < com.z ? 'up' : 'down'}. Move the gondola/heavy parts under the gas.`);
  if (cob.y < com.y + 1) issues.push('Centre of buoyancy is not well above the CoM: put the heavy parts (gondola) low for pendulum stability.');

  let t = await step(() => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 }), 3);
  const restOk = Math.abs(t.pitch) < 10 && Math.abs(t.roll) < 10;
  phases.push({ name: 'rest', passed: restOk, points: 15 });
  log.push(`rest: pitch ${t.pitch}°, roll ${t.roll}°, altitude ${t.altitude} m`);

  // Take off: full power, gentle up-elevator, until 60 m.
  let maxAltitude = t.altitude;
  t = await step((tt) => {
    maxAltitude = Math.max(maxAltitude, tt.altitude);
    return { pitch: tt.pitch < 15 ? 0.5 : 0, roll: 0, yaw: 0, throttle: 1, brake: 0 };
  }, 90, (tt) => tt.altitude > 60);
  const climbed = t.altitude > 60 && !state.crashed;
  phases.push({ name: 'climb to 60 m', passed: climbed, points: 35 });
  log.push(`climb: ${climbed ? 'reached' : 'did not reach'} 60 m in ${climbed ? r1(t.time) : 90} s (max ${r1(maxAltitude)} m)`);
  if (!climbed && !state.crashed) issues.push('Could not climb to 60 m: more thrust, larger elevators, or get closer to neutral buoyancy.');

  let turned = false;
  let stable = false;
  if (climbed) {
    // Blimps steer with the rudder (no ailerons) and hold height with the elevator.
    const target = (t.heading + 90) % 360;
    const wrap = (d: number) => ((d + 540) % 360) - 180;
    const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
    let prevHeading = t.heading;
    t = await step((tt) => {
      const yawRate = wrap(tt.heading - prevHeading) / sim.dt; // deg/s, damps the hull's yaw instability
      prevHeading = tt.heading;
      return {
        yaw: clamp1(wrap(target - tt.heading) * 0.04 - yawRate * 0.12),
        pitch: clamp1((60 - tt.altitude) * 0.03 - tt.pitch * 0.03),
        roll: 0,
        throttle: 0.8,
        brake: 0,
      };
    }, 40);
    const err = Math.abs(wrap(t.heading - target));
    turned = err < 20 && !state.crashed;
    log.push(`turn 90°: ended ${Math.round(err)}° off`);
    if (!turned && !state.crashed) issues.push('Could not turn 90° in 40 s: bigger rudders, or fins further aft.');
    let worst = 0;
    const thr = t.throttle;
    t = await step((tt) => {
      worst = Math.max(worst, Math.abs(tt.pitch), Math.abs(tt.roll));
      return { pitch: 0, roll: 0, yaw: 0, throttle: thr, brake: 0 };
    }, 20);
    stable = worst < 35 && !state.crashed;
    log.push(`hands-off 20 s: max tilt ${Math.round(worst)}°`);
    if (!stable && !state.crashed) issues.push('Not stable hands-off: lower the CoM below the gas and enlarge the tail fins.');
  }
  phases.push({ name: 'turn', passed: turned, points: 25 });
  phases.push({ name: 'hands-off', passed: stable, points: 25 });

  return { phases, maxAltitude: r1(maxAltitude), crashed: state.crashed, issues, log };
}

/** Steering and speed control for ground vehicles (test cards, and later AI riders). */
export class GroundPilot {
  heading: number;
  speed: number;
  brake = 0;
  private speedI = 0;
  constructor(heading: number, speed: number) {
    this.heading = heading;
    this.speed = speed;
  }
  sample(dt: number, t: Telemetry): ControlInputs {
    const err = ((((this.heading - t.heading) % 360) + 540) % 360) - 180;
    const yaw = Math.max(-1, Math.min(1, err * 0.04));
    const se = this.speed - t.groundSpeed;
    this.speedI = Math.max(-5, Math.min(5, this.speedI + se * dt));
    const throttle = this.brake > 0 ? 0 : Math.max(0, Math.min(1, 0.3 + se * 0.15 + this.speedI * 0.05));
    return { pitch: 0, roll: 0, yaw, throttle, brake: this.brake };
  }
}

/**
 * Ground vehicle card (light cycles, cars): rest upright, accelerate to 25 m/s, turn to 090,
 * brake to a stop, never falling over.
 */
export async function groundCard(sim: Simulation, step: Step, state: { crashed: boolean }): Promise<CardResult> {
  const issues: string[] = [];
  const log: string[] = [];
  const phases: CardResult['phases'] = [];
  let worstRoll = 0;
  const watch = (pilot: (t: Telemetry) => ControlInputs) => (t: Telemetry) => {
    worstRoll = Math.max(worstRoll, Math.abs(t.roll));
    return pilot(t);
  };
  let t = await step(watch(() => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 })), 3);
  const restOk = t.onGround && Math.abs(t.roll) < 10;
  phases.push({ name: 'rest', passed: restOk, points: 10 });
  log.push(`rest: roll ${t.roll}°, on wheels ${t.onGround}`);
  if (!restOk) issues.push(`Does not stand upright on its wheels at rest (roll ${t.roll}°): add a "stabilizer" module, or wheels spread sideways.`);

  const pilot = new GroundPilot(t.heading, 25);
  const t0 = t.time;
  t = await step(watch((tt) => pilot.sample(sim.dt, tt)), 25, (tt) => tt.groundSpeed >= 25);
  const accel = t.groundSpeed >= 24 && !state.crashed;
  phases.push({ name: 'accelerate', passed: accel, points: 30 });
  log.push(`accelerate: ${r1(t.groundSpeed)} m/s after ${r1(t.time - t0)} s`);
  if (!accel) issues.push(`Only reached ${r1(t.groundSpeed)} m/s: give the rear wheel more "drive" (N) or reduce mass and drag.`);

  pilot.heading = (t.heading + 90) % 360;
  pilot.speed = 20;
  t = await step(watch((tt) => pilot.sample(sim.dt, tt)), 15);
  const err = Math.abs(((((pilot.heading - t.heading) % 360) + 540) % 360) - 180);
  const turned = err < 15 && !state.crashed;
  phases.push({ name: 'turn', passed: turned, points: 25 });
  log.push(`turn: heading ${Math.round(t.heading)}° (target ${Math.round(pilot.heading)}), lean ${t.roll}°`);
  if (!turned) issues.push(`Could not turn to ${Math.round(pilot.heading)}° (ended ${Math.round(t.heading)}°): more "maxSteerDeg" on the front wheel, or more grip.`);

  pilot.brake = 1;
  t = await step(watch((tt) => pilot.sample(sim.dt, tt)), 15, (tt) => tt.groundSpeed < 0.5);
  const stopped = t.groundSpeed < 1 && !state.crashed;
  phases.push({ name: 'brake', passed: stopped, points: 20 });
  log.push(`brake: ${r1(t.groundSpeed)} m/s`);
  if (!stopped) issues.push('Did not stop: give the wheels "brakes": true.');

  const upright = worstRoll < 50 && !state.crashed;
  phases.push({ name: 'upright', passed: upright, points: 15 });
  log.push(`max lean ${Math.round(worstRoll)}°`);
  if (!upright) issues.push(`Fell over (lean reached ${Math.round(worstRoll)}°): stronger "stabilizer", lower centre of mass.`);
  return { phases, maxAltitude: 0, crashed: state.crashed, issues, log };
}
