/**
 * Tower turrets, headless. Run with `npm run turrets`.
 *
 * 1. Placement: deterministic, on flat tower roofs, never beside a rooftop helipad; Off gives
 *    none and Dense at least as many as Sparse.
 * 2. Streaming: turrets come live around the player and go when it leaves; a destroyed one stays
 *    down after leaving and coming back, and returns after a world reset.
 * 3. An unarmed craft in view is tracked but never fired on.
 * 4. An armed craft in view is fired on, hit, and sent a homing missile.
 * 5. Line of sight: a line through a tower is blocked, one over it is clear.
 * 6. A turret survives one gun hit and derezzes after enough; the kill is counted.
 * 7. A fractured tower takes its turret with it.
 * 8. Turrets are lock targets and radar contacts; the same seed gives the same fight.
 */
import * as THREE from 'three';
import { districtPlan } from '../src/arch/DistrictGenerator.ts';
import { JET } from '../src/craft/jet.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { simContacts } from '../src/sim/contacts.ts';
import { AIRFIELD_CLEAR, lineOfSight, runwayDistance, turretDef, turretSites, TURRET_DEF, TURRET_HEAD_Y, type TurretSite } from '../src/sim/groundTurrets.ts';
import { chunkAt } from '../src/world/planetCity.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { terrainHeight } from '../src/sim/terrain.ts';
import { landingSites } from '../src/world/landingSites.ts';
import { obstacleTop } from '../src/world/structures.ts';
import { validateCraft } from '../src/craft/validate.ts';
import { baseOwner } from '../src/sim/territory.ts';
import type { Team } from '../src/sim/teams.ts';
import { BODY_WARM, LIGHTS } from '../src/craft/style1982.ts';
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

// ---------------------------------------------------------------- 1. placement
console.log('--- placement');
const sparse: TurretSite[] = [], dense: TurretSite[] = [];
for (let ci = 0; ci < 6; ci++) for (let cj = 0; cj < 6; cj++) {
  sparse.push(...turretSites(ci, cj, 1));
  dense.push(...turretSites(ci, cj, 2));
}
{
  check(validateCraft(TURRET_DEF).length === 0, 'the turret is a valid craft definition');
  const palette = [...BODY_WARM, ...LIGHTS] as readonly string[];
  check(TURRET_DEF.parts.every((p) => palette.includes(p.color)) && TURRET_DEF.parts.some((p) => p.color === LIGHTS[2]), 'in red-team colours');
  check(sparse.length > 0 && dense.length >= sparse.length, 'sparse and dense both place turrets, dense at least as many', `${sparse.length} sparse, ${dense.length} dense in 36 districts`);
  check([0, 1, 2, 3].every((ci) => turretSites(ci, 2, 0).length === 0), 'off places none');
  const onRoof = sparse.every((s) => {
    for (let ci = 0; ci < 6; ci++) for (let cj = 0; cj < 6; cj++) {
      const st = districtPlan(ci, cj).structures.find((x) => x.id === s.structureId);
      if (st) return !!st.roof && st.roof.x === s.x && st.roof.y === s.y && st.roof.z === s.z && s.y >= 35;
    }
    return false;
  });
  check(onRoof, 'every one stands on a flat tower roof, 35 m up or more');
  const pads = landingSites().filter((p) => p.kind === 'helipad' && p.y > 0);
  check(sparse.every((s) => pads.every((p) => Math.hypot(p.x - s.x, p.z - s.z) > 40)), 'never beside a rooftop helipad');
  const again = JSON.stringify(sparse.map((s) => s.id));
  check(again.length > 2 && again === JSON.stringify([...Array(36).keys()].flatMap((k) => turretSites(Math.floor(k / 6), k % 6, 1)).map((s) => s.id)), 'the same towers every time');
}

// The site the rest of the checks use: one with clear air around it.
const site = sparse.find((s) => s.y < 200)!;
const base = new THREE.Vector3(site.x, site.y, site.z);
const head = base.clone().add(new THREE.Vector3(0, TURRET_HEAD_Y, 0));

