/**
 * Bits: the people of the Grid. Run with `npm run bit`.
 *
 * 1. The four figures are the imported polyhedra: closed, centred, unit circumradius.
 * 2. The state logic: idle alternates between the two blue figures, an answer shows for a
 *    moment and then it idles again.
 * 3. People: Bits live on lots, deterministic for the world: indoors in their building's room
 *    and on the kerb round it. They go in and out by the doors, never stand in a wall, stand,
 *    turn back, stop to talk, flinch from fast vehicles and explosions, answer the player, and
 *    derez when run over.
 * 4. On foot: the player steps out of a stopped vehicle as a Bit, walks, turns, sidesteps, is
 *    stopped by walls, walks into a building's room through its door, and gets back in beside
 *    the vehicle.
 */
import { BIT, BIT_LOOK, BIT_SHAPES, bitState, type BitState } from '../src/people/bit.ts';
import { LIGHT_CAR } from '../src/craft/lightCar.ts';
import { BITS, BitPopulation, BitWalker, lotPopulation, type BitHome, type BitPerson } from '../src/sim/bits.ts';
import { Errands, ERRANDS } from '../src/sim/errands.ts';
import { CHARGE, STRATEGIC } from '../src/sim/strategic.ts';
import { DEFAULT_BIT_STYLE, sanitizeBitStyle, styledState } from '../src/people/bitStyle.ts';
import { KIT, kitSolid } from '../src/world/kit.ts';
import { kitRoomId } from '../src/world/structures.ts';
import type { RoomDoor } from '../src/arch/InteriorGenerator.ts';
import type { ControlInputs } from '../src/sim/controls.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { terrainHeight } from '../src/sim/terrain.ts';
import { structureMask, worldStructures } from '../src/world/structures.ts';
import { TUNING } from '../src/tuning.ts';
import { districtLayout, districtPlan } from '../src/arch/DistrictGenerator.ts';
import { GRID } from '../src/arch/grid.ts';

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
const inRoom = (p: BitPerson) => { const r = p.home.room; return !!r && p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1; };
{
  const sim = new Simulation(LIGHT_CAR);
  sim.traffic.enabled = false;
  const street = { x: sim.position.x, z: sim.position.z };
  for (let i = 0; i < 120; i++) sim.step(neutral);
  const people = sim.bits.people;
  check(people.length >= 12 && people.length <= BITS.max, 'the lots around the player have people', `${people.length} Bits within ${BITS.radius} m, ${sim.bits.indoors} of them indoors`);
  // On the kerb: just outside the lot, clear of the lanes and of the buildings.
  const offKerb = people.filter((p) => {
    if (p.place !== 'kerb') return false;
    const h = p.home;
    const out = Math.max(h.x0 - p.x, p.x - h.x1, h.z0 - p.z, p.z - h.z1); // 0 on the kerb line, negative stepped back
    return out > 0.05 || out < -2.8;
  }).length;
  check(offKerb === 0, 'outdoors they keep to the kerb round their lot, off the lanes', `${offKerb} off it`);
  check(people.every((p) => Math.abs(p.y - (inRoom(p) ? p.home.room!.y : terrainHeight(p.x, p.z)) - BIT.hover) < 1e-6), 'each hovers over the floor it is on');
  // Deterministic: the same streets hold the same people.
  const again = new Simulation(LIGHT_CAR);
  again.traffic.enabled = false;
  for (let i = 0; i < 120; i++) again.step(neutral);
  const sig = (s: Simulation) => s.bits.people.map((p) => `${p.home.key},${p.slot},${p.place},${p.x.toFixed(3)},${p.z.toFixed(3)}`).join(';');
  check(sig(sim) === sig(again), 'the same world has the same people in the same places');

  const start = new Map(people.map((p) => [p.id, [p.x, p.z]]));
  const moods = new Set<string>(), said = new Set<string>();
  for (let i = 0; i < 180 * 120; i++) {
    sim.step(neutral);
    if (i % 30 === 0) for (const p of sim.bits.people) { moods.add(p.mood); said.add(sim.bits.stateOf(p, sim.time)); }
  }
  const moved = sim.bits.people.filter((p) => { const a = start.get(p.id); return a && Math.hypot(p.x - a[0], p.z - a[1]) > 5; }).length;

  console.log('\n--- daily life');
  check(moved > people.length * 0.5, 'they get about', `${moved} of ${people.length} moved on in 3 min`);
  check(moods.has('walk') && moods.has('stand'), 'they stop and stand a while', [...moods].join(', '));
  check(sim.bits.talks > 0 && moods.has('talk') && said.has('yes') && said.has('no'), 'two that meet stop to talk: YES and NO are said', `${sim.bits.talks} conversations in 3 min`);
  check(said.has('idle1') && said.has('idle2'), 'left alone they idle between the two blue figures');
  check(sim.bits.derezzed === 0 && Math.hypot(sim.position.x - street.x, sim.position.z - street.z) < 5, 'a parked vehicle hurts nobody');
}
{
  console.log('\n--- interiors');
  // A built-up part of town, away from the airfield.
  const c = { x: -2600, z: -1500 };
  const pop = new BitPopulation();
  pop.step(1 / 30, 0, c);
  const homes = [...pop.homes.values()];
  const rooms = homes.filter((h) => h.room);
  const programs = new Map<string, number>();
  for (const h of rooms) programs.set(h.room!.program, (programs.get(h.room!.program) ?? 0) + 1);
  check(rooms.length >= 5, 'buildings have rooms for their people', `${rooms.length} of ${homes.length} lots near (${c.x}, ${c.z}): ${[...programs].map(([k, n]) => `${n} ${k}`).join(', ')}`);
  check(rooms.every((h) => h.room!.doors.every((d) => d.depth >= 3 && Math.abs(d.nx) + Math.abs(d.nz) === 1)), 'every door has a clear aisle behind it');
  check(pop.indoors > 5 && pop.people.filter((p) => p.place === 'inside').every(inRoom), 'some are at home indoors when their lot comes into view', `${pop.indoors} of ${pop.people.length} indoors`);
  // Nobody stands in a wall or in the machinery: check against the buildings' own colliders.
  const solid: Array<{ x: number; y: number; z: number; sx: number; sy: number; sz: number }> = [];
  const seen = new Set<string>();
  for (const h of homes) {
    const ci = Math.floor(h.gi / GRID.chunkBlocks), cj = Math.floor(h.gj / GRID.chunkBlocks);
    if (seen.has(`${ci},${cj}`)) continue;
    seen.add(`${ci},${cj}`);
    for (const st of districtPlan(ci, cj).structures) solid.push(...st.colliders);
  }
  const inSolid = (p: BitPerson) => solid.some((b) => Math.abs(p.x - b.x) < b.sx / 2 - 0.1 && Math.abs(p.z - b.z) < b.sz / 2 - 0.1 && Math.abs(p.y - b.y) < b.sy / 2);
  const places = new Set<string>();
  let stuck = 0, indoorTalk = false, astray = 0, peak = 0;
  for (let i = 0; i < 480 * 30; i++) {
    pop.step(1 / 30, i / 30, c);
    if (i % 15 === 0) for (const p of pop.people) {
      places.add(p.place);
      if (p.place === 'inside' && p.mood === 'talk') indoorTalk = true;
      if (p.place === 'inside' && !inRoom(p)) astray++;
      if (inSolid(p)) stuck++;
    }
    peak = Math.max(peak, pop.indoors);
  }
  check(pop.entries > 3 && pop.exits > 3 && places.has('way'), 'they go in by the doors and come out again', `${pop.entries} went in, ${pop.exits} came out in 8 min`);
  check(astray === 0, 'indoors they stay in their room');
  check(stuck === 0, 'nobody is ever inside a wall or the machinery', `${solid.length} colliders, ${stuck} bad samples`);
  check(indoorTalk, 'they talk indoors too');
  check(pop.indoors > 0 && pop.indoors < pop.people.length, 'the town is never all indoors or all out', `${pop.indoors} of ${pop.people.length} indoors after 8 min (peak ${peak})`);
}
{
  // A vehicle coming past fast: they say NO and step back; one that is run over derezzes.
  const pop = new BitPopulation();
  const sim = new Simulation(LIGHT_CAR);
  const c = { x: sim.position.x, z: sim.position.z };
  pop.step(1 / 120, 0, c);
  const p = pop.people.find((q) => q.place === 'kerb')!;
  const threat = { x: p.x - 10, y: p.y, z: p.z, vx: 20, vz: 0 };
  pop.step(1 / 120, 0.01, c, [threat]);
  check(p.mood === 'scared' && pop.stateOf(p, 0.02) === 'no' && p.backTo > 0, 'a vehicle bearing down: it says NO and steps back from the road');
  const away = pop.people.find((q) => Math.hypot(q.x - threat.x, q.z - threat.z) > BITS.scareRange * 2)!;
  check(away.mood !== 'scared', 'the ones farther off carry on');
  const n = pop.people.length, slot = p.slot, home = p.home;
  pop.step(1 / 120, 0.02, c, [{ ...threat, x: p.x, z: p.z }]);
  check(pop.people.length === n - 1 && pop.derezzed === 1 && pop.derezEvents.length === 1, 'run over, it derezzes');
  for (let t = 0.03; t < 5; t += 0.5) pop.step(0.5, t, c);
  check(!pop.people.some((q) => q.home === home && q.slot === slot), 'and does not pop back while its lot is in view');
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
  // Through a door on foot: the rooms are real space, with a real opening.
  {
    sim.bits.enabled = true;
    sim.step(neutral);
    sim.bits.enabled = false;
    let best: { d: number; h: BitHome; door: RoomDoor } | null = null;
    for (const h of sim.bits.homes.values()) for (const door of h.room?.doors ?? []) {
      const d = Math.hypot(door.x - sim.position.x, door.z - sim.position.z);
      if (door.rise < 0.3 && (!best || d < best.d)) best = { d, h, door };
    }
    if (best) {
      const { door, h } = best;
      w.exit(door.x + door.nx * 5, terrainHeight(door.x + door.nx * 5, door.z + door.nz * 5), door.z + door.nz * 5, Math.atan2(door.nx, door.nz));
      sim.walkInput = { forward: 1, turn: 0, strafe: 0 };
      const want = Math.min(door.depth - 1, 8);
      for (let i = 0; i < 4 * 120; i++) {
        sim.step(neutral);
        if ((door.x - w.x) * door.nx + (door.z - w.z) * door.nz >= want) break;
      }
      const r = h.room!;
      const inside = w.x > r.x0 && w.x < r.x1 && w.z > r.z0 && w.z < r.z1;
      check(inside && Math.abs(w.y - r.y) < 0.4, 'it walks in through a door and stands in the room', `${r.program} ${r2(best.d)} m from the vehicle, ${r2((door.x - w.x) * door.nx + (door.z - w.z) * door.nz)} m inside`);
      // And the walls of the room hold it in.
      w.yaw += Math.PI / 2;
      for (let i = 0; i < 30 * 120; i++) sim.step(neutral);
      check(w.x > r.x0 - 0.5 && w.x < r.x1 + 0.5 && w.z > r.z0 - 0.5 && w.z < r.z1 + 0.5, 'and the walls keep it in');
    } else check(false, 'a room with a ground-level door near the vehicle');
    sim.walkInput = { forward: 0, turn: 0, strafe: 0 };
  }
  check(w.say('yes', sim.time) && w.state(sim.time + 0.1) === 'yes' && !w.say('yes', sim.time + 0.2), 'it says YES (a held key is one answer)');
  // Back to the vehicle and aboard.
  w.exit(car.x + 3, terrainHeight(car.x + 3, car.z), car.z, 0);
  check(sim.boardVehicle() === null && !sim.walker.active, 'beside the vehicle it gets back in');
  for (let i = 0; i < 360; i++) sim.step({ ...neutral, brake: 0, throttle: 1 });
  check(sim.position.distanceTo(car) > 5, 'and drives off', `${r2(sim.position.distanceTo(car))} m`);
  void parked;
}

