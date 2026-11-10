/**
 * Compressibility, shared by lifting surfaces and bodies, so craft can fly past Mach 1 the way
 * real ones do: drag climbs steeply through the transonic range and peaks just past Mach 1,
 * then falls again supersonically; the lift slope rises toward Mach 1 (Prandtl-Glauert) and
 * drops supersonically (Ackeret).
 */

/** Wave drag peak for a thin lifting surface (Cd, near Mach 1.05). */
export const WAVE_PEAK = 0.1;
const M_PEAK = 1.05;
const SUPER = Math.sqrt(M_PEAK * M_PEAK - 1);

/**
 * Lifting-surface wave drag coefficient at Mach `m`, for a surface with critical Mach `mcrit`.
 * A thinner section (higher critical Mach) has a smaller peak: about 0.1 for a thick
 * subsonic wing (mcrit 0.72), ~0.05 for a thin fighter wing (0.85), ~0.02 for a razor (0.95).
 */
export function surfaceWaveDrag(m: number, mcrit: number): number {
  if (m <= mcrit) return 0;
  const peak = WAVE_PEAK * Math.min(1.2, Math.max(0.2, (1 - mcrit) / 0.28)) ** 1.5;
  if (m < M_PEAK) {
    // Drag divergence: a steep rise from the critical Mach to the peak.
    const t = Math.min(1, (m - mcrit) / Math.max(0.05, M_PEAK - mcrit));
    return peak * t * t * t;
  }
  // Supersonic: falls as 1/sqrt(M²-1).
  return (peak * SUPER) / Math.sqrt(m * m - 1);
}

/**
 * Lift-slope factor relative to incompressible: Prandtl-Glauert 1/sqrt(1-M²) up to Mach 0.9,
 * blending through the transonic range into Ackeret's supersonic 4/sqrt(M²-1) / 2π.
 */
export function liftSlopeFactor(m: number): number {
  const pg = (x: number) => 1 / Math.sqrt(1 - x * x);
  const ack = (x: number) => (4 / Math.sqrt(x * x - 1)) / (2 * Math.PI);
  if (m <= 0.9) return pg(m);
  if (m >= 1.2) return Math.min(pg(0.9), ack(m));
  const t = (m - 0.9) / 0.3;
  return pg(0.9) * (1 - t) + ack(1.2) * t;
}

/** Body (fuselage, nacelle) nose-on drag multiplier: a transonic bump, settling to ~1.6× supersonic. */
export function bodyWaveFactor(m: number): number {
  if (m <= 0.8) return 1;
  if (m < 1.1) {
    const t = (m - 0.8) / 0.3;
    return 1 + 1.5 * t * t;
  }
  return 1.6 + 0.9 * Math.exp(-(m - 1.1) * 1.5);
}
