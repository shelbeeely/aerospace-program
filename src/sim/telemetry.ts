import type { ElectricalTelemetry } from '../craft/ElectricalSystem.ts';
import { PLANET } from './layout.ts';

/** Keplerian orbit of the craft around the planet (two-body, from its current state). */
export interface OrbitTelemetry {
  /** Highest point above sea level (m), or null on an escape trajectory. */
  apoapsis: number | null;
  /** Lowest point above sea level (m); negative = the orbit dips into the planet (suborbital). */
  periapsis: number;
  /** Speed relative to the planet's centre (m/s). */
  speed: number;
  /** Orbital period (s), or null on an escape trajectory. */
  period: number | null;
}

/**
 * Orbit elements from the local flat-frame state: r = R + h, radial speed = vertical speed,
 * tangential speed = horizontal speed. μ = g0·R² (surface gravity × radius²).
 */
export function orbitElements(altitude: number, verticalSpeed: number, horizontalSpeed: number): OrbitTelemetry {
  const R = PLANET.radius;
  const mu = PLANET.gravity * R * R;
  const r = R + Math.max(-R * 0.99, altitude);
  const v2 = verticalSpeed * verticalSpeed + horizontalSpeed * horizontalSpeed;
  const energy = v2 / 2 - mu / r;
  const h = r * horizontalSpeed; // specific angular momentum
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (mu * mu)));
  const speed = Math.sqrt(v2);
  if (energy >= 0) {
    // Parabolic/hyperbolic: periapsis from h² / (μ(1 + e)).
    return { apoapsis: null, periapsis: (h * h) / (mu * (1 + e)) - R, speed, period: null };
  }
  const a = -mu / (2 * energy);
  return { apoapsis: a * (1 + e) - R, periapsis: a * (1 - e) - R, speed, period: 2 * Math.PI * Math.sqrt((a * a * a) / mu) };
}

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
  /** Remaining impact hit points (0..1) of each attached, destructible part. */
  partHp?: Record<string, number>;
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
    /** 0..1 deepest any tyre is into dynamic hydroplaning. */
    aquaplaning: number;
  };
  /** 0..1 how deep any rotor is in vortex ring state. */
  vortexRing: number;
  /** Orbit around the planet from the current position and velocity. */
  orbit?: OrbitTelemetry;
  /** Electrical bus (battery, generator, avionics), or null/absent if the craft has none. */
  electrical?: ElectricalTelemetry | null;
}