/** Hold the craft still at `p`, nose toward `look` (a firing platform). */
function hold(sim: Simulation, p: THREE.Vector3, look = head): void {
  const b = sim.craft.body;
  const yaw = Math.atan2(look.x - p.x, -(look.z - p.z));
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
  b.setTranslation(p, true);
  b.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);
}
/** A world where the player flies for a team that doesn't hold the site's district (its turret is an enemy). */
function world(def = JET): Simulation {
  const sim = new Simulation(def);
  sim.traffic.enabled = false;
  sim.groundTurrets.density = 1;
  sim.setTeam((((baseOwner(site.ci, site.cj) ?? 0) + 1) % 3) as Team);
  return sim;
}
const turretAt = (sim: Simulation) => sim.groundTurrets.turrets.find((t) => t.site.id === site.id && t.derezAt === null);
/** A spot `d` m from the turret, `up` m above it, on the side with the clearest view. */
function vantage(d: number, up: number): THREE.Vector3 {
  let best = new THREE.Vector3(), bestTop = Infinity;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const p = new THREE.Vector3(site.x + Math.sin(a) * d, head.y + up, site.z - Math.cos(a) * d);
    if (!lineOfSight(head, p)) continue;
    const top = Math.max(terrainHeight(p.x, p.z), obstacleTop(p.x, p.z));
    if (top < bestTop) { best = p; bestTop = top; }
  }
  return best;
}

// ---------------------------------------------------------------- 2. streaming
console.log('--- streaming');
{
  const sim = world(TEST_PLANE);
  const near = vantage(900, 250);
  for (let i = 0; i < 150; i++) { hold(sim, near); sim.step(idle); }
  check(!!turretAt(sim), 'a turret comes live on its tower as the player nears', `${sim.groundTurrets.live().length} live`);
  const far = near.clone().add(new THREE.Vector3(9000, 0, 0));
  for (let i = 0; i < 150; i++) { hold(sim, far); sim.step(idle); }
  check(!sim.groundTurrets.turrets.some((t) => t.site.id === site.id), 'and goes when the player leaves');
  for (let i = 0; i < 150; i++) { hold(sim, near); sim.step(idle); }
  const t = turretAt(sim)!;
  sim.derezTurret(t, false); // (no side's kill: no capture)
  for (let i = 0; i < 150; i++) { hold(sim, far); sim.step(idle); }
  for (let i = 0; i < 150; i++) { hold(sim, near); sim.step(idle); }
  check(!turretAt(sim) && sim.groundTurrets.destroyed.has(site.id), 'a destroyed turret stays down after leaving and coming back');
  sim.resetToRunway(); allAtWar();
  for (let i = 0; i < 150; i++) { hold(sim, near); sim.step(idle); }
  check(!!turretAt(sim), 'and is back after a world reset');
}

// ---------------------------------------------------------------- 3, 4. fire control
console.log('--- fire control');
{
  const sim = world(TEST_PLANE);
  const p = vantage(1000, 300);
  for (let i = 0; i < 120 * 6; i++) { hold(sim, p); sim.step(idle); }
  const t = turretAt(sim)!;
  const want = Math.atan2(p.x - head.x, -(p.z - head.z));
  const off = Math.abs(Math.atan2(Math.sin(want - t.pose.yaw), Math.cos(want - t.pose.yaw))) * 180 / Math.PI;
  check(t.state === 'tracking' && off < 5, 'an unarmed craft in view is tracked', `${t.state}, ${off.toFixed(1)}° off`);
  check(t.weapons.fired === 0 && sim.hitsTaken === 0, 'but never fired on', `${t.weapons.fired} rounds`);
}
function fight(seconds: number) {
  const sim = world(JET);
  const p = vantage(1200, 300);
  let homing = 0, trace = '';
  for (let i = 0; i < 120 * seconds && !sim.exploded; i++) {
    hold(sim, p);
    sim.step(idle);
    const t = turretAt(sim);
    if (!t) continue;
    for (const q of t.weapons.projectiles) if (q.kind === 'missile' && q.target === sim.selfTarget) homing++;
    if (i % 120 === 0) trace += `${t.pose.yaw.toFixed(4)},${t.pose.pitch.toFixed(4)},${t.weapons.fired};`;
  }
  return { sim, homing, trace, t: sim.groundTurrets.turrets.find((x) => x.site.id === site.id) };
}
{
  const { sim, homing, t } = fight(40);
  check(!!t && t.weapons.fired > 10, 'an armed craft in view is fired on', `${t?.weapons.fired ?? 0} rounds`);
  check(sim.hitsTaken > 0, 'and hit', `${sim.hitsTaken} hits${sim.exploded ? `, shot down (${sim.derezCause})` : ''}`);
  check(homing > 0, 'and sent a homing missile');
}

// ---------------------------------------------------------------- 5. line of sight
console.log('--- line of sight');
{
  const low = (dx: number) => new THREE.Vector3(site.x + dx, terrainHeight(site.x + dx, site.z) + 4, site.z);
  const a = low(-260), b = low(260);
  check(!lineOfSight(a, b), 'a line through the tower is blocked');
  check(lineOfSight(a.clone().setY(site.y + 400), b.clone().setY(site.y + 400)), 'one high over it is clear');
}

