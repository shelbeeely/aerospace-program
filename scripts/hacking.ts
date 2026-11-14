/**
 * The hacking beam, headless. Run with `npm run hacking`.
 *
 * 1. Charges are bought (three for 600 credits, at most nine held) and spent.
 * 2. A locked enemy aircraft held in the beam for 3 s is taken over: it switches to your side
 *    and livery, its old side is now its enemy, and your rounds don't hurt it.
 * 3. The hack fails, free, if the beam breaks or the target is beyond 1.5 km.
 * 4. A hacked turret (4 s; half under an EMP) fires on its old side.
 * 5. A hacked light cycle's wall can't derez you.
 * 6. After 60 s each reverts.
 */
import * as THREE from 'three';
import { JET } from '../src/craft/jet.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { HACK } from '../src/sim/hacking.ts';
import { hostile } from '../src/sim/teams.ts';
import { OWN_WALL_GROUPS } from '../src/sim/collisionGroups.ts';
import type { AiFlyer } from '../src/sim/aiTraffic.ts';
import type { LockTarget } from '../src/sim/lock.ts';
import { wrapDelta } from '../src/sim/contacts.ts';
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
let AT = new THREE.Vector3(0, 900, -2600);
function hold(sim: Simulation): void {
  const b = sim.craft.body;
  b.setTranslation(AT, true);
  b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);
}
const run = (sim: Simulation, seconds: number, each?: () => void) => {
  for (let i = 0; i < Math.round(seconds * 120); i++) { hold(sim); each?.(); sim.step(idle); }
};
const park = (f: AiFlyer, p: THREE.Vector3) => {
  f.pos.copy(p);
  f.speed = f.cruise = 0;
  f.vel.set(0, 0, 0);
  f.altitude = f.cruiseAltitude = p.y;
  f.heading = 0;
};
/** Keep a target locked (the test holds the lock; aiming is the lock system's own check). */
const lockOn = (sim: Simulation, t: LockTarget) => {
  sim.lock.tracked = t;
  sim.lock.held = 10;
};
function world(): Simulation {
  const sim = new Simulation(JET);
  sim.traffic.enabled = false;
  sim.airTraffic.pool = [TEST_PLANE];
  sim.airTraffic.count = 0;
  sim.airTraffic.friendlies = 0;
  sim.airTraffic.freelancers = 0;
  sim.airTraffic.enemies = 2;
  sim.groundTurrets.density = 0;
  sim.weapons.arm(JET, 'none');
  // The test keeps the lock itself.
  (sim.lock as unknown as { step: () => void }).step = () => {};
  return sim;
}

// ---------------------------------------------------------------- 1. charges
console.log('--- charges');
{
  const sim = world();
  sim.credits = HACK.price * 4;
  check(sim.buyHack() === null && sim.hackCharges === 3 && sim.credits === HACK.price * 3, 'three charges for 600 credits');
  sim.buyHack(); sim.buyHack();
  check(sim.hackCharges === 9 && sim.buyHack() !== null && sim.hackCharges === 9, 'at most nine held', `${sim.hackCharges}`);
  sim.credits = 0; sim.hackCharges = 0;
  check(sim.buyHack() !== null, 'they need the credits');
}

