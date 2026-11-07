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

// Every built-in vehicle must still pass its own automated test card.
console.log('\n--- built-in vehicle test cards');
const { BUILTINS } = await import('../src/craft/builtins.ts');
const { flightTest } = await import('../src/sim/flightTest.ts');
let failed = 0;
for (const b of BUILTINS) {
  const r = await flightTest(b.craft);
  console.log(`${r.passed ? 'PASS' : 'FAIL'} ${b.label}: ${r.score}/100 (${r.vehicle})${r.issues.length ? ` - ${r.issues[0]}` : ''}`);
  if (!r.passed) failed++;
}
if (failed) {
  console.error(`${failed} built-in craft failed their test card`);
  process.exit(1);
}
