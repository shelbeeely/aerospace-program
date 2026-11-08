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
 * The Grid: one city covering all the land (west edge to the coast), seeded. Several downtown
 * hubs (clusters of information) rise out of low-rise districts; major avenues every few
 * blocks are glowing data highways. The airport keeps real obstacle-limitation zoning (see
 * `heightCap`), which also keeps every test-card flight path clear.
 */
export const CITY = {
  seed: 2049,
  /** Land the city covers (m). The coast is at COAST.x. */
  x0: -4950,
  x1: 2380,
  z0: -4950,
  z1: 4950,
  /** City block (buildable square, m) and street width (m): pitch = block + street. */
  block: 110,
  street: 26,
  /** Every Nth street is a data highway (wider glow, dense traffic). */
  highwayEvery: 6,
  /** Downtown hubs: centre (m), radius (m) and peak height (m). */
  hubs: [
    { x: -3000, z: -1200, r: 1100, h: 380 },
    { x: -2600, z: 3000, r: 900, h: 300 },
    { x: 900, z: 3400, r: 800, h: 260 },
    { x: -3800, z: -3900, r: 700, h: 240 },
    { x: 1500, z: -4200, r: 600, h: 120 },
  ],
  /** Height of the low-rise districts between hubs (m). */
  baseHeight: 22,
  minHeight: 10,
  /** Raised freeways: deck height (m) above the street. */
  highwayHeight: 30,
  /** Kit towers (imported models) placed on this fraction of eligible blocks. */
  kitFraction: 0.07,
  colors: ['#1f8bff', '#00eaff', '#00eaff', '#ff8a1f', '#9d4dff', '#3dffb0'],
} as const;

/**
 * Airport obstacle-limitation zoning: the tallest a building may be at (x, z), in metres.
 * - the airfield itself (runway strip, taxiway, apron, terminal): nothing;
 * - approach/departure funnels beyond each runway end, widening 15% and rising 2% with distance;
 * - the climb-out corridor east of the runway (where aircraft turn out): 40 m;
 * - the town (breakable blocks) keeps its own lots;
 * Elsewhere the sky is the limit.
 */
export function heightCap(x: number, z: number): number {
  const { length, centerZ } = LAYOUT.runway;
  const zN = centerZ - length / 2;
  const zS = centerZ + length / 2;
  // Airfield.
  if (x > -560 && x < 260 && z > zN - 200 && z < zS + 200) return 0;
  // Approach / departure funnels (both ends).
  const beyond = z < zN ? zN - z : z > zS ? z - zS : -1;
  if (beyond >= 0) {
    const halfWidth = 300 + 0.15 * beyond;
    if (Math.abs(x) < halfWidth) return beyond < 400 ? 0 : 0.02 * beyond;
  }
  // Climb-out / turn corridor east of the field.
  if (x > -560 && z < zS + 1200) return 40;
  // The breakable-block town.
  if (Math.abs(x - TOWN.centerX) < 160 && Math.abs(z - TOWN.centerZ) < 130) return 0;
  return Infinity;
}

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
