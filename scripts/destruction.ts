/**
 * Headless destruction tests: impact damage, part HP and CCD. Run with `npm run destruction`.
 *
 * 1. Every built-in dropped from 0.5 m takes zero damage.
 * 2. The trainer dropped from 30 m breaks parts.
 * 3. A jet-like body at 300 m/s into a fixed 0.3 m thick wall never crosses the wall plane,
 *    and the hit is reported as a contact-force event.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { BUILTINS } from '../src/craft/builtins.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import type { CraftDef } from '../src/craft/types.ts';
import type { ControlInputs } from '../src/sim/controls.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';

await initPhysics();

const idle: ControlInputs = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};
const run = (sim: Simulation, seconds: number) => {
  for (let i = 0, n = Math.round(seconds / sim.dt); i < n; i++) sim.step(idle);
};
/** Lift the craft `h` m above where it is, motionless, and let go. */
const drop = (sim: Simulation, h: number) => {
  const b = sim.craft.body;
  const t = b.translation();
  b.setTranslation({ x: t.x, y: t.y + h, z: t.z }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);
};
const minHp = (sim: Simulation) => Math.min(1, ...Object.values(sim.damage.fractions()));

// ---------------------------------------------------------------- 1. gentle drops
console.log('--- built-ins dropped from 0.5 m');
for (const b of BUILTINS) {
  const sim = new Simulation(b.craft);
  run(sim, 3); // settle on the runway
  drop(sim, 0.5);
  run(sim, 4);
  check(
    !sim.damage.damaged && sim.failures.length === 0,
    `${b.label}: 0.5 m drop, no damage`,
    `min HP ${minHp(sim)}, failures [${sim.failures.map((f) => f.partId).join(', ')}]`,
  );
}

// ---------------------------------------------------------------- 2. hard drop
console.log('\n--- trainer dropped from 30 m');
{
  const sim = new Simulation(TEST_PLANE);
  run(sim, 2);
  drop(sim, 30);
  run(sim, 6);
  const impacts = sim.failures.filter((f) => f.cause === 'impact');
  check(
    impacts.length > 0 && sim.debris.length > 0,
    'trainer: 30 m drop breaks parts',
    `broken [${impacts.map((f) => f.partId).join(', ')}], debris ${sim.debris.length}, min HP ${minHp(sim)}, version ${sim.version}`,
  );
  // Losing a wing takes its lift with it: no AeroSurface of a detached part remains.
  const orphan = sim.craft.aeroSurfaces.filter((s) => sim.craft.detached.has(s.partId));
  check(orphan.length === 0, 'detached parts leave no aero surfaces behind');
  check(!sim.exploded, 'a 30 m drop (~24 m/s) breaks parts but does not explode the craft');
  // A reset rebuilds the craft at full health.
  sim.resetToRunway();
  check(!sim.damage.damaged && sim.craft.detached.size === 0 && minHp(sim) === 1, 'reset restores full HP');
}

// ---------------------------------------------------------------- 3. wall at 300 m/s
console.log('\n--- jet into a 0.3 m wall at 300 m/s');
{
  const JET: CraftDef = {
    name: 'Dart',
    formatVersion: 1,
    parts: [
      {
        id: 'fuselage',
        kind: 'fuselage',
        mass: 4000,
        position: [0, 0, 0],
        shape: { type: 'box', size: [1.4, 1.4, 12] },
        color: '#888',
        modules: [{ type: 'body', length: 12, diameter: 1.4, cdFront: 0.1 }],
      },
      { id: 'wing.left', kind: 'wing', mass: 300, position: [-2.7, 0, 1], shape: { type: 'box', size: [4, 0.15, 2.5] }, color: '#aaa', modules: [{ type: 'aero', span: 4, chord: 2.5 }] },
      { id: 'wing.right', kind: 'wing', mass: 300, position: [2.7, 0, 1], shape: { type: 'box', size: [4, 0.15, 2.5] }, color: '#aaa', modules: [{ type: 'aero', span: 4, chord: 2.5 }] },
    ],
  };
  const sim = new Simulation(JET);
  const wallZ = -200;
  const half = 0.15;
  const wallBody = sim.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 100, wallZ));
  const wall = sim.world.createCollider(RAPIER.ColliderDesc.cuboid(60, 60, half), wallBody);
  let wallEvents = 0;
  let peakForce = 0;
  sim.onContactForce((e) => {
    if (e.collider1 === wall.handle || e.collider2 === wall.handle) {
      wallEvents++;
      peakForce = Math.max(peakForce, e.totalForceMagnitude);
    }
  });

  const body = sim.craft.body;
  body.setTranslation({ x: 0, y: 100, z: 0 }, true);
  body.setLinvel({ x: 0, y: 0, z: -300 }, true);
  const back = wallZ - half;
  let crossed = false;
  let deepest = Infinity;
  for (let i = 0; i < 240; i++) {
    sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 });
    // Every remaining airframe collider centre must stay on the near side of the wall.
    for (let c = 0; c < body.numColliders(); c++) {
      const z = body.collider(c).translation().z;
      deepest = Math.min(deepest, z);
      if (z < back) crossed = true;
    }
  }
  check(!crossed, 'craft never crosses the wall plane', `closest collider centre z=${deepest.toFixed(2)} (wall back face ${back})`);
  check(wallEvents > 0, 'contact force event recorded for the wall hit', `${wallEvents} events, peak ${(peakForce / 1e6).toFixed(1)} MN`);
  const debrisThrough = sim.debris.filter((d) => d.body.translation().z < back).length;
  check(debrisThrough === 0, 'no debris tunnels through the wall', `debris ${sim.debris.length}, failures [${sim.failures.map((f) => `${f.partId}:${f.cause}`).join(', ')}]`);
  check(sim.explosionResets === 0, 'no explosion resets');
}

