/**
 * Bits: the people of the Grid. Run with `npm run bit`.
 *
 * 1. The four figures are the imported polyhedra: closed, centred, unit circumradius.
 * 2. The state logic: idle alternates between the two blue figures, an answer shows for a
 *    moment and then it idles again.
 * 3. People: Bits live on blocks with streets and walk the kerb, deterministic for the world;
 *    they stand, turn back, stop to talk, flinch from fast vehicles and explosions, answer the
 *    player, and derez when run over.
 * 4. On foot: the player steps out of a stopped vehicle as a Bit, walks, turns, sidesteps, is
 *    stopped by walls, and gets back in beside the vehicle.
 */
import { BIT, BIT_LOOK, BIT_SHAPES, bitState, type BitState } from '../src/people/bit.ts';
import { LIGHT_CAR } from '../src/craft/lightCar.ts';
import { BITS, BitPopulation, blockPopulation } from '../src/sim/bits.ts';
import type { ControlInputs } from '../src/sim/controls.ts';
import { CITY } from '../src/sim/layout.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { terrainHeight } from '../src/sim/terrain.ts';
import { GRID } from '../src/world/planetCity.ts';
import { worldStructures } from '../src/world/structures.ts';

await initPhysics();
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const r2 = (x: number) => x.toFixed(2);

