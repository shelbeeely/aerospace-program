/**
 * AI light-cycle traffic checks: riders keep to street lanes, follow the grid (turning only at
 * intersections), stay off airfields, sea and the Outlands, derez riding into the player's
 * jetwall (or when the player hits them), steer clear of it when they can, stay bounded while
 * the player moves around the planet, and are deterministic for a given seed.
 * Run with `npm run traffic`.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { LIGHT_CYCLE } from '../src/craft/lightCycle.ts';
import { CITY, PLANET } from '../src/sim/layout.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { blockKind, exitOpen, HX, isHighwayLine, HZ, lineX, lineZ, TRAFFIC, TrafficSystem, type Heading, type Rider } from '../src/sim/traffic.ts';
import { DEREZ_TIME } from '../src/sim/trails.ts';
import { GRID } from '../src/world/planetCity.ts';
import { GroundPilot } from '../src/sim/vehicleTests.ts';

await initPhysics();
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const C = PLANET.circumference;
const P = GRID.pitch;
const DT = 1 / 120;
const nearestLine = (v: number, o: number) => Math.round((v - o) / P);
const roadKind = (k: number) => k === 0 || k === 128;

// --- Riding the grid: lanes, turns at intersections, streets only.
{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const traffic = new TrafficSystem(world);
  const player = { x: -2100, y: 120, z: 900 };
  let offLane = 0, badTurns = 0, offRoad = 0, turns = 0, samples = 0, worst = '';
  const last = new Map<Rider, Heading>();
  for (let s = 0; s < 120 * 40; s++) {
    traffic.step(DT, s * DT, player, null);
    for (const r of traffic.riders) {
      if (r.derezAt !== null) continue;
      const prev = last.get(r);
      last.set(r, r.heading);
      // Heading changes only inside an intersection box (lane offsets from both lines).
      if (prev !== undefined && prev !== r.heading) {
        turns++;
        // Where it turned: the jetwall's newest corner (it may ride on a little in the same step).
        const c = r.trail[r.trail.length - 1];
        const dx = Math.abs(c.x - lineX(nearestLine(c.x, GRID.x0)));
        const dz = Math.abs(c.z - lineZ(nearestLine(c.z, GRID.z0)));
        if (dx > TRAFFIC.lanes[1] + 0.01 || dz > TRAFFIC.lanes[1] + 0.01) { badTurns++; worst ||= `turn at ${dx.toFixed(1)}, ${dz.toFixed(1)} m from the lines`; }
      }
      if (r.uturn > 0) continue;
      samples++;
      const ax = r.heading === 0 || r.heading === 2;
      // In a lane: the right offset from the centreline of its line.
      const perp = ax ? r.z - lineZ(r.line) : r.x - lineX(r.line);
      const want = (ax ? HX[r.heading] : -HZ[r.heading]) * r.lane;
      if (Math.abs(perp - want) > 1e-6 || !TRAFFIC.lanes.includes(r.lane as 3.25)) { offLane++; worst ||= `lane offset ${perp.toFixed(2)} (want ${want})`; }
      // On a street: both blocks either side have streets (unless inside an intersection).
      const u = ((ax ? r.x - GRID.x0 : r.z - GRID.z0) / P);
      const inNode = Math.abs(u - Math.round(u)) * P < CITY.street / 2;
      if (!inNode) {
        const b = Math.floor(u);
        const ok = ax ? roadKind(blockKind(b, r.line - 1)) && roadKind(blockKind(b, r.line)) : roadKind(blockKind(r.line - 1, b)) && roadKind(blockKind(r.line, b));
        if (!ok) { offRoad++; worst ||= `off-road at ${r.x.toFixed(0)}, ${r.z.toFixed(0)}`; }
      }
    }
  }
  check(traffic.active > 250, 'the streamed disc fills with riders', `${traffic.active} riding`);
  check(offLane === 0, 'riders keep to their lane centres', `${samples} samples, ${offLane} off${worst ? ` (${worst})` : ''}`);
  check(turns > 50 && badTurns === 0, 'riders turn only at intersections', `${turns} turns, ${badTurns} elsewhere`);
  check(offRoad === 0, 'riders stay off airfields, sea and the Outlands', `${offRoad} off-road samples`);
  const highway = traffic.riders.filter((r) => isHighwayLine(r.line)).length;
  check(highway > traffic.riders.length * 0.4, 'the data highways carry most of the traffic', `${highway} of ${traffic.riders.length} on highways (1 line in 6)`);
  const trailLen = Math.max(...traffic.riders.map((r) => {
    const pts = [...r.trail, traffic.tail(r)];
    let L = 0;
    for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
    return L;
  }));
  check(trailLen <= TRAFFIC.trailLength + 0.01 && trailLen > TRAFFIC.trailLength * 0.9, 'each rider carries a short jetwall', `longest ${trailLen.toFixed(1)} m (limit ${TRAFFIC.trailLength} m)`);
  const bodies = traffic.riders.filter((r) => r.body);
  const far = bodies.filter((r) => Math.hypot(r.x - player.x, r.z - player.z, player.y - 2) > TRAFFIC.colliderRange + 1);
  check(bodies.length > 0 && far.length === 0, 'only riders near the player get colliders', `${bodies.length} with bodies, ${traffic.colliderCount} colliders, ${far.length} too far`);
}

// --- Streaming: bounded while the player crosses the planet (and a wrap edge), wrap-aware.
{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const traffic = new TrafficSystem(world);
  const player = { x: -2000, y: 300, z: 0 };
  let most = 0, farthest = 0, cost = 0;
  for (let s = 0; s < 120 * 150; s++) {
    player.x += 300 * DT;
    player.z -= 120 * DT;
    if (player.x > C / 2) player.x -= C;
    if (player.z < -C / 2) player.z += C;
    const t0 = performance.now();
    traffic.step(DT, s * DT, player, null);
    cost += performance.now() - t0;
    most = Math.max(most, traffic.riders.length);
    if (s % 60 === 0) for (const r of traffic.riders) farthest = Math.max(farthest, Math.hypot(r.x - player.x, r.z - player.z));
  }
  check(most <= TRAFFIC.maxRiders, 'the rider count stays bounded while the player moves', `at most ${most} (cap ${TRAFFIC.maxRiders})`);
  check(farthest <= TRAFFIC.despawn + 50, 'riders live in the planet image around the player', `farthest ${farthest.toFixed(0)} m`);
  check(cost / (120 * 150) < 1, 'traffic is cheap per physics step', `${(cost / (120 * 150)).toFixed(3)} ms`);
}

// --- Determinism.
{
  const run = (seed: number) => {
    const traffic = new TrafficSystem(new RAPIER.World({ x: 0, y: -9.81, z: 0 }), seed);
    const player = { x: 500, y: 200, z: -1500 };
    for (let s = 0; s < 120 * 15; s++) { player.z += 60 * DT; traffic.step(DT, s * DT, player, null); }
    return traffic.riders.map((r) => `${r.team}${r.heading}${r.x.toFixed(4)},${r.z.toFixed(4)}`).join(';');
  };
  const a = run(7), b = run(7), c = run(8);
  check(a === b && a.length > 0, 'traffic is deterministic for a given seed');
  check(a !== c, 'a different seed gives different traffic');
}

// --- The player's jetwall: riders derez riding into it, and steer clear when they can.
/** An intersection (i, j) with streets every way, and the blocks north of it too. */
function openNode(x: number, z: number): [number, number] {
  const i0 = nearestLine(x, GRID.x0), j0 = nearestLine(z, GRID.z0);
  for (let r = 0; r < 20; r++) for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
    const i = i0 + a, j = j0 + b;
    const all = (ii: number, jj: number) => ([0, 1, 2, 3] as Heading[]).every((h) => exitOpen(ii, jj, h));
    if (all(i, j) && all(i, j + 1) && all(i - 1, j) && all(i + 1, j)) return [i, j];
  }
  throw new Error('no open intersection');
}
{
  const sim = new Simulation(LIGHT_CYCLE);
  sim.traffic.spawning = false;
  sim.traffic.clear();
  const [i, j] = openNode(-2100, 900);
  // Lay a jetwall down z-line j in the outer +X lane, across x-line i.
  const wallZ = lineZ(j) + TRAFFIC.lanes[1];
  const b = sim.craft.body;
  const yaw = -Math.PI / 2;
  b.setTranslation({ x: lineX(i) - 70, y: 1, z: wallZ }, true);
  b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  b.setLinvel({ x: 30, y: 0, z: 0 }, true);
  sim.trails.derez(sim.time);
  sim.trails.start(sim.craft, false);
  const pilot = new GroundPilot(90, 30);
  let t = sim.telemetry();
  for (let s = 0; s < 120 * 5; s++) { sim.step(pilot.sample(sim.dt, t)); t = sim.telemetry(); }
  const wall = sim.trails.trails.filter((tr) => tr.kind === 'wall' && tr.derezAt === null).flatMap((tr) => tr.points);
  const spans = wall.length > 2 && Math.min(...wall.map((p) => p.x)) < lineX(i) - 20 && Math.max(...wall.map((p) => p.x)) > lineX(i) + 20;
  check(spans && !sim.exploded, 'test setup: the player\'s jetwall stands across a street', `${wall.length} points, ${sim.trails.colliderCount} solid`);
  pilot.speed = 0;
  pilot.brake = 1;
  const run = (seconds: number, until?: () => boolean) => {
    for (let s = 0; s < 120 * seconds && !until?.(); s++) { sim.step(pilot.sample(sim.dt, t)); t = sim.telemetry(); }
  };

  // Riding -Z down x-line i: the wall is crossed before any turn at the intersection.
  sim.traffic.avoid = false;
  const blind = sim.traffic.spawnRider({ heading: 3, line: i, along: wallZ + 40, speed: 30 });
  run(2, () => blind.derezAt !== null);
  check(blind.derezAt !== null, 'a rider driven into the player\'s jetwall derezzes', `derezzed at z ${blind.z.toFixed(1)} (wall at ${wallZ.toFixed(1)})`);
  check(!blind.body && blind.walls.length === 0 && sim.traffic.colliderCount === 0, 'its cycle and jetwall stop being solid at once');
  run(DEREZ_TIME + 0.2);
  check(!sim.traffic.riders.includes(blind), 'and it flickers out with its trail within a second');

  // With avoidance: from the north it swings round; from the south it turns right before the wall.
  sim.traffic.avoid = true;
  const north = sim.traffic.spawnRider({ heading: 3, line: i, along: wallZ + 90, speed: 30, seed: 3 });
  const south = sim.traffic.spawnRider({ heading: 1, line: i, along: lineZ(j) - 70, speed: 30, seed: 4 });
  const south2 = sim.traffic.spawnRider({ heading: 1, line: i, along: lineZ(j) - 110, speed: 40, laneIndex: 1, seed: 5 });
  run(8);
  const riders = [north, south, south2];
  const alive = riders.filter((r) => r.derezAt === null).length;
  check(alive === 3, 'riders turn away or swing round before the player\'s jetwall', `${alive} of 3 still riding, ${sim.traffic.derezzed} derezzed in all`);
}

// --- Hit by the player: a rider struck by the player's cycle derezzes.
{
  const sim = new Simulation(LIGHT_CYCLE);
  sim.traffic.spawning = false;
  sim.traffic.clear();
  const [i, j] = openNode(-2100, 900);
  const z = lineZ(j) + TRAFFIC.lanes[0]; // heading +X, inner lane
  const rider = sim.traffic.spawnRider({ heading: 0, line: j, along: lineX(i) + 60, speed: 0 });
  const b = sim.craft.body;
  const yaw = -Math.PI / 2;
  b.setTranslation({ x: lineX(i) + 15, y: 1, z }, true);
  b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  b.setLinvel({ x: 30, y: 0, z: 0 }, true);
  for (let s = 0; s < 120 * 3 && rider.derezAt === null; s++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: 0 });
  check(rider.derezAt !== null, 'a rider hit by the player derezzes', `player at x ${sim.position.x.toFixed(1)}, rider at ${rider.x.toFixed(1)}`);
}

console.log(failures ? `\n${failures} traffic check(s) failed` : '\nall traffic checks passed');
process.exit(failures ? 1 : 0);
