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

  // ---------------------------------------------------------------- wind
  /** Surface roughness length (m) for the log wind profile. Grass ≈ 0.03-0.1. */
  windRoughnessLength: 0.05,
  /** Cap on how much stronger than the 10 m reference the wind gets aloft. */
  windMaxProfile: 1.6,

  // ---------------------------------------------------------------- ground effect
  /**
   * Lifting surfaces within about one span of the ground get less induced drag and more lift
   * (the ground blocks the downwash). Set to 0 to disable.
   */
  groundEffect: 1,

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
  /**
   * Propeller reaction torque = thrust × prop radius × this. 0.11 gives ~420 N·m for a
   * 160 hp trainer at full power (it rolls/yaws left on takeoff, as real ones do).
   */
  propTorqueFactor: 0.11,
  /** P-factor: how far (fraction of prop radius) the thrust centre shifts in full crossflow. */
  pFactor: 0.25,
  /**
   * Default fuel burn (kg/s per newton of thrust at full power). Gameplay-accelerated about
   * 8x over reality so you notice fuel and CoM shift within a flight: 4000 N burns 0.1 kg/s.
   */
  fuelPerNewtonSecond: 2.5e-5,
  /** Turbofan thrust lapse with air density: T ∝ σ^this (σ = density / sea-level density). */
  turbofanDensityExponent: 0.7,
  /** Turbofan ram lapse: T ∝ 1 − this × M × (1 + BPR) / (1 + 0.1 × BPR). */
  turbofanMachLapse: 0.25,
  /** Turbofan TSFC (fuel per newton) rise with Mach: × (1 + this × M). */
  turbofanTsfcMach: 0.5,
  /** Throttle above which a turbofan's afterburner lights. */
  afterburnerThrottle: 0.95,
  /** Afterburner light-up / blow-out time constant (s). */
  afterburnerSpoolTime: 0.4,

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
  /** Dynamic hydroplaning speed on standing water (m/s): 9·√(30 psi) kt for light-aircraft tyres. */
  hydroplaneSpeed: 25,
  /** Nose-wheel steering is faded out between 0 m/s and this speed down to `steerHighSpeedFactor`. */
  steerFadeSpeed: 30,
  steerHighSpeedFactor: 0.25,

  // ---------------------------------------------------------------- structure
  /**
   * Default wing strength: a lifting surface breaks when its load exceeds this many g of its
   * area share of the craft's weight. The tail's downforce adds to wing load, so 10 here
   * breaks wings around 8 g of real load factor: forgiving, but yanking at high speed still hurts.
   */
  limitLoadFactor: 10,
  /** Default gear strength: each wheel can take this many g of the weight / wheel count. */
  gearLimitG: 5,
  /** Loads are low-pass filtered over this time (s) so a single noisy step can't snap a wing. */
  loadFilterTime: 0.05,

  // ---------------------------------------------------------------- impact damage
  /** Default part hit points: this many J per kg of part mass... */
  hpPerKg: 500,
  /** ...plus this many J per m³ of part volume. */
  hpPerCubicMetre: 2000,
  /**
   * Impacts are free up to the impulse of the whole craft stopping at this speed (m/s) on one
   * part: a 0.5 m drop (3.1 m/s) or a firm landing does nothing.
   */
  impactSafeSpeed: 4,
  /** Wheels, gear legs and skids take no impact damage up to the impulse of the craft arriving at this sink rate (m/s). */
  gearSinkLimit: 5,
  /** Contact impulses on a collider pair are summed over this window (s) into one impact. */
  impactWindow: 0.05,
  /** Contact force events start at this many times the craft's weight (per collider pair). */
  impactForceThreshold: 3,
  /** Above this speed (m/s) the craft body predicts contacts a step ahead (soft CCD). */
  softCcdMinSpeed: 30,
  /** Debris faster than this (m/s) gets continuous collision detection. */
  debrisCcdSpeed: 30,

  // ---------------------------------------------------------------- electrical
  /** Battery temperature at spawn and the air it cools into (°C). */
  batteryAmbientC: 20,
  /** Battery convective cooling time constant (s). */
  batteryCoolingTime: 600,
  /** A cell must sit below its Vmin under load this long (s) before the pack cuts off. */
  batteryCutoffDelay: 0.5,
  /**
   * Under-load cutoff per cell as a fraction of cellVmin (the empty resting voltage): 0.9 puts
   * a LiPo's at ~3.0 V, so hard climbs on a part-charged pack sag without tripping it.
   */
  batteryCutoffFraction: 0.9,
  /**
   * Generator regulator setpoint as a multiple of the battery's full open-circuit voltage: a
   * little above it, so the battery recharges and then floats at a trickle.
   */
  generatorRegulation: 1.02,
  /** Generator source resistance in regulation (Ω): how stiffly it holds the setpoint. */
  generatorResistance: 0.01,
  /** Avionics drop out below this fraction of the battery's full voltage. */
  avionicsMinVoltage: 0.7,
  /** Spike energy (J) that burns out a non-essential avionics box; essential ones take 4×. */
  avionicsSpikeTolerance: 2000,
  /** Fraction of a spike's energy that ends up as heat in the battery. */
  batterySpikeHeatFraction: 0.3,
  /** Spike energy (J) that doubles the battery's internal resistance (cell damage). */
  batterySpikeDamageJ: 50000,
  // ---------------------------------------------------------------- block buildings (src/world)
  /** Edge length of one building block (m). */
  blockSize: 3,
  /** Mass of one block (kg): a 3 m cube of floor slab, walls and contents (~110 kg/m³). */
  blockMass: 3000,
  /**
   * A block breaks when the contact impulse on it within one physics step exceeds this (N·s):
   * a 3 t block struck at ~3 m/s. A craft resting on a roof (or rubble lying on a block)
   * delivers a few hundred N·s per step; a wing hitting it at flying speed, tens of thousands.
   */
  blockBreakImpulse: 9000,
  /**
   * A falling chunk shatters (its blocks are destroyed) when one of its blocks takes an impulse
   * above blockMass × this speed (m/s) in one step: about a 2 m drop onto something hard.
   */
  chunkShatterSpeed: 6,
  /** Dynamic rubble caps: chunks and their colliders. Past them the oldest chunk is frozen in place. */
  maxDynamicChunks: 64,
  maxDynamicChunkColliders: 400,
  /** Frozen (settled) rubble kept in the world before the oldest is removed. */
  maxFrozenChunks: 96,
  maxFrozenChunkColliders: 2000,
  /** A chunk slower than this (m/s and rad/s) for `chunkSettleTime` s is frozen in place. */
  chunkSettleSpeed: 0.15,
  chunkSettleTime: 1,

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

/** Hazard simulation constants. Electrical coupling is a fraction of the strike energy. */
export const HAZARDS = {
  strikeIntervalMin: 5,
  strikeIntervalRange: 15,
  strikeRadius: 200,
  strikeEnergyMinJ: 12000,
  strikeEnergyRangeJ: 16000,
  electricalCoupling: 0.4,
  ignitionTemperature: 280,
  flameTemperature: 700,
  maximumTemperature: 1000,
  ambientTemperature: 20,
  coolingTime: 8,
  heatRate: 180,
  neighborHeatRate: 100,
  heatDamagePerDegree: 0.5,
  soundSpeed: 343,
} as const;
