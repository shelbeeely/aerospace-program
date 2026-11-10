import * as THREE from 'three';
import type { AirbrakeDef, ChuteDef } from '../craft/types.ts';
import { TUNING } from '../tuning.ts';
import type { ForceModule, StepContext } from './ForceModule.ts';

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();

/**
 * Airbrake (speed brake): panels that open into the airflow with the brake input, in the air or
 * on the ground. Drag = ½ρv²·Cd·area·deployment; the panels take ~0.6 s to open or close.
 */
export class Airbrake implements ForceModule {
  readonly type = 'airbrake';
  readonly localRotation = new THREE.Quaternion();
  readonly localPosition: THREE.Vector3;
  /** 0 = stowed, 1 = fully open. */
  deploy = 0;

  constructor(readonly partId: string, readonly def: AirbrakeDef, position: THREE.Vector3) {
    this.localPosition = position;
  }

  reset(): void {
    this.deploy = 0;
  }

  step(ctx: StepContext): void {
    this.deploy += (ctx.controls.brake - this.deploy) * (1 - Math.exp(-ctx.dt / 0.6));
    if (this.deploy < 1e-3) return;
    ctx.toWorldPoint(this.localPosition, _p);
    ctx.airVelocity(_p, _v);
    const speed = _v.length();
    if (speed < TUNING.minAeroSpeed) return;
    const k = -0.5 * ctx.airDensity(_p.y) * speed * (this.def.cd ?? 1.2) * this.def.area * this.deploy;
    ctx.applyForce('drag', _v.multiplyScalar(k), _p);
  }
}

/**
 * Drag chute: streams behind the craft when the brake is pulled above `deploySpeed` (default
 * 15 m/s; a landing roll, or slowing a fast ground racer), at most `maxSpeed` (default 120 m/s,
 * faster and it would tear off), and is cut away below `cutSpeed` (default 8 m/s). One use per
 * flight: a respawn packs a new one. The canopy opens over ~0.8 s.
 */
export class Chute implements ForceModule {
  readonly type = 'chute';
  readonly localRotation = new THREE.Quaternion();
  readonly localPosition: THREE.Vector3;
  state: 'packed' | 'deployed' | 'gone' = 'packed';
  /** Canopy opening 0..1 (drag and visuals). */
  open = 0;
  /** World-space drag direction last step (the canopy streams this way), for visuals. */
  readonly trail = new THREE.Vector3(0, 0, 1);

  constructor(readonly partId: string, readonly def: ChuteDef, position: THREE.Vector3) {
    this.localPosition = position;
  }

  reset(): void {
    this.state = 'packed';
    this.open = 0;
  }

  step(ctx: StepContext): void {
    ctx.toWorldPoint(this.localPosition, _p);
    ctx.airVelocity(_p, _v);
    const speed = _v.length();
    if (this.state === 'packed' && ctx.controls.brake > 0.5 && speed > (this.def.deploySpeed ?? 15) && speed < (this.def.maxSpeed ?? 120)) {
      this.state = 'deployed';
    }
    if (this.state !== 'deployed') return;
    if (speed < (this.def.cutSpeed ?? 8) || speed > (this.def.maxSpeed ?? 120) * 1.3) {
      this.state = 'gone'; // cut away (or torn off)
      this.open = 0;
      return;
    }
    this.open = Math.min(1, this.open + ctx.dt / 0.8);
    if (speed < TUNING.minAeroSpeed) return;
    this.trail.copy(_v).divideScalar(-speed).negate(); // the canopy streams downwind of the craft
    const k = -0.5 * ctx.airDensity(_p.y) * speed * this.def.cdA * this.open;
    ctx.applyForce('drag', _v.multiplyScalar(k), _p);
  }
}
