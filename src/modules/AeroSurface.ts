import * as THREE from 'three';
import type { AeroSurfaceDef } from '../craft/types.ts';
import { DEG, TUNING } from '../tuning.ts';
import type { ForceModule, StepContext } from './ForceModule.ts';

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _vg = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _s = new THREE.Vector3();
const _air = new THREE.Vector3();
const _liftDir = new THREE.Vector3();
const _f = new THREE.Vector3();
const _rel = new THREE.Vector3();
const CHORD = new THREE.Vector3(0, 0, -1);
const NORMAL = new THREE.Vector3(0, 1, 0);
const SPAN = new THREE.Vector3(1, 0, 0);
const HISTORY = 160; // steps of lift history kept for downwash transport delay (~1.3 s)
const ICE_DENSITY = 917;

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** How stalled the section wants to be at this angle of attack (0 attached .. 1 separated). */
export function stallTarget(alpha: number, stallAngle: number): number {
  const a = Math.abs(Math.atan2(Math.sin(alpha), Math.cos(alpha)));
  return a <= stallAngle ? 0 : smoothstep((a - stallAngle) / (TUNING.stallBlendDeg * DEG));
}

/**
 * Lift and drag coefficients for a section at angle of attack `alpha` (rad, any value).
 * Linear lift up to the stall angle, then a blend to flat-plate behaviour so lift sags but never
 * drops to zero. `stallState` (0..1) overrides the instantaneous separation amount, which is how
 * dynamic stall lag is applied. Exported for tests and the rotor's blade elements.
 */
export function liftDragCoefficients(
  alpha: number,
  liftSlope: number,
  stallAngle: number,
  cd0: number,
  aspectRatio: number,
  stallState?: number,
): { cl: number; cd: number; stall: number } {
  const a = Math.atan2(Math.sin(alpha), Math.cos(alpha));
  const absA = Math.abs(a);
  const sign = Math.sign(a) || 1;
  const plateCl = TUNING.postStallLiftFactor * Math.sin(2 * absA);
  const stall = stallState ?? stallTarget(a, stallAngle);
  // Attached-flow lift keeps rising past the static stall angle while separation lags.
  const attached = liftSlope * Math.min(absA, stallAngle * (1 + 0.6 * (1 - stall)));
  const cl = sign * (attached + (plateCl - attached) * stall);
  const attachedCl = cl * (1 - stall);
  const induced = (attachedCl * attachedCl) / (Math.PI * TUNING.oswaldEfficiency * aspectRatio);
  const sinA = Math.sin(absA);
  const plateCd = TUNING.postStallDragFactor * sinA * sinA;
  const cd = cd0 + induced + plateCd * Math.max(stall, 0.15);
  return { cl, cd, stall };
}

interface Upstream {
  src: AeroSurface;
  weight: number;
  dz: number;
}

/**
 * Per-surface lift and drag from local airflow, with the effects that make real wings behave:
 * - Airflow includes body rotation, wind/gusts/thermals (ctx.airVelocity).
 * - Compressibility: Prandtl-Glauert lift slope 1/√(1-M²), wave drag above critical Mach.
 * - Reynolds number: skin friction and max lift fall off for small/slow surfaces.
 * - Dynamic stall: separation lags the angle of attack (convective time c/V), and reattaches
 *   more slowly than it separates (hysteresis).
 * - Camber (zero-lift angle) and pitching moment Cm0; trailing-edge flaps/controls.
 * - Downwash from surfaces ahead, delayed by the time the air takes to travel back.
 * - Ground effect (McCormick).
 * - Rain: water film roughness costs max lift and raises drag (NASA rain tunnel data), worse at
 *   low Reynolds number; rain momentum. Icing in supercooled cloud: ice builds on the leading
 *   edge (thin sections collect more), wrecks max lift, adds drag and mass; melts when warm.
 */
export class AeroSurface implements ForceModule {
  readonly type = 'aero';
  readonly localPosition: THREE.Vector3;
  readonly localRotation: THREE.Quaternion;
  readonly area: number;
  readonly aspectRatio: number;
  readonly liftSlope: number;
  readonly stallAngle: number;
  readonly cd0: number;
  readonly incidence: number;
  readonly camber: number;
  readonly cm0: number;
  readonly def: AeroSurfaceDef;
  /** +1 if the surface's outer end is toward +X of its own frame (right side). */
  readonly outerSign: number;

