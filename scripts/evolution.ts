/**
 * Bit evolution. Run with `npm run evolution`.
 *
 * 1. Genes: crossover takes every gene from a parent, copying errors stay in range, looks stay
 *    among the bitStyle choices, founders are a pure function of their lot, and a middle genome
 *    is the Bit as it was before genes.
 * 2. Life on the street: two grown Bits of one lot who both said YES compile a child, only while
 *    the lot has room; children appear on the kerb or in the room, never in a wall; a room holds
 *    only so many; Bits age, and die of age.
 * 3. Gene pools: a lot that streams out and back keeps its people, older; pools survive a world
 *    reset; the compact encoding round-trips; off-screen catch-up is deterministic and keeps to
 *    the lot's capacity.
 * 4. The lab is deterministic for a seed, and selection works: kerb traffic breeds timid Bits
 *    and scarcity slow ones, against a control (four seeds each).
 * 5. YES stays yellow and NO red for every Bit, whatever its look.
 * 6. The relay's world (server/world.ts), with two games joined to it in-process: lots stream
 *    in from the relay, the holder's lots go back to it, lots nobody holds live on there, and a
 *    Bit killed in the other game leaves the holder's.
 */
import { BIT_LOOK } from '../src/people/bit.ts';
import { BIT_STYLE_CHOICES, styledState } from '../src/people/bitStyle.ts';
import { crossover, express, founderGenome, GENES, midGenome, mutate, sanitizeGenome, seededRand, STYLE_FIELDS, type BitGenome } from '../src/people/genome.ts';
import { BITS, BitPopulation, roomPlaces, type BitPerson } from '../src/sim/bits.ts';
import { advancePool, CHILD_SLOT, decodePools, encodePools, EVOLUTION, fromBase64, isGrown, toBase64, type StoredLot } from '../src/sim/evolution.ts';
import { EvolutionLab } from '../src/sim/evolutionLab.ts';
import { World } from '../server/world.ts';
import type { PoolSource } from '../src/sim/bits.ts';
import { districtPlan } from '../src/arch/DistrictGenerator.ts';
import { GRID } from '../src/arch/grid.ts';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const f2 = (x: number) => x.toFixed(2);
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const validStyle = (g: BitGenome) => STYLE_FIELDS.every((f) => (BIT_STYLE_CHOICES[f] as ReadonlyArray<readonly [string, string]>).some(([c]) => c === g.style[f]));

console.log('--- genes');
{
  const rand = seededRand(7);
  let fromParents = true, inRange = true, styles = true;
  for (let i = 0; i < 2000; i++) {
    const a = founderGenome(rand, rand(), rand()), b = founderGenome(rand, rand(), rand());
    const c = crossover(a, b, rand);
    for (const k of GENES) if (c[k] !== a[k] && c[k] !== b[k]) fromParents = false;
    for (const f of STYLE_FIELDS) if (c.style[f] !== a.style[f] && c.style[f] !== b.style[f]) fromParents = false;
    mutate(c, 0.5, rand);
    for (const k of GENES) if (!(c[k] >= 0 && c[k] <= 1)) inRange = false;
    if (!validStyle(c) || !sanitizeGenome(c)) styles = false;
  }
  check(fromParents, 'a child has every gene and every part of its look from one parent or the other');
  check(inRange && styles, 'copying errors keep genes in 0..1 and looks among the bitStyle choices');
  const m = express(midGenome());
  check(Math.abs(m.pace - 2.4) < 1e-9 && m.scareRange === 1 && m.scareSpeed === 1 && m.talkRange === 1 && m.cooldown === 1 && Math.abs(m.yes - 0.5) < 1e-9
    && Math.abs(m.indoors - 0.6) < 1e-9 && Math.abs(m.homeWeight - 1) < 1e-9 && m.stay === 1 && m.size === 1, 'a middle genome is the Bit as it was (pace, nerve, talk, YES, home, size)');
  check(sanitizeGenome({ ...midGenome(), pace: 2 }) === null && sanitizeGenome({ ...midGenome(), style: { light: 'red', size: 'medium', idle: 'pulse', spin: 'steady' } }) === null, 'a malformed genome is refused');
}

