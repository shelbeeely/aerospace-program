import * as THREE from 'three';
import type { RotorDef } from '../craft/types.ts';
import { DEG, TUNING } from '../tuning.ts';
import { liftDragCoefficients } from './AeroSurface.ts';
import type { ForceModule, StepContext } from './ForceModule.ts';

const STATIONS = 8;
const SECTION_LIFT_SLOPE = 5.7; // per rad, typical rotor airfoil
const SECTION_STALL = 14 * DEG;
const SECTION_CD0 = 0.011;

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _edge = new THREE.Vector3();
const _f = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Blade element rotor with momentum-theory inflow.
 *
 * Each step: integrate lift and drag over radial blade stations (local blade speed Ωr, axial
 * inflow, blade pitch and twist, soft-stalling section polar) to get thrust and torque, then
 * update the induced inflow with Glauert's formula, v_i = T / (2ρA·sqrt(V_edge² + (V_axial + v_i)²)).
 * That gives translational lift in forward flight, less thrust in climbs and more in descents,
 * and the torque that yaws a helicopter (or lets a quad yaw by spinning some rotors faster).
 */
export class Rotor implements ForceModule {
  readonly type = 'rotor';
  readonly localPosition: THREE.Vector3;
  readonly localRotation: THREE.Quaternion;
  readonly def: RotorDef;
  readonly maxOmega: number;
  readonly area: number;

  // Inputs (set by the flight controller, or straight from the stick without one)
  /** 'rpm' mode: thrust fraction 0..1. 'collective' mode: collective 0..1. */
  command = 0;
  /** Cyclic tilt commands -1..1 (pitch +1 tilts the disk back, roll +1 tilts it right). */
  cyclicPitch = 0;
  cyclicRoll = 0;
  /** True when a flight controller is driving this rotor. */
  managed = false;

  // State
  omega = 0;
  inflow = 0;
  thrust = 0;
  torque = 0;
  /** Blade azimuth for visuals (rad). */
  angle = 0;

  constructor(
    readonly partId: string,
    def: RotorDef,
    position: THREE.Vector3,
    rotation: THREE.Quaternion,
  ) {
    this.def = def;
    this.localPosition = position;
    this.localRotation = rotation;
    this.maxOmega = (def.maxRpm * Math.PI * 2) / 60;
    this.area = Math.PI * def.radius * def.radius;
  }

  reset(): void {
    this.command = 0;
    this.cyclicPitch = this.cyclicRoll = 0;
    this.omega = 0;
    this.inflow = 0;
    this.thrust = 0;
    this.torque = 0;
  }

