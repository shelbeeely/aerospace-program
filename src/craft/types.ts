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
  | { type: 'sphere'; radius: number }
  /**
   * Cone along an axis (nose cones, nozzles, intakes, spikes): base `radius`, `length` tip to
   * base, centred on the part position. The tip points to the axis's negative end by default
   * (a 'z' cone is a forward-pointing nose); `tip: 1` points it the other way.
   */
  | { type: 'cone'; radius: number; length: number; axis?: 'x' | 'y' | 'z'; tip?: 1 | -1 }
  /** Capsule: a cylinder with hemispherical ends (rounded fuselages, pods, tanks); `length` is overall. */
  | { type: 'capsule'; radius: number; length: number; axis?: 'x' | 'y' | 'z' };

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
   * Engine model. 'turbojet' is a turbofan with no bypass (keeps thrust to higher Mach, thirstier).
   * 'ramjet': no static thrust; works from ~Mach 0.5, best Mach 2.5-4, fades by Mach 6 (needs a
   * booster to get going). 'scramjet': works from ~Mach 4, best Mach 6-9, fades by Mach 12.
   * 'solid': a solid booster: full thrust from ignition (throttle past half) for burnTime,
   * no throttling, no shut-down, own propellant (include it in the part's mass).
   * 'prop' (needs propMaxSpeed) or 'turbofan': thrust lapses with density
   * (σ^0.7) and with Mach (more for higher bypass ratios), and fuel per newton (TSFC) rises
   * with Mach. 'rocket': carries its own oxidiser, so thrust ignores air density (full thrust in
   * vacuum) and propellant flow is maxThrust / (isp · g0). Omit for the legacy models: prop if
   * propMaxSpeed is set, else flat jet thrust.
   */
  kind?: 'prop' | 'turbofan' | 'turbojet' | 'rocket' | 'ramjet' | 'scramjet' | 'solid';
  /**
   * Thrust vectoring: the nozzle swivels up to this many degrees, steered by the pitch and yaw
   * stick (the tilt is chosen from the engine's position about the CoM, so it always turns the
   * craft the way the stick asks). Rockets and fast jets; works with no airflow.
   */
  gimbalDeg?: number;
  /** Solid booster: burn time (s) at full thrust once lit (default 20). It cannot be throttled or shut down. */
  burnTime?: number;
  /** Rocket specific impulse (s): ~250-320 kerosene/solid, ~450 hydrogen. Default 300. */
  isp?: number;
  /**
   * Reaction-control thrusters fed from the craft's tanks: up to this torque (N·m) per axis from
   * the pitch/roll/yaw stick. Rate-command (centred stick holds the attitude still), full
   * authority in near-vacuum, fading out as dynamic pressure builds and the surfaces take over.
   */
  rcsTorque?: number;
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
  /** Driven wheel: the throttle pushes it along the ground with up to this force (N). */
  drive?: number;
  /**
   * Skid steering (tanks): the side the wheel is on, +1 right, -1 left. The yaw channel then
   * drives the two sides in opposite directions (with `drive`), so the craft turns in place.
   */
  skid?: 1 | -1;
  brakes?: boolean;
}

/**
 * A weapon fitted to the part, firing from `offset` along the part's forward (-Z) axis (bomb bays
 * drop downward). Fit as many as you like: two cannons, four gun pods, missile rails under each
 * wing, several bomb bays. The part's mass must cover the weapon and its rounds.
 */
export interface WeaponModuleDef {
  type: 'weapon';
  offset?: Vec3Tuple;
  /** gun, cannon, missile (rail), bomb (bay), laser (beam), disc (identity disc launcher), pulse (bolt emitter). */
  kind: 'gun' | 'cannon' | 'bomb' | 'missile' | 'laser' | 'disc' | 'pulse';
  /** Rounds (bombs, missiles, discs...) it carries. Default per kind. */
  ammo?: number;
}

/** Airbrake / speed brake: panels that open into the airflow with the brake input. */
export interface AirbrakeDef {
  type: 'airbrake';
  offset?: Vec3Tuple;
  /** Panel area (m²) facing the flow when fully open. */
  area: number;
  /** Drag coefficient of the open panels (default 1.2). */
  cd?: number;
}

/** Drag chute: one-shot, deploys on the brake at speed, cut away when slow. */
export interface ChuteDef {
  type: 'chute';
  /** Where it's packed (usually the tail); it streams behind from there. */
  offset?: Vec3Tuple;
  /** Cd × canopy area (m²): ~10-40 for a jet, 2-6 for a ground racer. */
  cdA: number;
  /** Deploys when the brake is pulled above this speed (m/s, default 15). */
  deploySpeed?: number;
  /** Faster than this (m/s, default 120) it won't open (and tears off at 1.3×). */
  maxSpeed?: number;
  /** Cut away below this speed (m/s, default 8). */
  cutSpeed?: number;
}

