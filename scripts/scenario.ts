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
 * 7. The escort squad and the supply drone: the squad keeps its order until the escorted vehicle
 *    arrives and gets it through faster; the drone delivers in calm and windy air, crabs into a
 *    crosswind, and diverts when the clinic's pad is busy; the networks match the scripted
 *    leader and pilot within a margin.
 */
import { DRIVE_ACTIONS, drivePolicy, loadDriveWeights, respondPolicy } from '../src/scenario/policies.ts';
import { loadSquadWeights, squadPolicy } from '../src/scenario/escort.ts';
import { flightPolicy, landingPolicy, loadDroneWeights } from '../src/scenario/drone.ts';
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

console.log('\n--- the escort squad and the supply drone');
{
  const sq = loadSquadWeights(), dr = loadDroneWeights();
  check(sq && dr.flight && dr.landing, 'the shipped squad and drone weights fit their policies', `squad ${squadPolicy.sizes.join('-')}, flight ${flightPolicy.sizes.join('-')}, landing ${landingPolicy.sizes.join('-')}`);
  // The same vehicle with and without the escort, on the same seeds: its trip (route set to arrival) and its hold-ups.
  const tripOf = (s: Scenario, id: number) => {
    const log = s.vehicles[id].log, from = log.find((l) => l.kind === 'route'), to = log.find((l) => l.kind === 'arrive');
    return from && to ? to.t - from.t : Infinity;
  };
  const holdsOf = (s: Scenario, id: number) => s.vehicles[id].log.filter((l) => l.text.startsWith('held up')).length;
  for (const driver of ['scripted', 'net'] as const) {
    for (const escortAuto of ['convoy', 'truck'] as const) {
      const esc = [1, 2, 3, 4, 5, 6].map((seed) => run({ seed, driver, escortAuto }));
      const none = [1, 2, 3, 4, 5, 6].map((seed) => run({ seed, driver, escortAuto: 'none' }));
      const ids = esc.map((s) => s.metrics().escort.target!);
      const kept = esc.every((s) => s.metrics().escort.done && s.squad.log.filter((l) => l.text.startsWith('ordered')).length === 1);
      const tE = mean(esc.map((s, i) => tripOf(s, ids[i]))), tA = mean(none.map((s, i) => tripOf(s, ids[i])));
      const hE = esc.reduce((n, s, i) => n + holdsOf(s, ids[i]), 0), hA = none.reduce((n, s, i) => n + holdsOf(s, ids[i]), 0);
      const what = escortAuto === 'convoy' ? "the convoy's lead" : 'the first truck after the closure';
      check(kept, `${driver}: the squad keeps its order to escort ${what} until it arrives`);
      check(hE < hA && tE < tA, `${driver}: escorted, ${what} is held up less and gets through faster`, `${f0(tE)} s escorted vs ${f0(tA)} s alone; held up ${hE} vs ${hA} times in six runs`);
    }
  }
  const fly = (driver: 'scripted' | 'net', wind: number, seed: number) => { const s = new Scenario({ seed, driver, droneAt: 300, wind }); s.run(500); return s; };
  for (const driver of ['scripted', 'net'] as const) {
    const flights = [0, 6, 10].flatMap((wind) => [1, 2].map((seed) => fly(driver, wind, seed)));
    check(flights.every((s) => s.drone.state === 'delivered'), `${driver}: the drone delivers in calm air and in wind up to 10 m/s`, flights.map((s) => `${f0(s.metrics().drone.flightTime ?? NaN)} s`).join(' '));
    const calm = flights[0], windy = flights[2];
    check(calm.drone.decisions.crabLeft + calm.drone.decisions.crabRight === 0 && windy.drone.decisions.crabLeft + windy.drone.decisions.crabRight > 0, `${driver}: it flies straight in calm air and crabs into a crosswind`);
    const busy = new Scenario({ seed: 1, driver, droneAt: 125, wind: 6 });
    busy.drone.battery = 160;
    busy.run(400);
    check(busy.drone.state === 'diverted', `${driver}: the clinic's pad busy and holding costly, it diverts to the shelter`, busy.drone.log.map((l) => l.text).join(' → '));
  }
  const tS = mean([0, 6, 10].map((w) => fly('scripted', w, 1).metrics().drone.flightTime ?? Infinity));
  const tN = mean([0, 6, 10].map((w) => fly('net', w, 1).metrics().drone.flightTime ?? Infinity));
  check(tN <= tS * 1.25 + 5, 'the flight network is no slower than the scripted pilot (within 25%)', `${f0(tN)} s vs ${f0(tS)} s`);
}

console.log(failures ? `\n${failures} FAILED` : '\nAll scenario checks passed');
process.exit(failures ? 1 : 0);
