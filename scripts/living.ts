/**
 * The living world, headless. Run with `npm run living`.
 *
 * 1. Sixty days with nobody playing, reported week by week: blocks built per faction, prosperity,
 *    treasuries, trade, treaties, stances, captures, convoys lost, migrants.
 * 2. Deterministic: the same seed and time give the same world.
 * 3. Catching up equals living through it: a week at once is the same as tick by tick (and a
 *    snapshot taken mid-way, round-tripped through JSON, carries on identically).
 * 4. Growth only where it may: every developed block was open or plain, in a district of the
 *    faction that built it when it began, next to a built block; and no faction past its cap.
 *    A few blocks a day per faction.
 * 5. The books balance: goods made = goods in stock + in transit + consumed + used in building
 *    + lost on the road; credits = the start + taxes - building.
 * 6. Wars are rare: over three seasons on four seeds, wars start, but seldom.
 * 7. "While you were away" is built from the log.
 */
import { advance, digest, LIVING, LivingIndex, newLiving } from '../src/living/advance.ts';
import { baseMap, livingPitch, livingRegions } from '../src/living/baseMap.ts';
import { SEASON_EPOCH } from '../src/brain/season.ts';
import { FACTION_NAME, FACTIONS, GOODS, pairKey, type LivingState } from '../src/living/state.ts';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const DAY = 86_400_000;
const map = baseMap(), regions = livingRegions(), pitch = livingPitch();
const start = SEASON_EPOCH;
const fresh = (seed: number) => newLiving(map, regions, pitch, seed, start);
const go = (s: LivingState, to: number) => advance(s, to, map, regions, pitch);
const clone = (s: LivingState): LivingState => JSON.parse(JSON.stringify(s));

console.log('--- sixty days with nobody playing');
const t0 = Date.now();
const world = fresh(1);
const weekly: string[] = [];
for (let w = 1; w <= 8; w++) {
  go(world, start + Math.min(60, w * 7) * DAY);
  const built = FACTIONS.map((f) => world.factions[f].built);
  const rel = ['01', '02', '12'].map((k) => `${k}:${world.relations[k].stance}/${world.relations[k].treaty}/${world.relations[k].trust.toFixed(2)}`).join(' ');
  weekly.push(`  day ${Math.min(60, w * 7)}: built ${built.join('/')} sites ${world.sites.length} prosperity ${FACTIONS.map((f) => world.factions[f].prosperity.toFixed(2)).join('/')} treasury ${FACTIONS.map((f) => world.factions[f].treasury.toFixed(0)).join('/')} convoys ${world.convoys.length} ${rel}`);
}
const ms = Date.now() - t0;
for (const l of weekly) console.log(l);
console.log(`  (${(60 / (ms / 1000)).toFixed(0)} days a second; ${world.tick} ticks)`);
const perDay = FACTIONS.map((f) => world.factions[f].built / 60);
check(perDay.every((d) => d >= 1 && d <= 6), 'each faction builds a few blocks a day', perDay.map((d, f) => `${FACTION_NAME[f]} ${d.toFixed(1)}`).join(', '));
const traded = world.log.filter((e) => e.kind === 'trade').length;
check(traded > 0, 'the factions trade', `${traded} days of trade logged; ${world.migrants.flat().reduce((a, b) => a + b, 0)} Bits moved house`);

console.log('\n--- determinism and catching up');
{
  const a = fresh(7), b = fresh(7);
  go(a, start + 7 * DAY); go(b, start + 7 * DAY);
  check(JSON.stringify(a) === JSON.stringify(b), 'the same seed and time give the same world');
  const c = fresh(7);
  for (let t = start; t < start + 7 * DAY; t += 3 * 3_600_000 + 17_000) go(c, t);
  go(c, start + 7 * DAY);
  check(JSON.stringify(a) === JSON.stringify(c), 'a week at once equals living through it in small steps');
  const d = fresh(7);
  go(d, start + 3 * DAY);
  const e = clone(d);
  go(d, start + 7 * DAY); go(e, start + 7 * DAY);
  check(JSON.stringify(d) === JSON.stringify(a) && JSON.stringify(e) === JSON.stringify(a), 'a snapshot mid-way, through JSON, carries on identically');
}

