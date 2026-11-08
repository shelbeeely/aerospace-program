/**
 * Headless flight test: runs the real simulation in Node, faster than real time, and checks
 * the Stage 1 acceptance behaviours. Run with `npm run sim`.
 */
import * as THREE from 'three';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { Autopilot } from '../src/sim/autopilot.ts';
import type { ControlInputs } from '../src/sim/controls.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import type { Telemetry } from '../src/sim/telemetry.ts';

await initPhysics();

const fmt = (t: Telemetry) =>
  `t=${t.time.toFixed(1).padStart(5)} spd=${t.airspeed.toFixed(1).padStart(5)} alt=${t.altitude.toFixed(1).padStart(6)} ` +
  `vs=${t.verticalSpeed.toFixed(1).padStart(5)} pitch=${t.pitch.toFixed(1).padStart(5)} roll=${t.roll.toFixed(1).padStart(6)} ` +
  `hdg=${t.heading.toFixed(0).padStart(3)} aoa=${t.angleOfAttack.toFixed(1).padStart(5)} g=${t.gForce.toFixed(2)} ` +
  `stall=${t.stall.toFixed(2)} gnd=${t.onGround ? 'Y' : 'n'} in(p=${t.controls.pitch.toFixed(2)} r=${t.controls.roll.toFixed(2)} thr=${t.controls.throttle.toFixed(2)})`;

function run(
  sim: Simulation,
  seconds: number,
  pilot: (t: Telemetry, dt: number) => ControlInputs,
  printEvery = 2,
  stop?: (t: Telemetry) => boolean,
): Telemetry {
  let t = sim.telemetry();
  const n = Math.round(seconds / sim.dt);
  const every = Math.round(printEvery / sim.dt);
  for (let i = 0; i < n; i++) {
    sim.step(pilot(t, sim.dt));
    t = sim.telemetry();
    if (every > 0 && i % every === 0) console.log(fmt(t));
    if (stop?.(t)) break;
  }
  return t;
}

const sim = new Simulation(TEST_PLANE);
const mp = sim.craft.massProps;
console.log(`mass=${mp.mass.toFixed(0)} kg  CoM=${mp.com.toArray().map((x) => x.toFixed(2))}`);
console.log(`CoL=${sim.craft.centerOfLift().toArray().map((x) => x.toFixed(2))}  principal I=${mp.principal.toArray().map((x) => x.toFixed(0))}`);
console.log(`resting height=${sim.craft.restingHeight().toFixed(2)}`);

// Inertia check: R diag R^T must reproduce the tensor.
{
  const R = new THREE.Matrix4().makeRotationFromQuaternion(mp.principalFrame);
  const e = R.elements;
  const d = mp.principal.toArray();
  let maxErr = 0;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += e[k * 4 + i] * d[k] * e[k * 4 + j];
      maxErr = Math.max(maxErr, Math.abs(s - mp.inertia[i * 3 + j]));
    }
  console.log(`inertia reconstruction error=${maxErr.toExponential(2)}`);
}

console.log('\n--- settle on runway');
run(sim, 3, () => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 }), 1);

console.log('\n--- autopilot: takeoff, climb to 300 m @ 45 m/s');
const ap = new Autopilot({ heading: 0, altitude: 300, airspeed: 45 });
let liftoff: Telemetry | null = null;
let tel = run(sim, 60, (t, dt) => {
  const c = ap.sample(dt, t);
  if (!liftoff && !t.onGround && t.altitude > 1) liftoff = t;
  return c;
}, 4);
console.log(liftoff ? `LIFTOFF at ${(liftoff as Telemetry).airspeed} m/s, t=${(liftoff as Telemetry).time}s` : 'NO LIFTOFF');

console.log('\n--- autopilot: turn to heading 090');
ap.targets.heading = 90;
tel = run(sim, 30, (t, dt) => ap.sample(dt, t), 3);

console.log('\n--- climb to 500 m for the stall test');
ap.targets.altitude = 500;
ap.targets.heading = 0;
run(sim, 150, (t, dt) => ap.sample(dt, t), 0, (t) => t.altitude > 490);
console.log(fmt(sim.telemetry()));

