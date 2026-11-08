import * as THREE from 'three';
import type { FuelTankDef } from '../craft/types.ts';
import type { ForceModule } from './ForceModule.ts';

/**
 * Passive fuel storage. The fuel's mass sits at the tank's position, so burning it moves the
 * craft's centre of mass (the craft recomputes mass properties as fuel is used).
 */
export class FuelTank implements ForceModule {
  readonly type = 'fuel';
  readonly localRotation = new THREE.Quaternion();
  readonly localPosition: THREE.Vector3;
  readonly capacity: number;
  /** Current fuel (kg). */
  fuel: number;

  constructor(
    readonly partId: string,
    readonly def: FuelTankDef,
    position: THREE.Vector3,
  ) {
    this.localPosition = position;
    this.capacity = def.capacity;
    this.fuel = this.initialFuel();
  }

  private initialFuel(): number {
    return this.capacity * Math.min(1, Math.max(0, this.def.fill ?? 1));
  }

  reset(): void {
    this.fuel = this.initialFuel();
  }

  step(): void {}
}
