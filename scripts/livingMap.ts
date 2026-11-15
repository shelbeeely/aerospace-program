/**
 * Ship the planet as the living world sees it. Run with `npm run living-map` (or `npm run train`,
 * which runs it when world generation has changed).
 *
 * The relay keeps the living world but does not carry the world generator, so it loads this
 * instead: each block's kind and city region and each district's starting owner (src/living/
 * baseMap.ts), with the region names and the block size. Stamped with a fingerprint of the
 * generator code it came from (scripts/lib/fingerprint.ts): a change to world generation makes
 * it stale, and `npm run train` (and CI) regenerate it.
 */
import { writeFileSync } from 'node:fs';
import { baseMap, livingPitch, livingRegions } from '../src/living/baseMap.ts';
import { toBase64 } from '../src/sim/evolution.ts';
import { stampOf } from './lib/fingerprint.ts';

const m = baseMap();
const out = {
  trained: { note: 'npm run train (or living-map) regenerates this file from the world generator (src/living/baseMap.ts)', ...stampOf('scripts/livingMap.ts') },
  n: m.n, chunkBlocks: m.chunkBlocks, pitch: livingPitch(), regions: livingRegions(),
  kind: toBase64(m.kind), region: toBase64(m.region), owner: toBase64(new Uint8Array(m.owner.buffer, m.owner.byteOffset, m.owner.byteLength)),
};
writeFileSync('src/living/baseMap.json', JSON.stringify(out) + '\n');
console.log(`wrote src/living/baseMap.json: ${m.n}² blocks, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
