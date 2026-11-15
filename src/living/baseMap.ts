import { GRID } from '../arch/grid.ts';
import { CITY_REGIONS } from '../arch/WorldRegionManager.ts';
import { baseOwner } from '../sim/territory.ts';
import { blockSummary } from '../world/planetCity.ts';
import type { BaseMap } from './state.ts';

/**
 * The planet as the living world sees it, from the world generator: each block's kind and city
 * region (the block summary's B and G channels), and each district's starting owner. Built once
 * (about two seconds); the relay loads a shipped copy instead (it does not carry the generator).
 */
let cache: BaseMap | null = null;

export function baseMap(): BaseMap {
  if (cache) return cache;
  const s = blockSummary();
  const n = GRID.blocks, cb = GRID.chunkBlocks, nc = n / cb;
  const kind = new Uint8Array(n * n), region = new Uint8Array(n * n), owner = new Int8Array(nc * nc);
  for (let b = 0; b < n * n; b++) {
    kind[b] = s[b * 4 + 2];
    region[b] = s[b * 4 + 1] & 15;
  }
  for (let cj = 0; cj < nc; cj++) for (let ci = 0; ci < nc; ci++) owner[cj * nc + ci] = baseOwner(ci, cj) ?? -1;
  return (cache = { n, chunkBlocks: cb, kind, region, owner });
}

/** The city regions by index (the block summary's region bits), and a block's size (m). */
export const livingRegions = (): readonly string[] => CITY_REGIONS;
export const livingPitch = (): number => GRID.pitch;