console.log('\n--- kit towers');
{
  // Find a kit tower with people, and let a few minutes pass.
  let found: { x: number; z: number; type: number; rot: number; scale: number } | null = null;
  for (let ci = -3; ci <= 3 && !found; ci++) for (let cj = -3; cj <= 3 && !found; cj++) for (const l of districtLayout(ci, cj).lots) {
    if (l.kind !== 'kit' || !l.kit || lotPopulation(l) < 3) continue;
    found = { x: (l.rect.x0 + l.rect.x1) / 2, z: (l.rect.z0 + l.rect.z1) / 2, ...l.kit };
    break;
  }
  // Every kit tower type: its room and the way out of each doorway are clear of its walls.
  let types = 0, blockedCells = 0;
  for (const t of KIT) {
    if (!t.room) continue;
    types++;
    const [W, , D] = t.grid;
    const cellOf = (x: number, z: number, y: number) => kitSolid(t, Math.floor((x + (W * t.cell) / 2) / t.cell), Math.floor(y / t.cell), Math.floor((z + (D * t.cell) / 2) / t.cell));
    const r = t.room;
    for (let x = r.x0 + 0.5; x < r.x1; x += 1) for (let z = r.z0 + 0.5; z < r.z1; z += 1) if (cellOf(x, z, 1)) blockedCells++;
    for (const d of r.doors) for (let k = -d.through / 2; k < 60; k += 0.5) for (const lat of [-d.width / 2 + 0.4, 0, d.width / 2 - 0.4]) {
      if (cellOf(d.x + d.nx * k - d.nz * lat, d.z + d.nz * k + d.nx * lat, 1)) blockedCells++;
    }
  }
  check(types === KIT.length && blockedCells === 0, 'every kit tower type has a room, open and with a clear way out', `${types} of ${KIT.length} types, ${blockedCells} blocked cells`);
  check(!!found, 'test setup: a kit tower with people');
  if (found) {
    const pop = new BitPopulation();
    pop.step(1 / 30, 0, found);
    const home = [...pop.homes.values()].find((h) => h.room?.id === kitRoomId(found!.x, found!.z));
    check(!!home && home.room!.doors.length > 0, 'a kit tower has a room with doorways for its people', home ? `${(home.room!.x1 - home.room!.x0).toFixed(0)} × ${(home.room!.z1 - home.room!.z0).toFixed(0)} m, ${home.room!.doors.length} doors` : 'no room');
    if (home) {
      const t = KIT[found.type];
      // Is (x, y, z) in a solid cell of the tower? (World → the tower's own frame, then its grid.)
      const solidAt = (x: number, y: number, z: number) => {
        const a = -(found!.rot * Math.PI) / 2, c = Math.cos(a), sn = Math.sin(a);
        const dx = (x - found!.x) / found!.scale, dz = (z - found!.z) / found!.scale;
        const lx = dx * c + dz * sn, lz = -dx * sn + dz * c;
        const [W, , D] = t.grid;
        return kitSolid(t, Math.floor((lx + (W * t.cell) / 2) / t.cell), Math.floor(y / found!.scale / t.cell), Math.floor((lz + (D * t.cell) / 2) / t.cell));
      };
      let inside = 0, inWall = 0, entered = 0;
      for (let k = 0; k < 360 * 30; k++) {
        pop.step(1 / 30, k / 30, found);
        if (k % 15) continue;
        for (const p of pop.people) {
          if (p.home !== home) continue;
          if (p.place === 'inside') inside++;
          if (solidAt(p.x, p.y - BIT.hover + 0.8, p.z)) inWall++;
        }
      }
      entered = pop.entries;
      check(inside > 0 && entered > 0, 'its people go in and spend time inside', `${entered} went in`);
      check(inWall === 0, 'nobody stands inside the tower\'s walls', `${inWall} samples`);
    }
  }
}

