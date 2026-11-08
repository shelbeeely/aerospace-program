/** Seeded lightning, heat spread, fuel use, electrical coupling and reset regressions. */
import * as THREE from 'three';
import { BLIMP } from '../src/craft/builtins.ts';
import type { CraftDef, PartDef } from '../src/craft/types.ts';
import { FireSystem } from '../src/sim/fire.ts';
import { LightningSystem, strikeTarget, thunderDelay } from '../src/sim/lightning.ts';
import { calmWeather } from '../src/sim/atmosphere.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';

let failures = 0;
function check(label: string, ok: boolean): void { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; }
const targets = [
  { id: 'low', position: new THREE.Vector3(0, 5, 0) },
  { id: 'tower', position: new THREE.Vector3(2, 30, 0) },
  { id: 'distant', position: new THREE.Vector3(1000, 100, 0) },
];
check('rolling sphere intercepts tallest nearby conductor', strikeTarget(0, 0, targets).id === 'tower');
check('distant high conductor cannot attract an unrelated strike', strikeTarget(1000, 0, targets).id === 'distant');
check('bare terrain receives the strike', strikeTarget(-1000, 0, targets).id === 'ground');
const a = new LightningSystem(42), b = new LightningSystem(42);
const leaderA = a.trigger(0, 0, 0, targets), leaderB = b.trigger(0, 0, 0, targets);
check('same seed reproduces leader geometry and energy', JSON.stringify(leaderA) === JSON.stringify(leaderB));
check('leader terminates exactly at its conductor', leaderA.points.at(-1)!.equals(leaderA.target.position));
check('thunder is delayed by distance / 343', Math.abs(thunderDelay(686) - 2) < 1e-12);
const calm = new LightningSystem(1);
for (let i = 0; i < 300; i++) calm.step(1, i, 0, new THREE.Vector3(), targets);
check('calm weather never strikes', calm.strikes.length === 0);
const trace = (seed: number) => {
  const system = new LightningSystem(seed);
  for (let i = 0; i < 12000; i++) system.step(0.01, i * 0.01, 1, new THREE.Vector3(), targets);
  return JSON.stringify(system.strikes);
};
check('storm scheduler trace is seed-deterministic', trace(31) === trace(31) && trace(31) !== trace(32));
const charging = new LightningSystem(4);
for (let i = 0; i < 20; i++) charging.step(1, i, 0, new THREE.Vector3(), [], 800, 0.1);
const charged = charging.staticCharge;
for (let i = 0; i < 20; i++) charging.step(1, i + 20, 0, new THREE.Vector3(), []);
check('precipitation static builds up and leaks away in clear air', charged > 0.5 && charging.staticCharge < charged / 2);

const part = (id: string, x: number): PartDef => ({ id, kind: 'fuel', position: [x, 0, 0], mass: 30, color: '#ff00ff', shape: { type: 'box', size: [1, 1, 1] } });
const parts = [part('a', 0), part('b', 1.1), part('isolated', 20)];
const fire = new FireSystem(); fire.reset(parts, new Map([['a', 3], ['b', 2]])); fire.ignite('a');
const attached = new Set(parts.map((p) => p.id));
let spread = false, isolatedLit = false;
for (let i = 0; i < 60 * 120; i++) {
  fire.step(1 / 120, attached);
  spread ||= fire.parts.get('b')!.burning;
  isolatedLit ||= fire.parts.get('isolated')!.burning;
}
check('heat ignites adjacent parts without jumping empty space', spread && !isolatedLit);
check('all fires exhaust their finite fuel and burn out', [...fire.parts.values()].every((p) => !p.burning));
check('cooled structures recover strength', fire.strengthFactor('a') > 0.9);
fire.reset(parts); fire.ignite('a');
check('hot parts have lower structural strength', fire.strengthFactor('a') < 0.5);
const wind = new THREE.Vector3(); fire.addSmokeWind(new THREE.Vector3(0, 4, 0), new THREE.Vector3(), new THREE.Quaternion(), wind);
check('smoke contributes a finite buoyant updraft', wind.y > 0 && Number.isFinite(wind.length()));
fire.step(0.1, new Set(['b']));
check('detached parts cannot continue burning on the aircraft', !fire.parts.has('a'));

await initPhysics();
const blimp = new Simulation(BLIMP, calmWeather());
const envelope = blimp.craft.parts.find((p) => p.id === 'envelope')!;
const envelopeTarget = blimp.lightningTargets().find((p) => p.craftPart === envelope.id)!;
check('lightning contacts the top of a horizontal cylinder, not its half-length',
  envelope.shape.type === 'cylinder' && Math.abs(envelopeTarget.position.y - blimp.position.y - envelope.position[1] - envelope.shape.radius) < 1e-9);
blimp.world.free();
const cylinders: CraftDef = { formatVersion: 1, name: 'rotated conductors', parts: [
  { ...part('axis-x', 0), shape: { type: 'cylinder', axis: 'x', radius: 1, length: 10 } },
  { ...part('axis-y', 0), shape: { type: 'cylinder', axis: 'y', radius: 1, length: 10 } },
  { ...part('rotated-z', 0), rotationDeg: [90, 0, 0], shape: { type: 'cylinder', axis: 'z', radius: 1, length: 10 } },
] };
const conductors = new Simulation(cylinders, calmWeather());
const heights = new Map(conductors.lightningTargets().filter((t) => t.craftPart).map((t) => [t.craftPart, t.position.y - conductors.position.y]));
check('cylinder conductor heights respect every axis and part rotation',
  Math.abs(heights.get('axis-x')! - 1) < 1e-9 && Math.abs(heights.get('axis-y')! - 5) < 1e-9 && Math.abs(heights.get('rotated-z')! - 5) < 1e-9);
conductors.world.free();

const craft: CraftDef = { formatVersion: 1, name: 'hazard fixture', parts: [
  { ...part('tank', 0), hp: 1e8, modules: [{ type: 'fuel', capacity: 3, fill: 1 }] },
  { ...part('electronics', 0), position: [0, 1, 0], hp: 1e8, modules: [
    { type: 'battery', cells: 6, capacityAh: 5, cellResistance: 0.003, cellVmin: 3.3, cellVmax: 4.2 },
    { type: 'avionics', loadW: 50, essential: false }] },
  { ...part('exit', 0), position: [0, -1, 0], hp: 1e8 },
] };
const sim = new Simulation(craft, calmWeather());
sim.triggerLightning();
check('aircraft strike damages entry and exit parts', sim.damage.hp.get('electronics')! < 1e8 && sim.damage.hp.get('exit')! < 1e8);
check('strike couples into electrical spike API', sim.craft.electrical!.avionics.some((a) => a.failed));
check('current path ignites a fuel tank', sim.fire.parts.get('tank')!.burning);
const fuelBefore = sim.craft.fuel;
sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
check('combustion consumes actual aircraft fuel', sim.craft.fuel < fuelBefore);
sim.resetToRunway();
check('reset clears leaders and fire without retaining damage', sim.lightning.strikes.length === 0 && [...sim.fire.parts.values()].every((p) => !p.burning) && !sim.damage.damaged && sim.fire.parts.get('tank')!.fuel === 3);
console.log(failures ? `${failures} hazard checks failed` : 'all hazard checks passed');
process.exit(failures ? 1 : 0);
