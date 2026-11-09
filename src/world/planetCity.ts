import { CITY, COAST, hash01, heightCap, heightCapRect, isSea, PLANET, PLANET_HUBS, wrapCoord } from '../sim/layout.ts';
import { nearWasteland, wastelandByte } from '../sim/terrain.ts';
import { makeTowerBuilder, mulberry32, type CityPlan } from './City.ts';
import { KIT } from './kit.ts';
import { planStructures, type Structures } from './structures.ts';

/**
 * The rest of the planet: one seamless street grid (370 blocks around, see CITY.block) cut into
 * 37 × 37 chunks of 10 × 10 blocks. Each chunk's towers are generated on demand from its own
 * seed with the same rules as the hand-built centre (hub skyline, kit towers, zoning around
 * airfields and pads), so the city goes all the way around. The centre's blocks and the ocean
 * are skipped. Chunks are canonical in [x0, x0 + C); users add a whole-circumference image
 * offset to bring a chunk next to the viewer.
 */
export const GRID = (() => {
  const pitch = CITY.block + CITY.street;
  const blocks = Math.round(PLANET.circumference / pitch); // 370
  const chunkBlocks = 10;
  return {
    pitch,
    blocks,
    chunkBlocks,
    chunks: blocks / chunkBlocks,
    chunkSize: pitch * chunkBlocks,
    x0: CITY.x0,
    z0: CITY.z0,
    /** Blocks the centre covers (from x0, z0): the same count buildCity uses. */
    centralX: Math.floor((CITY.x1 - CITY.x0) / pitch),
    centralZ: Math.floor((CITY.z1 - CITY.z0) / pitch),
  };
})();

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
  let h = base;
  let core = 0;
  for (const hub of [...CITY.hubs, ...PLANET_HUBS]) {
    const dx = wrapCoord(x - hub.x), dz = wrapCoord(z - hub.z);
    const d2 = (dx * dx + dz * dz) / (hub.r * hub.r);
    if (d2 > 9) continue;
    const k = Math.exp(-d2);
    h = Math.max(h, hub.h * k ** 1.3);
    core = Math.max(core, k);
  }
  return { h, core };
}

/** Is block (gi, gj) one the hand-built centre already fills? */
export function isCentralBlock(gi: number, gj: number): boolean {
  return mod(gi, GRID.blocks) < GRID.centralX && mod(gj, GRID.blocks) < GRID.centralZ;
}

const cache = new Map<string, PlanetChunk>();
const MAX_CACHED = 400;

/** The chunk (generated once, then cached; oldest entries are dropped past MAX_CACHED). */
export function planetChunk(ci: number, cj: number): PlanetChunk {
  ci = mod(ci, GRID.chunks);
  cj = mod(cj, GRID.chunks);
  const key = `${ci},${cj}`;
  let c = cache.get(key);
  if (c) {
    cache.delete(key);
    cache.set(key, c); // most recently used last
    return c;
  }
  c = generate(ci, cj, key);
  cache.set(key, c);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return c;
}

