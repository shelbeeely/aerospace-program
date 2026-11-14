import { Policy, type Feature } from '../brain/policy.ts';
import { fromJSON } from '../brain/net.ts';
import weights from '../brain/weights/drone.json' with { type: 'json' };

/**
 * The supply drone: a small delivery (a few units of stock) from the depot's pad to the
 * clinic's, over the channel, while the trucks take the long way round. Two policies:
 *
 * - **flight** (en route): fly straight at the waypoint, crab left or right into a crosswind,
 *   or slow down for the approach. The engine flies it (airspeed, wind drift, battery).
 * - **landing** (at the pad): land, hold, or divert to the shelter's pad. The engine decides
 *   whether the pad is free and keeps the battery honest.
 *
 * An agent switching policy as its job changes: flight on the way, landing at the end.
 */
export type FlightAction = 'straight' | 'crabLeft' | 'crabRight' | 'slow';
export const FLIGHT_ACTIONS: readonly FlightAction[] = ['straight', 'crabLeft', 'crabRight', 'slow'];
export type LandAction = 'land' | 'hold' | 'divert';
export const LAND_ACTIONS: readonly LandAction[] = ['land', 'hold', 'divert'];

export interface FlightObs {
  /** How far the wind would set its track off the line to the waypoint if it flew straight (rad, + to the right). */
  bearingErr: number;
  /** Distance to the waypoint (m), and whether it is the last one. */
  dist: number;
  last: number;
  /** Wind across its track (m/s, + pushes it to the left) and along it (+ tailwind). */
  cross: number;
  head: number;
  /** Its ground speed (m/s) and battery left (0..1). */
  speed: number;
  battery: number;
}

export interface LandObs {
  padBusy: number;
  battery: number;
  /** Distance to the pad (m), the wind's strength (m/s), and the alternative pad's distance (m). */
  dist: number;
  wind: number;
  altDist: number;
  /** How long it has held already (s). */
  held: number;
}

const FLIGHT_FEATURES: Feature[] = [
  { name: 'bearing error (rad)', scale: 0.5 },
  { name: 'distance (m)', scale: 200 },
  { name: 'last waypoint', scale: 1 },
  { name: 'crosswind (m/s)', scale: 5 },
  { name: 'headwind (m/s)', scale: 5 },
  { name: 'ground speed (m/s)', scale: 15 },
  { name: 'battery', scale: 1 },
];
const LAND_FEATURES: Feature[] = [
  { name: 'pad busy', scale: 1 },
  { name: 'battery', scale: 1 },
  { name: 'distance (m)', scale: 50 },
  { name: 'wind (m/s)', scale: 8 },
  { name: 'alternative pad (m)', scale: 600 },
  { name: 'held (s)', scale: 30 },
];

/** The scripted pilot: crab into a crosswind (or against a drift), slow for the last approach. */
export function scriptedFlight(o: FlightObs): FlightAction {
  if (o.last && o.dist < 50 && o.head > -5) return 'slow';
  if (o.cross > 1.5) return 'crabRight';
  if (o.cross < -1.5) return 'crabLeft';
  if (o.bearingErr < -0.15) return 'crabRight';
  if (o.bearingErr > 0.15) return 'crabLeft';
  return 'straight';
}

/** Can it still reach the other pad on what is left (with a margin)? */
export const canReachAlt = (o: LandObs): boolean => o.battery * 240 * 16 > o.altDist * 1.1;

/** The scripted lander: land on a free pad; divert while the other pad is in reach and holding grows costly; else hold. */
export function scriptedLanding(o: LandObs): LandAction {
  if (!o.padBusy) return 'land';
  if (canReachAlt(o) && (o.held > 40 || o.battery < 0.45)) return 'divert';
  return 'hold';
}

export const flightPolicy = new Policy<FlightObs, FlightAction>('flight', FLIGHT_FEATURES, FLIGHT_ACTIONS,
  (o) => [o.bearingErr, Math.min(o.dist, 800), o.last, o.cross, o.head, o.speed, o.battery], scriptedFlight, [10]);
export const landingPolicy = new Policy<LandObs, LandAction>('landing', LAND_FEATURES, LAND_ACTIONS,
  (o) => [o.padBusy, o.battery, Math.min(o.dist, 200), o.wind, Math.min(o.altDist, 1500), Math.min(o.held, 120)], scriptedLanding, [8]);

export function loadDroneWeights(w: unknown = weights): { flight: boolean; landing: boolean } {
  const o = (w ?? {}) as Record<string, unknown>;
  const f = fromJSON(o.flight), l = fromJSON(o.landing);
  flightPolicy.net = f && flightPolicy.fits(f) ? f : null;
  landingPolicy.net = l && landingPolicy.fits(l) ? l : null;
  return { flight: !!flightPolicy.net, landing: !!landingPolicy.net };
}
loadDroneWeights();

export const DRONE = {
  airspeed: 16,
  slow: 9,
  crab: 0.4,
  /** Battery (s of flight), what holding costs per second (of a second's flight). */
  battery: 240,
  holdCost: 0.7,
  payload: 3,
  /** Within this of the pad it decides how to land (m); landing takes this long (s). */
  approach: 25,
  landTime: 5,
} as const;

export type DroneState = 'idle' | 'flying' | 'holding' | 'landing' | 'delivered' | 'diverted' | 'lost';

export interface Drone {
  x: number;
  z: number;
  heading: number;
  battery: number;
  state: DroneState;
  /** Waypoints left (the last is the pad it is going to) and where it is going. */
  path: Array<{ x: number; z: number }>;
  to: 'clinic' | 'shelter';
  heldSince: number | null;
  landedAt: number;
  launchedAt: number;
  log: Array<{ t: number; text: string }>;
  decisions: Record<FlightAction | LandAction, number>;
}

/** Wind in the district at time t (m/s, x east, z south): a steady breeze with gusts. */
export function windAt(t: number, strength: number, seed: number): { x: number; z: number } {
  const g = 1 + 0.35 * Math.sin(t * 0.21 + seed) * Math.sin(t * 0.07 + seed * 2);
  const a = 0.6 + 0.2 * Math.sin(t * 0.013 + seed);
  return { x: Math.sin(a) * strength * g, z: Math.cos(a) * strength * g };
}
