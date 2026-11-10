import { CITY, GROUND_HELIPADS, hash01, inCentral, isSea, PLANET, PLANET_HUBS, RUNWAYS, wrapCoord } from './layout.ts';

/**
 * The Outlands: vast wastelands outside the cities' boundaries, craggy and treacherous, all
 * sheer rock walls and deep ravines. Height = wasteland mask × geometric landforms (see
 * OUTLANDS). Evaluated identically on the CPU (physics colliders, altitude, the autopilot) and,
 * for the buttes and crags, on the GPU (the far ground disc, see render/terrainNode.ts): the
 * mask lives in one byte per city block (blockSummary's alpha channel, bilinearly blended by
 * hand), and the landforms sit on lattices that divide the circumference, so the terrain is
 * seamless. The mask noise is periodic, integer-hashed value noise.
 */
export const TERRAIN = {
  /** Highest apex (m). */
  peak: 320,
  /** Lattices of landforms: the circumference split this many times (~393 m buttes, ~98 m crags). */
  bigCells: 128,
  smallCells: 512,
  /** Grid of the mask: the city block grid. */
  blocks: 370,
} as const;

const C = PLANET.circumference;
const PITCH = C / TERRAIN.blocks;
const mod = (v: number, m: number) => ((v % m) + m) % m;

