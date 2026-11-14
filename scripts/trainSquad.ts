/**
 * Train the escort squad's and the supply drone's policies. Run with `npm run train-squad`.
 *
 * As for driving (scripts/trainDrive.ts): record the scripted leader and pilot in the Scenario
 * Lab (escorts of the convoy and of freight, drone flights in calm and windy air, with the
 * clinic's pad busy now and then), add generated hard cases, train each network by imitation
 * and report how often it agrees with the teacher on held-out decisions. Writes
 * src/brain/weights/squad.json and src/brain/weights/drone.json, deterministically.
 */
import { writeFileSync } from 'node:fs';
import { accuracy, argmax, createNet, forward, toJSON, train, type Example } from '../src/brain/net.ts';
import { seededRand } from '../src/people/genome.ts';
import { scriptedSquad, SQUAD_ACTIONS, squadPolicy, type SquadObs } from '../src/scenario/escort.ts';
import { FLIGHT_ACTIONS, flightPolicy, LAND_ACTIONS, landingPolicy, scriptedFlight, scriptedLanding, type FlightObs, type LandObs } from '../src/scenario/drone.ts';
import { Scenario } from '../src/scenario/scenario.ts';

const SEED = 20261115;
const rand = seededRand(SEED);
const data: Record<'squad' | 'flight' | 'landing', Example[]> = { squad: [], flight: [], landing: [] };
let runs = 0;
for (const seed of [1, 2, 3, 4, 5]) for (const escortAuto of ['convoy', 'truck'] as const) for (const wind of [0, 5, 9]) {
  const sc = new Scenario({ seed, escortAuto, wind, droneAt: 100 + seed * 20, commuters: 60, evacuees: 70 });
  sc.brainLog = [];
  sc.run(700);
  for (const r of sc.brainLog) data[r.policy].push({ x: r.x, y: r.y });
  runs++;
}

// Hard cases, labelled by the teachers.
for (let i = 0; i < 5000; i++) {
  const sq: SquadObs = {
    dist: rand() * 200, targetSpeed: rand() * 16, spread: rand() < 0.3 ? 30 + rand() * 60 : rand() * 30,
    threatAhead: rand() < 0.35 ? 1 : 0, threatNear: rand() < 0.4 ? rand() : 0, units: 1 + Math.floor(rand() * 4), urgency: rand(), queueAhead: Math.floor(rand() * 10),
  };
  data.squad.push({ x: squadPolicy.encode(sq), y: SQUAD_ACTIONS.indexOf(scriptedSquad(sq)) });
  const fl: FlightObs = { bearingErr: (rand() - 0.5) * 1.2, dist: rand() * 600, last: rand() < 0.5 ? 1 : 0, cross: (rand() - 0.5) * 16, head: (rand() - 0.5) * 16, speed: 5 + rand() * 20, battery: rand() };
  data.flight.push({ x: flightPolicy.encode(fl), y: FLIGHT_ACTIONS.indexOf(scriptedFlight(fl)) });
  const ld: LandObs = { padBusy: rand() < 0.6 ? 1 : 0, battery: rand(), dist: rand() * 25, wind: rand() * 12, altDist: 300 + rand() * 900, held: rand() < 0.4 ? rand() * 80 : 0 };
  data.landing.push({ x: landingPolicy.encode(ld), y: LAND_ACTIONS.indexOf(scriptedLanding(ld)) });
}

const out: Record<string, ReturnType<typeof toJSON>> = {};
for (const [pol, actions] of [[squadPolicy, SQUAD_ACTIONS], [flightPolicy, FLIGHT_ACTIONS], [landingPolicy, LAND_ACTIONS]] as const) {
  const ex = data[pol.id as 'squad' | 'flight' | 'landing'].slice();
  for (let i = ex.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [ex[i], ex[j]] = [ex[j], ex[i]]; }
  const cut = Math.floor(ex.length * 0.85);
  const trainSet = ex.slice(0, cut).slice(0, 60000), test = ex.slice(cut);
  const net = createNet(pol.sizes, rand);
  const fit = train(net, trainSet, { epochs: 40, lr: 0.02, rand });
  const per = (actions as readonly string[]).map((a, k) => {
    const of = test.filter((e) => e.y === k);
    return `${a} ${of.length ? Math.round((of.filter((e) => argmax(forward(net, e.x)) === k).length / of.length) * 100) : '-'}% of ${of.length}`;
  }).join(', ');
  console.log(`${pol.id}: ${ex.length} examples; agrees with the teacher on ${(accuracy(net, test) * 100).toFixed(1)}% held out (${per}); train loss ${fit.loss.toFixed(3)}`);
  out[pol.id] = toJSON(net);
}
const note = { seed: SEED, runs, note: 'npm run train-squad regenerates this file; scripted leader and pilot = teachers (src/scenario/escort.ts, drone.ts)' };
writeFileSync('src/brain/weights/squad.json', JSON.stringify({ trained: note, squad: out.squad }) + '\n');
writeFileSync('src/brain/weights/drone.json', JSON.stringify({ trained: note, flight: out.flight, landing: out.landing }) + '\n');
console.log(`${runs} scenario runs recorded; wrote src/brain/weights/squad.json and drone.json`);