console.log('\n--- founders');
const C0 = { x: -2600, z: -1500 };
{
  const a = new BitPopulation(), b = new BitPopulation();
  a.step(1 / 30, 0, C0);
  b.step(1 / 30, 0, C0);
  const sig = (p: BitPopulation) => p.people.map((q) => `${q.home.key}:${q.slot}:${GENES.map((k) => q.genome[k].toFixed(6)).join(',')}:${q.genome.style.light}${q.genome.style.size}`).join(';');
  check(a.people.length > 20 && sig(a) === sig(b), 'founders are a pure function of their lot', `${a.people.length} Bits`);
  const looks = new Set(a.people.map((q) => `${q.genome.style.light}/${q.genome.style.size}/${q.genome.style.idle}/${q.genome.style.spin}`));
  const plain = a.people.filter((q) => q.genome.style.light === 'blue').length / a.people.length;
  check(looks.size > 1 && plain > 0.7, 'most founders wear the plain blue look; a few wear their district\'s variant', `${looks.size} looks, ${Math.round(plain * 100)}% blue`);
  const craft = mean(a.people.map((q) => q.genome.craft));
  check(craft < 0.2, 'sapper skill starts near nothing', `mean craft ${f2(craft)}`);
}

console.log('\n--- life on the street');
{
  const pop = new BitPopulation({ evolution: { lifespanScale: 0.5, energyScale: 1, mutation: EVOLUTION.mutation } });
  pop.step(1 / 30, 0, C0);
  const homes = [...pop.homes.values()];
  // Solids: the buildings' own colliders.
  const solid: Array<{ x: number; y: number; z: number; sx: number; sy: number; sz: number }> = [];
  const seen = new Set<string>();
  for (const h of homes) {
    const ci = Math.floor(h.gi / GRID.chunkBlocks), cj = Math.floor(h.gj / GRID.chunkBlocks);
    if (seen.has(`${ci},${cj}`)) continue;
    seen.add(`${ci},${cj}`);
    for (const st of districtPlan(ci, cj).structures) solid.push(...st.colliders);
  }
  const inSolid = (p: BitPerson) => solid.some((b) => Math.abs(p.x - b.x) < b.sx / 2 - 0.1 && Math.abs(p.z - b.z) < b.sz / 2 - 0.1 && Math.abs(p.y - b.y) < b.sy / 2);
  const inRoom = (p: BitPerson) => { const r = p.home.room; return !!r && p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1; };
  // Watch every birth: who the parents were, and what they had said.
  const births: Array<{ ok: boolean; why: string }> = [];
  const priv = pop as unknown as { birth: (a: BitPerson, b: BitPerson, t: number) => BitPerson | null; headcount: (h: unknown) => number };
  const birth = priv.birth.bind(pop);
  priv.birth = (a, b, t) => {
    const before = priv.headcount(a.home);
    const c = birth(a, b, t);
    if (c) {
      const why = a.home !== b.home ? 'parents of two lots' : !isGrown(a.age, a.life) || !isGrown(b.age, b.life) ? 'a parent not grown' : a.answer !== 'yes' || b.answer !== 'yes' ? 'not two YESes' : before >= a.home.capacity ? 'lot full' : '';
      births.push({ ok: !why, why });
    }
    return c;
  };
  let stuck = 0, astray = 0, overRoom = 0, overLot = 0, children = 0, childrenPlaced = true;
  const firstKids = new Set<number>();
  for (let i = 0; i < 720 * 5; i++) {
    pop.step(0.2, i * 0.2, C0);
    if (i % 5 !== 0) continue;
    for (const p of pop.people) {
      if (inSolid(p)) stuck++;
      if (p.place === 'inside' && !inRoom(p)) astray++;
      if (p.slot >= CHILD_SLOT && p.gen > 0 && !firstKids.has(p.id)) {
        firstKids.add(p.id);
        children++;
        if (!(p.place === 'kerb' || p.place === 'inside')) childrenPlaced = false;
      }
    }
    for (const h of pop.homes.values()) {
      let inside = 0, n = 0;
      for (const p of pop.people) if (p.home === h) { n++; if (p.place === 'inside') inside++; }
      if (inside > roomPlaces(h.capacity)) overRoom++;
      if (n > h.capacity) overLot++;
    }
  }
  const bad = births.filter((b) => !b.ok);
  check(births.length > 20 && bad.length === 0, 'two grown Bits of one lot who both said YES compile a child, only while the lot has room', `${births.length} births in 12 min${bad.length ? `; bad: ${bad.slice(0, 3).map((b) => b.why).join(', ')}` : ''}`);
  check(children > 10 && childrenPlaced, 'children appear beside their parents, on the kerb or in the room', `${children} children seen`);
  check(stuck === 0 && astray === 0, 'nobody (child or mover) is ever inside a wall or out of its room', `${stuck} in walls, ${astray} astray`);
  check(overRoom === 0 && overLot === 0, 'a room holds only so many, a lot no more than its capacity', `${overRoom} over a room, ${overLot} over a lot`);
  check(pop.deaths['old-age'] > 10 && pop.people.length <= BITS.max, 'Bits grow old and fade out', `${pop.deaths['old-age']} of age, ${pop.deaths.spent} ran dry, ${pop.moves} moved house`);
  const maxGen = Math.max(...pop.people.map((p) => p.gen));
  check(maxGen >= 2, 'generations follow one another', `generation ${maxGen} after 12 min at half lifespans`);
}