/** 32-bit integer hash → [0, 1). Mirrored exactly in TSL (u32 arithmetic wraps the same). */
export function hashLattice(ix: number, iz: number, seed: number): number {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = (h ^ (h >>> 12)) >>> 0;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return (h >>> 8) / 16777216; // 24 bits: exact in a float32 on the GPU too
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Periodic value noise on an n × n lattice over the circumference, in [0, 1]. */
function valueNoise(x: number, z: number, n: number, seed: number): number {
  const cell = C / n;
  const fx = mod(x, C) / cell, fz = mod(z, C) / cell;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fade(fx - ix), tz = fade(fz - iz);
  const x0 = mod(ix, n), x1 = mod(ix + 1, n), z0 = mod(iz, n), z1 = mod(iz + 1, n);
  const a = hashLattice(x0, z0, seed), b = hashLattice(x1, z0, seed);
  const c = hashLattice(x0, z1, seed), d = hashLattice(x1, z1, seed);
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
}

/**
 * The Outlands' landforms (Rule 1: geometry is the foundation). Three lattices that divide the
 * circumference, each cell holding at most one convex solid:
 * - buttes (big lattice): sheer-walled rock blocks, one per cell, inset from the cell edges by a
 *   hashed gap on every side, so neighbouring buttes are split by deep, straight-walled
 *   ravines; walls batter in only BATTER m per metre of height;
 * - crags (small lattice, inner 2 × 2 cells of each butte): needle pyramids on the butte tops;
 * - rubble (fine lattice): sharp low pyramids strewn over ravine floors and basins, the rough
 *   ground light cycles are not built for.
 * Outlands highways (every OUTLAND_HIGHWAY_EVERY-th street line, both ways) cut clean corridors
 * through all three. Ravine floors, basins and highways are all at street level: drivable.
 */
export const OUTLANDS = {
  /** Wall batter: horizontal inset (m) per metre of height (~86.5° walls). */
  batter: 0.06,
  /** Per-side gap between a butte's base and its cell edge (m): ravines are two gaps wide. */
  gapMin: 14,
  gapMax: 44,
  /** Cells whose hash is below this are open basins. */
  basin: 0.18,
  /** Smallest butte footprint side (m): narrower slivers are left out. */
  minSide: 60,
  /** Every Nth street line (370 divide by 37: seamless) is an Outlands highway, both axes. */
  highwayEvery: 37,
  /** Clear half-width of a highway corridor (m). */
  highwayHalf: 32,
  /** Crag base half-size as a fraction of a small cell; its height as a multiple of that. */
  cragBase: 0.3,
  cragSlope: 2.6,
  /** Rubble: fine lattice, presence threshold, base half-size (fraction of a cell), height (m). */
  rubbleCells: 2048,
  rubbleKeep: 0.7,
  rubbleBase: 0.38,
  rubbleHeight: [1.2, 5.5] as const,
} as const;

const HWY = (C / TERRAIN.blocks) * OUTLANDS.highwayEvery;

/** Distance (m) from canonical coordinate `v` to the nearest Outlands highway line on that axis. */
export function highwayDistance(v: number, origin: number): number {
  const t = mod(v - origin, HWY);
  return Math.min(t, HWY - t);
}

/** Nearest highway line (in the same frame as `c`) to the coordinate `c`. */
function nearestLine(c: number, origin: number): number {
  const t = mod(c - origin, HWY);
  return t > HWY / 2 ? c - t + HWY : c - t;
}

/** Clip [a, b] off a corridor of half-width HW around `line`, keeping the wider side. */
function clipSpan(a: number, b: number, line: number): [number, number] {
  const HW = OUTLANDS.highwayHalf;
  if (line < a - HW || line > b + HW) return [a, b];
  const left = line - HW - a, right = b - (line + HW);
  return left >= right ? [a, Math.min(b, line - HW)] : [Math.max(a, line + HW), b];
}

export interface Butte {
  /** Base rectangle (canonical metres, around the cell centre). */
  x0: number; x1: number; z0: number; z1: number;
  /** Height (m). */
  H: number;
  cx: number; cz: number;
}

/** The butte in big-lattice cell (ix, iz), or null (open basin, city, highway). */
export function butteCell(ix: number, iz: number): Butte | null {
  const n = TERRAIN.bigCells;
  const a = mod(ix, n), b = mod(iz, n);
  const h = hashLattice(a, b, 101);
  if (h < OUTLANDS.basin) return null;
  const cell = C / n;
  const cx = (a + 0.5) * cell, cz = (b + 0.5) * cell;
  const w = wastelandAt(cx, cz);
  if (w <= 0) return null;
  const O = OUTLANDS;
  const gap = (s: number) => O.gapMin + (O.gapMax - O.gapMin) * hashLattice(a, b, s);
  let [x0, x1] = [cx - cell / 2 + gap(102), cx + cell / 2 - gap(103)];
  let [z0, z1] = [cz - cell / 2 + gap(104), cz + cell / 2 - gap(105)];
  [x0, x1] = clipSpan(x0, x1, nearestLine(cx, CITY.x0));
  [z0, z1] = clipSpan(z0, z1, nearestLine(cz, CITY.z0));
  if (x1 - x0 < O.minSide || z1 - z0 < O.minSide) return null;
  const H = TERRAIN.peak * (0.25 + 0.75 * ((h - O.basin) / (1 - O.basin))) * w * w;
  if (H < 0.5) return null;
  return { x0, x1, z0, z1, H, cx, cz };
}

/** Height (m) of butte `b` at canonical (px, pz) in its cell (0 outside the base). */
function butteHeight(b: Butte, px: number, pz: number): number {
  const d = Math.min(px - b.x0, b.x1 - px, pz - b.z0, b.z1 - pz);
  return Math.min(b.H, Math.max(0, d / OUTLANDS.batter));
}

export interface Pyramid {
  /** Apex above (cx, cz), base half-size `half` at height `y0`, apex at y0 + H. */
  cx: number; cz: number; half: number; y0: number; H: number;
}

/** The crag in small-lattice cell (sx, sz), standing on its butte's top, or null. */
export function cragCell(sx: number, sz: number): Pyramid | null {
  const n = TERRAIN.smallCells;
  const a = mod(sx, n), b = mod(sz, n);
  const la = a & 3, lb = b & 3;
  if (la === 0 || la === 3 || lb === 0 || lb === 3) return null;
  if (hashLattice(a, b, 211) < 0.55) return null;
  const bt = butteCell(a >> 2, b >> 2);
  if (!bt) return null;
  const cell = C / n;
  const cx = (a + 0.5) * cell, cz = (b + 0.5) * cell;
  const half = OUTLANDS.cragBase * cell;
  const inset = OUTLANDS.batter * bt.H;
  if (cx - half < bt.x0 + inset || cx + half > bt.x1 - inset || cz - half < bt.z0 + inset || cz + half > bt.z1 - inset) return null;
  const H = Math.min(OUTLANDS.cragSlope * half, bt.H * (0.15 + 0.45 * hashLattice(a, b, 218)));
  if (H < 0.5) return null;
  return { cx, cz, half, y0: bt.H, H };
}

/** The rubble shard in fine-lattice cell (rx, rz) (ravine floors and basins), or null. */
export function rubbleCell(rx: number, rz: number): Pyramid | null {
  const O = OUTLANDS;
  const n = O.rubbleCells;
  const a = mod(rx, n), b = mod(rz, n);
  if (hashLattice(a, b, 307) < O.rubbleKeep) return null;
  const cell = C / n;
  const cx = (a + 0.5) * cell, cz = (b + 0.5) * cell;
  const w = wastelandAt(cx, cz);
  if (w < 0.15) return null;
  const half = O.rubbleBase * cell;
  if (highwayDistance(cx, CITY.x0) < O.highwayHalf + half || highwayDistance(cz, CITY.z0) < O.highwayHalf + half) return null;
  const k = n / TERRAIN.bigCells;
  const bt = butteCell(Math.floor(a / k), Math.floor(b / k));
  if (bt && cx > bt.x0 - half && cx < bt.x1 + half && cz > bt.z0 - half && cz < bt.z1 + half) return null;
  const H = (O.rubbleHeight[0] + (O.rubbleHeight[1] - O.rubbleHeight[0]) * hashLattice(a, b, 311)) * Math.min(1, w * 1.6);
  return { cx, cz, half, y0: 0, H };
}

const pyramidHeight = (p: Pyramid, px: number, pz: number) =>
  p.H * Math.max(0, 1 - Math.max(Math.abs(px - p.cx), Math.abs(pz - p.cz)) / p.half);

/** Pyramid hull: 4 base corners and the apex (world metres). */
function pyramidHull(p: Pyramid, cx: number, cz: number): Float32Array {
  const pts: number[] = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) pts.push(cx + sx * p.half, p.y0, cz + sz * p.half);
  pts.push(cx, p.y0 + p.H, cz);
  return new Float32Array(pts);
}

