/**
 * Autopilot checks (headless, real sim): auto take-off and climb, heading and altitude hold,
 * knob adjustments from the stick, building avoidance in the Grid, rotorcraft hover hold.
 * Run with `npm run autopilot`.
 */
import { QUADCOPTER } from '../src/craft/builtins.ts';
import { JET } from '../src/craft/jet.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import type { ControlInputs, ControlSource } from '../src/sim/controls.ts';
import { FlightAutopilot } from '../src/sim/flightAutopilot.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import type { Telemetry } from '../src/sim/telemetry.ts';
import { obstacleTop, worldStructures } from '../src/world/structures.ts';

await initPhysics();
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const wrap = (a: number) => ((a + 540) % 360) - 180;

/** A scripted "human" whose stick we can move. */
class Human implements ControlSource {
  input: ControlInputs = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 };
  sample(): ControlInputs { return { ...this.input }; }
}
function fly(sim: Simulation, ap: FlightAutopilot, seconds: number, watch?: (t: Telemetry) => void): Telemetry {
  let t = sim.telemetry();
  for (let i = 0; i < seconds * 120; i++) {
    sim.step(ap.sample(sim.dt, t));
    t = sim.telemetry();
    watch?.(t);
  }
  return t;
}

// --- Trainer: engage on the runway → takes off, climbs to 300 m, holds runway heading.
{
  const sim = new Simulation(TEST_PLANE);
  const human = new Human();
  const ap = new FlightAutopilot(human);
  ap.engage(sim.telemetry(), 'airplane');
  let t = fly(sim, ap, 90);
  check(!t.onGround && Math.abs(t.altitude - 300) < 40, 'trainer: auto take-off and climb to 300 m', `${t.altitude.toFixed(0)} m, ${t.airspeed.toFixed(0)} m/s`);
  check(Math.abs(wrap(t.heading - ap.state.heading)) < 8, 'trainer: holds the runway heading', `${t.heading.toFixed(0)}° vs ${ap.state.heading.toFixed(0)}°`);
  // Roll right for 3.6 s = +90° on the heading knob.
  human.input.roll = 1;
  fly(sim, ap, 3.6);
  human.input.roll = 0;
  const want = ap.state.heading;
  t = fly(sim, ap, 45);
  check(Math.abs(wrap(t.heading - want)) < 10, 'trainer: stick roll dials a new heading and it turns to it', `selected ${want.toFixed(0)}°, flying ${t.heading.toFixed(0)}°`);
  // Pull back 5 s = +100 m on the altitude knob.
  human.input.pitch = 1;
  fly(sim, ap, 5);
  human.input.pitch = 0;
  const alt = ap.state.altitude;
  t = fly(sim, ap, 40);
  check(Math.abs(t.altitude - alt) < 30, 'trainer: stick pitch dials a new altitude', `selected ${alt.toFixed(0)} m, at ${t.altitude.toFixed(0)} m`);
  check(sim.failures.length === 0, 'trainer: no damage');
}

// --- Jet into the Grid at low level toward the tallest downtown: the autopilot climbs over.
{
  const sim = new Simulation(JET);
  const ws = worldStructures();
  const tallest = ws.groups.reduce((a, b) => (b.size[1] * b.blockSize > a.size[1] * a.blockSize ? b : a));
  const tx = tallest.x0 + (tallest.size[0] * tallest.blockSize) / 2;
  const tz = tallest.z0 + (tallest.size[2] * tallest.blockSize) / 2;
  // Start 3 km east of it at 150 m, flying west (heading 270) at 120 m/s.
  const body = sim.craft.body;
  const yaw = Math.PI / 2; // nose (-Z) turned to -X
  body.setTranslation({ x: tx + 3000, y: 150, z: tz }, true);
  body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  body.setLinvel({ x: -120, y: 0, z: 0 }, true);
  sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 });
  const human = new Human();
  human.input.throttle = 0.8;
  const ap = new FlightAutopilot(human);
  ap.engage(sim.telemetry(), 'airplane');
  ap.state.heading = 270;
  let minClear = Infinity;
  const t = fly(sim, ap, 45, (tt) => {
    const top = obstacleTop(tt.position[0], tt.position[2]);
    if (top > 0) minClear = Math.min(minClear, tt.position[1] - top);
    if (Math.round(tt.time * 120) % 600 === 0) console.log(`    t ${tt.time.toFixed(0)} x ${tt.position[0].toFixed(0)} alt ${tt.position[1].toFixed(0)} spd ${tt.airspeed.toFixed(0)} pitch ${tt.pitch.toFixed(0)} cmd ${ap.state.commanded.toFixed(0)}`);
  });
  console.log(`  jet: failures ${sim.failures.map((f) => f.partId + ':' + f.cause).join(',') || 'none'}, fractured ${sim.staticWorld.fractured.size}, alt ${t.altitude.toFixed(0)} m, speed ${t.airspeed.toFixed(0)} m/s, commanded ${ap.state.commanded.toFixed(0)} m`);
  check(sim.failures.length === 0 && sim.staticWorld.fractured.size === 0, 'jet: autopilot flies over the downtown towers without hitting anything', `min clearance ${minClear.toFixed(0)} m over buildings, now x ${t.position[0].toFixed(0)}`);
  check(t.position[0] < tx - 500, 'jet: it passed the tallest tower', `${(tx - t.position[0]).toFixed(0)} m beyond`);
}

// --- Quadcopter: hover hold at 30 m, then dial forward speed.
{
  const sim = new Simulation(QUADCOPTER);
  const human = new Human();
  const ap = new FlightAutopilot(human);
  ap.engage(sim.telemetry(), 'rotorcraft');
  let t = fly(sim, ap, 30);
  check(Math.abs(t.altitude - 30) < 5 && t.groundSpeed < 2, 'quad: lifts off and holds a 30 m hover', `${t.altitude.toFixed(1)} m, ${t.groundSpeed.toFixed(1)} m/s`);
  human.input.throttle = 0.25; // +10 m/s forward on the speed knob
  t = fly(sim, ap, 20);
  check(t.groundSpeed > 6, 'quad: throttle dials forward speed', `${t.groundSpeed.toFixed(1)} m/s at ${t.altitude.toFixed(0)} m`);
}

console.log(failures ? `\n${failures} autopilot check(s) failed` : '\nall autopilot checks passed');
process.exit(failures ? 1 : 0);
