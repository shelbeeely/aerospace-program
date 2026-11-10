/**
 * Headless weapons tests. Run with `npm run weapons`.
 *
 * 1. Mounts: the tank carries its cannon and coaxial gun by default; every loadout mounts on
 *    every built-in.
 * 2. The tank's cannon, fired at a structure, craters it (the structure fractures into blocks).
 * 3. The tank drives through a structure: the bulldozer clears its blocks and the tank survives.
 * 4. A jet's bomb falls ballistically and detonates on the ground (a derez flash in its colour).
 * 5. A missile accelerates in flight.
 * 6. Armour: the tank's parts are at least 4x stronger than reinforcement alone.
 */
import { BUILTINS } from '../src/craft/builtins.ts';
import { JET } from '../src/craft/jet.ts';
import { TANK } from '../src/craft/tank.ts';
import type { ControlInputs } from '../src/sim/controls.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { LOADOUT_ORDER, mountsFor } from '../src/sim/weapons.ts';
import { worldStructures } from '../src/world/structures.ts';
import * as THREE from 'three';

await initPhysics();
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};
const idle: ControlInputs = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };
const run = (sim: Simulation, seconds: number, c: ControlInputs = idle) => {
  for (let i = 0, n = Math.round(seconds / sim.dt); i < n; i++) sim.step(c);
};
const place = (sim: Simulation, x: number, y: number, z: number, yawDeg = 0, v = [0, 0, 0]) => {
  const b = sim.craft.body;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (yawDeg * Math.PI) / 180);
  b.setTranslation({ x, y, z }, true);
  b.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  b.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);
};

// ---------------------------------------------------------------- 1. mounts
console.log('--- mounts');
{
  const sim = new Simulation(TANK);
  const kinds = sim.weapons.mounts.map((m) => m.kind).sort().join(',');
  check(sim.weapons.loadout === 'tank' && kinds === 'cannon,gun', 'the tank is armed by default', kinds);
  const cannon = sim.weapons.mounts.find((m) => m.kind === 'cannon')!;
  check(cannon.offset.z < -3, 'its cannon fires from the barrel tip', `z ${cannon.offset.z.toFixed(2)}`);
  let bad = 0;
  for (const b of BUILTINS) for (const l of LOADOUT_ORDER) if (l !== 'none' && mountsFor(b.craft, l).length === 0) bad++;
  check(bad === 0, 'every loadout mounts on every built-in', `${BUILTINS.length} craft x ${LOADOUT_ORDER.length} loadouts`);
}

// Structures to shoot and drive into: a ground-level box with a broad +Z face, away from spawn.
const w = worldStructures();
const target = (() => {
  for (const g of w.groups) {
    if (!g.name.startsWith('arch:') || g.name.startsWith('arch:infra:')) continue;
    const h = g.size[1] * g.blockSize;
    if (h < 15 || h > 80) continue;
    const p = g.pieces.map((i) => w.list[i]).find((q) => q.shape === 'box' && q.y - q.sy / 2 < 0.5 && q.sy > 6 && q.sx > 12 && q.sz > 8 && q.sx < 60);
    if (p && Math.hypot(p.x, p.z) > 400 && Math.hypot(p.x, p.z) < 3000) return { g, p };
  }
  throw new Error('no suitable structure');
})();
const face = target.p.z + target.p.sz / 2;
console.log(`target ${target.g.name}: box ${target.p.sx.toFixed(0)}x${target.p.sy.toFixed(0)}x${target.p.sz.toFixed(0)} m at (${target.p.x.toFixed(0)}, ${target.p.z.toFixed(0)})`);

// ---------------------------------------------------------------- 2. cannon
console.log('\n--- tank cannon');
{
  const sim = new Simulation(TANK);
  place(sim, target.p.x, 2, face + 60);
  run(sim, 2);
  sim.fireWeapon('primary');
  run(sim, 1.5);
  check(sim.weapons.fired >= 2, 'cannon and coax gun fire', `${sim.weapons.fired} rounds`);
  check(sim.weapons.hits >= 1, 'the rounds hit something', `${sim.weapons.hits} hits`);
  check(sim.staticWorld.fractured.has(target.g.id), 'the cannon craters the structure', sim.staticWorld.fractured.has(target.g.id) ? `${sim.staticWorld.fractured.get(target.g.id)!.list.length} blocks` : 'intact');
  check(sim.explosions.length >= 1, 'the shell flashes in the tank\'s circuit colour', sim.explosions.map((e) => e.color).join(','));
}