// ---------------------------------------------------------------- 2-3. aircraft
console.log('--- aircraft');
{
  const sim = world();
  sim.hackCharges = 3;
  run(sim, 0.5);
  const [f, g] = sim.airTraffic.flyers.filter((x) => x.role === 'enemy');
  const old = f.side!;
  const ahead = AT.clone().add(new THREE.Vector3(0, 0, -800));
  const pin = () => { park(f, ahead); park(g, AT.clone().add(new THREE.Vector3(600, 0, -900))); };
  run(sim, 0.2, pin);
  // Beyond 1.5 km: nothing.
  park(f, AT.clone().add(new THREE.Vector3(0, 0, -2000)));
  sim.hackHeld = true;
  run(sim, 0.5, () => { park(f, AT.clone().add(new THREE.Vector3(0, 0, -2000))); lockOn(sim, f.handle); });
  check(sim.hackBeam.status === 'out of range' && sim.hackBeam.progress === 0, 'beyond 1.5 km the beam won\'t hold', sim.hackBeam.status);
  // A broken beam starts again, free.
  run(sim, 2, () => { pin(); lockOn(sim, f.handle); });
  const mid = sim.hackBeam.progress;
  sim.hackHeld = false;
  run(sim, 0.1, pin);
  sim.hackHeld = true;
  run(sim, 2, () => { pin(); lockOn(sim, f.handle); });
  check(mid > 0.6 && mid < 0.7 && f.side === old && sim.hackCharges === 3, 'letting go resets it and costs nothing', `${Math.round(mid * 100)}% then reset, ${sim.hackCharges} charges`);
  run(sim, 1.2, () => { pin(); lockOn(sim, f.handle); });
  sim.hackHeld = false;
  check(f.side === sim.team && f.role === 'hacked' && sim.hackCharges === 2, '3 s held on a locked enemy aircraft: it is yours', `side ${f.side}, ${sim.hackCharges} charges left`);
  check(hostile(f.side!, old) && f.def !== f.hacked!.wasDef, 'it wears your livery and fights its old side');
  // Your rounds don't hurt it; its old side's do.
  const hp = f.hp;
  (sim as unknown as { weaponImpact: (h: unknown) => void }).weaponImpact({ kind: 'gun', point: f.pos.clone(), normal: new THREE.Vector3(0, 1, 0), vel: new THREE.Vector3(0, 0, -600), mass: 0.05, blast: 1.6, color: '#fff', collider: f.body.collider(0), time: sim.time });
  check(f.hp === hp, 'your rounds don\'t hurt it', `${f.hp}/${hp}`);
  // It goes after its old side (the other enemy parked nearby).
  let went = false;
  run(sim, 6, () => { park(g, AT.clone().add(new THREE.Vector3(600, 0, -900))); went ||= f.target?.flyer === g; });
  check(went || g.side !== old, 'it attacks its old side', `target ${f.target?.kind ?? 'none'}`);
  const rec = sim.adsbRecords().find((r) => r.id === `air:${f.id}`)!;
  check(rec.hacked === true && rec.status.startsWith('hacked') && !rec.foe, 'ADS-B shows it hacked and friendly', rec.status);
  // Sixty seconds on, it is back.
  run(sim, HACK.duration - 6 + 1);
  check(f.derezAt !== null || (f.side === old && !f.hacked && f.role === 'enemy'), 'after 60 s it reverts', `side ${f.side}`);
  check(sim.notices.some((n) => n.text.includes('hack ran out')) || f.derezAt !== null, 'with a notice');
}

// ---------------------------------------------------------------- 4. turret
console.log('--- turret');
{
  const sim = world();
  sim.airTraffic.enemies = 0;
  sim.groundTurrets.density = 2;
  sim.hackCharges = 3;
  run(sim, 1);
  const t = sim.groundTurrets.turrets.filter((x) => x.derezAt === null && hostile(sim.team, x.side) && x.site.kind === 'gun')
    .sort((a, b) => Math.hypot(wrapDelta(AT.x, a.pos.x), wrapDelta(AT.z, a.pos.z)) - Math.hypot(wrapDelta(AT.x, b.pos.x), wrapDelta(AT.z, b.pos.z)))[0];
  check(!!t, 'an enemy turret nearby');
  const old = t.side;
  // Hover 500 m off it, 350 m up (clear line).
  AT = new THREE.Vector3(AT.x + wrapDelta(AT.x, t.pos.x) + 500, t.pos.y + 350, AT.z + wrapDelta(AT.z, t.pos.z));
  sim.hackHeld = true;
  run(sim, 3.5, () => lockOn(sim, t.handle));
  check(t.side === old, 'a turret takes longer (not yet at 3.5 s)');
  run(sim, 0.6, () => lockOn(sim, t.handle));
  sim.hackHeld = false;
  check(t.side === sim.team && !!t.hacked, 'held 4 s: it is your team\'s', `side ${t.side}`);
  // An aircraft of its old side flies by: it fires on it.
  sim.airTraffic.enemies = 1;
  run(sim, 0.2);
  const e = sim.airTraffic.flyers.find((x) => x.role === 'enemy' && x.side === old) ?? sim.airTraffic.flyers.find((x) => x.role === 'enemy')!;
  e.side = old; if (e.foe) e.foe.side = old;
  let shot = false;
  run(sim, 5, () => { park(e, t.pos.clone().add(new THREE.Vector3(-120, 380, 0))); shot ||= t.target?.flyer === e && (t.state === 'firing' || t.weapons.projectiles.length > 0); });
  check(shot, 'it fires on its old side');
  // Under an EMP a turret hacks in half the time.
  const t2 = sim.groundTurrets.turrets.find((x) => x !== t && x.derezAt === null && hostile(sim.team, x.side));
  if (t2) {
    AT = new THREE.Vector3(AT.x + wrapDelta(AT.x, t2.pos.x) + 500, t2.pos.y + 350, AT.z + wrapDelta(AT.z, t2.pos.z));
    sim.groundTurrets.disable(t2, sim.time + 20);
    sim.hackHeld = true;
    run(sim, 2.1, () => lockOn(sim, t2.handle));
    sim.hackHeld = false;
    check(!!t2.hacked, 'an EMP\'d turret hacks in half the time (2 s)');
  }
  run(sim, HACK.duration);
  check(t.derezAt !== null || (t.side === old && !t.hacked), 'after 60 s the turret is back with its old side', `side ${t.side}`);
}

