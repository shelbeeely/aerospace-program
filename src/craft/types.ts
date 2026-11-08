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
export type ControlChannel = 'pitch' | 'roll' | 'yaw' | 'flaps';

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
  /**
   * Airfoil camber as a zero-lift angle shift (deg): cambered sections lift at zero angle of
   * attack. ~2 for a NACA 2412-like wing, 0 for symmetric tails and fins.
   */
  camberDeg?: number;
  /** Pitching-moment coefficient about the aerodynamic centre (negative = nose-down). Default -0.025 × camberDeg. */
  cm0?: number;
  /** Mach number where wave drag starts to rise (thinner sections: higher). Default 0.72. */
  criticalMach?: number;
  control?: ControlDef;
}

/**
 * Slender body (fuselage, pod, nacelle) along the part's -Z axis: axial drag, viscous crossflow
 * drag, and the destabilising Munk moment from potential flow that tail fins have to overcome.
 */
export interface BodyDef {
  type: 'body';
  offset?: Vec3Tuple;
  length: number;
  diameter: number;
  /** Axial drag coefficient on the frontal area. Default 0.2 (streamlined ~0.05-0.1, blunt ~0.5). */
  cdFront?: number;
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
  /** Visual propeller radius. Also sets the size of torque and P-factor effects. */
  propRadius?: number;
  /**
   * Propeller rotation seen from behind: 1 = clockwise (most single-engine planes), -1 =
   * counter-clockwise, 0 = no torque effects (e.g. a jet). Default 1 when propMaxSpeed is set.
   */
  propDirection?: 1 | -1 | 0;
  /** Fuel burn at full thrust (kg/s). Default scales with maxThrust (see tuning). */
  fuelFlow?: number;
  /**
   * Engine model. 'prop' (needs propMaxSpeed) or 'turbofan': thrust lapses with density
   * (σ^0.7) and with Mach (more for higher bypass ratios), and fuel per newton (TSFC) rises
   * with Mach. Omit for the legacy models: prop if propMaxSpeed is set, else flat jet thrust.
   */
  kind?: 'prop' | 'turbofan';
  /** Turbofan bypass ratio (0 = turbojet, ~0.3-1 fighters/trainers, 3-5 business jets). Default 1. */
  bypassRatio?: number;
  /**
   * Turbofan reheat: above 95% throttle, thrust × thrustRatio (~1.3-1.7) and fuel flow ×
   * fuelRatio (~3-5: afterburning is very thirsty).
   */
  afterburner?: { thrustRatio: number; fuelRatio: number };
}

/** Fuel carried in the part. Its mass moves the CoM as it burns. */
export interface FuelTankDef {
  type: 'fuel';
  offset?: Vec3Tuple;
  /** Capacity in kg. */
  capacity: number;
  /** Initial fill fraction 0..1 (default 1). */
  fill?: number;
}

/** Lifting gas cell (blimps, balloons): buoyancy = (air density - gas density) × volume × g. */
export interface BuoyancyDef {
  type: 'buoyancy';
  offset?: Vec3Tuple;
  /** Gas volume in m³. */
  volume: number;
  gas?: 'helium' | 'hydrogen' | 'hot-air';
}

/**
 * Blade-element rotor. Thrust along the part's +Y axis. Two control styles:
 * - 'rpm': fixed blade pitch, thrust controlled by motor speed (multirotor drones).
 * - 'collective': constant speed, thrust controlled by blade pitch, plus cyclic disk tilt
 *   (helicopters).
 */
export interface RotorDef {
  type: 'rotor';
  offset?: Vec3Tuple;
  radius: number;
  blades: number;
  /** Blade chord (m). */
  chord: number;
  /** Rotor speed at full command (rpm 'rpm' mode) or governed speed ('collective' mode). */
  maxRpm: number;
  mode: 'rpm' | 'collective';
  /** Blade pitch at the 3/4 radius station (deg): fixed for 'rpm', maximum for 'collective'. */
  pitchDeg: number;
  /** Lowest collective pitch (deg), 'collective' mode only. Default -2. */
  minPitchDeg?: number;
  /** Linear blade twist root to tip (deg, usually negative). Default -8. */
  twistDeg?: number;
  /** Spin seen from above: 1 = counter-clockwise, -1 = clockwise. Sets the reaction torque. */
  spin: 1 | -1;
  /** Max disk tilt from cyclic (deg), 'collective' mode only. Default 0 (no cyclic). */
  cyclicDeg?: number;
  /** Which input drives cyclic/collective. Tail rotors use { collective: 'yaw' }. */
  inputs?: { collective?: 'throttle' | 'yaw' };
  /** Motor/rotor speed time constant (s). Default 0.08 for 'rpm', 1.0 for 'collective'. */
  spoolTime?: number;
}

/**
 * Stability augmentation / flight computer. Reads the pilot's stick and the body's attitude
 * and rates, then drives the craft's rotors (and, in 'assist' mode, adds damping to stick
 * inputs for control surfaces). Without one, a multirotor is unflyable, as in real life.
 */
export interface FlightControllerDef {
  type: 'flightController';
  offset?: Vec3Tuple;
  /** 'multirotor': angle mode for drones; 'helicopter': rate damping + auto tail rotor. */
  mode: 'multirotor' | 'helicopter';
  /** Max tilt the stick commands (deg). Default 30. */
  maxTiltDeg?: number;
  /** Max yaw rate the stick commands (deg/s). Default 120. */
  maxYawRateDeg?: number;
  /** Proportional/derivative gains for attitude (defaults are tuned for small drones). */
  gains?: { attitude?: number; rate?: number; yaw?: number };
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

export type ModuleDef =
  | AeroSurfaceDef
  | EngineDef
  | WheelDef
  | DragDef
  | BodyDef
  | FuelTankDef
  | BuoyancyDef
  | RotorDef
  | FlightControllerDef;

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
  /**
   * Structural strength: the load (N) the part's modules can put on it before it breaks off.
   * Omit for a sensible default (lifting surfaces ~8 g of their share of the weight, gear ~5 g).
   * Use 0 for unbreakable.
   */
  strength?: number;
  /**
   * Impact hit points (J of impact energy above tolerance). Omit for a default from the part's
   * mass and volume. Use 0 for indestructible.
   */
  hp?: number;
}

export interface CraftDef {
  name: string;
  formatVersion: 1;
  parts: PartDef[];
}
