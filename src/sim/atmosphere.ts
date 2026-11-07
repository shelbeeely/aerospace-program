import { TUNING } from '../tuning.ts';

/** Air density (kg/m^3) at an altitude above sea level, exponential falloff. */
export function airDensity(altitude: number): number {
  const h = Math.max(0, altitude);
  return TUNING.seaLevelDensity * Math.exp(-h / TUNING.densityScaleHeight);
}
