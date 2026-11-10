/**
 * Headless checks for fast vehicles and the new parts and modules. Run with `npm run engines`.
 *
 * 1. Compressibility: wing wave drag peaks just past Mach 1 and falls supersonically; the lift
 *    slope is continuous; bodies get a transonic drag bump.
 * 2. Engine kinds: ramjet and scramjet thrust curves; a solid booster can't be throttled off and
 *    burns out; a turbojet keeps thrust to higher Mach than a turbofan.
 * 3. A ramjet dart with a solid booster accelerates past Mach 3 at altitude.
 * 4. Thrust vectoring turns the craft the way the stick asks, engine behind or ahead of the CoM.
 * 5. Airbrake and drag chute slow the craft; the chute is one-shot.
 * 6. Cone and capsule parts: valid, collide, have mass and inertia, voxels, connectivity.
 * 7. Weight floors: a part too light for its engine is raised by the auto-fix.
 */
import * as THREE from 'three';
import { connectivityErrors } from '../src/craft/connectivity.ts';
import { LIGHT_CAR } from '../src/craft/lightCar.ts';
import { partMinMass } from '../src/craft/moduleMass.ts';
import type { CraftDef, EngineDef, PartDef } from '../src/craft/types.ts';
import { validateCraft } from '../src/craft/validate.ts';
import { PartVoxels } from '../src/craft/voxels.ts';
import { autoFix } from '../src/gen/autofix.ts';
import { Chute } from '../src/modules/Airbrake.ts';
import { bodyWaveFactor, liftSlopeFactor, surfaceWaveDrag } from '../src/modules/compressibility.ts';
import { Engine } from '../src/modules/Engine.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { boomOverpressure } from '../src/sim/sonicBoom.ts';
import { worldStructures } from '../src/world/structures.ts';

await initPhysics();
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};
const place = (sim: Simulation, y: number, vz: number) => {
  const b = sim.craft.body;
  b.setTranslation({ x: 2000, y, z: -3000 }, true);
  b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  b.setLinvel({ x: 0, y: 0, z: vz }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);
};
const holdLevel = (sim: Simulation) => {
  // Attitude held level (this is a propulsion and drag test, not a handling test).
  const b = sim.craft.body;
  b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);
};

// ---------------------------------------------------------------- 1. compressibility
console.log('--- compressibility');
{
  const at = (m: number) => surfaceWaveDrag(m, 0.72);
  check(at(0.7) === 0 && at(1.05) > 0.09 && at(3) < 0.03 && at(3) < at(1.5) && surfaceWaveDrag(1.05, 0.85) < at(1.05) * 0.6, 'wing wave drag peaks past Mach 1 (less for thin wings) and falls supersonically', `M0.9 ${at(0.9).toFixed(3)}, M1.05 ${at(1.05).toFixed(3)}, M2 ${at(2).toFixed(3)}, M3 ${at(3).toFixed(3)}`);
  let jump = 0;
  for (let m = 0.5; m < 4; m += 0.01) jump = Math.max(jump, Math.abs(liftSlopeFactor(m + 0.01) - liftSlopeFactor(m)));
  // The steepest step is Prandtl-Glauert's own rise just below Mach 0.9.
  check(jump < 0.12 && liftSlopeFactor(3) < 0.3, 'lift slope rises toward Mach 1 and drops supersonically, without jumps', `max step ${jump.toFixed(3)}, M3 ${liftSlopeFactor(3).toFixed(2)}`);
  check(bodyWaveFactor(0.5) === 1 && bodyWaveFactor(1.1) > 2 && bodyWaveFactor(3) < 1.8, 'bodies get a transonic drag bump', `M1.1 ×${bodyWaveFactor(1.1).toFixed(2)}, M3 ×${bodyWaveFactor(3).toFixed(2)}`);
}

// ---------------------------------------------------------------- 2. engine curves
console.log('\n--- engine kinds');
check(Engine.ramjetCurve(0) === 0 && Engine.ramjetCurve(3) === 1 && Engine.ramjetCurve(6.5) === 0, 'ramjet: no static thrust, full at Mach 3, gone past 6');
check(Engine.scramjetCurve(3) === 0 && Engine.scramjetCurve(7) === 1 && Engine.scramjetCurve(12.5) === 0, 'scramjet: nothing at Mach 3, full at 7, gone past 12');
check(Engine.turbofanLapse(1, 2.5, 0) > 0.3 && Engine.turbofanLapse(1, 2.5, 1) === 0, 'a turbojet keeps thrust at Mach 2.5 where a turbofan has none');

