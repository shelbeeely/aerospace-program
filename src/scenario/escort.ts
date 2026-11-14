import { Policy, type Feature } from '../brain/policy.ts';
import { fromJSON } from '../brain/net.ts';
import weights from '../brain/weights/squad.json' with { type: 'json' };

/**
 * The escort squad: four units the player can order to escort a vehicle (an ambulance, a
 * freight truck). The order is the objective, and it holds until the player changes it or the
 * escorted vehicle arrives. What the squad's network decides: where to hold (ahead to clear the
 * way, behind, on the flank), when to regroup and when to fall back. What the engine decides:
 * how the units move, how far they spread, what the fighting does.
 *
 * Escorted from ahead (within reach), the vehicle gets the right of way at junctions and the
 * traffic ahead moves over for it; escorted from ahead or the flank, fighting it drives through
 * does not hold it up.
 */
export type SquadAction = 'ahead' | 'behind' | 'flank' | 'regroup' | 'fallback';
export const SQUAD_ACTIONS: readonly SquadAction[] = ['ahead', 'behind', 'flank', 'regroup', 'fallback'];

export interface SquadObs {
  /** Distance from the squad's centre to the escorted vehicle (m), and the vehicle's speed (m/s). */
  dist: number;
  targetSpeed: number;
  /** How spread out the squad is (m, the farthest unit from its centre). */
  spread: number;
  /** Fighting on the vehicle's way ahead (0..1), and how close fighting is to the squad (0..1). */
  threatAhead: number;
  threatNear: number;
  /** Units still able to fight (of 4). */
  units: number;
  /** The escorted vehicle's urgency (0..1) and the queue in front of it. */
  urgency: number;
  queueAhead: number;
}

const FEATURES: Feature[] = [
  { name: 'distance to escorted (m)', scale: 60 },
  { name: 'escorted speed (m/s)', scale: 10 },
  { name: 'spread (m)', scale: 30 },
  { name: 'fighting ahead', scale: 1 },
  { name: 'fighting near', scale: 1 },
  { name: 'units', scale: 4 },
  { name: 'urgency', scale: 1 },
  { name: 'queue ahead', scale: 6 },
];

const feats = (o: SquadObs): number[] => [Math.min(o.dist, 300), o.targetSpeed, Math.min(o.spread, 120), o.threatAhead, o.threatNear, o.units, o.urgency, Math.min(o.queueAhead, 20)];

/** The scripted squad leader: the baseline and the teacher. */
export function scriptedSquad(o: SquadObs): SquadAction {
  if (o.spread > 35) return 'regroup';
  if (o.threatNear > 0.7 && o.units < 2) return 'fallback';
  if (o.threatAhead > 0.3) return 'ahead';
  if (o.queueAhead > 3 && o.urgency > 0.4) return 'ahead';
  if (o.threatNear > 0.4) return 'flank';
  return 'behind';
}

export const squadPolicy = new Policy<SquadObs, SquadAction>('squad', FEATURES, SQUAD_ACTIONS, feats, scriptedSquad, [10]);

export function loadSquadWeights(w: unknown = weights): boolean {
  const n = fromJSON((w as Record<string, unknown> | null)?.squad);
  squadPolicy.net = n && squadPolicy.fits(n) ? n : null;
  return !!squadPolicy.net;
}
loadSquadWeights();

/** Fighting somewhere in the district (where a crossing was fought over), until a time. */
export interface DangerZone {
  x: number;
  z: number;
  r: number;
  until: number;
  name: string;
}

export interface Squad {
  units: Array<{ x: number; z: number; lag: number; down: boolean }>;
  /** The vehicle it escorts (the player's order), or null. */
  target: number | null;
  slot: SquadAction;
  nextDecide: number;
  /** Where it holds relative to the vehicle (world point it is heading for). */
  aim: { x: number; z: number };
  log: Array<{ t: number; text: string }>;
  decisions: Record<SquadAction, number>;
}

export function newSquad(x: number, z: number): Squad {
  return {
    units: [0, 1, 2, 3].map((i) => ({ x: x + (i % 2) * 4, z: z + Math.floor(i / 2) * 4, lag: 0.82 + 0.05 * i, down: false })),
    target: null, slot: 'behind', nextDecide: 0, aim: { x, z }, log: [], decisions: { ahead: 0, behind: 0, flank: 0, regroup: 0, fallback: 0 },
  };
}

export const SQUAD = { speed: 24, ahead: 35, behind: 20, flank: 12, fallback: 60, reach: 60, decideEvery: 1 } as const;

/** The squad.s centre and spread. */
export function squadShape(sq: Squad): { x: number; z: number; spread: number; units: number } {
  const up = sq.units.filter((u) => !u.down);
  if (!up.length) return { x: sq.aim.x, z: sq.aim.z, spread: 0, units: 0 };
  const x = up.reduce((a, u) => a + u.x, 0) / up.length, z = up.reduce((a, u) => a + u.z, 0) / up.length;
  return { x, z, spread: Math.max(...up.map((u) => Math.hypot(u.x - x, u.z - z))), units: up.length };
}
