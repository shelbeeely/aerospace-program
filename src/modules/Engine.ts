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
const _w = new THREE.Vector3();
const _iq = new THREE.Quaternion();
const _tau = new THREE.Vector3();

/**
 * Thrust along the part's forward axis with throttle, first-order spool lag and fuel. Props
 * also produce reaction torque (the airframe rolls against the prop) and P-factor (at an
 * angle to the airflow, one side of the disk bites harder, so the thrust line shifts).
 * Rockets carry their own oxidiser: thrust ignores air density (full thrust in vacuum) and
 * burn maxThrust / (isp · g0) kg/s at full power. An engine with `rcsTorque` also fires
 * reaction-control thrusters that turn the craft where the air is too thin for its surfaces.
 */
export class Engine implements ForceModule {
  readonly type = 'engine';
  readonly localPosition: THREE.Vector3;
  readonly localRotation: THREE.Quaternion;
  readonly def: EngineDef;
  readonly isProp: boolean;
  /** Turbofan or turbojet (a turbofan with no bypass). */
  readonly isTurbofan: boolean;
  /** Carries its own oxidiser (liquid rocket or solid booster): thrust ignores the air. */
  readonly isRocket: boolean;
  readonly isRamjet: boolean;
  readonly isScramjet: boolean;
  readonly isSolid: boolean;
  /** Solid booster: lit (it can't be stopped) and seconds of burn left. */
  lit = false;
  burnLeft = 0;
  /** Thrust-vector deflection last step (0..1 of gimbalDeg), for visuals and tests. */
  gimbal = 0;
  readonly propDirection: number;
  readonly fuelFlow: number;
  /** Afterburner level 0..1 (lags the throttle crossing the light-up threshold). */
  afterburner = 0;
  /** Flight Mach number at the engine, last step. */
  mach = 0;

  /** Current spool 0..1 (lags throttle). */
  spool = 0;
  thrust = 0;
  /** Fraction of the part's voxels still attached (a battered engine makes less thrust). */
  integrity = 1;
  /** True when the tanks ran dry. */
  starved = false;
  /** Propeller angle for visuals (rad). */
  propAngle = 0;
  /** RCS authority 0..1 last step (fades out as dynamic pressure builds). */
  rcs = 0;

  constructor(
    readonly partId: string,
    def: EngineDef,
    position: THREE.Vector3,
    rotation: THREE.Quaternion,
  ) {
    this.def = def;
    this.localPosition = position;
    this.localRotation = rotation;
    this.isTurbofan = def.kind === 'turbofan' || def.kind === 'turbojet';
    this.isSolid = def.kind === 'solid';
    this.isRocket = def.kind === 'rocket' || this.isSolid;
    this.isRamjet = def.kind === 'ramjet';
    this.isScramjet = def.kind === 'scramjet';
    this.isProp = !this.isTurbofan && !this.isRocket && !this.isRamjet && !this.isScramjet && def.propMaxSpeed !== undefined;
    this.burnLeft = def.burnTime ?? 20;
    // Turbofans and rockets have no propeller: no reaction torque or P-factor.
    this.propDirection = this.isTurbofan || this.isRocket ? 0 : (def.propDirection ?? (this.isProp ? 1 : 0));
    // Ram/scramjets burn about twice / two and a half times a turbofan's fuel per newton.
    const airBreathingFuel = def.maxThrust * TUNING.fuelPerNewtonSecond * (this.isRamjet ? 2 : this.isScramjet ? 2.5 : 1);
    this.fuelFlow =
      def.fuelFlow ?? (this.isRocket ? Engine.rocketFuelFlow(def.maxThrust, def.isp ?? (this.isSolid ? 250 : TUNING.rocketDefaultIsp)) : airBreathingFuel);
  }

  reset(): void {
    this.spool = 0;
    this.thrust = 0;
    this.starved = false;
    this.afterburner = 0;
    this.mach = 0;
    this.rcs = 0;
    this.lit = false;
    this.burnLeft = this.def.burnTime ?? 20;
    this.gimbal = 0;
  }

  /** Ramjet thrust fraction vs Mach: nothing static, rising from Mach 0.4, best 2.5-4, gone by 6. */
  static ramjetCurve(m: number): number {
    if (m <= 0.4 || m >= 6) return 0;
    if (m < 2.5) { const t = (m - 0.4) / 2.1; return t * t * (3 - 2 * t); }
    if (m <= 4) return 1;
    const t = (6 - m) / 2;
    return t * t * (3 - 2 * t);
  }

