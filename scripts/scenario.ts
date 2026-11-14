/**
 * The Scenario Lab: one district, two crossings, an evacuation and a closure. Run with
 * `npm run scenario`.
 *
 * 1. Deterministic: the same settings give the same metrics and the same logs.
 * 2. Safe whoever drives: no collisions for the scripted driver or the networks; nobody enters a
 *    closed crossing; those who learn of the closure on their way reroute.
 * 3. The networks against the scripted driver on the same seeds (a table): delivery lateness,
 *    ambulance response, mean delay, longest queue, clinic shortage. The networks may not be
 *    worse than the baseline by more than a stated margin.
 * 4. One simulation at two levels of detail: everyone in full and everyone by edges agree on
 *    delivery times within a tolerance; a shipment that never arrives causes a shortage in both.
 * 5. Policies switch with the job (an ambulance: respond on a call, drive afterwards); the
 *    shipped weights fit the policies; a delayed vehicle's story comes from its recorded events.
 * 6. The design test: the same encounter on a different street network plays out differently
 *    (a backup crossing, a depot on the clinic's bank).
 */
import { DRIVE_ACTIONS, drivePolicy, loadDriveWeights, respondPolicy } from '../src/scenario/policies.ts';
import { Scenario, summary, type ScenarioSettings } from '../src/scenario/scenario.ts';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const run = (s: Partial<ScenarioSettings>) => { const sc = new Scenario(s); sc.run(); return sc; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : '-');

console.log('--- determinism');
{
  const a = run({ seed: 3 }), b = run({ seed: 3 });
  const logs = (s: Scenario) => s.vehicles.map((v) => v.log.map((e) => `${e.t}:${e.text}`).join('|')).join('\n');
  check(JSON.stringify(a.metrics()) === JSON.stringify(b.metrics()) && logs(a) === logs(b), 'the same settings give the same run, metrics and logs');
}

console.log('\n--- safety and closures');
const SEEDS = [1, 2, 3];
const weights = loadDriveWeights();
check(weights.drive && weights.respond, 'the shipped weights fit the policies (inputs and actions)', `drive ${drivePolicy.sizes.join('-')}, respond ${respondPolicy.sizes.join('-')}`);
const scripted = SEEDS.map((seed) => run({ seed, driver: 'scripted' }));
const net = SEEDS.map((seed) => run({ seed, driver: 'net' }));
{
  const all = [...scripted, ...net];
  check(all.every((s) => s.metrics().collisions === 0), 'no collisions, whoever drives', all.map((s) => s.metrics().collisions).join(' '));
  check(all.every((s) => s.metrics().closedEntries === 0), 'nobody enters a closed crossing');
  // Everyone who learned of the closure while still to cross it took another way.
  let learned = 0, rerouted = 0;
  for (const s of all) for (const v of s.vehicles) {
    const i = v.log.findIndex((e) => e.kind === 'closure');
    if (i < 0) continue;
    learned++;
    if (v.log.slice(i + 1).some((e) => e.kind === 'reroute' || e.kind === 'route' || e.kind === 'arrive')) rerouted++;
  }
  check(learned > 10 && rerouted / learned > 0.95, 'those who learn of the closure on their way take another way', `${rerouted} of ${learned}`);
  // Two minutes into the closure: someone it caught out says why it is late, from its own records.
  const mid = new Scenario({ seed: 1 });
  mid.run(200);
  const story = mid.vehicles.find((v) => v.kind !== 'car' && /closed/.test(mid.explain(v.id)) && /rerouted/.test(mid.explain(v.id)));
  const text = story ? mid.explain(story.id) : '';
  check(!!story && /closed/.test(text) && /rerouted/.test(text), 'a delayed vehicle\'s story comes from its recorded events', text);
}

