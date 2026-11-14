/**
 * Radar and planet map, headless. Run with `npm run radar`.
 *
 * 1. Every vehicle in the world is a contact: AI aircraft, hostiles and light-cycle riders, each
 *    with its kind, position, heading and circuit colour; a derezzed one is gone.
 * 2. The radar scope is heading-up and wrap-aware: dead ahead is up, the right is right, a
 *    contact across the planet's seam is as near as it really is, and one beyond the range sits
 *    on the rim.
 * 3. The planet map is north-up, centred on the craft, and covers the whole planet.
 */
import { BUILTINS } from '../src/craft/builtins.ts';
import { JET } from '../src/craft/jet.ts';
import { globeAngles, globeProject, globeUnproject, mapPoint, radarPoint, simContacts, wrapDelta } from '../src/sim/contacts.ts';
import { PLANET } from '../src/sim/layout.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { allAtWar } from '../src/sim/teams.ts';
// The world starts at peace; these checks test fighting, so every team is at war with every other.
allAtWar();

await initPhysics();
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const idle = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };
const C = PLANET.circumference;

console.log('--- contacts');
{
  const sim = new Simulation(JET);
  sim.airTraffic.pool = BUILTINS.map((b) => b.craft);
  sim.airTraffic.count = 5;
  sim.airTraffic.enemies = 2;
  for (let i = 0; i < 120 * 20; i++) sim.step(idle);
  const cs = simContacts(sim);
  const n = (k: string) => cs.filter((c) => c.kind === k).length;
  const riders = sim.traffic.riders.filter((r) => r.derezAt === null).length;
  check(n('aircraft') === 5 && n('hostile') === 2, 'AI aircraft and hostiles are contacts', `${n('aircraft')} aircraft, ${n('hostile')} hostile`);
  check(riders > 0 && n('rider') === riders, 'so is every light-cycle rider', `${riders} riders`);
  check(cs.every((c) => Number.isFinite(c.x + c.z + c.y + c.heading) && /^#[0-9a-f]{6}$/i.test(c.color) && c.name.length > 0), 'each has a position, a heading, a colour and a name');
  check(cs.filter((c) => c.kind === 'hostile').every((c) => c.foe && (c.color === '#ff2a12' || c.color === '#ffb000')), 'enemies are drawn in their team\'s light, as foes');
  const f = sim.airTraffic.hostileFlyers()[0];
  sim.derezFlyer(f, true);
  check(simContacts(sim).filter((c) => c.kind === 'hostile').length === 1, 'a derezzed vehicle leaves the scope');
  const within = cs.every((c) => Math.hypot(wrapDelta(sim.position.x, c.x), wrapDelta(sim.position.z, c.z)) < C / 2);
  check(within, 'every contact is placed the short way round the planet');
}

console.log('--- radar scope');
{
  // Heading north: 1 km ahead (north, -Z) is straight up at a fifth of a 5 km scope.
  let p = radarPoint(0, 0, 0, 0, -1000, 5000);
  check(near(p.x, 0) && near(p.y, 0.2) && p.inside, 'dead ahead is up');
  p = radarPoint(0, 0, 0, 1000, 0, 5000);
  check(near(p.x, 0.2) && near(p.y, 0), 'east of a north-bound craft is to the right');
  // Heading east: the same contact is now dead ahead.
  p = radarPoint(0, 0, Math.PI / 2, 1000, 0, 5000);
  check(near(p.x, 0) && near(p.y, 0.2), 'the scope turns with the craft (heading up)');
  p = radarPoint(C / 2 - 100, 0, 0, -C / 2 + 100, 0, 5000);
  check(near(p.distance, 200, 1e-3) && near(p.x, 0.04, 1e-6), 'a contact across the seam is 200 m away, not a planet away', `${p.distance.toFixed(0)} m`);
  p = radarPoint(0, 0, 0, 0, -9000, 5000);
  check(!p.inside && near(Math.hypot(p.x, p.y), 1), 'beyond the range it sits on the rim');
}

console.log('--- planet map');
{
  let m = mapPoint(1234, -567, 1234, -567);
  check(near(m.u, 0.5) && near(m.v, 0.5), 'the craft is at the centre');
  m = mapPoint(0, 0, 0, -C / 4);
  check(near(m.u, 0.5) && near(m.v, 0.25), 'north is up');
  m = mapPoint(0, 0, C / 4, 0);
  check(near(m.u, 0.75) && near(m.v, 0.5), 'east is right');
  let inside = true;
  for (let i = 0; i < 400; i++) {
    const q = mapPoint(i * 311.7, -i * 177.3, i * 9973.1, i * 7919.3);
    if (q.u < 0 || q.u > 1 || q.v < 0 || q.v > 1) inside = false;
  }
  check(inside, 'every point on the planet falls on the map');
}

console.log('--- globe');
{
  const lon0 = 1.2, lat0 = 0.4;
  let q = globeProject(lon0, lat0, lon0, lat0);
  check(near(q.x, 0) && near(q.y, 0) && near(q.z, 1), 'the point looked at is the centre of the globe');
  q = globeProject(lon0 + Math.PI / 2, 0, lon0, 0);
  check(near(q.x, 1) && near(q.y, 0) && near(q.z, 0), '90° east sits on the right-hand limb');
  q = globeProject(lon0 + Math.PI, 0.2, lon0, lat0);
  check(q.z < 0, 'the far side is hidden');
  q = globeProject(lon0, lat0 + 0.3, lon0, lat0);
  check(q.y > 0 && near(q.x, 0), 'north is up');
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const lon = lon0 + ((i * 37) % 100) / 100 * 2.6 - 1.3, lat = ((i * 53) % 100) / 100 * 2 - 1;
    const p = globeProject(lon, lat, lon0, lat0);
    if (p.z <= 0) continue;
    const back = globeUnproject(p.x, p.y, lon0, lat0)!;
    worst = Math.max(worst, Math.abs(back.lat - lat), Math.abs(Math.atan2(Math.sin(back.lon - lon), Math.cos(back.lon - lon))));
  }
  check(worst < 1e-9, 'a point on the globe maps back to where it came from', `error ${worst.toExponential(1)}`);
  const a = globeAngles(0.25, 0.5);
  check(near(a.lon, Math.PI / 2) && near(a.lat, 0), 'a quarter of the way east on the equator is 90° east');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
