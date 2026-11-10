/**
 * Sonic booms. A craft faster than sound drags an N-wave behind it; where its shock cone meets
 * the ground or a building the overpressure hits all at once. Carlson's estimate:
 *
 *   Δp ≈ K · (M² − 1)^⅛ · d^(−¾) · L^¾
 *
 * (d: distance from the craft, L: its length). K is calibrated so Concorde (L 62 m, Mach 2,
 * 16 km) gives its measured ~96 Pa; a 15 m fighter at Mach 1.2 and 50 m gives ~2 kPa, like real
 * low-level booms. Windows go at ~500 Pa, light structure at a few kPa.
 */
export const BOOM_K = 5500;
/** Overpressure (Pa) that shatters glass-like surface panels (voxel shards, no structural damage). */
export const BOOM_SHATTER = 600;
/** Overpressure (Pa) that knocks blocks out of a structure. */
export const BOOM_DAMAGE = 1200;
/** Overpressure (Pa) that derezzes an exposed rider. */
export const BOOM_DEREZ = 6000;

/** Ground overpressure (Pa) at distance `d` (m) from a craft of length `length` (m) at `mach`. */
export function boomOverpressure(mach: number, d: number, length: number): number {
  if (mach <= 1) return 0;
  return BOOM_K * (mach * mach - 1) ** 0.125 * Math.max(1, d) ** -0.75 * Math.max(1, length) ** 0.75;
}

/** How far (m) the boom still reaches `dp` Pa (the search radius for damage). */
export function boomReach(mach: number, length: number, dp: number): number {
  if (mach <= 1) return 0;
  const k = BOOM_K * (mach * mach - 1) ** 0.125 * Math.max(1, length) ** 0.75;
  return Math.min(2500, (k / dp) ** (4 / 3));
}

/** Blast radius (m) that a given overpressure tears out of a structure (≥ BOOM_DAMAGE). */
export function boomBite(dp: number): number {
  return Math.min(14, 2 + 4 * Math.log2(Math.max(1, dp / BOOM_DAMAGE)));
}

export interface BoomEvent {
  x: number;
  y: number;
  z: number;
  time: number;
  mach: number;
  /** Overpressure (Pa) on the ground straight below. */
  groundDp: number;
  /** Structure blocks it knocked out. */
  blocks: number;
}
