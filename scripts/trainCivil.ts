/**
 * Train the non-combat road networks. Run with `npm run train-civil` (or `npm run train`, which
 * runs it when its weights are stale).
 *
 * The riders (src/sim/riderPolicy.ts): record the scripted rider in headless traffic on the
 * planet's streets and data highways while a synthetic player drives through (calm, brisk and
 * reckless, at different speeds), add generated hard cases (slow leaders, turns that need the
 * other lane, a reckless player closing from behind), train by imitation, and report agreement
 * with the teacher on held-out decisions, per action.
 *
 * One network per stock ground type: each is trained on its own riders' decisions. Until the
 * traffic mix spawns every type, only the light cycle rides, so only `drive.cycle` is written;
 * the other types fall back to it (riderNet in src/sim/riderPolicy.ts).
 *
 * Writes src/brain/weights/civil.json, deterministically, stamped with a fingerprint of the
 * code it ran (scripts/lib/fingerprint.ts).
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { writeFileSync } from 'node:fs';
import { accuracy, argmax, createNet, forward, toJSON, train, type Example } from '../src/brain/net.ts';
import { seededRand } from '../src/people/genome.ts';
import { GROUND_FIGURES, GROUND_TYPES, RIDER_ACTIONS, riderPolicy, scriptedRider, type GroundType, type RiderObs } from '../src/sim/riderPolicy.ts';
import { initPhysics } from '../src/sim/Simulation.ts';
import { exitOpen, lineX, lineZ, TRAFFIC, TrafficSystem, type Heading } from '../src/sim/traffic.ts';
import { GRID } from '../src/world/planetCity.ts';
import { stampOf } from './lib/fingerprint.ts';

await initPhysics();
const SEED = 20261116;
const rand = seededRand(SEED);
const DT = 1 / 120;
const P = GRID.pitch;
const data = new Map<GroundType, Example[]>();
const add = (t: GroundType, e: Example) => { let l = data.get(t); if (!l) data.set(t, (l = [])); l.push(e); };

/** An east-west street (z-line j) through an open intersection near (x, z). */
function openLine(x: number, z: number): { i: number; j: number } {
  const i0 = Math.round((x - GRID.x0) / P), j0 = Math.round((z - GRID.z0) / P);
  for (let r = 0; r < 60; r++) for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
    if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
    const i = i0 + a, j = j0 + b;
    if (([0, 2] as Heading[]).every((h) => exitOpen(i, j, h) && exitOpen(i + 3, j, h) && exitOpen(i - 3, j, h))) return { i, j };
  }
  throw new Error('no open street');
}

// 1. The scripted rider at work, around a player driving through the traffic.
let runs = 0;
const areas: Array<[number, number]> = [[-2100, 900], [1800, -1200], [-600, -2400], [3000, 2600]];
for (const [ax, az] of areas) for (const reckless of [0, 0.35, 0.8]) for (const speed of [18, 34, 52]) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const traffic = new TrafficSystem(world);
  traffic.brain = 'scripted';
  traffic.reckless = reckless;
  traffic.recording = [];
  const { i, j } = openLine(ax, az);
  const lane = TRAFFIC.lanes[speed > 40 ? 0 : 1];
  const ob = { x: lineX(i) - 600, y: 1, z: lineZ(j) + lane, vx: speed, vz: 0, radius: 1.5 };
  traffic.obstacles = [ob];
  const SECONDS = 45;
  for (let s = 0; s < SECONDS / DT; s++) {
    const t = s * DT;
    // The player drives east along the street, back and forth through the same stretch.
    ob.x += ob.vx * DT;
    if (ob.x > lineX(i) + 600) ob.x = lineX(i) - 600;
    traffic.step(DT, t, ob, null);
  }
  for (const r of traffic.recording) add(r.type, { x: r.x, y: r.y });
  runs++;
}

