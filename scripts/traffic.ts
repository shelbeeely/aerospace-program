/**
 * AI light-cycle traffic checks: riders keep to street lanes, follow the grid (turning only at
 * intersections, changing lane with a square jog between them), stay off airfields, sea and
 * the Outlands, follow the rider ahead without riding into it or its jetwall, obey the signals
 * and take the other crossings in turn, brake for the player's vehicle, derez riding into the
 * player's jetwall (or when the player hits them), steer clear of it when they can, stay
 * bounded while the player moves around the planet, and are deterministic for a given seed.
 * Run with `npm run traffic`.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { LIGHT_CYCLE } from '../src/craft/lightCycle.ts';
import { CITY, PLANET } from '../src/sim/layout.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { blockKind, CONTROL, controlAt, exitOpen, HX, isHighwayLine, HZ, lineX, lineZ, SIGNAL, signalPhase, TRAFFIC, TrafficSystem, trailLength, type Heading, type Rider } from '../src/sim/traffic.ts';
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

// --- Riding the grid: lanes, turns at intersections, streets only; following, signals, crossings.
{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const traffic = new TrafficSystem(world);
  const player = { x: -2100, y: 120, z: 900 };
  let offLane = 0, badTurns = 0, offRoad = 0, turns = 0, jogs = 0, samples = 0, worst = '';
  let crossings = 0, overlaps = 0, redRuns = 0, entries = 0, stopped = 0, longest = 0, speedSum = 0, wantSum = 0, speedN = 0, crossWorst = '';
  const last = new Map<Rider, { h: Heading; jog: boolean; node: number; toStop: number; fx: number; fz: number }>();
  const SECONDS = 150;
  const cells = new Map<number, Rider[]>();
  const cellOf = (x: number, z: number) => Math.floor(x / 64) * 100003 + Math.floor(z / 64);
  for (let s = 0; s < 120 * SECONDS; s++) {
    const time = s * DT;
    traffic.step(DT, time, player, null);
    cells.clear();
    for (const r of traffic.riders) {
      if (r.derezAt !== null) continue;
      const k = cellOf(r.x, r.z);
      let l = cells.get(k);
      if (!l) cells.set(k, (l = []));
      l.push(r);
    }
    for (const r of traffic.riders) {
      if (r.derezAt !== null) continue;
      const prev = last.get(r);
      const fx = r.x + HX[r.heading] * TRAFFIC.nose, fz = r.z + HZ[r.heading] * TRAFFIC.nose;
      const riding = r.uturn === 0 && r.jog === 0;
      const ax = r.heading === 0 || r.heading === 2;
      const d = r.heading === 0 || r.heading === 1 ? 1 : -1;
      const toStop = riding ? ((ax ? lineX(r.node) : lineZ(r.node)) - d * TRAFFIC.stopLine - (ax ? fx : fz)) * d : 0;
      last.set(r, { h: r.heading, jog: r.jog > 0, node: r.node, toStop, fx, fz });
      // Heading changes only inside an intersection box (lane offsets from both lines), or as
      // the two square corners of a lane change.
      if (prev !== undefined && prev.h !== r.heading) {
        if (r.jog > 0 || prev.jog) { if (r.jog > 0) jogs++; }
        else {
          turns++;
          // Where it turned: the jetwall's newest corner (it may ride on a little in the same step).
          const c = r.trail[r.trail.length - 1];
          const dx = Math.abs(c.x - lineX(nearestLine(c.x, GRID.x0)));
          const dz = Math.abs(c.z - lineZ(nearestLine(c.z, GRID.z0)));
          if (dx > TRAFFIC.lanes[1] + 0.01 || dz > TRAFFIC.lanes[1] + 0.01) { badTurns++; worst ||= `turn at ${dx.toFixed(1)}, ${dz.toFixed(1)} m from the lines`; }
        }
      }
      // Its nose never crosses another rider's jetwall, and it never sits inside another cycle.
      if (prev && s % 2 === 0) {
        const cx = Math.floor(r.x / 64), cz = Math.floor(r.z / 64);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const o of cells.get((cx + a) * 100003 + cz + b) ?? []) {
          if (o === r) continue;
          if (Math.abs(o.x - r.x) < 0.7 && Math.abs(o.z - r.z) < 0.7) overlaps++;
          const pts = [...o.trail, traffic.tail(o), { x: o.x + HX[o.heading] * TRAFFIC.nose, z: o.z + HZ[o.heading] * TRAFFIC.nose }];
          const ex = fx - prev.fx, ez = fz - prev.fz;
          for (let k = 1; k < pts.length; k++) {
            const p = pts[k - 1], q = pts[k];
            const wx = q.x - p.x, wz = q.z - p.z;
            const den = ex * wz - ez * wx;
            if (Math.abs(den) < 1e-9) continue;
            const t = ((p.x - prev.fx) * wz - (p.z - prev.fz) * wx) / den;
            const u = ((p.x - prev.fx) * ez - (p.z - prev.fz) * ex) / den;
            if (t > 0 && t <= 1 && u > 0.001 && u < 0.999) { crossings++; crossWorst ||= `rider ${r.id} through ${o.id}'s wall at ${fx.toFixed(0)}, ${fz.toFixed(0)}, t=${time.toFixed(1)} s`; }
          }
        }
      }
      if (!riding) continue;
      samples++;
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
      // Signals: nobody rides over a stop line on red.
      const i = ax ? r.node : r.line, j = ax ? r.line : r.node;
      if (prev && !prev.jog && prev.h === r.heading && prev.node === r.node && prev.toStop > 0 && toStop <= 0 && controlAt(i, j) === CONTROL.signal) {
        entries++;
        // (A left turn that waited out the green may clear in the first second of the all-red.)
        const [light, remains] = signalPhase(i, j, ax, time);
        if (light === 'red' && !(r.next === ((r.heading + 3) % 4) && remains > SIGNAL.cycle / 2 + SIGNAL.allRed - 1.1)) redRuns++;
      }
      if (time > 30 && s % 30 === 0) {
        speedSum += r.speed;
        wantSum += traffic.desired(r);
        speedN++;
        if (r.speed < 0.3) stopped++;
        longest = Math.max(longest, r.waited);
      }
    }
  }
  check(traffic.active > 250, 'the streamed disc fills with riders', `${traffic.active} riding`);
  check(offLane === 0, 'riders keep to their lane centres', `${samples} samples, ${offLane} off${worst ? ` (${worst})` : ''}`);
  check(turns > 50 && badTurns === 0, 'riders turn only at intersections', `${turns} turns, ${badTurns} elsewhere`);
  check(jogs > 10, 'riders change lane between intersections', `${jogs} lane changes`);
  check(offRoad === 0, 'riders stay off airfields, sea and the Outlands', `${offRoad} off-road samples`);
  check(crossings === 0 && overlaps === 0, 'no rider rides into another or through its jetwall', `${crossings} wall crossings, ${overlaps} overlaps${crossWorst ? ` (${crossWorst})` : ''}`);
  check(entries > 30 && redRuns === 0, 'riders stop for red at the highway crossings', `${entries} crossed a signal's stop line, ${redRuns} on red`);
  check(stopped > 0 && speedSum / wantSum > 0.55, 'traffic queues and still flows', `${((100 * stopped) / speedN).toFixed(1)}% standing, mean speed ${(speedSum / speedN).toFixed(1)} m/s (${((100 * speedSum) / wantSum).toFixed(0)}% of what riders want)`);
  check(longest < 120, 'nobody is stuck at a crossing', `longest wait ${longest.toFixed(0)} s`);
  const highway = traffic.riders.filter((r) => isHighwayLine(r.line)).length;
  check(highway > traffic.riders.length * 0.4, 'the data highways carry most of the traffic', `${highway} of ${traffic.riders.length} on highways (1 line in 6)`);
  let trailBad = 0, trailMax = 0;
  for (const r of traffic.riders) {
    if (r.derezAt !== null) continue;
    const pts = [...r.trail, traffic.tail(r)];
    let L = 0;
    for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
    trailMax = Math.max(trailMax, L);
    if (L > trailLength(r) + 0.5) trailBad++;
  }
  check(trailBad === 0 && trailMax <= TRAFFIC.trailLength + 0.01 && trailMax > TRAFFIC.trailLength * 0.8, 'each rider carries a short jetwall, shorter the slower it rides', `longest ${trailMax.toFixed(1)} m (limit ${TRAFFIC.trailLength} m)`);
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
  for (let r = 0; r < 60; r++) for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
    if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
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
  sim.traffic.control = false;
  const blind = sim.traffic.spawnRider({ heading: 3, line: i, along: wallZ + 40, speed: 30 });
  run(2, () => blind.derezAt !== null);
  check(blind.derezAt !== null, 'a rider driven into the player\'s jetwall derezzes', `derezzed at z ${blind.z.toFixed(1)} (wall at ${wallZ.toFixed(1)})`);
  check(!blind.body && blind.walls.length === 0 && sim.traffic.colliderCount === 0, 'its cycle and jetwall stop being solid at once');
  run(DEREZ_TIME + 0.2);
  check(!sim.traffic.riders.includes(blind), 'and it flickers out with its trail within a second');

  // With avoidance: from the north it swings round; from the south it turns right before the wall.
  sim.traffic.avoid = true;
  sim.traffic.control = false; // whatever the lights say
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

// --- The player's vehicle on the road: a rider coming up behind brakes and waits.
{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const traffic = new TrafficSystem(world);
  traffic.spawning = false;
  const [i, j] = openNode(-2100, 900);
  const z = lineZ(j) + TRAFFIC.lanes[0]; // the inner +X lane, mid-block
  const rider = traffic.spawnRider({ heading: 0, line: j, along: lineX(i) + 25, speed: 30 });
  // Parked across both lanes (in one lane the rider would simply pull out and pass).
  const parked = { x: lineX(i) + 90, y: 1, z: lineZ(j) + (TRAFFIC.lanes[0] + TRAFFIC.lanes[1]) / 2, vx: 0, vz: 0, radius: 2 };
  traffic.obstacles = [parked];
  for (let s = 0; s < 120 * 6; s++) traffic.step(DT, s * DT, { x: parked.x, y: 1, z }, null);
  const gap = parked.x - parked.radius - (rider.x + TRAFFIC.nose);
  check(rider.derezAt === null && rider.speed < 0.5 && gap > 0.5 && gap < 12 && rider.jog === 0, 'a rider brakes behind the player\'s vehicle across its road', `stopped ${gap.toFixed(1)} m behind it`);
  traffic.obstacles = [];
  for (let s = 0; s < 120 * 3; s++) traffic.step(DT, 6 + s * DT, { x: parked.x, y: 1, z }, null);
  check(rider.speed > 10, 'and rides on when the way is clear', `${rider.speed.toFixed(1)} m/s`);
}

console.log(failures ? `\n${failures} traffic check(s) failed` : '\nall traffic checks passed');
process.exit(failures ? 1 : 0);
