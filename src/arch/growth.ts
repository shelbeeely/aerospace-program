import type { CityRegion } from './WorldRegionManager.ts';

/**
 * The cities' growth, as the world generator sees it (the living world decides it,
 * src/living/; this is only what it has decided): blocks being built and blocks built, by
 * global block index (gj * blocks + gi).
 *
 * - stage 0 survey: nothing yet;
 * - stage 1 roads: the plains lot it sat in is split into single blocks, so streets run round it;
 * - stage 2 foundation: still open ground on its own block;
 * - stage 3 structure: the structure, rising (about half its height);
 * - stage 4: built, a structure of its region like any other.
 *
 * World generation stays a pure function: of the seed, the lattice indices and this overlay.
 * Everything that derives from the layout (the block summary and its road network, district
 * plans, the ground, traffic's intersections, the radar) listens and refreshes.
 */
export interface GrowthBlock {
  stage: number;
  region: CityRegion;
}

export const BUILT = 4;
let blocks = new Map<number, GrowthBlock>();
let version = 0;
const listeners = new Set<(changed: ReadonlySet<number>) => void>();

/** The growth at block index b (none: as generated). */
export function growthAt(b: number): GrowthBlock | undefined {
  return blocks.get(b);
}

/** Bumped whenever the overlay changes. */
export function growthVersion(): number {
  return version;
}

/** How many blocks are growing or grown. */
export function growthSize(): number {
  return blocks.size;
}

/** Listen for changes (given the blocks that changed). Returns a function that stops listening. */
export function onGrowth(fn: (changed: ReadonlySet<number>) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Replace the overlay. True (and listeners told) if anything changed. */
export function setGrowth(next: ReadonlyMap<number, GrowthBlock>): boolean {
  const changed = new Set<number>();
  for (const [b, g] of next) { const o = blocks.get(b); if (!o || o.stage !== g.stage || o.region !== g.region) changed.add(b); }
  for (const b of blocks.keys()) if (!next.has(b)) changed.add(b);
  if (!changed.size) return false;
  blocks = new Map(next);
  version++;
  for (const fn of listeners) fn(changed);
  return true;
}
