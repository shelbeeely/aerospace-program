/**
 * Headless weapons tests. Run with `npm run weapons`.
 *
 * 1. Mounts: the tank carries its fitted cannon and coaxial gun by default; every loadout mounts on
 *    every built-in.
 * 2. The tank's cannon, fired at a structure, craters it (the structure fractures into blocks).
 * 3. The tank drives through a structure: the bulldozer clears its blocks and the tank survives.
 * 4. A jet's bomb falls ballistically and detonates on the ground (a derez flash in its colour).
 * 5. A missile accelerates in flight.
 * 5b. Fitted weapons: multiples of each kind, each firing from where it is fitted; bays and rails
 *    empty on the craft; nose-heavy bombs pitch down; the laser hits instantly; the disc ricochets.
 * 6. Armour: the tank's parts are at least 4x stronger than reinforcement alone.
 */
import { BUILTINS } from '../src/craft/builtins.ts';
import { JET } from '../src/craft/jet.ts';
import { TANK } from '../src/craft/tank.ts';
import { LIGHT_CYCLE } from '../src/craft/lightCycle.ts';
import type { ControlInputs } from '../src/sim/controls.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { LOADOUT_ORDER, mountsFor } from '../src/sim/weapons.ts';
import { worldStructures } from '../src/world/structures.ts';
import * as THREE from 'three';
import { WeaponMount } from '../src/modules/WeaponMount.ts';

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
  check(sim.weapons.loadout === 'fitted' && kinds === 'cannon,gun', 'the tank is armed by default', kinds);
  const jet = new Simulation(JET).weapons.mounts.map((m) => m.kind).sort().join(',');
  check(jet === 'bomb,gun,gun,missile,missile', 'the jet carries its fitted guns, rails and bay', jet);
  const cannon = sim.weapons.mounts.find((m) => m.kind === 'cannon')!;
  check(cannon.offset.z < -3, 'its cannon fires from the barrel tip', `z ${cannon.offset.z.toFixed(2)}`);
  let bad = 0;
  for (const b of BUILTINS) for (const l of LOADOUT_ORDER) if (l !== 'none' && l !== 'fitted' && mountsFor(b.craft, l).length === 0) bad++;
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

