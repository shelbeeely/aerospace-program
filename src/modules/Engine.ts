import * as THREE from 'three';
import type { EngineDef } from '../craft/types.ts';
import { TUNING } from '../tuning.ts';
import type { ForceModule, StepContext } from './ForceModule.ts';

const _p = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _q = new THREE.Vector3();
const _at = new THREE.Vector3();
const FORWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

/**
 * Thrust along the part's forward axis with throttle, first-order spool lag and fuel. Props
 * also produce reaction torque (the airframe rolls against the prop) and P-factor (at an
 * angle to the airflow, one side of the disk bites harder, so the thrust line shifts).
 */
export class Engine implements ForceModule {
  readonly type = 'engine';
  readonly localPosition: THREE.Vector3;
  readonly localRotation: THREE.Quaternion;
  readonly def: EngineDef;
  readonly isProp: boolean;
  readonly propDirection: number;
  readonly fuelFlow: number;

  /** Current spool 0..1 (lags throttle). */
  spool = 0;
  thrust = 0;
  /** True when the tanks ran dry. */
  starved = false;
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
    this.isProp = def.propMaxSpeed !== undefined;
    this.propDirection = def.propDirection ?? (this.isProp ? 1 : 0);
    this.fuelFlow = def.fuelFlow ?? def.maxThrust * TUNING.fuelPerNewtonSecond;
  }

  reset(): void {
    this.spool = 0;
    this.thrust = 0;
    this.starved = false;
  }

  /** Craft-local thrust direction. */
  localDirection(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(FORWARD).applyQuaternion(this.localRotation);
  }

  step(ctx: StepContext): void {
    const def = this.def;
    const tau = def.spoolTime ?? TUNING.engineSpoolTime;
    const k = 1 - Math.exp(-ctx.dt / Math.max(1e-3, tau));
    const command = this.starved ? 0 : ctx.controls.throttle;
    this.spool += (command - this.spool) * k;

    ctx.toWorldPoint(this.localPosition, _p);
    ctx.toWorldDir(this.localDirection(_dir), _dir);

    // Fuel: burn in proportion to spool. Engines on a craft without tanks run forever.
    if (ctx.hasFuelSystem && this.spool > 0.001) {
      const need = this.fuelFlow * this.spool * ctx.dt;
      const got = ctx.drawFuel(need);
      if (got < need * 0.999) {
        this.starved = true;
        this.spool *= got / need;
      }
    }

    let thrust = def.maxThrust * this.spool;
    // Air-breathing: thrust scales with density.
    thrust *= ctx.airDensity(_p.y) / TUNING.seaLevelDensity;
    ctx.airVelocity(_p, _v);
    // Propellers lose thrust as airspeed approaches their pitch speed.
    if (this.isProp) {
      const axial = _v.dot(_dir);
      thrust *= Math.max(0, 1 - Math.max(0, axial) / def.propMaxSpeed!);
    }
    this.thrust = thrust;
    this.propAngle = (this.propAngle + this.spool * 150 * ctx.dt * (this.propDirection || 1)) % (Math.PI * 2);
    if (thrust <= 0) return;

    _at.copy(_p);
    if (this.propDirection !== 0) {
      const radius = def.propRadius ?? 0.8;
      ctx.toWorldDir(_up.copy(UP).applyQuaternion(this.localRotation), _up);
      ctx.toWorldDir(_right.copy(RIGHT).applyQuaternion(this.localRotation), _right);

      // Reaction torque: the airframe is pushed opposite to the prop's spin. A clockwise prop
      // (seen from behind) spins about +forward, so the airframe gets torque about -forward.
      const torque = thrust * radius * TUNING.propTorqueFactor;
      ctx.applyTorque(_q.copy(_dir).multiplyScalar(-this.propDirection * torque));

      // P-factor: crossflow through the disk (air moving across it) makes the blade moving into
      // it produce more thrust, so the thrust centre shifts sideways on the disk.
      const speed = _v.length();
      if (speed > 1) {
        // In-plane velocity of the air relative to the prop (the air moves opposite to _v).
        const wx = -_v.dot(_right) / speed;
        const wy = -_v.dot(_up) / speed;
        const shift = radius * TUNING.pFactor;
        // Blade moving into the crossflow: for clockwise-from-behind props the right blade moves
        // down, so air rising through the disk loads the right side.
        _at.addScaledVector(_right, this.propDirection * wy * shift);
        _at.addScaledVector(_up, -this.propDirection * wx * shift);
      }
    }

    _f.copy(_dir).multiplyScalar(thrust);
    ctx.applyForce('thrust', _f, _at);
  }
}
