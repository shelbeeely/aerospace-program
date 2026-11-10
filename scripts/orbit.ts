/**
 * Headless orbit test: the flight computer's "To orbit" mode flies the Orbiter from the runway
 * to a stable orbit (periapsis above the atmosphere) without any part failing. `npm run orbit`.
 */
import { ORBITER } from '../src/craft/orbiter.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { FlightAutopilot } from '../src/sim/flightAutopilot.ts';
import { analyzeDesign } from '../src/sim/flightTest.ts';

await initPhysics();
const sim = new Simulation(ORBITER);
sim.traffic.enabled = false;
const ap = new FlightAutopilot({ sample: () => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 }) } as never);
let t = sim.telemetry();
ap.engage(t, 'airplane', { stallSpeed: analyzeDesign(sim).stallSpeed }, { mode: 'ascent', altitude: 30000 });
let last = '';
let orbitAt = -1;
for (let i = 0; i < 120 * 900 && !sim.exploded; i++) {
  sim.step(ap.sample(sim.dt, t));
  t = sim.telemetry();
  if (ap.state.phase !== last) {
    last = ap.state.phase;
    console.log(`t=${t.time.toFixed(0)} s ${ap.state.phase}: alt ${(t.altitude / 1000).toFixed(1)} km, ${t.groundSpeed.toFixed(0)} m/s, Ap ${t.orbit?.apoapsis?.toFixed(0)} Pe ${t.orbit?.periapsis?.toFixed(0)}`);
  }
  if (ap.state.phase === 'orbiting' && orbitAt < 0) orbitAt = t.time;
  if (orbitAt > 0 && t.time > orbitAt + 60) break; // a minute in orbit
}
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};
check(orbitAt > 0, 'the flight computer reaches orbit', ap.state.status);
check((t.orbit?.periapsis ?? 0) > 20000, 'periapsis clear of the atmosphere', `Pe ${(t.orbit?.periapsis ?? 0).toFixed(0)} m`);
check(!sim.exploded && sim.failures.length === 0, 'no part fails on the way up', sim.failures.map((f) => `${f.partId} ${f.load}/${f.strength}`).join(', '));
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