for (const [label, rudder] of [['straight', 0], ['with full rudder (spin entry)', 1]] as const) {
  console.log(`\n--- stall test ${label}: idle, full aft stick for 6 s`);
  tel = run(sim, 6, () => ({ pitch: 1, roll: 0, yaw: rudder, throttle: 0, brake: 0 }), 0.5);
  console.log('--- recovery: neutral stick + opposite rudder, full power, then level off');
  const altBefore = tel.altitude;
  let minAlt = Infinity;
  tel = run(sim, 25, (t) => {
    minAlt = Math.min(minAlt, t.altitude);
    const diving = t.verticalSpeed < -2;
    return {
      pitch: t.stall > 0.2 ? -0.2 : diving && t.airspeed > 35 ? 0.4 : 0,
      roll: Math.max(-1, Math.min(1, -t.roll * 0.03)),
      yaw: -rudder * (t.stall > 0.2 ? 1 : 0),
      throttle: 1,
      brake: 0,
    };
  }, 2);
  console.log(`altitude lost: ${(altBefore - minAlt).toFixed(0)} m, final stall=${tel.stall} roll=${tel.roll}`);
  // climb back
  ap.targets.altitude = 500;
  run(sim, 120, (t, dt) => ap.sample(dt, t), 0, (t) => t.altitude > 490 && Math.abs(t.verticalSpeed) < 3);
}

console.log('\n--- CoM shifted 1.6 m aft (behind CoL), hands off');
sim.resetToRunway();
const ap2 = new Autopilot({ heading: 0, altitude: 300, airspeed: 45 });
run(sim, 50, (t, dt) => ap2.sample(dt, t), 0);
console.log('before shift:', fmt(sim.telemetry()));
sim.craft.setComOffset(new THREE.Vector3(0, 0, 1.6));
console.log(`CoM=${sim.craft.centerOfMass().z.toFixed(2)} CoL=${sim.craft.centerOfLift().z.toFixed(2)}`);
run(sim, 8, (t) => ({ pitch: 0, roll: 0, yaw: 0, throttle: t.throttle, brake: 0 }), 0.5);
sim.craft.setComOffset(new THREE.Vector3());

console.log('\n--- crash test: dive into the ground at full power');
sim.resetToRunway();
run(sim, 40, (t, dt) => ap2.sample(dt, t), 0);
run(sim, 30, () => ({ pitch: -1, roll: 0.3, yaw: 0, throttle: 1, brake: 0 }), 2);
console.log('explosion resets:', sim.explosionResets);
sim.resetToRunway();
run(sim, 2, () => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 }), 1);

// Speed benchmark
const t0 = performance.now();
const N = 12000;
for (let i = 0; i < N; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0.5, brake: 0 });
const ms = (performance.now() - t0) / N;
console.log(`\nstep cost: ${(ms * 1000).toFixed(1)} µs/step  (${(1 / 120 / (ms / 1000)).toFixed(0)}x real time)`);

