/**
 * Teams, territory, the AI war, freelancers and mercenaries, headless. Run with `npm run teams`.
 *
 * 1. Liveries: each side's craft uses only its light and its body set, within the light budget.
 * 2. Territory: deterministic; each team holds a good share; patches are contiguous.
 * 3. Turrets: one in your territory never fires on you; one in enemy territory does (armed).
 * 4. The AI war: enemy teams fight each other; friendlies go for an enemy attacking the player.
 * 5. No friendly fire: your rounds don't hurt your side, your side's don't hurt you.
 * 6. Capture: the last enemy turret of a district falling to you flips it, its turrets come back
 *    in your colours 20 s later, credits are paid; a world reset restores the map.
 * 7. AI aircraft attack enemy turrets; an AI team can capture; freelancers fight everyone and
 *    never capture.
 * 8. Mercenaries: hiring costs credits, needs enough, at most three; they escort, fight for you,
 *    never your team, and leave when the contract ends.
 * 9. The lock skips your side; the same seed gives the same war.
 */
import * as THREE from 'three';
import { GRID } from '../src/arch/grid.ts';
import { BUILTINS } from '../src/craft/builtins.ts';
import { JET } from '../src/craft/jet.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { BODY_COOL, BODY_WARM, LIGHTS } from '../src/craft/style1982.ts';
import { MAX_MERCS, type AiFlyer } from '../src/sim/aiTraffic.ts';
import { lineOfSight, turretSites, TURRET_HEAD_Y, type TurretSite } from '../src/sim/groundTurrets.ts';
import { CREDITS, mercPrice } from '../src/sim/mercenaries.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { FREELANCER, hostile, sideLivery, TEAMS, type Side, type Team } from '../src/sim/teams.ts';
import { baseOwner } from '../src/sim/territory.ts';
import { terrainHeight } from '../src/sim/terrain.ts';
import { obstacleTop } from '../src/world/structures.ts';
import type { WeaponImpact } from '../src/sim/weapons.ts';
import { allAtWar, atWar, resetDiplomacy } from '../src/sim/teams.ts';
// The world starts at peace; these checks test fighting, so every team is at war with every other.
allAtWar();

await initPhysics();
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};
const idle = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };
const pool = BUILTINS.map((b) => b.craft);

// ---------------------------------------------------------------- 1. liveries
console.log('--- liveries');
{
  const area = (p: (typeof JET.parts)[number]) => (p.shape.type === 'box' ? p.shape.size[0] * p.shape.size[1] + p.shape.size[1] * p.shape.size[2] + p.shape.size[0] * p.shape.size[2] : p.shape.type === 'sphere' ? 6 * p.shape.radius ** 2 : 4 * p.shape.radius * p.shape.length);
  let ok = true, worst = 0, detail = '';
  const sides: Array<[Side, boolean]> = [[0, false], [1, false], [2, false], [FREELANCER, false], [0, true]];
  for (const [side, merc] of sides) for (const raw of pool) {
    const def = sideLivery(raw, side, merc);
    const light = merc ? LIGHTS[1] : side === FREELANCER ? LIGHTS[5] : TEAMS[side].light;
    const bodies = side === 1 && !merc ? BODY_WARM : BODY_COOL;
    const allowed = new Set<string>([light, ...bodies]);
    const bad = def.parts.filter((p) => !allowed.has(p.color));
    if (bad.length) { ok = false; detail = `${def.name} as ${merc ? 'merc' : side}: ${bad[0].id} ${bad[0].color}`; }
    const total = def.parts.reduce((s, p) => s + area(p), 0);
    worst = Math.max(worst, def.parts.reduce((s, p) => s + (p.color === light ? area(p) : 0), 0) / total);
  }
  check(ok, 'every side wears only its own light and body colours', detail);
  check(worst < 0.3, 'light stays selective in every livery', `at most ${(worst * 100).toFixed(0)}% lit`);
}

// ---------------------------------------------------------------- 2. territory
console.log('--- territory');
{
  const n = GRID.chunks;
  const counts = [0, 0, 0];
  let same = 0, land = 0, again = true;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const t = baseOwner(i, j);
    if (t !== baseOwner(i, j)) again = false;
    if (t === null) continue;
    counts[t]++;
    land++;
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => baseOwner(i + a, j + b) === t)) same++;
  }
  check(again, 'the starting map is the same every time');
  check(counts.every((c) => c > land * 0.25), 'each team holds a good share of the land', counts.map((c, t) => `${TEAMS[t].name} ${c}`).join(', '));
  check(same / land > 0.95, 'territory comes in contiguous patches', `${((same / land) * 100).toFixed(0)}% of districts border one of their own`);
}

