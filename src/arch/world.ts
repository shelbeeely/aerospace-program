/**
 * World-level configuration of the digital world and the cache registry that lets a new seed
 * regenerate everything (the explorer's seed field). The flight game uses the default seed, so
 * physics and rendering always agree.
 */
export const WORLD = {
  /** Master seed: regions, districts, structures, terrain landforms and routes derive from it. */
  seed: 1982,
  /** Region lattice: the circumference split this many times each way (~4.2 km cells). */
  regionCells: 12,
  /** Width (m) over which neighbouring regions blend (transitional regions). */
  transition: 1100,
  /** Probability that a region site away from the hubs is Outlands. */
  outlandsShare: 0.5,
};

const clearers: Array<() => void> = [];

/** Modules with derived caches register a clearer here. */
export function onWorldReset(fn: () => void): void {
  clearers.push(fn);
}

/** Change the world seed / blend and drop every derived cache. */
export function setWorld(opts: Partial<typeof WORLD>): void {
  Object.assign(WORLD, opts);
  for (const f of clearers) f();
}
