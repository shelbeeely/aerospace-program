import * as THREE from 'three';
import type { MotorDef } from '../craft/types.ts';
import type { ForceModule } from './ForceModule.ts';

/**
 * Brushless DC motor + ESC on the battery bus, driving the rotor on its part.
 *
 * Kt = 60/(2π·Kv) (N·m/A, equal to the back-EMF constant in V·s/rad). With duty u the winding
 * current is I = (V·u − ω·Kt)/R, clipped to ±maxCurrent; torque τ = Kt·I. The rotor's speed
 * controller picks the torque it wants (≤ the u = 1 limit); the motor then draws
 * P = τ·ω + I²·R from the bus (negative when braking: regeneration).
 */
export class Motor implements ForceModule {
  readonly type = 'motor';
  readonly localRotation = new THREE.Quaternion();
  readonly localPosition: THREE.Vector3;
  readonly def: MotorDef;
  /** Torque constant (N·m/A). */
  readonly kt: number;

  /** Bus voltage available to the ESC (V), set by the ElectricalSystem each step. */
  busVoltage = 0;
  /** Fraction of the requested power the bus could deliver (brownout < 1). */
  supply = 1;
  /** Operating point from the last rotor step. */
  current = 0;
  torque = 0;
  omega = 0;
  /** Electrical power drawn from the bus (W). */
  power = 0;
  /** ESC duty 0..1 implied by the operating point. */
  duty = 0;

  constructor(
    readonly partId: string,
    def: MotorDef,
    position: THREE.Vector3,
  ) {
    this.def = def;
    this.localPosition = position;
    this.kt = 60 / (2 * Math.PI * def.kv);
  }

  /** Winding current available at full duty at rotor speed ω (A, ≥ 0). */
  maxCurrentAt(omega: number): number {
    const v = this.busVoltage * this.supply;
    return Math.min(this.def.maxCurrent, Math.max(0, (v - omega * this.kt) / this.def.rWinding));
  }

  /** Driving torque available at ω with full duty (N·m). */
  availableTorque(omega: number): number {
    return this.kt * this.maxCurrentAt(omega);
  }

  /** Braking torque the ESC can apply (N·m, ≥ 0), limited by current. */
  brakingTorque(): number {
    return this.busVoltage > 0 ? 0.5 * this.kt * this.def.maxCurrent : 0;
  }

  /** Record what the rotor made the motor do this step; sets current and bus power. */
  setOperatingPoint(torque: number, omega: number): void {
    this.torque = torque;
    this.omega = omega;
    const i = torque / this.kt;
    this.current = i;
    this.power = torque * omega + i * i * this.def.rWinding;
    this.duty = this.busVoltage > 0 ? Math.min(1, Math.max(0, (i * this.def.rWinding + omega * this.kt) / this.busVoltage)) : 0;
  }

  reset(): void {
    this.current = this.torque = this.omega = this.power = this.duty = 0;
    this.supply = 1;
  }

  step(): void {}
}
