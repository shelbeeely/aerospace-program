/**
 * The living world's state: what the factions hold, make, trade and build, carried forward in
 * world time whether anyone plays or not (src/living/advance.ts). Plain data (JSON round-trips
 * exactly), DOM- and scene-free, so the relay keeps it on disk and a browser keeps a copy.
 *
 * The planet itself stays a pure function of the seed (src/world, src/arch); this is the layer
 * that changes on top of it: blocks developed, districts captured, damage repaired, and the
 * factions' economies and relations.
 */
export type Faction = 0 | 1 | 2;
export const FACTIONS: readonly Faction[] = [0, 1, 2];
export const FACTION_NAME = ['Cyan', 'Red', 'Amber'] as const;

/** What districts make, by what their architecture does. */
export const GOODS = ['compute', 'memory', 'materials', 'bandwidth', 'energy'] as const;
export type Good = (typeof GOODS)[number];

/**
 * The planet as the living world sees it: per block, its kind (the block summary's BLOCK_KIND)
 * and city region (CITY_REGIONS index); per district, the starting owner (-1: none). Built
 * from the world generator (src/living/baseMap.ts) or loaded from a shipped copy (the relay).
 */
export interface BaseMap {
  /** Blocks per side, and blocks per district side. */
  n: number;
  chunkBlocks: number;
  kind: Uint8Array;
  region: Uint8Array;
  owner: Int8Array;
}

/** A block being built: its owner, stage (0 survey, 1 roads, 2 foundation, 3 structure) and when the stage began (ms). */
export interface Site {
  b: number;
  f: Faction;
  stage: number;
  since: number;
  region: number;
}

/** Goods on their way from one faction to another, paid for on arrival. */
export interface Convoy {
  id: number;
  from: Faction;
  to: Faction;
  good: Good;
  amount: number;
  /** Credits per unit, agreed at departure. */
  price: number;
  mode: 'road' | 'air';
  departs: number;
  arrives: number;
  /** Bits riding along to move house in the other faction's city. */
  migrants: number;
  /** Through the Outlands (a little riskier). */
  outlands: boolean;
}

export type Stance = 'peace' | 'tension' | 'mobilising' | 'war' | 'truce';
export type Treaty = 'none' | 'pact' | 'alliance' | 'embargo';

/** One pair of factions: trust (0..1), stance on the war ladder, treaty, and recent disputes. */
export interface Relation {
  trust: number;
  stance: Stance;
  since: number;
  treaty: Treaty;
  treatySince: number;
  /** Disputes lately (decays): contested blocks, lost convoys. */
  disputes: number;
  /** Trade volume lately (decays). */
  trade: number;
}

export interface FactionState {
  treasury: number;
  stock: Record<Good, number>;
  /** How well its needs have been met lately (0..1). */
  prosperity: number;
  /** Build points saved up (a block is started at 1). */
  budget: number;
  /** Blocks it has developed, and how many it may (its cap). */
  built: number;
  cap: number;
}

export type EventKind = 'started' | 'built' | 'trade' | 'convoyLost' | 'treaty' | 'stance' | 'capture' | 'migration' | 'repair';

/** Something that happened, for "while you were away" (explanations come only from these). */
export interface LivingEvent {
  t: number;
  kind: EventKind;
  factions: number[];
  text: string;
  /** Where (block or district index), when it matters. */
  at?: number;
}

/** Damage waiting to be repaired: a crater or a felled tower, ready at `at` (ms). */
export interface Repair {
  id: string;
  kind: 'crater' | 'tower';
  at: number;
}

export interface LivingState {
  v: 1;
  seed: number;
  /** World time (ms since the epoch) of the last tick, and the tick count. */
  time: number;
  tick: number;
  factions: FactionState[];
  /** Developed blocks: [block, faction, region, completed at]. */
  developed: Array<[number, number, number, number]>;
  sites: Site[];
  /** Districts taken from their starting owner: [district, faction]. */
  captures: Array<[number, number]>;
  convoys: Convoy[];
  /** Keyed '01', '02', '12'. */
  relations: Record<string, Relation>;
  repairs: Repair[];
  /** Bits moved between the factions' cities, all told: [from][to]. */
  migrants: number[][];
  /** Running totals, for the books (conservation is checked). */
  totals: { produced: Record<Good, number>; consumed: Record<Good, number>; built: Record<Good, number>; lost: Record<Good, number>; taxed: number; spent: number };
  log: LivingEvent[];
  nextId: number;
}

export const pairKey = (a: number, b: number) => (a < b ? `${a}${b}` : `${b}${a}`);

const zeroGoods = (): Record<Good, number> => ({ compute: 0, memory: 0, materials: 0, bandwidth: 0, energy: 0 });

/** A fresh living world at `time`: everyone at peace, stocks for a few days, no growth yet. */
export function createLiving(seed: number, time: number, caps: [number, number, number]): LivingState {
  const relations: Record<string, Relation> = {};
  for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) relations[pairKey(a, b)] = { trust: 0.5, stance: 'peace', since: time, treaty: 'none', treatySince: time, disputes: 0, trade: 0 };
  return {
    v: 1, seed, time, tick: 0,
    factions: FACTIONS.map((f) => ({ treasury: 1000, stock: { compute: 400, memory: 400, materials: 400, bandwidth: 400, energy: 400 }, prosperity: 0.6, budget: 0, built: 0, cap: caps[f] })),
    developed: [], sites: [], captures: [], convoys: [], relations, repairs: [],
    migrants: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    totals: { produced: zeroGoods(), consumed: zeroGoods(), built: zeroGoods(), lost: zeroGoods(), taxed: 0, spent: 0 },
    log: [], nextId: 1,
  };
}
