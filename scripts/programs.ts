/**
 * Programs: the working population of the streets, one kind per side. Run with `npm run programs`.
 *
 * 1. Posts are deterministic, and each faction's kind stands only where its team holds the
 *    district: Archivists in Cyan land, Sentinels in Red, Tenders in Amber; Scavengers
 *    (freelancers) and Brokers (mercenaries) anywhere.
 * 2. They walk the road network's margins in file and never step off them into a lot, nor along
 *    a closed road.
 * 3. Sentinels warn a stranger on foot and derez them if they come on; they salute a Red player.
 * 4. Tenders walk to a broken road and mend it; scavengers go to a fresh crater.
 * 5. Run over, they derez; a blast derezzes them; a broker renews mercenary contracts.
 */
import { GRID } from '../src/arch/grid.ts';
import { CITY } from '../src/sim/layout.ts';
import { baseOwner } from '../src/sim/territory.ts';
import { chunkAt } from '../src/world/planetCity.ts';
import { nodeX, nodeZ, roadOpen } from '../src/sim/roads.ts';
import { RoadDamage } from '../src/sim/roadDamage.ts';
import { terrainHeight } from '../src/sim/terrain.ts';
import { postAt, Programs, PROGRAMS, PROGRAM_KIND_LIST, PROGRAM_KINDS, TEAM_PROGRAM, cornerX, cornerZ, type ProgramKind, type ProgramWorld } from '../src/sim/programs.ts';
import type { Team } from '../src/sim/teams.ts';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const P = GRID.pitch;
const owner = (x: number, z: number): Team | null => { const [ci, cj] = chunkAt(x, z); return baseOwner(ci, cj); };

console.log('--- posts');
const counts = new Map<ProgramKind, number>();
let wrongSide = 0, posts = 0, corners = 0;
const N = GRID.blocks;
for (let i = 0; i < N; i += 3) for (let j = 0; j < N; j += 3) {
  corners++;
  const o = owner(nodeX(i), nodeZ(j));
  const p = postAt(i, j, o);
  if (!p) continue;
  posts++;
  counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  const side = PROGRAM_KINDS[p.kind].side;
  if (typeof side === 'number' && side < 3 && side !== o) wrongSide++;
  const again = postAt(i, j, o);
  if (!again || again.kind !== p.kind || again.size !== p.size) wrongSide++;
}
check(PROGRAM_KIND_LIST.every((k) => (counts.get(k) ?? 0) > 20), 'every kind stands somewhere', PROGRAM_KIND_LIST.map((k) => `${k} ${counts.get(k) ?? 0}`).join(', '));
check(wrongSide === 0, "each faction's kind only in its own team's land, deterministic", `${wrongSide} wrong of ${posts} posts (${corners} corners)`);
check(TEAM_PROGRAM.every((k, t) => PROGRAM_KINDS[k].side === t) && new Set(PROGRAM_KIND_LIST.map((k) => String(PROGRAM_KINDS[k].side))).size === PROGRAM_KIND_LIST.length, 'one kind per side, exclusive to it');

// A busy street corner somewhere in the city with all three teams within reach.
function findSpot(want: ProgramKind): { x: number; z: number } {
  for (let i = 10; i < N; i++) for (let j = 10; j < N; j++) {
    const p = postAt(i, j, owner(nodeX(i), nodeZ(j)));
    if (p?.kind === want && p.size >= PROGRAM_KINDS[want].group[0]) return { x: cornerX(p.corner), z: cornerZ(p.corner) };
  }
  throw new Error('no ' + want);
}

console.log('--- walking');
{
  const spot = findSpot('sentinel');
  const pr = new Programs();
  const world: ProgramWorld = { owner };
  const dt = 0.1;
  let t = 0;
  pr.step(dt, t, spot, world);
  const n0 = pr.people.length;
  const pr2 = new Programs();
  pr2.step(dt, 0, spot, world);
  check(n0 > 20 && pr2.people.length === n0 && pr2.people.every((p, k) => p.key === pr.people[k].key && p.x === pr.people[k].x), 'a street corner fills with programs, the same every time', `${n0} round the player`);
  const start = new Map(pr.people.map((p) => [p.key, { x: p.x, z: p.z }]));
  let offRoad = 0, worst = 0, fileGap = 0;
  for (let k = 0; k < 900; k++) {
    t += dt;
    pr.step(dt, t, spot, world);
    for (const p of pr.people) {
      const fx = (p.x - GRID.x0) / P, fz = (p.z - GRID.z0) / P;
      const off = Math.min(Math.abs(fx - Math.round(fx)), Math.abs(fz - Math.round(fz))) * P;
      worst = Math.max(worst, off);
      if (off > CITY.street / 2) offRoad++;
    }
    for (const g of pr.groups.values()) for (let m = 1; m < g.members.length; m++) {
      const a = g.members[m - 1], b = g.members[m];
      if (b.k === a.k + 1) fileGap = Math.max(fileGap, Math.hypot(a.x - b.x, a.z - b.z));
    }
  }
  const moved = pr.people.filter((p) => { const s = start.get(p.key); return s && Math.hypot(p.x - s.x, p.z - s.z) > 20; }).length;
  check(moved > n0 * 0.4, 'they walk the streets', `${moved} of ${pr.people.length} moved more than 20 m in 90 s`);
  check(offRoad === 0, 'never off the road margins into a lot', `furthest ${worst.toFixed(1)} m from a centreline (street half-width ${CITY.street / 2})`);
  check(fileGap < PROGRAMS.spacing + 0.6, 'groups keep in file', `largest gap ${fileGap.toFixed(2)} m`);
  const brokers = pr.people.filter((p) => p.kind === 'broker');
  check(brokers.every((p) => { const s = start.get(p.key); return s && Math.hypot(p.x - s.x, p.z - s.z) < 0.01; }), 'brokers keep their corners', `${brokers.length} brokers`);
}