console.log('\n--- destruction');
{
  // A wrecked building empties: its people run out by the door and nobody goes back in.
  const c = { x: -2600, z: -1500 };
  const pop = new BitPopulation();
  pop.step(1 / 30, 0, c);
  const busy = [...pop.homes.values()].filter((h) => h.room).map((h) => ({ h, n: pop.people.filter((p) => p.home === h && p.place === 'inside').length })).sort((a, b) => b.n - a.n)[0];
  const h = busy.h;
  const indoors = pop.collapse(h.room!.id, 1);
  check(indoors === busy.n && indoors > 0 && h.ruined, 'a wrecked building: everyone indoors makes for the door', `${indoors} indoors`);
  check(pop.people.filter((p) => p.home === h).every((p) => pop.stateOf(p, 1.1) === 'no'), 'and its people say NO');
  let t = 1;
  for (; t < 120 && pop.people.some((p) => p.home === h && p.place !== 'kerb'); t += 1 / 30) pop.step(1 / 30, t, c);
  check(pop.people.filter((p) => p.home === h).every((p) => p.place === 'kerb' && !inRoom(p)), 'they get out to the kerb', `clear in ${(t - 1).toFixed(0)} s`);
  for (; t < 400; t += 1 / 30) pop.step(1 / 30, t, c);
  check(pop.people.filter((p) => p.home === h).every((p) => p.place === 'kerb'), 'and nobody goes back into the ruin');
  // Rubble and blasts derez whoever they reach.
  const q = pop.people[0];
  const n0 = pop.people.length;
  check(pop.strike(q.x, q.y, q.z, 2.6, t) >= 1 && pop.people.length < n0 && !pop.people.includes(q), 'rubble landing on a Bit derezzes it');
}
{
  // In the simulation: fracture a building with a room and its people are told; a block
  // breaking beside the player on foot takes the player down, and they come back aboard.
  const sim = new Simulation(LIGHT_CAR);
  sim.traffic.enabled = false;
  for (let i = 0; i < 60; i++) sim.step(neutral);
  const groups = sim.staticWorld.structures.groups;
  const withRoom = groups.filter((g) => g.room);
  check(withRoom.length > 20, 'structures carry their rooms into the destruction engine', `${withRoom.length} of ${groups.length} groups`);
  // The fracture grid is hollow where the room is, and open at a door.
  let hollow = 0, open = 0, tried = 0;
  for (const g of withRoom.slice(0, 40)) {
    const r = g.room!, s = g.blockSize;
    if (r.x1 - r.x0 < 3 * s || r.z1 - r.z0 < 3 * s || r.y1 - r.y0 < 2 * s) continue; // a room smaller than its blocks is just walls
    tried++;
    const mask = structureMask(g, sim.staticWorld.structures.list);
    const cell = (x: number, y: number, z: number) => mask(Math.floor((x - g.x0) / s), Math.floor(y / s), Math.floor((z - g.z0) / s));
    if (!cell((r.x0 + r.x1) / 2, r.y0 + s / 2, (r.z0 + r.z1) / 2)) hollow++;
    const d = r.doors[0];
    if (!cell(d.x, r.y0 + s / 2, d.z)) open++;
  }
  check(tried > 5 && hollow === tried && open === tried, 'fractured, a hollow structure is still hollow, with its doorway open', `${hollow} hollow and ${open} open of ${tried}`);
  const home = [...sim.bits.homes.values()].find((x) => x.room && groups.some((g) => g.arch === x.room!.id));
  if (home) {
    const g = groups.find((x) => x.arch === home.room!.id)!;
    sim.staticWorld.fracture(g.id, { impulse: 0, x: 0, y: 0, z: 0 }, sim.time, false);
    sim.step(neutral);
    check(home.ruined, 'when a building fractures its people are told');
  } else check(false, 'a home with a room near the vehicle');
  for (let i = 0; i < 600; i++) sim.step(neutral);
  check(sim.exitVehicle() === null, 'the player steps out');
  sim.town.breaks.push({ x: sim.walker.x + 1, y: sim.walker.y + 1, z: sim.walker.z, color: '#fff', time: sim.time + 1e-6 });
  sim.step(neutral);
  check(sim.walker.downAt !== null, 'a block breaking beside the player on foot derezzes them');
  const at = [sim.walker.x, sim.walker.z];
  sim.walkInput = { forward: 1, turn: 0, strafe: 0 };
  for (let i = 0; i < 120; i++) sim.step(neutral);
  check(Math.hypot(sim.walker.x - at[0], sim.walker.z - at[1]) < 0.01, 'down, they cannot walk');
  for (let i = 0; i < (TUNING.respawnDelay + 1) * 120; i++) sim.step(neutral);
  check(!sim.walker.active, 'and a moment later they are back in their vehicle');
}

