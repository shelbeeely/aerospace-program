/**
 * Planet checks (headless): wrap-around at the circumference, gravity falling off with
 * altitude, and a real orbit at orbital speed. Run with `npm run planet`.
 */
import { JET } from '../src/craft/jet.ts';
import { ORBITER } from '../src/craft/orbiter.ts';
import { Engine } from '../src/modules/Engine.ts';
import type { Telemetry } from '../src/sim/telemetry.ts';
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
/** Orbiter pitch program: pitch (deg) to a1, linearly to 0 at a2; burn to hold the apoapsis, then circularise. */
const ASCENT = { pitch: 40, a1: 8000, a2: 35000, apoapsis: 55000, circAltitude: 33000, circVs: 25, periapsis: 32000 };

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

// --- Orbit readout: a circular orbit reads Ap ≈ Pe ≈ altitude with the Kepler period, and on an
// eccentric coast Ap and Pe hold still (energy and angular momentum are conserved).
{
  const h = 30000;
  const r = PLANET.radius + h;
  const vOrb = Math.sqrt(mu / r);
  const circ = launch(0, h, 0, vOrb, BALL).telemetry().orbit!;
  const T = 2 * Math.PI * Math.sqrt(r ** 3 / mu);
  check(Math.abs(circ.apoapsis! - h) < 50 && Math.abs(circ.periapsis - h) < 50 && Math.abs(circ.period! - T) < 5, 'circular orbit readout: Ap = Pe = altitude, Kepler period', `Ap ${circ.apoapsis} Pe ${circ.periapsis} T ${circ.period} s (expect ${T.toFixed(0)})`);
  const sim = launch(0, h, 0, vOrb * 1.1, BALL);
  sim.craft.body.setLinvel({ x: vOrb * 1.1, y: 40, z: 0 }, true);
  sim.step(idle);
  const o0 = sim.telemetry().orbit!;
  for (let i = 0; i < 120 * 30; i++) sim.step(idle);
  const o1 = sim.telemetry().orbit!;
  check(Math.abs(o1.apoapsis! - o0.apoapsis!) < 300 && Math.abs(o1.periapsis - o0.periapsis) < 300 && sim.position.y > h + 500, 'eccentric coast: Ap and Pe hold while climbing', `Ap ${o0.apoapsis} -> ${o1.apoapsis}, Pe ${o0.periapsis} -> ${o1.periapsis}, alt ${sim.position.y.toFixed(0)}`);
  const esc = launch(0, h, 0, Math.sqrt(2) * vOrb * 1.05, BALL).telemetry().orbit!;
  check(esc.apoapsis === null && esc.period === null, 'above escape speed the readout says so (no apoapsis or period)');
}

// --- Rocket: same thrust in vacuum as at sea level, burning T / (isp · g0); RCS turns it in vacuum.
{
  const sim = launch(0, 60000, 0, 120, ORBITER);
  const e = sim.craft.engines[0] as Engine;
  const fuel0 = sim.craft.fuel;
  for (let i = 0; i < 120 * 2; i++) sim.step({ ...idle, throttle: 1 });
  const flow = (fuel0 - sim.craft.fuel) / 2;
  const def = e.def;
  const expectFlow = def.maxThrust / (def.isp! * 9.80665);
  check(Math.abs(e.thrust - def.maxThrust) < 1, 'rocket: full thrust at 60 km (vacuum)', `${(e.thrust / 1000).toFixed(1)} kN of ${(def.maxThrust / 1000).toFixed(1)} kN`);
  check(Math.abs(flow - expectFlow) < expectFlow * 0.1, 'rocket: propellant flow = T / (isp · g0)', `${flow.toFixed(2)} kg/s (expect ${expectFlow.toFixed(2)})`);
  const p0 = sim.telemetry().pitch;
  for (let i = 0; i < 120 * 2; i++) sim.step({ ...idle, pitch: 1 });
  const p1 = sim.telemetry().pitch;
  for (let i = 0; i < 120 * 3; i++) sim.step(idle);
  const rate = Math.abs(sim.craft.body.angvel().x) + Math.abs(sim.craft.body.angvel().y) + Math.abs(sim.craft.body.angvel().z);
  check(p1 - p0 > 20 && e.rcs > 0.99, 'RCS pitches the nose up in vacuum', `pitch ${p0.toFixed(1)}° -> ${p1.toFixed(1)}° in 2 s`);
  check(rate < 0.02, 'RCS: centred stick stops the rotation', `${rate.toFixed(3)} rad/s after 3 s`);
}

// --- The Orbiter flies a scripted ascent to orbit: climb ~40°, ease the nose down above 8 km,
// keep the apoapsis topped up, burn horizontally high up until the periapsis clears 32 km,
// then coast prograde for 60 s without dropping below 20 km.
{
  const sim = launch(0, 600, 0, 120, ORBITER);
  let t: Telemetry = sim.telemetry();
  let prevPitch = t.pitch;
  const every = 4; // control at 30 Hz
  const steer = (target: number, throttle: number) => {
    const rate = (t.pitch - prevPitch) / (sim.dt * every);
    prevPitch = t.pitch;
    const c = (x: number) => Math.max(-1, Math.min(1, x));
    return { pitch: c((target - t.pitch) * 0.06 - rate * 0.03), roll: c(-t.roll * 0.04), yaw: 0, throttle, brake: 0 };
  };
  let ctl = idle;
  let inOrbit = -1;
  let minAlt = Infinity;
  let minPe = Infinity;
  for (let i = 0; i < 120 * 900; i++) {
    if (i % every === 0) {
      t = sim.telemetry();
      const o = t.orbit!;
      if (inOrbit < 0) {
        const target = t.altitude < ASCENT.a1 ? ASCENT.pitch : Math.max(0, ASCENT.pitch * (1 - (t.altitude - ASCENT.a1) / (ASCENT.a2 - ASCENT.a1)));
        const burn = (o.apoapsis ?? Infinity) < ASCENT.apoapsis || (t.altitude > ASCENT.circAltitude && t.verticalSpeed < ASCENT.circVs);
        ctl = steer(target, burn ? 1 : 0);
        if (o.periapsis > ASCENT.periapsis) inOrbit = t.time;
      } else {
        minAlt = Math.min(minAlt, t.altitude);
        minPe = Math.min(minPe, o.periapsis);
        ctl = steer((Math.atan2(t.verticalSpeed, Math.hypot(t.velocity[0], t.velocity[2])) * 180) / Math.PI, 0);
        if (t.time > inOrbit + 60) break;
      }
    }
    sim.step(ctl);
    if (sim.failures.length || sim.explosionResets) break;
  }
  const o = sim.telemetry().orbit!;
  check(inOrbit > 0, `Orbiter: scripted ascent reaches a periapsis above ${ASCENT.periapsis / 1000} km`, inOrbit > 0 ? `orbit at t=${inOrbit.toFixed(0)} s, fuel left ${((sim.craft.fuel / sim.craft.fuelCapacity) * 100).toFixed(0)}%` : `stuck at Ap ${o.apoapsis} Pe ${o.periapsis}`);
  check(inOrbit > 0 && minAlt > 20000 && minPe > 20000 && sim.failures.length === 0, 'Orbiter: stays in orbit for 60 s (above 20 km, Pe above 20 km)', `min alt ${minAlt.toFixed(0)} m, min Pe ${minPe.toFixed(0)} m, now Ap ${o.apoapsis} Pe ${o.periapsis}`);
}

console.log(failures ? `\n${failures} planet check(s) failed` : '\nall planet checks passed');
process.exit(failures ? 1 : 0);