console.log('--- figures');
const EXPECT: Record<BitState, [number, number]> = { yes: [6, 8], no: [182, 360], idle1: [86, 168], idle2: [32, 80] };
for (const s of Object.keys(EXPECT) as BitState[]) {
  const { positions, indices } = BIT_SHAPES[s];
  const nv = positions.length / 3, nt = indices.length / 3;
  let rMax = 0;
  const c = [0, 0, 0];
  for (let i = 0; i < positions.length; i += 3) {
    rMax = Math.max(rMax, Math.hypot(positions[i], positions[i + 1], positions[i + 2]));
    for (let k = 0; k < 3; k++) c[k] += positions[i + k] / nv;
  }
  // Closed surface: every edge is shared by exactly two triangles.
  const edges = new Map<string, number>();
  for (let i = 0; i < indices.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = indices[i + k], b = indices[i + (k + 1) % 3];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  const open = [...edges.values()].filter((n) => n % 2 !== 0).length; // stellations meet themselves along edges: 4 is closed too
  check(nv === EXPECT[s][0] && nt === EXPECT[s][1], `${s}: ${nv} vertices, ${nt} triangles`);
  check(Math.abs(rMax - 1) < 1e-3 && Math.hypot(...c) < 0.02, `${s}: centred, unit circumradius`, `r ${r2(rMax)}, centroid off by ${r2(Math.hypot(...c))}`);
  check(open === 0, `${s}: a closed solid`, `${open} open edges`);
}
check(BIT_LOOK.idle1.color === BIT_LOOK.idle2.color && BIT_LOOK.yes.color !== BIT_LOOK.no.color && BIT_LOOK.yes.color !== BIT_LOOK.idle1.color, 'idle figures share a colour; yes and no have their own');

console.log('\n--- states');
{
  const seen = new Set<BitState>();
  let flips = 0, last: BitState | null = null;
  for (let t = 0; t < 10; t += 0.01) {
    const s = bitState(t);
    seen.add(s);
    if (last && s !== last) flips++;
    last = s;
  }
  check(seen.size === 2 && seen.has('idle1') && seen.has('idle2'), 'idle shows only the two idle figures');
  check(Math.abs(flips - 10 / BIT.idleBeat) <= 1, 'idle alternates on the beat', `${flips} changes in 10 s`);
  check(bitState(5.2, 'yes', 5) === 'yes' && bitState(5.2, 'no', 5) === 'no', 'an answer shows at once');
  const after = bitState(5 + BIT.answerTime + 0.01, 'yes', 5);
  check(after === 'idle1' || after === 'idle2', 'then it idles again', `after ${BIT.answerTime} s`);
  check(bitState(4.9, 'yes', 5) !== 'yes', 'an answer does not show before it is given');
}

console.log('\n--- people');
const neutral: ControlInputs = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };
{
  const sim = new Simulation(LIGHT_CAR);
  sim.traffic.enabled = false;
  const street = { x: sim.position.x, z: sim.position.z };
  for (let i = 0; i < 120; i++) sim.step(neutral);
  const people = sim.bits.people;
  check(people.length >= 12 && people.length <= BITS.max, 'the streets around the player have people on them', `${people.length} Bits within ${BITS.radius} m`);
  check(people.every((p) => blockPopulation(p.gi, p.gj) > p.slot), 'each lives on a block that has streets');
  // On the kerb: just outside the block, clear of the lanes and of the buildings.
  const P = CITY.block + CITY.street;
  const offKerb = people.filter((p) => {
    const lx = Math.abs(((p.x - GRID.x0) % P + P) % P - P / 2), lz = Math.abs(((p.z - GRID.z0) % P + P) % P - P / 2);
    const out = Math.max(lx, lz) - CITY.block / 2; // distance outside the block edge
    return out < BITS.kerb - 2.8 || out > BITS.kerb + 0.05;
  }).length;
  check(offKerb === 0, 'they keep to the kerb, off the lanes', `${offKerb} off it`);
  check(people.every((p) => Math.abs(p.y - terrainHeight(p.x, p.z) - BIT.hover) < 1e-6), 'each hovers over the ground');
  // Deterministic: the same streets hold the same people.
  const again = new Simulation(LIGHT_CAR);
  again.traffic.enabled = false;
  for (let i = 0; i < 120; i++) again.step(neutral);
  const sig = (s: Simulation) => s.bits.people.map((p) => `${p.gi},${p.gj},${p.slot},${p.x.toFixed(3)},${p.z.toFixed(3)}`).join(';');
  check(sig(sim) === sig(again), 'the same world has the same people in the same places');
  // They walk, stand, and stop to talk.
  const start = new Map(people.map((p) => [p.id, [p.x, p.z]]));
  const moods = new Set<string>(), said = new Set<string>();
  for (let i = 0; i < 90 * 120; i++) {
    sim.step(neutral);
    if (i % 30 === 0) for (const p of sim.bits.people) { moods.add(p.mood); said.add(sim.bits.stateOf(p, sim.time)); }
  }
  const moved = sim.bits.people.filter((p) => { const a = start.get(p.id); return a && Math.hypot(p.x - a[0], p.z - a[1]) > 5; }).length;
  check(moved > people.length * 0.6, 'they walk their blocks', `${moved} of ${people.length} moved on in 90 s`);
  check(moods.has('walk') && moods.has('stand'), 'they stop and stand a while', [...moods].join(', '));
  check(sim.bits.talks > 0 && moods.has('talk') && said.has('yes') && said.has('no'), 'two that meet stop to talk: YES and NO are said', `${sim.bits.talks} conversations in 90 s`);
  check(said.has('idle1') && said.has('idle2'), 'left alone they idle between the two blue figures');
  check(sim.bits.derezzed === 0 && Math.hypot(sim.position.x - street.x, sim.position.z - street.z) < 5, 'a parked vehicle hurts nobody');
}
{
  // A vehicle coming past fast: they say NO and step back; one that is run over derezzes.
  const pop = new BitPopulation();
  const sim = new Simulation(LIGHT_CAR);
  const c = { x: sim.position.x, z: sim.position.z };
  pop.step(1 / 120, 0, c);
  const p = pop.people[0];
  const threat = { x: p.x - 10, y: p.y, z: p.z, vx: 20, vz: 0 };
  pop.step(1 / 120, 0.01, c, [threat]);
  check(p.mood === 'scared' && pop.stateOf(p, 0.02) === 'no' && p.backTo > 0, 'a vehicle bearing down: it says NO and steps back from the road');
  const away = pop.people.find((q) => Math.hypot(q.x - threat.x, q.z - threat.z) > BITS.scareRange * 2)!;
  check(away.mood !== 'scared', 'the ones farther off carry on');
  const n = pop.people.length, slot = p.slot, gi = p.gi, gj = p.gj;
  pop.step(1 / 120, 0.02, c, [{ ...threat, x: p.x, z: p.z }]);
  check(pop.people.length === n - 1 && pop.derezzed === 1 && pop.derezEvents.length === 1, 'run over, it derezzes');
  for (let t = 0.03; t < 5; t += 0.5) pop.step(0.5, t, c);
  check(!pop.people.some((q) => q.gi === gi && q.gj === gj && q.slot === slot), 'and does not pop back while its block is in view');
  // The player's Bit speaks: those in earshot turn and answer.
  const q = pop.people[0];
  const heard = pop.hear(q.x + 2, q.z, 6);
  let answered = false;
  for (let t = 6; t < 8; t += 1 / 60) { pop.step(1 / 60, t, c); const s = pop.stateOf(q, t); if (s === 'yes' || s === 'no') answered = true; }
  check(heard >= 1 && answered, 'spoken to, a Bit turns and answers', `${heard} in earshot`);
  pop.scare(q.x, q.z, 30, 9);
  check(q.mood === 'scared' && pop.stateOf(q, 9.1) === 'no', 'an explosion nearby: NO');
}

