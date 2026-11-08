/**
 * Neon city and airport checks (headless, real simulation): placement clear of the runway and
 * every test-card path, destructible structures (fracture into block grids, anchor check,
 * falling tops, floating slabs), crash damage to the aircraft, reset, and step cost.
 * Run with `npm run city`.
 */
import { JET } from '../src/craft/jet.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { CITY, heightCap } from '../src/sim/layout.ts';
import { TUNING } from '../src/tuning.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { worldStructures } from '../src/world/structures.ts';

await initPhysics();
let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}

const w = worldStructures();
const city = w.groups.filter((g) => g.name.startsWith('city:') || g.name.startsWith('highway:'));
const airport = w.groups.filter((g) => g.name.startsWith('airport:'));
console.log(`${w.groups.length} structures (${city.length} city, ${airport.length} airport), ${w.list.length} pieces`);

// --- Placement: the Grid covers the land, but respects the airport's obstacle-limitation zoning
// (airfield clear, approach/departure funnels, climb-out corridor), which keeps test paths clear.
const zoned = w.list.filter((p) => !w.groups[p.group].name.startsWith('airport:'));
const breach = zoned.filter((p) => {
  const top = p.y + p.sy / 2;
  const hx = p.sx / 2, hz = p.sz / 2;
  const cap = Math.min(heightCap(p.x - hx, p.z - hz), heightCap(p.x + hx, p.z - hz), heightCap(p.x - hx, p.z + hz), heightCap(p.x + hx, p.z + hz), heightCap(p.x, p.z));
  return top > cap + 0.5;
});
check(breach.length === 0, 'every city structure respects the airport height zoning', breach.length ? `${breach.length} breaches, e.g. ${breach[0].x.toFixed(0)},${breach[0].z.toFixed(0)}` : `${zoned.length} pieces`);
const span = { x0: Math.min(...zoned.map((p) => p.x)), x1: Math.max(...zoned.map((p) => p.x)), z0: Math.min(...zoned.map((p) => p.z)), z1: Math.max(...zoned.map((p) => p.z)) };
check(span.x1 - span.x0 > 6000 && span.z1 - span.z0 > 9000, 'the city covers the whole land', `${(span.x1 - span.x0).toFixed(0)} × ${(span.z1 - span.z0).toFixed(0)} m`);
const kits = w.groups.filter((g) => g.kit).length;
check(kits > 50, 'imported kit towers are placed across the grid', `${kits} towers`);
const tallest = city.reduce((a, b) => (b.size[1] * b.blockSize > a.size[1] * a.blockSize ? b : a));
check(tallest.size[1] * tallest.blockSize > 450, 'the landmark spire tops 450 m', `${(tallest.size[1] * tallest.blockSize).toFixed(0)} m`);

const sim = new Simulation(JET);
sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
const streamed = sim.staticWorld.colliderCount;
check(streamed > 0 && streamed < w.list.length / 4, 'only structures near the craft carry colliders (streaming)', `${streamed} of ${w.list.length}`);
{
  const t = performance.now();
  for (let i = 0; i < 240; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  const ms = (performance.now() - t) / 240;
  check(ms < 1.5, 'an idle step stays cheap with the whole world loaded', `${ms.toFixed(3)} ms/step`);
}

// --- Jet flown into a tower at 80 m/s
const target = city.filter((g) => g.name.startsWith('city:') && g.size[1] * g.blockSize > 150 && g.size[1] * g.blockSize < 300)[0];
const s = target.blockSize;
const cx = target.x0 + (target.size[0] * s) / 2;

const zFace = target.z0 + target.size[2] * s;
const body = sim.craft.body;
body.setTranslation({ x: cx, y: 60, z: zFace + 30 }, true);
body.setLinvel({ x: 0, y: 0, z: -80 }, true);
body.setAngvel({ x: 0, y: 0, z: 0 }, true);
const t0 = performance.now();
let steps = 0;
for (let i = 0; i < 120 * 4; i++) {
  sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: 0 });
  steps++;
}
const ms = (performance.now() - t0) / steps;
const fractured = sim.staticWorld.fractured.has(target.id);
const blocks = sim.staticWorld.fractured.get(target.id);
check(fractured, 'the struck tower fractured into its block grid', blocks ? `${blocks.list.length} blocks of ${s.toFixed(1)} m` : 'not fractured');
check(sim.town.destroyed > 0, 'blocks around the impact were destroyed', `${sim.town.destroyed} blocks`);
check(sim.failures.length > 0, 'the jet broke apart on impact', sim.failures.map((f) => f.partId).join(', '));
check(sim.position.z > target.z0 - 5 || sim.town.destroyed > 0, 'no tunnelling through the tower');
check(ms < 25, 'physics step stays affordable during the crash', `${ms.toFixed(2)} ms/step`);

