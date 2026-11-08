import * as THREE from 'three';
import type { FlightControllerDef } from '../craft/types.ts';
import { DEG, TUNING } from '../tuning.ts';
import type { ForceModule, StepContext } from './ForceModule.ts';
import { Rotor } from './Rotor.ts';

const _inv = new THREE.Quaternion();
const _w = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface MixEntry {
  rotor: Rotor;
  roll: number;
  pitch: number;
  yaw: number;
}

/**
 * Flight computer: turns the pilot's stick into rotor commands while stabilising attitude.
 * The mixer is built automatically from each rotor's position (relative to the centre of mass)
 * and spin direction, so any layout the Designer comes up with gets mixed correctly.
 *
 * - multirotor: angle mode. Stick = target bank/pitch, yaw stick = target yaw rate,
 *   throttle 0.5 ≈ hover (scaled from the craft's weight vs. rotor thrust).
 * - helicopter: rate damping + gentle self-levelling on the cyclic, and a yaw-rate loop on the
 *   tail rotor that cancels main-rotor torque automatically.
 */
export class FlightController implements ForceModule {
  readonly type = 'flightController';
  readonly localRotation = new THREE.Quaternion();
  readonly localPosition: THREE.Vector3;
  readonly def: FlightControllerDef;

  private mix: MixEntry[] = [];
  private mainRotors: Rotor[] = [];
  private tailRotors: Rotor[] = [];
  private tailSigns: number[] = [];
  /** Thrust fraction needed to hover (multirotor), estimated at link time. */
  hoverFraction = 0.5;
  private yawIntegral = 0;
  private massKg = 1;
  /** Set by the craft's ElectricalSystem each step. Unpowered, it commands nothing. */
  powered = true;

  constructor(
    readonly partId: string,
    def: FlightControllerDef,
    position: THREE.Vector3,
  ) {
    this.def = def;
    this.localPosition = position;
  }

  /** Called by the craft with its modules, CoM and mass whenever the layout changes. */
  link(modules: readonly ForceModule[], com?: THREE.Vector3, mass?: number): void {
    const rotors = modules.filter((m): m is Rotor => m instanceof Rotor);
    for (const r of rotors) r.managed = true;
    const c = com ?? new THREE.Vector3();
    this.massKg = mass ?? this.massKg;
    if (this.def.mode === 'multirotor') {
      const lift = rotors.filter((r) => r.def.mode === 'rpm');
      let maxArm = 1e-3;
      for (const r of lift) maxArm = Math.max(maxArm, Math.hypot(r.localPosition.x - c.x, r.localPosition.z - c.z));
      this.mix = lift.map((r) => ({
        rotor: r,
        // Roll right: more thrust on the left (x < CoM). Pitch up: more thrust in front (z < CoM).
        roll: -(r.localPosition.x - c.x) / maxArm,
        pitch: -(r.localPosition.z - c.z) / maxArm,
        // Yaw right needs body torque about -Y; a counter-clockwise (spin +1) rotor gives that.
        yaw: r.def.spin,
      }));
      const totalThrust = lift.reduce((s, r) => s + r.staticThrust(), 0);
      this.hoverFraction = totalThrust > 0 ? clamp((this.massKg * TUNING.gravity) / totalThrust, 0.05, 0.95) : 0.5;
    } else {
      this.mainRotors = rotors.filter((r) => (r.def.cyclicDeg ?? 0) > 0 || r.def.inputs?.collective !== 'yaw');
      this.tailRotors = rotors.filter((r) => r.def.inputs?.collective === 'yaw');
      // Which way does more tail-rotor thrust yaw the craft? +1 = yaw left (torque about +Y).
      this.tailSigns = this.tailRotors.map((r) => {
        const arm = r.localPosition.clone().sub(c);
        const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(r.localRotation);
        return Math.sign(arm.cross(axis).y) || 1;
      });
    }
  }

  reset(): void {
    this.yawIntegral = 0;
    this.powered = true;
  }

