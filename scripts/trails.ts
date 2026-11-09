/**
 * Trail checks (Rule 4): a light cycle's jetwall is solid and deadly, a light ribbon fades
 * behind it, switching off or derezzing removes the walls, aircraft leave contrails.
 * Run with `npm run trails`.
 */
import { LIGHT_CYCLE } from '../src/craft/lightCycle.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { Autopilot } from '../src/sim/autopilot.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { DEREZ_TIME, RIBBON_LENGTH } from '../src/sim/trails.ts';
import { GroundPilot } from '../src/sim/vehicleTests.ts';

await initPhysics();
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const drive = (sim: Simulation, pilot: GroundPilot, seconds: number) => {
  let t = sim.telemetry();
  for (let i = 0; i < seconds * 120; i++) { sim.step(pilot.sample(sim.dt, t)); t = sim.telemetry(); }
  return t;
};
const wallLength = (sim: Simulation) => sim.trails.trails.filter((t) => t.kind === 'wall' && t.derezAt === null)
  .reduce((a, t) => a + (t.points.length ? t.points.at(-1)!.arc - t.points[0].arc : 0), 0);

// --- Jetwall: solid light behind the cycle.
{
  const sim = new Simulation(LIGHT_CYCLE);
  const pilot = new GroundPilot(sim.telemetry().heading, 30);
  drive(sim, pilot, 10);
  check(wallLength(sim) > 200 && sim.trails.colliderCount > 100, 'a jetwall stands behind the cycle', `${wallLength(sim).toFixed(0)} m, ${sim.trails.colliderCount} solid segments`);
  check(!sim.exploded && sim.failures.length === 0, 'the cycle never hits its own fresh wall');

  // Ride back across the wall at speed: derez.
  const head = sim.trails.trails[0].points[Math.floor(sim.trails.trails[0].points.length / 2)];
  const b = sim.craft.body;
  const yaw = -Math.PI / 2; // face +X, across the wall (which runs along Z)
  b.setTranslation({ x: head.x - 25, y: 1, z: head.z }, true);
  b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  b.setLinvel({ x: 40, y: 0, z: 0 }, true);
  for (let i = 0; i < 240; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: 0 });
  check(sim.exploded, 'riding into a jetwall at 40 m/s derezzes the cycle', `exploded ${sim.exploded}, failures ${sim.failures.length}`);
  check(sim.trails.colliderCount === 0, 'its walls stop being solid at once');
  for (let i = 0; i < (DEREZ_TIME + 0.2) * 120; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  check(sim.trails.trails.filter((t) => t.kind === 'wall' && t.derezAt !== null).length === 0, 'and the light derezzes within a second');
}

// --- Light ribbon: fades a short distance behind, never blocks the way permanently.
{
  const sim = new Simulation(LIGHT_CYCLE);
  sim.trails.cycleMode(sim.craft, false, sim.time); // wall -> ribbon
  const pilot = new GroundPilot(sim.telemetry().heading, 30);
  drive(sim, pilot, 12);
  const len = wallLength(sim);
  check(sim.trails.mode === 'ribbon' && len <= RIBBON_LENGTH + 3 && len > RIBBON_LENGTH * 0.7, 'a light ribbon only reaches a short way behind', `${len.toFixed(0)} m (limit ${RIBBON_LENGTH} m), ${sim.trails.colliderCount} solid segments`);
  sim.trails.cycleMode(sim.craft, false, sim.time); // ribbon -> off
  check(sim.trails.colliderCount === 0, 'switching the trail off derezzes it');
  drive(sim, pilot, 3);
  check(wallLength(sim) === 0, 'off: no new light');
}

// --- Aircraft contrails: visual energy paths, never solid.
{
  const sim = new Simulation(TEST_PLANE);
  const ap = new Autopilot({ heading: 0, altitude: 150, airspeed: 50 });
  let t = sim.telemetry();
  for (let i = 0; i < 120 * 60; i++) { sim.step(ap.sample(sim.dt, t)); t = sim.telemetry(); }
  const contrails = sim.trails.trails.filter((tr) => tr.kind === 'contrail');
  check(contrails.length === 2 && contrails.every((tr) => tr.points.length > 10), 'the trainer draws two wingtip contrails in flight', contrails.map((tr) => tr.points.length).join(', '));
  check(sim.trails.colliderCount === 0, 'contrails are not solid');
}

console.log(failures ? `\n${failures} trail check(s) failed` : '\nall trail checks passed');
process.exit(failures ? 1 : 0);
