import { districtPlan, joined, lotAt } from '../arch/DistrictGenerator.ts';
import { blockArchetype, nearWasteland, wastelandByte } from '../arch/DigitalTerrainGenerator.ts';
import { GRID, isCentralBlock } from '../arch/grid.ts';
import { CITY_REGIONS, intensityAt, TERRAIN_ARCHETYPES } from '../arch/WorldRegionManager.ts';
import { onWorldReset } from '../arch/world.ts';
import { CITY, hash01, heightCap, isSea, PLANET } from '../sim/layout.ts';
import { appendDistrict, emptyPlan, type CityPlan } from './City.ts';
import { connectRoads } from '../sim/roadRules.ts';
import { planStructures, type Structures } from './structures.ts';

export { GRID, isCentralBlock };

/**
 * The planet beyond the planned centre: one district per chunk (10 × 10 blocks), generated on
 * demand by the architecture system (src/arch/DistrictGenerator.ts) and turned into collider
 * pieces here, so physics, zoning, traffic and the renderer all see the same structures. The
 * centre's blocks and the ocean are skipped. Chunks are canonical in [x0, x0 + C); users add a
 * whole-circumference image offset to bring a chunk next to the viewer.
 */
const C = PLANET.circumference;
const mod = (v: number, m: number) => ((v % m) + m) % m;

export interface PlanetChunk {
  ci: number;
  cj: number;
  key: string;
  /** Canonical minimum corner (m). */
  x: number;
  z: number;
  plan: CityPlan;
  structures: Structures;
  /** Lazily built obstacle height map (20 m cells, canonical coordinates). */
  heights?: Map<string, number>;
}

/** Chunk indices containing (x, z) (any image). */
export function chunkAt(x: number, z: number): [number, number] {
  return [Math.floor(mod(x - GRID.x0, C) / GRID.chunkSize), Math.floor(mod(z - GRID.z0, C) / GRID.chunkSize)];
}

/** Whole-circumference shift that brings canonical coordinate `c` nearest to `near`. */
export function imageOffset(c: number, near: number): number {
  return Math.round((near - c) / C) * C;
}

/** Skyline height (m) and hub core (0..1) at a point: tallest hub influence over the base. */
export function skyline(x: number, z: number, base: number): { h: number; core: number } {
  const { core, peak } = intensityAt(x, z);
  return { h: Math.max(base, peak * core ** 1.3), core };
}

const cache = new Map<string, PlanetChunk>();
const MAX_CACHED = 400;
onWorldReset(() => { cache.clear(); summaryCache = null; styleCache = null; });

/** The chunk (generated once, then cached; oldest entries are dropped past MAX_CACHED). */
export function planetChunk(ci: number, cj: number): PlanetChunk {
  ci = mod(ci, GRID.chunks);
  cj = mod(cj, GRID.chunks);
  const key = `${ci},${cj}`;
  let c = cache.get(key);
  if (c) {
    cache.delete(key);
    cache.set(key, c);
    return c;
  }
  const d = districtPlan(ci, cj);
  const plan = emptyPlan(d.x, d.x + GRID.chunkSize, d.z, d.z + GRID.chunkSize);
  appendDistrict(plan, d, false);
  c = { ci, cj, key, x: d.x, z: d.z, plan, structures: planStructures(plan, false, `p${key}:`) };
  cache.set(key, c);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return c;
}

/** Tallest structure top (m) at (x, z) in the planet city (0 if none), from the chunk's height map. */
export function planetObstacleTop(x: number, z: number): number {
  const [ci, cj] = chunkAt(x, z);
  const c = planetChunk(ci, cj);
  const cell = 20;
  if (!c.heights) {
    const map = new Map<string, number>();
    for (const p of c.structures.list) {
      const top = p.y + p.sy / 2;
      for (let gx = Math.floor((p.x - p.sx / 2) / cell); gx <= Math.floor((p.x + p.sx / 2) / cell); gx++)
        for (let gz = Math.floor((p.z - p.sz / 2) / cell); gz <= Math.floor((p.z + p.sz / 2) / cell); gz++) {
          const k = `${gx},${gz}`;
          map.set(k, Math.max(map.get(k) ?? 0, top));
        }
    }
    c.heights = map;
  }
  const cxw = c.x + mod(x - c.x, C), czw = c.z + mod(z - c.z, C);
  return c.heights.get(`${Math.floor(cxw / cell)},${Math.floor(czw / cell)}`) ?? 0;
}