console.log('\n--- gene pools');
{
  const pop = new BitPopulation();
  pop.step(1 / 30, 0, C0);
  for (let i = 0; i < 600; i++) pop.step(0.2, i * 0.2, C0);
  const before = new Map(pop.people.filter((p) => p.place !== 'follow').map((p) => [`${p.home.key}:${p.slot}`, p]));
  const ages = new Map([...before].map(([k, p]) => [k, p.age]));
  // Far away (out of every lot's despawn range) for two minutes, then back.
  const far = { x: C0.x + 6000, z: C0.z };
  pop.step(0.2, 120, far);
  check(pop.pools.size > 5 && [...before.keys()].every((k) => pop.pools.get(Number(k.split(':')[0]))), 'a lot streaming out keeps its people as its gene pool', `${pop.pools.size} pools`);
  for (let i = 0; i < 600; i++) pop.step(0.2, 120 + i * 0.2, far);
  pop.step(0.2, 241, C0);
  const back = pop.people.filter((p) => before.has(`${p.home.key}:${p.slot}`));
  const sameGenes = back.every((p) => GENES.every((k) => p.genome[k] === before.get(`${p.home.key}:${p.slot}`)!.genome[k]));
  const older = back.every((p) => p.age >= ages.get(`${p.home.key}:${p.slot}`)! + 110);
  check(back.length > before.size * 0.5 && sameGenes && older, 'coming back finds the same people, older (the dead gone, children among them)', `${back.length} of ${before.size} still there, ${pop.people.length - back.length} new`);
  pop.reset();
  check(pop.people.length === 0 && pop.pools.size > 5, 'a world reset keeps the gene pools');
  pop.clearEvolution();
  check(pop.pools.size === 0, 'Reset evolution forgets them');

  const lots: StoredLot[] = [{ key: 1234, births: 17, capacity: 30, people: [] }];
  const rand = seededRand(3);
  for (let i = 0; i < 20; i++) lots[0].people.push({ genome: founderGenome(rand, rand(), 0.4), age: Math.round(rand() * 500), life: 600 + i, energy: rand(), gen: i % 5, slot: CHILD_SLOT + i, lineage: 99 + i, prestige: rand() });
  const round = decodePools(fromBase64(toBase64(encodePools(lots)))!);
  const r0 = round?.[0];
  const close = !!r0 && r0.key === 1234 && r0.births === 17 && r0.capacity === 30 && r0.people.every((p, i) => {
    const q = lots[0].people[i];
    return GENES.every((k) => Math.abs(p.genome[k] - q.genome[k]) <= 0.5 / 255 + 1e-9) && STYLE_FIELDS.every((f) => p.genome.style[f] === q.genome.style[f])
      && p.age === q.age && p.life === q.life && p.gen === q.gen && p.slot === q.slot && p.lineage === q.lineage;
  });
  check(close, 'the compact encoding round-trips (genes to a 255th, the rest exact)', `${encodePools(lots).length} bytes for 20 Bits`);
  check(decodePools(new Uint8Array([9, 1, 2])) === null && fromBase64('not base64!') === null, 'a bad encoding is refused');
  const run = () => {
    const l: StoredLot = JSON.parse(JSON.stringify(lots[0]));
    const out = advancePool(l, 3000, seededRand(11), undefined, Infinity);
    return { l, out };
  };
  const x = run(), y = run();
  check(JSON.stringify(x.l) === JSON.stringify(y.l) && x.out.births > 0 && x.l.people.length <= x.l.capacity, 'off-screen catch-up is deterministic, breeds and keeps to the lot\'s capacity', `${x.out.births} born, ${JSON.stringify(x.out.deaths)}, ${x.l.people.length}/${x.l.capacity}`);
}

