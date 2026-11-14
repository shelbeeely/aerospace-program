/**
 * Target lock, homing missiles, the turret and the chase mode, headless. Run with `npm run lock`.
 *
 * 1. Lock: a vehicle on the aim line locks after about 1.2 s; one behind, or beyond 3 km, does
 *    not; the lock drops when the vehicle leaves the cone or derezzes; an unarmed craft locks nothing.
 * 2. A locked missile hits a crossing aircraft that the same shot unguided misses.
 * 3. A missile whose target gets outside its seeker cone flies on straight.
 * 4. Hostiles' missiles home on the player (the MISSILE warning counts them).
 * 5. Turret: traverses and elevates at its rates, within its limits; the cannon fires along the
 *    barrel; a craft without a turret fires along its nose as before.
 * 6. Auto-aim: with a lock held, the turret lays the cannon on the target and the shell passes
 *    within a few metres of it.
 * 7. Chase: the flight computer flies the jet onto a locked aircraft and holds station behind it,
 *    above the ground; it ends when the target derezzes; with nothing locked it won't engage.
 */
import * as THREE from 'three';
import { JET } from '../src/craft/jet.ts';
import { TANK } from '../src/craft/tank.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { BUILTINS } from '../src/craft/builtins.ts';
import { TURRET } from '../src/craft/turret.ts';
import type { ControlInputs, ControlSource } from '../src/sim/controls.ts';
import { FlightAutopilot } from '../src/sim/flightAutopilot.ts';
import { analyzeDesign } from '../src/sim/flightTest.ts';
import { LOCK, type LockTarget } from '../src/sim/lock.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { terrainHeight } from '../src/sim/terrain.ts';
import { obstacleTop } from '../src/world/structures.ts';
import type { AiFlyer } from '../src/sim/aiTraffic.ts';
import { allAtWar } from '../src/sim/teams.ts';
// The world starts at peace; these checks test fighting, so every team is at war with every other.
allAtWar();

await initPhysics();
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};
const DEG = Math.PI / 180;
const idle: ControlInputs = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };
const AT = new THREE.Vector3(0, 700, -2600);

/** Hold the craft still in the air at `AT`, nose north (a firing platform). */
function hover(sim: Simulation): void {
  const b = sim.craft.body;
  b.setTranslation(AT, true);
  b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);
}
function step(sim: Simulation, seconds: number, each?: () => void): void {
  for (let i = 0, n = Math.round(seconds / sim.dt); i < n; i++) {
    hover(sim);
    each?.();
    sim.step(idle);
  }
}
/** One AI aircraft, parked or flying straight east at `speed` from `pos`. */
function flyer(sim: Simulation, pos: THREE.Vector3, speed = 0): AiFlyer {
  sim.traffic.enabled = false;
  sim.airTraffic.pool = [TEST_PLANE];
  sim.airTraffic.count = 1;
  sim.step(idle);
  const f = sim.airTraffic.flyers[0];
  f.pos.copy(pos);
  park(f, speed);
  return f;
}
function park(f: AiFlyer, speed: number): void {
  f.heading = Math.PI / 2;
  f.speed = f.cruise = speed;
  f.altitude = f.cruiseAltitude = f.pos.y;
  f.phase = 'wander'; // no flight plan: it flies where the test puts it
  f.state = 'transit';
  f.dest = { x: f.pos.x + 50000, z: f.pos.z };
  f.pitch = f.bank = 0;
}
const handle = (sim: Simulation, f: AiFlyer) => sim.lockTargets().find((t) => t.id === `air:${f.id}`)!;

// ---------------------------------------------------------------- 1. lock
console.log('--- lock');
{
  const sim = new Simulation(JET);
  hover(sim);
  const f = flyer(sim, AT.clone().add(new THREE.Vector3(0, 0, -1200)));
  const pin = (p: THREE.Vector3) => () => { f.pos.copy(p); park(f, 0); };
  step(sim, 0.6, pin(AT.clone().add(new THREE.Vector3(0, 0, -1200))));
  check(sim.lock.tracked?.id === `air:${f.id}` && !sim.lock.locked, 'an aircraft ahead is tracked at once, not yet locked');
  step(sim, 1.0, pin(AT.clone().add(new THREE.Vector3(0, 0, -1200))));
  check(sim.lock.locked && sim.weapons.lock?.id === `air:${f.id}`, 'and locked after about 1.2 s', `held ${sim.lock.held.toFixed(1)} s`);
  step(sim, 0.5, pin(AT.clone().add(new THREE.Vector3(2000, 0, 300))));
  check(!sim.lock.tracked, 'the lock drops when it leaves the cone');
  sim.lock.clear();
  step(sim, 2, pin(AT.clone().add(new THREE.Vector3(0, 0, 1500))));
  check(!sim.lock.tracked, 'one behind is never locked');
  step(sim, 2, pin(AT.clone().add(new THREE.Vector3(0, 0, -LOCK.range - 400))));
  check(!sim.lock.tracked, `nor one beyond ${LOCK.range / 1000} km`);
  step(sim, 2, pin(AT.clone().add(new THREE.Vector3(0, 0, -900))));
  sim.derezFlyer(f, true);
  step(sim, 0.2);
  check(!sim.lock.tracked, 'a derezzed target drops the lock');
  const unarmed = new Simulation(TEST_PLANE);
  hover(unarmed);
  const g = flyer(unarmed, AT.clone().add(new THREE.Vector3(0, 0, -800)));
  step(unarmed, 2, () => { g.pos.copy(AT).add(new THREE.Vector3(0, 0, -800)); park(g, 0); });
  check(unarmed.weapons.mounts.length === 0 && !unarmed.lock.tracked, 'an unarmed craft locks nothing');
}

