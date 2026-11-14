/**
 * Train the road vehicles' policies. Run with `npm run train-drive` (add `--evolve N` to refine by
 * N generations of evolution after imitation).
 *
 * 1. Record the scripted driver's decisions (observation, action) in the Scenario Lab across
 *    seeds, layouts, with and without the closure, with and without the player's orders.
 * 2. Add generated hard cases (blocked lanes, competing merges, emergency traffic, closures)
 *    labelled by the same scripted rules, so rare situations are not left to chance.
 * 3. Train each network by imitation (src/brain/net.ts), report how often it agrees with the
 *    teacher on held-out examples, per action.
 * 4. Optionally evolve: variants of the trained network, scored in the scenario on delivery
 *    lateness, response times, delay and shortage (collisions disqualify); the best is kept
 *    only if it beats the imitation.
 * 5. Write src/brain/weights/drive.json. Deterministic for its seed.
 */
import { writeFileSync } from 'node:fs';
import { accuracy, cloneNet, createNet, evolve, forward, argmax, mutateNet, toJSON, train, type Example, type Net } from '../src/brain/net.ts';
import { seededRand } from '../src/people/genome.ts';
import { DRIVE_ACTIONS, drivePolicy, respondPolicy, scriptedDrive, scriptedRespond, type DriveObs } from '../src/scenario/policies.ts';
import { Scenario, summary } from '../src/scenario/scenario.ts';
import { LAYOUTS } from '../src/scenario/district.ts';

const SEED = 20261114;
const rand = seededRand(SEED);
const argEvolve = process.argv.indexOf('--evolve');
const generations = argEvolve > 0 ? Number(process.argv[argEvolve + 1] ?? 4) : 0;

// 1. The scripted driver at work.
const recorded: Record<'drive' | 'respond', Array<{ obs: DriveObs; y: number }>> = { drive: [], respond: [] };
let runs = 0;
for (const seed of [1, 2, 3, 4]) for (const layout of LAYOUTS) for (const closeAt of [90, null]) for (const orders of [false, true]) {
  const sc = new Scenario({ seed, layout, closeAt, priorities: { ambulancesFirst: orders, contraflow: orders, trucksHold: false } });
  sc.recording = [];
  sc.run();
  for (const r of sc.recording) recorded[r.policy].push({ obs: r.obs, y: DRIVE_ACTIONS.indexOf(r.action) });
  runs++;
}

// 2. Hard cases, labelled by the teacher.
function hardCase(): DriveObs {
  const limit = [8, 12, 13, 16][Math.floor(rand() * 4)];
  const blocked = rand() < 0.3, merge = rand() < 0.3, emergency = rand() < 0.2, closed = rand() < 0.15;
  return {
    speed: rand() * limit * 1.1, limit,
    gap: blocked ? rand() * 30 : rand() * 120,
    closing: blocked ? rand() * 6 : rand() * 6 - 2,
    nextQueue: Math.floor(rand() * 12),
    nextClosed: closed ? 1 : 0,
    laneGap: merge ? 15 + rand() * 40 : rand() * 120,
    laneFree: merge || rand() < 0.5 ? 1 : 0,
    emergencyBehind: emergency ? 1 : 0,
    urgency: rand(),
    delay: rand() < 0.4 ? rand() * 80 : rand() * 10,
    waited: rand() < 0.3 ? rand() * 60 : 0,
    toNode: rand() * 200,
    heavy: rand() < 0.25 ? 1 : 0,
  };
}
for (let i = 0; i < 6000; i++) {
  const o = hardCase();
  recorded.drive.push({ obs: o, y: DRIVE_ACTIONS.indexOf(scriptedDrive(o)) });
  recorded.respond.push({ obs: { ...o, emergencyBehind: 0, urgency: 1 }, y: DRIVE_ACTIONS.indexOf(scriptedRespond({ ...o, emergencyBehind: 0, urgency: 1 })) });
}