console.log('\n--- the lab');
{
  const a = new EvolutionLab({ seed: 5, traffic: 1 }), b = new EvolutionLab({ seed: 5, traffic: 1 });
  a.run(600);
  b.run(600);
  check(JSON.stringify(a.history) === JSON.stringify(b.history), 'the same settings and seed give the same history');
  const seeds = [1, 2, 3, 4];
  const T = 12000;
  const end = (set: Partial<EvolutionLab['settings']>) => seeds.map((seed) => {
    const lab = new EvolutionLab({ seed, ...set });
    let over = false;
    while (lab.time < T) {
      lab.run(600);
      for (const h of lab.bits.homes.values()) if (lab.bits.people.filter((p) => p.home === h).length > h.capacity) over = true;
    }
    return { last: lab.history[lab.history.length - 1], first: lab.history[0], over };
  });
  const control = end({}), traffic = end({ traffic: 1 }), scarce = end({ scarcity: 1.8 });
  const boldC = mean(control.map((r) => r.last.mean.boldness)), boldT = mean(traffic.map((r) => r.last.mean.boldness));
  const paceC = mean(control.map((r) => r.last.mean.pace)), paceS = mean(scarce.map((r) => r.last.mean.pace));
  check(control.every((r) => r.last.count > r.first.count * 0.6) && ![...control, ...traffic, ...scarce].some((r) => r.over), 'populations hold up and never overfill their lots', control.map((r) => `${r.first.count}→${r.last.count}`).join(' '));
  check(control.every((r) => r.last.maxGen > 40), 'over 3 h of lab time Bits go through many generations', `${control.map((r) => r.last.maxGen).join(' ')} deep`);
  check(boldT < boldC - 0.1, 'kerb traffic breeds timid Bits', `boldness ${f2(boldT)} under traffic vs ${f2(boldC)} control (${traffic.map((r) => f2(r.last.mean.boldness)).join(' ')} vs ${control.map((r) => f2(r.last.mean.boldness)).join(' ')})`);
  check(paceS < paceC - 0.08, 'scarcity breeds slow walkers', `pace ${f2(paceS)} scarce vs ${f2(paceC)} control (${scarce.map((r) => f2(r.last.mean.pace)).join(' ')} vs ${control.map((r) => f2(r.last.mean.pace)).join(' ')})`);
}

