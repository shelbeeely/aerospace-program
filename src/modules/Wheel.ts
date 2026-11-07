import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { WheelDef } from '../craft/types.ts';
import { DEG, TUNING } from '../tuning.ts';
import type { ForceModule, StepContext } from './ForceModule.ts';

const _mount = new THREE.Vector3();
const _down = new THREE.Vector3();
const _up = new THREE.Vector3();
const _contact = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _lat = new THREE.Vector3();
const _f = new THREE.Vector3();
const _q = new THREE.Quaternion();
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);

/**
 * Raycast suspension wheel: a spring-damper along the part's down axis plus tyre friction.
 * Friction uses a "relaxation" model: it tries to cancel the contact patch's sliding velocity
 * over `tyreRelaxationTime`, capped by the friction circle (mu * load).
 */
export class Wheel implements ForceModule {
  readonly type = 'wheel';
  readonly localPosition: THREE.Vector3;
  readonly localRotation: THREE.Quaternion;
  readonly def: WheelDef;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  // Live state
  grounded = false;
  compression = 0;
  /** Distance from mount to wheel centre (for visuals). */
  suspensionLength: number;
  steerAngle = 0;
  spinAngle = 0;
  load = 0;

  constructor(
    readonly partId: string,
    def: WheelDef,
    position: THREE.Vector3,
    rotation: THREE.Quaternion,
  ) {
    this.def = def;
    this.localPosition = position;
    this.localRotation = rotation;
    this.suspensionLength = def.restLength;
  }

  reset(): void {
    this.grounded = false;
    this.compression = 0;
    this.suspensionLength = this.def.restLength;
    this.steerAngle = 0;
    this.load = 0;
  }

  step(ctx: StepContext): void {
    const def = this.def;
    ctx.toWorldPoint(this.localPosition, _mount);
    ctx.toWorldDir(_down.copy(DOWN).applyQuaternion(this.localRotation), _down);
    _up.copy(_down).negate();

    // Steering, faded with speed so high-speed taxiing isn't twitchy.
    const speed = ctx.linvel.length();
    const fade =
      1 - (1 - TUNING.steerHighSpeedFactor) * Math.min(1, speed / TUNING.steerFadeSpeed);
    this.steerAngle = (def.maxSteerDeg ?? 0) * DEG * ctx.controls.yaw * fade;

    const maxLen = def.restLength + def.radius;
    this.ray.origin = { x: _mount.x, y: _mount.y, z: _mount.z };
    this.ray.dir = { x: _down.x, y: _down.y, z: _down.z };
    const hit = ctx.world.castRayAndGetNormal(
      this.ray,
      maxLen,
      true,
      undefined,
      undefined,
      undefined,
      ctx.body,
    );

    const prevCompression = this.compression;
    if (!hit) {
      this.grounded = false;
      this.compression = 0;
      this.load = 0;
      this.suspensionLength = def.restLength;
      return;
    }

    const dist = hit.timeOfImpact;
    this.grounded = true;
    // Allow a little over-compression (bottoming out) but cap it.
    this.compression = Math.min(def.restLength * 1.3, maxLen - dist);
    this.suspensionLength = Math.max(0, dist - def.radius);
    _contact.copy(_mount).addScaledVector(_down, dist);
    _normal.set(hit.normal.x, hit.normal.y, hit.normal.z);

    // --- Suspension
    const compressionVel = (this.compression - prevCompression) / ctx.dt;
    let spring = def.stiffness * this.compression + def.damping * compressionVel;
    spring = Math.max(0, spring);
    // Load on the tyre is the part of the spring force pressing into the ground.
    const load = spring * Math.max(0, _up.dot(_normal));
    this.load = load;
    _f.copy(_up).multiplyScalar(spring);
    ctx.applyForce('wheel', _f, _contact);

    if (load <= 0) return;

    // --- Tyre friction
    ctx.pointVelocity(_contact, _v);
    _q.setFromAxisAngle(UP, -this.steerAngle);
    _fwd.copy(FORWARD).applyQuaternion(_q).applyQuaternion(this.localRotation);
    ctx.toWorldDir(_fwd, _fwd);
    _fwd.addScaledVector(_normal, -_fwd.dot(_normal));
    if (_fwd.lengthSq() < 1e-8) return;
    _fwd.normalize();
    _lat.crossVectors(_fwd, _normal).normalize();

    const vLong = _v.dot(_fwd);
    const vLat = _v.dot(_lat);
    this.spinAngle = (this.spinAngle + (vLong / def.radius) * ctx.dt) % (Math.PI * 2);

    const massShare = load / TUNING.gravity;
    const gain = massShare / TUNING.tyreRelaxationTime;
    const muLong =
      TUNING.rollingResistance + (def.brakes ? ctx.controls.brake * TUNING.brakeFriction : 0);
    const muLat = TUNING.tyreLateralFriction;

    let fLong = THREE.MathUtils.clamp(-vLong * gain, -muLong * load, muLong * load);
    let fLat = THREE.MathUtils.clamp(-vLat * gain, -muLat * load, muLat * load);
    // Friction circle
    const total = Math.hypot(fLong, fLat);
    const cap = muLat * load;
    if (total > cap) {
      fLong *= cap / total;
      fLat *= cap / total;
    }
    _f.copy(_fwd).multiplyScalar(fLong).addScaledVector(_lat, fLat);
    ctx.applyForce('wheel', _f, _contact);
  }
}