// --- Middle tier blown out: the top must lose support and fall
sim.resetToRunway();
sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
check(sim.staticWorld.fractured.size === 0 && sim.town.buildings.length === 12, 'reset restores every structure', `${sim.staticWorld.colliderCount} colliders streamed near the spawn`);
const tower = sim.staticWorld.fracture(target.id, { impulse: 1e4, x: cx, y: (target.size[1] * s) / 2, z: zFace }, sim.time);
const level = Math.floor(target.size[1] / 2);
let killed = 0;
for (const b of tower.list) if (b.alive && b.y === level) { sim.town.blast(tower, ...centre(tower, b), 0.1, sim.time); killed++; }
for (let i = 0; i < 6; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 });
const falling = sim.town.pool.chunks.reduce((a, c) => (c.blocks.length > (a?.blocks.length ?? 0) ? c : a), null as (typeof sim.town.pool.chunks)[number] | null);
const fallY0 = falling?.body.translation().y ?? 0;
for (let i = 0; i < 60; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 });
check(!!falling && falling.blocks.length > 100 && (falling.body.translation().y < fallY0 - 0.5 || !sim.town.pool.chunks.includes(falling)), 'the detached top falls as one rigid body', falling ? `${falling.blocks.length} blocks, ${(falling.mass / 1000).toFixed(0)} t, ${falling.colliders.length} colliders` : 'no chunk');
const destroyedBefore = sim.town.destroyed;
for (let i = 0; i < 120 * 6; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 });
const above = tower.list.filter((b) => b.y > level);
check(killed > 0 && above.every((b) => !b.alive), 'cutting a whole floor detaches everything above it', `${killed} blocks cut, ${above.filter((b) => b.alive).length}/${above.length} above still standing`);
const below = tower.list.filter((b) => b.y < level && b.alive).length;
check(below > 0, 'the floors below stay standing', `${below} blocks`);
check(sim.town.destroyed > destroyedBefore, 'the falling top shatters when it lands', `${sim.town.destroyed - destroyedBefore} blocks shattered`);

// --- Floating slab: no anchor at all, so it drops when broken
sim.resetToRunway();
const slab = w.groups.find((g) => g.name.startsWith('city:') && w.list[g.pieces[0]].y > 200 && g.pieces.length === 1)!;
const slabB = sim.staticWorld.fracture(slab.id, { impulse: 1e4, x: w.list[slab.pieces[0]].x, y: w.list[slab.pieces[0]].y, z: w.list[slab.pieces[0]].z }, sim.time);
for (let i = 0; i < 30; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 });
check(slabB.list.every((b) => !b.alive), 'a struck floating slab has no anchor and falls', `${slabB.list.filter((b) => b.alive).length} blocks still floating`);

// --- Airport structures are destructible too
sim.resetToRunway();
const terminal = airport.find((g) => g.name === 'airport:terminal')!;
const tB = sim.staticWorld.fracture(terminal.id, { impulse: 3e4, x: terminal.x0, y: 8, z: terminal.z0 + 100 }, sim.time);
for (let i = 0; i < 60; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 });
check(tB.list.some((b) => !b.alive), 'the terminal can be blown apart', `${tB.list.filter((b) => !b.alive).length}/${tB.list.length} blocks gone`);

// --- Trainer still flies its card untouched by the world
sim.resetToRunway();
const sim2 = new Simulation(TEST_PLANE);
for (let i = 0; i < 120 * 5; i++) sim2.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
check(sim2.failures.length === 0 && sim2.staticWorld.fractured.size === 0, 'a parked plane on the runway touches nothing');

// --- Earthquake: towers near the craft fracture and come down block by block
{
  const q = new Simulation(TEST_PLANE);
  const { x: hx, z: hz } = CITY.hubs[0];
  q.atmosphere.events.trigger('earthquake', { duration: 12 });
  const destroyed0 = q.town.destroyed;
  let spawned = 0;
  let last = q.town.pool.version;
  let peakFractured = 0;
  const t0 = performance.now();
  const steps = Math.round(14 / q.dt);
  const accel = { x: 0, y: 0, z: 0 } as { x: number; y: number; z: number };
  for (let i = 0; i < steps; i++) {
    // Shake around downtown (the sim itself shakes around the craft on the runway).
    const a = q.atmosphere.events.groundAcceleration();
    accel.x = a.x; accel.z = a.z;
    q.staticWorld.shake(accel, hx, hz, q.time);
    q.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
    peakFractured = Math.max(peakFractured, q.staticWorld.fractured.size);
    if (q.town.pool.version !== last) spawned++;
    last = q.town.pool.version;
  }
  const ms = (performance.now() - t0) / steps;
  const names = [...q.staticWorld.fractured.values()].map((b) => b.def.id);
  check(peakFractured > 0, 'the quake fractures downtown towers', `${peakFractured} structures (${names.slice(0, 3).join(', ')}…)`);
  check(q.town.destroyed - destroyed0 > 50, 'shaking knocks blocks out of them', `${q.town.destroyed - destroyed0} blocks destroyed`);
  check(spawned > 0, 'what they held up comes down as rubble', `${spawned} rubble spawns`);
  check(peakFractured <= TUNING.maxFracturedStructures, 'within the fracture cap', `${peakFractured}/${TUNING.maxFracturedStructures}`);
  check(ms < 6, 'step time during the collapse', `avg ${ms.toFixed(2)} ms`);
  q.resetToRunway();
  check(q.staticWorld.fractured.size === 0, 'world reset rebuilds them');
}

function centre(b: { worldCentre(c: { x: number; y: number; z: number }, o: { x: number; y: number; z: number }): { x: number; y: number; z: number } }, block: { x: number; y: number; z: number }): [number, number, number] {
  const p = b.worldCentre(block, { x: 0, y: 0, z: 0 });
  return [p.x, p.y, p.z];
}

console.log(failures ? `\n${failures} city check(s) failed` : '\nall city checks passed');
process.exit(failures ? 1 : 0);
