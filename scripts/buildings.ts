/**
 * Headless tests for the breakable block buildings. Run with `npm run buildings`.
 *
 * 1. Anchor check (pure BFS): a 3×5×3 tower loses its whole y = 1 layer -> every block above is
 *    unsupported; losing a corner column instead leaves everything supported.
 * 2. Town layout: buildings stay west of x = -700 and inside the rubble caps.
 * 3. Integration: the jet flown at 60 m/s with its left wing into a building's corner destroys
 *    blocks, loses a part (the wing), rolls afterwards; the building's top falls as rubble
 *    within the pool caps; step time stays reasonable; a reset restores the town.
 */
import * as THREE from 'three';
import { JET } from '../src/craft/jet.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import type { CraftDef } from '../src/craft/types.ts';
import type { ControlInputs } from '../src/sim/controls.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { TUNING } from '../src/tuning.ts';
import { blockKey, connectedGroups, findUnsupported, makeGrid, markSupport } from '../src/world/BlockBuilding.ts';
import type { BlockBuilding } from '../src/world/BlockBuilding.ts';

await initPhysics();

let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------- 1. anchor check
console.log('--- anchor check (BFS)');
{
  const g = makeGrid(3, 5, 3);
  markSupport(g);
  check(findUnsupported(g).length === 0, 'intact 3×5×3 tower fully supported');

  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) g.get(blockKey(x, 1, z))!.alive = false;
  markSupport(g);
  const loose = findUnsupported(g);
  const above = [...g.values()].filter((b) => b.alive && b.y >= 2);
  check(
    loose.length === above.length && loose.length === 27 && loose.every((b) => b.y >= 2),
    'remove the y=1 layer -> all y>=2 unsupported',
    `${loose.length} unsupported of ${above.length} above`,
  );
  check(
    [...g.values()].filter((b) => b.y === 0).every((b) => b.supported),
    'ground layer stays supported',
  );
  const groups = connectedGroups(loose);
  check(groups.length === 1 && groups[0].length === 27, 'the loose top is one connected chunk', `${groups.length} group(s)`);
}
{
  const g = makeGrid(3, 5, 3);
  for (let y = 0; y < 5; y++) g.get(blockKey(0, y, 0))!.alive = false;
  markSupport(g);
  check(findUnsupported(g).length === 0, 'remove a corner column -> all still supported');
}
{
  // Two separate floating pieces split into two chunks; a dead block is never "supported".
  const g = makeGrid(3, 3, 1);
  for (let x = 0; x < 3; x++) g.get(blockKey(x, 0, 0))!.alive = false; // whole ground row gone
  g.get(blockKey(1, 1, 0))!.alive = false;
  g.get(blockKey(1, 2, 0))!.alive = false;
  markSupport(g);
  const loose = findUnsupported(g);
  check(loose.length === 4 && connectedGroups(loose).length === 2, 'two separate loose pieces -> two chunks');
  check([...g.values()].every((b) => b.alive || !b.supported), 'dead blocks are never supported');
}

// ---------------------------------------------------------------- 2. town layout
console.log('\n--- town layout');
{
  const sim = new Simulation(TEST_PLANE);
  const town = sim.town;
  const maxX = Math.max(...town.buildings.map((b) => b.def.origin[0] + b.def.size[0] * b.blockSize));
  check(town.buildings.length >= 10, `town has ${town.buildings.length} buildings, ${town.blockCount} blocks`);
  check(maxX < -700, 'every building is west of x = -700', `east-most edge x=${maxX.toFixed(1)}`);
  const biggest = Math.max(...town.buildings.map((b) => b.list.length));
  check(biggest <= TUNING.maxDynamicChunkColliders, 'any building fits the rubble collider cap', `largest ${biggest} blocks`);
  // Buildings must not overlap.
  let overlap = false;
  const bs = town.buildings;
  for (let i = 0; i < bs.length; i++)
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i].def;
      const b = bs[j].def;
      const s = TUNING.blockSize;
      if (
        a.origin[0] < b.origin[0] + b.size[0] * s &&
        b.origin[0] < a.origin[0] + a.size[0] * s &&
        a.origin[2] < b.origin[2] + b.size[2] * s &&
        b.origin[2] < a.origin[2] + a.size[2] * s
      )
        overlap = true;
    }
  check(!overlap, 'no two buildings overlap');
}