// The checks below play out round one turret site with clear air around it.
const sites: TurretSite[] = [];
for (let ci = 0; ci < 8; ci++) for (let cj = 0; cj < 8; cj++) sites.push(...turretSites(ci, cj, 1));
const site = sites.find((s) => s.y < 200 && baseOwner(s.ci, s.cj) !== null)!;
const owner = baseOwner(site.ci, site.cj)!;
const other = ((owner + 1) % 3) as Team;
const head = new THREE.Vector3(site.x, site.y + TURRET_HEAD_Y, site.z);
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
function hold(sim: Simulation, p: THREE.Vector3): void {
  const b = sim.craft.body;
  b.setTranslation(p, true);
  b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);
}
function world(def = JET, team: Team = 0, turrets = 1): Simulation {
  const sim = new Simulation(def);
  sim.traffic.enabled = false;
  sim.airTraffic.pool = pool;
  sim.groundTurrets.density = turrets as 0 | 1;
  sim.setTeam(team);
  return sim;
}
const turretAt = (sim: Simulation) => sim.groundTurrets.turrets.find((t) => t.site.id === site.id && t.derezAt === null);
const run = (sim: Simulation, seconds: number, at: THREE.Vector3, each?: () => void) => {
  for (let i = 0; i < 120 * seconds && !sim.exploded; i++) { hold(sim, at); each?.(); sim.step(idle); }
};

// ---------------------------------------------------------------- 3. turrets take sides
console.log('--- turrets take sides');
{
  const p = vantage(1000, 300);
  const friend = world(JET, owner);
  run(friend, 20, p);
  const t = turretAt(friend)!;
  check(!!t && t.side === owner && t.weapons.fired === 0 && t.target?.kind !== 'player', `a ${TEAMS[owner].name} turret never fires on a ${TEAMS[owner].name} craft`, `${t?.weapons.fired} rounds`);
  const foe = world(JET, other);
  run(foe, 30, p);
  const u = foe.groundTurrets.turrets.find((x) => x.site.id === site.id);
  check(!!u && u.weapons.fired > 0 && foe.hitsTaken > 0, `the same turret fires on an armed ${TEAMS[other].name} craft`, `${u?.weapons.fired} rounds, ${foe.hitsTaken} hits`);
}

// ---------------------------------------------------------------- 4, 9. the AI war
console.log('--- the AI war');
function war(seconds: number) {
  const sim = world(TEST_PLANE, 0, 0);
  sim.airTraffic.enemies = 4;
  const at = new THREE.Vector3(0, 900, -2600);
  let duels = 0, fired = 0, trace = '';
  const seen = new Set<string>();
  run(sim, seconds, at, () => {
    if (Math.round(sim.time * 120) % 120) return;
    for (const f of sim.airTraffic.combatFlyers()) {
      if (f.target?.kind === 'flyer' && f.target.flyer && f.target.side !== f.side) { duels++; seen.add(`${f.side}>${f.target.side}`); }
      trace += `${f.pos.x.toFixed(1)},${f.pos.z.toFixed(1)};`;
    }
  });
  for (const f of sim.airTraffic.flyers) fired += f.weapons?.fired ?? 0;
  return { sim, duels, fired, trace, seen };
}
{
  const { sim, duels, fired, seen } = war(120);
  const teams = new Set(sim.airTraffic.combatFlyers().map((f) => f.side));
  check(teams.has(1) && teams.has(2) && !teams.has(0), 'enemies come from both other teams', [...teams].join(','));
  check(duels > 0 && seen.has('1>2') && seen.has('2>1'), 'Red and Amber aircraft fight each other', [...seen].join(' '));
  check(fired > 0 && sim.hitsTaken === 0, 'rounds fly, and none at the unarmed player', `${fired} rounds, ${sim.airTraffic.derezzed} shot down`);
  check(war(30).trace === war(30).trace, 'the same seed gives the same war');
}
{
  const sim = world(JET, 0, 0);
  sim.airTraffic.friendlies = 2;
  sim.airTraffic.enemies = 2;
  const at = new THREE.Vector3(0, 900, -2600);
  let guarded = 0, onTeam = 0;
  run(sim, 120, at, () => {
    for (const f of sim.airTraffic.combatFlyers()) {
      if (f.side !== 0) continue;
      if (f.target?.flyer?.target?.kind === 'player') guarded++;
      if (f.target && !hostile(0, f.target.side)) onTeam++;
    }
  });
  check(guarded > 0, 'friendlies go for an enemy attacking the player');
  check(onTeam === 0, 'and never fight their own team');
  const ids = new Set(sim.lockTargets().map((t) => t.id));
  check(sim.airTraffic.combatFlyers().filter((f) => f.side === 0).every((f) => !ids.has(f.handle.id)), 'the lock skips friendly aircraft');
}