// ---------------------------------------------------------------- 3. a fast craft
const part = (p: Partial<PartDef> & Pick<PartDef, 'id' | 'shape' | 'position' | 'mass'>): PartDef => ({ kind: p.id, color: '#10284f', ...p });
const DART: CraftDef = {
  name: 'Ramjet Dart',
  formatVersion: 1,
  parts: [
    part({ id: 'fuselage', mass: 1500, position: [0, 0, 0], shape: { type: 'capsule', radius: 0.5, length: 10, axis: 'z' }, modules: [
      { type: 'body', length: 10, diameter: 1, cdFront: 0.08 },
      { type: 'fuel', capacity: 1500 },
    ] }),
    part({ id: 'nose', mass: 60, position: [0, 0, -6], shape: { type: 'cone', radius: 0.5, length: 2, axis: 'z' } }),
    part({ id: 'ramjet', mass: 1100, position: [0, -0.8, 2], shape: { type: 'cylinder', radius: 0.45, length: 4, axis: 'z' }, modules: [{ type: 'engine', kind: 'ramjet', maxThrust: 150000 }] }),
    part({ id: 'booster', mass: 900, position: [0, 0, 5.4], shape: { type: 'cylinder', radius: 0.45, length: 1.2, axis: 'z' }, modules: [{ type: 'engine', kind: 'solid', maxThrust: 90000, burnTime: 15, gimbalDeg: 5 }] }),
    part({ id: 'wing.left', mass: 120, position: [-1.45, 0, 1], shape: { type: 'box', size: [2.0, 0.05, 2.0] }, modules: [{ type: 'aero', span: 2.0, chord: 2.0, aspectRatio: 2, criticalMach: 0.92, incidenceDeg: 2 }] }),
    part({ id: 'wing.right', mass: 120, position: [1.45, 0, 1], shape: { type: 'box', size: [2.0, 0.05, 2.0] }, modules: [{ type: 'aero', span: 2.0, chord: 2.0, aspectRatio: 2, criticalMach: 0.92, incidenceDeg: 2 }] }),
  ],
};
console.log('\n--- a ramjet dart');
{
  check(validateCraft(DART).length === 0 && connectivityErrors(DART).length === 0, 'the dart is valid and one connected piece', [...validateCraft(DART), ...connectivityErrors(DART)].join('; '));
  const sim = new Simulation(DART);
  sim.traffic.enabled = false;
  const sound = (y: number) => sim.atmosphere.air(y).speedOfSound;
  place(sim, 7000, -1.2 * sound(7000));
  let maxMach = 0;
  for (let i = 0; i < 120 * 150; i++) {
    holdLevel(sim);
    const b = sim.craft.body;
    const t = b.translation();
    // A propulsion and drag test: held at 7 km with no vertical motion, so lift can't tilt
    // forward speed into a climb (that's handling, tested elsewhere).
    const v0 = b.linvel();
    b.setTranslation({ x: t.x, y: 7000, z: t.z }, true);
    b.setLinvel({ x: v0.x, y: 0, z: v0.z }, true);
    sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: 0 });
    const v = sim.craft.body.linvel();
    maxMach = Math.max(maxMach, Math.hypot(v.x, v.y, v.z) / sound(sim.position.y));
  }
  const ram = sim.craft.engines.find((e) => e.isRamjet)!;
  check(maxMach > 3 && !sim.exploded, 'booster then ramjet take it past Mach 3', `peak Mach ${maxMach.toFixed(2)}, ramjet ${(ram.thrust / 1000).toFixed(0)} kN at Mach ${ram.mach.toFixed(2)}`);
}