// ---------------------------------------------------------------- 5b. fitted weapons
console.log('\n--- fitted weapons');
{
  // A jet with weapons fitted as parts: two cannons, four gun pods, two missile rails, two bomb
  // bays, a laser and a disc launcher.
  const W = (kind: string, offset: [number, number, number], ammo?: number) => ({ type: 'weapon' as const, kind: kind as 'gun', offset, ...(ammo ? { ammo } : {}) });
  const armed = structuredClone(JET);
  for (const p of armed.parts) p.modules = p.modules?.filter((m) => m.type !== 'weapon'); // start bare
  const body = armed.parts[0];
  body.mass += 6000;
  body.modules = [
    ...(body.modules ?? []),
    W('cannon', [-0.6, -0.4, 0]), W('cannon', [0.6, -0.4, 0]),
    W('gun', [-1.2, -0.3, 0]), W('gun', [1.2, -0.3, 0]), W('gun', [-1.5, -0.3, 0.5]), W('gun', [1.5, -0.3, 0.5]),
    W('missile', [-1.0, -0.6, 1], 4), W('missile', [1.0, -0.6, 1], 4),
    W('bomb', [-0.5, -0.7, 1.5], 4), W('bomb', [0.5, -0.7, 1.5], 4),
    W('laser', [0, -0.5, -1]), W('disc', [0, 0.5, 0]),
  ];
  const sim = new Simulation(armed);
  const count = (k: string) => sim.weapons.mounts.filter((m) => m.kind === k).length;
  check(sim.weapons.loadout === 'fitted', 'a craft with fitted weapons uses them', sim.weapons.loadout);
  check(count('cannon') === 2 && count('gun') === 4 && count('missile') === 2 && count('bomb') === 2, 'multiples of each: 2 cannons, 4 guns, 2 rails, 2 bays',
    sim.weapons.mounts.map((m) => m.kind).join(','));
  const cx = sim.weapons.mounts.filter((m) => m.kind === 'cannon').map((m) => m.offset.x);
  check(Math.abs(cx[0] - cx[1]) > 1, 'each fires from where it is fitted', `cannon x ${cx.map((x) => x.toFixed(1)).join(', ')}`);
  const mods = sim.craft.modules.filter((m): m is WeaponMount => m instanceof WeaponMount);
  check(mods.length === 12, 'each weapon is a module on the craft (drawn on it)', `${mods.length}`);

  place(sim, 300, 800, -2000, 0, [0, 0, -150]);
  sim.step(idle);
  sim.fireWeapon('secondary');
  run(sim, 0.05);
  const bays = mods.filter((m) => m.def.kind === 'bomb');
  const rails = mods.filter((m) => m.def.kind === 'missile');
  check(bays.every((b) => b.ammo === 3) && rails.every((r) => r.ammo === 3), 'firing empties the bays and rails on the craft', `bays ${bays.map((b) => b.ammo)}, rails ${rails.map((r) => r.ammo)}`);

  // Bombs are nose-heavy: released level, they pitch nose-down into the fall.
  const bomb = sim.weapons.projectiles.find((p) => p.kind === 'bomb')!;
  const pitch0 = bomb.heading.y;
  run(sim, 3, { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 });
  check(Math.abs(pitch0) < 0.1 && bomb.heading.y < -0.15, 'bombs leave level and pitch nose-down as they fall', `heading y ${pitch0.toFixed(2)} -> ${bomb.heading.y.toFixed(2)}`);
}
{
  // The laser: an instant beam that strikes the target the moment it fires.
  const sim = new Simulation(TANK);
  sim.weapons.arm(TANK, 'light');
  place(sim, target.p.x, 2, face + 120);
  run(sim, 1);
  const h0 = sim.weapons.hits;
  sim.weapons.fireOnce((sim as unknown as { weaponHost: Parameters<typeof sim.weapons.fireOnce>[0] }).weaponHost, 'primary', sim.time);
  check(sim.weapons.beams.length >= 1, 'the laser fires a beam of light', `${sim.weapons.beams.length}`);
  check(sim.weapons.hits > h0, 'which hits instantly', `${sim.weapons.hits - h0} hits in the same step`);
}
{
  // The identity disc ricochets off a structure and flies on.
  const sim = new Simulation(TANK);
  sim.weapons.arm(TANK, 'light');
  place(sim, target.p.x, 2, face + 60);
  run(sim, 1);
  const host = (sim as unknown as { weaponHost: Parameters<typeof sim.weapons.fireOnce>[0] }).weaponHost;
  // Fire just the disc: drop the laser for this shot.
  const laser = sim.weapons.mounts.find((m) => m.kind === 'laser')!;
  laser.ammo = 0;
  sim.weapons.fireOnce(host, 'primary', sim.time);
  const disc = sim.weapons.projectiles.find((p) => p.kind === 'disc');
  check(!!disc, 'the disc launcher throws a disc');
  let bounced = false;
  for (let i = 0; i < 240 && disc; i++) {
    sim.step(idle);
    if (disc.bounces < 3) { bounced = true; break; }
  }
  check(bounced && !!disc && disc.vel.z > 0, 'it ricochets off the structure and comes back', disc ? `bounces left ${disc.bounces}, vz ${disc.vel.z.toFixed(0)}` : '');
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

// ---------------------------------------------------------------- 7. light walls break
console.log('\n--- light walls');
{
  const sim = new Simulation(LIGHT_CYCLE);
  sim.weapons.arm(LIGHT_CYCLE, 'guns');
  for (let i = 0; i < 120 * 8; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: 0 });
  const wall = sim.trails.trails.find((t) => t.kind === 'wall')!;
  const solid0 = sim.trails.colliderCount;
  // Shoot at the middle of the wall it laid.
  const mid = wall.points[Math.floor(wall.points.length / 2)];
  const b = sim.craft.body;
  // Stand 30 m to the side of the wall's middle, facing it.
  const nx = -(wall.points.at(-1)!.z - wall.points[0].z), nz = wall.points.at(-1)!.x - wall.points[0].x;
  const nl = Math.hypot(nx, nz);
  const sx = mid.x + (nx / nl) * 30, sz = mid.z + (nz / nl) * 30;
  const yaw = Math.atan2(-(mid.x - sx), -(mid.z - sz));
  b.setTranslation({ x: sx, y: 1.2, z: sz }, true);
  b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true);
  sim.trails.mode = 'off';
  sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  for (let k = 0; k < 6; k++) { sim.fireWeapon('primary'); run(sim, 0.2); }
  const walls = sim.trails.trails.filter((t) => t.kind === 'wall' && t.derezAt === null);
  check(sim.trails.colliderCount < solid0, 'gunfire breaks a light wall', `${solid0} -> ${sim.trails.colliderCount} solid segments`);
  check(walls.length >= 2, 'leaving a gap (the wall splits in two)', `${walls.length} wall pieces`);
}

// ---------------------------------------------------------------- 8. craters
console.log('\n--- craters');
{
  const sim = new Simulation(JET);
  sim.weapons.arm(JET, 'bombs');
  place(sim, 300, 300, -2000, 0, [0, 0, -100]);
  sim.step(idle);
  sim.fireWeapon('secondary');
  for (let i = 0; i < 120 * 12 && !sim.craters.length; i++) {
    const c = sim.craft.body;
    c.setTranslation({ x: 300, y: 300, z: c.translation().z }, true);
    c.setLinvel({ x: 0, y: 0, z: -100 }, true);
    sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 });
  }
  const c = sim.craters[0];
  check(!!c && c.radius >= 9, 'a bomb leaves a crater in the ground', c ? `r ${c.radius.toFixed(1)} m at (${c.x.toFixed(0)}, ${c.z.toFixed(0)}), ground y ${c.y.toFixed(1)}` : 'none');
  const n = sim.craters.length;
  sim.explode();
  check(sim.craters.length === n, 'an airburst (the jet exploding 300 m up) leaves none');
}
{
  const sim = new Simulation(TANK);
  place(sim, 300, 1.5, -2000);
  run(sim, 1);
  // A shell into the ground just ahead: tip the tank's nose down and fire.
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.25);
  sim.craft.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  sim.step(idle);
  sim.fireWeapon('primary');
  run(sim, 1);
  check(sim.craters.length >= 1, 'a cannon shell into the ground leaves a crater', `${sim.craters.length}`);
  const before = sim.craters.length;
  (sim as unknown as { prevVelocity: THREE.Vector3 }).prevVelocity.set(0, 0, -40); // going in at 40 m/s
  sim.explode();
  check(sim.craters.length === before + 1, 'and so does a crash on the ground');
  sim.resetToRunway();
  check(sim.craters.length === 0, 'a world reset clears them');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