// ---------------------------------------------------------------- 3. crash
const idle: ControlInputs = { pitch: 0, roll: 0, yaw: 0, throttle: 0.6, brake: 0 };

/** Bank angle rate around the craft's nose (rad/s, body frame). */
function rollRate(sim: Simulation): number {
  const av = sim.craft.body.angvel();
  const r = sim.craft.body.rotation();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
  return fwd.dot(new THREE.Vector3(av.x, av.y, av.z));
}

/** Tallest building (most room for the top to fall). */
function tallest(sim: Simulation): BlockBuilding {
  return sim.town.buildings.reduce((a, b) => (b.def.size[1] > a.def.size[1] ? b : a));
}

function crash(def: CraftDef, label: string, wingReach: number) {
  console.log(`\n--- ${label} at 60 m/s, left wing into a building corner`);
  const sim = new Simulation(def);
  const b = tallest(sim);
  const s = b.blockSize;
  const [ox, , oz] = b.def.origin;
  const maxX = ox + b.def.size[0] * s;
  const maxZ = oz + b.def.size[2] * s;
  // Fly -Z (the craft's forward) along the building's east face, centreline outside it, so the
  // left wing overlaps the face by ~1.5 m and the fuselage just clears the corner.
  const com = sim.craft.massProps.com;
  const x = maxX + (wingReach - 1.5);
  const y = s * 1.5; // second floor
  const body = sim.craft.body;
  body.setTranslation({ x: x - com.x, y: y - com.y, z: maxZ + 25 - com.z }, true);
  body.setLinvel({ x: 0, y: 0, z: -60 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);

  let peakDyn = 0;
  let peakDynCols = 0;
  let maxStepMs = 0;
  let sumStepMs = 0;
  let steps = 0;
  let impactTime = -1;
  let roll = 0;
  const totalBlocks = b.list.length;
  for (let i = 0; i < Math.round(4 / sim.dt); i++) {
    sim.step(idle);
    steps++;
    sumStepMs += sim.lastStepMs;
    maxStepMs = Math.max(maxStepMs, sim.lastStepMs);
    peakDyn = Math.max(peakDyn, sim.town.pool.dynamicChunks);
    peakDynCols = Math.max(peakDynCols, sim.town.pool.dynamicColliders);
    if (impactTime < 0 && sim.failures.length) impactTime = sim.time;
    // Roll rate half a second after the first part broke off.
    if (impactTime >= 0 && Math.abs(sim.time - impactTime - 0.5) < sim.dt / 2) roll = rollRate(sim);
  }
  const dead = b.list.filter((x) => !x.alive).length;
  const town = sim.town;
  check(town.destroyed > 0, 'at least one block destroyed', `${town.destroyed} destroyed, ${dead}/${totalBlocks} gone from the building`);
  const parts = sim.failures.map((f) => `${f.partId}:${f.cause}`);
  check(sim.failures.length > 0, 'at least one craft part detached', parts.join(', '));
  check(sim.failures.some((f) => f.partId.startsWith('wing')), 'a wing broke off');
  check(Math.abs(roll) > 0.05, 'nonzero roll rate after the hit', `${roll.toFixed(2)} rad/s`);
  check(
    peakDyn <= TUNING.maxDynamicChunks && peakDynCols <= TUNING.maxDynamicChunkColliders,
    'rubble within the pool caps',
    `peak ${peakDyn} chunks / ${peakDynCols} colliders, ${town.pool.chunks.length} chunks now`,
  );
  check(sim.explosionResets === 0, 'no explosion resets');
  const avg = sumStepMs / steps;
  check(avg < 4, 'physics step time reasonable', `avg ${avg.toFixed(3)} ms, max ${maxStepMs.toFixed(2)} ms, ${sim.bodyCount} bodies`);
  return sim;
}

const jetSim = crash(JET, 'jet', 4.9);
crash(TEST_PLANE, 'trainer', 4.9);

// The top of a building falls when its supports go.
console.log('\n--- collapse: knock out a whole floor');
{
  const sim = jetSim;
  sim.resetToRunway();
  check(sim.town.destroyed === 0 && sim.town.pool.chunks.length === 0 && sim.town.buildings.every((b) => b.aliveCount === b.list.length), 'reset restores the town');
  const b = tallest(sim);
  const top = b.list.filter((x) => x.y >= 2).length;
  for (const x of b.list) if (x.y === 1) b.remove(x);
  // Removing blocks directly doesn't run the anchor check; a hit does. Strike one ground block.
  sim.town.onContact({
    collider1: b.list[0].collider!.handle, collider2: -1,
    totalForceMagnitude: 1e9 / sim.dt, maxForceMagnitude: 1e9 / sim.dt, dt: sim.dt, time: sim.time,
  });
  const idle0: ControlInputs = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };
  sim.step(idle0);
  const chunks = sim.town.pool.chunks.filter((c) => c.building === b);
  check(chunks.length === 1 && chunks[0].blocks.length === top, 'the floors above fall as one chunk', `${chunks.length} chunk(s), ${chunks[0]?.blocks.length ?? 0}/${top} blocks`);
  const y0 = chunks[0]?.body.translation().y ?? 0;
  let shattered = false;
  for (let i = 0; i < Math.round(4 / sim.dt); i++) {
    sim.step(idle0);
    if (!sim.town.pool.chunks.includes(chunks[0])) shattered = true;
  }
  check(shattered || (chunks[0] && chunks[0].body.translation().y < y0 - 1), 'the chunk falls (and shatters on landing)', shattered ? 'shattered' : `y ${y0.toFixed(1)} -> ${chunks[0]?.body.translation().y.toFixed(1)}`);
  check(sim.town.destroyed > 0, 'landing destroyed blocks', `${sim.town.destroyed} destroyed`);
}

