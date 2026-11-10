/**
 * AI air traffic, headless. Run with `npm run air`.
 *
 * 1. The traffic keeps its count around the player, from the pool (ground vehicles never fly).
 * 2. Flyers stay airborne, clear of terrain and structures, at a sensible speed for their kind.
 * 3. They reach their destinations, circle there, then move on to new ones.
 * 4. A gun hit derezzes one (flash and voxels), and the count is topped back up.
 */
import * as THREE from 'three';
import { BUILTINS } from '../src/craft/builtins.ts';
import { JET } from '../src/craft/jet.ts';
import { flyerKind } from '../src/sim/aiTraffic.ts';
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

const sim = new Simulation(JET);
sim.traffic.enabled = false;
sim.airTraffic.pool = BUILTINS.map((b) => b.craft);
sim.airTraffic.count = 8;
let minClear = Infinity, loiters = 0, transits = 0;
let worst = '';
const reached = new Set<number>();
const states = new Map<number, string>();
for (let i = 0; i < 120 * 180; i++) {
  sim.step(idle);
  if (i % 60 !== 0) continue;
  for (const f of sim.airTraffic.flyers) {
    if (f.derezAt !== null) continue;
    const ground = Math.max(terrainHeight(f.pos.x, f.pos.z), obstacleTop(f.pos.x, f.pos.z));
    if (f.pos.y - ground < minClear) worst = `${f.name} ${f.state} at ${f.pos.y.toFixed(0)} m over ${ground.toFixed(0)} m (terrain ${terrainHeight(f.pos.x, f.pos.z).toFixed(0)}), ${f.speed.toFixed(0)} m/s, t=${sim.time.toFixed(0)}`;
    minClear = Math.min(minClear, f.pos.y - ground);
    const prev = states.get(f.id);
    if (prev === 'transit' && f.state === 'loiter') { loiters++; reached.add(f.id); }
    if (prev === 'loiter' && f.state === 'transit') transits++;
    states.set(f.id, f.state);
  }
}
const flyers = sim.airTraffic.flyers.filter((f) => f.derezAt === null);
check(flyers.length === 8, 'eight AI aircraft fly around the player', flyers.map((f) => `${f.name} (${f.kind}, ${f.speed.toFixed(0)} m/s)`).join(', '));
check(!sim.airTraffic.flyers.some((f) => flyerKind(f.def) === 'ground'), 'ground vehicles in the pool never take to the air');
check(minClear > 30, 'they stay clear of the ground and the structures', `closest ${minClear.toFixed(0)} m: ${worst}`);
check(loiters >= 3 && transits >= 1, 'they reach destinations, circle, and move on', `${loiters} arrivals (${reached.size} aircraft), ${transits} departures`);
const speedsOk = flyers.every((f) => f.speed > 5 && f.speed < 300);
check(speedsOk, 'each flies at a sensible speed for its kind');

// A gun hit derezzes one.
{
  const f = [...flyers].sort((a, b) => b.radius - a.radius)[0]; // the biggest: between the guns
  // Park it 150 m ahead of the jet, on the guns' line.
  sim.weapons.arm(JET, 'guns');
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(sim.rotation);
  const gunY = sim.weapons.mounts[0].offset.y;
  f.pos.copy(sim.position).addScaledVector(fwd, 150).add(new THREE.Vector3(0, gunY, 0));
  f.speed = 0;
  f.cruise = 0;
  f.altitude = f.pos.y;
  const before = sim.airTraffic.derezzed;
  for (let k = 0; k < 8; k++) {
    sim.step(idle);
    sim.fireWeapon('primary');
    for (let j = 0; j < 12; j++) sim.step(idle);
    f.pos.copy(sim.position).addScaledVector(fwd, 150).add(new THREE.Vector3(0, gunY, 0));
    if (sim.airTraffic.derezzed > before) break;
  }
  check(sim.airTraffic.derezzed > before && sim.explosions.some((e) => e.color === f.color), 'gunfire derezzes an AI aircraft in its circuit colour', `${sim.airTraffic.derezzed - before} derezzed`);
  for (let i = 0; i < 120 * 3; i++) sim.step(idle);
  check(sim.airTraffic.flyers.filter((x) => x.derezAt === null).length === 8, 'and a new one takes its place');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