console.log('\n--- on foot');
{
  const sim = new Simulation(LIGHT_CAR);
  sim.traffic.enabled = false;
  sim.bits.enabled = false;
  for (let i = 0; i < 240; i++) sim.step(neutral);
  const parked = sim.position.clone();
  for (let i = 0; i < 360; i++) sim.step({ ...neutral, brake: 0, throttle: 1 });
  check(sim.exitVehicle() === 'Stop first', 'no stepping out of a moving vehicle');
  for (let i = 0; i < 600; i++) sim.step(neutral);
  check(sim.exitVehicle() === null && sim.walker.active, 'steps out of a stopped vehicle');
  const w = sim.walker;
  const beside = Math.hypot(w.x - sim.position.x, w.z - sim.position.z);
  check(beside > 1.5 && beside < 6 && Math.abs(w.y - terrainHeight(w.x, w.z)) < 0.05, 'it stands on the ground beside it', `${r2(beside)} m away`);
  const car = sim.position.clone();
  const from = [w.x, w.z];
  sim.walkInput = { forward: 1, turn: 0, strafe: 0 };
  for (let i = 0; i < 5 * 120; i++) sim.step({ ...neutral, brake: 0, throttle: 1 }); // the vehicle's controls are dead
  const walked = Math.hypot(w.x - from[0], w.z - from[1]);
  check(walked > 25 && walked < 40, 'walks forward at a walking pace', `${r2(walked)} m in 5 s`);
  check(sim.position.distanceTo(car) < 0.5, 'the vehicle stays parked where it was left', `${r2(sim.position.distanceTo(car))} m`);
  const yaw0 = w.yaw;
  sim.walkInput = { forward: 0, turn: 1, strafe: 0 };
  for (let i = 0; i < 120; i++) sim.step(neutral);
  check(Math.abs(w.yaw - yaw0) > 1.5 && Math.hypot(w.vx, w.vz) < 0.2, 'turns where it stands', `${((w.yaw - yaw0) * 180 / Math.PI).toFixed(0)}° in 1 s`);
  const side0 = [w.x, w.z];
  sim.walkInput = { forward: 0, turn: 0, strafe: 1 };
  for (let i = 0; i < 240; i++) sim.step(neutral);
  const fwd = [-Math.sin(w.yaw), -Math.cos(w.yaw)];
  const along = (w.x - side0[0]) * fwd[0] + (w.z - side0[1]) * fwd[1];
  check(Math.hypot(w.x - side0[0], w.z - side0[1]) > 5 && Math.abs(along) < 1, 'sidesteps');
  check(sim.boardVehicle() === 'Too far from your vehicle', 'cannot board from far away');
  // A wall stops it: walk at the nearest building.
  sim.walkInput = { forward: 0, turn: 0, strafe: 0 };
  let best: { d: number; x: number; z: number } | null = null;
  for (const b of worldStructures().list) {
    if (b.sy < 6) continue;
    const d = Math.hypot(b.x - w.x, b.z - w.z);
    if (!best || d < best.d) best = { d, x: b.x, z: b.z };
  }
  if (best) {
    w.yaw = Math.atan2(-(best.x - w.x), -(best.z - w.z));
    sim.walkInput = { forward: 1, turn: 0, strafe: 0 };
    let closest = Infinity;
    for (let i = 0; i < 60 * 120; i++) { sim.step(neutral); closest = Math.min(closest, Math.hypot(best.x - w.x, best.z - w.z)); }
    check(closest > 1 && closest < best.d, 'a building stops it: it does not walk through walls', `stopped ${r2(closest)} m from the centre of a structure ${r2(best.d)} m away`);
  }
  check(w.say('yes', sim.time) && w.state(sim.time + 0.1) === 'yes' && !w.say('yes', sim.time + 0.2), 'it says YES (a held key is one answer)');
  // Back to the vehicle and aboard.
  w.exit(car.x + 3, terrainHeight(car.x + 3, car.z), car.z, 0);
  check(sim.boardVehicle() === null && !sim.walker.active, 'beside the vehicle it gets back in');
  for (let i = 0; i < 360; i++) sim.step({ ...neutral, brake: 0, throttle: 1 });
  check(sim.position.distanceTo(car) > 5, 'and drives off', `${r2(sim.position.distanceTo(car))} m`);
  void parked;
}

console.log(failures ? `\n${failures} FAILED` : '\nAll Bit checks passed');
process.exit(failures ? 1 : 0);
