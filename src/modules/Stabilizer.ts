import * as THREE from 'three';
import type { StabilizerDef } from '../craft/types.ts';
import type { ForceModule, StepContext } from './ForceModule.ts';

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _t = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Gyro stabiliser for two-wheel craft (light cycles): a light cycle never falls over. It holds
 * the bank angle a balanced rider would take for the current turn (tan(lean) = v·ω / g) and
 * damps roll rate, by applying a torque about the craft's forward axis.
 */
export class Stabilizer implements ForceModule {
  readonly type = 'stabilizer';
  readonly localRotation = new THREE.Quaternion();
  readonly localPosition: THREE.Vector3;

  constructor(
    readonly partId: string,
    readonly def: StabilizerDef,
    position: THREE.Vector3,
  ) {
    this.localPosition = position;
  }

  reset(): void {}

  step(ctx: StepContext): void {
    ctx.toWorldDir(_fwd.set(0, 0, -1), _fwd);
    ctx.toWorldDir(_up.set(0, 1, 0), _up);
    ctx.toWorldDir(_right.set(1, 0, 0), _right);
    // Current bank: right wing (side) below the horizon = positive.
    const roll = Math.atan2(-_right.y, _up.y);
    const speed = ctx.linvel.length();
    const yawRate = ctx.angvel.dot(WORLD_UP); // + = turning left (counter-clockwise from above)
    const lean = Math.max(-0.9, Math.min(0.9, Math.atan2(-speed * yawRate, 9.81)));
    // About the nose axis, a positive rotation rolls the right side down (raises `roll`).
    const rollRate = ctx.angvel.dot(_fwd);
    const k = this.def.strength;
    const torque = -(roll - lean) * k - rollRate * k * 0.25;
    ctx.applyTorque(_t.copy(_fwd).multiplyScalar(torque));
  }
}
