/**
 * Networked damage between players, headless (the parts that run in one game; the relay is
 * covered by `npm run test:server`). Run with `npm run netdamage`.
 *
 * 1. Hit tests: a round's flight segment hits a sphere and misses beside it; a fast round can't
 *    tunnel through.
 * 2. The shooter's scanner: a round crossing another player is reported (and removed); a railgun
 *    reports every player on its line, up to three; a blast near one reports it.
 * 3. The victim's game: an enemy's hit damages the craft; a team-mate's, a far-off one and a
 *    flood past the rate cap are refused; a warhead against it derezzes it; the hit is
 *    remembered for the kill.
 */
import * as THREE from 'three';
import { JET } from '../src/craft/jet.ts';
import { segmentHitsSphere, ShotScanner } from '../src/net/hits.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { WeaponSystem } from '../src/sim/weapons.ts';

await initPhysics();
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

console.log('--- hit tests');
{
  const c = v(0, 0, -100);
  const t = segmentHitsSphere(v(0, 0, 0), v(0, 0, -200), c, 5);
  check(t !== null && Math.abs(t - 0.475) < 1e-6, 'a segment through a sphere hits it where it enters', `t = ${t?.toFixed(3)}`);
  check(segmentHitsSphere(v(6, 0, 0), v(6, 0, -200), c, 5) === null, 'one passing beside it misses');
  check(segmentHitsSphere(v(0, 0, -50), v(0, 0, -90), c, 5) === null, 'one that stops short misses');
  check(segmentHitsSphere(v(0, 0, 0), v(0, 0, -1000), c, 2) !== null, 'a fast round (1 km in a step) can\'t tunnel through');
}

console.log('--- the shooter\'s scanner');
{
  const w = new WeaponSystem();
  const sc = new ShotScanner();
  const target = { id: 'B', pos: v(0, 0, -300), radius: 4 };
  const p = { id: 1, kind: 'gun' as const, bounces: 0, pos: v(0, 0, -100), vel: v(0, 0, -600), heading: v(0, 0, -1), age: 0, color: '#fff', target: null };
  w.projectiles.push(p);
  check(sc.scan(w, [target]).length === 0, 'first sight of a round: nothing yet');
  p.pos.set(0, 0, -400);
  const hits = sc.scan(w, [target]);
  check(hits.length === 1 && hits[0].target === 'B' && hits[0].kind === 'gun' && Math.abs(hits[0].point.z + 296) < 0.5, 'a round crossing another player is reported where it struck', hits[0] ? `at z ${hits[0].point.z.toFixed(1)}` : 'none');
  check(!w.projectiles.includes(p), 'and the round ends there');
  // A railgun line through four players: three are reported.
  const line = [1, 2, 3, 4].map((k) => ({ id: `P${k}`, pos: v(0, 0, -200 * k), radius: 4 }));
  w.beams.push({ a: v(0, 0, 0), b: v(0, 0, -4000), time: 0, color: '#fff', kind: 'rail' });
  const rail = sc.scan(w, line);
  check(rail.map((h) => h.target).join(',') === 'P1,P2,P3', 'a railgun slug reports the first three players on its line', rail.map((h) => h.target).join(','));
  w.beams.push({ a: v(0, 0, 0), b: v(0, 0, -4000), time: 0, color: '#fff', kind: 'laser' });
  check(sc.scan(w, line).map((h) => h.target).join(',') === 'P1', 'a laser beam only the first');
  w.impacts.push({ kind: 'missile', point: v(8, 0, -200), normal: v(0, 1, 0), vel: v(0, 0, 0), mass: 60, blast: 10, color: '#fff', collider: null, time: 0 });
  check(sc.scan(w, line).map((h) => h.target).join(',') === 'P1', 'a missile going off beside a player reports it');
}

console.log('--- the victim\'s game');
{
  const sim = new Simulation(JET);
  sim.traffic.enabled = false;
  sim.setTeam(0);
  const hold = () => {
    const b = sim.craft.body;
    b.setTranslation({ x: 0, y: 800, z: -2600 }, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  };
  for (let i = 0; i < 30; i++) { hold(); sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 }); }
  const total = () => [...sim.damage.hp.values()].filter(Number.isFinite).reduce((s, x) => s + x, 0);
  const before = total();
  const at = sim.position.clone().add(v(0, 0, -2));
  check(sim.applyRemoteHit({ id: 'R1', team: 1 }, 'gun', at) === 'applied' && total() < before, 'an enemy\'s round damages the craft');
  check(sim.lastRemoteHit?.id === 'R1', 'and is remembered for the kill');
  const after = total();
  check(sim.applyRemoteHit({ id: 'C1', team: 0 }, 'gun', at) === 'team' && total() === after, 'a team-mate\'s is refused');
  check(sim.applyRemoteHit({ id: 'R1', team: 1 }, 'gun', sim.position.clone().add(v(0, 0, -400))) === 'far', 'so is one far from where the craft is');
  // A flood: 40 at once from one sender (in a fresh game, so the craft lives through it).
  const flood = new Simulation(JET);
  flood.setTeam(0);
  let refused = 0;
  for (let i = 0; i < 40; i++) if (flood.applyRemoteHit({ id: 'R2', team: 2 }, 'gun', flood.position.clone()) === 'rate') refused++;
  check(refused >= 19, 'a flood past 20 a second is cut off', `${refused} of 40 refused`);
  sim.applyRemoteHit({ id: 'R3', team: 2 }, 'missile', sim.position.clone().add(v(0, 3, 0)));
  check(sim.exploded && sim.derezCause === 'shot' && sim.lastRemoteHit?.id === 'R3', 'a missile going off against it derezzes it, R3\'s kill');
  sim.credits = 0;
  sim.creditRemoteKill('Bravo');
  check(sim.credits === 200, 'a kill reported back pays the shooter 200 credits');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