// ---------------------------------------------------------------- 4. voxel bites and the explosion threshold
console.log('\n--- voxel bites and crash speed');
const crash = (def: CraftDef, v: number) => {
  const sim = new Simulation(def);
  sim.traffic.enabled = false; // ground vehicles start on a road: keep riders out of a controlled drop
  run(sim, 2);
  const b = sim.craft.body;
  const t = b.translation();
  b.setTranslation({ x: t.x, y: t.y + 8, z: t.z }, true);
  b.setRotation({ x: 0.2, y: 0, z: 0.1, w: 0.97 }, true);
  b.setLinvel({ x: 0, y: -v, z: 0 }, true);
  run(sim, 2.5);
  return sim;
};
{
  const sim = crash(TEST_PLANE, 15);
  const bitten = [...sim.craft.voxels.entries()].filter(([, v]) => v.aliveCount < v.total);
  check((bitten.length > 0 || sim.failures.length > 0) && sim.chips.total > 0, 'a 15 m/s belly hit bites voxels out and throws chips',
    `bitten [${bitten.map(([k, v]) => `${k} ${(v.integrity * 100).toFixed(0)}%`).join(', ')}], broken off [${sim.failures.map((f) => f.partId).join(', ')}]; ${sim.chips.total} chips`);
  check(!sim.exploded, '15 m/s: no explosion');
  for (const b of BUILTINS) {
    // Reinforced craft (the tank) hold together longer: the threshold scales as the sim's does.
    const tough = new Simulation(b.craft).explodeSpeed() / new Simulation(TEST_PLANE).explodeSpeed();
    const vFast = Math.round(34 * tough);
    const slow = crash(b.craft, 20);
    const fast = crash(b.craft, vFast);
    // Clearly tougher craft (≥ 25% over the trainer: explode threshold well above 34 m/s)
    // survive the 34 m/s crash; a marginally reinforced one (the crawler, 1.05×: ~31.5 m/s)
    // rightly doesn't.
    const tougher = tough >= 1.25 ? !crash(b.craft, 34).exploded : true;
    check(!slow.exploded && fast.exploded && tougher, `${b.label}: survives 20 m/s${tough >= 1.25 ? ' and 34 m/s' : ''}, explodes at ${vFast} m/s`, `20: ${slow.exploded}, ${vFast}: ${fast.exploded}`);
  }
}

// ---------------------------------------------------------------- 5. explosion and the two resets
console.log('\n--- hard crash: explosion, new plane, world reset');
{
  const sim = new Simulation(TEST_PLANE);
  run(sim, 2);
  // Wreck a structure first, so we can tell the two resets apart.
  const group = 0;
  sim.staticWorld.fracture(group, { impulse: 1e6, x: 0, y: 0, z: 0 }, sim.time);
  const b = sim.craft.body;
  const t = b.translation();
  b.setTranslation({ x: t.x, y: t.y + 30, z: t.z }, true);
  b.setLinvel({ x: 0, y: -90, z: -40 }, true);
  run(sim, 1.5);
  check(sim.exploded && sim.explosions.length === 1, 'a 90 m/s nose-in explodes the craft', `exploded ${sim.exploded}, explosions ${sim.explosions.length}, debris ${sim.debris.length}`);
  check(sim.debris.length >= sim.craft.def.parts.length - 2, 'the explosion throws the parts off', `debris ${sim.debris.length} of ${sim.craft.def.parts.length} parts`);
  check(sim.chips.total > 100, 'the explosion bursts into chips', `${sim.chips.total} chips`);
  const tel = sim.telemetry();
  check(sim.controls.throttle === 0, 'a wreck ignores the controls', `throttle ${sim.controls.throttle}, speed ${tel.airspeed.toFixed(1)}`);

  sim.respawn();
  check(!sim.exploded && sim.debris.length === 0 && sim.craft.detached.size === 0, 'new plane: a whole craft, no debris');
  check([...sim.craft.voxels.values()].every((v) => v.aliveCount === v.total), 'new plane: every voxel back');
  check(sim.staticWorld.fractured.size >= 1, 'new plane: the wrecked structure stays wrecked', `${sim.staticWorld.fractured.size} fractured`);
  run(sim, 2);
  check(!sim.exploded && sim.failures.length === 0, 'new plane: sits on the runway unharmed');

  sim.resetToRunway();
  check(sim.staticWorld.fractured.size === 0 && sim.explosions.length === 0 && sim.chips.bursts.length === 0, 'world reset: every structure whole again');
}

if (failed) {
  console.error(`\n${failed} destruction check(s) failed`);
  process.exit(1);
}
console.log('\nall destruction checks passed');