// 2. Hard cases, labelled by the teacher, for every stock ground type (with its own figures).
function hardCase(type: GroundType): RiderObs {
  const f = GROUND_FIGURES[type];
  const desired = [17, 20, 23, 34, 38, 44][Math.floor(rand() * 6)];
  const slow = rand() < 0.35, player = rand() < 0.4;
  return {
    speed: rand() < 0.15 ? 0 : desired * (0.3 + rand() * 0.8), desired,
    leadGap: slow ? 10 + rand() * 90 : rand() < 0.4 ? 999 : rand() * 200, leadSlower: slow ? 2 + rand() * 15 : (rand() - 0.5) * 6,
    inner: rand() < 0.5 ? 1 : 0, mustMove: rand() < 0.2 ? 1 : 0, leftNext: rand() < 0.25 ? 1 : 0,
    toStop: rand() * 250, highway: desired > 30 ? 1 : 0, waited: rand() < 0.15 ? rand() * 30 : 0,
    playerDist: player ? rand() * 120 : 300 + rand() * 500, playerBehind: player && rand() < 0.7 ? 1 : 0, playerClosing: player ? (rand() - 0.3) * 30 : 0, reckless: rand(), playerEta: 99,
    mass: f.mass, top: f.top, accel: f.accel, length: f.length,
  };
}
const eta = (o: RiderObs) => { o.playerEta = o.playerBehind && o.playerClosing > 0.5 ? o.playerDist / o.playerClosing : 99; return o; };
for (const type of GROUND_TYPES) for (let k = 0; k < 4000; k++) {
  const o = eta(hardCase(type));
  add(type, { x: riderPolicy.encode(o), y: RIDER_ACTIONS.indexOf(scriptedRider(o)) });
}
// The boundary that matters most: a player close behind and closing, at every degree of
// recklessness, so the network learns that only a reckless one is given room.
for (const type of GROUND_TYPES) for (let k = 0; k < 6000; k++) {
  const o = hardCase(type);
  o.playerBehind = 1;
  o.playerDist = rand() * 300;
  o.playerClosing = rand() * 52 - 2; // well past the input's 30 m/s ceiling (a player at full speed on a highway)
  o.reckless = rand();
  // Often stopped at a stop line (lights, a queue), where the player comes up fastest.
  if (rand() < 0.35) { o.speed = 0; o.toStop = rand() * 15; o.waited = rand() * 20; }
  eta(o);
  add(type, { x: riderPolicy.encode(o), y: RIDER_ACTIONS.indexOf(scriptedRider(o)) });
}

// 3. Train each type that has its own riders in traffic (the rest fall back to the cycle's).
const out: Record<string, ReturnType<typeof toJSON>> = {};
const riding = new Set<GroundType>(['cycle']);
for (const type of GROUND_TYPES) {
  if (!riding.has(type)) continue;
  const all = data.get(type) ?? [];
  // Keep the rare actions: cap each action's share of the training set.
  const byAction = RIDER_ACTIONS.map((_, k) => all.filter((e) => e.y === k));
  for (const l of byAction) for (let n = l.length - 1; n > 0; n--) { const m = Math.floor(rand() * (n + 1)); [l[n], l[m]] = [l[m], l[n]]; }
  const ex = byAction.flatMap((l) => l.slice(0, 20000));
  for (let n = ex.length - 1; n > 0; n--) { const m = Math.floor(rand() * (n + 1)); [ex[n], ex[m]] = [ex[m], ex[n]]; }
  const cut = Math.floor(ex.length * 0.85);
  const trainSet = ex.slice(0, cut), test = ex.slice(cut);
  const net = createNet(riderPolicy.sizes, rand);
  const fit = train(net, trainSet, { epochs: 50, lr: 0.02, rand, balance: false });
  const per = RIDER_ACTIONS.map((a, k) => {
    const of = test.filter((e) => e.y === k);
    return `${a} ${of.length ? Math.round((of.filter((e) => argmax(forward(net, e.x)) === k).length / of.length) * 100) : '-'}% of ${of.length}`;
  }).join(', ');
  console.log(`drive.${type}: ${all.length} recorded, ${trainSet.length} trained on; agrees with the teacher on ${(accuracy(net, test) * 100).toFixed(1)}% held out (${per}); train loss ${fit.loss.toFixed(3)}`);
  out[`drive.${type}`] = toJSON(net);
}

const note = { seed: SEED, runs, note: 'npm run train (or train-civil) regenerates this file; scripted rider = teacher (src/sim/riderPolicy.ts)', ...stampOf('scripts/trainCivil.ts') };
writeFileSync('src/brain/weights/civil.json', JSON.stringify({ trained: note, ...out }) + '\n');
console.log(`${runs} traffic runs recorded; wrote src/brain/weights/civil.json`);
