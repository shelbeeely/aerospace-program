import { Policy, type Feature } from '../brain/policy.ts';
import { fromJSON } from '../brain/net.ts';
import weights from '../brain/weights/drive.json' with { type: 'json' };

/**
 * The road vehicles' policies. What a network decides here: keep following, yield (move over
 * and ease off, let an emergency vehicle by), merge into the other lane, or ask the router for a
 * new route. What the engine decides: speed and braking (the Intelligent Driver Model), whether
 * a lane change is safe, the right of way at junctions, which route the router returns.
 *
 * - **drive**: everyone on an ordinary job (commuters, freight, evacuation, the convoy).
 * - **respond**: an ambulance on a call; it never yields and reroutes sooner. An ambulance
 *   switches back to drive when the call is over.
 */
export type DriveAction = 'follow' | 'yield' | 'merge' | 'reroute';
export const DRIVE_ACTIONS: readonly DriveAction[] = ['follow', 'yield', 'merge', 'reroute'];

/** What a driver knows at a decision. */
export interface DriveObs {
  /** Own speed and the speed limit (m/s). */
  speed: number;
  limit: number;
  /** Gap to the vehicle ahead in its lane (m, 120 if none) and how fast it closes (m/s). */
  gap: number;
  closing: number;
  /** Vehicles queued on its next edge, and whether it knows that edge is closed. */
  nextQueue: number;
  nextClosed: number;
  /** The gap ahead in the other lane (m) and whether there is another lane to take. */
  laneGap: number;
  laneFree: number;
  /** An emergency vehicle close behind. */
  emergencyBehind: number;
  /** How urgent its job is (0..1). */
  urgency: number;
  /** How much longer its route is than the best one it knows (s). */
  delay: number;
  /** How long it has been standing (s). */
  waited: number;
  /** Distance to the end of its edge (m). */
  toNode: number;
  /** It is a heavy vehicle. */
  heavy: number;
}

const FEATURES: Feature[] = [
  { name: 'speed / limit', scale: 1 },
  { name: 'gap ahead (m)', scale: 50 },
  { name: 'closing speed (m/s)', scale: 5 },
  { name: 'queue on next edge', scale: 8 },
  { name: 'next edge closed', scale: 1 },
  { name: 'gap in other lane (m)', scale: 50 },
  { name: 'other lane free', scale: 1 },
  { name: 'emergency behind', scale: 1 },
  { name: 'urgency', scale: 1 },
  { name: 'route delay (s)', scale: 30 },
  { name: 'waited (s)', scale: 20 },
  { name: 'to node (m)', scale: 100 },
  { name: 'heavy', scale: 1 },
];

const feats = (o: DriveObs): number[] => [
  o.limit > 0 ? o.speed / o.limit : 0, Math.min(o.gap, 120), o.closing, o.nextQueue, o.nextClosed,
  Math.min(o.laneGap, 120), o.laneFree, o.emergencyBehind, o.urgency, Math.min(o.delay, 180), Math.min(o.waited, 120), Math.min(o.toNode, 300), o.heavy,
];

/** The scripted driver: the baseline, and the teacher. */
export function scriptedDrive(o: DriveObs): DriveAction {
  if (o.nextClosed) return 'reroute';
  if (o.emergencyBehind) return 'yield';
  if (o.delay > 40 - 20 * o.urgency) return 'reroute';
  if (o.waited > 25 && o.delay > 8) return 'reroute';
  if (o.gap < 35 && o.closing > 1.5 && o.laneFree && o.laneGap > 30 && o.speed > 3) return 'merge';
  return 'follow';
}

/** The scripted ambulance on a call. */
export function scriptedRespond(o: DriveObs): DriveAction {
  if (o.nextClosed) return 'reroute';
  if (o.delay > 15) return 'reroute';
  if (o.waited > 10 && o.delay > 4) return 'reroute';
  if (o.gap < 30 && o.closing > 0.5 && o.laneFree && o.laneGap > 18) return 'merge';
  return 'follow';
}

export const drivePolicy = new Policy<DriveObs, DriveAction>('drive', FEATURES, DRIVE_ACTIONS, feats, scriptedDrive, [12]);
export const respondPolicy = new Policy<DriveObs, DriveAction>('respond', FEATURES, DRIVE_ACTIONS, feats, scriptedRespond, [12]);

/** Load the trained networks shipped with the game (src/brain/weights/drive.json), if they fit. */
export function loadDriveWeights(w: unknown = weights): { drive: boolean; respond: boolean } {
  const o = (w ?? {}) as Record<string, unknown>;
  const d = fromJSON(o.drive), r = fromJSON(o.respond);
  drivePolicy.net = d && drivePolicy.fits(d) ? d : null;
  respondPolicy.net = r && respondPolicy.fits(r) ? r : null;
  return { drive: !!drivePolicy.net, respond: !!respondPolicy.net };
}
loadDriveWeights();
