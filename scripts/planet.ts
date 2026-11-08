/**
 * Planet checks (headless): wrap-around at the circumference, gravity falling off with
 * altitude, and a real orbit at orbital speed. Run with `npm run planet`.
 */
import { JET } from '../src/craft/jet.ts';
import type { CraftDef } from '../src/craft/types.ts';
import { PLANET } from '../src/sim/layout.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';

await initPhysics();
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const idle = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0 };
const mu = PLANET.gravity * PLANET.radius ** 2;

/** A bare 1 t box: no wings, no drag, so only gravity and the planet's curvature act on it. */
const BALL: CraftDef = { name: 'Ballast', formatVersion: 1, parts: [{ id: 'mass', kind: 'ballast', mass: 1000, position: [0, 0, 0], shape: { type: 'box', size: [1, 1, 1] }, color: '#ffffff' }] };

/** Put a craft at (x, y, z) flying east (+X) at speed v, nose east. */
function launch(x: number, y: number, z: number, v: number, def: CraftDef = JET) {
  const sim = new Simulation(def);
  const b = sim.craft.body;
  const yaw = -Math.PI / 2; // nose (-Z) to +X
  b.setTranslation({ x, y, z }, true);
  b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  b.setLinvel({ x: v, y: 0, z: 0 }, true);
  sim.step(idle);
  return sim;
}

// --- Wrap: cross the east edge, come back in from the west.
{
  const half = PLANET.circumference / 2;
  const sim = launch(half - 300, 2000, 0, 251, BALL);
  for (let i = 0; i < 120 * 4; i++) sim.step(idle);
  check(sim.wrapCount === 1 && sim.position.x < -half + 1000 && sim.position.x > -half, 'crossing the east edge brings you in from the west', `x ${sim.position.x.toFixed(0)}, wraps ${sim.wrapCount}`);
  check(sim.failures.length === 0 && sim.explosionResets === 0, 'the wrap is seamless (no damage, no resets)', sim.failures.map((f) => `${f.partId}:${f.cause}`).join(', '));
}

// --- Orbit: a drag-free mass at 2 km and orbital speed keeps its altitude; at half speed it
// falls as (1 - v²/v_orb²) of the local gravity.
{
  const h = 2000;
  const r = PLANET.radius + h;
  const vOrb = Math.sqrt(mu / r);
  const orbit = launch(0, h, 0, vOrb, BALL);
  const fall = launch(0, h, 0, vOrb * 0.5, BALL);
  let minAlt = Infinity, maxAlt = -Infinity;
  for (let i = 0; i < 120 * 10; i++) {
    orbit.step(idle);
    fall.step(idle);
    minAlt = Math.min(minAlt, orbit.position.y);
    maxAlt = Math.max(maxAlt, orbit.position.y);
  }
  check(maxAlt - minAlt < 20, `${vOrb.toFixed(0)} m/s at 2 km is an orbit: altitude holds`, `${minAlt.toFixed(0)}-${maxAlt.toFixed(0)} m over 10 s`);
  const g = PLANET.gravity * (PLANET.radius / r) ** 2;
  const expectDrop = 0.5 * g * 0.75 * 100;
  check(Math.abs(h - fall.position.y - expectDrop) < 15, 'at half orbital speed it falls at 3/4 of local gravity', `dropped ${(h - fall.position.y).toFixed(0)} m, expected ~${expectDrop.toFixed(0)} m`);
  check(Math.abs(g - 6.28) < 0.05, 'gravity at 2 km is (R/(R+h))² of the surface value', `${g.toFixed(2)} m/s²`);
}

console.log(failures ? `\n${failures} planet check(s) failed` : '\nall planet checks passed');
process.exit(failures ? 1 : 0);
