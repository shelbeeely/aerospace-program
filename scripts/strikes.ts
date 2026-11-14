/**
 * Called-in strikes and orders, headless. Run with `npm run strikes`.
 *
 * 1. Focus points: turrets come live round a strike target far from the player.
 * 2. Barrage: it costs its price, starts in friendly territory, its missiles reach the far
 *    target and destroy the turrets there, and the district is captured.
 * 3. Interception: a turret round passing close to a cruise missile destroys it.
 * 4. EMP strike: it disables what's at the target.
 * 5. Nuke bomber: it flies there in team colours and drops, the bomb bursts near the target,
 *    the bomber leaves.
 * 6. Orders: ordered aircraft reach the point and fight there; a recall brings them back.
 * 7. Strikes need the credits.
 */
import * as THREE from 'three';
import { JET } from '../src/craft/jet.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { turretSites } from '../src/sim/groundTurrets.ts';
import { GRID } from '../src/arch/grid.ts';
import { STRIKES } from '../src/sim/strikes.ts';
import { PLANET } from '../src/sim/layout.ts';
import { chunkAt } from '../src/world/planetCity.ts';
import { allAtWar } from '../src/sim/teams.ts';
// The world starts at peace; these checks test fighting, so every team is at war with every other.
allAtWar();

await initPhysics();
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};
const idle = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };
const AT = new THREE.Vector3(0, 900, -2600);
function hold(sim: Simulation, p = AT): void {
  const b = sim.craft.body;
  b.setTranslation(p, true);
  b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);
}
/** Run until `until` says so (or the time is up); returns the seconds it took. */
const run = (sim: Simulation, seconds: number, until?: () => boolean) => {
  const t0 = sim.time;
  for (let i = 0; i < Math.round(seconds * 120); i++) {
    hold(sim);
    sim.step(idle);
    if (until && i % 12 === 0 && until()) break;
  }
  return sim.time - t0;
};
const C = PLANET.circumference;
const wrap = (d: number) => d - Math.round(d / C) * C;
const gap = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(wrap(a.x - b.x), wrap(a.z - b.z));
function world(): Simulation {
  const sim = new Simulation(JET);
  sim.traffic.enabled = false;
  sim.airTraffic.pool = [TEST_PLANE];
  sim.airTraffic.count = 0;
  sim.airTraffic.enemies = 0;
  sim.airTraffic.friendlies = 0;
  sim.airTraffic.freelancers = 0;
  sim.weapons.arm(JET, 'none');
  return sim;
}
/** An enemy district 10-20 km from the player, with turrets, and its centre. */
function enemyDistrict(sim: Simulation, density: 1 | 2, minD = 10000, maxD = 20000, gunsOnly = false) {
  const n = GRID.chunks;
  const [pi, pj] = chunkAt(AT.x, AT.z);
  const out: Array<{ ci: number; cj: number; x: number; z: number; d: number; owner: number; sites: ReturnType<typeof turretSites> }> = [];
  for (let di = -16; di <= 16; di++) for (let dj = -16; dj <= 16; dj++) {
    const ci = (((pi + di) % n) + n) % n, cj = (((pj + dj) % n) + n) % n;
    const owner = sim.groundTurrets.territory.ownerOf(ci, cj);
    if (owner === null || owner === sim.team) continue;
    const sites = turretSites(ci, cj, density);
    if (!sites.length || (gunsOnly && sites.some((x) => x.kind === 'rail'))) continue;
    const x = sites.reduce((a, s) => a + s.x, 0) / sites.length, z = sites.reduce((a, s) => a + s.z, 0) / sites.length;
    const d = gap({ x, z }, AT);
    if (d < minD || d > maxD) continue;
    out.push({ ci, cj, x, z, d, owner, sites });
  }
  out.sort((a, b) => a.d - b.d);
  return out[0];
}

