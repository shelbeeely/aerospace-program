/**
 * Road network and ground autopilot checks (headless, real simulation): every road on one
 * network, every flight-computer destination reachable by road, ground vehicles spawning on a
 * road (never an airstrip), and the flight computer driving ground vehicles to destinations.
 * Run with `npm run drive`.
 */
import { LIGHT_CAR } from '../src/craft/lightCar.ts';
import { LIGHT_CYCLE } from '../src/craft/lightCycle.ts';
import { LIGHT_RUNNER } from '../src/craft/outlands.ts';
import type { CraftDef } from '../src/craft/types.ts';
import type { ControlInputs, ControlSource } from '../src/sim/controls.ts';
import { FlightAutopilot } from '../src/sim/flightAutopilot.ts';
import { distance, destinations } from '../src/sim/nav.ts';
import { RUNWAYS, runwayFrame } from '../src/sim/layout.ts';
import { findRoute, roadOpen } from '../src/sim/roads.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { blockSummary, roadStats } from '../src/world/planetCity.ts';

await initPhysics();
let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}

// --- One network
blockSummary();
check(!!roadStats && roadStats.removed <= roadStats.components * 0.05, 'road islands are linked into one network', JSON.stringify(roadStats));
{
  // Flood from the network's biggest component: every road segment must be reached.
  const N = 370;
  const seen = new Uint8Array(N * N);
  const mod = (v: number) => ((v % N) + N) % N;
  let start = -1;
  for (let k = 0; k < N * N && start < 0; k++) if (roadOpen(true, Math.floor(k / N), k % N)) start = k;
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const c = stack.pop()!;
    const i = Math.floor(c / N), j = c % N;
    for (const [di, dj, ax, si, sj] of [[1, 0, true, i, j], [-1, 0, true, i - 1, j], [0, 1, false, i, j], [0, -1, false, i, j - 1]] as const) {
      if (!roadOpen(ax, si, sj)) continue;
      const nk = mod(i + di) * N + mod(j + dj);
      if (!seen[nk]) { seen[nk] = 1; stack.push(nk); }
    }
  }
  let orphan = 0, total = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (const ax of [true, false]) {
    if (!roadOpen(ax, i, j)) continue;
    total++;
    if (!seen[i * N + j]) orphan++;
  }
  check(orphan === 0, 'every road segment is on the one network', `${total} segments, ${orphan} orphaned`);
}

// --- Every destination by road
{
  const from = { x: 253, z: 206 };
  const t0 = performance.now();
  const bad = destinations().filter((d) => !findRoute(from.x, from.z, d.x, d.z)).map((d) => d.name);
  check(bad.length === 0, 'every flight-computer destination is reachable by road', bad.length ? bad.join(', ') : `${destinations().length} destinations, ${((performance.now() - t0) / destinations().length).toFixed(0)} ms per route`);
}

// --- Ground vehicles start on a road, not an airstrip
for (const def of [LIGHT_CAR, LIGHT_CYCLE, LIGHT_RUNNER] as CraftDef[]) {
  const sim = new Simulation(def);
  const p = sim.position;
  const onStrip = RUNWAYS.some((r) => { const a = runwayFrame(r, p.x, p.z); return Math.abs(a.across) < r.width / 2 + 20 && Math.abs(a.along) < r.length / 2 + 60; });
  check(!onStrip, `${def.name} spawns off the airstrips`, `${p.x.toFixed(0)}, ${p.z.toFixed(0)}`);
}

// --- The flight computer drives to destinations
class Idle implements ControlSource {
  throttle = 0;
  sample(): ControlInputs { return { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 }; }
}
function drive(def: CraftDef, destId: string, limit: number): { arrived: boolean; dist: number; time: number; route: number; maxOff: number } {
  const sim = new Simulation(def);
  sim.traffic.enabled = false;
  for (let i = 0; i < 120; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  const ap = new FlightAutopilot(new Idle());
  let t = sim.telemetry();
  ap.engage(t, 'ground', undefined, { mode: 'goto', destination: destId, speed: 22 });
  const route = ap.driver.length;
  const d = destinations().find((x) => x.id === destId)!;
  let maxOff = 0;
  for (let i = 0; i < limit * 120 && ap.state.phase !== 'arrived'; i++) {
    sim.step(ap.sample(sim.dt, t));
    t = sim.telemetry();
    if (i % 60 === 0) { const st = ap.driver.drive(0, t, 22).status; maxOff = Math.max(maxOff, st.offPath); }
    if (!ap.state.engaged) break;
  }
  return { arrived: ap.state.phase === 'arrived', dist: distance(t.position[0], t.position[2], d.x, d.z), time: t.time, route, maxOff };
}
for (const [def, dest] of [[LIGHT_CAR, 'pad-apron'], [LIGHT_CAR, 'spire'], [LIGHT_CYCLE, 'pad-town']] as Array<[CraftDef, string]>) {
  const r = drive(def, dest, 900);
  check(r.arrived && r.dist < 450, `the flight computer drives the ${def.name} to ${dest}`, `${(r.route / 1000).toFixed(1)} km route, arrived ${r.arrived} in ${r.time.toFixed(0)} s, ${r.dist.toFixed(0)} m from the site, max ${r.maxOff.toFixed(1)} m off path`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll road checks passed');
process.exit(failures ? 1 : 0);
