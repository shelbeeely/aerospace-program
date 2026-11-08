/**
 * A plain, JSON-serializable snapshot of the craft's flight state. This is what the HUD shows
 * and what a future AI/LLM pilot would receive as its observation.
 */
export interface Telemetry {
  /** Simulation time (s). */
  time: number;
  position: [number, number, number];
  velocity: [number, number, number];
  /** Airspeed (m/s), relative to the moving air. */
  airspeed: number;
  /** Horizontal speed over the ground (m/s). */
  groundSpeed: number;
  /** Wind at the craft (m/s, world: +X east, -Z north, +Y up). */
  wind: [number, number, number];
  /** Height above ground (m). */
  altitude: number;
  /** m/s, positive up. */
  verticalSpeed: number;
  /** Compass heading, deg. 0 = -Z ("north"), 90 = +X ("east"). */
  heading: number;
  /** Nose pitch above horizon, deg. */
  pitch: number;
  /** Bank angle, deg, positive = right wing down. */
  roll: number;
  /** Angle of attack, deg. */
  angleOfAttack: number;
  /** Sideslip, deg, positive = air coming from the right. */
  sideslip: number;
  /** Load factor along the craft's up axis, in g (1 = level flight). */
  gForce: number;
  /** Commanded throttle 0..1 and actual engine spool 0..1. */
  throttle: number;
  engineSpool: number;
  /** Fuel remaining 0..1, or null if the craft has no tanks. */
  fuel: number | null;
  onGround: boolean;
  /** Ids of parts that have broken off. */
  brokenParts: string[];
  /** 0..1, how stalled the main wings are. */
  stall: number;
  /** Current control inputs actually applied. */
  controls: { pitch: number; roll: number; yaw: number; throttle: number; brake: number; flaps?: number };
  /** Mach number (airspeed / local speed of sound). */
  mach: number;
  /** Outside air temperature (°C). */
  oat: number;
  /** Density altitude (m): how high the air "feels" to wings and engines. */
  densityAltitude: number;
  /** Weather at the craft. */
  weather: {
    /** Precipitation rate mm/h and kind. */
    precipitation: number;
    precipitationKind: 'none' | 'rain' | 'snow';
    inCloud: boolean;
    /** Max ice thickness on any surface/rotor (mm). */
    iceMm: number;
    /** Water clinging to the airframe (kg). */
    waterKg: number;
    /** Runway wetness 0..1. */
    groundWetness: number;
  };
}
