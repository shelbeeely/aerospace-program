/**
 * Enemy AI aircraft, headless. Run with `npm run enemies`.
 *
 * 1. Enemy aircraft are kept at their count beside the peaceful traffic: aeroplanes in their
 *    team's colours (the two teams the player isn't on), armed with guns and missiles.
 * 2. An unarmed player is left alone: no enemy hunts it or hits it (they fight each other).
 * 3. An armed player is hunted: they close, attack and fire, their rounds damage the craft, and
 *    they neither fly into the ground or a structure nor ram the player.
 * 4. A hostile takes several gun hits; shooting it down counts as a kill and another arrives.
 * 5. The same seed gives the same fight.
 */
import * as THREE from 'three';
import { BUILTINS } from '../src/craft/builtins.ts';
import { JET } from '../src/craft/jet.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { BODY_COOL, BODY_WARM, LIGHTS, redTeam } from '../src/craft/style1982.ts';
import { TEAMS } from '../src/sim/teams.ts';
import { flyerKind } from '../src/sim/aiTraffic.ts';
import { Autopilot } from '../src/sim/autopilot.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { terrainHeight } from '../src/sim/terrain.ts';
import { obstacleTop } from '../src/world/structures.ts';

await initPhysics();
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};
const idle = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };
const pool = BUILTINS.map((b) => b.craft);
const RED = LIGHTS[2];

// ---------------------------------------------------------------- 1, 2. unarmed: a patrol
console.log('--- unarmed player');
{
  const sim = new Simulation(TEST_PLANE);
  sim.traffic.enabled = false;
  sim.airTraffic.pool = pool;
  sim.airTraffic.count = 4;
  sim.airTraffic.enemies = 3;
  let left = 0;
  for (let i = 0; i < 120 * 90; i++) {
    sim.step(idle);
    if (i % 60 === 0 && sim.airTraffic.hostileFlyers().some((f) => f.target?.kind === 'player')) left++;
  }
  const hostiles = sim.airTraffic.hostileFlyers();
  const peaceful = sim.airTraffic.flyers.filter((f) => !f.hostile && f.derezAt === null);
  check(hostiles.length === 3 && peaceful.length === 4, 'three hostiles fly beside four peaceful aircraft', hostiles.map((f) => `${f.name} (${f.speed.toFixed(0)} m/s)`).join(', '));
  check(hostiles.every((f) => flyerKind(f.def) === 'airplane'), 'hostiles are aeroplanes');
  const palette = [...BODY_WARM, ...BODY_COOL, ...LIGHTS] as readonly string[];
  const worn = hostiles.every((f) => f.side !== null && f.side !== sim.team && f.side < 3 && f.color === TEAMS[f.side].light && f.def.parts.every((p) => palette.includes(p.color)));
  check(worn, 'they wear their own team\'s colours, of the two other teams', hostiles.map((f) => TEAMS[f.side as 0].name).join(', '));
  const lit = (def: typeof JET) => {
    const area = (p: (typeof def.parts)[number]) => (p.shape.type === 'box' ? p.shape.size[0] * p.shape.size[1] + p.shape.size[1] * p.shape.size[2] + p.shape.size[0] * p.shape.size[2] : p.shape.type === 'sphere' ? 6 * p.shape.radius ** 2 : 4 * p.shape.radius * p.shape.length);
    const all = def.parts.reduce((s, p) => s + area(p), 0);
    return def.parts.reduce((s, p) => s + ((LIGHTS as readonly string[]).includes(p.color) ? area(p) : 0), 0) / all;
  };
  const share = Math.max(...pool.filter((d) => flyerKind(d) === 'airplane').map((d) => lit(redTeam(d))));
  check(share < 0.3, 'light stays selective on every red-team design', `at most ${(share * 100).toFixed(0)}% lit`);
  check(hostiles.every((f) => f.weapons && f.weapons.mounts.some((m) => m.kind === 'gun') && f.weapons.mounts.some((m) => m.kind === 'missile')), 'each carries guns and missiles');
  check(sim.weapons.mounts.length === 0 && left === 0 && sim.hitsTaken === 0, 'they leave an unarmed craft alone', `${left} samples hunting it`);
}

