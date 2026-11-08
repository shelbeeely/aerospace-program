/**
 * Weather impact tests: runs the real simulation headless and shows that weather changes how
 * craft fly. Run with `npm run weather`. Exits non-zero if an expected effect is missing.
 */
import { QUADCOPTER } from '../src/craft/builtins.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { calmWeather, type WeatherSettings } from '../src/sim/atmosphere.ts';
import { HoverPilot } from '../src/sim/autopilot.ts';
import type { ControlInputs } from '../src/sim/controls.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import type { Telemetry } from '../src/sim/telemetry.ts';
import type { CraftDef } from '../src/craft/types.ts';

await initPhysics();

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
  if (!ok) failures++;
}

const weather = (patch: Partial<WeatherSettings>): WeatherSettings => ({ ...calmWeather(), ...patch });

interface Stats {
  throttle: number;
  rpm: number;
  /** Shaft power, all rotors (W). */
  power: number;
  vsStd: number;
  last: Telemetry;
  vortexRing: number;
  groundEffect: number;
}

/** Fly a pilot for `seconds`, averaging over the last `avg` seconds. */
function fly(
  def: CraftDef,
  w: WeatherSettings,
  seconds: number,
  avg: number,
  pilot: (t: Telemetry, dt: number) => ControlInputs,
  setup?: (sim: Simulation) => void,
): Stats {
  const sim = new Simulation(def, w);
  setup?.(sim);
  let t = sim.telemetry();
  const n = Math.round(seconds / sim.dt);
  const from = n - Math.round(avg / sim.dt);
  let thr = 0;
  let rpm = 0;
  let pw = 0;
  let vs = 0;
  let vs2 = 0;
  let vrs = 0;
  let ge = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    sim.step(pilot(t, sim.dt));
    t = sim.telemetry();
    if (i >= from) {
      const rotors = sim.craft.rotors;
      thr += t.controls.throttle;
      rpm += rotors.reduce((a, r) => a + r.omega / r.maxOmega, 0) / Math.max(1, rotors.length);
      pw += rotors.reduce((a, r) => a + r.motorTorque * r.omega, 0);
      vrs += rotors.reduce((a, r) => Math.max(a, r.vortexRing), 0);
      ge += rotors.reduce((a, r) => Math.max(a, r.groundEffect), 0);
      vs += t.verticalSpeed;
      vs2 += t.verticalSpeed ** 2;
      k++;
    }
  }
  const m = vs / k;
  return { throttle: thr / k, rpm: rpm / k, power: pw / k, vsStd: Math.sqrt(Math.max(0, vs2 / k - m * m)), last: t, vortexRing: vrs / k, groundEffect: ge / k };
}

const hover = (altitude: number) => {
  const p = new HoverPilot({ altitude, forwardSpeed: 0, heading: 0 });
  return (t: Telemetry, dt: number) => p.sample(dt, t);
};

console.log('--- Quadcopter hover at 20 m');
const calm = fly(QUADCOPTER, calmWeather(), 40, 15, hover(20));
const rain = fly(QUADCOPTER, weather({ precipitation: 50, cloudCover: 1 }), 40, 15, hover(20));
const downpour = fly(QUADCOPTER, weather({ precipitation: 150, cloudCover: 1 }), 40, 15, hover(20));
const show = (s: Stats) =>
  `power ${(s.power / 1000).toFixed(2)} kW, rotor speed ${(s.rpm * 100).toFixed(1)}% max, alt ${s.last.altitude.toFixed(1)} m, water ${s.last.weather.waterKg.toFixed(2)} kg`;
console.log(`calm:            ${show(calm)}`);
console.log(`rain 50 mm/h:    ${show(rain)}`);
console.log(`downpour 150:    ${show(downpour)}`);
check('heavy rain needs more power to hover', rain.power > calm.power * 1.03, `${((rain.power / calm.power - 1) * 100).toFixed(0)}% more power, ${((rain.rpm / calm.rpm - 1) * 100).toFixed(1)}% more rotor speed`);
check('downpour worse than heavy rain', downpour.power > rain.power, `${((downpour.power / calm.power - 1) * 100).toFixed(0)}% more power than calm`);
check('airframe carries water in rain', rain.last.weather.waterKg > 0.05, `${rain.last.weather.waterKg.toFixed(2)} kg`);

