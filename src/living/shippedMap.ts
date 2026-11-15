import { fromBase64 } from '../sim/evolution.ts';
import type { BaseMap } from './state.ts';

/**
 * The planet as the living world sees it, from the shipped copy (src/living/baseMap.json,
 * written by `npm run living-map`): for the relay, which does not carry the world generator.
 * Browsers and scripts build it from the generator itself (src/living/baseMap.ts); both give
 * the same map while the copy is fresh (`npm run living` checks).
 */
export interface ShippedMap {
  map: BaseMap;
  regions: string[];
  pitch: number;
}

export function readShippedMap(json: unknown): ShippedMap | null {
  const o = (json ?? {}) as { n?: number; chunkBlocks?: number; pitch?: number; regions?: string[]; kind?: string; region?: string; owner?: string };
  if (!o.n || !o.chunkBlocks || !o.pitch || !Array.isArray(o.regions) || !o.kind || !o.region || !o.owner) return null;
  const kind = fromBase64(o.kind), region = fromBase64(o.region), owner = fromBase64(o.owner);
  if (!kind || !region || !owner || kind.length !== o.n * o.n || region.length !== o.n * o.n) return null;
  return { map: { n: o.n, chunkBlocks: o.chunkBlocks, kind, region, owner: new Int8Array(owner.buffer, owner.byteOffset, owner.byteLength) }, regions: o.regions, pitch: o.pitch };
}
