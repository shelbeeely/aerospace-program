/**
 * Road network and ground autopilot checks (headless, real simulation): every road on one
 * network, every flight-computer destination reachable by road, ground vehicles spawning on a
 * road (never an airstrip), and the flight computer driving ground vehicles to destinations.
 * Run with `npm run drive`.
 */
import * as THREE from 'three';
import { LIGHT_CAR } from '../src/craft/lightCar.ts';
import { LIGHT_CYCLE } from '../src/craft/lightCycle.ts';
import { LIGHT_RUNNER } from '../src/craft/outlands.ts';
import type { CraftDef } from '../src/craft/types.ts';
import type { ControlInputs, ControlSource } from '../src/sim/controls.ts';
import { FlightAutopilot } from '../src/sim/flightAutopilot.ts';
import { distance, destinations } from '../src/sim/nav.ts';
import { RUNWAYS, runwayFrame } from '../src/sim/layout.ts';
import { findRoute, roadOpen } from '../src/sim/roads.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { wallSegmentsNear } from '../src/sim/lightWalls.ts';
import { blockSummary, roadStats } from '../src/world/planetCity.ts';

await initPhysics();
let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}

// --- One network
blockSummary();
check(!!roadStats && roadStats.removed <= roadStats.components * 0.05, 'road islands are linked into one network', JSON.stringify(roadStats));
{
  // Flood from the network's biggest component: every road segment must be reached.
  const N = 370;
  const seen = new Uint8Array(N * N);
  const mod = (v: number) => ((v % N) + N) % N;
  let start = -1;
  for (let k = 0; k < N * N && start < 0; k++) if (roadOpen(true, Math.floor(k / N), k % N)) start = k;
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const c = stack.pop()!;
    const i = Math.floor(c / N), j = c % N;
    for (const [di, dj, ax, si, sj] of [[1, 0, true, i, j], [-1, 0, true, i - 1, j], [0, 1, false, i, j], [0, -1, false, i, j - 1]] as const) {
      if (!roadOpen(ax, si, sj)) continue;
      const nk = mod(i + di) * N + mod(j + dj);
      if (!seen[nk]) { seen[nk] = 1; stack.push(nk); }
    }
  }
  let orphan = 0, total = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (const ax of [true, false]) {
    if (!roadOpen(ax, i, j)) continue;
    total++;
    if (!seen[i * N + j]) orphan++;
  }
  check(orphan === 0, 'every road segment is on the one network', `${total} segments, ${orphan} orphaned`);
}

// --- Every destination by road
{
  const from = { x: 253, z: 206 };
  const t0 = performance.now();
  const bad = destinations().filter((d) => !findRoute(from.x, from.z, d.x, d.z)).map((d) => d.name);
  check(bad.length === 0, 'every flight-computer destination is reachable by road', bad.length ? bad.join(', ') : `${destinations().length} destinations, ${((performance.now() - t0) / destinations().length).toFixed(0)} ms per route`);
}

// --- Ground vehicles start on a road, not an airstrip
for (const def of [LIGHT_CAR, LIGHT_CYCLE, LIGHT_RUNNER] as CraftDef[]) {
  const sim = new Simulation(def);
  const p = sim.position;
  const onStrip = RUNWAYS.some((r) => { const a = runwayFrame(r, p.x, p.z); return Math.abs(a.across) < r.width / 2 + 20 && Math.abs(a.along) < r.length / 2 + 60; });
  check(!onStrip, `${def.name} spawns off the airstrips`, `${p.x.toFixed(0)}, ${p.z.toFixed(0)}`);
}

