/**
 * Electrical system tests: battery physics, the electric quadcopter's drivetrain and
 * endurance, generator failure on a plane, validation and electrical spikes. Runs the real
 * simulation headless. Run with `npm run electric`. Exits non-zero on any failure.
 */
import * as THREE from 'three';
import { BUILTINS, QUADCOPTER } from '../src/craft/builtins.ts';
import { ElectricalSystem } from '../src/craft/ElectricalSystem.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import type { BatteryDef, CraftDef } from '../src/craft/types.ts';
import { validateCraft } from '../src/craft/validate.ts';
import { Battery } from '../src/modules/Battery.ts';
import { Generator } from '../src/modules/Generator.ts';
import { calmWeather, WEATHER_PRESETS } from '../src/sim/atmosphere.ts';
import { HoverPilot } from '../src/sim/autopilot.ts';
import { flightTest } from '../src/sim/flightTest.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import type { Telemetry } from '../src/sim/telemetry.ts';

await initPhysics();

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
  if (!ok) failures++;
}

const quadBattery = QUADCOPTER.parts.flatMap((p) => p.modules ?? []).find((m): m is BatteryDef => m.type === 'battery')!;

// ------------------------------------------------------------------ battery sag
console.log('--- Battery sag into a fixed resistor (12S 16 Ah LiPo)');
for (const amps of [20, 60]) {
  const bat = new Battery('bat', quadBattery, new THREE.Vector3());
  const bus = new ElectricalSystem([bat]);
  const voc = bat.openCircuitVoltage;
  const r = bat.resistance;
  // Load resistor that would draw `amps` from this pack: Voc / (R_batt + R_load) = I.
  bus.testLoadOhms = voc / amps - r;
  bus.step(1e-3);
  const expected = voc - amps * r;
  const err = Math.abs(bus.busVoltage - expected) / expected;
  const errI = Math.abs(bat.current - amps) / amps;
  check(
    `V = Voc − I·R at ${amps} A`,
    err < 0.01 && errI < 0.01,
    `Voc ${voc.toFixed(2)} V, R ${(r * 1000).toFixed(0)} mΩ: ${bus.busVoltage.toFixed(3)} V at ${bat.current.toFixed(2)} A (expected ${expected.toFixed(3)} V, error ${(err * 100).toFixed(3)}%)`,
  );
}

{
  const bat = new Battery('bat', quadBattery, new THREE.Vector3());
  const bus = new ElectricalSystem([bat]);
  bus.testLoadOhms = bat.openCircuitVoltage / 60;
  let prev = bat.soc;
  let monotonic = true;
  let t = 0;
  for (; t < 3600 && bat.connected; t += 0.1) {
    bus.step(0.1);
    if (!(bat.soc < prev)) monotonic = false;
    prev = bat.soc;
  }
  check('SoC falls monotonically under load', monotonic && bat.soc < 0.1, `cut off (${bat.cutoff || 'none'}) after ${(t / 60).toFixed(1)} min at SoC ${(bat.soc * 100).toFixed(1)}%, pack ${bat.tempC.toFixed(1)} °C`);
  check('pack heats by I²R', bat.tempC > 22, `${bat.tempC.toFixed(1)} °C after a 60 A discharge`);
}

// ------------------------------------------------------------------ quad drivetrain
console.log('\n--- Quadcopter on its electric drivetrain');
const moderate = { ...calmWeather(), ...WEATHER_PRESETS.moderate.settings };
for (const [name, w] of [['calm', calmWeather()], ['moderate', moderate]] as const) {
  const r = await flightTest(QUADCOPTER, { weather: w });
  check(`quad test card [${name}]`, r.passed && r.score === 100, `${r.score}/100${r.issues.length ? ` - ${r.issues[0]}` : ''}`);
}

{
  const sim = new Simulation(QUADCOPTER, calmWeather());
  const pilot = new HoverPilot({ altitude: 20, forwardSpeed: 0, heading: 0 });
  let t: Telemetry = sim.telemetry();
  let sumW = 0;
  let sumA = 0;
  let n = 0;
  let cutAt = -1;
  let maxTemp = 0;
  const limit = 60 * 60;
  while (t.time < limit) {
    sim.step(pilot.sample(sim.dt, t));
    t = sim.telemetry();
    const e = t.electrical!;
    maxTemp = Math.max(maxTemp, e.batteryTempC ?? 0);
    if (t.time > 30 && t.time < 90) {
      sumW += sim.craft.electrical!.loadW;
      sumA += e.batteryAmps;
      n++;
    }
    if (!e.powered) {
      cutAt = t.time;
      break;
    }
  }
  const endurance = cutAt / 60;
  const e = sim.craft.electrical!;
  console.log(`hover draw ${(sumW / n / 1000).toFixed(2)} kW, ${(sumA / n).toFixed(0)} A from the pack`);
  check('quad hover endurance plausible (8-25 min)', endurance > 8 && endurance < 25, `${endurance.toFixed(1)} min to cutoff (${e.batteries[0].cutoff}), SoC ${((e.stateOfCharge ?? 0) * 100).toFixed(1)}%, max pack ${maxTemp.toFixed(1)} °C`);
  // Unpowered: flight controller and motors stop, so it falls.
  const alt0 = t.altitude;
  for (let i = 0; i < 2 / sim.dt; i++) {
    sim.step(pilot.sample(sim.dt, t));
    t = sim.telemetry();
  }
  const rpm = Math.max(...sim.craft.rotors.map((r) => r.omega / r.maxOmega));
  check('dead battery: flight controller stops and the quad drops', t.altitude < alt0 - 3 && t.electrical!.avionics === false, `altitude ${alt0.toFixed(1)} -> ${t.altitude.toFixed(1)} m in 2 s, rotors at ${(rpm * 100).toFixed(0)}% max`);
}

