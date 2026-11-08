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

/**
 * The neon city: a seeded grid of skyscrapers well west of the airport and the town, clear of
 * every test-card path (those climb out along the runway and turn east). Downtown is at the
 * centre; heights fall off with distance from it.
 */
export const CITY = {
  seed: 2049,
  centerX: -3000,
  centerZ: -1200,
  /** Extent (m) along X and Z. */
  sizeX: 2800,
  sizeZ: 4400,
  /** City block (buildable square, m) and street width (m): pitch = block + street. */
  block: 110,
  street: 26,
  /** Downtown radius (m): heights fall off as a Gaussian of this size. */
  downtownRadius: 1100,
  /** Tallest ordinary tower (m) at the very centre; the landmark spire is taller. */
  maxHeight: 380,
  minHeight: 16,
  /** Raised highways: deck height (m) above the street. */
  highwayHeight: 30,
  colors: ['#00eaff', '#00eaff', '#ff2bd6', '#9d4dff', '#ff8a1f', '#3dffb0'],
} as const;

/** The airport around the runway: taxiway, apron, terminal and tower, all west of the runway. */
export const AIRPORT = {
  /** Parallel taxiway centreline (m) and width. */
  taxiwayX: -130,
  taxiwayWidth: 18,
  /** Apron (parking area) bounds. */
  apron: { x0: -330, x1: -150, z0: -540, z1: 140 },
  /** Terminal building centre line and size. */
  terminal: { x: -372, z: -200, depth: 44, length: 340, height: 18 },
  /** Control tower base. */
  tower: { x: -210, z: -660, height: 62 },
  /** Approach light system length (m) beyond each threshold. */
  approachLength: 900,
  /** PAPI glide slope (deg) and offset from the runway edge (m). */
  glideSlopeDeg: 3,
  papiOffset: 18,
} as const;
