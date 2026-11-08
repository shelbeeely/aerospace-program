import * as THREE from 'three';
import type { RotorDef } from '../craft/types.ts';
import { DEG, TUNING } from '../tuning.ts';
import { liftDragCoefficients } from './AeroSurface.ts';
import type { ForceModule, StepContext } from './ForceModule.ts';

const STATIONS = 8;
const SECTION_LIFT_SLOPE = 5.7; // per rad, typical rotor airfoil
const SECTION_STALL = 14 * DEG;
const SECTION_CD0 = 0.011;
const ICE_DENSITY = 917;
/** Effective blade material density (kg/m³) over a 12%-thick section: solid props, and
 *  helicopter blades whose spar + tip weights make them heavy for their size. */
const BLADE_DENSITY = { rpm: 900, collective: 2000 } as const;

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _edge = new THREE.Vector3();
const _f = new THREE.Vector3();
const _vg = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _h = new THREE.Vector3();
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
 *
 * On top of that:
 * - Motor/engine: the rotor has inertia and is driven by a torque-limited motor (BLDC: torque
 *   falls with rpm) or a power-limited governed engine. Whatever the airflow demands beyond that
 *   costs rpm, so a heavy, iced or rain-soaked rotor runs out of headroom. The airframe feels the
 *   motor torque, so spin-up/spin-down yaws a quad. Unpowered rotors windmill (autorotation).
 * - Rain: the water film on small, low-Reynolds-number blades costs lift and stall margin and
 *   raises profile drag; blades sweeping through drops need extra torque; drops hitting the disk
 *   push it down.
 * - Icing in supercooled cloud: rime builds fastest on thin, fast blades (minus kinetic heating
 *   near the tip), wrecking the section; centrifugal force sheds it once it is thick enough.
 * - Ground effect (Cheeseman–Bennett) cuts induced inflow near the ground.
 * - Vortex ring state: descending into your own wake at ~0.3-1.5× the hover induced speed with
 *   little forward speed loses thrust and makes it fluctuate.
 * - Gyroscopic precession of the spinning rotor (rigid props fully, hinged rotors barely).
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
  /** Ice thickness on the blade leading edges (m). */
  ice = 0;
  /** 0..1 how deep in vortex ring state; ground effect inflow reduction 0..1. */
  vortexRing = 0;
  groundEffect = 0;
  /** Torque the motor is delivering now (N·m) and its limit at the current rpm. */
  motorTorque = 0;
  motorLimit = 0;
  /** Rotor polar moment of inertia (kg·m²). */
  readonly inertia: number;
  /** Section degradation from rain/ice for the current step. */
  private sec = { lift: 1, stall: 1, cd: 1 };
  private rainTorque = 0;
  private ref: { thrust: number; torque: number } | null = null;
  private vrsTime = 0;
  /** Horizontal distances to neighbouring parallel rotors, and to the rotor group's centre. */
  private neighbours: number[] = [];
  private bodyDistance = 0;
  private readonly vrsPhase: number;

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
    const bladeMass = BLADE_DENSITY[def.mode] * def.chord * 0.12 * def.chord * def.radius;
    this.inertia = (def.blades * bladeMass * def.radius * def.radius) / 3;
    let h = 0;
    for (let i = 0; i < partId.length; i++) h = (h * 31 + partId.charCodeAt(i)) % 1000;
    this.vrsPhase = h * 0.0123;
  }

  /** Find parallel rotors in roughly the same plane (multirotor ground effect). */
  link(modules: readonly ForceModule[]): void {
    const axis = _n.copy(UP).applyQuaternion(this.localRotation);
    const group: Rotor[] = [];
    for (const m of modules) {
      if (!(m instanceof Rotor)) continue;
      const a = _v.copy(UP).applyQuaternion(m.localRotation);
      if (a.dot(axis) > 0.9 && Math.abs(m.localPosition.y - this.localPosition.y) < this.def.radius) group.push(m);
    }
    this.neighbours = group
      .filter((m) => m !== this)
      .map((m) => Math.hypot(m.localPosition.x - this.localPosition.x, m.localPosition.z - this.localPosition.z));
    if (group.length >= 3) {
      let cx = 0;
      let cz = 0;
      for (const m of group) {
        cx += m.localPosition.x / group.length;
        cz += m.localPosition.z / group.length;
      }
      this.bodyDistance = Math.hypot(this.localPosition.x - cx, this.localPosition.z - cz);
    } else this.bodyDistance = 0;
  }

  /** Mass of ice on the blades (kg). */
  get iceMass(): number {
    return this.ice * this.def.blades * this.def.radius * this.def.chord * 0.3 * 2 * ICE_DENSITY;
  }

  reset(): void {
    this.command = 0;
    this.cyclicPitch = this.cyclicRoll = 0;
    this.omega = 0;
    this.inflow = 0;
    this.thrust = 0;
    this.torque = 0;
    this.ice = 0;
    this.vortexRing = this.groundEffect = 0;
    this.motorTorque = 0;
  }

  /** Static sea-level thrust at full command (N), for design analysis / mixers. */
  staticThrust(): number {
    return this.reference().thrust;
  }

  /** Clean sea-level static thrust and torque at full command (cached): sizes the motor. */
  private reference(): { thrust: number; torque: number } {
    if (this.ref) return this.ref;
    const save = { omega: this.omega, inflow: this.inflow, sec: this.sec, g: this.groundEffect };
    this.omega = this.maxOmega;
    this.inflow = 0;
    this.sec = { lift: 1, stall: 1, cd: 1 };
    this.groundEffect = 0;
    let r = { thrust: 0, torque: 0 };
    for (let i = 0; i < 40; i++) {
      r = this.integrate(TUNING.seaLevelDensity, this.pitchAt(1), 0, 0);
      this.updateInflow(r.thrust, TUNING.seaLevelDensity, 0, 0, 0.5);
    }
    Object.assign(this, save);
    this.ref = { thrust: r.thrust, torque: Math.max(1e-3, r.torque) };
    return this.ref;
  }

  /**
   * Torque available at rotor speed ω. Electric motor (rpm mode): linear torque-speed line,
   * sized so it can just hold max rpm with 15% margin in clean sea-level air, with plenty of
   * torque at lower rpm for fast control. Governed engine: constant power (25% margin),
   * torque-limited at low rpm.
   */
  private availableTorque(omega: number): number {
    const q = this.reference().torque;
    if (this.def.mode === 'rpm') {
      const noLoad = 1.25 * this.maxOmega;
      return Math.max(0, 5.75 * q * (1 - omega / noLoad));
    }
    return Math.min(3 * q, (1.25 * q * this.maxOmega) / Math.max(1, omega));
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
      const sec = this.sec;
      const { cl, cd } = liftDragCoefficients(
        theta - phi,
        SECTION_LIFT_SLOPE * sec.lift,
        SECTION_STALL * sec.stall,
        SECTION_CD0 * sec.cd,
        1e6,
      );
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
    // Ground effect: the ground blocks the wake, so less inflow is needed for the same thrust.
    this.inflow += (Math.min(v, 60) * (1 - this.groundEffect) - this.inflow) * relax;
  }

  /** Rain film and ice on the blades -> section lift slope, stall angle and drag factors. */
  private updateSection(ctx: StepContext, rho: number, rainRate: number, isRain: boolean, waterContent: number): void {
    const d = this.def;
    const air = ctx.air(_p.y);
    const v75 = this.omega * 0.75 * d.radius;
    const re = Math.max(1e4, (v75 * d.chord) / air.kinematicViscosity);
    const lowRe = Math.min(1.8, Math.max(0.8, Math.pow(1e6 / re, 0.15)));
    const rain = isRain ? Math.min(1.5, rainRate / 100) : 0;
    const iceRatio = this.ice / d.chord;
    const iceStall = Math.min(0.45, 0.25 * (1 - Math.exp(-iceRatio / 0.002)) + 15 * iceRatio);
    this.sec = {
      lift: (1 - 0.08 * rain * lowRe) * (1 - Math.min(0.35, 5 * iceRatio)),
      stall: (1 - 0.12 * rain * lowRe) * (1 - iceStall),
      cd: (1 + 0.5 * rain * lowRe) * (1 + Math.min(4, 300 * iceRatio)),
    };
    // Blades sweep through the drops and fling them to blade speed: D = ρw·t·(Ωr)² per unit
    // span, torque ∫ D·r dr = ρw·t·Ω²·R⁴/4 per blade (t ≈ 12% chord frontal thickness).
    this.rainTorque = waterContent * 0.12 * d.chord * d.blades * (this.omega * this.omega * d.radius ** 4) * 0.25;
    void rho;
  }

  /** Rime/glaze ice on the blades in supercooled cloud; kinetic heating near the tip. */
  private updateIce(ctx: StepContext, temperatureK: number): void {
    const d = this.def;
    const v75 = this.omega * 0.75 * d.radius;
    // Stagnation (recovery) heating: ~0.85·V²/(2cp).
    const tc = temperatureK - 273.15 + (0.85 * v75 * v75) / 2010;
    if (tc < 0) {
      const cloud = ctx.cloud(_p);
      if (cloud.inCloud && cloud.liquidWater > 0) {
        const e = Math.min(1, Math.max(0.15, 0.35 / Math.sqrt(d.chord)));
        const freeze = Math.min(1, -tc / 10);
        this.ice = Math.min(0.03, this.ice + ((e * cloud.liquidWater * v75 * freeze) / ICE_DENSITY) * ctx.dt);
      }
    } else if (this.ice > 0) {
      this.ice = Math.max(0, this.ice - tc * 2e-6 * ctx.dt * (1 + v75 / 30));
    }
    // Centrifugal shedding: when the ice's outward pull beats its adhesion, most of it flies off.
    if (this.ice > 0 && ICE_DENSITY * this.ice * this.omega * this.omega * 0.75 * d.radius > 4e5) this.ice *= 0.3;
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

    // --- Rotor speed. Motors follow the command (thrust ∝ Ω², so Ω ∝ √thrust); governed
    //     helicopter rotors spin up to fixed speed once there is any throttle/collective input.
    //     The speed controller asks for the torque that would get there with time constant τ,
    //     limited by what the motor/engine can give; the rotor then accelerates by
    //     (motor − aerodynamic − rain) torque / inertia.
    const target =
      d.mode === 'rpm' ? Math.sqrt(cmd) * this.maxOmega : this.omega > 0 || cmd > 0.02 ? this.maxOmega : 0;
    const tau = d.spoolTime ?? (d.mode === 'rpm' ? 0.08 : 1.0);
    const load = this.torque + this.rainTorque;
    this.motorLimit = target > 0 ? this.availableTorque(this.omega) : 0;
    const want = (this.inertia * (target - this.omega)) / tau + load;
    // ESCs brake actively (rpm mode); a governed engine can only drive (freewheel unit).
    const floor = d.mode === 'rpm' && target > 0 ? -0.5 * this.motorLimit : 0;
    this.motorTorque = Math.min(this.motorLimit, Math.max(floor, want));
    const omegaPrev = this.omega;
    this.omega += ((this.motorTorque - load) / this.inertia) * ctx.dt;
    // Unpowered and slow: friction stops it (avoids creeping forever).
    if (target === 0 && this.omega < 5) this.omega *= Math.exp(-ctx.dt / 0.5);
    this.omega = Math.min(1.15 * this.maxOmega, Math.max(0, this.omega));
    this.angle = (this.angle + this.omega * ctx.dt * d.spin) % (Math.PI * 2);

    // --- Disk axis (part +Y), tilted by cyclic.
    const tilt = (d.cyclicDeg ?? 0) * DEG;
    _q.copy(this.localRotation);
    if (tilt > 0) _q.multiply(new THREE.Quaternion().setFromEuler(_e.set(this.cyclicPitch * tilt, 0, -this.cyclicRoll * tilt)));
    ctx.toWorldDir(_n.copy(UP).applyQuaternion(_q), _n);
    ctx.toWorldPoint(this.localPosition, _p);

    // Reaction torque on the airframe: whatever the motor delivers, opposite to the spin
    // (spin +1 = counter-clockwise from above = rotation about +axis). Includes spin-up kick.
    _f.copy(_n).multiplyScalar(-d.spin * this.motorTorque);
    ctx.applyTorque(_f);

    // Gyroscopic precession: turning the spinning rotor's angular momentum H needs torque
    // ω×H from the airframe, which feels H×ω. Hinged/teetering rotors pass little of it on.
    const rigid = d.mode === 'rpm' ? 1 : 0.05;
    _h.copy(_n).multiplyScalar(rigid * this.inertia * omegaPrev * d.spin);
    ctx.applyTorque(_f.crossVectors(_h, ctx.angvel));

    if (this.omega < 1) {
      this.thrust = this.torque = this.rainTorque = 0;
      this.vortexRing = 0;
      return;
    }

    // --- Flow at the hub, relative to the air.
    ctx.airVelocity(_p, _v);
    const vAxial = _v.dot(_n); // + = moving along the thrust axis (climbing into the air)
    _edge.copy(_v).addScaledVector(_n, -vAxial);
    const vEdge = _edge.length();
    const air = ctx.air(_p.y);
    const rho = air.density;

    // --- Weather on the blades.
    const precip = ctx.precipitation(_p);
    this.updateIce(ctx, air.temperature);
    this.updateSection(ctx, rho, precip.rate, precip.kind === 'rain', precip.waterContent);

    // --- Ground effect (Cheeseman–Bennett): T_IGE/T_OGE = 1/(1 − (R/4z)²), fading with
    //     forward speed; applied as reduced inflow. z along the axis for tilted disks.
    //     Multirotors get more: the neighbours' wakes and the fountain rising under the body
    //     add 0.5·R²z/(s²+4z²)^1.5 per neighbour at distance s and 2R²z/(b²+4z²)^1.5 for the
    //     body at distance b (Sanchez-Cuevas et al. 2017, measured on quadrotors).
    this.groundEffect = 0;
    if (_n.y > 0.5) {
      const z = (_p.y - ctx.groundHeight(_p.x, _p.z)) / _n.y;
      if (z > 0) {
        const vi = Math.max(0.5, this.inflow);
        const zz = Math.max(z, 0.5 * d.radius);
        const R2 = d.radius * d.radius;
        let k = (d.radius / (4 * zz)) ** 2;
        for (const sd of this.neighbours) k += (0.5 * R2 * zz) / (sd * sd + 4 * zz * zz) ** 1.5;
        if (this.bodyDistance > 0) k += (2 * R2 * zz) / (this.bodyDistance ** 2 + 4 * zz * zz) ** 1.5;
        k /= 1 + (vEdge / vi) ** 2;
        this.groundEffect = Math.min(0.3, k);
      }
    }

    const theta = this.pitchAt(cmd);
    let res = this.integrate(rho, theta, vAxial, vEdge);
    this.updateInflow(res.thrust, rho, vAxial, vEdge, 0.35);
    res = this.integrate(rho, theta, vAxial, vEdge);
    this.updateInflow(res.thrust, rho, vAxial, vEdge, 0.35);

    // --- Vortex ring state: descending at 0.3-1.5 v_h with little edgewise speed, the rotor
    //     sits in its own recirculating wake. Thrust drops ~30% and surges at a few Hz
    //     (different phase per rotor, so a multirotor rocks).
    const vh = Math.sqrt(Math.max(0, res.thrust) / (2 * rho * this.area));
    let vrs = 0;
    if (vh > 0.5 && vAxial < 0) {
      const x = -vAxial / vh;
      const band = Math.max(0, 1 - ((x - 0.85) / 0.6) ** 2);
      const edge = Math.max(0, 1 - vEdge / (1.2 * vh)) ** 2;
      vrs = band * edge;
    }
    this.vortexRing += (vrs - this.vortexRing) * (1 - Math.exp(-ctx.dt / 0.6));
    if (this.vortexRing > 0.01) {
      this.vrsTime += ctx.dt;
      const t = this.vrsTime + this.vrsPhase;
      const surge = 0.6 * Math.sin(2 * Math.PI * 2.1 * t) + 0.4 * Math.sin(2 * Math.PI * 3.7 * t + 1.3);
      res = { thrust: res.thrust * (1 - this.vortexRing * (0.3 + 0.15 * surge)), torque: res.torque };
    }

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
    // Rain hitting the disk: drops pass through the swept disk and give up their momentum.
    if (precip.waterContent > 0) {
      ctx.pointVelocity(_p, _vg);
      _rel.copy(precip.velocity).sub(_vg);
      const flux = precip.waterContent * Math.abs(_rel.dot(_n)) * this.area; // kg/s
      ctx.applyForce('drag', _f.copy(_rel).multiplyScalar(flux), _p);
    }
    ctx.structuralLoad(this.partId, Math.abs(res.thrust));
  }
}