  /** Static sea-level thrust at full command (N), for design analysis / mixers. */
  staticThrust(): number {
    const save = { omega: this.omega, inflow: this.inflow };
    this.omega = this.maxOmega;
    this.inflow = 0;
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t = this.integrate(TUNING.seaLevelDensity, this.pitchAt(1), 0, 0).thrust;
      this.updateInflow(t, TUNING.seaLevelDensity, 0, 0, 0.5);
    }
    this.omega = save.omega;
    this.inflow = save.inflow;
    return t;
  }

  /** Blade pitch at 3/4 radius for a given command. */
  private pitchAt(command: number): number {
    const d = this.def;
    if (d.mode === 'rpm') return d.pitchDeg * DEG;
    const lo = d.minPitchDeg ?? -2;
    return (lo + (d.pitchDeg - lo) * command) * DEG;
  }

  private integrate(rho: number, theta75: number, vAxial: number, vEdge: number): { thrust: number; torque: number } {
    const d = this.def;
    const R = d.radius;
    const twist = (d.twistDeg ?? -8) * DEG;
    const r0 = 0.15 * R;
    const dr = (R - r0) / STATIONS;
    const up = vAxial + this.inflow; // flow down through the disk, relative to the blades
    let thrust = 0;
    let torque = 0;
    for (let i = 0; i < STATIONS; i++) {
      const r = r0 + (i + 0.5) * dr;
      const ut = this.omega * r;
      // Edgewise flow averaged over a revolution adds to the dynamic pressure.
      const u2 = ut * ut + up * up + 0.5 * vEdge * vEdge;
      if (u2 < 1e-4) continue;
      const phi = Math.atan2(up, Math.max(1e-3, ut));
      const theta = theta75 + twist * (r / R - 0.75);
      const { cl, cd } = liftDragCoefficients(theta - phi, SECTION_LIFT_SLOPE, SECTION_STALL, SECTION_CD0, 1e6);
      const q = 0.5 * rho * u2 * d.chord * dr * d.blades;
      const dL = q * cl;
      const dD = q * cd;
      thrust += dL * Math.cos(phi) - dD * Math.sin(phi);
      torque += (dL * Math.sin(phi) + dD * Math.cos(phi)) * r;
    }
    return { thrust, torque };
  }

  private updateInflow(thrust: number, rho: number, vAxial: number, vEdge: number, relax: number): void {
    if (thrust <= 0) {
      this.inflow += (0 - this.inflow) * relax;
      return;
    }
    // Glauert: solve v·sqrt(Ve² + (Va + v)²) = T / (2ρA) for the induced velocity v with a few
    // Newton steps (a plain fixed-point iteration oscillates in hover), then relax toward it
    // because thrust itself depends on v.
    const k = thrust / (2 * rho * this.area);
    let v = Math.max(0.1, this.inflow > 0 ? this.inflow : Math.sqrt(k));
    for (let i = 0; i < 6; i++) {
      const s = Math.sqrt(vEdge * vEdge + (vAxial + v) ** 2) || 1e-6;
      const f = v * s - k;
      const df = s + (v * (vAxial + v)) / s;
      v = Math.max(0, v - f / Math.max(1e-6, df));
    }
    this.inflow += (Math.min(v, 60) - this.inflow) * relax;
  }

  step(ctx: StepContext): void {
    const d = this.def;
    // --- Inputs without a flight controller: throttle (or yaw for tail rotors) direct.
    if (!this.managed) {
      const src = d.inputs?.collective ?? 'throttle';
      this.command = src === 'yaw' ? 0.5 + 0.5 * ctx.controls.yaw : ctx.controls.throttle;
      if (d.cyclicDeg) {
        this.cyclicPitch = ctx.controls.pitch;
        this.cyclicRoll = ctx.controls.roll;
      }
    }
    const cmd = Math.min(1, Math.max(0, this.command));

    // --- Rotor speed: motors follow the command (thrust ∝ Ω², so Ω ∝ √thrust); governed
    //     helicopter rotors spin up to fixed speed once there is any throttle/collective input.
    const target =
      d.mode === 'rpm' ? Math.sqrt(cmd) * this.maxOmega : this.omega > 0 || cmd > 0.02 ? this.maxOmega : 0;
    const tau = d.spoolTime ?? (d.mode === 'rpm' ? 0.08 : 1.0);
    this.omega += (target - this.omega) * (1 - Math.exp(-ctx.dt / tau));
    this.angle = (this.angle + this.omega * ctx.dt * d.spin) % (Math.PI * 2);
    if (this.omega < 1) {
      this.thrust = this.torque = 0;
      return;
    }

    // --- Disk axis (part +Y), tilted by cyclic.
    const tilt = (d.cyclicDeg ?? 0) * DEG;
    _q.copy(this.localRotation);
    if (tilt > 0) _q.multiply(new THREE.Quaternion().setFromEuler(_e.set(this.cyclicPitch * tilt, 0, -this.cyclicRoll * tilt)));
    ctx.toWorldDir(_n.copy(UP).applyQuaternion(_q), _n);
    ctx.toWorldPoint(this.localPosition, _p);

    // --- Flow at the hub, relative to the air.
    ctx.airVelocity(_p, _v);
    const vAxial = _v.dot(_n); // + = moving along the thrust axis (climbing into the air)
    _edge.copy(_v).addScaledVector(_n, -vAxial);
    const vEdge = _edge.length();
    const rho = ctx.airDensity(_p.y);

    const theta = this.pitchAt(cmd);
    let res = this.integrate(rho, theta, vAxial, vEdge);
    this.updateInflow(res.thrust, rho, vAxial, vEdge, 0.35);
    res = this.integrate(rho, theta, vAxial, vEdge);
    this.updateInflow(res.thrust, rho, vAxial, vEdge, 0.35);
    this.thrust = res.thrust;
    this.torque = res.torque;

    // Thrust along the axis.
    _f.copy(_n).multiplyScalar(res.thrust);
    ctx.applyForce('thrust', _f, _p);
    // In-plane "H-force" drag in edgewise flight (blade profile drag + flapping back).
    if (vEdge > 0.5) {
      const tipSpeed = Math.max(1, this.omega * d.radius);
      const h = Math.abs(res.thrust) * 0.4 * (vEdge / tipSpeed) + 0.5 * rho * vEdge * vEdge * d.blades * d.chord * d.radius * SECTION_CD0;
      _f.copy(_edge).multiplyScalar(-h / vEdge);
      ctx.applyForce('drag', _f, _p);
    }
    // Reaction torque: the motor spins the rotor one way, the airframe is pushed the other.
    // spin +1 = counter-clockwise from above = rotation about +axis.
    _f.copy(_n).multiplyScalar(-d.spin * res.torque);
    ctx.applyTorque(_f);
    ctx.structuralLoad(this.partId, Math.abs(res.thrust));
  }
}