// ---------------------------------------------------------------- 3b. solid booster
console.log('\n--- solid booster');
{
  const sim = new Simulation(DART);
  sim.traffic.enabled = false;
  place(sim, 9000, -200);
  const solid = sim.craft.engines.find((e) => e.isSolid)!;
  sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: 0 });
  for (let i = 0; i < 120 * 3; i++) { holdLevel(sim); sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 }); }
  check(solid.lit && solid.thrust > 80000, 'once lit, it keeps burning with the throttle closed', `${(solid.thrust / 1000).toFixed(0)} kN`);
  for (let i = 0; i < 120 * 14; i++) { holdLevel(sim); sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: 0 }); }
  check(solid.thrust < 1 && solid.burnLeft <= 0, 'and burns out after its burn time');
}

// ---------------------------------------------------------------- 4. thrust vectoring
console.log('\n--- thrust vectoring');
for (const [label, z] of [['behind', 5.4], ['ahead of', -5]] as const) {
  const craft: CraftDef = structuredClone(DART);
  craft.parts = craft.parts.filter((p) => !/wing/.test(p.id));
  const b = craft.parts.find((p) => p.id === 'booster')!;
  b.position = [0, 0, z];
  (b.modules![0] as EngineDef).burnTime = 60;
  const sim = new Simulation(craft);
  sim.traffic.enabled = false;
  place(sim, 60000, 0); // near-vacuum: no aero moments
  sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: 0 });
  for (let i = 0; i < 60; i++) sim.step({ pitch: 1, roll: 0, yaw: 0, throttle: 1, brake: 0 });
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(sim.rotation);
  const w = sim.craft.body.angvel();
  const pitchRate = new THREE.Vector3(w.x, w.y, w.z).dot(right);
  for (let i = 0; i < 60; i++) sim.step({ pitch: 0, roll: 0, yaw: 1, throttle: 1, brake: 0 });
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(sim.rotation);
  check(pitchRate > 0.02, `pitch up: nose rises with the engine ${label} the CoM`, `${pitchRate.toFixed(3)} rad/s`);
  void up;
}