// Exercise the hard limits with live rubble rather than only an intact town.
console.log('\n--- rubble capacity');
{
  const sim = new Simulation(TEST_PLANE);
  const b = tallest(sim);
  const pool = sim.town.pool;
  const block = b.list[0];
  b.remove(block);
  // More than one chunk per permitted slot must freeze the oldest chunks, never overflow.
  let capsHeld = true;
  for (let i = 0; i < TUNING.maxDynamicChunks + 8; i++) {
    pool.spawn(b, [block], sim.time);
    capsHeld &&= pool.dynamicChunks <= TUNING.maxDynamicChunks && pool.dynamicColliders <= TUNING.maxDynamicChunkColliders;
  }
  check(capsHeld && pool.chunks.some((c) => c.frozen), 'chunk cap freezes oldest rubble without overflowing');
  pool.clear();
  // Three large groups force eviction on the collider limit before the chunk limit.
  const group = b.list.slice(0, 180);
  for (const block of group) b.remove(block);
  for (let i = 0; i < 3; i++) pool.spawn(b, group, sim.time);
  check(pool.dynamicChunks === 2 && pool.dynamicColliders === group.length * 2 && pool.chunks[0].frozen, 'collider cap freezes oldest compound rubble');
  const before = pool.chunks.length;
  check(pool.spawn(b, Array.from({ length: TUNING.maxDynamicChunkColliders + 1 }, () => block), sim.time) === null && pool.chunks.length === before, 'oversized groups cannot bypass collider cap');
  sim.resetToRunway();
  check(pool.chunks.length === 0 && b.aliveCount === b.list.length, 'reset removes frozen and dynamic rubble and restores blocks');
}

if (failed) {
  console.error(`\n${failed} building check(s) failed`);
  process.exit(1);
}
console.log('\nall building checks passed');
