import * as THREE from 'three';
import type { TrailDef } from '../craft/types.ts';
import type { ForceModule } from './ForceModule.ts';

/**
 * Marks where a craft lays down its trail (Rule 4: movement produces visible information). The
 * simulation's TrailSystem reads these; the module itself applies no force.
 * - 'wall': a light cycle's jetwall (solid light, or a fading light ribbon, set by the rider);
 * - 'contrail': a thin energy path behind an aircraft's wingtip or engine (visual only).
 */
export class TrailEmitter implements ForceModule {
  readonly type = 'trail';
  readonly localRotation = new THREE.Quaternion();
  readonly localPosition: THREE.Vector3;

  constructor(
    readonly partId: string,
    readonly def: TrailDef,
    position: THREE.Vector3,
  ) {
    this.localPosition = position;
  }

  reset(): void {}
  step(): void {}
}