// ---------------------------------------------------------------- 1-2. barrage
console.log('--- barrage on a far district');
{
  const sim = world();
  sim.groundTurrets.density = 1;
  const t = enemyDistrict(sim, 1)!;
  check(!!t, 'an enemy district with a turret 10-20 km away', t ? `${(t.d / 1000).toFixed(1)} km, ${t.sites.length} turret(s)` : '');
  run(sim, 0.5);
  const liveBefore = sim.groundTurrets.turrets.filter((x) => x.site.ci === t.ci && x.site.cj === t.cj).length;
  check(liveBefore === 0, 'its turrets are not live before the strike (too far away)', `${liveBefore}`);
  sim.credits = 1000;
  const why = sim.callStrike('barrage', t.x, t.z);
  const s = sim.strikeSystem.strikes[0];
  check(why === null && sim.credits === 1000 - STRIKES.barrage.price, 'a barrage costs its price', `${why ?? ''} ${sim.credits}`);
  const fromOwner = sim.groundTurrets.territory.ownerAt(s.fromX, s.fromZ);
  check(fromOwner === sim.team && gap({ x: s.fromX, z: s.fromZ }, t) >= 3000, 'it sets out from a district the team holds, 3 km or more from the target', `${(gap({ x: s.fromX, z: s.fromZ }, t) / 1000).toFixed(1)} km`);
  run(sim, 2);
  const liveAt = sim.groundTurrets.turrets.filter((x) => x.site.ci === t.ci && x.site.cj === t.cj && x.derezAt === null).length;
  check(liveAt === t.sites.length, 'the target is a focus point: its turrets come live', `${liveAt}/${t.sites.length}`);
  check(sim.allWeapons().includes(sim.strikeSystem.view) && sim.strikeSystem.view.projectiles.length > 0, 'the missiles are drawn as rounds in flight', `${sim.strikeSystem.view.projectiles.length}`);
  const took = run(sim, 160, () => s.done);
  const left = sim.groundTurrets.turrets.filter((x) => x.site.ci === t.ci && x.site.cj === t.cj && x.derezAt === null && x.side === t.owner).length;
  const owner = sim.groundTurrets.territory.ownerOf(t.ci, t.cj);
  check(s.done && s.outcome !== null, 'the barrage arrives', `${s.outcome} after ${took.toFixed(0)} s (ETA said ${(s.eta - s.launchedAt).toFixed(0)} s)`);
  check(left === 0, 'it destroys the turrets there', `${left} left`);
  check(owner === sim.team, 'the district is captured for the team', `owner ${owner}`);
  check(sim.credits > 1000 - STRIKES.barrage.price, 'its kills pay', `${sim.credits} credits`);
}

// ---------------------------------------------------------------- 3. interception
console.log('--- interception');
{
  const sim = world();
  sim.groundTurrets.density = 2;
  const t = enemyDistrict(sim, 2, 8000, 20000)!;
  sim.credits = 1000;
  sim.callStrike('barrage', t.x, t.z);
  const s = sim.strikeSystem.strikes[0];
  run(sim, 1);
  // A turret round placed right on a missile's path.
  const m = s.missiles.find((x) => !x.dead && sim.time >= x.at)!;
  const tur = sim.groundTurrets.turrets.find((x) => x.derezAt === null && x.side === t.owner)!;
  const round = { ...tur.weapons.projectiles[0], id: 9999, kind: 'gun' as const, bounces: 0, pos: m.pos.clone().addScaledVector(m.vel, 1 / 120).add(new THREE.Vector3(2, 0, 0)), vel: new THREE.Vector3(0, 0, 0), heading: new THREE.Vector3(0, 1, 0), age: 0, color: '#f00', target: null };
  tur.weapons.projectiles.push(round);
  const before = sim.strikeSystem.intercepted;
  run(sim, 1 / 60);
  check(m.dead && sim.strikeSystem.intercepted === before + 1, 'a turret round within 6 m destroys a cruise missile', `${sim.strikeSystem.intercepted - before}`);
  const foes = sim.strikeSystem.foes();
  check(foes.length > 0 && foes.every((f) => f.kind === 'missile' && f.side === sim.team), 'the missiles are targets for the turrets', `${foes.length}`);
}

// ---------------------------------------------------------------- 4. EMP strike
console.log('--- EMP strike');
{
  const sim = world();
  sim.groundTurrets.density = 2;
  const t = enemyDistrict(sim, 2)!;
  sim.credits = 900;
  check(sim.callStrike('emp', t.x, t.z) === null && sim.credits === 0, 'an EMP strike costs 900');
  const s = sim.strikeSystem.strikes[0];
  let dark = 0, alive = 0;
  run(sim, 160, () => {
    if (!s.done) return false;
    const at = sim.groundTurrets.turrets.filter((x) => x.site.ci === t.ci && x.site.cj === t.cj);
    alive = at.filter((x) => x.derezAt === null).length;
    dark = at.filter((x) => x.derezAt === null && x.disabledUntil > sim.time).length;
    return true;
  });
  const burst = sim.blasts.find((b) => b.kind === 'emp');
  check(!!burst && gap(burst, t) < 1000, 'it bursts over the target', burst ? `${gap(burst, t).toFixed(0)} m off` : 'no burst');
  check(alive > 0 && dark === alive, 'the turrets there go dark, none destroyed', `${dark}/${alive}`);
}