// ---------------------------------------------------------------- 3. armed: the hunt
console.log('--- armed player');
function hunt(seconds: number) {
  const sim = new Simulation(JET);
  sim.traffic.enabled = false;
  sim.airTraffic.pool = pool;
  sim.airTraffic.enemies = 3;
  // Airborne at 600 m, flying a wide lazy circle.
  const b = sim.craft.body;
  b.setTranslation({ x: 0, y: 600, z: -2000 }, true);
  b.setLinvel({ x: 0, y: 0, z: -150 }, true);
  const ap = new Autopilot({ heading: 0, altitude: 600, airspeed: 150 });
  let t = sim.telemetry();
  let attacked = 0, minClear = Infinity, minRange = Infinity, trace = '', fired = 0;
  const rounds = new Map<number, number>();
  for (let i = 0; i < 120 * seconds && !sim.exploded; i++) {
    ap.targets.heading = (sim.time * 2) % 360;
    sim.step(ap.sample(sim.dt, t));
    t = sim.telemetry();
    if (i % 12 !== 0) continue;
    for (const f of sim.airTraffic.hostileFlyers()) {
      fired += (f.weapons?.fired ?? 0) - (rounds.get(f.id) ?? 0);
      rounds.set(f.id, f.weapons?.fired ?? 0);
      if (f.combat !== 'patrol') attacked++;
      minClear = Math.min(minClear, f.pos.y - Math.max(terrainHeight(f.pos.x, f.pos.z), obstacleTop(f.pos.x, f.pos.z)));
      minRange = Math.min(minRange, f.pos.distanceTo(sim.position));
    }
    if (i % 1200 === 0) trace += sim.airTraffic.hostileFlyers().map((f) => `${f.pos.x.toFixed(2)},${f.pos.y.toFixed(2)},${f.pos.z.toFixed(2)}`).join(';') + '|';
  }
  return { sim, attacked, minClear, minRange, trace, fired };
}
{
  const { sim, attacked, minClear, minRange, fired } = hunt(300);
  check(attacked > 0, 'hostiles turn on an armed craft');
  check(fired >= 1, 'they open fire when the nose is on (guns or a homing missile)', `${fired} rounds`);
  check(sim.hitsTaken > 0, 'their rounds strike the craft', `${sim.hitsTaken} hits, ${sim.failures.filter((f) => f.cause === 'weapon').length} parts shot off`);
  check(sim.exploded && sim.derezCause === 'shot', 'a craft that never evades is shot down', `after ${sim.time.toFixed(0)} s (${sim.derezCause ?? 'still flying'})`);
  check(minClear > 10, 'they stay clear of the ground and the structures', `closest ${minClear.toFixed(0)} m`);
  check(minRange > 15, 'they break off rather than ram', `closest pass ${minRange.toFixed(0)} m`);
  // Once the craft is gone they go back to their patrol.
  for (let i = 0; i < 120 * 3; i++) sim.step(idle);
  check(sim.airTraffic.hostileFlyers().every((f) => f.target?.kind !== 'player'), 'and they leave it be once it is down');
}

// ---------------------------------------------------------------- 4. hit points and kills
console.log('--- shooting one down');
{
  const sim = new Simulation(JET);
  sim.traffic.enabled = false;
  sim.airTraffic.pool = [JET];
  sim.airTraffic.enemies = 1;
  sim.weapons.arm(JET, 'guns');
  for (let i = 0; i < 30; i++) sim.step(idle);
  const f = sim.airTraffic.hostileFlyers()[0];
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(sim.rotation);
  const gunY = sim.weapons.mounts[0].offset.y;
  const park = () => {
    f.pos.copy(sim.position).addScaledVector(fwd, 150).add(new THREE.Vector3(0, gunY, 0));
    f.speed = 0;
    f.cruise = 0;
  };
  let afterFirst = -1, shots = 0;
  for (let k = 0; k < 20 && f.derezAt === null; k++) {
    park();
    sim.step(idle);
    sim.fireWeapon('primary');
    shots++;
    for (let j = 0; j < 40; j++) { park(); sim.step(idle); }
    if (afterFirst < 0 && f.hp < f.maxHp) afterFirst = f.hp;
  }
  check(afterFirst > 0, 'a hostile survives a gun hit', `${afterFirst}/${f.maxHp} hit points left`);
  check(f.derezAt !== null && shots >= f.maxHp, 'enough hits derez it', `${shots} rounds`);
  check(sim.airTraffic.kills === 1 && sim.explosions.some((e) => e.color === RED), 'the kill is counted, in a red flash');
  for (let i = 0; i < 120 * 3; i++) sim.step(idle);
  check(sim.airTraffic.hostileFlyers().length === 1, 'and another hostile takes its place');
}

// ---------------------------------------------------------------- 5. determinism
console.log('--- determinism');
{
  const a = hunt(40), b = hunt(40);
  check(a.trace.length > 0 && a.trace === b.trace, 'the same seed gives the same fight');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
