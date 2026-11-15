import type { GrowthBlock } from '../arch/growth.ts';
import type { CityRegion } from '../arch/WorldRegionManager.ts';
import type { LivingState } from './state.ts';

/**
 * The living world's growth as the world generator's overlay (src/arch/growth.ts): blocks
 * being built (by stage) and blocks built, each with the city region it grows as.
 */
export function growthOverlay(state: LivingState, regions: readonly string[]): Map<number, GrowthBlock> {
  const out = new Map<number, GrowthBlock>();
  for (const [b, , region] of state.developed) out.set(b, { stage: 4, region: regions[region] as CityRegion });
  for (const s of state.sites) out.set(s.b, { stage: s.stage, region: regions[s.region] as CityRegion });
  return out;
}
