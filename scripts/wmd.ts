/**
 * Weapons of mass destruction, headless. Run with `npm run wmd`.
 *
 * 1. Railgun: one shot punches through three aircraft in a line; it reaches 4 km; slow to reload.
 * 2. Buying: a nuke or an EMP needs the credits and takes them; one carried at a time; launching
 *    uses it.
 * 3. Nuke: a dud before it arms; armed, it flattens structures inside 400 m, derezzes aircraft,
 *    turrets and riders within 1.2 km and spares those beyond; a craft inside it derezzes.
 * 4. EMP: aircraft inside glide and hold fire, then recover; turrets go quiet for 20 s; riders
 *    stall; missiles lose their lock; the craft's engines cut; nothing is destroyed.
 */
import * as THREE from 'three';
import { JET } from '../src/craft/jet.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { STRATEGIC } from '../src/sim/strategic.ts';
import { WEAPONS } from '../src/sim/weapons.ts';
import { turretSites, TURRET_HEAD_Y } from '../src/sim/groundTurrets.ts';
import { baseOwner } from '../src/sim/territory.ts';
import type { Team } from '../src/sim/teams.ts';
import type { AiFlyer } from '../src/sim/aiTraffic.ts';

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
const run = (sim: Simulation, seconds: number, each?: () => void, p = AT) => {
  for (let i = 0; i < Math.round(seconds * 120); i++) { hold(sim, p); each?.(); sim.step(idle); }
};
/** Park every flyer of the traffic at a spot (they stay put: no speed). */
const park = (f: AiFlyer, p: THREE.Vector3) => {
  f.pos.copy(p);
  f.speed = f.cruise = 0;
  f.altitude = f.cruiseAltitude = p.y;
  f.heading = 0;
};
function world(def = JET): Simulation {
  const sim = new Simulation(def);
  sim.traffic.enabled = false;
  sim.airTraffic.pool = [TEST_PLANE];
  return sim;
}

// ---------------------------------------------------------------- 1. railgun
console.log('--- railgun');
{
  const sim = world();
  sim.weapons.arm(JET, 'rail');
  sim.airTraffic.count = 4;
  run(sim, 0.1);
  const gunY = sim.weapons.mounts.find((m) => m.kind === 'rail')!.offset;
  const flyers = sim.airTraffic.flyers.slice(0, 4);
  // Three in a line ahead of one rail (the 4th far off to the side), and keep them there.
  const line = (k: number) => AT.clone().add(new THREE.Vector3(gunY.x, gunY.y, -300 - k * 400));
  const pin = () => { flyers.slice(0, 3).forEach((f, k) => park(f, line(k))); park(flyers[3], AT.clone().add(new THREE.Vector3(800, 0, -500))); };
  run(sim, 0.2, pin);
  const before = flyers.map((f) => f.hp);
  // Fire the one rail on that side.
  sim.weapons.mounts = sim.weapons.mounts.filter((m) => m.kind === 'rail' && m.offset.x === gunY.x);
  sim.fireWeapon('primary');
  run(sim, 0.1, pin);
  const hit = flyers.slice(0, 3).filter((f, k) => f.hp < before[k] || f.derezAt !== null).length;
  check(hit === 3 && flyers[3].hp === before[3], 'one shot punches through three aircraft in a line', `${hit} hit`);
  check(WEAPONS.rail.beam === 4000 && WEAPONS.rail.rate < 1, 'it reaches 4 km and reloads slowly', `${WEAPONS.rail.rate}/s`);
}

// ---------------------------------------------------------------- 2. buying
console.log('--- buying');
{
  const sim = world();
  sim.credits = 1000;
  check(sim.buyStrategic('nuke') !== null && sim.strategic === null && sim.credits === 1000, 'a nuke needs 1500 credits');
  check(sim.buyStrategic('emp') === null && sim.strategic === 'emp' && sim.credits === 200, 'an EMP costs 800 and is carried');
  sim.credits = 5000;
  check(sim.buyStrategic('nuke') !== null && sim.strategic === 'emp', 'one carried at a time');
  run(sim, 0.1);
  check(sim.launchStrategic() === null && sim.strategic === null && sim.weapons.projectiles.some((p) => p.kind === 'emp'), 'launching uses it: the EMP is away');
}

