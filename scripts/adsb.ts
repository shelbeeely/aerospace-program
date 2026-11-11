/**
 * ADS-B and the strike globe's geometry, headless. Run with `npm run adsb`.
 *
 * 1. Callsigns are unique, and stable across steps and between two runs with the same seed.
 * 2. Ground speed, track and vertical rate match each aircraft's velocity; light cycles report
 *    AGL 0 and their speed; the craft broadcasts as YOU.
 * 3. Squawk turns to 7700 when an aircraft is badly hit and to 7600 while an EMP has it.
 * 4. Tracks sample once a second, keep 60 points and go when the vehicle goes.
 * 5. Globe pick → planet → globe round-trips; the close view's local frame round-trips across
 *    the wrap.
 */
import * as THREE from 'three';
import { JET } from '../src/craft/jet.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { TRACK_POINTS, knots } from '../src/sim/adsb.ts';
import { fromLocal, globeToWorld, toLocal, worldToGlobe, wrapDelta } from '../src/sim/contacts.ts';
import { PLANET } from '../src/sim/layout.ts';

await initPhysics();
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};
const idle = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };
const AT = new THREE.Vector3(0, 900, -2600);
const run = (sim: Simulation, seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 120); i++) {
    const b = sim.craft.body;
    b.setTranslation(AT, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    sim.step(idle);
  }
};
function world(): Simulation {
  const sim = new Simulation(JET);
  sim.airTraffic.pool = [TEST_PLANE, JET];
  sim.airTraffic.count = 6;
  sim.airTraffic.enemies = 3;
  sim.airTraffic.friendlies = 2;
  sim.airTraffic.freelancers = 1;
  sim.groundTurrets.density = 0;
  return sim;
}

// ---------------------------------------------------------------- 1-2. records
console.log('--- records');
const a = world(), b = world();
run(a, 3); run(b, 3);
const ra = a.adsbRecords(), rb = b.adsbRecords();
const calls = ra.map((r) => r.callsign);
check(new Set(calls).size === calls.length, 'every callsign is unique', `${calls.length} vehicles: ${calls.slice(0, 8).join(' ')} …`);
check(JSON.stringify(calls) === JSON.stringify(rb.map((r) => r.callsign)), 'the same seed gives the same callsigns');
const byId = new Map(ra.map((r) => [r.id, r.callsign]));
run(a, 2);
const later = a.adsbRecords();
check(later.every((r) => !byId.has(r.id) || byId.get(r.id) === r.callsign), 'a vehicle keeps its callsign');
check(later.some((r) => r.callsign === 'YOU' && r.category === 'self'), 'the craft broadcasts as YOU');
let worst = 0;
for (const f of a.airTraffic.flyers) {
  const r = later.find((x) => x.id === `air:${f.id}`);
  if (!r) continue;
  const gs = Math.hypot(f.vel.x, f.vel.z);
  const trackErr = gs > 1 ? Math.abs(Math.atan2(Math.sin(r.track - Math.atan2(f.vel.x, -f.vel.z)), Math.cos(r.track - Math.atan2(f.vel.x, -f.vel.z)))) : 0;
  worst = Math.max(worst, Math.abs(r.gs - gs), Math.abs(r.vs - f.vel.y), trackErr * 100);
}
check(worst < 1e-6, 'ground speed, track and vertical rate are the aircraft\'s own', `worst error ${worst.toExponential(1)}`);
const prefixes = new Set(later.map((r) => r.callsign.split('-')[0]));
check(['CYN', 'RED', 'AMB', 'FRL', 'CIV'].filter((p) => prefixes.has(p)).length >= 3, 'callsigns carry the side', [...prefixes].join(' '));
{
  const sim = world();
  sim.traffic.enabled = true;
  run(sim, 3);
  const riders = sim.adsbRecords().filter((r) => r.category === 'ground');
  const r0 = sim.traffic.riders.find((r) => r.derezAt === null);
  const rec = riders.find((r) => r.id === `rider:${r0?.id}`);
  check(riders.length > 0 && riders.every((r) => r.agl === 0 && r.callsign.startsWith('LC-')), 'light cycles broadcast on the ground', `${riders.length}`);
  check(!!rec && Math.abs(rec.gs - r0!.speed) < 1e-9, 'with their speed', rec ? `${knots(rec.gs)} kt` : '');
}