// ---------------------------------------------------------------- 3. bulldozer
console.log('\n--- tank bulldozer');
{
  const sim = new Simulation(TANK);
  place(sim, target.p.x, 2, face + 25);
  run(sim, 1.5);
  run(sim, 14, { pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: 0 });
  const z = sim.position.z;
  check(sim.bulldozed >= 6, 'the tank bulldozes the structure\'s blocks', `${sim.bulldozed} blocks`);
  check(z < face - 2, 'and drives on into it', `${(face - z).toFixed(1)} m past the face`);
  check(!sim.exploded && sim.failures.length === 0, 'the tank survives intact', `block ${target.g.blockSize.toFixed(1)} m; ` + sim.failures.map((f) => `${f.partId} ${f.cause} ${f.load}/${f.strength} @${f.time.toFixed(1)}`).join(', ') + (sim.exploded ? ' exploded' : ''));
}

// ---------------------------------------------------------------- 4. bomb
console.log('\n--- jet bomb');
{
  const sim = new Simulation(JET);
  sim.weapons.arm(JET, 'bombs');
  place(sim, 300, 400, -2000, 0, [0, 0, -120]);
  sim.step(idle);
  const t0 = sim.time;
  sim.fireWeapon('secondary');
  const bomb = sim.weapons.projectiles.find((p) => p.kind === 'bomb');
  check(!!bomb, 'a bomb drops');
  let impactT = 0;
  for (let i = 0; i < 120 * 15 && !impactT; i++) {
    const c = sim.craft.body;
    c.setTranslation({ x: 300, y: 400, z: c.translation().z }, true); // keep the jet up there
    c.setLinvel({ x: 0, y: 0, z: -120 }, true);
    sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 });
    if (sim.weapons.impacts.some((h) => h.kind === 'bomb')) impactT = sim.time - t0;
  }
  const fall = Math.sqrt((2 * 400) / 9.81);
  check(impactT > fall * 0.9 && impactT < fall * 1.3, 'it falls ballistically', `${impactT.toFixed(1)} s (vacuum ${fall.toFixed(1)} s)`);
  const hit = sim.weapons.impacts.find((h) => h.kind === 'bomb');
  check(!!hit && Math.abs(hit.vel.z) > 60, 'carrying the jet\'s forward speed', hit ? `${hit.vel.z.toFixed(0)} m/s` : '');
  check(sim.explosions.some((e) => e.radius >= 18), 'and detonates with an 18 m blast');
}

// ---------------------------------------------------------------- 5. missile
console.log('\n--- missile');
{
  const sim = new Simulation(JET);
  sim.weapons.arm(JET, 'missiles');
  place(sim, 300, 600, -2000, 0, [0, 0, -100]);
  sim.step(idle);
  sim.fireWeapon('secondary');
  const m = sim.weapons.projectiles.find((p) => p.kind === 'missile')!;
  const v0 = m.vel.length();
  run(sim, 1.5, { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 });
  check(m.vel.length() > v0 + 100, 'it accelerates under thrust', `${v0.toFixed(0)} -> ${m.vel.length().toFixed(0)} m/s`);
}

// ---------------------------------------------------------------- 6. armour
console.log('\n--- armour');
{
  const sim = new Simulation(TANK);
  const hull = sim.craft.strength.get('hull') ?? 0;
  const plain = new Simulation({ ...TANK, armor: undefined }).craft.strength.get('hull') ?? 0;
  check(hull >= plain * 3.99, 'the hull is 4x stronger with armour', `${(hull / 1000).toFixed(0)} kN vs ${(plain / 1000).toFixed(0)} kN`);
  check(sim.explodeSpeed() >= 1.99 * new Simulation({ ...TANK, armor: undefined }).explodeSpeed(), 'and survives twice the crash speed');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
