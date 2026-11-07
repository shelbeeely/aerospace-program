/**
 * All feel-related physics constants live here. Tweak freely.
 *
 * Units: SI everywhere (metres, kilograms, seconds, newtons, radians unless a
 * name ends in `Deg`).
 */

export const TUNING = {
  // ---------------------------------------------------------------- simulation
  /** Physics rate. 120 Hz keeps stiff suspension springs stable. */
  physicsHz: 120,
  /** Max physics steps per rendered frame. Prevents the "spiral of death" when a tab stalls. */
  maxStepsPerFrame: 8,
  /** Gravity (m/s^2, pointing down). */
  gravity: 9.81,

  // ---------------------------------------------------------------- atmosphere
  /** Sea-level air density (kg/m^3). */
  seaLevelDensity: 1.225,
  /** Scale height of the exponential density falloff (m). rho = rho0 * exp(-h / H). */
  densityScaleHeight: 8500,

  // ---------------------------------------------------------------- aerodynamics
  /** Oswald efficiency factor used for induced drag: CDi = CL^2 / (pi * e * AR). */
  oswaldEfficiency: 0.8,
  /** Default angle at which the linear lift curve stops (stall onset). */
  stallAngleDeg: 15,
  /**
   * Width of the soft-stall blend (deg). Past `stallAngleDeg` lift smoothly blends from the
   * peak value to the flat-plate curve over this many degrees, so lift sags but never hits zero.
   */
  stallBlendDeg: 10,
  /** Flat-plate lift coefficient amplitude after stall: CL = k * sin(2*alpha). */
  postStallLiftFactor: 0.85,
  /** Flat-plate drag after stall: CD = k * sin^2(alpha) (blended in through the stall). */
  postStallDragFactor: 1.3,
  /** Default zero-lift (parasitic) drag coefficient of a lifting surface. */
  surfaceCd0: 0.02,
  /**
   * Control surface effectiveness: how many degrees of effective angle of attack one degree of
   * flap deflection adds. ~0.5 for a 30% chord flap.
   */
  controlEffectiveness: 0.55,
  /** Extra drag coefficient per radian^2 of control deflection. */
  controlDragFactor: 0.15,
  /** Below this airspeed (m/s) at a surface, aero forces are skipped (avoids noise / NaN). */
  minAeroSpeed: 0.5,
  /** Hard cap on any single aero force (N). Safety net against blow-ups on violent crashes. */
  maxAeroForce: 200_000,

  // ---------------------------------------------------------------- engine
  /** Time constant (s) of engine spool-up/down. Bigger = laggier throttle response. */
  engineSpoolTime: 0.6,

  // ---------------------------------------------------------------- wheels
  /**
   * Friction "relaxation time" (s): how quickly tyre friction kills sliding velocity.
   * Smaller = grippier, but too small can jitter. Must stay well above the physics dt.
   */
  tyreRelaxationTime: 0.06,
  /** Tyre lateral friction coefficient (sideways grip). */
  tyreLateralFriction: 0.9,
  /** Rolling resistance coefficient (fraction of load) when not braking. */
  rollingResistance: 0.02,
  /** Brake friction coefficient (fraction of load) at full brake. */
  brakeFriction: 0.7,
  /** Nose-wheel steering is faded out between 0 m/s and this speed down to `steerHighSpeedFactor`. */
  steerFadeSpeed: 30,
  steerHighSpeedFactor: 0.25,

  // ---------------------------------------------------------------- rigid body
  /** Tiny angular damping so a craft at rest settles. Real damping comes from aero. */
  angularDamping: 0.05,
  linearDamping: 0.0,
  /** Friction of the airframe colliders when sliding on the ground after a crash. */
  airframeFriction: 0.6,
  airframeRestitution: 0.1,
  /** If the body ever exceeds these, it's considered exploded and is reset. */
  maxSaneSpeed: 2000,
  maxSaneAngularSpeed: 200,

  // ---------------------------------------------------------------- input
  /** How fast smoothed stick inputs approach the raw input (1/s). Higher = snappier. */
  inputSmoothing: 10,
  /** Throttle change per second while holding Shift/Ctrl. */
  throttleRate: 0.6,
  /** Trim change per second while holding a trim key. */
  trimRate: 0.25,
  /** Gamepad stick dead zone. */
  gamepadDeadzone: 0.12,
} as const;

export const DEG = Math.PI / 180;