// ---------------------------------------------------------------- 3. squawk
console.log('--- squawk');
{
  const f = a.airTraffic.flyers.find((x) => x.hostile && x.derezAt === null)!;
  const normal = a.adsbRecords().find((r) => r.id === `air:${f.id}`)!.squawk;
  check(/^[1-6][0-7]{3}$/.test(normal), 'a normal squawk: four octal digits, no emergency code', normal);
  f.hp = f.maxHp * 0.3;
  check(a.adsbRecords().find((r) => r.id === `air:${f.id}`)!.squawk === '7700', 'badly hit: 7700');
  f.hp = f.maxHp;
  a.airTraffic.disable(f, a.time + 5);
  check(a.adsbRecords().find((r) => r.id === `air:${f.id}`)!.squawk === '7600', 'under an EMP: 7600');
}

// ---------------------------------------------------------------- 4. tracks
console.log('--- tracks');
{
  const sim = world();
  run(sim, 0.5);
  const id = `air:${sim.airTraffic.flyers[0].id}`;
  run(sim, 10);
  const t = sim.adsb.tracks.get(id)!;
  const gaps = t.slice(1).map((p, i) => p.t - t[i].t);
  check(t.length >= 10 && t.length <= 12 && gaps.every((g) => Math.abs(g - 1) < 0.02), 'tracks sample once a second', `${t.length} points`);
  run(sim, 65);
  const len = Math.max(...[...sim.adsb.tracks.values()].map((x) => x.length));
  check(len === TRACK_POINTS, 'and keep the last minute', `${len}`);
  const f = sim.airTraffic.flyers[0];
  const gone = `air:${f.id}`;
  sim.derezFlyer(f);
  run(sim, 4);
  check(!sim.adsb.tracks.has(gone) && !sim.adsb.latest.has(gone), 'a track goes with its vehicle');
}

// ---------------------------------------------------------------- 5. globe geometry
console.log('--- globe geometry');
{
  const C = PLANET.circumference, X0 = -C / 2, Z0 = -C / 2;
  let worstPick = 0;
  for (let i = 0; i < 40; i++) for (let j = 1; j < 40; j++) {
    const x = X0 + (i / 40) * C + 13, z = Z0 + (j / 40) * C + 7;
    const g = worldToGlobe(x, z, X0, Z0);
    const w = globeToWorld(g.x, g.y, g.z, X0, Z0);
    worstPick = Math.max(worstPick, Math.hypot(wrapDelta(x, w.x), wrapDelta(z, w.z)));
  }
  check(worstPick < 1, 'planet → globe → planet round-trips', `worst ${worstPick.toFixed(3)} m`);
  const cx = C / 2 - 40, cz = -C / 2 + 25; // right by the wrap seam
  let worstLocal = 0;
  for (const [dx, dz] of [[100, 0], [-3000, 2000], [2500, -2500], [60, 60]]) {
    const x = cx + dx, z = cz + dz;
    const l = toLocal(x, z, cx, cz);
    const w = fromLocal(l.x, l.z, cx, cz);
    worstLocal = Math.max(worstLocal, Math.hypot(wrapDelta(x, w.x), wrapDelta(z, w.z)), Math.abs(l.x - dx), Math.abs(l.z - dz));
    // The same point in the next image round the planet maps to the same local point.
    const l2 = toLocal(x + C, z - C, cx, cz);
    worstLocal = Math.max(worstLocal, Math.hypot(l2.x - l.x, l2.z - l.z));
  }
  check(worstLocal < 1e-6, 'the close view\'s local frame round-trips across the wrap seam', `worst ${worstLocal.toExponential(1)} m`);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll ADS-B checks passed');
process.exit(failed ? 1 : 0);