// ---------------------------------------------------------------- 3. nuke
console.log('--- nuke');
// Over a district with structures: a turret site, so there are towers about.
const site = (() => {
  for (let ci = 0; ci < 8; ci++) for (let cj = 0; cj < 8; cj++) for (const s of turretSites(ci, cj, 1)) if (s.y < 200) return s;
  throw new Error('no site');
})();
const ground = new THREE.Vector3(site.x, site.y + TURRET_HEAD_Y, site.z);
{
  // A dud: launched straight at the ground from close by, it goes off before it arms.
  const sim = world();
  sim.credits = 1500;
  sim.buyStrategic('nuke');
  const low = new THREE.Vector3(site.x + 300, site.y + 60, site.z);
  run(sim, 0.2, undefined, low);
  sim.launchStrategic();
  const p = sim.weapons.projectiles.find((q) => q.kind === 'nuke')!;
  p.vel.set(0, -120, 0);
  p.heading.set(0, -1, 0);
  run(sim, 2.5, undefined, low);
  check(sim.blasts.length === 0 && !sim.weapons.projectiles.includes(p), 'a nuke that strikes before it arms is a dud');
}
{
  const sim = world();
  sim.groundTurrets.density = 2;
  sim.airTraffic.count = 3;
  sim.traffic.enabled = true;
  const away = ground.clone().add(new THREE.Vector3(0, 900, 2600)); // the craft watches from 2.8 km
  run(sim, 2, undefined, away);
  const [a, b, c] = sim.airTraffic.flyers;
  park(a, ground.clone().add(new THREE.Vector3(200, 150, 0)));
  park(b, ground.clone().add(new THREE.Vector3(-900, 300, 0)));
  park(c, ground.clone().add(new THREE.Vector3(0, 300, -1700)));
  const turretsNear = sim.groundTurrets.turrets.filter((t) => t.derezAt === null && t.pos.distanceTo(ground) < 1100).length;
  const ridersNear = sim.traffic.riders.filter((r) => r.derezAt === null && Math.hypot(r.x - ground.x, r.z - ground.z) < 1100).length;
  const fracturedBefore = sim.staticWorld.fractured.size;
  sim.detonateNuke(ground.x, ground.y, ground.z, sim.team, true);
  check(sim.staticWorld.fractured.size > fracturedBefore, 'the fireball fractures the structures in it', `${sim.staticWorld.fractured.size - fracturedBefore} structures`);
  check(a.derezAt !== null && b.derezAt !== null && c.derezAt === null, 'aircraft within 1.2 km derez, those beyond are spared');
  const turretsLeft = sim.groundTurrets.turrets.filter((t) => t.derezAt === null && t.pos.distanceTo(ground) < 1100).length;
  const ridersLeft = sim.traffic.riders.filter((r) => r.derezAt === null && Math.hypot(r.x - ground.x, r.z - ground.z) < 1100).length;
  check(turretsNear > 0 && turretsLeft === 0, 'turrets in the shock ring are destroyed', `${turretsNear} before`);
  check(ridersNear === 0 || ridersLeft === 0, 'light cycles in it derez', `${ridersNear} before`);
  check(!sim.exploded && sim.blasts.at(-1)?.kind === 'nuke', 'a craft 2.8 km out survives, and the blast is recorded');
  const inside = world();
  run(inside, 0.2, undefined, ground.clone().add(new THREE.Vector3(0, 200, 0)));
  inside.detonateNuke(ground.x, ground.y, ground.z, inside.team, true);
  check(inside.exploded, 'a craft inside the fireball derezzes');
  const ring = world();
  run(ring, 0.2, undefined, ground.clone().add(new THREE.Vector3(0, 300, 800)));
  ring.detonateNuke(ground.x, ground.y, ground.z, ring.team, true);
  const left = [...ring.damage.hp].filter(([, hp]) => Number.isFinite(hp)).map(([id, hp]) => hp / (ring.damage.maxHp.get(id) ?? 1));
  check(ring.exploded || (left.length > 0 && Math.max(...left) < 0.5), 'one in the shock ring is badly damaged', ring.exploded ? 'derezzed' : `every part at ${(Math.max(...left) * 100).toFixed(0)}% or less`);
}