// ---------------------------------------------------------------- 5. friendly fire
console.log('--- friendly fire');
{
  const sim = world(JET, 0, 0);
  sim.airTraffic.friendlies = 1;
  sim.airTraffic.enemies = 1;
  const at = new THREE.Vector3(0, 900, -2600);
  run(sim, 1, at);
  const friend = sim.airTraffic.combatFlyers().find((f) => f.side === 0)!;
  const enemy = sim.airTraffic.combatFlyers().find((f) => f.side !== 0)!;
  const impact = (onto: THREE.Vector3, collider: unknown): WeaponImpact => ({ kind: 'gun', point: onto.clone(), normal: new THREE.Vector3(0, 1, 0), vel: new THREE.Vector3(0, 0, -600), mass: 0.05, blast: 1.6, color: '#fff', collider: collider as never, time: sim.time });
  const hit = (h: WeaponImpact, by?: AiFlyer) => (sim as unknown as { weaponImpact(h: WeaponImpact, s?: AiFlyer): void }).weaponImpact(h, by);
  const col = (f: AiFlyer) => f.body.collider(0);
  hit(impact(friend.pos, col(friend)));
  check(friend.hp === friend.maxHp, 'your rounds don\'t hurt a friendly aircraft');
  hit(impact(enemy.pos, col(enemy)));
  check(enemy.hp < enemy.maxHp, 'they do hurt an enemy');
  const part = sim.craft.body.collider(0);
  hit(impact(sim.position, part), friend);
  check(sim.hitsTaken === 0, 'a friendly\'s round doesn\'t hurt you');
  hit(impact(sim.position, part), enemy);
  check(sim.hitsTaken === 1, 'an enemy\'s does');
}

// ---------------------------------------------------------------- 6. capture and credits
console.log('--- capture');
{
  const sim = world(TEST_PLANE, other);
  const p = vantage(900, 250);
  run(sim, 1.5, p);
  sim.credits = 0;
  const district = sim.groundTurrets.turrets.filter((t) => t.site.ci === site.ci && t.site.cj === site.cj);
  for (const t of district) sim.derezTurret(t, true);
  check(sim.groundTurrets.territory.ownerOf(site.ci, site.cj) === other, `destroying the district's last ${TEAMS[owner].name} turret makes it ${TEAMS[other].name}`);
  check(sim.credits === CREDITS.turret * district.length + CREDITS.capture, 'and pays for the turrets and the capture', `${sim.credits} credits`);
  run(sim, 5, p);
  check(!turretAt(sim), 'its turrets stay down a while');
  run(sim, 17, p);
  const back = turretAt(sim);
  check(!!back && back.side === other, `then rise again in ${TEAMS[other].name} colours`, back ? `side ${back.side}` : 'none');
  sim.resetToRunway(); allAtWar();
  check(sim.groundTurrets.territory.ownerOf(site.ci, site.cj) === owner, 'a world reset restores the map');
}

// ---------------------------------------------------------------- 7. AI vs turrets, freelancers
console.log('--- AI against turrets; freelancers');
{
  // The player, unarmed and on the turret's side, watches the other teams' aircraft attack it.
  const sim = world(TEST_PLANE, owner);
  sim.airTraffic.enemies = 4;
  const p = vantage(700, 400);
  let hitByAi = false, raid = 0;
  run(sim, 180, p, () => {
    // The player is unarmed: any damage to a turret is the AI's.
    if (sim.groundTurrets.turrets.some((t) => t.hp < t.maxHp) || sim.groundTurrets.derezzed > 0) hitByAi = true;
    for (const f of sim.airTraffic.combatFlyers()) if (f.target?.kind === 'turret') raid++;
  });
  check(raid > 0, 'enemy aircraft go after enemy turrets');
  check(hitByAi, 'and hit them', `${sim.groundTurrets.derezzed} destroyed, ${sim.airTraffic.derezzed} aircraft lost`);
  const c = world(TEST_PLANE, owner);
  run(c, 1.5, p);
  const ai = ((owner + 2) % 3) as Team;
  for (const t of c.groundTurrets.turrets.filter((x) => x.site.ci === site.ci && x.site.cj === site.cj)) c.derezTurret(t, false, ai);
  check(c.groundTurrets.territory.ownerOf(site.ci, site.cj) === ai, 'an AI team takes a district when its aircraft destroy the last turret');
  const d = world(TEST_PLANE, owner);
  run(d, 1.5, p);
  for (const t of d.groundTurrets.turrets.filter((x) => x.site.ci === site.ci && x.site.cj === site.cj)) d.derezTurret(t, false, FREELANCER);
  check(d.groundTurrets.territory.ownerOf(site.ci, site.cj) === owner, 'freelancers never capture');
}
{
  const sim = world(TEST_PLANE, 0, 0);
  sim.airTraffic.enemies = 2;
  sim.airTraffic.freelancers = 2;
  const at = new THREE.Vector3(0, 900, -2600);
  let freeHunts = 0, hunted = 0;
  run(sim, 120, at, () => {
    for (const f of sim.airTraffic.combatFlyers()) {
      if (f.side === FREELANCER && f.target?.kind === 'flyer' && f.target.side !== FREELANCER) freeHunts++;
      if (f.side !== FREELANCER && f.target?.side === FREELANCER) hunted++;
    }
  });
  check(sim.airTraffic.combatFlyers().some((f) => f.side === FREELANCER && f.color === LIGHTS[5]), 'freelancers fly in white');
  check(freeHunts > 0 && hunted > 0, 'they fight the teams, and the teams fight them');
}

