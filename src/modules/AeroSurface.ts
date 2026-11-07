import * as THREE from 'three';
import type { AeroSurfaceDef } from '../craft/types.ts';
import { DEG, TUNING } from '../tuning.ts';
import type { ForceModule, StepContext } from './ForceModule.ts';

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _s = new THREE.Vector3();
const _air = new THREE.Vector3();
const _liftDir = new THREE.Vector3();
const _f = new THREE.Vector3();
const CHORD = new THREE.Vector3(0, 0, -1);
const NORMAL = new THREE.Vector3(0, 1, 0);
const SPAN = new THREE.Vector3(1, 0, 0);

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Lift and drag coefficients for a flat surface at angle of attack `alpha` (rad, any value).
 * Linear lift up to the stall angle, then a soft blend to flat-plate behaviour so lift sags
 * but never drops to zero. Exported for tests/tuning plots.
 */
export function liftDragCoefficients(
  alpha: number,
  liftSlope: number,
  stallAngle: number,
  cd0: number,
  aspectRatio: number,
): { cl: number; cd: number; stall: number } {
  // Wrap to (-pi, pi]
  const a = Math.atan2(Math.sin(alpha), Math.cos(alpha));
  const absA = Math.abs(a);
  const sign = Math.sign(a) || 1;
  const blend = TUNING.stallBlendDeg * DEG;

  // Flat plate lift is symmetric around 90 deg, sin(2a) handles reverse flow too.
  const plateCl = TUNING.postStallLiftFactor * Math.sin(2 * absA);

  let cl: number;
  let stall: number; // 0 = attached flow, 1 = fully stalled
  if (absA <= stallAngle) {
    cl = liftSlope * absA;
    stall = 0;
  } else {
    stall = smoothstep((absA - stallAngle) / blend);
    const peak = liftSlope * stallAngle;
    cl = peak + (plateCl - peak) * stall;
  }
  cl *= sign;

  // Induced drag only from attached-flow lift; stalled drag comes from the flat-plate term.
  const attachedCl = cl * (1 - stall);
  const induced = (attachedCl * attachedCl) / (Math.PI * TUNING.oswaldEfficiency * aspectRatio);
  const sinA = Math.sin(absA);
  const plateCd = TUNING.postStallDragFactor * sinA * sinA;
  const cd = cd0 + induced + plateCd * Math.max(stall, 0.15);
  return { cl, cd, stall };
}

/**
 * Per-surface lift and drag from local airflow. Airflow includes the angular-velocity
 * contribution at the surface point, so roll/pitch damping, adverse yaw from ailerons,
 * weathervaning etc. all fall out naturally.
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
  readonly def: AeroSurfaceDef;
  /** +1 if the surface's outer end is toward +X of its own frame (right side). */
  readonly outerSign: number;

  // Live state (read by the renderer / HUD)
  deflection = 0; // rad
  alpha = 0; // rad, effective incl. incidence (not incl. flap)
  stall = 0;
  liftMagnitude = 0;
  /** 0..1, how much ground effect is helping right now. */
  groundEffect = 0;

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
  }

  reset(): void {
    this.deflection = 0;
    this.alpha = 0;
    this.stall = 0;
    this.liftMagnitude = 0;
  }

  /** Craft-local surface normal (lift direction at zero AoA). */
  localNormal(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(NORMAL).applyQuaternion(this.localRotation);
  }

  step(ctx: StepContext): void {
    const ctrl = this.def.control;
    this.deflection = ctrl
      ? ctx.controls[ctrl.channel] * ctrl.gain * ctrl.maxDeflectionDeg * DEG
      : 0;

    ctx.toWorldPoint(this.localPosition, _p);
    ctx.airVelocity(_p, _v); // relative to the moving air: wind, gusts, turbulence
    _c.copy(CHORD).applyQuaternion(this.localRotation);
    ctx.toWorldDir(_c, _c);
    _n.copy(NORMAL).applyQuaternion(this.localRotation);
    ctx.toWorldDir(_n, _n);
    _s.copy(SPAN).applyQuaternion(this.localRotation);
    ctx.toWorldDir(_s, _s);

    // Only the chord-normal plane matters for a 2D section; spanwise flow is ignored.
    _v.addScaledVector(_s, -_v.dot(_s));
    const speed2 = _v.lengthSq();
    if (speed2 < TUNING.minAeroSpeed * TUNING.minAeroSpeed) {
      this.liftMagnitude = 0;
      this.stall = 0;
      return;
    }
    const speed = Math.sqrt(speed2);
    _air.copy(_v).multiplyScalar(-1 / speed); // direction the air moves past the surface

    const geomAlpha = Math.atan2(-_v.dot(_n), _v.dot(_c));
    this.alpha = geomAlpha + this.incidence;
    const flapAlpha = this.deflection * TUNING.controlEffectiveness;

    // Ground effect: within about a span of the ground the downwash is blocked, which acts like
    // a bigger aspect ratio (more lift slope, much less induced drag). McCormick's factor.
    let ar = this.aspectRatio;
    let slope = this.liftSlope;
    this.groundEffect = 0;
    if (TUNING.groundEffect > 0 && Math.abs(_n.y) > 0.5) {
      const h = _p.y - ctx.groundHeight(_p.x, _p.z);
      const span = this.def.chord * this.aspectRatio; // full-wing span, also for wing panels
      if (h > 0 && h < span) {
        const x = (16 * h) / span;
        const phi = Math.max(0.05, (x * x) / (1 + x * x)); // induced drag multiplier
        const blend = TUNING.groundEffect;
        ar = this.aspectRatio / (1 - blend + blend * phi);
        slope = (2 * Math.PI * ar) / (ar + 2);
        this.groundEffect = 1 - phi;
      }
    }

    const { cl, cd, stall } = liftDragCoefficients(
      this.alpha + flapAlpha,
      slope,
      this.stallAngle,
      this.cd0 + TUNING.controlDragFactor * this.deflection * this.deflection,
      ar,
    );
    this.stall = stall;

    const rho = ctx.airDensity(_p.y);
    const qS = 0.5 * rho * speed2 * this.area;

    // Lift is perpendicular to the airflow, in the chord/normal plane.
    _liftDir.crossVectors(_air, _s).normalize();
    let lift = cl * qS;
    let drag = cd * qS;
    const max = TUNING.maxAeroForce;
    lift = Math.max(-max, Math.min(max, lift));
    drag = Math.min(max, drag);
    this.liftMagnitude = lift;

    _f.copy(_liftDir).multiplyScalar(lift);
    ctx.applyForce('lift', _f, _p);
    _f.copy(_air).multiplyScalar(drag);
    ctx.applyForce('drag', _f, _p);
    // Bending load on the spar: mostly the normal force.
    ctx.structuralLoad(this.partId, Math.hypot(lift, drag * 0.3));
  }
}