// ---------------------------------------------------------------- 5. light cycle
console.log('--- light cycle');
{
  const sim = world();
  sim.airTraffic.enemies = 0;
  sim.traffic.enabled = true;
  sim.hackCharges = 3;
  run(sim, 1);
  // Over the nearest rider (jetwall colliders exist only near the craft), then pick one with a wall.
  const r0 = [...sim.traffic.riders].filter((x) => x.derezAt === null).sort((a, b) => Math.hypot(wrapDelta(AT.x, a.x), wrapDelta(AT.z, a.z)) - Math.hypot(wrapDelta(AT.x, b.x), wrapDelta(AT.z, b.z)))[0];
  AT = new THREE.Vector3(AT.x + wrapDelta(AT.x, r0.x), 60, AT.z + wrapDelta(AT.z, r0.z) + 150);
  run(sim, 3);
  const r = sim.traffic.riders.filter((x) => x.derezAt === null && x.walls.length > 0)
    .sort((a, b) => Math.hypot(wrapDelta(AT.x, a.x), wrapDelta(AT.z, a.z)) - Math.hypot(wrapDelta(AT.x, b.x), wrapDelta(AT.z, b.z)))[0];
  check(!!r, 'a light cycle with a wall');
  const before = r.walls.map((c) => c.collisionGroups());
  AT = new THREE.Vector3(AT.x + wrapDelta(AT.x, r.x), 60, AT.z + wrapDelta(AT.z, r.z) + 150);
  const handle = sim.lockTargets().find((x) => x.id === `rider:${r.id}`)!;
  // Keep close over it (its wall's colliders exist only within 300 m of the craft).
  const follow = () => { AT = new THREE.Vector3(AT.x + wrapDelta(AT.x, r.x), 60, AT.z + wrapDelta(AT.z, r.z) + 120); };
  sim.hackHeld = true;
  run(sim, 3.2, () => { follow(); lockOn(sim, handle); });
  sim.hackHeld = false;
  run(sim, 0.2, follow);
  check(!!r.hackColor && r.hackColor !== undefined, 'held 3 s: it rides in your colour', r.hackColor ?? '');
  check(before.every((g) => g !== OWN_WALL_GROUPS) && r.walls.length > 0 && r.walls.every((c) => c.collisionGroups() === OWN_WALL_GROUPS), 'its wall can no longer derez you (it skips your craft like your own)', `${r.walls.length} walls: ${r.walls.map((c) => (c.collisionGroups() >>> 0).toString(16)).join(' ')} want ${OWN_WALL_GROUPS.toString(16)}; before ${before.map((g) => (g >>> 0).toString(16)).join(' ')}`);
  run(sim, HACK.duration, follow);
  check(!r.hackColor && r.walls.length > 0 && r.walls.every((c) => c.collisionGroups() !== OWN_WALL_GROUPS), 'after 60 s its wall is deadly again');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll hacking checks passed');
process.exit(failed ? 1 : 0);