  /** Scramjet thrust fraction vs Mach: nothing below Mach 3.5, best 6-9, gone by 12. */
  static scramjetCurve(m: number): number {
    if (m <= 3.5 || m >= 12) return 0;
    if (m < 6) { const t = (m - 3.5) / 2.5; return t * t * (3 - 2 * t); }
    if (m <= 9) return 1;
    const t = (12 - m) / 3;
    return t * t * (3 - 2 * t);
  }

  /** Rocket propellant flow (kg/s) at a thrust (N) and specific impulse (s): T / (isp · g0). */
  static rocketFuelFlow(thrust: number, isp: number): number {
    return thrust / (Math.max(1, isp) * TUNING.standardGravity);
  }

  /**
   * Turbofan thrust as a fraction of static sea-level dry thrust at full spool, for a density
   * ratio and Mach number: σ^0.7 × (1 − 0.25·M·(1+BPR)/(1+0.1·BPR)).
   */
  static turbofanLapse(sigma: number, mach: number, bypassRatio: number): number {
    const ram = 1 - (TUNING.turbofanMachLapse * mach * (1 + bypassRatio)) / (1 + 0.1 * bypassRatio);
    return Math.pow(Math.max(0, sigma), TUNING.turbofanDensityExponent) * Math.max(0, ram);
  }

  /** Craft-local thrust direction. */
  localDirection(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(FORWARD).applyQuaternion(this.localRotation);
  }

  step(ctx: StepContext): void {
    const def = this.def;
    const tau = def.spoolTime ?? (this.isRocket ? TUNING.rocketSpoolTime : TUNING.engineSpoolTime);
    const k = 1 - Math.exp(-ctx.dt / Math.max(1e-3, tau));
    let command = this.starved ? 0 : ctx.controls.throttle;
    if (this.isSolid) {
      // A solid booster lights once (throttle past half) and burns flat out until it's spent.
      if (!this.lit && command > 0.5 && this.burnLeft > 0) this.lit = true;
      if (this.lit) this.burnLeft -= ctx.dt;
      command = this.lit && this.burnLeft > 0 ? 1 : 0;
      if (this.lit && this.burnLeft <= 0) this.spool = 0; // burnt out: thrust stops, no tail-off
    }
    this.spool += (command - this.spool) * k;

    ctx.toWorldPoint(this.localPosition, _p);
    ctx.toWorldDir(this.localDirection(_dir), _dir);
    ctx.airVelocity(_p, _v);
    const air = this.isTurbofan || this.isRamjet || this.isScramjet ? ctx.air(_p.y) : undefined;
    const density = air ? air.density : ctx.airDensity(_p.y);
    const sigma = density / TUNING.seaLevelDensity;

    // Engine-specific thrust factor (fraction of maxThrust at full spool) and fuel factor
    // (fraction of fuelFlow at full spool).
    let thrustFactor: number;
    let fuelFactor = 1;
    if (this.isTurbofan) {
      this.mach = _v.length() / air!.speedOfSound;
      const dry = Engine.turbofanLapse(sigma, this.mach, def.kind === 'turbojet' ? 0 : def.bypassRatio ?? 1);
      const ab = def.afterburner;
      // Reheat lights only at full military power: throttle past the detent AND spooled up.
      const lit = ab && !this.starved && command > TUNING.afterburnerThrottle && this.spool > TUNING.afterburnerThrottle ? 1 : 0;
      this.afterburner += (lit - this.afterburner) * (1 - Math.exp(-ctx.dt / TUNING.afterburnerSpoolTime));
      const abThrust = ab ? 1 + (ab.thrustRatio - 1) * this.afterburner : 1;
      const abFuel = ab ? 1 + (ab.fuelRatio - 1) * this.afterburner : 1;
      thrustFactor = dry * abThrust;
      // Fuel follows dry thrust (gas-generator work) with TSFC rising with Mach; reheat on top.
      fuelFactor = dry * (1 + TUNING.turbofanTsfcMach * this.mach) * abFuel;
    } else if (this.isRocket) {
      // Rocket: carries its own oxidiser, so the same thrust at sea level and in vacuum.
      thrustFactor = 1;
      if (this.isSolid) fuelFactor = 0; // its propellant is in the casing (the part's mass)
    } else if (this.isRamjet || this.isScramjet) {
      // Ram compression only: thrust from the inlet's Mach, scaled by the air it swallows.
      this.mach = _v.length() / air!.speedOfSound;
      const curve = this.isRamjet ? Engine.ramjetCurve(this.mach) : Engine.scramjetCurve(this.mach);
      thrustFactor = curve * (this.isScramjet ? Math.sqrt(sigma) : sigma);
      fuelFactor = curve > 0 ? Math.max(0.2, thrustFactor) : 0;
    } else {
      // Air-breathing: thrust scales with density.
      thrustFactor = sigma;
      // Propellers lose thrust as airspeed approaches their pitch speed.
      if (this.isProp) thrustFactor *= Math.max(0, 1 - Math.max(0, _v.dot(_dir)) / def.propMaxSpeed!);
    }

    // Fuel: burn in proportion to spool. Engines on a craft without tanks run forever.
    if (ctx.hasFuelSystem && this.spool > 0.001 && fuelFactor > 0) {
      const need = this.fuelFlow * fuelFactor * this.spool * ctx.dt;
      const got = ctx.drawFuel(need);
      if (got < need * 0.999) {
        this.starved = true;
        this.spool *= got / need;
      }
    }

    // RCS after the main engine's fuel draw, so a trickle of attitude control can't starve it.
    if (def.rcsTorque) this.stepRcs(ctx, 0.5 * density * _v.lengthSq());

    const thrust = def.maxThrust * this.spool * thrustFactor * this.integrity;
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

    if (def.gimbalDeg) this.vector(ctx, _dir);
    _f.copy(_dir).multiplyScalar(thrust);
    ctx.applyForce('thrust', _f, _at);
  }

