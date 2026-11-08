/** Deterministic coast, waves, flotation and water-impact regressions. */
import RAPIER from '@dimforge/rapier3d-compat';
import type { CraftDef } from '../src/craft/types.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { COAST } from '../src/sim/layout.ts';
import { oceanHeight, oceanPoint, OCEAN_MAX_AMPLITUDE } from '../src/sim/ocean.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';

await initPhysics();
let failures = 0;
function check(ok: boolean, message: string, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${message}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}
const idle = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 };
let bounded = true;
let inverseError = 0;
for (let t = 0; t < 30; t += 0.37) for (let x = 2510; x < 2600; x += 3.7) {
  const p = oceanPoint(x, 123, t);
  const h = oceanHeight(p.x, p.z, t);
  inverseError = Math.max(inverseError, Math.abs(h - p.y));
  bounded &&= Math.abs(h - COAST.seaLevel) <= OCEAN_MAX_AMPLITUDE + 1e-7;
}
check(bounded, 'wave height bounded by summed amplitudes');
check(inverseError < 1e-6, 'world-space height inverts Gerstner displacement', `${inverseError.toExponential(2)} m`);
check(Math.abs(oceanHeight(2600, 0, 4, () => 2) - oceanHeight(2600, 0, 4) - 2) < 1e-9, 'optional surge adds to water height');

const box: CraftDef = { formatVersion: 1, name: 'Float box', parts: [
  { id: 'box', kind: 'fuselage', position: [0, 0, 0], mass: 4000, shape: { type: 'box', size: [2, 2, 2] }, color: '#19f0ff', strength: 0, hp: 0 },
] };
const sim = new Simulation(box);
sim.ocean.waves = false;
sim.craft.body.setTranslation({ x: 2600, y: COAST.seaLevel + 0.7, z: 0 }, true);
sim.craft.body.setLinvel({ x: 8, y: 0, z: 0 }, true);
for (let i = 0; i < 30 / sim.dt; i++) sim.step(idle);
const position = sim.craft.body.translation();
// 4000 kg / (1025 kg/m3 × 4 m2) = 0.9756 m draft for a level, sealed 2 m box.
const expected = COAST.seaLevel + 1 - 4000 / (1025 * 4);
check(Math.abs(position.y - expected) < 0.07, 'floating box reaches Archimedes equilibrium', `${position.y.toFixed(3)} m, expected ${expected.toFixed(3)} m`);
check(Math.abs(sim.craft.body.linvel().y) < 0.05 && sim.explosionResets === 0, 'flotation settles without numerical reset');
check(Math.abs(sim.craft.body.linvel().x) < 0.1, 'water drag arrests horizontal motion');

const land = new Simulation(TEST_PLANE);
land.step(idle);
const groundRay = (x: number) => land.world.castRay(new RAPIER.Ray({ x, y: 10, z: 1600 }, { x: 0, y: -1, z: 0 }), 150, true);
const runway = groundRay(0);
const sea = groundRay(2600);
check(runway !== null && Math.abs(runway.timeOfImpact - 10) < 0.01, 'runway ground remains at zero');
check(sea !== null && Math.abs(sea.timeOfImpact - (10 + COAST.depth)) < 0.01, 'solid sea-level ground removed east of coast');

// Cross-subsystem regression: hurricane time is weather time, including after a reset.
land.atmosphere.events.trigger('hurricane', { x: COAST.x, z: 0, duration: 360 });
land.atmosphere.advance(180);
const surge = land.atmosphere.events.surgeHeight(COAST.x + 20, 0);
check(surge > 0 && Math.abs(land.ocean.height(COAST.x + 20, 0, land.time) - oceanHeight(COAST.x + 20, 0, land.time) - surge) < 1e-8, 'hurricane surge reaches actual ocean despite independent simulation time');
land.resetToRunway();
check(land.atmosphere.events.active.length === 0 && Math.abs(land.ocean.height(2600, 0, land.time) - oceanHeight(2600, 0, land.time)) < 1e-8, 'reset removes hurricane surge from ocean');
land.atmosphere.events.trigger('earthquake', { duration: 1 });
for (let i = 0; i < 130; i++) land.step(idle);
const westAfterQuake = groundRay(-4900);
const seaAfterQuake = groundRay(2600);
check(westAfterQuake !== null && Math.abs(westAfterQuake.timeOfImpact - 10) < 0.01 && seaAfterQuake !== null && Math.abs(seaAfterQuake.timeOfImpact - (10 + COAST.depth)) < 0.01, 'earthquake preserves shifted coastline collider origin');

const crash = new Simulation({ ...box, name: 'crash', parts: [
  { ...box.parts[0], id: 'hull', mass: 1000, hp: 10 },
  { ...box.parts[0], id: 'wing', mass: 1000, position: [2, 0, 0], hp: 10 },
] });
crash.ocean.waves = false;
crash.craft.body.setTranslation({ x: 2600, y: 8, z: 0 }, true);
crash.craft.body.setLinvel({ x: 0, y: -30, z: 0 }, true);
for (let i = 0; i < 1 / crash.dt; i++) crash.step(idle);
check(crash.failures.some(f => f.cause === 'impact'), 'hard water entry detaches a part through impact damage', crash.failures.map(f=>f.partId).join(', '));
check(crash.explosionResets === 0, 'hard water entry remains finite');
if (failures) throw new Error(`${failures} ocean checks failed`);
console.log('all ocean checks passed');