console.log("\n--- the relay's world");
{
  let now = 0;
  const world = new World({ now: () => now });
  // Two games, joined to the relay in-process (the messages a NetClient would carry, carried at once).
  const join = (id: string, pop: BitPopulation): PoolSource => ({
    want: (keys) => { for (const r of world.want(id, keys)) pop.receive(r.key, r.pool ? decodePools(fromBase64(r.pool)!)![0] : null, r.holder); },
    push: (lot) => { if (!world.push(id, lot.key, toBase64(encodePools([lot])))) pop.receive(lot.key, null, false); },
    release: (keys) => world.release(id, keys),
    derez: (key, slot) => { const h = world.derez(id, key, slot); if (h === 'b') b.remoteDerez(key, slot); if (h === 'a') a.remoteDerez(key, slot); },
  });
  const a = new BitPopulation(), b = new BitPopulation();
  a.attach(join('a', a));
  b.attach(join('b', b));
  let t = 0;
  const run = (pop: BitPopulation, at: { x: number; z: number }, seconds: number) => { for (let i = 0; i < seconds * 5; i++) { t += 0.2; now += 200; pop.step(0.2, t, at); } };
  run(a, C0, 120);
  const heldA = [...a.homes.keys()].filter((k) => a.holds(k));
  check(a.people.length > 20 && heldA.length === a.homes.size && world.lots.size === a.homes.size, 'the first game into a district holds its lots and registers them with the relay', `${heldA.length} lots, ${a.people.length} Bits`);
  // b arrives: it sees a's lots but does not hold them.
  run(b, C0, 10);
  check(b.homes.size > 0 && [...b.homes.keys()].every((k) => !b.holds(k)), 'a second game there draws the lots but does not hold them');
  const sameKeys = [...b.homes.keys()].filter((k) => a.homes.has(k));
  const slotsA = new Set(a.people.filter((p) => sameKeys.includes(p.home.key)).map((p) => `${p.home.key}:${p.slot}`));
  const shared = b.people.filter((p) => slotsA.has(`${p.home.key}:${p.slot}`)).length;
  check(shared > b.people.length * 0.6, 'it streams in the same people the holder has', `${shared} of ${b.people.length}`);
  // b runs one of a's Bits over (a blast): it leaves a's game too.
  const victim = b.people.find((p) => a.people.some((q) => q.home.key === p.home.key && q.slot === p.slot && q.place !== 'follow'))!;
  const key = victim.home.key, slot = victim.slot;
  b.strike(victim.x, victim.y, victim.z, 0.1, t);
  check(!a.people.some((q) => q.home.key === key && q.slot === slot), 'a Bit killed in the other game leaves the holder\'s');
  // Both leave; an hour passes on the relay alone.
  const far = { x: C0.x + 6000, z: C0.z };
  run(a, far, 1);
  run(b, far, 1);
  const before = world.stats();
  for (let i = 0; i < 360; i++) { now += 10_000; world.tick(); }
  const after = world.stats();
  check(after.held === 0 && after.births > before.births && after.maxGen > before.maxGen, 'lots nobody is near live on in the relay', `births ${before.births} → ${after.births}, deepest generation ${before.maxGen} → ${after.maxGen}`);
  // b comes back: it finds the relay's people, not its own memory of them.
  run(b, C0, 5);
  const fromRelay = [...b.homes.keys()].filter((k) => world.lots.has(k));
  const gens = Math.max(...b.people.map((p) => p.gen));
  check(fromRelay.length > 0 && gens >= after.maxGen - 2 && fromRelay.every((k) => b.holds(k)), 'coming back, a game finds the lots as the relay kept them, and holds them now', `deepest generation in view ${gens}`);
}

console.log('\n--- what a Bit says');
{
  let kept = true;
  for (const light of BIT_STYLE_CHOICES.light) for (const idle of BIT_STYLE_CHOICES.idle) {
    const style = { light: light[0], size: 'large', idle: idle[0], spin: 'lively' } as const;
    if (styledState('yes', style) !== 'yes' || styledState('no', style) !== 'no') kept = false;
  }
  check(kept && BIT_LOOK.yes.color === '#ffd21a' && BIT_LOOK.no.color === '#ff2a12', 'YES stays the yellow octahedron and NO the red stellation, whatever a Bit inherits');
}

console.log(failures ? `\n${failures} FAILED` : '\nAll evolution checks passed');
process.exit(failures ? 1 : 0);