{
  // Same hover with a sagging (half-empty) pack still works, just at higher current.
  const half: CraftDef = structuredClone(QUADCOPTER);
  for (const p of half.parts) for (const m of p.modules ?? []) if (m.type === 'battery') m.soc = 0.3;
  const sim = new Simulation(half, calmWeather());
  const pilot = new HoverPilot({ altitude: 20, forwardSpeed: 0, heading: 0 });
  let t = sim.telemetry();
  for (let i = 0; i < 40 / sim.dt; i++) {
    sim.step(pilot.sample(sim.dt, t));
    t = sim.telemetry();
  }
  check('hover on a 30% pack', Math.abs(t.altitude - 20) < 1.5, `alt ${t.altitude.toFixed(1)} m, bus ${t.electrical!.busVolts} V, ${t.electrical!.batteryAmps} A`);
}

// ------------------------------------------------------------------ plane: generator
console.log('\n--- Trainer: generator and essential bus');
{
  const sim = new Simulation(TEST_PLANE, calmWeather());
  let t = sim.telemetry();
  for (let i = 0; i < 20 / sim.dt; i++) {
    sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0.6, brake: 1 });
    t = sim.telemetry();
  }
  const e = t.electrical!;
  check('engine running: generator carries the bus and charges the battery', e.generatorOnline && e.batteryAmps < 0 && e.avionics, `gen ${e.generatorAmps} A, battery ${e.batteryAmps} A, bus ${e.busVolts} V`);

  // Alternator fails: non-essential loads shed, essentials run from the battery.
  for (const g of sim.craft.modules) if (g instanceof Generator) g.failed = true;
  for (let i = 0; i < 5 / sim.dt; i++) {
    sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0.6, brake: 1 });
    t = sim.telemetry();
  }
  const bus = sim.craft.electrical!;
  const shed = bus.avionics.filter((a) => !a.essential).every((a) => a.shed);
  check('generator failure: non-essential loads shed, instruments on battery', shed && t.electrical!.avionics && t.electrical!.batteryAmps > 0, `battery ${t.electrical!.batteryAmps} A, load ${t.electrical!.loadW} W`);
  // Fast-forward the bus alone (nothing else draws power) until the instruments drop out.
  const designed = bus.essentialEnduranceMin();
  let minutes = 0;
  while (bus.avionicsPowered && minutes < 600) {
    bus.step(1);
    minutes += 1 / 60;
  }
  check(
    'essential bus lasts its designed time on battery',
    minutes >= 0.9 * designed && minutes >= 30,
    `${minutes.toFixed(0)} min (designed ${designed.toFixed(0)} min from ${bus.batteries[0].def.capacityAh} Ah over ${bus.essentialLoadW} W)`,
  );
  sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0.6, brake: 1 });
  t = sim.telemetry();
  check('flat battery: instruments flagged unpowered', t.electrical!.avionics === false, `bus ${t.electrical!.busVolts} V, cutoff "${t.electrical!.batteryCutoff}"`);
}

// ------------------------------------------------------------------ spikes
console.log('\n--- Electrical spike (lightning hook)');
{
  const sim = new Simulation(TEST_PLANE, calmWeather());
  sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  const bus = sim.craft.electrical!;
  const temp0 = bus.batteries[0].tempC;
  sim.craft.onElectricalSpike(3000);
  sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  const t = sim.telemetry();
  const nonEss = bus.avionics.filter((a) => !a.essential).every((a) => a.failed);
  const ess = bus.avionics.filter((a) => a.essential).every((a) => !a.failed);
  check('3 kJ spike burns out non-essential avionics only', nonEss && ess && t.electrical!.avionics, `failed: ${t.electrical!.failed.join(', ') || 'none'}, battery +${(bus.batteries[0].tempC - temp0).toFixed(2)} K`);
  sim.craft.onElectricalSpike(20000);
  sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  check('20 kJ spike takes out the essential bus too', !sim.telemetry().electrical!.avionics, `battery R ×${bus.batteries[0].damage.toFixed(2)}`);
  sim.resetToRunway();
  sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  check('reset repairs the avionics', sim.telemetry().electrical!.avionics && bus.avionics.every((a) => !a.failed), 'ok');
}

// ------------------------------------------------------------------ validation
console.log('\n--- Validation');
for (const b of BUILTINS) {
  const errs = validateCraft(b.craft);
  check(`${b.label} validates`, errs.length === 0, errs.join('; ') || 'ok');
}
{
  const noBattery: CraftDef = structuredClone(QUADCOPTER);
  for (const p of noBattery.parts) p.modules = (p.modules ?? []).filter((m) => m.type !== 'battery');
  const errs = validateCraft(noBattery);
  check('motor without a battery is rejected', errs.some((e) => e.includes('needs a battery')), errs[0] ?? 'no error');
  const bad: CraftDef = structuredClone(QUADCOPTER);
  for (const p of bad.parts)
    for (const m of p.modules ?? []) {
      if (m.type === 'motor') m.kv = 0;
      if (m.type === 'battery') m.capacityAh = 0;
    }
  const e2 = validateCraft(bad);
  check('kv and capacity must be > 0', e2.some((e) => e.includes('kv')) && e2.some((e) => e.includes('capacityAh')), `${e2.length} errors`);
  const r0: CraftDef = structuredClone(QUADCOPTER);
  for (const p of r0.parts) for (const m of p.modules ?? []) if (m.type === 'motor') m.rWinding = 0;
  check('winding resistance must be > 0', validateCraft(r0).some((e) => e.includes('rWinding')), 'ok');
}

console.log(failures ? `\n${failures} electrical check(s) failed` : '\nall electrical checks passed');
process.exit(failures ? 1 : 0);