  // Live state (renderer / HUD / telemetry)
  deflection = 0; // rad
  alpha = 0; // rad, incl. incidence and downwash (not flap)
  stall = 0; // lagged separation 0..1
  cl = 0;
  liftMagnitude = 0;
  groundEffect = 0; // 0..1
  downwash = 0; // rad received from surfaces ahead
  mach = 0;
  reynolds = 0;
  /** Ice thickness on the leading edge (m). */
  ice = 0;

  private upstream: Upstream[] = [];
  /** dε/dα this surface sees from the surfaces ahead (for neutral-point estimates). */
  downwashGradient = 0;
  private readonly epsHistory = new Float32Array(HISTORY);
  private histIndex = 0;

  constructor(
    readonly partId: string,
    def: AeroSurfaceDef,
    position: THREE.Vector3,
    rotation: THREE.Quaternion,
    outerSign: number,
  ) {
    this.def = def;
    this.localPosition = position;
    this.localRotation = rotation;
    this.outerSign = outerSign;
    this.area = def.span * def.chord;
    this.aspectRatio = def.aspectRatio ?? (def.span * def.span) / this.area;
    // Finite-wing lift slope (Helmbold-ish simplification of lifting-line theory).
    this.liftSlope = (2 * Math.PI * this.aspectRatio) / (this.aspectRatio + 2);
    this.stallAngle = (def.stallAngleDeg ?? TUNING.stallAngleDeg) * DEG;
    this.cd0 = def.cd0 ?? TUNING.surfaceCd0;
    this.incidence = (def.incidenceDeg ?? 0) * DEG;
    this.camber = (def.camberDeg ?? 0) * DEG;
    this.cm0 = def.cm0 ?? -0.025 * (def.camberDeg ?? 0);
  }

  /** Craft-local surface normal (lift direction at zero AoA). */
  localNormal(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(NORMAL).applyQuaternion(this.localRotation);
  }

  get isHorizontal(): boolean {
    return Math.abs(this.localNormal(_n).y) > 0.7;
  }

  /** Full span of the wing this surface belongs to (panels use the whole-wing aspect ratio). */
  get fullSpan(): number {
    return this.def.chord * this.aspectRatio;
  }

  /** Mass of accreted ice (kg): leading-edge band ~30% of the chord, both surfaces. */
  get iceMass(): number {
    return this.ice * this.area * 0.3 * 2 * ICE_DENSITY;
  }

  /** Find the horizontal surfaces ahead whose downwash reaches this one. */
  link(modules: readonly unknown[]): void {
    this.upstream = [];
    this.downwashGradient = 0;
    if (!this.isHorizontal) return;
    const sources = modules.filter((m): m is AeroSurface => m instanceof AeroSurface && m !== this && m.isHorizontal);
    const qualifying: Upstream[] = [];
    let total = 0;
    for (const src of sources) {
      const dz = this.localPosition.z - src.localPosition.z; // +z is aft
      const span = src.fullSpan;
      if (dz < Math.max(0.5, src.def.chord * 0.75)) continue;
      if (Math.abs(this.localPosition.x - src.localPosition.x) > span * 0.6) continue;
      const dy = this.localPosition.y - src.localPosition.y;
      if (Math.abs(dy) > span * 0.4) continue;
      // Vertical offset from the wake reduces the downwash felt.
      const w = src.area / (1 + (dy / (0.12 * span)) ** 2);
      qualifying.push({ src, weight: w, dz });
      total += src.area;
    }
    for (const q of qualifying) {
      q.weight /= total;
      // Far-field downwash ≈ 1.7 × CL/(πAR) at a typical tail position.
      this.downwashGradient += q.weight * ((1.7 * q.src.liftSlope) / (Math.PI * q.src.aspectRatio));
    }
    this.upstream = qualifying;
  }

  reset(): void {
    this.deflection = 0;
    this.alpha = 0;
    this.stall = 0;
    this.cl = 0;
    this.liftMagnitude = 0;
    this.downwash = 0;
    this.ice = 0;
    this.epsHistory.fill(0);
  }