// ---------------------------------------------------------------- 6. shooting one down
console.log('--- shooting one down');
{
  const sim = world(JET);
  sim.weapons.arm(JET, 'guns');
  const gunY = sim.weapons.mounts[0].offset.y;
  const p = head.clone().add(new THREE.Vector3(0, -gunY - 1.2, 0));
  const dir = vantage(140, 0).sub(head).setY(0).normalize();
  p.addScaledVector(dir, 140);
  for (let i = 0; i < 150; i++) { hold(sim, p); sim.step(idle); }
  const t = turretAt(sim)!;
  for (const x of sim.groundTurrets.turrets) { x.weapons.mounts.length = 0; x.weapons.projectiles.length = 0; } // (test only: none shoot back, so the craft lives to finish the job)
  let afterFirst = -1, shots = 0;
  const kills = sim.airTraffic.kills;
  for (let k = 0; k < 40 && t.derezAt === null && !sim.exploded; k++) {
    hold(sim, p);
    sim.step(idle);
    sim.fireWeapon('primary');
    shots++;
    for (let j = 0; j < 30; j++) { hold(sim, p); sim.step(idle); }
    if (afterFirst < 0 && t.hp < t.maxHp) afterFirst = t.hp;
  }
  check(afterFirst > 0, 'a turret survives a gun hit', `${afterFirst}/${t.maxHp} hit points left`);
  check(t.derezAt !== null && sim.airTraffic.kills === kills + 1, 'enough hits derez it, and the kill counts', `${shots} rounds, hp ${t.hp}, exploded ${sim.exploded} (${sim.derezCause}), kills +${sim.airTraffic.kills - kills}`);
}

// ---------------------------------------------------------------- 7. tower falls
console.log('--- tower falls');
{
  const sim = world(TEST_PLANE);
  const p = vantage(900, 250);
  for (let i = 0; i < 150; i++) { hold(sim, p); sim.step(idle); }
  const g = sim.staticWorld.structures.groups.find((x) => x.arch === site.structureId);
  check(!!g, 'the tower is a structure group');
  if (g) sim.staticWorld.fractured.set(g.id, {} as never);
  for (let i = 0; i < 10; i++) { hold(sim, p); sim.step(idle); }
  if (g) sim.staticWorld.fractured.delete(g.id);
  check(!turretAt(sim) && sim.groundTurrets.destroyed.has(site.id), 'when it fractures its turret goes with it');
}

// ---------------------------------------------------------------- 8. lock, radar, determinism
console.log('--- lock, radar, determinism');
{
  const sim = world(JET);
  const p = vantage(900, 250);
  for (let i = 0; i < 150; i++) { hold(sim, p); sim.step(idle); }
  check(sim.lockTargets().some((x) => x.id === `turret:${site.id}` && x.kind === 'turret'), 'turrets are lock targets');
  check(simContacts(sim).some((c) => c.kind === 'turret' && c.id === `turret:${site.id}`), 'and radar contacts');
  const a = fight(15).trace, b = fight(15).trace;
  check(a.length > 0 && a === b, 'the same seed gives the same fight');
}