// ---------------------------------------------------------------- 8. mercenaries
console.log('--- mercenaries');
{
  const sim = world(JET, 0, 0);
  sim.airTraffic.enemies = 1;
  const at = new THREE.Vector3(0, 900, -2600);
  run(sim, 1, at);
  sim.credits = 0;
  const enemy = sim.airTraffic.combatFlyers().find((f) => f.side !== 0)!;
  sim.derezFlyer(enemy, true);
  check(sim.credits === CREDITS.aircraft, 'a kill pays', `${sim.credits} credits`);
  const price = mercPrice(JET);
  check(sim.hireMercenary(JET) !== null && sim.airTraffic.mercs().length === 0, 'hiring needs enough credits', `${price} needed`);
  sim.credits = price * 4;
  check(sim.hireMercenary(JET) === null && sim.credits === price * 3, 'hiring takes the price', `${price} credits`);
  sim.hireMercenary(TEST_PLANE);
  sim.hireMercenary(JET);
  check(sim.hireMercenary(JET) !== null && sim.airTraffic.mercs().length === MAX_MERCS, `at most ${MAX_MERCS} at once`);
  let near = 0, wrong = 0, fighting = 0;
  run(sim, 90, at, () => {
    for (const m of sim.airTraffic.mercs()) {
      if (m.pos.distanceTo(sim.position) < 2500) near++;
      if (m.target && !hostile(0, m.target.side)) wrong++;
      if (m.target?.kind === 'flyer') fighting++;
    }
  });
  const ms = sim.airTraffic.mercs();
  check(ms.every((m) => m.color === LIGHTS[1] && m.side === 0), 'mercenaries fly for you, in blue');
  check(near > 0 && fighting > 0 && wrong === 0, 'they escort, fight your enemies, never your team', `${fighting} samples fighting`);
  for (const m of ms) m.mercUntil = sim.time;
  run(sim, 60, at);
  check(sim.airTraffic.mercs().length === 0 && !sim.airTraffic.flyers.some((f) => f.role === 'merc' && f.pos.distanceTo(sim.position) < 4000), 'when the contract ends they leave');
}

// ---------------------------------------------------------------- the world starts at peace
console.log('--- the world starts at peace');
{
  resetDiplomacy();
  check(!hostile(0, 1) && !hostile(1, 2) && !hostile(0, 2) && hostile(FREELANCER, 0), 'at the start no two teams fight (freelancers still fight anyone)');
  // An armed craft beside another team's turret: at peace it holds fire.
  const p = vantage(1000, 300);
  const calm = world(JET, other);
  resetDiplomacy();
  calm.airTraffic.freelancers = 2;
  run(calm, 30, p);
  const u = calm.groundTurrets.turrets.find((x) => x.site.id === site.id);
  check(!!u && u.weapons.fired === 0 && calm.hitsTaken === 0, `a ${TEAMS[owner].name} turret holds fire on an armed ${TEAMS[other].name} craft at peace`, `${u?.weapons.fired} rounds`);
  check(!calm.airTraffic.flyers.some((f) => f.role === 'free' && f.derezAt === null), 'no freelancers come out while the world is at peace');
  check(calm.lockTargets().some((t) => t.id === u?.handle.id), 'its turret can still be locked (firing is what starts a war)');
  // Fire on it: war with that team only.
  const w = world(TEST_PLANE, 0, 0);
  resetDiplomacy();
  check(w.applyRemoteHit({ id: 'red-player', team: 1 }, 'gun', w.position.clone()) !== 'team' && atWar(0, 1) && !atWar(0, 2), 'a Red player opening fire starts war with Red, not Amber');
  check(w.ceaseFire(1) !== null && atWar(0, 1), 'a cease fire is refused while shots are still flying');
  for (let i = 0; i < 120 * 31; i++) w.step(idle);
  check(w.ceaseFire(1) === null && !atWar(0, 1), 'after 30 s of quiet the cease fire holds');
  check(w.declareWar(2) === null && atWar(0, 2) && w.diplomacyEvents.some((d) => d.b === 2 && d.on), 'declaring war on Amber is sent to the room');
  w.resetToRunway();
  check(!atWar(0, 2) && !atWar(0, 1), 'a world reset restores peace');
  allAtWar();
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