/**
 * Every butte, crag and rubble shard whose cell centre lies in the canonical rectangle
 * [x0, x1) × [z0, z1), as a convex hull in world metres: their union is exactly the terrain
 * surface, so physics can use them directly.
 */
export function solidHulls(x0: number, z0: number, x1: number, z1: number): Float32Array[] {
  const out: Float32Array[] = [];
  /** Lattice cells whose centre may fall in the rectangle, with the centre's image in it. */
  const each = (n: number, f: (ix: number, iz: number, img: (cx: number, cz: number) => [number, number] | null) => void) => {
    const cell = C / n;
    const i0 = Math.floor(mod(x0, C) / cell) - 1, j0 = Math.floor(mod(z0, C) / cell) - 1;
    const i1 = i0 + Math.ceil((x1 - x0) / cell) + 2, j1 = j0 + Math.ceil((z1 - z0) / cell) + 2;
    const img = (cx: number, cz: number): [number, number] | null => {
      const ix = x0 + mod(cx - x0, C), iz = z0 + mod(cz - z0, C);
      return ix >= x1 || iz >= z1 ? null : [ix, iz];
    };
    for (let ix = i0; ix <= i1; ix++) for (let iz = j0; iz <= j1; iz++) f(ix, iz, img);
  };
  each(TERRAIN.bigCells, (ix, iz, img) => {
    const b = butteCell(ix, iz);
    if (!b) return;
    const at = img(b.cx, b.cz);
    if (!at) return;
    const ox = at[0] - b.cx, oz = at[1] - b.cz;
    const t = OUTLANDS.batter * b.H;
    const pts: number[] = [];
    for (const [x, z] of [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1]]) pts.push(x + ox, 0, z + oz);
    for (const [x, z] of [[b.x0 + t, b.z0 + t], [b.x1 - t, b.z0 + t], [b.x0 + t, b.z1 - t], [b.x1 - t, b.z1 - t]]) pts.push(x + ox, b.H, z + oz);
    out.push(new Float32Array(pts));
  });
  each(TERRAIN.smallCells, (ix, iz, img) => {
    const p = cragCell(ix, iz);
    const at = p && img(p.cx, p.cz);
    if (p && at) out.push(pyramidHull(p, at[0], at[1]));
  });
  each(OUTLANDS.rubbleCells, (ix, iz, img) => {
    const p = rubbleCell(ix, iz);
    const at = p && img(p.cx, p.cz);
    if (p && at) out.push(pyramidHull(p, at[0], at[1]));
  });
  return out;
}

