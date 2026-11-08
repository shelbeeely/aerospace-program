/**
 * The Grid is a small planet. Physics runs in a flat frame that wraps around every
 * `circumference` metres in x and z (fly far enough and you are back where you started);
 * gravity weakens with altitude and horizontal speed gives the v²/(R+h) lift of flying around a
 * sphere, so orbits are real. The renderer bends everything around a sphere under the camera.
 */
export const PLANET = {
  radius: 8000,
  circumference: 2 * Math.PI * 8000,
  /** Surface gravity (m/s²); falls off as (R / (R + h))². */
  gravity: 9.81,
} as const;

/** Wrap a flat coordinate into [-C/2, C/2). */
export const wrapCoord = (v: number) => {
  const c = PLANET.circumference;
  return v - c * Math.floor((v + c / 2) / c);
};

/** Static world layout shared by the simulation and the renderer. */
export const LAYOUT = {
  /** Ground: the whole planet (one circumference square, wrapping), top surface at y = 0. */
  groundSize: 2 * Math.PI * 8000,
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
export const COAST = { x: 2500, width: 9000, seaLevel: -1.8, depth: 80 } as const;

/** True over the ocean band (x from the coast to coast + width, wrapping). */
export function isSea(x: number): boolean {
  const w = wrapCoord(x);
  return w > COAST.x && w < COAST.x + COAST.width;
}

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
  /** Kit towers (imported models) placed on this fraction of eligible blocks (more in hub cores). */
  kitFraction: 0.3,
  kitCoreFraction: 0.55,
  colors: ['#1f8bff', '#00eaff', '#00eaff', '#ff8a1f', '#9d4dff', '#3dffb0'],
} as const;

/** A place to land: a runway (axis-aligned strip) or a helipad (circle; rooftop pads have y > 0). */
export interface LandingSite {
  id: string;
  name: string;
  kind: 'runway' | 'helipad';
  /** Centre (m) and pad height above the street (0 = ground). */
  x: number;
  z: number;
  y: number;
  /** Runways: the axis the strip runs along, its length and width (m). Helipads: radius in width. */
  axis: 'x' | 'z';
  length: number;
  width: number;
  /** Rooftop pads: the structure group they sit on (gone while it is fractured). */
  group?: number;
}

/** Runways. The first is Grid International (spawn, terminal, test cards). */
export const RUNWAYS: readonly LandingSite[] = [
  { id: 'grid', name: 'Grid International', kind: 'runway', x: 0, z: LAYOUT.runway.centerZ, y: 0, axis: 'z', length: LAYOUT.runway.length, width: LAYOUT.runway.width },
  { id: 'north', name: 'North Field', kind: 'runway', x: -1300, z: -3500, y: 0, axis: 'x', length: 1100, width: 25 },
  { id: 'harbour', name: 'Harbour Strip', kind: 'runway', x: 2150, z: 1500, y: 0, axis: 'z', length: 900, width: 22 },
  { id: 'southgate', name: 'Southgate', kind: 'runway', x: -800, z: 2750, y: 0, axis: 'z', length: 1200, width: 28 },
];

/** Street-level helipads (each keeps a clear circle). Rooftop pads come from the city plan. */
export const GROUND_HELIPADS: readonly LandingSite[] = [
  { id: 'pad-apron', name: 'Apron Heliport', kind: 'helipad', x: -240, z: 220, y: 0, axis: 'z', length: 0, width: 12 },
  { id: 'pad-town', name: 'Town Square Pad', kind: 'helipad', x: -1000, z: -110, y: 0, axis: 'z', length: 0, width: 10 },
  { id: 'pad-coast', name: 'Coastguard Pad', kind: 'helipad', x: 2330, z: -1400, y: 0, axis: 'z', length: 0, width: 12 },
  { id: 'pad-west', name: 'West Gate Pad', kind: 'helipad', x: -4600, z: 600, y: 0, axis: 'z', length: 0, width: 12 },
  { id: 'pad-south', name: 'South Plaza Pad', kind: 'helipad', x: 300, z: 4600, y: 0, axis: 'z', length: 0, width: 12 },
  { id: 'pad-north', name: 'North Plaza Pad', kind: 'helipad', x: 600, z: -2600, y: 0, axis: 'z', length: 0, width: 12 },
];

/** Along/across coordinates of (x, z) relative to a runway (along its axis). */
export function runwayFrame(r: LandingSite, x: number, z: number): { along: number; across: number } {
  return r.axis === 'z' ? { along: z - r.z, across: x - r.x } : { along: x - r.x, across: z - r.z };
}

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
  // The other airstrips: strip and its surrounds clear, funnels beyond each end.
  for (let i = 1; i < RUNWAYS.length; i++) {
    const r = RUNWAYS[i];
    const { along, across } = runwayFrame(r, x, z);
    const half = r.length / 2;
    if (Math.abs(across) < 110 && Math.abs(along) < half + 150) return 0;
    const past = Math.abs(along) - half;
    if (past > 0 && Math.abs(across) < 160 + 0.15 * past) return past < 300 ? 0 : 0.02 * past;
  }
  for (const p of GROUND_HELIPADS) if ((x - p.x) ** 2 + (z - p.z) ** 2 < 45 * 45) return 0;
  // Climb-out / turn corridor east of the field.
  if (x > -560 && z < zS + 1200) return 40;
  // The breakable-block town.
  if (Math.abs(x - TOWN.centerX) < 160 && Math.abs(z - TOWN.centerZ) < 130) return 0;
  return Infinity;
}

/**
 * The lowest zoning cap over a rectangle: a 5×5 sample grid, plus exact tests against the
 * helipad clear circles (small enough to slip between samples).
 */
export function heightCapRect(xa: number, za: number, xb: number, zb: number): number {
  let cap = Infinity;
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) cap = Math.min(cap, heightCap(xa + ((xb - xa) * i) / 4, za + ((zb - za) * j) / 4));
  for (const p of GROUND_HELIPADS) {
    const dx = Math.max(xa - p.x, 0, p.x - xb);
    const dz = Math.max(za - p.z, 0, p.z - zb);
    if (dx * dx + dz * dz < 45 * 45) return 0;
  }
  return cap;
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