/** Block kinds in the summary's blue channel. */
export const BLOCK_KIND = { lot: 0, plain: 32, outlands: 64, open: 128, airfield: 192, sea: 255 } as const;

/**
 * Per-block summary of the whole planet (no geometry), RGBA per block:
 * R = monumentality (skyline height / 400), G = region index (low 4 bits) | 16 connector road on
 * its -z edge | 32 connector road on its -x edge | 64 if the block's lot continues to +x (no
 * street on that side) | 128 if it continues to +z (see sim/roadRules.ts),
 * B = kind (BLOCK_KIND), A = Outlands mask. Read by the ground shader (streets, plains,
 * substrate, far LOD) and by traffic (which segments exist).
 */
export function blockSummary(): Uint8Array {
  return (summaryCache ??= buildSummary());
}
let summaryCache: Uint8Array | null = null;

function buildSummary(): Uint8Array {
  const n = GRID.blocks;
  const out = new Uint8Array(n * n * 4);
  for (let gj = 0; gj < n; gj++) for (let gi = 0; gi < n; gi++) {
    const cx = GRID.x0 + (gi + 0.5) * GRID.pitch, cz = GRID.z0 + (gj + 0.5) * GRID.pitch;
    const o = (gj * n + gi) * 4;
    const waste = wastelandByte(gi, gj);
    let kind: number = BLOCK_KIND.lot;
    let region = 0;
    if (isSea(cx)) kind = BLOCK_KIND.sea;
    else if (waste > 0 || nearWasteland(gi, gj)) {
      kind = BLOCK_KIND.outlands;
      region = TERRAIN_ARCHETYPES.indexOf(blockArchetype(gi, gj).primary);
    } else {
      const lot = lotAt(gi, gj);
      if (lot) {
        region = Math.max(0, CITY_REGIONS.indexOf(lot.region as never));
        if (lot.kind === 'open' && lot.region === 'plains') kind = BLOCK_KIND.plain;
      } else kind = heightCap(cx, cz) === 0 ? BLOCK_KIND.airfield : BLOCK_KIND.open;
    }
    const { core, peak } = intensityAt(cx, cz);
    out[o] = Math.min(255, Math.round((Math.min(400, peak * core) / 400) * 255));
    out[o + 1] = region | (kind === BLOCK_KIND.lot && joined(gi, gj, true) ? 64 : 0) | (kind === BLOCK_KIND.lot && joined(gi, gj, false) ? 128 : 0);
    out[o + 2] = kind;
    out[o + 3] = waste;
  }
  // Every road on one network (AGENTS.md §14): islands of streets are
  // linked by connector roads, unlinkable fragments removed, before anyone reads the summary.
  roadStats = connectRoads(out);
  void hash01;
  void CITY;
  return out;
}

/** What the road connection pass did (debug, tests). */
export let roadStats: ReturnType<typeof connectRoads> | null = null;

/**
 * Ground style weights per block (RGBA, linearly filtered by the ground shader so styles blend):
 * R = grid plains / open plain, G = Sea of Simulation, B = canyons and caverns (dark), A = wasteland.
 */
export function terrainStyleSummary(): Uint8Array {
  return (styleCache ??= buildStyles());
}
let styleCache: Uint8Array | null = null;

function buildStyles(): Uint8Array {
  const n = GRID.blocks;
  const s = blockSummary();
  const out = new Uint8Array(n * n * 4);
  const ch: Record<string, number> = { 'grid-plains': 0, sea: 1, canyons: 2, 'mech-caverns': 2, wasteland: 3 };
  for (let k = 0; k < n * n; k++) {
    const kind = s[k * 4 + 2];
    if (kind === BLOCK_KIND.plain) { out[k * 4] = 255; continue; }
    if (kind !== BLOCK_KIND.outlands) continue;
    const gi = k % n, gj = Math.floor(k / n);
    const a = blockArchetype(gi, gj);
    const m = s[k * 4 + 3] / 255;
    out[k * 4 + ch[a.primary]] += Math.round(255 * (1 - a.blend) * Math.max(0.35, m));
    out[k * 4 + ch[a.secondary]] = Math.min(255, out[k * 4 + ch[a.secondary]] + Math.round(255 * a.blend * Math.max(0.35, m)));
  }
  return out;
}
