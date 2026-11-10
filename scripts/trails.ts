/**
 * Trail checks (Rule 4): a light cycle's jetwall is solid and deadly, a light ribbon fades
 * behind it, switching off or derezzing removes the walls, aircraft leave contrails.
 * Run with `npm run trails`.
 */
import * as THREE from 'three';
import { LIGHT_CYCLE } from '../src/craft/lightCycle.ts';
import { LIGHT_CAR } from '../src/craft/lightCar.ts';
import { BLIMP, HELICOPTER, QUADCOPTER } from '../src/craft/builtins.ts';
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

  // Ride back across its own wall at speed: a vehicle never runs into its own jetwall.
  const pts = sim.trails.trails[0].points;
  const head = pts[Math.floor(pts.length / 2)];
  const b = sim.craft.body;
  // Across the wall, whichever way it runs (the cycle starts on a road, facing along it).
  const wx = pts.at(-1)!.x - pts[0].x, wz = pts.at(-1)!.z - pts[0].z, wl = Math.hypot(wx, wz);
  const px = -wz / wl, pz = wx / wl;
  const yaw = Math.atan2(-px, -pz); // forward (0, 0, -1) rotated onto (px, pz)
  b.setTranslation({ x: head.x - px * 25, y: 1, z: head.z - pz * 25 }, true);
  b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  b.setLinvel({ x: px * 40, y: 0, z: pz * 40 }, true);
  const solid = sim.trails.colliderCount;
  for (let i = 0; i < 240; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: 0 });
  const crossed = (sim.position.x - head.x) * px + (sim.position.z - head.z) * pz;
  check(!sim.exploded && sim.failures.length === 0 && crossed > 5, 'riding back across its own jetwall at 40 m/s is safe: it passes through', `exploded ${sim.exploded}, ${crossed.toFixed(0)} m past it, ${solid} solid segments`);
  // Its walls are still solid to everyone else (riders, debris, other players): a rider that
  // meets one derezzes (see npm run traffic). When the vehicle derezzes, its light goes too.
  sim.explode();
  check(sim.trails.colliderCount === 0, 'when the vehicle derezzes, its walls stop being solid at once');
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
  check(contrails.length === 2 && contrails.every((tr) => tr.points.length > 10), 'the trainer draws two wingtip light ribbons in flight', contrails.map((tr) => tr.points.length).join(', '));
  const reach = Math.max(...contrails.map((tr) => tr.points.at(-1)!.arc - tr.points[0].arc));
  check(reach < Math.max(90, t.airspeed * 2.5) + 6, 'they dissipate a short, speed-scaled way behind', `${reach.toFixed(0)} m at ${t.airspeed.toFixed(0)} m/s`);
  check(sim.trails.colliderCount === 0, 'airborne ribbons are light only, not solid');
}

// --- Every vehicle: the quadcopter, helicopter and blimp lay light ribbons too.
for (const def of [QUADCOPTER, HELICOPTER, BLIMP]) {
  const sim = new Simulation(def);
  const b = sim.craft.body;
  const t0 = b.translation();
  b.setTranslation({ x: t0.x, y: 80, z: t0.z }, true);
  b.setLinvel({ x: 0, y: 0, z: -15 }, true);
  for (let i = 0; i < 120 * 3; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0.5, brake: 0 });
  const r = sim.trails.trails.filter((tr) => tr.points.length > 3);
  check(r.length >= 2, `${def.name} lays light ribbons`, `${sim.trails.trails.length} trails, points ${sim.trails.trails.map((tr) => tr.points.length).join(', ')}`);
  sim.trails.cycleMode(sim.craft, false, sim.time); // wall -> ribbon (no change for aircraft)
  sim.trails.cycleMode(sim.craft, false, sim.time); // ribbon -> off: derez
  check(sim.trails.trails.every((tr) => tr.derezAt !== null), `${def.name}: L switches its ribbons off`);
}

// ---------------------------------------------------------------- reverse
{
  const sim = new Simulation(LIGHT_CAR);
  for (let i = 0; i < 240; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(sim.rotation);
  const p0 = sim.position.clone();
  for (let i = 0; i < 360; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, reverse: 1 });
  const moved = sim.position.clone().sub(p0).dot(fwd);
  check(moved < -5 && !sim.exploded, 'a ground vehicle reverses', `${moved.toFixed(1)} m along its nose in 3 s`);
}

console.log(failures ? `\n${failures} trail check(s) failed` : '\nall trail checks passed');
process.exit(failures ? 1 : 0);