// ---------------------------------------------------------------- 5. airbrake and chute
console.log('\n--- airbrake and drag chute');
{
  const decel = (brake: number) => {
    const craft: CraftDef = structuredClone(DART);
    craft.parts[0].modules!.push({ type: 'airbrake', area: 2 });
    const sim = new Simulation(craft);
    sim.traffic.enabled = false;
    place(sim, 3000, -200);
    for (let i = 0; i < 120; i++) { holdLevel(sim); sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake }); }
    const v = sim.craft.body.linvel();
    return 200 - Math.hypot(v.x, v.y, v.z);
  };
  const off = decel(0), on = decel(1);
  check(on > off * 1.5, 'airbrakes slow it down', `lost ${off.toFixed(1)} m/s closed, ${on.toFixed(1)} m/s open in 1 s`);
  const stop = (chute: boolean) => {
    const car: CraftDef = structuredClone(LIGHT_CAR);
    if (chute) car.parts[0].modules!.push({ type: 'chute', offset: [0, 0, 2], cdA: 4 });
    const sim = new Simulation(car);
    sim.traffic.enabled = false;
    for (let i = 0; i < 120; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
    const b = sim.craft.body;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(sim.rotation).multiplyScalar(60);
    b.setLinvel({ x: fwd.x, y: 0, z: fwd.z }, true);
    let t = 0;
    const speed = () => { const v = b.linvel(); return Math.hypot(v.x, v.y, v.z); };
    for (; t < 30 && speed() > 10; t += sim.dt) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
    for (let i = 0; i < 600; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
    return { t, chute: sim.craft.modules.find((m) => m instanceof Chute) as Chute | undefined };
  };
  const plain = stop(false), chuted = stop(true);
  check(chuted.t < plain.t * 0.9, 'a drag chute shortens the stop from 60 m/s', `${plain.t.toFixed(1)} s → ${chuted.t.toFixed(1)} s`);
  check(chuted.chute?.state === 'gone', 'and is cut away once slow (one use)');
}

// ---------------------------------------------------------------- 6. shapes
console.log('\n--- cone and capsule parts');
{
  const sim = new Simulation(DART);
  const ids = Array.from({ length: sim.craft.body.numColliders() }, (_, i) => sim.craft.partIdForCollider(sim.craft.body.collider(i).handle));
  check(ids.includes('nose') && ids.includes('fuselage'), 'cone and capsule parts get Rapier colliders', ids.join(', '));
  const cone = new PartVoxels({ type: 'cone', radius: 0.5, length: 2, axis: 'z' });
  const cyl = new PartVoxels({ type: 'cylinder', radius: 0.5, length: 2, axis: 'z' });
  const cap = new PartVoxels({ type: 'capsule', radius: 0.5, length: 10, axis: 'z' });
  check(cone.total > 0 && cone.total < cyl.total * 0.6 && cap.total > 0, 'they voxelise to their volume (a cone ~1/3 of its cylinder)', `cone ${cone.total}, cylinder ${cyl.total}, capsule ${cap.total}`);
  check(validateCraft({ name: 'x', formatVersion: 1, parts: [part({ id: 'c', mass: 1, position: [0, 0, 0], shape: { type: 'capsule', radius: 1, length: 1 } })] }).length > 0, 'a capsule shorter than its two caps is rejected');
}

// ---------------------------------------------------------------- 7. weight floors
console.log('\n--- weight floors');
{
  const light: CraftDef = structuredClone(DART);
  light.parts.find((p) => p.id === 'ramjet')!.mass = 20;
  const { craft, fixes } = autoFix(light);
  const ram = craft.parts.find((p) => p.id === 'ramjet')!;
  check(ram.mass >= partMinMass(ram).kg && fixes.some((f) => /ramjet.*raised/.test(f)), 'a 20 kg 150 kN ramjet is raised to its floor', fixes.find((f) => /ramjet/.test(f)) ?? '');
  const booster = partMinMass(DART.parts.find((p) => p.id === 'booster')!);
  check(booster.kg > 300 && booster.kg < 900, 'a solid booster must carry its propellant', `${booster.kg.toFixed(0)} kg floor for 90 kN × 15 s`);
}

// ---------------------------------------------------------------- 8. sonic booms
console.log('\n--- sonic booms');
{
  const concorde = boomOverpressure(2, 16000, 62);
  const fighter = boomOverpressure(1.2, 50, 15);
  check(Math.abs(concorde - 96) < 15 && fighter > 1500 && fighter < 3000, 'overpressure calibrated: Concorde at 16 km ~96 Pa, a fighter at 50 m ~2 kPa', `${concorde.toFixed(0)} Pa, ${fighter.toFixed(0)} Pa`);
  // A structure to fly over, away from the airport.
  const w = worldStructures();
  const g = w.groups.find((x) => x.name.startsWith('arch:') && !x.name.startsWith('arch:infra:') && Math.hypot(x.x0, x.z0) > 1500 && Math.hypot(x.x0, x.z0) < 4000 && x.size[1] * x.blockSize > 20 && x.size[1] * x.blockSize < 120)!;
  const cx = g.x0 + (g.size[0] * g.blockSize) / 2, cz = g.z0 + (g.size[2] * g.blockSize) / 2, top = g.size[1] * g.blockSize;
  const pass = (height: number, mach: number) => {
    const sim = new Simulation(DART);
    sim.traffic.enabled = false;
    const v = mach * sim.atmosphere.air(top + height).speedOfSound;
    const b = sim.craft.body;
    // Run in along z so the pass crosses the structure.
    for (let i = 0; i < 120 * 2.5; i++) {
      const z = cz + 0.5 * v * 2.5 - v * (i / 120);
      b.setTranslation({ x: cx, y: top + height, z }, true);
      b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      b.setLinvel({ x: 0, y: 0, z: -v }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 });
    }
    return { blocks: sim.boomDamage, fractured: sim.staticWorld.fractured.has(g.id), booms: sim.booms.length, dp: Math.max(0, ...sim.booms.map((e) => e.groundDp)) };
  };
  const low = pass(60, 1.4), high = pass(3000, 1.4), slow = pass(60, 0.9);
  check(low.blocks > 0 && low.fractured, 'a supersonic pass 60 m over a structure knocks blocks out of it', `${low.blocks} blocks, ${low.booms} booms`);
  check(high.blocks === 0, 'the same pass at 3 km only rattles the ground', `${high.blocks} blocks, ground ${high.dp.toFixed(0)} Pa`);
  check(slow.blocks === 0 && slow.booms === 0, 'a subsonic pass makes no boom');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