// ---------------------------------------------------------------- 2, 3. homing
console.log('--- homing missiles');
function shot(guided: boolean): { hit: boolean; miss: number } {
  const sim = new Simulation(JET);
  sim.weapons.arm(JET, 'missiles');
  hover(sim);
  // A crossing target 1.4 km out, flying east at 90 m/s; it starts west of the line.
  const start = AT.clone().add(new THREE.Vector3(-150, 0, -1400));
  const f = flyer(sim, start, 90);
  step(sim, 1.6, () => { if (sim.time < 1.5) { f.pos.copy(start); park(f, 90); } });
  if (!guided) { sim.lock.clear(); sim.weapons.lock = null; }
  const locked = sim.weapons.lock?.id === `air:${f.id}`;
  sim.fireWeapon('secondary');
  let miss = Infinity;
  const derezzed = () => f.derezAt !== null;
  for (let i = 0; i < 120 * 14 && !derezzed(); i++) {
    hover(sim);
    if (!guided) sim.lock.clear();
    sim.step(idle);
    for (const p of sim.weapons.projectiles) if (p.kind === 'missile') miss = Math.min(miss, p.pos.distanceTo(f.pos));
  }
  if (guided && !locked) return { hit: false, miss: -1 };
  return { hit: derezzed(), miss };
}
{
  const g = shot(true), u = shot(false);
  check(g.hit, 'a locked missile hits a crossing aircraft', g.miss < 0 ? 'no lock at launch' : '');
  check(!u.hit, 'the same shot unguided misses it', `passes ${u.miss.toFixed(0)} m away`);
}
{
  const sim = new Simulation(JET);
  sim.weapons.arm(JET, 'missiles');
  hover(sim);
  const f = flyer(sim, AT.clone().add(new THREE.Vector3(0, 0, -1500)));
  step(sim, 1.6, () => { f.pos.copy(AT).add(new THREE.Vector3(0, 0, -1500)); park(f, 0); });
  sim.fireWeapon('secondary');
  step(sim, 0.5, () => { f.pos.copy(AT).add(new THREE.Vector3(0, 0, -1500)); park(f, 0); });
  const m = sim.weapons.projectiles.find((p) => p.kind === 'missile')!;
  const had = m?.target?.id === `air:${f.id}`;
  // The target jumps behind the missile: outside its seeker.
  step(sim, 0.3, () => { f.pos.copy(AT).add(new THREE.Vector3(0, 0, 600)); park(f, 0); });
  const h0 = m.heading.clone();
  step(sim, 1, () => { f.pos.copy(AT).add(new THREE.Vector3(0, 0, 600)); park(f, 0); });
  check(had && m.target === null && m.heading.angleTo(h0) < 0.01, 'a missile that loses its target flies on straight', `turned ${(m.heading.angleTo(h0) / DEG).toFixed(2)}°`);
}

// ---------------------------------------------------------------- 4. hostile missiles
console.log('--- hostile missiles');
{
  const sim = new Simulation(JET);
  sim.traffic.enabled = false;
  sim.airTraffic.pool = BUILTINS.map((b) => b.craft);
  sim.airTraffic.enemies = 3;
  const b = sim.craft.body;
  b.setTranslation({ x: 0, y: 600, z: -2000 }, true);
  b.setLinvel({ x: 0, y: 0, z: -150 }, true);
  const { Autopilot } = await import('../src/sim/autopilot.ts');
  const ap = new Autopilot({ heading: 0, altitude: 600, airspeed: 150 });
  let t = sim.telemetry(), seen = 0, homing = 0;
  for (let i = 0; i < 120 * 300 && !sim.exploded; i++) {
    ap.targets.heading = (sim.time * 2) % 360;
    sim.step(ap.sample(sim.dt, t));
    t = sim.telemetry();
    if (i % 12) continue;
    seen = Math.max(seen, sim.incomingMissiles());
    for (const f of sim.airTraffic.hostileFlyers()) for (const p of f.weapons!.projectiles) if (p.kind === 'missile' && p.target === sim.selfTarget) homing++;
  }
  check(homing > 0 && seen > 0, 'hostiles fire missiles that home on the player, and the warning counts them', `up to ${seen} at once`);
}