// --- The flight computer drives to destinations
class Idle implements ControlSource {
  throttle = 0;
  sample(): ControlInputs { return { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 }; }
}
function drive(def: CraftDef, destId: string, limit: number): { arrived: boolean; dist: number; time: number; route: number; maxOff: number } {
  const sim = new Simulation(def);
  sim.traffic.enabled = false;
  for (let i = 0; i < 120; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  const ap = new FlightAutopilot(new Idle());
  let t = sim.telemetry();
  ap.engage(t, 'ground', undefined, { mode: 'goto', destination: destId, speed: 22 });
  const route = ap.driver.length;
  const d = destinations().find((x) => x.id === destId)!;
  let maxOff = 0;
  for (let i = 0; i < limit * 120 && ap.state.phase !== 'arrived'; i++) {
    sim.step(ap.sample(sim.dt, t));
    t = sim.telemetry();
    if (i % 60 === 0) { const st = ap.driver.drive(0, t, 22).status; maxOff = Math.max(maxOff, st.offPath); }
    if (!ap.state.engaged) break;
  }
  return { arrived: ap.state.phase === 'arrived', dist: distance(t.position[0], t.position[2], d.x, d.z), time: t.time, route, maxOff };
}
for (const [def, dest] of [[LIGHT_CAR, 'pad-apron'], [LIGHT_CAR, 'spire'], [LIGHT_CYCLE, 'pad-town']] as Array<[CraftDef, string]>) {
  const r = drive(def, dest, 900);
  check(r.arrived && r.dist < 450, `the flight computer drives the ${def.name} to ${dest}`, `${(r.route / 1000).toFixed(1)} km route, arrived ${r.arrived} in ${r.time.toFixed(0)} s, ${r.dist.toFixed(0)} m from the site, max ${r.maxOff.toFixed(1)} m off path`);
}

// --- Light walls: the driver stops short of a jetwall across its road, then finds another way.
{
  const sim = new Simulation(LIGHT_CAR);
  sim.traffic.enabled = false;
  for (let i = 0; i < 120; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  const ap = new FlightAutopilot(new Idle());
  ap.driver.walls = (x, z, r) => wallSegmentsNear(sim, x, z, r, extra);
  let t = sim.telemetry();
  ap.engage(t, 'ground', undefined, { mode: 'goto', destination: 'spire', speed: 22 });
  // A wall laid across the route ~250 m ahead (as another program's jetwall would be).
  const path = ap.driver.path;
  let acc = 0, k = 1;
  for (; k < path.length && acc < 250; k++) acc += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
  const [ax, az] = path[k - 1], [bx, bz] = path[k];
  const L = Math.hypot(bx - ax, bz - az), nx = -(bz - az) / L, nz = (bx - ax) / L;
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  const extra = [{ points: [-30, 30].map((o) => ({ x: mx + nx * o, z: mz + nz * o, y0: 0, y1: 1.6, time: 0, arc: 0 })) }];
  let minD = Infinity, rerouted = false;
  const first = ap.driver.length;
  for (let i = 0; i < 120 * 120 && ap.state.phase !== 'arrived'; i++) {
    sim.step(ap.sample(sim.dt, t));
    t = sim.telemetry();
    const d = Math.abs((t.position[0] - mx) * (bx - ax) / L + (t.position[2] - mz) * (bz - az) / L);
    const lat = Math.abs((t.position[0] - mx) * nx + (t.position[2] - mz) * nz);
    if (lat < 30) minD = Math.min(minD, d);
    if (Math.abs(ap.driver.length - first) > 1) rerouted = true;
    if (rerouted && i > 120 * 60) break;
  }
  check(!sim.exploded && sim.failures.length === 0 && minD > 3, 'the driver never runs into a light wall across its road', `closest ${minD.toFixed(1)} m, intact ${!sim.exploded}`);
  check(rerouted, 'blocked by the wall, it re-routes around it', `route ${(first / 1000).toFixed(2)} km → ${(ap.driver.length / 1000).toFixed(2)} km`);
}

// --- Broken road: a crater closes the stretch it is on; routes avoid it and the driver goes round.
{
  const sim = new Simulation(LIGHT_CAR);
  sim.traffic.enabled = false;
  sim.bits.enabled = false;
  for (let i = 0; i < 120; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  const ap = new FlightAutopilot(new Idle());
  ap.driver.walls = (x, z, r) => wallSegmentsNear(sim, x, z, r);
  ap.driver.closed = sim.roadDamage.closed;
  let t = sim.telemetry();
  ap.engage(t, 'ground', undefined, { mode: 'goto', destination: 'spire', speed: 22 });
  // The middle of a straight stretch of the route ~300 m ahead.
  const path = ap.driver.path;
  let acc = 0, k = 1;
  for (; k < path.length && (acc < 300 || Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]) < 60); k++) acc += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
  const mx = (path[k - 1][0] + path[k][0]) / 2, mz = (path[k - 1][1] + path[k][1]) / 2;
  check(sim.roadDamage.closures.length === 0, 'a whole world has no closed roads');
  sim.crater(mx, 0, mz, 4, '#fff'); // a small one only scars the surface
  check(sim.roadDamage.closures.length === 0 && sim.craters.length === 1, 'a small crater scars the road without closing it');
  sim.crater(mx, 0, mz, 24, '#fff');
  const c = sim.roadDamage.closures[0];
  check(!!c && sim.roadDamage.closed(c.alongX, c.i, c.j) && c.barriers.length === 2 && c.slabs.length >= 8, 'a big crater on a road closes that stretch', c ? `${c.slabs.length} slabs, radius ${c.radius.toFixed(1)} m` : 'no closure');
  const first = ap.driver.length;
  const fresh = findRoute(sim.position.x, sim.position.z, destinations().find((d) => d.id === 'spire')!.x, destinations().find((d) => d.id === 'spire')!.z, 400000, sim.roadDamage.closed);
  const uses = (r: NonNullable<typeof fresh>) => r.points.some((p, n) => n > 0 && Math.abs((p.x + r.points[n - 1].x) / 2 - mx) < 40 && Math.abs((p.z + r.points[n - 1].z) / 2 - mz) < 40 && Math.hypot(p.x - r.points[n - 1].x, p.z - r.points[n - 1].z) < 200);
  check(!!fresh && !uses(fresh), 'a route planned now goes another way', fresh ? `${(fresh.length / 1000).toFixed(2)} km (was ${(first / 1000).toFixed(2)} km)` : 'no route');
  let minD = Infinity, rerouted = false;
  for (let i = 0; i < 120 * 150 && ap.state.phase !== 'arrived'; i++) {
    sim.step(ap.sample(sim.dt, t));
    t = sim.telemetry();
    minD = Math.min(minD, Math.hypot(t.position[0] - mx, t.position[2] - mz));
    if (Math.abs(ap.driver.length - first) > 1) rerouted = true;
    if (rerouted && i > 120 * 90) break;
  }
  check(!sim.exploded && sim.failures.length === 0 && minD > c.radius, 'the flight computer never drives into the broken road', `closest ${minD.toFixed(1)} m from its centre`);
  check(rerouted, 'it goes round by another road', `route ${(first / 1000).toFixed(2)} km → ${(ap.driver.length / 1000).toFixed(2)} km`);
  // Driven straight at it by hand, the slabs are solid.
  const car = new Simulation(LIGHT_CAR);
  car.traffic.enabled = false;
  car.bits.enabled = false;
  for (let i = 0; i < 120; i++) car.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  // Straight down the road it stands on: snap its facing to the road's axis.
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(car.rotation);
  const fwd = Math.abs(f.x) > Math.abs(f.z) ? { x: Math.sign(f.x), z: 0 } : { x: 0, z: Math.sign(f.z) };
  let ahead = { x: 0, z: 0 };
  for (const dist of [70, -70, 55, -55]) {
    ahead = { x: car.position.x + fwd.x * dist, z: car.position.z + fwd.z * dist };
    car.crater(ahead.x, 0, ahead.z, 24, '#fff');
    if (!car.roadDamage.closures.length) continue;
    if (dist < 0) {
      // The road only runs the other way from here: turn the car round to face it.
      fwd.x = -fwd.x; fwd.z = -fwd.z;
      const yaw = Math.atan2(-fwd.x, -fwd.z);
      car.craft.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
      for (let i = 0; i < 60; i++) car.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
    }
    break;
  }
  const field = car.roadDamage.closures[0];
  if (!field) throw new Error(`no road to break ahead of the car at ${car.position.x.toFixed(0)}, ${car.position.z.toFixed(0)} facing ${fwd.x},${fwd.z}`);
  const start = { x: car.position.x, z: car.position.z };
  const need = Math.hypot(ahead.x - start.x, ahead.z - start.z);
  let far = 0;
  for (let i = 0; i < 120 * 14; i++) {
    car.step({ pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: 0 });
    far = Math.max(far, (car.position.x - ahead.x) * fwd.x + (car.position.z - ahead.z) * fwd.z);
  }
  check(far < field.radius, 'a vehicle driven straight at the slabs does not come out the other side', `got ${(far + need).toFixed(0)} m of the ${(need + field.radius).toFixed(0)} m needed`);
  car.resetToRunway();
  check(car.roadDamage.closures.length === 0 && !car.roadDamage.closed(field.alongX, field.i, field.j) && car.traffic.barriers.length === 0, 'a world reset reopens every road');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll road checks passed');
process.exit(failures ? 1 : 0);
