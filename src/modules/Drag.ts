import * as THREE from 'three';
import type { DragDef } from '../craft/types.ts';
import { TUNING } from '../tuning.ts';
import type { ForceModule, StepContext } from './ForceModule.ts';

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();

/**
 * Isotropic quadratic drag: F = -0.5 * rho * |v| * v * CdA. The simplest possible force
 * module, and a good template for writing new ones.
 */
export class Drag implements ForceModule {
  readonly type = 'drag';
  readonly localRotation = new THREE.Quaternion();
  readonly localPosition: THREE.Vector3;

  constructor(
    readonly partId: string,
    readonly def: DragDef,
    position: THREE.Vector3,
  ) {
    this.localPosition = position;
  }

  reset(): void {}

  step(ctx: StepContext): void {
    ctx.toWorldPoint(this.localPosition, _p);
    ctx.pointVelocity(_p, _v);
    const speed = _v.length();
    if (speed < TUNING.minAeroSpeed) return;
    const k = -0.5 * ctx.airDensity(_p.y) * speed * this.def.cdA;
    _v.multiplyScalar(k);
    ctx.applyForce('drag', _v, _p);
  }
}
