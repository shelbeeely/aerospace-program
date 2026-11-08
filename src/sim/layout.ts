/** Static world layout shared by the simulation and the renderer. */
export const LAYOUT = {
  /** Ground is a square of this size (m), top surface at y = 0. */
  groundSize: 10_000,
  runway: {
    length: 1400,
    width: 30,
    /** Runway centre. The runway is aligned with the Z axis. */
    centerZ: -300,
  },
  /** Spawn: near the +Z threshold, facing -Z down the runway. */
  spawnZ: 360,
} as const;

/**
 * The town of breakable block buildings (src/world/Town.ts). Lots on a grid well west of the
 * runway (x < -700), clear of every test-card flight path (those stay near the runway and turn
 * east). Building sizes are seeded, so the town is identical on every load.
 */
export const TOWN = {
  seed: 1983,
  /** Lot grid: columns along X, rows along Z. */
  columns: 4,
  rows: 3,
  /** Lot pitch (m): building plus street. */
  lot: 48,
  /** Centre of the grid (m). */
  centerX: -1000,
  centerZ: -300,
  /** Footprint (blocks per side) and floors (blocks high) ranges, inclusive. */
  footprint: [3, 6],
  floors: [4, 10],
  /** Neon edge colours handed out to buildings. */
  colors: ['#19f0ff', '#ff2bd6', '#8a5cff', '#ff8a1f', '#39ff9c'],
} as const;

/** Coast is east of all runway and town paths; ocean floor lies below the waves. */
export const COAST = { x: 2500, seaLevel: -1.8, depth: 80 } as const;
