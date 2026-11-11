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
import { lineOfSight, turretSites, TURRET_DEF, TURRET_HEAD_Y, type TurretSite } from '../src/sim/groundTurrets.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { terrainHeight } from '../src/sim/terrain.ts';
import { landingSites } from '../src/world/landingSites.ts';
import { obstacleTop } from '../src/world/structures.ts';
import { validateCraft } from '../src/craft/validate.ts';
import { BODY_WARM, LIGHTS } from '../src/craft/style1982.ts';

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
function world(def = JET): Simulation {
  const sim = new Simulation(def);
  sim.traffic.enabled = false;
  sim.groundTurrets.density = 1;
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
  sim.derezTurret(t, true);
  for (let i = 0; i < 150; i++) { hold(sim, far); sim.step(idle); }
  for (let i = 0; i < 150; i++) { hold(sim, near); sim.step(idle); }
  check(!turretAt(sim) && sim.groundTurrets.destroyed.has(site.id), 'a destroyed turret stays down after leaving and coming back');
  sim.resetToRunway();
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

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
