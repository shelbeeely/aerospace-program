/**
 * The non-combat networks. Run with `npm run civil`.
 *
 * Road traffic (src/sim/riderPolicy.ts, src/sim/traffic.ts):
 * 1. Fresh: the shipped weights were trained on the code as it is now; they fit the policy.
 * 2. The networks drive like the scripted rider: no rider rides into another, nobody derezzes,
 *    speeds and lane changes within a margin of the scripted traffic.
 * 3. The engine's rails hold whatever the network asks: with random weights, still no rider in
 *    another and nobody derezzed (signals, give-way and the lane-change gap checks are the
 *    engine's, not the policy's).
 * 4. A reckless player gets room: riders it comes up behind ease off and move over (or turn
 *    away); a calm player at the same speed gets none of that.
 * 5. Deterministic: the same run twice ends with every rider in the same place.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { createNet } from '../src/brain/net.ts';
import { seededRand } from '../src/people/genome.ts';
import { loadRiderWeights, riderNets, riderPolicy } from '../src/sim/riderPolicy.ts';
import { initPhysics } from '../src/sim/Simulation.ts';
import { exitOpen, lineX, lineZ, TRAFFIC, TrafficSystem, type Heading } from '../src/sim/traffic.ts';
import { GRID } from '../src/world/planetCity.ts';
import { freshness } from './lib/trainers.ts';

await initPhysics();
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const DT = 1 / 120;
const P = GRID.pitch;

console.log('--- the weights');
for (const f of freshness().filter((x) => x.trainer.name === 'train-civil')) {
  check(!f.stale, `${f.trainer.outputs.join(', ')} trained on the code as it is now`, f.stale ? `stale (${f.reasons.slice(0, 4).join('; ')}): run npm run train` : f.stamp.fingerprint);
}
const types = loadRiderWeights();
check(types.includes('cycle'), 'the riders\' networks fit their policy', `${types.map((t) => `drive.${t}`).join(', ')} ${riderPolicy.sizes.join('-')}`);

/** An east-west street through an open stretch near (x, z). */
function openLine(x: number, z: number): { i: number; j: number } {
  const i0 = Math.round((x - GRID.x0) / P), j0 = Math.round((z - GRID.z0) / P);
  for (let r = 0; r < 60; r++) for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
    if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
    const i = i0 + a, j = j0 + b;
    if (([0, 2] as Heading[]).every((h) => exitOpen(i, j, h) && exitOpen(i + 3, j, h) && exitOpen(i - 3, j, h))) return { i, j };
  }
  throw new Error('no open street');
}

interface Run { overlaps: number; derezzed: number; speedRatio: number; jogs: number; decisions: Record<string, number>; end: string; inLane: number }
/**
 * Traffic for `seconds` around a point; optionally a player driving east through it at `speed`
 * with `reckless`. Counts riders inside one another, derezzes, speed against what each wants,
 * lane changes, and how many riders just ahead of the player are making way for it.
 */
function ride(brain: 'scripted' | 'net', seconds: number, o: { x?: number; z?: number; player?: { speed: number; reckless: number } } = {}): Run {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const traffic = new TrafficSystem(world);
  traffic.brain = brain;
  const { i, j } = openLine(o.x ?? -2100, o.z ?? 900);
  const ob = o.player ? { x: lineX(i) - 500, y: 1, z: lineZ(j) + TRAFFIC.lanes[0], vx: o.player.speed, vz: 0, radius: 1.5 } : null;
  traffic.reckless = o.player?.reckless ?? 0;
  traffic.obstacles = ob ? [ob] : [];
  const centre = { x: lineX(i), y: 1, z: lineZ(j) };
  let overlaps = 0, ratioSum = 0, ratioN = 0, jogs = 0, inLane = 0, samples = 0;
  const jogging = new Set<number>();
  for (let s = 0; s < seconds / DT; s++) {
    if (ob) { ob.x += ob.vx * DT; if (ob.x > lineX(i) + 500) ob.x = lineX(i) - 500; }
    traffic.step(DT, s * DT, ob ?? centre, null);
    if (s % 30 !== 0) continue;
    samples++;
    const cells = new Map<number, typeof traffic.riders>();
    for (const r of traffic.riders) {
      if (r.derezAt !== null) continue;
      const k = Math.floor(r.x / 8) * 100003 + Math.floor(r.z / 8);
      for (const q of cells.get(k) ?? []) if (Math.abs(q.x - r.x) < 0.7 && Math.abs(q.z - r.z) < 0.7) overlaps++;
      let l = cells.get(k);
      if (!l) cells.set(k, (l = []));
      l.push(r);
      if (r.jog > 0 && !jogging.has(r.id)) { jogs++; jogging.add(r.id); } else if (r.jog === 0) jogging.delete(r.id);
      if (r.jog === 0 && r.uturn === 0 && r.speed > 1) { ratioSum += r.speed / traffic.ownSpeed(r); ratioN++; }
      // Ahead of the player on its street and making way for it (easing off and moving over, or turning off).
      if (ob && r.heading === 0 && (r.action === 'giveRoom' || r.action === 'turnAway') && Math.abs(r.z - lineZ(j)) < 12 && r.x > ob.x && r.x - ob.x < 160) inLane++;
    }
  }
  const end = traffic.riders.filter((r) => r.derezAt === null).map((r) => `${r.id}:${r.x.toFixed(2)},${r.z.toFixed(2)}`).join('|');
  return { overlaps, derezzed: traffic.derezzed, speedRatio: ratioSum / Math.max(1, ratioN), jogs, decisions: { ...traffic.decisions }, end, inLane: inLane / Math.max(1, samples) };
}