// Jet engine model: turbofan thrust lapse with altitude and Mach, afterburner.
console.log('\n--- jet: turbofan lapse and afterburner');
const { JET } = await import('../src/craft/jet.ts');
let failed = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
  if (!ok) failed++;
};
{
  // Thrust at full dry power (95% throttle: just below afterburner light-up), engine spooled up.
  const dryThrust = (altitude: number, mach: number) => {
    const s = new Simulation(JET);
    const a = s.atmosphere.air(altitude).speedOfSound;
    if (altitude > 0) {
      s.craft.body.setTranslation({ x: 0, y: altitude, z: 0 }, true);
      s.craft.body.setLinvel({ x: 0, y: 0, z: -mach * a }, true);
    }
    const e = s.craft.engines[0];
    e.spool = 1;
    s.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0.95, brake: 0 });
    return { thrust: e.thrust, mach: e.mach, afterburner: e.afterburner };
  };
  const st = dryThrust(0, 0);
  const cr = dryThrust(10000, 0.8);
  const ratio = cr.thrust / st.thrust;
  console.log(`static ${(st.thrust / 1000).toFixed(1)} kN, M${cr.mach.toFixed(2)} at 10 km ${(cr.thrust / 1000).toFixed(1)} kN`);
  check('turbofan thrust at M0.8 / 10 km is 0.25-0.35 × static', ratio >= 0.25 && ratio <= 0.35, `${ratio.toFixed(3)} × static`);
  check('no afterburner at 95% throttle', st.afterburner === 0 && cr.afterburner === 0, `afterburner ${st.afterburner} static, ${cr.afterburner} at altitude`);

  // Afterburner: same start (1000 m, 150 m/s, level), same 12° pitch hold for 20 s.
  const climb = (throttle: number) => {
    const s = new Simulation(JET);
    s.craft.body.setTranslation({ x: 0, y: 1000, z: 0 }, true);
    s.craft.body.setLinvel({ x: 0, y: 0, z: -150 }, true);
    s.craft.engines[0].spool = 1;
    let prevPitch = NaN;
    const pilot = (tt: Telemetry, dt: number): ControlInputs => {
      const rate = Number.isNaN(prevPitch) ? 0 : (tt.pitch - prevPitch) / dt;
      prevPitch = tt.pitch;
      return {
        pitch: Math.max(-1, Math.min(1, (12 - tt.pitch) * 0.08 - rate * 0.03)),
        roll: Math.max(-1, Math.min(1, -tt.roll * 0.04)),
        yaw: 0,
        throttle,
        brake: 0,
      };
    };
    // Settle into the climb, then measure over the next 10 s.
    let t = run(s, 10, pilot, 0);
    const alt0 = t.altitude;
    const fuel0 = s.craft.fuel;
    t = run(s, 10, pilot, 0);
    return { climb: (t.altitude - alt0) / 10, speed: t.airspeed, fuel: (fuel0 - s.craft.fuel) / 10, ab: s.craft.engines[0].afterburner };
  };
  const dry = climb(0.95);
  const wet = climb(1);
  console.log(`dry:         climb ${dry.climb.toFixed(1)} m/s, end speed ${dry.speed.toFixed(0)} m/s, fuel ${dry.fuel.toFixed(2)} kg/s`);
  console.log(`afterburner: climb ${wet.climb.toFixed(1)} m/s, end speed ${wet.speed.toFixed(0)} m/s, fuel ${wet.fuel.toFixed(2)} kg/s`);
  check('afterburner raises the climb rate', wet.climb > dry.climb * 1.1 && wet.ab > 0.9, `${dry.climb.toFixed(1)} -> ${wet.climb.toFixed(1)} m/s`);
  check('afterburner burns much more fuel', wet.fuel > dry.fuel * 2, `${dry.fuel.toFixed(2)} -> ${wet.fuel.toFixed(2)} kg/s`);
}

// Every built-in vehicle must pass its own automated test card, in calm air and in a moderate
// breeze. The helicopter and blimp are no longer built-ins but stay as regression checks.
console.log('\n--- built-in vehicle test cards');
const { BUILTINS, HELICOPTER, BLIMP } = await import('../src/craft/builtins.ts');
const { flightTest } = await import('../src/sim/flightTest.ts');
const { calmWeather, WEATHER_PRESETS } = await import('../src/sim/atmosphere.ts');
const moderate = { ...calmWeather(), ...WEATHER_PRESETS.moderate.settings };
const cards = [
  ...BUILTINS.flatMap((b) => [
    { label: `${b.label} [calm]`, craft: b.craft, weather: calmWeather() },
    { label: `${b.label} [moderate]`, craft: b.craft, weather: moderate },
  ]),
  { label: 'Kestrel H-2 (helicopter, regression) [calm]', craft: HELICOPTER, weather: calmWeather() },
  { label: 'Skyship B-1 (blimp, regression) [calm]', craft: BLIMP, weather: calmWeather() },
];
for (const c of cards) {
  const r = await flightTest(c.craft, { weather: c.weather });
  console.log(`${r.passed ? 'PASS' : 'FAIL'} ${c.label}: ${r.score}/100 (${r.vehicle})${r.issues.length ? ` - ${r.issues[0]}` : ''}`);
  if (!r.passed) failed++;
}
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
