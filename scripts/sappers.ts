/**
 * Sappers: the Bits' part in the war. Run with `npm run sappers`.
 *
 * 1. At peace nobody is drafted.
 * 2. At war the side holding a district drafts sappers; every charge a Bit sets is in a district
 *    held by a side at war with the planter's, never its own; sappers walk the kerbs (never in a
 *    wall); at most one Bit-set nuke is live.
 * 3. The rails, directly: no charge in your own district or at peace; a nuke waits three minutes
 *    into a war, and one at a time.
 * 4. The player defuses a sapper's charge by picking it up: a demolition charge is thrown away,
 *    a nuke is the player's to carry.
 * 5. A demolition charge at the foot of a turret's tower brings the turret down, and with the
 *    district's last turret the district changes hands.
 */
import * as THREE from 'three/webgpu';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import type { ControlInputs } from '../src/sim/controls.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { turretSites } from '../src/sim/groundTurrets.ts';
import { baseOwner } from '../src/sim/territory.ts';
import { allAtWar, atWar, resetDiplomacy, type Team } from '../src/sim/teams.ts';
import { GRID } from '../src/arch/grid.ts';
import { districtPlan } from '../src/arch/DistrictGenerator.ts';
import { chunkAt } from '../src/world/planetCity.ts';
import { SAPPERS } from '../src/sim/sappers.ts';
import { CHARGE } from '../src/sim/strategic.ts';

await initPhysics();
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const idle: ControlInputs = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, flaps: 0 } as ControlInputs;

// A turret tower near the border with another side's district: Bits across the border have it in reach.
const S = GRID.chunkSize;
let pick: { x: number; z: number; y: number; ci: number; cj: number; owner: Team; enemyOf: Team; toward: { x: number; z: number } } | null = null;
for (let ci = 0; ci < GRID.chunks && !pick; ci++) for (let cj = 0; cj < GRID.chunks && !pick; cj++) {
  const owner = baseOwner(ci, cj);
  if (owner === null) continue;
  for (const s of turretSites(ci, cj, 1)) {
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const other = baseOwner(ci + di, cj + dj);
      if (other === null || other === owner) continue;
      const x0 = GRID.x0 + (ci + di) * S, z0 = GRID.z0 + (cj + dj) * S;
      const dx = Math.max(x0 - s.x, 0, s.x - (x0 + S)), dz = Math.max(z0 - s.z, 0, s.z - (z0 + S));
      if (Math.hypot(dx, dz) > 260) continue;
      pick = { x: s.x, z: s.z, y: s.y, ci, cj, owner, enemyOf: other, toward: { x: s.x + di * 280, z: s.z + dj * 280 } };
      break;
    }
    if (pick) break;
  }
}
check(!!pick, 'there is a front: a turret tower near another side\'s district', pick ? `district ${pick.ci},${pick.cj} (team ${pick.owner}) against team ${pick.enemyOf}` : '');
if (!pick) process.exit(1);
const site = pick;

/** Hold the craft high over the front (the people stream round it; nothing to crash into). */
function hold(sim: Simulation): void {
  const b = sim.craft.body;
  b.setTranslation({ x: site.toward.x, y: 420, z: site.toward.z }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);
}
function world(): Simulation {
  resetDiplomacy();
  const sim = new Simulation(TEST_PLANE);
  sim.traffic.enabled = false;
  sim.airTraffic.enemies = 0;
  sim.groundTurrets.density = 1;
  return sim;
}
const run = (sim: Simulation, seconds: number, each?: () => void) => {
  for (let i = 0; i < seconds * 120; i++) { hold(sim); sim.step(idle); if (each && i % 30 === 0) each(); }
};

console.log('--- peace');
{
  const sim = world();
  run(sim, 120);
  check(sim.bits.people.length > 20 && sim.sappers.stats.sent === 0, 'at peace nobody is drafted', `${sim.bits.people.length} Bits about, ${sim.sappers.stats.sent} sappers`);
}