  step(ctx: StepContext): void {
    if (!this.powered) {
      // Dead flight computer: every rotor it drives gets no command (motors stop, governed
      // rotors are left to windmill).
      for (const m of this.mix) m.rotor.command = 0;
      for (const r of this.mainRotors) {
        r.command = 0;
        r.cyclicPitch = r.cyclicRoll = 0;
      }
      for (const r of this.tailRotors) r.command = 0;
      this.yawIntegral = 0;
      return;
    }
    const c = ctx.controls;
    // Attitude from the body rotation (same conventions as telemetry).
    _fwd.set(0, 0, -1).applyQuaternion(ctx.rotation);
    _up.set(0, 1, 0).applyQuaternion(ctx.rotation);
    _right.set(1, 0, 0).applyQuaternion(ctx.rotation);
    const pitch = Math.asin(clamp(_fwd.y, -1, 1)); // + nose up
    const roll = Math.atan2(-_right.y, _up.y); // + right wing down
    // Body rates: +x = pitch up, -z = roll right, -y = yaw right.
    _inv.copy(ctx.rotation).invert();
    _w.copy(ctx.angvel).applyQuaternion(_inv);
    const pitchRate = _w.x;
    const rollRate = -_w.z;
    const yawRate = -_w.y;

    const g = this.def.gains ?? {};
    const maxTilt = (this.def.maxTiltDeg ?? 30) * DEG;
    const maxYaw = (this.def.maxYawRateDeg ?? 120) * DEG;
    const yawErr = c.yaw * maxYaw - yawRate;

    if (this.def.mode === 'multirotor') {
      const kp = g.attitude ?? 1.4;
      const kd = g.rate ?? 0.35;
      const ky = g.yaw ?? 0.4;
      const rollCmd = kp * (c.roll * maxTilt - roll) - kd * rollRate;
      const pitchCmd = kp * (c.pitch * maxTilt - pitch) - kd * pitchRate;
      this.yawIntegral = clamp(this.yawIntegral + yawErr * ctx.dt * 0.5, -0.3, 0.3);
      const yawCmd = ky * yawErr + this.yawIntegral;
      // Throttle 0..1 with 0.5 = hover, compensated for tilt so turns don't sink.
      const h = this.hoverFraction;
      let collective = c.throttle < 0.5 ? c.throttle * 2 * h : h + (c.throttle - 0.5) * 2 * (1 - h);
      collective /= Math.max(0.6, Math.cos(roll) * Math.cos(pitch));
      for (const m of this.mix) {
        m.rotor.command = clamp(collective + rollCmd * m.roll * 0.5 + pitchCmd * m.pitch * 0.5 + yawCmd * m.yaw * 0.25, 0, 1);
      }
    } else {
      // Helicopter: angle mode on the cyclic (stick = target attitude, centred = level), so it
      // is forgiving like a trainer's stabiliser. Disk tilt also moves the craft, so attitude
      // and translation stay coupled as in a real helicopter.
      const kp = g.attitude ?? 2.2;
      const kd = g.rate ?? 0.7;
      const tilt = (this.def.maxTiltDeg ?? 20) * DEG;
      const cycPitch = clamp(kp * (c.pitch * tilt - pitch) - kd * pitchRate, -1, 1);
      const cycRoll = clamp(kp * (c.roll * tilt - roll) - kd * rollRate, -1, 1);
      for (const r of this.mainRotors) {
        r.command = c.throttle;
        r.cyclicPitch = cycPitch;
        r.cyclicRoll = cycRoll;
      }
      // Tail rotor: PI on yaw rate. The integral learns the anti-torque needed for the
      // current main-rotor power.
      const ky = g.yaw ?? 1.2;
      this.yawIntegral = clamp(this.yawIntegral - yawErr * ctx.dt * 1.5, -0.5, 0.5);
      this.tailRotors.forEach((r, i) => {
        const s = this.tailSigns[i];
        r.command = clamp(0.5 + s * (this.yawIntegral - ky * yawErr * 0.5), 0, 1);
      });
    }
  }
}
