import * as THREE from 'three';
import { bodyWaveFactor } from './compressibility.ts';
import type { BodyDef } from '../craft/types.ts';
import { TUNING } from '../tuning.ts';
import type { ForceModule, StepContext } from './ForceModule.ts';

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _b = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _f = new THREE.Vector3();
const _t = new THREE.Vector3();
const NOSE = new THREE.Vector3(0, 0, -1);

/**
 * Slender-body aerodynamics for fuselages, pods and hulls (axis = part -Z):
 * - Axial drag on the frontal area.
 * - Viscous crossflow drag: the body side-on to the flow acts like a cylinder in crossflow
 *   (Allen & Perkins), Cdc ≈ 1.2 on the planform area, at the body centroid.
 * - Munk moment from potential flow: M = q (k2 - k1) Vol sin 2α, turning the body broadside to
 *   the flow. This is why aircraft need tail fins and why airships are unstable without them.
 *   k2 - k1 (added-mass coefficients) comes from the fineness ratio, as for a prolate spheroid.
 */
export class Body implements ForceModule {
  readonly type = 'body';
  readonly localPosition: THREE.Vector3;
  readonly localRotation: THREE.Quaternion;
  readonly frontalArea: number;
  readonly planformArea: number;
  readonly volume: number;
  readonly munkFactor: number;
  /** Last angle between the body axis and the relative wind (rad), for telemetry/debug. */
  alpha = 0;

  constructor(
    readonly partId: string,
    readonly def: BodyDef,
    position: THREE.Vector3,
    rotation: THREE.Quaternion,
  ) {
    this.localPosition = position;
    this.localRotation = rotation;
    const d = def.diameter;
    this.frontalArea = (Math.PI * d * d) / 4;
    this.planformArea = 0.8 * d * def.length; // tapered nose/tail
    this.volume = 0.65 * this.frontalArea * def.length;
    // Prolate-spheroid added mass (Lamb): fit of k2 - k1 vs fineness ratio L/d.
    const fineness = Math.max(1, def.length / d);
    this.munkFactor = Math.min(0.95, Math.max(0, 1 - 0.85 / Math.pow(fineness, 0.9)));
  }

  reset(): void {
    this.alpha = 0;
  }

  step(ctx: StepContext): void {
    ctx.toWorldPoint(this.localPosition, _p);
    ctx.airVelocity(_p, _v); // body velocity relative to the air
    const speed = _v.length();
    if (speed < TUNING.minAeroSpeed) return;
    ctx.toWorldDir(_b.copy(NOSE).applyQuaternion(this.localRotation), _b);
    const rho = ctx.airDensity(_p.y);
    const q = 0.5 * rho * speed * speed;
    const vAxial = _v.dot(_b);
    this.alpha = Math.acos(Math.max(-1, Math.min(1, vAxial / speed)));

    // Axial drag (opposes motion along the axis).
    // Nose-on drag, with the transonic wave-drag bump (sound speed from the local air).
    const mach = speed / ctx.air(_p.y).speedOfSound;
    const axial = -0.5 * rho * vAxial * Math.abs(vAxial) * (this.def.cdFront ?? 0.2) * bodyWaveFactor(mach) * this.frontalArea;
    _f.copy(_b).multiplyScalar(axial);
    ctx.applyForce('drag', _f, _p);

    // Viscous crossflow drag (opposes sideways motion).
    _vc.copy(_v).addScaledVector(_b, -vAxial);
    const vc = _vc.length();
    if (vc > 1e-3) {
      _f.copy(_vc).multiplyScalar(-0.5 * rho * vc * 1.2 * this.planformArea);
      ctx.applyForce('drag', _f, _p);
    }

    // Munk moment: τ = ρ (k2-k1) Vol (v·b)(v × b), rotating the axis away from the flow.
    if (this.munkFactor > 0) {
      _t.crossVectors(_v, _b).multiplyScalar(rho * this.munkFactor * this.volume * vAxial);
      // Cap at the value for 45° so a tumbling body doesn't get absurd torques.
      const max = q * this.munkFactor * this.volume;
      const m = _t.length();
      if (m > max) _t.multiplyScalar(max / m);
      ctx.applyTorque(_t);
    }
  }
}