// ---------------------------------------------------------------- 5. turret
console.log('--- turret');
{
  const sim = new Simulation(TANK);
  sim.traffic.enabled = false;
  for (let i = 0; i < 240; i++) sim.step(idle);
  const rig = sim.craft.turretRig;
  check(!!rig && rig.riders.has('cannon') && rig.barrels.has('cannon') && rig.riders.has('turret.light'), 'the tank has a turret: the cannon rides and elevates, the turret light rides');
  check(!new Simulation(JET).craft.turretRig, 'the jet has none');
  sim.turretInput.yaw = 1;
  for (let i = 0; i < 120; i++) sim.step(idle);
  sim.turretInput.yaw = 0;
  const yaw = sim.craft.turret.yaw / DEG;
  check(Math.abs(yaw - TURRET.yawRate / DEG) < 2, 'it traverses at its rate', `${yaw.toFixed(1)}° in 1 s`);
  sim.turretInput.pitch = 1;
  for (let i = 0; i < 120 * 3; i++) sim.step(idle);
  check(Math.abs(sim.craft.turret.pitch - TURRET.pitchMax) < 1e-6, 'elevation stops at its limit', `${(sim.craft.turret.pitch / DEG).toFixed(1)}°`);
  sim.turretInput.pitch = -1;
  for (let i = 0; i < 120 * 4; i++) sim.step(idle);
  sim.turretInput.pitch = 0;
  check(Math.abs(sim.craft.turret.pitch - TURRET.pitchMin) < 1e-6, 'and depression at its own', `${(sim.craft.turret.pitch / DEG).toFixed(1)}°`);
  const fireAt = (yawDeg: number, pitchDeg: number) => {
    sim.craft.turret.yaw = yawDeg * DEG;
    sim.craft.turret.pitch = pitchDeg * DEG;
    sim.weapons.reset();
    for (let i = 0; i < 120; i++) sim.step(idle);
    sim.craft.turret.yaw = yawDeg * DEG;
    sim.craft.turret.pitch = pitchDeg * DEG;
    sim.fireWeapon('primary');
    const p = sim.weapons.projectiles.find((q) => q.kind === 'cannon')!;
    const v = p.vel.clone().sub(new THREE.Vector3(...sim.telemetry().velocity)).applyQuaternion(sim.rotation.clone().invert()).normalize();
    return { right: v.x, up: Math.asin(v.y) / DEG, yaw: Math.atan2(v.x, -v.z) / DEG };
  };
  const side = fireAt(90, 0);
  check(Math.abs(side.yaw - 90) < 2, 'turned 90° right, the shell leaves to the right', `${side.yaw.toFixed(1)}°`);
  const up = fireAt(0, 20);
  check(Math.abs(up.up - 20) < 2 && Math.abs(up.yaw) < 2, 'at +20° it leaves 20° above the hull', `${up.up.toFixed(1)}° up`);
  sim.recentreTurret();
  for (let i = 0; i < 120 * 6; i++) sim.step(idle);
  check(Math.abs(sim.craft.turret.yaw) < 1e-3 && Math.abs(sim.craft.turret.pitch) < 1e-3, 'it recentres on the nose');
}