  /**
   * Thrust vectoring: tilt the thrust line so its moment about the CoM is the one the pitch/yaw
   * stick asks for (nose up = +X about the craft, nose right = -Y), up to gimbalDeg. For an
   * engine behind the CoM that swings the nozzle one way, ahead of it the other.
   */
  private vector(ctx: StepContext, dir: THREE.Vector3): void {
    const c = ctx.controls;
    const pitch = c.pitch, yaw = c.yaw;
    const amount = Math.min(1, Math.hypot(pitch, yaw));
    this.gimbal = amount;
    if (amount < 1e-3) return;
    // Desired torque direction in world space, and the engine's arm from the CoM.
    _iq.copy(ctx.rotation);
    _tau.set(pitch, -yaw, 0).applyQuaternion(_iq);
    _w.copy(_p).sub(ctx.com);
    const r2 = _w.lengthSq();
    if (r2 < 1e-4) return;
    // δ = τ × r / |r|² gives r × δ = τ (for τ ⟂ r); keep it perpendicular to the thrust.
    _q.copy(_tau).cross(_w).divideScalar(r2);
    _q.addScaledVector(dir, -_q.dot(dir));
    const len = _q.length();
    if (len < 1e-6) return;
    const tilt = Math.tan(((this.def.gimbalDeg ?? 0) * Math.PI) / 180) * amount;
    dir.addScaledVector(_q, tilt / len).normalize();
  }

  /**
   * Reaction control: rate-command attitude thrusters. Stick deflection commands a body rate
   * (up to TUNING.rcsMaxRate); with the stick centred they null the rotation. Torque is capped
   * at rcsTorque per axis and fades out between TUNING.rcsFullQ and TUNING.rcsFadeQ of dynamic
   * pressure, where the control surfaces take over. Off near the ground (below rcsMinHeight,
   * full by twice that), so it never pivots a taxiing craft. Fuel: |torque| / arm / (isp · g0).
   */
  private stepRcs(ctx: StepContext, q: number): void {
    const height = _p.y - ctx.groundHeight(_p.x, _p.z);
    const fade =
      THREE.MathUtils.clamp((TUNING.rcsFadeQ - q) / (TUNING.rcsFadeQ - TUNING.rcsFullQ), 0, 1) *
      THREE.MathUtils.clamp(height / TUNING.rcsMinHeight - 1, 0, 1);
    this.rcs = fade;
    if (fade <= 0) return;
    const c = ctx.controls;
    const maxRate = TUNING.rcsMaxRate;
    // Craft-local body rates: +X nose up, +Y nose left, +Z right wing up (roll left).
    _w.copy(ctx.angvel).applyQuaternion(_iq.copy(ctx.rotation).invert());
    const gain = 1 / (TUNING.rcsRateBand * maxRate);
    const axis = (cmd: number, rate: number) => THREE.MathUtils.clamp((cmd * maxRate - rate) * gain, -1, 1);
    _tau.set(axis(c.pitch, _w.x), axis(-c.yaw, _w.y), axis(-c.roll, _w.z)).multiplyScalar(this.def.rcsTorque! * fade * this.integrity);
    const mag = Math.abs(_tau.x) + Math.abs(_tau.y) + Math.abs(_tau.z);
    if (mag < 1e-6) return;
    if (ctx.hasFuelSystem) {
      const need = Engine.rocketFuelFlow(mag / TUNING.rcsArm, TUNING.rcsIsp) * ctx.dt;
      const got = ctx.drawFuel(need);
      if (got < need * 0.999) _tau.multiplyScalar(got / need);
    }
    ctx.applyTorque(ctx.toWorldDir(_tau, _tau));
  }
}
