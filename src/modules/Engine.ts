import * as THREE from 'three';
import type { EngineDef } from '../craft/types.ts';
import { TUNING } from '../tuning.ts';
import { airDensity } from '../sim/atmosphere.ts';
import type { ForceModule, StepContext } from './ForceModule.ts';

const _p = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const FORWARD = new THREE.Vector3(0, 0, -1);

/** Thrust along the part's forward axis with throttle and first-order spool lag. */
export class Engine implements ForceModule {
  readonly type = 'engine';
  readonly localPosition: THREE.Vector3;
  readonly localRotation: THREE.Quaternion;
  readonly def: EngineDef;

  /** Current spool 0..1 (lags throttle). */
  spool = 0;
  thrust = 0;
  /** Propeller angle for visuals (rad). */
  propAngle = 0;

  constructor(
    readonly partId: string,
    def: EngineDef,
    position: THREE.Vector3,
    rotation: THREE.Quaternion,
  ) {
    this.def = def;
    this.localPosition = position;
    this.localRotation = rotation;
  }

  reset(): void {
    this.spool = 0;
    this.thrust = 0;
  }

  /** Craft-local thrust direction. */
  localDirection(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(FORWARD).applyQuaternion(this.localRotation);
  }

  step(ctx: StepContext): void {
    const tau = this.def.spoolTime ?? TUNING.engineSpoolTime;
    const k = 1 - Math.exp(-ctx.dt / Math.max(1e-3, tau));
    this.spool += (ctx.controls.throttle - this.spool) * k;

    ctx.toWorldPoint(this.localPosition, _p);
    this.localDirection(_dir);
    ctx.toWorldDir(_dir, _dir);

    let thrust = this.def.maxThrust * this.spool;
    // Air-breathing: thrust scales with density.
    thrust *= airDensity(_p.y) / TUNING.seaLevelDensity;
    // Propellers lose thrust as airspeed approaches their pitch speed.
    if (this.def.propMaxSpeed) {
      const axial = ctx.pointVelocity(_p, _v).dot(_dir);
      thrust *= Math.max(0, 1 - Math.max(0, axial) / this.def.propMaxSpeed);
    }
    this.thrust = thrust;
    this.propAngle = (this.propAngle + this.spool * 150 * ctx.dt) % (Math.PI * 2);

    _f.copy(_dir).multiplyScalar(thrust);
    ctx.applyForce('thrust', _f, _p);
  }
}