console.log('--- sentinels');
for (const team of [0, 1] as Team[]) {
  const spot = findSpot('sentinel');
  const pr = new Programs();
  const walker = { active: true, downAt: null as number | null, x: spot.x, y: terrainHeight(spot.x, spot.z), z: spot.z };
  const world: ProgramWorld = { owner, walker, team };
  let t = 0, shot = -1, warned = false, saluted = false;
  pr.step(0.1, t, spot, world);
  const g = [...pr.groups.values()].find((g) => g.kind === 'sentinel' && Math.hypot(cornerX(g.post) - spot.x, cornerZ(g.post) - spot.z) < 1)!;
  for (let k = 0; k < 200 && shot < 0; k++) {
    t += 0.1;
    // Keep walking up to the patrol's leader.
    const l = g.members[0];
    walker.x = l.x + 4; walker.z = l.z;
    if (pr.step(0.1, t, spot, world).shotPlayer) shot = t;
    if (g.activity === 'alert') warned = true;
    if (g.members.some((p) => p.answer === 'yes')) saluted = true;
  }
  if (team === 0) {
    check(warned && shot > 0 && shot < 6, 'a Cyan player on foot is warned, then derezzed by a Sentinel patrol', `warned ${warned}, shot at ${shot.toFixed(1)} s`);
    check(pr.shots.length > 0, 'the shot is recorded for the renderer');
  } else check(shot < 0 && saluted && !warned, 'a Red player is saluted (YES) and never shot', `saluted ${saluted}, warned ${warned}`);
}
{
  // Walk away after the warning: no shot.
  const spot = findSpot('sentinel');
  const pr = new Programs();
  const walker = { active: true, downAt: null as number | null, x: 0, y: 0, z: 0 };
  const world: ProgramWorld = { owner, walker, team: 2 };
  pr.step(0.1, 0, spot, world);
  const g = [...pr.groups.values()].find((g) => g.kind === 'sentinel' && Math.hypot(cornerX(g.post) - spot.x, cornerZ(g.post) - spot.z) < 1)!;
  const l = g.members[0];
  walker.x = l.x + 14; walker.z = l.z;
  let shot = false;
  for (let k = 0; k < 20; k++) shot ||= pr.step(0.1, 0.1 * k, spot, world).shotPlayer;
  const alerted = g.activity === 'alert';
  walker.x = l.x + 60;
  for (let k = 20; k < 120; k++) shot ||= pr.step(0.1, 0.1 * k, spot, world).shotPlayer;
  check(alerted && !shot && g.activity !== 'alert', 'keeping your distance after the warning: never shot, and the patrol goes back to its beat', `alerted ${alerted}, now ${g.activity}`);
}