// 3. Imitation.
const out: Record<string, unknown> = {};
const report: string[] = [];
for (const pol of [drivePolicy, respondPolicy]) {
  const all = recorded[pol.id as 'drive' | 'respond'];
  // Up to 25 000 of each rare decision, and "follow" at most three to one against them.
  const rare: typeof all = [];
  for (let k = 1; k < DRIVE_ACTIONS.length; k++) {
    const of = all.filter((r) => r.y === k);
    const keep = Math.min(1, 25000 / Math.max(1, of.length));
    rare.push(...of.filter(() => rand() < keep));
  }
  const follow = all.filter((r) => r.y === 0);
  const keepF = Math.min(1, (rare.length * 3) / Math.max(1, follow.length));
  const pool = [...rare, ...follow.filter(() => rand() < keepF)];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const ex: Example[] = pool.map((r) => ({ x: pol.encode(r.obs), y: r.y }));
  const cut = Math.floor(ex.length * 0.85);
  const trainSet = ex.slice(0, cut), test = ex.slice(cut);
  const net = createNet(pol.sizes, rand);
  const fit = train(net, trainSet, { epochs: 40, lr: 0.02, rand });
  const perAction = DRIVE_ACTIONS.map((a, k) => {
    const of = test.filter((e) => e.y === k);
    const ok = of.filter((e) => argmax(forward(net, e.x)) === k).length;
    return `${a} ${of.length ? Math.round((ok / of.length) * 100) : '-'}% of ${of.length}`;
  }).join(', ');
  report.push(`${pol.id}: ${all.length} recorded, ${trainSet.length} trained on; agrees with the teacher on ${(accuracy(net, test) * 100).toFixed(1)}% held out (${perAction}); train loss ${fit.loss.toFixed(3)}`);
  pol.net = net;
  out[pol.id] = net;
}

// 4. Evolution (optional): variants of the imitation, scored in the scenario.
function score(): number {
  let total = 0;
  for (const seed of [11, 12]) {
    const sc = new Scenario({ seed, driver: 'net', closeAt: 90 });
    sc.run();
    const m = summary(sc.metrics());
    if (m.collisions > 0) return -Infinity;
    total += (m.delivery || 0) + (m.response || 0) + 2 * m.delay + 0.2 * m.shortage;
  }
  return -total;
}
if (generations > 0) {
  for (const pol of [drivePolicy]) {
    const base = cloneNet(pol.net!);
    let pop: Net[] = [base, ...Array.from({ length: 7 }, () => mutateNet(base, 0.2, 0.15, rand))];
    let bestNet = base, bestFit = score();
    const baseFit = bestFit;
    for (let g = 0; g < generations; g++) {
      const fits = pop.map((n) => { pol.net = n; return score(); });
      fits.forEach((f, i) => { if (f > bestFit) { bestFit = f; bestNet = cloneNet(pop[i]); } });
      report.push(`  evolve ${pol.id} gen ${g + 1}: best ${(-Math.max(...fits)).toFixed(0)} (imitation ${(-baseFit).toFixed(0)})`);
      pop = evolve(pop, fits, { elite: 2, rate: 0.15, sigma: 0.1, rand });
    }
    pol.net = bestNet;
    out[pol.id] = bestNet;
    report.push(`  ${pol.id}: kept ${bestFit > baseFit ? 'the evolved network' : 'the imitation'} (${(-bestFit).toFixed(0)} vs ${(-baseFit).toFixed(0)})`);
  }
}

const json = {
  trained: { seed: SEED, runs, generations, note: 'npm run train-drive regenerates this file; scripted driver = teacher (src/scenario/policies.ts)' },
  drive: toJSON(out.drive as Net),
  respond: toJSON(out.respond as Net),
};
writeFileSync('src/brain/weights/drive.json', JSON.stringify(json) + '\n');
console.log(`${runs} scenario runs recorded`);
for (const r of report) console.log(r);
console.log('wrote src/brain/weights/drive.json');