console.log('\n--- charges set down by hand');
{
  const sim = new Simulation(LIGHT_CAR);
  sim.traffic.enabled = false;
  for (let i = 0; i < 600; i++) sim.step(neutral);
  sim.strategic = 'nuke';
  check(sim.placeStrategic() === 'Set charges down on foot' && sim.strategic === 'nuke', 'in a vehicle, ` does not set a charge down');
  check(sim.exitVehicle() === null, 'the player steps out');
  check(sim.placeStrategic() === null && sim.strategic === null && sim.charges.length === 1 && sim.charges[0].fuse === CHARGE.fuse.nuke, 'on foot, the nuke carried is set down with its fuse running', `${CHARGE.fuse.nuke} s`);
  check(sim.placeStrategic() === null && sim.strategic === 'nuke' && sim.charges.length === 0, 'standing over it, ` picks it up again (disarmed)');
  check(sim.placeStrategic() === null, 'set down again');
  const c = sim.charges[0];
  // Run the fuse down to its last seconds: too late to pick it up.
  for (let i = 0; i < (CHARGE.fuse.nuke - CHARGE.lockout + 1) * 120; i++) sim.step(neutral);
  check(sim.placeStrategic() === 'Too late to pick it up: run' && sim.charges.length === 1, 'in its last seconds it cannot be picked up');
  const blasts = sim.blasts.length;
  for (let i = 0; i < (CHARGE.lockout + 1) * 120; i++) sim.step(neutral);
  const b = sim.blasts[sim.blasts.length - 1];
  check(sim.charges.length === 0 && sim.blasts.length === blasts + 1 && b.kind === 'nuke' && Math.hypot(b.x - c.x, b.z - c.z) < 1, 'when the fuse runs out it goes off where it was set');
  check(sim.walker.downAt !== null && sim.exploded, 'standing beside it, the player and the vehicle are caught in the fireball');
  check(sim.bits.people.every((p) => Math.hypot(p.x - c.x, p.z - c.z) > STRATEGIC.nuke.fireball), 'nobody is left inside the fireball');
}