// ---------------------------------------------------------------- 9. railgun turrets
console.log('--- railgun turrets');
{
  const all: TurretSite[] = [];
  // (Away from the central airfields, where turrets keep out of reach of the runways.)
  for (let ci = 14; ci < 24; ci++) for (let cj = 14; cj < 24; cj++) all.push(...turretSites(ci, cj, 2));
  const rails = all.filter((s) => s.kind === 'rail');
  const tall = all.filter((s) => s.y >= 120), tallRails = tall.filter((s) => s.kind === 'rail');
  check(rails.length > all.length * 0.15 && rails.length < all.length * 0.5, 'about a quarter of the turrets are railgun turrets', `${rails.length} of ${all.length}`);
  check(tall.length === 0 || tallRails.length / tall.length > rails.length / all.length, 'more of them on the tallest towers', `${tallRails.length} of ${tall.length} tall`);
  check(validateCraft(turretDef(1, 'rail')).length === 0, 'the railgun turret is a valid craft definition');
  const rs = rails.find((s) => s.y < 200 && (baseOwner(s.ci, s.cj) ?? null) !== null)!;
  const rhead = new THREE.Vector3(rs.x, rs.y + TURRET_HEAD_Y, rs.z);
  // A spot 3 km out (beyond a gun turret's 2.5 km), high up with a clear line.
  let far = new THREE.Vector3();
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const p = new THREE.Vector3(rs.x + Math.sin(a) * 3000, rhead.y + 700, rs.z - Math.cos(a) * 3000);
    if (lineOfSight(rhead, p)) { far = p; break; }
  }
  const scene = (def: typeof JET) => {
    const sim = new Simulation(def);
    sim.traffic.enabled = false;
    sim.groundTurrets.density = 2;
    sim.setTeam((((baseOwner(rs.ci, rs.cj) ?? 0) + 1) % 3) as Team);
    return sim;
  };
  const railAt = (sim: Simulation) => sim.groundTurrets.turrets.find((t) => t.site.id === rs.id && t.derezAt === null);
  const sim = scene(JET);
  let charged = 0, shots: number[] = [];
  for (let i = 0; i < 120 * 30 && !sim.exploded; i++) {
    hold(sim, far, rhead);
    sim.step(idle);
    const t = railAt(sim);
    if (!t) continue;
    if (t.state === 'charging') charged++;
    const last = t.weapons.mounts[0]?.lastFired;
    if (last !== undefined && last !== shots.at(-1)) shots.push(last);
  }
  const gaps = shots.slice(1).map((s, i) => s - shots[i]);
  check(shots.length > 0, 'a railgun turret fires at an armed enemy 3 km away', `${shots.length} shots`);
  check(charged > 0 && gaps.every((g) => g >= 2.49), 'it charges before each shot, no faster than one every 2.5 s', gaps.length ? `gaps ${Math.min(...gaps).toFixed(2)} s and up` : '');
  check(sim.hitsTaken > 0, 'and hits', `${sim.hitsTaken} hits${sim.exploded ? ', shot down' : ''}`);
  const calm = scene(TEST_PLANE);
  let fired = 0;
  for (let i = 0; i < 120 * 10; i++) { hold(calm, far, rhead); calm.step(idle); fired = railAt(calm)?.weapons.fired ?? fired; }
  check(fired === 0 && railAt(calm)?.target?.kind === 'player', 'it watches an unarmed craft but holds fire');
  const emp = scene(JET);
  for (let i = 0; i < 120; i++) { hold(emp, far, rhead); emp.step(idle); }
  emp.detonateEmp(rhead.x, rhead.y, rhead.z, true);
  const before = railAt(emp)!.weapons.fired;
  for (let i = 0; i < 120 * 8; i++) { hold(emp, far, rhead); emp.step(idle); }
  check(railAt(emp)!.weapons.fired === before, 'an EMP silences it');
}

// ---------------------------------------------------------------- 10. airfields are safe
console.log('--- airfields');
{
  // No turret stands where it could reach a runway (districts round every runway).
  const runways = landingSites().filter((s) => s.kind === 'runway');
  const seen = new Set<string>();
  let worst = { d: Infinity, kind: '' };
  for (const r of runways) for (let dx = -6000; dx <= 6000; dx += 1300) for (let dz = -6000; dz <= 6000; dz += 1300) {
    const [ci, cj] = chunkAt(r.x + dx, r.z + dz);
    if (seen.has(`${ci},${cj}`)) continue;
    seen.add(`${ci},${cj}`);
    for (const s of turretSites(ci, cj, 2)) {
      const d = runwayDistance(s.x, s.z) - (s.kind === 'rail' ? AIRFIELD_CLEAR.rail : AIRFIELD_CLEAR.gun);
      if (d < worst.d) worst = { d, kind: s.kind };
    }
  }
  check(worst.d >= 0, 'no turret can reach a runway (railguns 3.8 km clear, guns 2.1 km)', `closest margin ${Math.round(worst.d)} m (${worst.kind}), ${seen.size} districts`);
  // An armed craft sitting on the runway, then 20 s of spawn grace: nothing fires at it.
  for (const team of [0, 1, 2] as const) {
    const sim = new Simulation(TEST_PLANE);
    sim.setTeam(team);
    sim.traffic.enabled = false;
    sim.airTraffic.pool = [JET];
    sim.airTraffic.enemies = 4;
    sim.groundTurrets.density = 2;
    sim.weapons.arm(TEST_PLANE, 'missiles');
    // Steps in which anything was attacking the craft: an aircraft on it, a turret firing at it.
    let shotAt = 0;
    for (let i = 0; i < 120 * 25; i++) {
      sim.step(idle);
      if (sim.airTraffic.flyers.some((f) => f.derezAt === null && f.target?.kind === 'player')
        || sim.groundTurrets.turrets.some((t) => t.derezAt === null && t.target?.kind === 'player' && (t.state === 'firing' || t.state === 'charging'))) shotAt++;
    }
    check(!sim.exploded && sim.hitsTaken === 0 && shotAt === 0, `team ${sim.team}: armed on the runway, nothing attacks the craft`, `${shotAt} steps under attack, hits ${sim.hitsTaken}`);
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