console.log('--- tenders and scavengers');
{
  const spot = findSpot('tender');
  const pr = new Programs();
  const roads = new RoadDamage();
  const world: ProgramWorld = { owner, closed: roads.closed, closures: roads.closures, repair: (c) => roads.repair(c) };
  pr.step(0.1, 0, spot, world);
  // Break a road two blocks away.
  const i0 = Math.round((spot.x - GRID.x0) / P) + 2, j0 = Math.round((spot.z - GRID.z0) / P);
  let c = null;
  for (let di = 0; di < 6 && !c; di++) for (let dj = -3; dj < 4 && !c; dj++) {
    const i = i0 + di, j = j0 + dj;
    if (!roadOpen(true, i, j)) continue;
    const x = nodeX(i) + P / 2, z = nodeZ(j);
    c = roads.add(x, terrainHeight(x, z), z, 9);
  }
  check(!!c, 'a crater closes a road near the tenders');
  let t = 0, mended = -1, onClosed = 0;
  const tenders = () => [...pr.groups.values()].filter((g) => g.kind === 'tender');
  for (let k = 0; k < 6000 && mended < 0; k++) {
    t += 0.1;
    pr.step(0.1, t, spot, world);
    if (!roads.closures.length) mended = t;
    for (const g of pr.groups.values()) if (g.activity === 'walk' && g.to && c) {
      // Walking along the closed segment's margin?
      const a = g.at, b = g.to;
      if (a.j === b.j && c.alongX && Math.min(a.i, b.i) === c.i && a.j === c.j && a.i !== b.i) onClosed++;
      if (a.i === b.i && !c.alongX && Math.min(a.j, b.j) === c.j && a.i === c.i && a.j !== b.j) onClosed++;
    }
  }
  check(mended > 0, 'Amber tenders walk to the broken road and mend it', `${tenders().length} tender groups, mended at ${mended.toFixed(0)} s, ${pr.repaired} repaired`);
  check(!roads.closed(c!.alongX, c!.i, c!.j) && roads.barriers.length === 0, 'the mended road is open: no closure, no barriers');
  check(onClosed === 0, 'no one walks along a closed road', `${onClosed} steps`);
}
{
  const spot = findSpot('scavenger');
  const pr = new Programs();
  const sites: Array<{ x: number; z: number; time: number }> = [];
  const world: ProgramWorld = { owner, sites };
  pr.step(0.1, 0, spot, world);
  const g = [...pr.groups.values()].find((g) => g.kind === 'scavenger' && Math.hypot(cornerX(g.post) - spot.x, cornerZ(g.post) - spot.z) < 1)!;
  const site = { x: spot.x + 3 * P, z: spot.z + 2 * P, time: 0.5 };
  sites.push(site);
  let t = 0.1, worked = false, closest = Infinity;
  for (let k = 0; k < 4000 && !worked; k++) {
    t += 0.1;
    pr.step(0.1, t, spot, world);
    const l = g.members[0];
    if (l) closest = Math.min(closest, Math.hypot(l.x - site.x, l.z - site.z));
    if (g.activity === 'work') worked = true;
  }
  check(worked && closest < 80, 'freelance scavengers go to a fresh crater and pick it over', `came within ${closest.toFixed(0)} m`);
}

console.log('--- derez and brokers');
{
  const spot = findSpot('archivist');
  const pr = new Programs();
  pr.step(0.1, 0, spot, { owner });
  const p = pr.people[0];
  const n = pr.people.length;
  pr.step(0.1, 0.1, spot, { owner, threats: [{ x: p.x, y: p.y + 0.8, z: p.z, vx: 20, vz: 0 }] });
  check(!pr.people.includes(p) && pr.derezEvents.some((d) => d.byPlayer), 'run over, a program derezzes', `${n} → ${pr.people.length}`);
  const q = pr.people[0];
  const k = pr.strike(q.x, q.y + 1, q.z, 6, 0.2);
  check(k >= 1 && !pr.people.includes(q), 'a blast derezzes the programs it reaches', `${k} derezzed`);
  const b = pr.people.find((p) => p.kind === 'broker');
  if (b) {
    const heard = pr.hear(b.x + 2, b.z, 'yes', 0, 1);
    check(heard === b && b.answer === 'yes', 'a broker answers the player and is the one heard');
  } else check(false, 'a broker near the archivists');
}

// The simulation: a broker renews contracts, a tender's mend lifts the rubble.
{
  const { initPhysics, Simulation } = await import('../src/sim/Simulation.ts');
  const { LIGHT_CAR } = await import('../src/craft/lightCar.ts');
  await initPhysics();
  const sim = new Simulation(LIGHT_CAR);
  const spot = findSpot('broker');
  sim.programs.step(0.1, 0, spot, { owner });
  const b = sim.programs.people.find((p) => p.kind === 'broker')!;
  const w = sim.walker;
  // Stand beside it on foot (a bare walker: the test does not need the vehicle).
  w.active = true; w.downAt = null; w.x = b.x + 2; w.z = b.z; w.y = b.y;
  (sim as unknown as { credits: number }).credits = 1000;
  const none = sim.speak('yes');
  check(!!none && /no contracts/.test(none), 'a broker with no one hired says so', none ?? '');
  const f = { mercUntil: 100 } as { mercUntil: number };
  (sim.airTraffic as unknown as { mercs: () => unknown[] }).mercs = () => [f];
  w.answeredAt = -Infinity;
  const word = sim.speak('yes');
  check(!!word && /renewed/.test(word) && f.mercUntil === 100 + PROGRAMS.broker.renew && sim.credits === 1000 - PROGRAMS.broker.price, 'YES beside a broker renews the mercenary contracts for a fee', word ?? '');
}

console.log(failures ? `\n${failures} program check(s) FAILED` : '\nAll program checks passed');
process.exit(failures ? 1 : 0);