// ---------------------------------------------------------------- 4. EMP
console.log('--- EMP');
{
  const sim = world();
  sim.groundTurrets.density = 2;
  sim.setTeam((baseOwner(site.ci, site.cj) ?? 0) as Team); // the turrets here are on its side: it's here to watch, not fight
  sim.airTraffic.enemies = 2;
  sim.airTraffic.pool = [JET];
  sim.traffic.enabled = true;
  const at = ground.clone().add(new THREE.Vector3(0, 300, 400));
  run(sim, 2, undefined, at);
  const flyers = sim.airTraffic.combatFlyers();
  flyers.forEach((f, k) => { f.pos.copy(ground).add(new THREE.Vector3(k * 120, 250, 0)); f.altitude = f.pos.y; });
  const y0 = flyers.map((f) => f.pos.y);
  const turrets = sim.groundTurrets.turrets.filter((t) => t.derezAt === null && t.pos.distanceTo(ground) < 700);
  const riders = sim.traffic.riders.filter((r) => r.derezAt === null && Math.hypot(r.x - ground.x, r.z - ground.z) < 700);
  const rx = riders.map((r) => r.x + r.z);
  // A homing missile in flight near it, with a lock.
  sim.weapons.arm(JET, 'missiles');
  sim.weapons.lock = flyers[0].handle;
  sim.fireWeapon('secondary');
  const m = sim.weapons.projectiles.find((p) => p.kind === 'missile')!;
  m.pos.copy(ground).add(new THREE.Vector3(0, 300, 200));
  const before = sim.airTraffic.derezzed + sim.groundTurrets.derezzed;
  sim.detonateEmp(ground.x, ground.y + 100, ground.z, true);
  // (Measured at the pulse: afterwards turrets outside its reach may well shoot the gliders down.)
  const destroyedByPulse = sim.airTraffic.derezzed + sim.groundTurrets.derezzed - before;
  let fired = 0;
  run(sim, 5, () => { fired += flyers.reduce((s, f) => s + (f.weapons?.trigger.primary || f.weapons?.trigger.secondary ? 1 : 0), 0); }, at);
  check(flyers.every((f, k) => f.pos.y < y0[k] - 10) && fired === 0, 'aircraft inside glide down and hold fire', flyers.map((f, k) => `${(y0[k] - f.pos.y).toFixed(0)} m down`).join(', '));
  check(turrets.length > 0 && turrets.every((t) => t.weapons.trigger.primary === false && t.state === 'idle' && t.disabledUntil > sim.time), 'turrets inside go dark', `${turrets.length} turrets`);
  check(riders.every((r, k) => r.x + r.z === rx[k]), 'light cycles stall', `${riders.length} riders`);
  check(m.target === null, 'a homing missile in it loses its lock');
  check(sim.empActive && sim.controls.throttle === 0, 'the craft caught in it loses its engines');
  check(destroyedByPulse === 0, 'nothing is destroyed by it');
  run(sim, 6, undefined, at);
  check(flyers.every((f) => f.disabledUntil < sim.time) && !sim.empActive, 'after 8 s aircraft and the craft recover');
  check(turrets.every((t) => t.disabledUntil > sim.time), 'turrets stay down for 20 s');
  check(STRATEGIC.emp.turrets === 20 && STRATEGIC.emp.aircraft === 8, 'as specified');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