  /** Downwash angle this surface produced `stepsAgo` steps ago. */
  private epsAt(stepsAgo: number): number {
    const i = (this.histIndex - 1 - Math.min(HISTORY - 1, Math.max(0, stepsAgo)) + HISTORY * 2) % HISTORY;
    return this.epsHistory[i];
  }

  step(ctx: StepContext): void {
    const ctrl = this.def.control;
    const input = ctrl ? (ctx.controls[ctrl.channel] ?? 0) : 0;
    this.deflection = ctrl ? input * (ctrl.channel === 'flaps' ? 1 : ctrl.gain) * ctrl.maxDeflectionDeg * DEG : 0;

    ctx.toWorldPoint(this.localPosition, _p);
    ctx.pointVelocity(_p, _vg); // ground-relative (for rain impact)
    ctx.airVelocity(_p, _v); // relative to the moving air: wind, gusts, thermals
    ctx.toWorldDir(_c.copy(CHORD).applyQuaternion(this.localRotation), _c);
    ctx.toWorldDir(_n.copy(NORMAL).applyQuaternion(this.localRotation), _n);
    ctx.toWorldDir(_s.copy(SPAN).applyQuaternion(this.localRotation), _s);

    const air = ctx.air(_p.y);
    this.updateIce(ctx, air.temperature, _v.length());

    // Only the chord-normal plane matters for a 2D section; spanwise flow is ignored.
    _v.addScaledVector(_s, -_v.dot(_s));
    const speed2 = _v.lengthSq();
    if (speed2 < TUNING.minAeroSpeed * TUNING.minAeroSpeed) {
      this.liftMagnitude = 0;
      this.cl = 0;
      this.stall += (0 - this.stall) * 0.05;
      this.pushEps(0);
      return;
    }
    const speed = Math.sqrt(speed2);
    _air.copy(_v).multiplyScalar(-1 / speed); // direction the air moves past the surface

    // Downwash from surfaces ahead, each delayed by its transport time dz / V.
    let eps = 0;
    for (const u of this.upstream) eps += u.weight * u.src.epsAt(Math.round(u.dz / (speed * ctx.dt)));
    this.downwash = eps;

    const geomAlpha = Math.atan2(-_v.dot(_n), _v.dot(_c));
    this.alpha = geomAlpha + this.incidence - eps;
    const flapAlpha = this.deflection * TUNING.controlEffectiveness;

    // --- Reynolds and Mach
    const chord = this.def.chord;
    this.reynolds = (speed * chord) / air.kinematicViscosity;
    const re = Math.max(1e4, this.reynolds);
    const reDrag = Math.min(2.5, Math.max(0.75, Math.pow(3e6 / re, 0.2)));
    const reStall = Math.min(1.05, Math.max(0.8, 1 + 0.06 * Math.log10(re / 3e6)));
    this.mach = speed / air.speedOfSound;
    const pg = 1 / Math.sqrt(1 - Math.min(this.mach, 0.9) ** 2);
    const mcrit = this.def.criticalMach ?? 0.72;
    const wave = this.mach > mcrit ? 20 * (this.mach - mcrit) ** 4 + (this.mach > 1 ? 0.06 : 0) : 0;

    // --- Rain and ice degrade the section (more so for small, low-Re surfaces)
    const precip = ctx.precipitation(_p);
    const rain = precip.kind === 'rain' ? Math.min(1.5, precip.rate / 100) : 0;
    const lowRe = Math.min(1.8, Math.max(0.8, Math.pow(1e6 / re, 0.15)));
    const iceRatio = this.ice / chord;
    const iceStall = Math.min(0.45, 0.25 * (1 - Math.exp(-iceRatio / 0.002)) + 15 * iceRatio);
    const stallAngle = this.stallAngle * reStall * (1 - 0.12 * rain * lowRe) * (1 - iceStall);
    const roughCd = this.cd0 * reDrag * (1 + 0.5 * rain * lowRe) * (1 + Math.min(4, 300 * iceRatio));
    const liftLoss = 1 - 0.08 * rain * lowRe;

    // --- Ground effect: within about a span of the ground the downwash is blocked (McCormick).
    let ar = this.aspectRatio;
    let slope = this.liftSlope;
    this.groundEffect = 0;
    if (TUNING.groundEffect > 0 && Math.abs(_n.y) > 0.5) {
      const h = _p.y - ctx.groundHeight(_p.x, _p.z);
      const span = this.fullSpan;
      if (h > 0 && h < span) {
        const x = (16 * h) / span;
        const phi = Math.max(0.05, (x * x) / (1 + x * x));
        const blend = TUNING.groundEffect;
        ar = this.aspectRatio / (1 - blend + blend * phi);
        slope = (2 * Math.PI * ar) / (ar + 2);
        this.groundEffect = 1 - phi;
      }
    }
    slope *= pg * liftLoss;

    // --- Dynamic stall: separation follows the target with a convective-time lag.
    const totalAlpha = this.alpha + this.camber + flapAlpha;
    const target = stallTarget(totalAlpha, stallAngle);
    const convective = chord / speed;
    const tau = (target > this.stall ? 2 : 6) * convective; // reattachment is slower
    this.stall += (target - this.stall) * (1 - Math.exp(-ctx.dt / Math.max(1e-3, tau)));

    const { cl, cd } = liftDragCoefficients(
      totalAlpha,
      slope,
      stallAngle,
      roughCd + wave + TUNING.controlDragFactor * this.deflection * this.deflection,
      ar,
      this.stall,
    );
    this.cl = cl;
    // Record our downwash for surfaces behind us: ε ≈ 1.7·CL/(πAR) (far-field ≈ 2·CL/(πAR)).
    this.pushEps(this.isHorizontal ? (1.7 * cl * (1 - this.stall * 0.5)) / (Math.PI * this.aspectRatio) : 0);

    const qS = 0.5 * air.density * speed2 * this.area;
    _liftDir.crossVectors(_air, _s).normalize();
    const max = TUNING.maxAeroForce;
    const lift = Math.max(-max, Math.min(max, cl * qS));
    const drag = Math.min(max, cd * qS);
    this.liftMagnitude = lift;
    _f.copy(_liftDir).multiplyScalar(lift);
    ctx.applyForce('lift', _f, _p);
    _f.copy(_air).multiplyScalar(drag);
    ctx.applyForce('drag', _f, _p);

    // Pitching moment about the aerodynamic centre (camber, flaps): M = Cm·q·S·c about the span axis.
    const cm = (this.cm0 - 0.4 * flapAlpha * (this.def.control?.chordFraction ?? 0.3)) * (1 - this.stall * 0.5);
    if (cm !== 0) ctx.applyTorque(_f.copy(_s).multiplyScalar(cm * qS * chord));

    // Rain momentum: water hitting the surface at the drop-relative velocity.
    if (precip.waterContent > 0) {
      _rel.copy(precip.velocity).sub(_vg);
      const flux = precip.waterContent * Math.abs(_rel.dot(_n)) * this.area; // kg/s
      ctx.applyForce('drag', _f.copy(_rel).multiplyScalar(flux), _p);
    }

    // Bending load on the spar: mostly the normal force.
    ctx.structuralLoad(this.partId, Math.hypot(lift, drag * 0.3));
  }

  private pushEps(eps: number): void {
    this.epsHistory[this.histIndex] = eps;
    this.histIndex = (this.histIndex + 1) % HISTORY;
  }

  /** Ice accretion in supercooled cloud (rime/glaze), melting above freezing. */
  private updateIce(ctx: StepContext, temperatureK: number, speed: number): void {
    const tc = temperatureK - 273.15;
    if (tc < 0) {
      const cloud = ctx.cloud(_p);
      if (cloud.inCloud && cloud.liquidWater > 0) {
        // Collection efficiency: thin leading edges catch more droplets.
        const e = Math.min(1, Math.max(0.15, 0.35 / Math.sqrt(this.def.chord)));
        // Fraction that freezes falls off near 0 °C (glaze runs back), max below about -10 °C.
        const freeze = Math.min(1, -tc / 10);
        this.ice = Math.min(0.03, this.ice + ((e * cloud.liquidWater * speed * freeze) / ICE_DENSITY) * ctx.dt);
      }
    } else if (this.ice > 0) {
      this.ice = Math.max(0, this.ice - tc * 2e-6 * ctx.dt * (1 + speed / 30));
    }
  }
}
