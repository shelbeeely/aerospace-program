import * as THREE from 'three';
import type { BatteryDef } from '../craft/types.ts';
import { TUNING } from '../tuning.ts';
import type { ForceModule } from './ForceModule.ts';

/**
 * Normalised open-circuit voltage vs state of charge, (V − Vmin)/(Vmax − Vmin): the steep
 * knee when nearly empty, a long flat middle and a rise when full (a typical LiPo discharge
 * curve at rest; lead-acid is close enough at this level of detail).
 */
const SOC_CURVE: ReadonlyArray<[number, number]> = [
  [0, 0],
  [0.05, 0.3],
  [0.1, 0.42],
  [0.2, 0.47],
  [0.4, 0.53],
  [0.6, 0.6],
  [0.8, 0.76],
  [0.9, 0.86],
  [1, 1],
];

/** Normalised open-circuit voltage 0..1 at a state of charge 0..1 (piecewise linear). */
export function socCurve(soc: number): number {
  const s = Math.min(1, Math.max(0, soc));
  for (let i = 1; i < SOC_CURVE.length; i++) {
    const [s1, v1] = SOC_CURVE[i];
    if (s <= s1) {
      const [s0, v0] = SOC_CURVE[i - 1];
      return v0 + ((v1 - v0) * (s - s0)) / (s1 - s0);
    }
  }
  return 1;
}

/**
 * Battery pack state. The ElectricalSystem solves the bus and calls `applyCurrent` each step;
 * this module only holds the chemistry: open-circuit voltage from SoC, I·R sag, I²R heating,
 * coulomb counting and the protection cutoff (cell under-voltage under load, or overheat).
 */
export class Battery implements ForceModule {
  readonly type = 'battery';
  readonly localRotation = new THREE.Quaternion();
  readonly localPosition: THREE.Vector3;
  readonly def: BatteryDef;
  readonly thermalMass: number;
  readonly maxTempC: number;

  /** State of charge 0..1. */
  soc = 1;
  /** Pack temperature (°C). */
  tempC = TUNING.batteryAmbientC;
  /** Current out of the pack this step (A, negative = charging). */
  current = 0;
  /** Terminal voltage this step (V). */
  voltage = 0;
  /** Protection tripped: the pack is off the bus until reset. */
  cutoff: '' | 'undervoltage' | 'overheat' = '';
  /** Internal resistance multiplier (>1 after an electrical spike damaged cells). */
  damage = 1;
  private lowTime = 0;

  constructor(
    readonly partId: string,
    def: BatteryDef,
    position: THREE.Vector3,
  ) {
    this.def = def;
    this.localPosition = position;
    // ~150 Wh/kg packs at ~1000 J/(kg·K) if not given.
    const wh = def.cells * 0.5 * (def.cellVmax + def.cellVmin) * def.capacityAh;
    this.thermalMass = def.thermalMass ?? Math.max(50, (wh / 150) * 1000);
    this.maxTempC = def.maxTempC ?? 70;
    this.reset();
  }

  /** Pack internal resistance (Ω). */
  get resistance(): number {
    return this.def.cells * this.def.cellResistance * this.damage;
  }

  /** Open-circuit voltage of the pack at the current SoC (V). */
  get openCircuitVoltage(): number {
    const d = this.def;
    return d.cells * (d.cellVmin + (d.cellVmax - d.cellVmin) * socCurve(this.soc));
  }

  /** Full-charge open-circuit voltage (V). */
  get fullVoltage(): number {
    return this.def.cells * this.def.cellVmax;
  }

  /** Energy left above empty (Wh), at the open-circuit voltage (no I·R losses). */
  get energyWh(): number {
    // ∫ V dq from 0 to soc, by the trapezoid rule over a few points.
    const d = this.def;
    const n = 20;
    let e = 0;
    for (let i = 0; i < n; i++) {
      const s = (this.soc * (i + 0.5)) / n;
      e += d.cells * (d.cellVmin + (d.cellVmax - d.cellVmin) * socCurve(s));
    }
    return (e / n) * this.soc * d.capacityAh;
  }

  get connected(): boolean {
    return this.cutoff === '';
  }

  /**
   * Integrate one step at pack current `amps` (positive = discharge) and terminal voltage
   * `volts`. Updates SoC, temperature, and the cutoff latch.
   */
  applyCurrent(amps: number, volts: number, dt: number, ambientC: number): void {
    const d = this.def;
    this.current = amps;
    this.voltage = volts;
    this.soc = Math.min(1, Math.max(0, this.soc - (amps * dt) / (3600 * d.capacityAh)));
    // I²R heating against convective cooling (time constant ~10 min).
    const heat = amps * amps * this.resistance;
    const cooling = (this.thermalMass / TUNING.batteryCoolingTime) * (this.tempC - ambientC);
    this.tempC += ((heat - cooling) / this.thermalMass) * dt;
    // Under-voltage: a cell below Vmin under load for longer than a short transient, or empty.
    if (amps > 0 && (volts / d.cells < d.cellVmin || this.soc <= 0)) this.lowTime += dt;
    else this.lowTime = 0;
    if (this.lowTime > TUNING.batteryCutoffDelay) this.cutoff = 'undervoltage';
    if (this.tempC > this.maxTempC) this.cutoff = 'overheat';
  }

  /** Off the bus: no current, terminal voltage = open-circuit voltage; it still cools. */
  idle(dt: number, ambientC: number): void {
    this.current = 0;
    this.voltage = this.openCircuitVoltage;
    this.tempC -= ((this.tempC - ambientC) / TUNING.batteryCoolingTime) * dt;
  }

  reset(): void {
    this.soc = Math.min(1, Math.max(0, this.def.soc ?? 1));
    this.tempC = TUNING.batteryAmbientC;
    this.current = 0;
    this.voltage = this.openCircuitVoltage;
    this.cutoff = '';
    this.damage = 1;
    this.lowTime = 0;
  }

  step(): void {}
}