/** Simple quadratic drag blob (fuselage, gear legs...). */
export interface DragDef {
  type: 'drag';
  offset?: Vec3Tuple;
  /** Cd * reference area (m^2). */
  cdA: number;
}

/**
 * Rechargeable battery pack (LiPo, lead-acid...). Open-circuit voltage follows the state of
 * charge between cellVmin (empty) and cellVmax (full); under load the terminal voltage sags
 * by I·R and the pack heats by I²R. It disconnects (protection cutoff) when it is empty, when a
 * cell's terminal voltage sags below cellVmin under load (with a small margin, see
 * TUNING.batteryCutoffFraction), or when it overheats. Mass belongs to the part.
 */
export interface BatteryDef {
  type: 'battery';
  offset?: Vec3Tuple;
  /** Cells in series (e.g. 12 for a 12S LiPo, 12 for a 24 V lead-acid). */
  cells: number;
  capacityAh: number;
  /** Internal resistance per cell (Ω). LiPo ~0.002-0.01, lead-acid ~0.003-0.01. */
  cellResistance: number;
  /** Cell open-circuit voltage full / empty (LiPo 4.2 / 3.3, lead-acid 2.13 / 1.85). */
  cellVmax: number;
  cellVmin: number;
  /** Heat capacity of the pack (J/K), ≈ 1000 × pack kg. Default from capacity and voltage. */
  thermalMass?: number;
  /** Over-temperature cutoff (°C). Default 70. */
  maxTempC?: number;
  /** Initial state of charge 0..1. Default 1. */
  soc?: number;
}

/**
 * Brushless motor driving the rotor on the same part, powered from the craft's battery bus.
 * Kt = 60/(2π·kv) N·m/A; at full throttle I = (V − ω/Kv)/R, clipped to maxCurrent; τ = Kt·I.
 */
export interface MotorDef {
  type: 'motor';
  offset?: Vec3Tuple;
  /** Speed constant (rpm per volt, no load). */
  kv: number;
  /** Winding resistance (Ω). */
  rWinding: number;
  /** Current limit (ESC/motor), A. */
  maxCurrent: number;
}

/** Engine-driven generator/alternator: charges the battery and runs the bus once the engine turns. */
export interface GeneratorDef {
  type: 'generator';
  offset?: Vec3Tuple;
  /** Rated output current (A). */
  ratedAmps: number;
  /** Engine spool (0..1) below which it gives nothing; full output 0.15 above it. Default 0.05. */
  minRpmFraction?: number;
}

/**
 * Electrical load: instruments, radios, flight computer, lights. Non-essential loads are shed
 * automatically when no generator is online, so the battery keeps the essentials running.
 */
export interface AvionicsDef {
  type: 'avionics';
  offset?: Vec3Tuple;
  loadW: number;
  /** Essential bus (flight instruments, flight controller). Default true. */
  essential?: boolean;
}

/** Gyro stabiliser: keeps a two-wheel craft upright, leaning into turns (light cycles). */
export interface StabilizerDef {
  type: 'stabilizer';
  offset?: Vec3Tuple;
  /** Roll stiffness (N·m per radian of error). ~10× the craft mass is a good start. */
  strength: number;
}

/** Where the craft lays down a light trail. */
export interface TrailDef {
  type: 'trail';
  offset?: Vec3Tuple;
  /** 'wall': a light cycle's jetwall / light ribbon (from the ground up to `height`); 'contrail': a thin energy path. */
  kind: 'wall' | 'contrail';
  /** Wall height (m) or contrail width (m). */
  height: number;
  color: string;
}

export type ModuleDef =
  | WeaponModuleDef
  | AirbrakeDef
  | ChuteDef
  | AeroSurfaceDef
  | EngineDef
  | WheelDef
  | DragDef
  | BodyDef
  | FuelTankDef
  | BuoyancyDef
  | RotorDef
  | FlightControllerDef
  | BatteryDef
  | MotorDef
  | GeneratorDef
  | AvionicsDef
  | StabilizerDef
  | TrailDef;

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
  /** Reinforcement level 0-3: each level adds 60% strength, 80% impact HP and voxel toughness, and 15% of the part's mass. */
  reinforce?: number;
}

export interface CraftDef {
  name: string;
  formatVersion: 1;
  parts: PartDef[];
  /** Armour multiplier on structural strength, impact HP and crash tolerance (default 1; the tank is 4). */
  armor?: number;
  /** Heavy vehicle that bulldozes through buildings it drives into (the tank). */
  bulldozer?: boolean;
  /** Default weapons loadout (see sim/weapons.ts); omitted = unarmed until one is chosen. */
  loadout?: string;
}