console.log('\n--- growth only where it may');
{
  const s = fresh(3);
  // Watch what each block was when it was begun.
  const begun = new Map<number, { f: number; owner: number; adjacent: boolean; kind: number }>();
  const idx0 = () => new LivingIndex(map, regions, pitch, s);
  for (let day = 1; day <= 30; day++) {
    const before = new Set(s.sites.map((x) => x.b));
    const idx = idx0();
    go(s, start + day * DAY);
    for (const site of s.sites) if (!before.has(site.b) && !begun.has(site.b)) begun.set(site.b, { f: site.f, owner: idx.owner[idx.chunkOf(site.b)], adjacent: true, kind: map.kind[site.b] });
  }
  const devBlocks = s.developed.map(([b]) => b);
  const okKind = devBlocks.every((b) => map.kind[b] === 128 || map.kind[b] === 32);
  const unique = new Set(devBlocks).size === devBlocks.length;
  const idx = idx0();
  const adjacent = devBlocks.every((b) => idx.neighbours(b).some((nb) => map.kind[nb] === 0 || idx.developed.has(nb)));
  const owned = [...begun.values()].every((x) => x.owner === x.f);
  const caps = FACTIONS.every((f) => s.factions[f].built <= s.factions[f].cap);
  check(okKind && unique && adjacent && owned && caps, 'only open or plain blocks, in the builder\'s own district, next to built ones, within caps',
    `${devBlocks.length} blocks; caps ${FACTIONS.map((f) => `${s.factions[f].built}/${s.factions[f].cap}`).join(', ')}`);
}

console.log('\n--- the books balance');
{
  const s = world;
  const transit = Object.fromEntries(GOODS.map((g) => [g, s.convoys.filter((c) => c.good === g).reduce((a, c) => a + c.amount, 0)]));
  const startStock = fresh(1).factions;
  let worst = 0;
  for (const g of GOODS) {
    const have = FACTIONS.reduce<number>((sum, f) => sum + s.factions[f].stock[g], 0) + transit[g] + s.totals.consumed[g] + s.totals.built[g] + s.totals.lost[g];
    const had = FACTIONS.reduce<number>((sum, f) => sum + startStock[f].stock[g], 0) + s.totals.produced[g];
    worst = Math.max(worst, Math.abs(have - had) / Math.max(1, had));
  }
  const credits = FACTIONS.reduce<number>((sum, f) => sum + s.factions[f].treasury, 0);
  const expected = FACTIONS.reduce<number>((sum, f) => sum + startStock[f].treasury, 0) + s.totals.taxed - s.totals.spent;
  check(worst < 1e-9, 'goods made = in stock + in transit + consumed + used in building + lost', `worst drift ${worst.toExponential(1)}`);
  check(Math.abs(credits - expected) < 1e-6 * Math.max(1, expected), 'credits = the start + taxes - building', `${credits.toFixed(0)} vs ${expected.toFixed(0)}`);
}

console.log('\n--- wars are rare');
{
  // Stepping a day at a time and watching each pair's stance (a war lasts days).
  let wars = 0, seasons = 0;
  const examples: string[] = [];
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const s = fresh(seed);
    const prev: Record<string, string> = { '01': 'peace', '02': 'peace', '12': 'peace' };
    for (let d = 1; d <= 84; d++) {
      go(s, start + d * DAY);
      for (const k of ['01', '02', '12']) {
        if (s.relations[k].stance === 'war' && prev[k] !== 'war') { wars++; if (examples.length < 2) examples.push(`seed ${seed} day ${d}: ${FACTION_NAME[Number(k[0])]}–${FACTION_NAME[Number(k[1])]}`); }
        prev[k] = s.relations[k].stance;
      }
    }
    seasons += 3;
  }
  const rate = wars / seasons;
  check(wars >= 1 && rate <= 1, 'wars do start, but seldom (at most about one a season)', `${wars} wars in ${seasons} seasons${examples.length ? `: ${examples.join('; ')}` : ''}`);
}

console.log('\n--- while you were away');
{
  const lines = digest(world, start + 53 * DAY);
  check(lines.length >= 2, 'the last week, from the log', lines.join(' | '));
  const rel = world.relations[pairKey(0, 1)];
  void rel;
}

void LIVING;
console.log(failures ? `\n${failures} FAILED` : '\nAll living checks passed');
if (failures) process.exit(1);