console.log('\n--- your Bit\'s style');
{
  const bad = sanitizeBitStyle({ light: 'red', size: 'huge', idle: 'compound', spin: 42 });
  check(bad.light === DEFAULT_BIT_STYLE.light && bad.size === DEFAULT_BIT_STYLE.size && bad.idle === 'compound' && bad.spin === DEFAULT_BIT_STYLE.spin, 'a style read back keeps what is valid and drops the rest (no red or yellow idle light)');
  let answers = true;
  for (const idle of ['pulse', 'compound', 'triambic'] as const) for (const st of ['yes', 'no'] as const) if (styledState(st, { ...DEFAULT_BIT_STYLE, idle }) !== st) answers = false;
  check(answers && styledState('idle1', { ...DEFAULT_BIT_STYLE, idle: 'triambic' }) === 'idle2' && styledState('idle2', { ...DEFAULT_BIT_STYLE, idle: 'pulse' }) === 'idle2', 'a style can hold the idle figure but never changes YES or NO');
}

console.log('\n--- errands on foot');
{
  const c = { x: -2600, z: -1500 };
  const pop = new BitPopulation();
  pop.step(1 / 30, 0, c);
  const er = new Errands();
  const offers = (t: number) => pop.people.map((p) => er.offerOf(p, t)).join(',');
  check(offers(10) === offers(20) && offers(10) !== offers(10 + ERRANDS.epoch * 3), 'what the people ask for holds for a while, then changes');
  const asking = (kind: 'courier' | 'escort') => pop.people.find((p) => er.offerOf(p, 30) === kind);
  const walker = new BitWalker();
  // Courier: YES beside a Bit with a packet, then walk into the room it goes to.
  const giver = asking('courier');
  check(!!giver, 'test setup: a Bit indoors with a packet to send');
  if (giver) {
    walker.exit(giver.x + 2, giver.y - BIT.hover, giver.z, 0);
    const word = er.say('yes', walker, pop, 30);
    const e = er.active;
    check(!!e && e.kind === 'courier' && !!word && e.to.id !== giver.home.room!.id && e.to.distance >= 40, 'YES beside it takes the delivery to another building', word ?? 'nothing');
    if (e) {
      check(er.step(31, walker, pop) === null, 'not done yet');
      walker.x = (e.to.x0 + e.to.x1) / 2; walker.z = (e.to.z0 + e.to.z1) / 2; walker.y = e.to.y;
      const done = er.step(32, walker, pop);
      check(!!done && 'reward' in done && done.reward === e.reward && !er.active && er.completed === 1, 'walking into that room delivers it and pays', done && 'reward' in done ? `${done.reward} credits` : 'not delivered');
    }
  }
  // Escort: the Bit follows the player's trail to its new building and goes in.
  const lost = asking('escort');
  check(!!lost, 'test setup: a Bit on the kerb that wants to move');
  if (lost) {
    walker.exit(lost.x + 2, 0, lost.z, 0);
    er.say('yes', walker, pop, 40);
    const e = er.active;
    check(!!e && e.kind === 'escort' && lost.place === 'follow', 'YES beside it: it follows');
    if (e) {
      // Walk there: along the kerb line out of the lot, then straight to the door (the test's path stands for the player's).
      const to = e.to.door;
      const steps = Math.ceil(Math.hypot(to.x - walker.x, to.z - walker.z) / 0.25);
      const x0 = walker.x, z0 = walker.z;
      let t = 40, done: ReturnType<Errands['step']> = null, maxGap = 0;
      for (let k = 1; k <= steps && !done; k++) {
        walker.x = x0 + ((to.x - x0) * k) / steps; walker.z = z0 + ((to.z - z0) * k) / steps;
        t += 1 / 30;
        pop.step(1 / 30, t, walker);
        done = er.step(t, walker, pop);
        if (lost.place === 'follow') maxGap = Math.max(maxGap, Math.hypot(lost.x - walker.x, lost.z - walker.z));
      }
      for (let k = 0; k < 30 * 20 && !done; k++) { t += 1 / 30; pop.step(1 / 30, t, walker); done = er.step(t, walker, pop); }
      check(maxGap < 12, 'it keeps up, a few metres behind', `${maxGap.toFixed(1)} m at most`);
      check(!!done && 'reward' in done && lost.place === 'way' && lost.home.room?.id === e.to.id, 'at the door it goes into its new building, and the player is paid', done && 'reward' in done ? `${done.reward} credits` : JSON.stringify(done));
    }
  }
  // NO drops an errand: an escorted Bit walks home the way it came.
  const another = pop.people.find((p) => er.offerOf(p, 200) === 'escort');
  if (another) {
    walker.exit(another.x + 2, 0, another.z, 0);
    er.say('yes', walker, pop, 200);
    const word = er.say('no', walker, pop, 201);
    check(!er.active && another.place === 'way' && another.then === 'kerb' && !!word, 'NO drops the errand; the Bit says NO and walks back to its kerb', word ?? '');
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nAll Bit checks passed');
process.exit(failures ? 1 : 0);
