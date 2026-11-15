import { Policy, type Feature } from '../brain/policy.ts';
import { fromJSON, type Net } from '../brain/net.ts';
import weights from '../brain/weights/civil.json' with { type: 'json' };

/**
 * The road traffic's policy (src/sim/traffic.ts): what a rider wants to do between the
 * intersections. One network per stock ground vehicle type (a tank and a light cycle need not
 * drive alike); every type shares the inputs, the actions and the scripted teacher, which is the
 * traffic as it always rode plus one new courtesy: give a reckless player room.
 *
 * - follow: ride its lane at its own speed.
 * - pass: pull out to pass a slower rider (the engine judges the gap, as it always did).
 * - keepRight: drift back to the outer lane when there is room.
 * - giveRoom: a fast, reckless player coming up behind: ease off and move over.
 * - turnAway: take the next turn away from the player.
 *
 * The network decides; the engine carries it out and keeps the rules: signals, give-way, no
 * entering a crossing it cannot leave, the lane-change gap checks, jetwalls, closed roads. A
 * network that asks for something unsafe simply does not get it.
 */
export type RiderAction = 'follow' | 'pass' | 'keepRight' | 'giveRoom' | 'turnAway';
export const RIDER_ACTIONS: readonly RiderAction[] = ['follow', 'pass', 'keepRight', 'giveRoom', 'turnAway'];

/** The stock ground vehicles (src/craft/builtins.ts). */
export type GroundType = 'cycle' | 'car' | 'tank' | 'crawler' | 'runner' | 'sled' | 'cycle-outlands';
export const GROUND_TYPES: readonly GroundType[] = ['cycle', 'car', 'tank', 'crawler', 'runner', 'sled', 'cycle-outlands'];

/**
 * How each type rides in traffic (relative to the light cycle): mass, top speed, acceleration,
 * and its length (m). Inputs to its network, and (with the traffic mix) its dynamics.
 */
export const GROUND_FIGURES: Record<GroundType, { mass: number; top: number; accel: number; length: number }> = {
  cycle: { mass: 1, top: 1, accel: 1, length: 2.8 },
  car: { mass: 2.5, top: 0.9, accel: 0.8, length: 4.5 },
  tank: { mass: 12, top: 0.55, accel: 0.4, length: 7 },
  crawler: { mass: 5, top: 0.5, accel: 0.5, length: 5.5 },
  runner: { mass: 2.5, top: 1, accel: 0.9, length: 4.6 },
  sled: { mass: 0.8, top: 0.8, accel: 1, length: 3.2 },
  'cycle-outlands': { mass: 1.3, top: 0.9, accel: 0.9, length: 3 },
};

export interface RiderObs {
  /** Its speed and the speed it wants on this road (m/s). */
  speed: number;
  desired: number;
  /** The rider ahead in its lane: the gap (m) and how much slower than it wants to go it is (m/s). */
  leadGap: number;
  leadSlower: number;
  /** In the inner lane; its next turn needs the other lane; it turns left at the next crossing. */
  inner: number;
  mustMove: number;
  leftNext: number;
  /** Metres to the next stop line; on a data highway; seconds stood still. */
  toStop: number;
  highway: number;
  waited: number;
  /** The player: how far (m), whether behind it on its street, how fast it closes (m/s), how reckless it drives (0..1). */
  playerDist: number;
  playerBehind: number;
  playerClosing: number;
  reckless: number;
  /** Seconds until the player reaches it (closing from behind on its street; 99 if never). */
  playerEta: number;
  /** Its own figures (GROUND_FIGURES). */
  mass: number;
  top: number;
  accel: number;
  length: number;
}

const FEATURES: Feature[] = [
  { name: 'speed (m/s)', scale: 30 },
  { name: 'desired (m/s)', scale: 30 },
  { name: 'gap ahead (m)', scale: 100 },
  { name: 'lead slower by (m/s)', scale: 10 },
  { name: 'inner lane', scale: 1 },
  { name: 'turn needs the other lane', scale: 1 },
  { name: 'left turn next', scale: 1 },
  { name: 'to the stop line (m)', scale: 100 },
  { name: 'data highway', scale: 1 },
  { name: 'stood still (s)', scale: 20 },
  { name: 'player distance (m)', scale: 100 },
  { name: 'player behind', scale: 1 },
  { name: 'player closing (m/s)', scale: 10 },
  { name: 'player reckless', scale: 1 },
  { name: 'player there in (s)', scale: 5 },
  { name: 'mass', scale: 5 },
  { name: 'top speed', scale: 1 },
  { name: 'acceleration', scale: 1 },
  { name: 'length (m)', scale: 5 },
];

/** The scripted rider: the baseline and the teacher. */
export function scriptedRider(o: RiderObs): RiderAction {
  // A reckless player coming up behind it on its street, there within about 4 s: get out of the way.
  if (o.playerBehind && o.playerClosing > 4 && o.playerEta < 4 && o.reckless > 0.5) return o.toStop < 60 && !o.mustMove ? 'turnAway' : 'giveRoom';
  // Held up by a slower rider: pass when the lane allows (the engine judges the gap).
  if (o.leadGap < 90 && o.leadSlower > 3) return 'pass';
  // Otherwise back to the outer lane when the next turn doesn't need the inner.
  if (o.inner && !o.mustMove && !o.leftNext && o.speed > 8) return 'keepRight';
  return 'follow';
}

const feats = (o: RiderObs): number[] => [
  o.speed, o.desired, Math.min(o.leadGap, 200), Math.max(-20, Math.min(20, o.leadSlower)), o.inner, o.mustMove, o.leftNext, Math.max(-10, Math.min(o.toStop, 300)), o.highway,
  Math.min(o.waited, 60), Math.min(o.playerDist, 400), o.playerBehind, Math.max(-30, Math.min(30, o.playerClosing)), o.reckless, Math.min(o.playerEta, 20), o.mass, o.top, o.accel, o.length,
];

export const riderPolicy = new Policy<RiderObs, RiderAction>('rider', FEATURES, RIDER_ACTIONS, feats, scriptedRider, [16]);

/** Each stock ground type's network (missing: its role's shared network, `riderPolicy.net`). */
export const riderNets = new Map<GroundType, Net>();

/** The network a type drives by. */
export const riderNet = (type: GroundType): Net | null => riderNets.get(type) ?? riderPolicy.net;

export function loadRiderWeights(w: unknown = weights): GroundType[] {
  const o = (w ?? {}) as Record<string, unknown>;
  riderNets.clear();
  for (const t of GROUND_TYPES) {
    const n = fromJSON(o[`drive.${t}`]);
    if (n && riderPolicy.fits(n)) riderNets.set(t, n);
  }
  riderPolicy.net = riderNets.get('cycle') ?? null;
  return [...riderNets.keys()];
}
loadRiderWeights();
