import * as THREE from 'three';
import type { WeaponModuleDef } from '../craft/types.ts';
import type { ForceModule } from './ForceModule.ts';

/**
 * A weapon fitted to a part (gun, cannon, missile rail, bomb bay, laser, disc launcher, pulse
 * emitter). No forces of its own: the weapon system fires from here (sim/weapons.ts) and keeps
 * `ammo` in step, so the craft view can show missiles and bombs leaving their rails and bays.
 */
export class WeaponMount implements ForceModule {
  readonly type = 'weapon';
  ammo: number;
  /** Seconds since it last fired (muzzle flash). */
  sinceFired = Infinity;

  constructor(
    readonly partId: string,
    readonly def: WeaponModuleDef,
    readonly localPosition: THREE.Vector3,
    readonly localRotation: THREE.Quaternion,
    capacity: number,
  ) {
    this.ammo = capacity;
  }

  reset(): void {
    this.sinceFired = Infinity;
  }

  step(): void {}
}