// ---------------------------------------------------------------- 6. auto-aim
console.log('--- auto-aim');
{
  const sim = new Simulation(TANK);
  sim.traffic.enabled = false;
  for (let i = 0; i < 240; i++) sim.step(idle);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(sim.rotation);
  const hdg = Math.atan2(fwd.x, -fwd.z);
  const spot = new THREE.Vector3();
  const place = (bearingDeg: number, range: number, height: number) => {
    const a = hdg + bearingDeg * DEG;
    spot.set(sim.position.x + Math.sin(a) * range, 0, sim.position.z - Math.cos(a) * range);
    spot.y = terrainHeight(spot.x, spot.z) + height;
  };
  const target: LockTarget = {
    id: 'test', kind: 'rider', name: 'Test target', radius: 1, alive: () => true,
    position: (o) => o.copy(spot), velocity: (o) => o.set(0, 0, 0),
  };
  sim.extraLockTargets = [target];
  place(50, 600, 12);
  // Swing the turret toward it by hand until it is tracked, then let go.
  sim.turretInput.yaw = 1;
  for (let i = 0; i < 120 * 4 && sim.lock.tracked !== target; i++) sim.step(idle);
  sim.turretInput.yaw = 0;
  for (let i = 0; i < 120 * 2; i++) sim.step(idle);
  check(sim.lock.target === target, 'turned onto it by hand, it locks');
  // It moves round: the turret follows it by itself.
  for (let b = 50; b <= 75; b += 0.5) { place(b, 600, 12); for (let i = 0; i < 12; i++) sim.step(idle); }
  for (let i = 0; i < 120 * 3; i++) sim.step(idle);
  const sol = sim.firingSolution(target)!;
  const err = Math.hypot(sol.yaw - sim.craft.turret.yaw, sol.pitch - sim.craft.turret.pitch) / DEG;
  check(sim.lock.target === target && err < 0.5, 'the turret follows it and lays the gun on it', `${(sim.craft.turret.yaw / DEG).toFixed(1)}° traverse, ${(sim.craft.turret.pitch / DEG).toFixed(1)}° elevation, ${err.toFixed(2)}° off`);
  sim.weapons.reset();
  for (let i = 0; i < 120 * 2; i++) sim.step(idle);
  sim.fireWeapon('primary');
  const shell = sim.weapons.projectiles.find((p) => p.kind === 'cannon')!;
  let closest = Infinity;
  for (let i = 0; i < 120 * 4 && sim.weapons.projectiles.includes(shell); i++) {
    sim.step(idle);
    closest = Math.min(closest, shell.pos.distanceTo(spot));
  }
  check(closest < 4, 'and the shell passes within a few metres of it', `${closest.toFixed(1)} m`);
}

// ---------------------------------------------------------------- 7. chase
console.log('--- chase');
class Human implements ControlSource {
  input: ControlInputs = { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 };
  sample(): ControlInputs { return { ...this.input }; }
}
{
  const sim = new Simulation(JET);
  const stall = analyzeDesign(sim).stallSpeed;
  sim.traffic.enabled = false;
  sim.airTraffic.pool = [JET];
  sim.airTraffic.count = 1;
  const b = sim.craft.body;
  b.setTranslation({ x: 0, y: 700, z: -2600 }, true);
  b.setLinvel({ x: 0, y: 0, z: -150 }, true);
  sim.step(idle);
  // A jet 2 km ahead and off to the side, cruising east.
  const f = sim.airTraffic.flyers[0];
  f.pos.set(1200, 750, -4200);
  park(f, 140);
  const ap = new FlightAutopilot(new Human());
  let t = sim.telemetry();
  ap.engage(t, 'airplane', { stallSpeed: stall }, { mode: 'chase', target: null });
  check(ap.state.mode === 'hold' && /nothing locked/.test(ap.state.notice), 'with nothing locked, Chase will not engage', ap.state.notice);
  ap.engage(t, 'airplane', { stallSpeed: stall }, { mode: 'chase', target: handle(sim, f) });
  check(ap.state.mode === 'chase', 'with a target it engages');
  let closeAt = -1, maxAfter = 0, minClear = Infinity;
  for (let i = 0; i < 120 * 150; i++) {
    sim.step(ap.sample(sim.dt, t));
    t = sim.telemetry();
    if (i % 12) continue;
    const d = f.pos.distanceTo(sim.position);
    if (closeAt < 0 && d < 400) closeAt = sim.time;
    if (closeAt > 0 && sim.time > closeAt + 10) maxAfter = Math.max(maxAfter, d);
    minClear = Math.min(minClear, sim.position.y - Math.max(terrainHeight(sim.position.x, sim.position.z), obstacleTop(sim.position.x, sim.position.z)));
  }
  check(closeAt > 0 && closeAt < 100, 'it closes on the target', closeAt > 0 ? `within 400 m after ${closeAt.toFixed(0)} s` : `still ${f.pos.distanceTo(sim.position).toFixed(0)} m away`);
  check(closeAt > 0 && maxAfter < 1000, 'and holds station behind it', `never more than ${maxAfter.toFixed(0)} m off`);
  check(minClear > 40 && !sim.exploded, 'clear of the ground and the structures', `lowest ${minClear.toFixed(0)} m`);
  sim.derezFlyer(f, true);
  for (let i = 0; i < 30; i++) { sim.step(ap.sample(sim.dt, t)); t = sim.telemetry(); }
  check(ap.state.mode === 'hold' && ap.state.engaged && /Chase ended/.test(ap.state.notice), 'when the target derezzes it goes back to Hold', ap.state.notice);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
