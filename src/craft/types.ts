/**
 * Serializable craft format. This is pure data (JSON-compatible) so the Stage 2 hangar can
 * save/load craft as a part graph. Nothing in here references three.js or Rapier.
 *
 * Craft-local axes: +X = right, +Y = up, -Z = forward (nose points toward -Z).
 */

export type Vec3Tuple = [number, number, number];

export type ShapeDef =
  | { type: 'box'; size: Vec3Tuple }
  | { type: 'cylinder'; radius: number; length: number; axis?: 'x' | 'y' | 'z' }
  | { type: 'sphere'; radius: number };

/** Which pilot input channel a control surface (or steering) responds to. */
export type ControlChannel = 'pitch' | 'roll' | 'yaw';

export interface ControlDef {
  channel: ControlChannel;
  /** Max flap deflection in degrees. */
  maxDeflectionDeg: number;
  /**
   * +1 or -1. Channel value * gain * maxDeflection = deflection. Positive deflection increases
   * the surface's effective angle of attack (pushes along the surface normal).
   */
  gain: number;
  /** Fraction of chord that is the moving flap (visual + drag only). Default 0.3. */
  chordFraction?: number;
  /** Fraction of span covered by the flap, measured from the outer end. Default 1. */
  spanFraction?: number;
}

/**
 * A flat lifting surface. Its local frame (relative to the part) is:
 * chord = -Z (leading edge forward), normal = +Y (lift side), span = +X.
 */
export interface AeroSurfaceDef {
  type: 'aero';
  /** Aerodynamic centre (quarter chord) relative to the part origin. */
  offset?: Vec3Tuple;
  span: number;
  chord: number;
  /** Override the aspect ratio used for the lift slope / induced drag (e.g. for half-wings). */
  aspectRatio?: number;
  /** Built-in incidence (deg) added to the angle of attack. */
  incidenceDeg?: number;
  cd0?: number;
  stallAngleDeg?: number;
  control?: ControlDef;
}

/** Thrust along the part's forward (-Z) axis. */
export interface EngineDef {
  type: 'engine';
  offset?: Vec3Tuple;
  /** Static (zero airspeed) thrust at sea level, N. */
  maxThrust: number;
  /** Airspeed (m/s) at which a propeller's thrust has fallen to zero. Omit for a jet (flat thrust). */
  propMaxSpeed?: number;
  spoolTime?: number;
  /** Visual propeller radius. */
  propRadius?: number;
}

/** Raycast suspension wheel. `offset` is the suspension mount (top of travel). */
export interface WheelDef {
  type: 'wheel';
  offset?: Vec3Tuple;
  radius: number;
  /** Suspension travel (m). */
  restLength: number;
  /** Spring stiffness N/m. */
  stiffness: number;
  /** Damper N/(m/s). */
  damping: number;
  /** Max steering angle (deg), driven by the yaw channel. */
  maxSteerDeg?: number;
  brakes?: boolean;
}

/** Simple quadratic drag blob (fuselage, gear legs...). */
export interface DragDef {
  type: 'drag';
  offset?: Vec3Tuple;
  /** Cd * reference area (m^2). */
  cdA: number;
}

export type ModuleDef = AeroSurfaceDef | EngineDef | WheelDef | DragDef;

export interface PartDef {
  id: string;
  /** Part kind (what the hangar would call it). Free text for now. */
  kind: string;
  mass: number;
  position: Vec3Tuple;
  /** Euler XYZ in degrees. */
  rotationDeg?: Vec3Tuple;
  shape: ShapeDef;
  /** Defaults to true. Set false for parts that shouldn't collide (e.g. landing gear legs). */
  collider?: boolean;
  color: string;
  modules?: ModuleDef[];
}

export interface CraftDef {
  name: string;
  formatVersion: 1;
  parts: PartDef[];
}