console.log('\n--- war');
{
  const sim = world();
  allAtWar();
  // Solids near the front, to check that sappers keep out of walls.
  const solid: Array<{ x: number; y: number; z: number; sx: number; sy: number; sz: number }> = [];
  const [ci0, cj0] = chunkAt(site.x, site.z);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const st of districtPlan(ci0 + a, cj0 + b).structures) solid.push(...st.colliders);
  const charges = new Set<object>();
  let wrongPlace = 0, nukesLive = 0, inWall = 0, maxOut = 0;
  run(sim, 600, () => {
    for (const c of sim.charges) {
      if (c.by === undefined || charges.has(c)) continue;
      charges.add(c);
      const owner = sim.groundTurrets.territory.ownerAt(c.x, c.z);
      if (owner === null || owner === c.by || !atWar(c.by, owner)) wrongPlace++;
    }
    nukesLive = Math.max(nukesLive, sim.charges.filter((c) => c.by !== undefined && c.kind === 'nuke').length);
    const out = sim.bits.people.filter((p) => p.mission);
    maxOut = Math.max(maxOut, out.length);
    for (const p of out) if (solid.some((b) => Math.abs(p.x - b.x) < b.sx / 2 - 0.1 && Math.abs(p.z - b.z) < b.sz / 2 - 0.1 && Math.abs(p.y - b.y) < b.sy / 2)) inWall++;
  });
  const st = sim.sappers.stats;
  check(st.sent > 0, 'at war the side holding a district drafts sappers', `${st.sent} sent, ${st.set} set charges, ${st.shot} shot, ${st.duds} duds, ${st.home} veterans home; at most ${maxOut} out`);
  check(wrongPlace === 0, 'every charge a Bit sets is in a district held by a side at war with its own', `${charges.size} charges`);
  check(inWall === 0, 'sappers walk the kerbs, never in a wall', `${inWall} samples in a wall`);
  check(nukesLive <= 1 && maxOut <= SAPPERS.max, 'never more than one Bit-set nuke live, never more sappers out than the cap');
}

console.log('\n--- the rails');
{
  const sim = world();
  run(sim, 5);
  const side = site.enemyOf;
  const targets = () => sim.battle.targets(side, site.toward.x, site.toward.z, 800);
  check(targets().length === 0, 'at peace there is nothing to attack');
  allAtWar();
  run(sim, 2);
  const t = targets()[0];
  check(!!t, 'at war the enemy turret is a target', t ? `${t.id} at its tower's foot` : '');
  if (t) {
    const own = sim.battle.plant('demo', site.toward.x, 0, site.toward.z, side, t, 1, sim.time);
    check(!own && sim.battle.sideAt(site.toward.x, site.toward.z) === side, 'no charge in the sapper\'s own district');
    check(!sim.battle.plant('nuke', t.x, 0, t.z, side, t, 1, sim.time), 'a nuke waits until the war is three minutes old');
    run(sim, 181);
    check(sim.battle.plant('nuke', t.x, 0, t.z, side, t, 1, sim.time), 'then a sapper may set one at the enemy tower');
    check(!sim.battle.plant('nuke', t.x, 0, t.z, side, t, 2, sim.time), 'but only one Bit-set nuke is ever live');
    // The player defuses it: on foot beside it, ` picks it up.
    const nuke = sim.charges.find((c) => c.by === side && c.kind === 'nuke')!;
    sim.walker.exit(nuke.x + 1, nuke.y, nuke.z, 0);
    const why = sim.placeStrategic();
    check(why === null && !sim.charges.includes(nuke) && sim.strategic === 'nuke', 'the player defuses a sapper\'s nuke by picking it up, and carries it', why ?? '');
    sim.walker.board();
    // And a demolition charge: thrown away.
    sim.battle.plant('demo', t.x, 0, t.z, side, t, 3, sim.time);
    const demo = sim.charges.find((c) => c.by === side && c.kind === 'demo')!;
    sim.walker.exit(demo.x + 1, demo.y, demo.z, 0);
    const why2 = sim.placeStrategic();
    check(why2 === null && !sim.charges.includes(demo), 'a sapper\'s demolition charge is defused the same way', why2 ?? '');
    sim.walker.board();
  }
}

console.log('\n--- demolition');
{
  const sim = world();
  allAtWar();
  run(sim, 3);
  const side = site.enemyOf;
  const t = sim.battle.targets(side, site.toward.x, site.toward.z, 800)[0];
  const turret = sim.groundTurrets.turrets.find((q) => q.derezAt === null && Math.hypot(q.pos.x - site.x, q.pos.z - site.z) < 5);
  const before = sim.groundTurrets.territory.ownerOf(site.ci, site.cj);
  const others = turretSites(site.ci, site.cj, 1).length;
  check(!!t && !!turret, 'the tower\'s turret is up', `${others} turret(s) hold district ${site.ci},${site.cj} for team ${before}`);
  if (t && turret) {
    sim.battle.plant('demo', t.x, 0, t.z, side, t, 4, sim.time);
    run(sim, CHARGE.fuse.demo + 6);
    check(turret.derezAt !== null, 'a demolition charge at the foot of the tower brings its turret down', `${sim.bits.deaths.blast} Bits caught in the blast`);
    const after = sim.groundTurrets.territory.ownerOf(site.ci, site.cj);
    check(others > 1 || after === side, 'with the district\'s last turret, the district goes to the sapper\'s side', `team ${before} → ${after}`);
  }
}

void THREE;
console.log(failures ? `\n${failures} FAILED` : '\nAll sapper checks passed');
process.exit(failures ? 1 : 0);