console.log('\n--- the networks against the scripted driver (North Bridge closes at 1:30)');
{
  const rows = (runs: Scenario[]) => runs.map((s) => summary(s.metrics()));
  const sr = rows(scripted), nr = rows(net);
  const avg = (r: ReturnType<typeof rows>, k: keyof ReturnType<typeof rows>[number]) => mean(r.map((x) => x[k] as number).filter(Number.isFinite));
  const keys = ['delivery', 'response', 'delay', 'queue', 'shortage', 'evacuated', 'convoy'] as const;
  console.log(`  ${'measure'.padEnd(26)}${'scripted'.padStart(10)}${'network'.padStart(10)}`);
  const label: Record<string, string> = { delivery: 'delivery lateness (s)', response: 'ambulance response (s)', delay: 'mean trip delay (s)', queue: 'longest queue', shortage: 'clinic short of stock (s)', evacuated: 'last evacuee in (s)', convoy: 'convoy through (s)' };
  for (const k of keys) console.log(`  ${label[k].padEnd(26)}${f0(avg(sr, k)).padStart(10)}${f0(avg(nr, k)).padStart(10)}`);
  const decisions = (runs: Scenario[]) => DRIVE_ACTIONS.map((a) => `${a} ${runs.reduce((n, s) => n + s.metrics().decisions[a], 0)}`).join(', ');
  console.log(`  decisions, scripted: ${decisions(scripted)}`);
  console.log(`  decisions, network:  ${decisions(net)}`);
  const within = (k: (typeof keys)[number], rel: number, abs: number) => avg(nr, k) <= avg(sr, k) * (1 + rel) + abs;
  check(within('delivery', 0.25, 10) && within('response', 0.25, 10) && within('delay', 0.25, 5) && within('shortage', 0.25, 30), 'the networks are no worse than the scripted driver (within 25%)');
}

console.log('\n--- levels of detail');
{
  const det = SEEDS.map((seed) => summary(run({ seed, lod: 'detail' }).metrics()));
  const agg = SEEDS.map((seed) => summary(run({ seed, lod: 'agg' }).metrics()));
  const d = mean(det.map((x) => x.delivery)), g = mean(agg.map((x) => x.delivery));
  check(Math.abs(d - g) <= 0.4 * Math.max(d, g) + 15, 'everyone in full and everyone by edges agree on delivery times', `lateness ${f0(d)} s in full, ${f0(g)} s by edges`);
  // Both crossings shut: no freight reaches the clinic, at either level of detail.
  const cut = (lod: 'detail' | 'agg') => {
    const sc = new Scenario({ seed: 1, lod, closeAt: null });
    sc.close('North Bridge');
    sc.close('South Bridge');
    sc.run();
    return sc.metrics();
  };
  const md = cut('detail'), ma = cut('agg');
  check(md.shortage > 0 && ma.shortage > 0 && md.deliveries.every((x) => x.arrived === null) && ma.deliveries.every((x) => x.arrived === null), 'a shipment that never arrives causes a shortage at either level of detail', `short ${f0(md.shortage)} s in full, ${f0(ma.shortage)} s by edges`);
}

console.log('\n--- jobs and policies');
{
  const amb = scripted[0].vehicles.find((v) => v.kind === 'ambulance' && v.log.some((e) => e.text.startsWith('respond policy')) && v.log.some((e) => e.text.startsWith('drive policy')));
  check(!!amb, 'an ambulance drives by the respond policy on a call and the drive policy after', amb ? amb.log.filter((e) => e.kind === 'policy').slice(0, 3).map((e) => e.text).join(' → ') : '');
}

console.log('\n--- the design test: the same encounter on another street network');
{
  const by = (layout: ScenarioSettings['layout']) => SEEDS.map((seed) => summary(run({ seed, layout }).metrics()));
  const base = by('base'), backup = by('backup'), depot = by('depotEast'), lane = by('emergencyLane');
  const row = (name: string, r: typeof base) => console.log(`  ${name.padEnd(30)} evacuation ${f0(mean(r.map((x) => x.evacuated))).padStart(4)} s · delay ${f0(mean(r.map((x) => x.delay))).padStart(3)} s · response ${f0(mean(r.map((x) => x.response))).padStart(4)} s · clinic short ${f0(mean(r.map((x) => x.shortage))).padStart(4)} s`);
  row('two crossings', base);
  row('backup crossing (north)', backup);
  row('emergency lane, Market Road', lane);
  row('depot on the clinic bank', depot);
  check(mean(backup.map((x) => x.evacuated)) < mean(base.map((x) => x.evacuated)) - 30 && mean(backup.map((x) => x.delay)) < mean(base.map((x) => x.delay)), 'a backup crossing speeds the evacuation and cuts the delay');
  check(mean(depot.map((x) => x.shortage)) < mean(base.map((x) => x.shortage)) * 0.5, 'a depot on the clinic\'s bank keeps the clinic supplied through the closure');
}

console.log(failures ? `\n${failures} FAILED` : '\nAll scenario checks passed');
process.exit(failures ? 1 : 0);