console.log('\n--- Quadcopter in supercooled cloud (-6 °C), 3 minutes');
const icing = fly(
  QUADCOPTER,
  weather({ temperatureOffset: -21, cloudBase: 0, cloudTop: 2000, cloudCover: 1 }),
  180,
  10,
  hover(20),
);
const iceMm = Math.max(...[icing.last.weather.iceMm]);
console.log(`iced:            ${show(icing)}, ice ${iceMm.toFixed(2)} mm`);
check('blades ice up in supercooled cloud', iceMm > 0.3, `${iceMm.toFixed(2)} mm`);
check('iced rotors need far more power', icing.power > calm.power * 1.25, `${((icing.power / calm.power - 1) * 100).toFixed(0)}% more power, ${((icing.rpm / calm.rpm - 1) * 100).toFixed(1)}% more rotor speed`);

console.log('\n--- Ground effect');
const low = fly(QUADCOPTER, calmWeather(), 25, 10, hover(0.15));
console.log(`hover 0.15 m:     ${show(low)}, ground effect ${(low.groundEffect * 100).toFixed(0)}%`);
check('less power needed in ground effect', low.power < calm.power * 0.95, `${((1 - low.power / calm.power) * 100).toFixed(0)}% less power`);

console.log('\n--- Vertical descent (vortex ring state)');
const descend = (rate: number) => {
  let integ = 0;
  return (t: Telemetry, dt: number): ControlInputs => {
    const err = -rate - t.verticalSpeed;
    integ = Math.max(-0.3, Math.min(0.3, integ + err * dt * 0.05));
    const h = (t.heading * Math.PI) / 180;
    const vFwd = t.velocity[0] * Math.sin(h) - t.velocity[2] * Math.cos(h);
    const vRight = t.velocity[0] * Math.cos(h) + t.velocity[2] * Math.sin(h);
    return {
      pitch: Math.max(-1, Math.min(1, vFwd * 0.12)),
      roll: Math.max(-1, Math.min(1, -vRight * 0.15)),
      yaw: 0,
      throttle: Math.max(0, Math.min(1, 0.5 + err * 0.12 + integ)),
      brake: 0,
    };
  };
};
const climbTo = (sim: Simulation) => {
  const p = new HoverPilot({ altitude: 400, forwardSpeed: 0, heading: 0 });
  let t = sim.telemetry();
  for (let i = 0; i < 120 / sim.dt && t.altitude < 395; i++) {
    sim.step(p.sample(sim.dt, t));
    t = sim.telemetry();
  }
};
const slow = fly(QUADCOPTER, calmWeather(), 12, 6, descend(1.5), climbTo);
const vrs = fly(QUADCOPTER, calmWeather(), 12, 6, descend(6), climbTo);
console.log(`descent 1.5 m/s: vortex ring ${(slow.vortexRing * 100).toFixed(0)}%, v/s jitter ±${slow.vsStd.toFixed(2)} m/s`);
console.log(`descent 6 m/s:   vortex ring ${(vrs.vortexRing * 100).toFixed(0)}%, v/s jitter ±${vrs.vsStd.toFixed(2)} m/s, throttle ${(vrs.throttle * 100).toFixed(0)}%`);
check('fast vertical descent enters vortex ring state', vrs.vortexRing > 0.3 && slow.vortexRing < 0.1, `${(vrs.vortexRing * 100).toFixed(0)}% vs ${(slow.vortexRing * 100).toFixed(0)}%`);

console.log('\n--- Trainer braking from 30 m/s, full brake, idle');
const brake = (w: WeatherSettings) => {
  const sim = new Simulation(TEST_PLANE, w);
  sim.craft.body.setLinvel({ x: 0, y: 0, z: -30 }, true);
  const x0 = sim.telemetry().position[2];
  let t = sim.telemetry();
  for (let i = 0; i < 60 / sim.dt && (i < 10 || t.groundSpeed > 0.5); i++) {
    sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
    t = sim.telemetry();
  }
  return { dist: Math.abs(t.position[2] - x0), wet: t.weather.groundWetness };
};
const dry = brake(calmWeather());
const wet = brake(weather({ precipitation: 10, cloudCover: 1 }));
const flooded = brake(weather({ precipitation: 60, cloudCover: 1 }));
console.log(`dry:      ${dry.dist.toFixed(0)} m`);
console.log(`wet:      ${wet.dist.toFixed(0)} m (runway wetness ${wet.wet.toFixed(2)})`);
console.log(`flooded:  ${flooded.dist.toFixed(0)} m (runway wetness ${flooded.wet.toFixed(2)}, aquaplaning above 25 m/s)`);
check('wet runway lengthens the stop', wet.dist > dry.dist * 1.15, `${((wet.dist / dry.dist - 1) * 100).toFixed(0)}% longer`);
check('flooded runway is worse still', flooded.dist > wet.dist, `${((flooded.dist / dry.dist - 1) * 100).toFixed(0)}% longer than dry`);

console.log(failures ? `\n${failures} weather check(s) failed` : '\nall weather checks passed');
process.exit(failures ? 1 : 0);