console.log('\n--- the networks against the scripted rider');
{
  const s = ride('scripted', 90), n = ride('net', 90);
  console.log(`  scripted: speed ${s.speedRatio.toFixed(2)} of wanted, ${s.jogs} lane changes, decisions ${JSON.stringify(s.decisions)}`);
  console.log(`  network:  speed ${n.speedRatio.toFixed(2)} of wanted, ${n.jogs} lane changes, decisions ${JSON.stringify(n.decisions)}`);
  check(s.overlaps === 0 && n.overlaps === 0 && s.derezzed === 0 && n.derezzed === 0, 'no rider rides into another and nobody derezzes, whoever drives', `overlaps ${s.overlaps}/${n.overlaps}, derezzed ${s.derezzed}/${n.derezzed}`);
  check(Math.abs(n.speedRatio - s.speedRatio) < 0.1 && n.jogs >= s.jogs * 0.6 && n.jogs <= s.jogs * 1.6 + 5, 'the network rides like the scripted rider (speed, lane changes)', `${n.speedRatio.toFixed(2)} vs ${s.speedRatio.toFixed(2)}, ${n.jogs} vs ${s.jogs} lane changes`);
}

console.log('\n--- the rails are the engine\'s');
{
  const keep = riderPolicy.net, kept = new Map(riderNets);
  const rand = seededRand(7);
  riderNets.clear();
  riderPolicy.net = createNet(riderPolicy.sizes, rand);
  for (let k = 0; k < riderPolicy.net.w.length; k++) riderPolicy.net.w[k] *= 6; // loud, arbitrary choices
  const f = ride('net', 90);
  riderPolicy.net = keep;
  for (const [t, n] of kept) riderNets.set(t, n);
  check(f.overlaps === 0 && f.derezzed === 0, 'with random weights, still no rider in another and nobody derezzed', `decisions ${JSON.stringify(f.decisions)}`);
}

console.log('\n--- a reckless player gets room');
{
  const calm = ride('net', 60, { player: { speed: 45, reckless: 0 } }), wild = ride('net', 60, { player: { speed: 45, reckless: 0.9 } });
  const roomCalm = calm.decisions.giveRoom + calm.decisions.turnAway, roomWild = wild.decisions.giveRoom + wild.decisions.turnAway;
  check(roomWild > 0 && roomCalm <= roomWild * 0.05, 'riders give a reckless player room, and a calm one (almost) none', `${roomWild} times for the reckless player, ${roomCalm} for the calm one`);
  check(wild.inLane > 0.05 && wild.inLane > calm.inLane * 3, 'riders ahead of a reckless player make way for it', `${(wild.inLane * 100).toFixed(0)} vs ${(calm.inLane * 100).toFixed(0)} riders making way in the 160 m ahead (per 100 samples)`);
  check(wild.overlaps === 0 && wild.derezzed === 0, 'and giving room is as safe as riding on');
}

console.log('\n--- determinism');
{
  const a = ride('net', 30, { x: 1800, z: -1200 }), b = ride('net', 30, { x: 1800, z: -1200 });
  check(a.end.length > 0 && a.end === b.end, 'the same run twice ends with every rider in the same place');
}

console.log(failures ? `\n${failures} FAILED` : '\nAll civil checks passed');
if (failures) process.exit(1);