function generate(ci: number, cj: number, key: string): PlanetChunk {
  const def = CITY;
  const rnd = mulberry32((def.seed * 7919) ^ (ci * 73856093) ^ (cj * 19349663));
  const x = GRID.x0 + ci * GRID.chunkSize;
  const z = GRID.z0 + cj * GRID.chunkSize;
  const plan: CityPlan = {
    pieces: [], buildings: [], spires: [], rings: [], beacons: [], roads: [], kit: [],
    x0: x, x1: x + GRID.chunkSize, z0: z, z1: z + GRID.chunkSize, pitch: GRID.pitch,
  };
  const pickColor = () => Math.floor(rnd() * def.colors.length);
  const addTower = makeTowerBuilder(plan, rnd, pickColor);
  for (let bi = 0; bi < GRID.chunkBlocks; bi++) {
    for (let bj = 0; bj < GRID.chunkBlocks; bj++) {
      const gi = ci * GRID.chunkBlocks + bi;
      const gj = cj * GRID.chunkBlocks + bj;
      if (isCentralBlock(gi, gj) || nearWasteland(gi, gj)) continue;
      const xa = x + bi * GRID.pitch + def.street / 2;
      const za = z + bj * GRID.pitch + def.street / 2;
      const xb = xa + def.block, zb = za + def.block;
      if (isSea(xa) || isSea(xb)) continue;
      const cap = heightCapRect(xa, za, xb, zb);
      if (cap < def.minHeight) continue;
      const cx = (xa + xb) / 2, cz = (za + zb) / 2;
      // Dense: a slightly taller base than the centre and fewer empty plazas.
      const { h: sky, core } = skyline(cx, cz, 26 * (0.6 + rnd() * 0.9));
      if (rnd() < 0.03 + 0.05 * (1 - core)) continue;
      if (rnd() < (core > 0.6 ? def.kitCoreFraction : def.kitFraction) && cap > 45) {
        const type = Math.floor(rnd() * KIT.length);
        const t = KIT[type];
        const rot = Math.floor(rnd() * 4);
        const want = Math.min(cap * 0.96, Math.max(45, sky * (0.8 + rnd() * 0.5)));
        const scale = Math.min(want / t.size[1], 96 / Math.max(t.size[0], t.size[2]));
        plan.kit.push({ type, x: cx, z: cz, scale, rot });
        continue;
      }
      const tall = Math.min(cap, sky);
      if (core > 0.7 || rnd() < 0.5) {
        addTower(cx, cz, 34 + rnd() * 30, Math.max(def.minHeight, Math.min(cap, tall * (0.6 + rnd() * 0.6))));
      } else {
        for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          if (rnd() < 0.15) continue;
          addTower(cx + ox * 27, cz + oz * 27, 18 + rnd() * 16, Math.max(def.minHeight, Math.min(cap, tall * (0.3 + rnd() * 0.5))));
        }
      }
    }
  }
  return { ci, cj, key, x, z, plan, structures: planStructures(plan, false, `p${key}:`) };
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
  // Into the chunk's canonical frame.
  const cxw = c.x + mod(x - c.x, C), czw = c.z + mod(z - c.z, C);
  return c.heights.get(`${Math.floor(cxw / cell)},${Math.floor(czw / cell)}`) ?? 0;
}

/**
 * Far-LOD summary of every block on the planet (no geometry): RGBA per block, R = skyline
 * height / 400, G = colour index, B = kind (0 city, 128 open/zoned, 192 airfield, 255 sea).
 * Drawn by the ground shader as city lights beyond the box LOD, and seen from orbit.
 */
let summaryCache: Uint8Array | null = null;
export function blockSummary(): Uint8Array {
  return (summaryCache ??= buildSummary()); // shared by the ground shader and the traffic (read-only)
}

function buildSummary(): Uint8Array {
  const n = GRID.blocks;
  const out = new Uint8Array(n * n * 4);
  for (let gj = 0; gj < n; gj++) for (let gi = 0; gi < n; gi++) {
    const xa = GRID.x0 + gi * GRID.pitch + CITY.street / 2;
    const za = GRID.z0 + gj * GRID.pitch + CITY.street / 2;
    const cx = xa + CITY.block / 2, cz = za + CITY.block / 2;
    const o = (gj * n + gi) * 4;
    let kind = 0;
    const waste = wastelandByte(gi, gj);
    if (isSea(cx)) kind = 255;
    else if (waste > 0 || nearWasteland(gi, gj)) kind = 64;
    else {
      const cap = heightCap(cx, cz);
      if (cap === 0) kind = 192;
      else if (cap < CITY.minHeight || hash01(gi, gj, 7) < 0.06) kind = 128;
    }
    const { h } = skyline(cx, cz, 26 * (0.6 + hash01(gi, gj, 8) * 0.9));
    out[o] = Math.min(255, Math.round((Math.min(h, 400) / 400) * 255));
    out[o + 1] = Math.floor(hash01(gi, gj, 9) * CITY.colors.length);
    out[o + 2] = kind;
    out[o + 3] = waste; // Off-Grid mask: the terrain shader blends it exactly like terrain.ts
  }
  void COAST;
  return out;
}