/** Wasteland strength of block (gi, gj) as a byte (0 = city, 255 = deep Outlands). */
export function wastelandByte(gi: number, gj: number): number {
  const x = CITY.x0 + (mod(gi, TERRAIN.blocks) + 0.5) * PITCH;
  const z = CITY.z0 + (mod(gj, TERRAIN.blocks) + 0.5) * PITCH;
  if (isSea(x) || inCentral(x, z, 1500)) return 0;
  // Large regions from two octaves of slow noise (~30% of the land).
  const n = 0.65 * valueNoise(x, z, 7, 41) + 0.35 * valueNoise(x, z, 14, 43);
  let m = Math.min(1, Math.max(0, (n - 0.51) / 0.14));
  if (m <= 0) return 0;
  // Keep hubs, airfields, pads and the coast in the Grid.
  const fadeNear = (dx: number, dz: number, r0: number, r1: number) => {
    const d = Math.hypot(wrapCoord(dx), wrapCoord(dz));
    return d < r0 ? 0 : d > r1 ? 1 : (d - r0) / (r1 - r0);
  };
  for (const h of PLANET_HUBS) m *= fadeNear(x - h.x, z - h.z, h.r * 1.2, h.r * 2.2);
  for (const r of RUNWAYS) m *= fadeNear(x - r.x, z - r.z, r.length / 2 + 1500, r.length / 2 + 2600);
  for (const p of GROUND_HELIPADS) m *= fadeNear(x - p.x, z - p.z, 300, 700);
  const coast = Math.abs(wrapCoord(x - 2500)), coast2 = Math.abs(wrapCoord(x - 8500));
  m *= Math.min(1, Math.min(coast, coast2) / 1500);
  void hash01;
  return Math.round(m * 255);
}

let maskCache: Uint8Array | null = null;
/** All block masks (row-major, z rows), shared with the GPU via blockSummary. */
export function wastelandMask(): Uint8Array {
  if (maskCache) return maskCache;
  const n = TERRAIN.blocks;
  const out = new Uint8Array(n * n);
  for (let gj = 0; gj < n; gj++) for (let gi = 0; gi < n; gi++) out[gj * n + gi] = wastelandByte(gi, gj);
  return (maskCache = out);
}

/** Bilinear mask at (x, z) from the four nearest block centres (0..1). */
export function wastelandAt(x: number, z: number): number {
  const n = TERRAIN.blocks;
  const m = wastelandMask();
  const u = mod(x - CITY.x0, C) / PITCH - 0.5;
  const v = mod(z - CITY.z0, C) / PITCH - 0.5;
  const i = Math.floor(u), j = Math.floor(v);
  const tu = u - i, tv = v - j;
  const at = (a: number, b: number) => m[mod(b, n) * n + mod(a, n)] / 255;
  const top = at(i, j) + (at(i + 1, j) - at(i, j)) * tu;
  const bot = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tu;
  return top + (bot - top) * tv;
}

/** Terrain height (m) above the street level at (x, z): 0 in the Grid, butte, crag or rubble in the Outlands. */
export function terrainHeight(x: number, z: number): number {
  const px = mod(x, C), pz = mod(z, C);
  const big = C / TERRAIN.bigCells, small = C / TERRAIN.smallCells, fine = C / OUTLANDS.rubbleCells;
  const b = butteCell(Math.floor(px / big), Math.floor(pz / big));
  let h = 0;
  if (b) {
    h = butteHeight(b, px, pz);
    if (h >= b.H) {
      const c = cragCell(Math.floor(px / small), Math.floor(pz / small));
      if (c) h += pyramidHeight(c, px, pz);
    }
  }
  if (h > 0) return h;
  const r = rubbleCell(Math.floor(px / fine), Math.floor(pz / fine));
  return r ? pyramidHeight(r, px, pz) : 0;
}

/** Is block (gi, gj) or any neighbour in the Outlands (so no tower sits on a slope)? */
export function nearWasteland(gi: number, gj: number): boolean {
  const n = TERRAIN.blocks;
  const m = wastelandMask();
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (m[mod(gj + b, n) * n + mod(gi + a, n)] > 0) return true;
  return false;
}

/** Does planet chunk (ci, cj) (10 × 10 blocks) have any Outlands terrain, including its border? */
export function chunkHasTerrain(ci: number, cj: number): boolean {
  const n = TERRAIN.blocks;
  const m = wastelandMask();
  for (let a = -1; a <= 10; a++) for (let b = -1; b <= 10; b++) if (m[mod(cj * 10 + b, n) * n + mod(ci * 10 + a, n)] > 0) return true;
  return false;
}