// ---------------------------------------------------------------- 5. nuke bomber
console.log('--- nuke bomber');
{
  const sim = world();
  sim.groundTurrets.density = 1;
  const t = enemyDistrict(sim, 1)!;
  sim.credits = 2400;
  check(sim.callStrike('bomber', t.x, t.z) !== null, 'a nuke bomber needs 2500 credits');
  sim.credits = 2500;
  check(sim.callStrike('bomber', t.x, t.z) === null && sim.credits === 0, 'with them it is called in');
  const s = sim.strikeSystem.strikes[0];
  const b = s.bomber!;
  check(!!b && b.side === sim.team && b.role === 'strike', 'a bomber of the team flies it', b ? `${b.name}, side ${b.side}` : '');
  const start = b.pos.clone();
  let dropAt: THREE.Vector3 | null = null;
  run(sim, 260, () => {
    if (!dropAt && b.run?.dropped) dropAt = b.pos.clone();
    return sim.blasts.some((x) => x.kind === 'nuke');
  });
  const burst = sim.blasts.find((x) => x.kind === 'nuke');
  check(!!dropAt, 'it drops the bomb', dropAt ? `${(gap(start, dropAt!) / 1000).toFixed(1)} km from where it set out` : '');
  check(!!burst && gap(burst, t) < 400, 'the bomb bursts near the target', burst ? `${gap(burst, t).toFixed(0)} m off, ${(burst.y - Math.max(0, 0)).toFixed(0)} m up` : 'no burst');
  check(b.leaving || b.derezAt !== null || !sim.airTraffic.flyers.includes(b), 'the bomber turns for home');
  const at = sim.groundTurrets.turrets.filter((x) => x.site.ci === t.ci && x.site.cj === t.cj && x.derezAt === null && x.side === t.owner).length;
  check(at === 0, 'nothing of the enemy is left standing at the target', `${at}`);
}

// ---------------------------------------------------------------- 6. orders
console.log('--- orders');
{
  const sim = world();
  sim.groundTurrets.density = 1;
  sim.airTraffic.pool = [JET];
  sim.airTraffic.friendlies = 3;
  run(sim, 1);
  const t = enemyDistrict(sim, 1, 6000, 12000, true)!;
  const n = sim.orderAircraft(t.x, t.z, 'friends');
  check(n === 3, 'the friendlies take the order', `${n}`);
  const ordered = sim.airTraffic.flyers.filter((f) => f.order);
  // (This checks where they go and what they fight, not whether they survive the turrets.)
  for (const f of ordered) f.hp = f.maxHp = 1000;
  let near = 0, fought = false, focus = false;
  run(sim, 150, () => {
    near = Math.max(near, ordered.filter((f) => f.derezAt === null && gap(f.pos, t) < 3000).length);
    fought ||= ordered.some((f) => f.derezAt === null && f.target?.kind === 'turret' && gap(f.target.lock.position(new THREE.Vector3()), t) < 3000);
    focus ||= sim.focusPoints().some((p) => p.x === t.x && p.z === t.z);
    return near > 0 && fought;
  });
  check(near > 0, 'they reach the point', `${near} within 3 km`);
  check(fought, 'they attack the enemy turrets there');
  check(focus, 'the order point is a focus point');
  const out = ordered.filter((f) => f.derezAt === null);
  const before = out.map((f) => gap(f.pos, AT));
  sim.recallAircraft();
  check(sim.airTraffic.flyers.every((f) => !f.order), 'a recall calls them off');
  // Back on guard duty: by the craft, or fighting something near it (not at the old point).
  const tp = new THREE.Vector3();
  const guarding = () => out.filter((f) => f.derezAt === null && (f.target ? gap(f.target.lock.position(tp), AT) < 6600 : gap(f.pos, AT) < 4000)).length;
  run(sim, 60, () => guarding() === out.filter((f) => f.derezAt === null).length);
  const alive = out.filter((f) => f.derezAt === null).length;
  check(alive > 0 && guarding() === alive, 'and they go back to guarding the craft', `${guarding()}/${alive}: ${before.map((d) => (d / 1000).toFixed(1)).join(', ')} km → ${out.map((f) => (gap(f.pos, AT) / 1000).toFixed(1)).join(', ')} km`);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll strike checks passed');
process.exit(failed ? 1 : 0);
