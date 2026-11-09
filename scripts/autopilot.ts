/**
 * Autopilot checks (headless, real sim): auto take-off and climb, heading and altitude hold,
 * knob adjustments from the stick, building avoidance in the Grid, rotorcraft hover hold, and
 * the flight computer: autoland (trainer, twin, jet), landing at another field, Go to + Orbit,
 * Level, and a quadcopter landing on a rooftop pad.
 * Run with `npm run autopilot`.
 */
import * as THREE from 'three';
import { QUADCOPTER } from '../src/craft/builtins.ts';
import { JET } from '../src/craft/jet.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { TWIN_PLANE } from '../src/craft/twinPlane.ts';
import type { CraftDef } from '../src/craft/types.ts';
import { Autopilot } from '../src/sim/autopilot.ts';
import type { ControlInputs, ControlSource } from '../src/sim/controls.ts';
import { FlightAutopilot } from '../src/sim/flightAutopilot.ts';
import { analyzeDesign } from '../src/sim/flightTest.ts';
import { approachFrame, destination, distance, siteElevation } from '../src/sim/nav.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import type { Telemetry } from '../src/sim/telemetry.ts';
import { landingSites } from '../src/world/landingSites.ts';
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
function fly(sim: Simulation, ap: FlightAutopilot, seconds: number, watch?: (t: Telemetry) => void, until?: (t: Telemetry) => boolean): Telemetry {
  let t = sim.telemetry();
  for (let i = 0; i < seconds * 120; i++) {
    sim.step(ap.sample(sim.dt, t));
    t = sim.telemetry();
    watch?.(t);
    if (until?.(t)) break;
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

// ---------------------------------------------------------------- flight computer

/** Put a craft in the air at (x, y, z) on a compass heading at a speed, wings level. */
function launch(sim: Simulation, x: number, y: number, z: number, heading: number, speed: number, throttle = 0.6): void {
  const body = sim.craft.body;
  const yaw = (-heading * Math.PI) / 180; // heading 0 = -Z; positive heading turns the nose to +X
  body.setTranslation({ x, y, z }, true);
  body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  const h = (heading * Math.PI) / 180;
  body.setLinvel({ x: Math.sin(h) * speed, y: 0, z: -Math.cos(h) * speed }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  sim.step({ pitch: 0, roll: 0, yaw: 0, throttle, brake: 0 });
}

/** The airplane test card up to the end of the turn (rest, take-off, climb to 140 m, turn to 090, 20 s). */
function postTurn(sim: Simulation, stall: number): Telemetry {
  let t = sim.telemetry();
  const run = (s: number, f: (t: Telemetry) => ControlInputs, until?: (t: Telemetry) => boolean) => {
    for (let i = 0; i < s * 120; i++) {
      sim.step(f(t));
      t = sim.telemetry();
      if (until?.(t)) break;
    }
  };
  run(3, () => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 }));
  const ap = new Autopilot({ heading: 0, altitude: 150, airspeed: THREE.MathUtils.clamp(stall * 1.6, 25, 120) });
  ap.rotateSpeed = THREE.MathUtils.clamp(stall * 1.15, 12, 90);
  run(130, (tt) => ap.sample(sim.dt, tt), (tt) => tt.altitude >= 140);
  ap.targets.heading = 90;
  run(55, (tt) => ap.sample(sim.dt, tt));
  return t;
}

/** Fly the flight computer in Land mode until it has stopped; report the touchdown and stop. */
function autoland(sim: Simulation, ap: FlightAutopilot, seconds: number) {
  let prev = sim.telemetry();
  let td: { sink: number; along: number; cross: number; speed: number } | null = null;
  let maxCross = 0;
  const t = fly(sim, ap, seconds, (tt) => {
    const f = approachFrame(ap.landingApproach!, tt.position[0], tt.position[2]);
    if (!td && tt.onGround) td = { sink: -Math.min(prev.verticalSpeed, tt.verticalSpeed), along: f.along, cross: f.cross, speed: prev.airspeed };
    if (td) maxCross = Math.max(maxCross, Math.abs(f.cross));
    prev = tt;
  }, () => ap.state.phase === 'landed');
  const end = approachFrame(ap.landingApproach!, t.position[0], t.position[2]);
  return { t, td: td as { sink: number; along: number; cross: number; speed: number } | null, end, maxCross };
}

function checkLanding(label: string, sim: Simulation, ap: FlightAutopilot, r: ReturnType<typeof autoland>): void {
  const site = ap.landingApproach!.site;
  const td = r.td;
  const detail = td
    ? `touchdown ${td.along.toFixed(0)} m in, ${td.cross.toFixed(1)} m off centre, ${td.speed.toFixed(1)} m/s, sink ${td.sink.toFixed(2)} m/s; stopped at ${r.end.along.toFixed(0)} of ${site.length} m (${ap.state.status})`
    : `no touchdown (${ap.state.status})`;
  const ok = !!td && td.along > 0 && td.sink < 3 && ap.state.phase === 'landed' && r.end.along < site.length && r.maxCross < site.width / 2 && sim.failures.length === 0 && !sim.airframeTouchingGround();
  check(ok, label, detail);
}

// --- Autoland from the test card's post-turn position: trainer, twin and jet.
for (const [name, craft] of [['trainer', TEST_PLANE], ['twin', TWIN_PLANE], ['jet', JET]] as Array<[string, CraftDef]>) {
  const sim = new Simulation(craft);
  const stall = analyzeDesign(sim).stallSpeed;
  const t = postTurn(sim, stall);
  const ap = new FlightAutopilot(new Human());
  ap.engage(t, 'airplane', { stallSpeed: stall }, { mode: 'land', destination: 'grid' });
  checkLanding(`${name}: autoland at Grid International from the post-turn position`, sim, ap, autoland(sim, ap, 420));
}

// --- Trainer lands at North Field (nearest long-enough runway picked by name).
{
  const sim = new Simulation(TEST_PLANE);
  const stall = analyzeDesign(sim).stallSpeed;
  launch(sim, 0, 250, -1600, 270, 42);
  const ap = new FlightAutopilot(new Human());
  ap.engage(sim.telemetry(), 'airplane', { stallSpeed: stall }, { mode: 'land', destination: 'north' });
  checkLanding('trainer: lands at North Field', sim, ap, autoland(sim, ap, 480));
}

// --- Go to a hub, then Orbit it without hitting anything.
{
  const sim = new Simulation(TEST_PLANE);
  const stall = analyzeDesign(sim).stallSpeed;
  const hub = destination('hub-2')!;
  launch(sim, 0, 300, -800, 180, 45);
  const ap = new FlightAutopilot(new Human());
  ap.engage(sim.telemetry(), 'airplane', { stallSpeed: stall }, { mode: 'goto', destination: hub.id, altitude: 300, speed: 45, orbitRadius: 600 });
  let minClear = Infinity;
  let reachedOrbitAt = -1;
  const watch = (tt: Telemetry) => {
    minClear = Math.min(minClear, tt.position[1] - obstacleTop(tt.position[0], tt.position[2]));
    if (reachedOrbitAt < 0 && ap.state.mode === 'orbit') reachedOrbitAt = tt.time;
  };
  fly(sim, ap, 240, watch, () => ap.state.mode === 'orbit');
  let worstRadius = 0;
  const t = fly(sim, ap, 90, (tt) => {
    watch(tt);
    if (tt.time - reachedOrbitAt > 30) worstRadius = Math.max(worstRadius, Math.abs(distance(tt.position[0], tt.position[2], hub.x, hub.z) - 600));
  });
  check(reachedOrbitAt > 0, `trainer: Go to ${hub.name} switches to Orbit on arrival`, `at t=${reachedOrbitAt.toFixed(0)} s (${ap.state.status})`);
  check(worstRadius < 150, 'trainer: orbits at the selected radius', `worst radius error ${worstRadius.toFixed(0)} m`);
  check(sim.failures.length === 0 && sim.staticWorld.fractured.size === 0 && minClear > 30, 'trainer: Go to + Orbit hits nothing', `min clearance ${minClear.toFixed(0)} m, now ${t.altitude.toFixed(0)} m`);
}

// --- Level: from a 30° bank, wings level and the altitude held.
{
  const sim = new Simulation(TEST_PLANE);
  const stall = analyzeDesign(sim).stallSpeed;
  launch(sim, 0, 300, -1500, 90, 42);
  const human = new Human();
  human.input.throttle = 0.6;
  const roll = new Autopilot({ heading: 90, altitude: 300, airspeed: 42 });
  let t = sim.telemetry();
  for (let i = 0; i < 6 * 120; i++) {
    sim.step(roll.fly(sim.dt, t, { vs: 0, roll: 30, throttle: 0.6 }));
    t = sim.telemetry();
  }
  const bank0 = t.roll;
  const alt0 = t.altitude;
  const ap = new FlightAutopilot(human);
  ap.engage(t, 'airplane', { stallSpeed: stall }, { mode: 'level' });
  let worstAlt = 0;
  t = fly(sim, ap, 25, (tt) => {
    if (tt.time - t.time > 8) worstAlt = Math.max(worstAlt, Math.abs(tt.altitude - alt0));
  });
  check(Math.abs(t.roll) < 3 && worstAlt < 25 && Math.abs(t.verticalSpeed) < 1, 'trainer: Level rolls wings level and holds altitude', `bank ${bank0.toFixed(0)}° → ${t.roll.toFixed(1)}°, altitude change up to ${worstAlt.toFixed(0)} m, V/S ${t.verticalSpeed.toFixed(1)}`);
}

// --- Quadcopter: Go to a rooftop pad, then Land on it.
{
  const sim = new Simulation(QUADCOPTER);
  const start = sim.telemetry();
  const roof = landingSites()
    .filter((s) => s.kind === 'helipad' && s.y > 0)
    .sort((a, b) => distance(start.position[0], start.position[2], a.x, a.z) - distance(start.position[0], start.position[2], b.x, b.z))[0];
  const ap = new FlightAutopilot(new Human());
  ap.engage(start, 'rotorcraft', undefined, { mode: 'goto', destination: roof.id, altitude: 60, speed: 20 });
  let t = fly(sim, ap, 400, undefined, () => ap.state.phase === 'hold');
  const over = distance(t.position[0], t.position[2], roof.x, roof.z);
  check(over < 25, `quad: Go to ${roof.name}`, `${over.toFixed(1)} m from the pad at ${t.altitude.toFixed(0)} m (roof ${roof.y.toFixed(0)} m)`);
  ap.engage(t, 'rotorcraft', undefined, { mode: 'land', destination: roof.id });
  let prev = t;
  let touchSpeed = -1;
  t = fly(sim, ap, 180, (tt) => {
    if (touchSpeed < 0 && ap.state.phase === 'landed') touchSpeed = Math.hypot(prev.velocity[0], prev.velocity[1], prev.velocity[2]);
    prev = tt;
  }, () => ap.state.phase === 'landed');
  t = fly(sim, ap, 3);
  const onRoof = Math.abs(t.altitude - (siteElevation(roof) - 0)) < 1.5 && distance(t.position[0], t.position[2], roof.x, roof.z) < roof.width;
  check(ap.state.phase === 'landed' && onRoof && touchSpeed >= 0 && touchSpeed < 2 && sim.failures.length === 0,
    `quad: lands on ${roof.name}`, `height ${t.altitude.toFixed(1)} m (roof ${roof.y.toFixed(1)} m), ${distance(t.position[0], t.position[2], roof.x, roof.z).toFixed(1)} m from centre, touchdown ${touchSpeed.toFixed(2)} m/s, throttle ${t.throttle.toFixed(2)}`);
}

console.log(failures ? `\n${failures} autopilot check(s) failed` : '\nall autopilot checks passed');
process.exit(failures ? 1 : 0);
