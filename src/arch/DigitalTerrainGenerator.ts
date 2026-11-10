import { CITY, PLANET } from '../sim/layout.ts';
import { GRID, mod } from './grid.ts';
import { hashFloat } from './rng.ts';
import { outlandsStrength, regionWeights, TERRAIN_ARCHETYPES, type TerrainArchetype } from './WorldRegionManager.ts';
import { onWorldReset, WORLD } from './world.ts';

/**
 * The Outlands: immense abstract computational landscapes outside the civilised regions.
 *
 * Not Earth terrain with neon applied: every landform is an exact geometric solid placed by
 * deterministic lattice rules (no noise heightfield), so the drawn surface is exactly the one
 * physics collides with (each solid becomes one convex hull) and generation is identical
 * across chunk boundaries (a solid belongs to the chunk holding its lattice cell's centre).
 *
 * Terrain archetypes, chosen per cell from the blend of the nearest Outlands region sites
 * (dithered, so borders are transitional regions mixing two archetypes):
 * - grid-plains: broad uninterrupted grid surfaces, occasional elevated platforms and markers;
 * - sea (Sea of Simulation, book p. 54): smooth pale swells, domes and lenses flowing in bands,
 *   orbs floating overhead;
 * - canyons (pp. 55, 60): immense angular stepped mesas separated by narrow passages and
 *   recessed valleys, crags on their tops, rubble on the floors;
 * - wasteland: sparse isolated polygonal formations (monoliths, pyramids, tilted slabs,
 *   balanced octahedra, tapered prisms) on empty ground;
 * - mech-caverns: enormous voids under massive roof slabs carried by pillars and walls, open
 *   shafts of light between them, machinery on the floor.
 * Three lattices divide the circumference (seamless): big (~393 m) primary landforms, small
 * (~98 m) secondary formations, fine (~25 m) rubble. Outlands highways cut clean corridors.
 */
export const TERRAIN = {
  peak: 300,
  bigCells: 128,
  smallCells: 512,
  fineCells: 2048,
  blocks: 370,
} as const;

export const OUTLANDS = {
  /** Every Nth street line (370 divides by 37: seamless) runs on through the Outlands. */
  highwayEvery: 37,
  /** Clear half-width of a highway corridor (m). */
  highwayHalf: 32,
  /** Clearing radius around an Outlands landmark (m). */
  landmarkClear: 240,
} as const;

const C = PLANET.circumference;
const PITCH = C / TERRAIN.blocks;
const HWY = PITCH * OUTLANDS.highwayEvery;
const h01 = (a: number, b: number, salt: number) => hashFloat(WORLD.seed, a, b, salt);

export type LandformShape = 'frustum' | 'pyramid' | 'dome' | 'sphere' | 'slab' | 'prism' | 'octa';

export interface Landform {
  shape: LandformShape;
  arch: TerrainArchetype;
  tier: 1 | 2 | 3;
  /** Canonical centre of the base and base elevation (m). */
  cx: number;
  cz: number;
  y0: number;
  /** frustum: base w × d, top wt × dt; slab: box w × h × d; height h for all but sphere. */
  w: number;
  d: number;
  wt: number;
  dt: number;
  h: number;
  /** pyramid/octa: base half-size; prism: base and top radii, sides; dome: radii rx (w/2), rz (d/2); sphere: r. */
  half: number;
  r0: number;
  r1: number;
  sides: number;
  /** Rotation about +Y and tilts (rad). */
  ry: number;
  rx: number;
  rz: number;
  /** Floating above the ground (roof slab, orb): not part of the ground surface. */
  overhead: boolean;
  /** Stable per-landform hash (colour variety). */
  id: number;
}

function form(p: Partial<Landform> & Pick<Landform, 'shape' | 'arch' | 'cx' | 'cz'>): Landform {
  return { tier: 1, y0: 0, w: 0, d: 0, wt: 0, dt: 0, h: 0, half: 0, r0: 0, r1: 0, sides: 4, ry: 0, rx: 0, rz: 0, overhead: false, id: 0, ...p };
}

// --- Per-block mask and archetype (the region blend sampled once per city block) ---

interface BlockTerrain {
  mask: Uint8Array;
  primary: Uint8Array;
  secondary: Uint8Array;
  blend: Uint8Array;
}
let blockCache: BlockTerrain | null = null;
const bigCache = new Map<number, Landform[]>();
const smallCache = new Map<number, Landform[]>();
let landmarkCache: OutlandsLandmark[] | null = null;
onWorldReset(() => { blockCache = null; bigCache.clear(); smallCache.clear(); landmarkCache = null; });

function blockTerrain(): BlockTerrain {
  if (blockCache) return blockCache;
  const n = TERRAIN.blocks;
  const out: BlockTerrain = { mask: new Uint8Array(n * n), primary: new Uint8Array(n * n), secondary: new Uint8Array(n * n), blend: new Uint8Array(n * n) };
  for (let gj = 0; gj < n; gj++) for (let gi = 0; gi < n; gi++) {
    const x = CITY.x0 + (gi + 0.5) * PITCH, z = CITY.z0 + (gj + 0.5) * PITCH;
    const k = gj * n + gi;
    const m = outlandsStrength(x, z);
    out.mask[k] = Math.round(m * 255);
    if (m <= 0) continue;
    const w = regionWeights(x, z, 3, (s) => s.kind === 'outlands');
    if (!w.length) continue;
    const a = TERRAIN_ARCHETYPES.indexOf(w[0].site.terrain);
    let b = a, t = 0;
    for (let i = 1; i < w.length; i++) if (w[i].site.terrain !== w[0].site.terrain) { b = TERRAIN_ARCHETYPES.indexOf(w[i].site.terrain); t = w[i].w; break; }
    out.primary[k] = a;
    out.secondary[k] = b;
    out.blend[k] = Math.round(t * 255);
  }
  return (blockCache = out);
}

/** Outlands strength of block (gi, gj) as a byte (0 = civilised, 255 = deep Outlands). */
export function wastelandByte(gi: number, gj: number): number {
  const n = TERRAIN.blocks;
  return blockTerrain().mask[mod(gj, n) * n + mod(gi, n)];
}

/** All block masks (row-major, z rows). */
export function wastelandMask(): Uint8Array {
  return blockTerrain().mask;
}

/** Bilinear Outlands strength at (x, z) (0..1). */
export function wastelandAt(x: number, z: number): number {
  const n = TERRAIN.blocks;
  const m = blockTerrain().mask;
  const u = mod(x - CITY.x0, C) / PITCH - 0.5, v = mod(z - CITY.z0, C) / PITCH - 0.5;
  const i = Math.floor(u), j = Math.floor(v);
  const tu = u - i, tv = v - j;
  const at = (a: number, b: number) => m[mod(b, n) * n + mod(a, n)] / 255;
  const top = at(i, j) + (at(i + 1, j) - at(i, j)) * tu;
  const bot = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tu;
  return top + (bot - top) * tv;
}

/** Dominant terrain archetype of a block, its blend partner and the partner's weight (0..1). */
export function blockArchetype(gi: number, gj: number): { primary: TerrainArchetype; secondary: TerrainArchetype; blend: number } {
  const n = TERRAIN.blocks;
  const t = blockTerrain();
  const k = mod(gj, n) * n + mod(gi, n);
  return { primary: TERRAIN_ARCHETYPES[t.primary[k]], secondary: TERRAIN_ARCHETYPES[t.secondary[k]], blend: t.blend[k] / 255 };
}

/** Archetype for a lattice cell at (x, z): the block's blend dithered by the cell's own hash. */
function archAt(x: number, z: number, u: number): TerrainArchetype {
  const gi = Math.floor(mod(x - CITY.x0, C) / PITCH), gj = Math.floor(mod(z - CITY.z0, C) / PITCH);
  const a = blockArchetype(gi, gj);
  return u < a.blend * 0.9 ? a.secondary : a.primary;
}

/** Is block (gi, gj) or any neighbour in the Outlands (so no civilised structure sits on terrain)? */
export function nearWasteland(gi: number, gj: number): boolean {
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (wastelandByte(gi + a, gj + b) > 0) return true;
  return false;
}

/** Does planet chunk (ci, cj) (10 × 10 blocks) have any Outlands terrain, including its border? */
export function chunkHasTerrain(ci: number, cj: number): boolean {
  for (let a = -1; a <= 10; a++) for (let b = -1; b <= 10; b++) if (wastelandByte(ci * 10 + a, cj * 10 + b) > 0) return true;
  return false;
}

// --- Highways ---

/** Distance (m) from canonical coordinate `v` to the nearest Outlands highway line on that axis. */
export function highwayDistance(v: number, origin: number): number {
  const t = mod(v - origin, HWY);
  return Math.min(t, HWY - t);
}

function nearestLine(c: number, origin: number): number {
  const t = mod(c - origin, HWY);
  return t > HWY / 2 ? c - t + HWY : c - t;
}

function clipSpan(a: number, b: number, line: number): [number, number] {
  const HW = OUTLANDS.highwayHalf;
  if (line < a - HW || line > b + HW) return [a, b];
  const left = line - HW - a, right = b - (line + HW);
  return left >= right ? [a, Math.min(b, line - HW)] : [Math.max(a, line + HW), b];
}

const inCorridor = (x: number, z: number, r: number) =>
  highwayDistance(x, CITY.x0) < OUTLANDS.highwayHalf + r || highwayDistance(z, CITY.z0) < OUTLANDS.highwayHalf + r;

// --- Landmarks: sparse monumental sites deep in the Outlands, kept clear of landforms ---

export interface OutlandsLandmark {
  x: number;
  z: number;
  arch: TerrainArchetype;
  i: number;
  j: number;
}

/** Outlands landmark sites (cached per seed): a ~2 km lattice, deep Outlands only, sparse. */
export function outlandsLandmarks(): OutlandsLandmark[] {
  if (landmarkCache) return landmarkCache;
  const n = 24, cell = C / n;
  const out: OutlandsLandmark[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (h01(i, j, 601) > 0.34) continue;
    const x = (i + 0.5 + (h01(i, j, 602) - 0.5) * 0.5) * cell;
    const z = (j + 0.5 + (h01(i, j, 603) - 0.5) * 0.5) * cell;
    if (wastelandAt(x, z) < 0.9) continue;
    // Keep the landmark off the highway corridors.
    if (inCorridor(x, z, OUTLANDS.landmarkClear * 0.6)) continue;
    out.push({ x, z, arch: archAt(x, z, h01(i, j, 604)), i, j });
  }
  return (landmarkCache = out);
}

function nearLandmark(x: number, z: number, r: number): boolean {
  for (const l of outlandsLandmarks()) {
    const dx = Math.abs(mod(x - l.x + C / 2, C) - C / 2), dz = Math.abs(mod(z - l.z + C / 2, C) - C / 2);
    if (dx < r + OUTLANDS.landmarkClear && dz < r + OUTLANDS.landmarkClear) return true;
  }
  return false;
}

// --- Landform lattices ---

/** Primary landforms of big-lattice cell (ix, iz) (cached). */
export function bigCellForms(ix: number, iz: number): Landform[] {
  const n = TERRAIN.bigCells;
  const a = mod(ix, n), b = mod(iz, n);
  const key = a * n + b;
  let f = bigCache.get(key);
  if (f) return f;
  f = makeBig(a, b);
  bigCache.set(key, f);
  if (bigCache.size > 6000) bigCache.delete(bigCache.keys().next().value!);
  return f;
}

function makeBig(a: number, b: number): Landform[] {
  const cell = C / TERRAIN.bigCells;
  const cx = (a + 0.5) * cell, cz = (b + 0.5) * cell;
  const w = wastelandAt(cx, cz);
  if (w <= 0.03) return [];
  if (nearLandmark(cx, cz, cell * 0.5)) return [];
  const arch = archAt(cx, cz, h01(a, b, 401));
  const hb = h01(a, b, 101);
  const id = Math.floor(h01(a, b, 99) * 1e6);
  const out: Landform[] = [];
  /** Cell rectangle inset by hashed gaps on each side and clipped off highway corridors. */
  const rect = (gMin: number, gMax: number) => {
    const gap = (s: number) => gMin + (gMax - gMin) * h01(a, b, s);
    let [x0, x1] = [cx - cell / 2 + gap(102), cx + cell / 2 - gap(103)];
    let [z0, z1] = [cz - cell / 2 + gap(104), cz + cell / 2 - gap(105)];
    [x0, x1] = clipSpan(x0, x1, nearestLine(cx, CITY.x0));
    [z0, z1] = clipSpan(z0, z1, nearestLine(cz, CITY.z0));
    return { x0, x1, z0, z1 };
  };
  const frustum = (x0: number, x1: number, z0: number, z1: number, y0: number, h: number, batter: number, tier: 1 | 2 | 3, overhead = false) => {
    const t = batter * h;
    out.push(form({ shape: 'frustum', arch, tier, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, y0, w: x1 - x0, d: z1 - z0, wt: Math.max(1, x1 - x0 - 2 * t), dt: Math.max(1, z1 - z0 - 2 * t), h, overhead, id: id + out.length }));
  };

  if (arch === 'canyons') {
    if (hb < 0.14) return []; // a recessed valley
    const r = rect(5, 26); // narrow passages between neighbouring mesas
    if (r.x1 - r.x0 < 50 || r.z1 - r.z0 < 50) return [];
    const H = TERRAIN.peak * (0.3 + 0.7 * ((hb - 0.14) / 0.86)) * w * w;
    if (H < 4) return [];
    const batter = 0.03 + 0.08 * h01(a, b, 106);
    const tiers = H > 110 ? 1 + Math.floor(h01(a, b, 107) * 3) : 1;
    let { x0, x1, z0, z1 } = r;
    let y = 0;
    for (let k = 0; k < tiers; k++) {
      const hk = k === tiers - 1 ? H - y : H * (0.45 + 0.2 * h01(a, b, 110 + k)) / (tiers - k > 1 ? 1.4 : 1);
      if (x1 - x0 < 30 || z1 - z0 < 30 || hk < 3) break;
      frustum(x0, x1, z0, z1, y, hk, batter, k === 0 ? 1 : 2);
      const t = batter * hk;
      const terrace = 10 + 22 * h01(a, b, 120 + k);
      // Terraces step in on two or four sides (asymmetric steps read as engineered).
      const sides = h01(a, b, 125 + k);
      x0 += t + (sides > 0.3 ? terrace : 0); x1 -= t + (sides < 0.7 ? terrace : 0);
      z0 += t + (sides > 0.5 ? terrace : 0); z1 -= t + terrace;
      y += hk;
    }
  } else if (arch === 'grid-plains') {
    if (hb > 0.24) return [];
    const side = cell * (0.3 + 0.45 * h01(a, b, 130));
    const dep = cell * (0.25 + 0.4 * h01(a, b, 131));
    const ox = (h01(a, b, 132) - 0.5) * (cell - side) * 0.8, oz = (h01(a, b, 133) - 0.5) * (cell - dep) * 0.8;
    let x0 = cx + ox - side / 2, x1 = cx + ox + side / 2, z0 = cz + oz - dep / 2, z1 = cz + oz + dep / 2;
    [x0, x1] = clipSpan(x0, x1, nearestLine(cx, CITY.x0));
    [z0, z1] = clipSpan(z0, z1, nearestLine(cz, CITY.z0));
    if (x1 - x0 < 40 || z1 - z0 < 40) return [];
    const h1 = (4 + 12 * h01(a, b, 134)) * Math.max(0.4, w);
    frustum(x0, x1, z0, z1, 0, h1, 0.12, 1);
    if (h01(a, b, 135) < 0.45) {
      const ix = (x1 - x0) * 0.25, iz = (z1 - z0) * 0.25;
      frustum(x0 + ix, x1 - ix, z0 + iz, z1 - iz, h1, h1 * 0.6, 0.12, 2);
    }
  } else if (arch === 'sea') {
    const nd = 1 + Math.floor(hb * 2.6);
    // Swells flow in broad bands: orientation from a slow periodic field.
    const flow = 0.7 * Math.sin((2 * Math.PI * cx) / (C / 23)) + 0.7 * Math.cos((2 * Math.PI * cz) / (C / 29));
    for (let k = 0; k < nd; k++) {
      const u = h01(a, b, 140 + k);
      const R = (28 + 62 * u) * Math.sqrt(Math.max(0.2, w));
      const e = 1 + 1.6 * h01(a, b, 145 + k);
      const rx = Math.min(R * e, cell * 0.42), rz = Math.min(R, cell * 0.3);
      const px = cx + (h01(a, b, 150 + k) - 0.5) * cell * 0.4, pz = cz + (h01(a, b, 155 + k) - 0.5) * cell * 0.4;
      if (inCorridor(px, pz, Math.max(rx, rz))) continue;
      out.push(form({ shape: 'dome', arch, tier: 1, cx: px, cz: pz, w: rx * 2, d: rz * 2, h: R * (0.35 + 0.55 * h01(a, b, 160 + k)) * w, ry: flow + (u - 0.5) * 0.5, id: id + k }));
    }
    if (h01(a, b, 165) < 0.07) {
      const r = 14 + 34 * h01(a, b, 166);
      out.push(form({ shape: 'sphere', arch, tier: 2, cx: cx + (h01(a, b, 167) - 0.5) * cell * 0.5, cz: cz + (h01(a, b, 168) - 0.5) * cell * 0.5, y0: 120 + 260 * h01(a, b, 169), r0: r, h: 2 * r, overhead: true, id: id + 9 }));
    }
  } else if (arch === 'wasteland') {
    if (hb > 0.38) return [];
    const kind = h01(a, b, 170);
    const px = cx + (h01(a, b, 171) - 0.5) * cell * 0.4, pz = cz + (h01(a, b, 172) - 0.5) * cell * 0.4;
    const s = 0.5 + 0.5 * w;
    const ry = h01(a, b, 173) * Math.PI;
    if (inCorridor(px, pz, 90)) return [];
    if (kind < 0.22) {
      const fw = (8 + 10 * h01(a, b, 174)) * s, fd = (3 + 5 * h01(a, b, 175)) * s;
      out.push(form({ shape: 'frustum', arch, cx: px, cz: pz, w: fw, d: fd, wt: fw * 0.86, dt: fd * 0.86, h: (40 + 90 * h01(a, b, 176)) * s, ry: Math.round(ry / (Math.PI / 2)) * (Math.PI / 2), id }));
    } else if (kind < 0.45) {
      out.push(form({ shape: 'pyramid', arch, cx: px, cz: pz, half: (25 + 45 * h01(a, b, 177)) * s, h: (40 + 110 * h01(a, b, 178)) * s, ry, id }));
    } else if (kind < 0.65) {
      out.push(form({ shape: 'slab', arch, cx: px, cz: pz, y0: -4, w: (50 + 40 * h01(a, b, 179)) * s, h: (6 + 6 * h01(a, b, 180)) * s, d: (25 + 15 * h01(a, b, 181)) * s, ry, rx: 0.3 + 0.5 * h01(a, b, 182), id }));
    } else if (kind < 0.82) {
      const hf = (18 + 28 * h01(a, b, 183)) * s;
      out.push(form({ shape: 'octa', arch, cx: px, cz: pz, half: hf * 0.8, h: hf, ry: Math.PI / 4, id }));
    } else {
      const r0 = (15 + 15 * h01(a, b, 184)) * s;
      out.push(form({ shape: 'prism', arch, cx: px, cz: pz, sides: 6, r0, r1: r0 * 0.6, h: (30 + 60 * h01(a, b, 185)) * s, ry, id }));
    }
  } else {
    // mech-caverns: superblocks of 3 × 3 cells share a roof height, so voids interconnect.
    const Y = 70 + 80 * hashFloat(WORLD.seed, Math.floor(a / 3), Math.floor(b / 3), 501);
    const r = rect(4, 11);
    if (r.x1 - r.x0 < 60 || r.z1 - r.z0 < 60) return [];
    const shaft = hb < 0.2;
    const T = 18 + 20 * h01(a, b, 190);
    if (!shaft && w > 0.45) frustum(r.x0, r.x1, r.z0, r.z1, Y, T, 0, 1, true);
    const walls = h01(a, b, 191) < 0.3;
    const pillarTop = shaft || w <= 0.45 ? Y * (0.5 + 0.5 * h01(a, b, 192)) : Y;
    if (walls) {
      // Two long walls with a passage through the middle of each.
      const alongX = h01(a, b, 193) < 0.5;
      for (const s of [-1, 1]) {
        const off = s * (alongX ? r.z1 - r.z0 : r.x1 - r.x0) * 0.28;
        const len = (alongX ? r.x1 - r.x0 : r.z1 - r.z0) * 0.42;
        for (const side of [-1, 1]) {
          const mid = side * len * 0.62;
          const x = alongX ? (r.x0 + r.x1) / 2 + mid : (r.x0 + r.x1) / 2 + off;
          const z = alongX ? (r.z0 + r.z1) / 2 + off : (r.z0 + r.z1) / 2 + mid;
          const ww = alongX ? len * 0.76 : 14, dd = alongX ? 14 : len * 0.76;
          frustum(x - ww / 2, x + ww / 2, z - dd / 2, z + dd / 2, 0, pillarTop, 0, 2);
        }
      }
    } else {
      const k = h01(a, b, 194) < 0.5 ? 2 : 3;
      const ps = 16 + 18 * h01(a, b, 195);
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
        const x = r.x0 + ((i + 0.5) * (r.x1 - r.x0)) / k, z = r.z0 + ((j + 0.5) * (r.z1 - r.z0)) / k;
        if (inCorridor(x, z, ps)) continue;
        frustum(x - ps / 2, x + ps / 2, z - ps / 2, z + ps / 2, 0, pillarTop, 0, 2);
      }
    }
  }
  return out;
}

/** Secondary formations of small-lattice cell (sx, sz) (cached). */
export function smallCellForms(sx: number, sz: number): Landform[] {
  const n = TERRAIN.smallCells;
  const a = mod(sx, n), b = mod(sz, n);
  const key = a * n + b;
  let f = smallCache.get(key);
  if (f) return f;
  f = makeSmall(a, b);
  smallCache.set(key, f);
  if (smallCache.size > 20000) smallCache.delete(smallCache.keys().next().value!);
  return f;
}

function makeSmall(a: number, b: number): Landform[] {
  const cell = C / TERRAIN.smallCells;
  const cx = (a + 0.5) * cell, cz = (b + 0.5) * cell;
  const w = wastelandAt(cx, cz);
  if (w < 0.1 || inCorridor(cx, cz, cell * 0.5) || nearLandmark(cx, cz, cell)) return [];
  const big = bigCellForms(a >> 2, b >> 2);
  const arch = archAt(cx, cz, h01(a >> 2, b >> 2, 401));
  const u = h01(a, b, 211);
  const id = Math.floor(h01(a, b, 98) * 1e6);
  if (arch === 'canyons') {
    // Crags on the top tier of the mesa beneath.
    const top = big.filter((f) => f.shape === 'frustum').reduce<Landform | null>((m, f) => (!m || f.y0 + f.h > m.y0 + m.h ? f : m), null);
    if (!top || u < 0.5) return [];
    const half = cell * 0.3;
    if (Math.abs(cx - top.cx) + half > top.wt / 2 || Math.abs(cz - top.cz) + half > top.dt / 2) return [];
    const H = Math.min(2.6 * half, top.h * (0.15 + 0.45 * h01(a, b, 218)));
    return H < 1 ? [] : [form({ shape: 'pyramid', arch, tier: 2, cx, cz, y0: top.y0 + top.h, half, h: H, id })];
  }
  if (big.some((f) => !f.overhead && f.shape !== 'dome' && Math.abs(cx - f.cx) < (f.w || f.half * 2) / 2 + cell * 0.4 && Math.abs(cz - f.cz) < (f.d || f.half * 2) / 2 + cell * 0.4)) return [];
  if (arch === 'grid-plains') {
    if (u > 0.025) return [];
    return [form({ shape: 'prism', arch, tier: 3, cx, cz, sides: 4, r0: 1.6, r1: 1.2, h: 12 + 20 * h01(a, b, 220), ry: Math.PI / 4, id })];
  }
  if (arch === 'sea') {
    if (u > 0.2) return [];
    const R = 8 + 14 * h01(a, b, 221);
    return [form({ shape: 'dome', arch, tier: 2, cx: cx + (h01(a, b, 222) - 0.5) * cell * 0.3, cz: cz + (h01(a, b, 223) - 0.5) * cell * 0.3, w: R * 2.4, d: R * 2, h: R * (0.3 + 0.4 * h01(a, b, 224)), ry: h01(a, b, 225) * Math.PI, id })];
  }
  if (arch === 'wasteland') {
    if (u > 0.05) return [];
    return [form({ shape: 'pyramid', arch, tier: 2, cx, cz, half: 3 + 5 * h01(a, b, 226), h: 4 + 10 * h01(a, b, 227), ry: h01(a, b, 228) * Math.PI, id })];
  }
  // mech-caverns: machinery on the floor under the roof.
  if (u > 0.22) return [];
  const mw = 10 + 18 * h01(a, b, 229), md = 8 + 14 * h01(a, b, 230);
  return [form({ shape: 'frustum', arch, tier: 2, cx, cz, w: mw, d: md, wt: mw, dt: md, h: 6 + 12 * h01(a, b, 231), id })];
}

/** Rubble shard of fine-lattice cell (rx, rz), or null (canyon floors and wastelands). */
export function fineCellForm(rx: number, rz: number): Landform | null {
  const n = TERRAIN.fineCells;
  const a = mod(rx, n), b = mod(rz, n);
  const u = h01(a, b, 307);
  if (u < 0.82) return null;
  const cell = C / n;
  const cx = (a + 0.5) * cell, cz = (b + 0.5) * cell;
  const w = wastelandAt(cx, cz);
  if (w < 0.2) return null;
  const arch = archAt(cx, cz, h01(a >> 4, b >> 4, 401));
  if (arch !== 'canyons' && arch !== 'wasteland') return null;
  if (arch === 'wasteland' && u < 0.93) return null;
  const half = 0.38 * cell;
  if (inCorridor(cx, cz, half) || nearLandmark(cx, cz, half)) return null;
  for (const f of bigCellForms(a >> 4, b >> 4)) {
    const hw = (f.w || f.half * 2) / 2 + half, hd = (f.d || f.half * 2) / 2 + half;
    if (Math.abs(cx - f.cx) < hw && Math.abs(cz - f.cz) < hd) return null;
  }
  return form({ shape: 'pyramid', arch, tier: 3, cx, cz, half, h: (1.2 + 4.3 * h01(a, b, 311)) * Math.min(1, w * 1.6), ry: (h01(a, b, 312) - 0.5) * 0.6, id: Math.floor(u * 1e6) });
}

// --- Geometry of a landform: surface height and convex hull ---

/** Rotate (x, z) by -ry (into a landform's local frame). */
function local(f: Landform, x: number, z: number): [number, number] {
  const dx = x - f.cx, dz = z - f.cz;
  if (!f.ry) return [dx, dz];
  const c = Math.cos(f.ry), s = Math.sin(f.ry);
  // Inverse of three.js Ry: x' = x cos - z sin, z' = x sin + z cos.
  return [dx * c - dz * s, dx * s + dz * c];
}

/** Top surface height of a landform at (x, z) (canonical frame of the landform), or -Infinity. */
export function landformTop(f: Landform, x: number, z: number): number {
  const [u, v] = local(f, x, z);
  switch (f.shape) {
    case 'frustum': {
      const ax = Math.abs(u), az = Math.abs(v);
      if (ax > f.w / 2 || az > f.d / 2) return -Infinity;
      const fx = ax <= f.wt / 2 ? 1 : (f.w / 2 - ax) / Math.max(1e-6, (f.w - f.wt) / 2);
      const fz = az <= f.dt / 2 ? 1 : (f.d / 2 - az) / Math.max(1e-6, (f.d - f.dt) / 2);
      return f.y0 + f.h * Math.min(fx, fz);
    }
    case 'pyramid': {
      const m = Math.max(Math.abs(u), Math.abs(v));
      return m >= f.half ? -Infinity : f.y0 + f.h * (1 - m / f.half);
    }
    case 'octa': {
      const m = Math.max(Math.abs(u), Math.abs(v));
      return m >= f.half ? -Infinity : f.y0 + f.h * (2 - m / f.half);
    }
    case 'dome': {
      const e = (u / (f.w / 2)) ** 2 + (v / (f.d / 2)) ** 2;
      return e >= 1 ? -Infinity : f.y0 + f.h * Math.sqrt(1 - e);
    }
    case 'sphere': {
      const d2 = u * u + v * v;
      return d2 >= f.r0 * f.r0 ? -Infinity : f.y0 + f.r0 + Math.sqrt(f.r0 * f.r0 - d2);
    }
    case 'prism': {
      const k = Math.cos(Math.PI / f.sides);
      const d = Math.hypot(u, v);
      const ri0 = f.r0 * k, ri1 = f.r1 * k;
      if (d >= ri0) return -Infinity;
      return f.y0 + (d <= ri1 ? f.h : (f.h * (ri0 - d)) / Math.max(1e-6, ri0 - ri1));
    }
    case 'slab': {
      // Vertical line through a box tilted by rx about its local x axis.
      const c = Math.cos(f.rx), s = Math.sin(f.rx);
      if (Math.abs(u) > f.w / 2) return -Infinity;
      // In the slab frame, a point (v, y) maps to (v c + y s, -v s + y c) for (z', y').
      // Find the largest y with |z'| ≤ d/2 and |y'| ≤ h/2 (y measured from the slab centre).
      let lo = -Infinity, hi = Infinity;
      const clampLine = (a: number, b: number, lim: number) => {
        // |a + b·y| ≤ lim
        if (Math.abs(b) < 1e-9) { if (Math.abs(a) > lim) { lo = Infinity; } return; }
        const y1 = (-lim - a) / b, y2 = (lim - a) / b;
        lo = Math.max(lo, Math.min(y1, y2)); hi = Math.min(hi, Math.max(y1, y2));
      };
      clampLine(v * c, -s, f.d / 2);
      clampLine(v * s, c, f.h / 2);
      return hi >= lo ? f.y0 + f.h / 2 + hi : -Infinity;
    }
  }
}

/** Convex hull points (world metres, offset by (ox, oz)) of a landform. */
export function landformHull(f: Landform, ox = 0, oz = 0): Float32Array {
  const pts: number[] = [];
  const c = Math.cos(f.ry), s = Math.sin(f.ry);
  // Local → world (three.js Ry).
  const P = (u: number, y: number, v: number) => pts.push(f.cx + ox + u * c + v * s, y, f.cz + oz - u * s + v * c);
  switch (f.shape) {
    case 'frustum':
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) P((x * f.w) / 2, f.y0, (z * f.d) / 2);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) P((x * f.wt) / 2, f.y0 + f.h, (z * f.dt) / 2);
      break;
    case 'pyramid':
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) P(x * f.half, f.y0, z * f.half);
      P(0, f.y0 + f.h, 0);
      break;
    case 'octa':
      P(0, f.y0, 0);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) P(x * f.half, f.y0 + f.h, z * f.half);
      P(0, f.y0 + 2 * f.h, 0);
      break;
    case 'dome':
      for (let i = 0; i <= 4; i++) {
        const t = i / 4, rr = Math.sqrt(1 - t * t), y = f.y0 + f.h * t;
        const segs = i === 4 ? 1 : 12;
        for (let k = 0; k < segs; k++) {
          const a = (k / segs) * Math.PI * 2;
          P((Math.cos(a) * rr * f.w) / 2, y, (Math.sin(a) * rr * f.d) / 2);
        }
      }
      break;
    case 'sphere':
      for (let i = 0; i <= 6; i++) {
        const t = -1 + (2 * i) / 6, rr = Math.sqrt(Math.max(0, 1 - t * t)), y = f.y0 + f.r0 * (1 + t);
        const segs = i === 0 || i === 6 ? 1 : 10;
        for (let k = 0; k < segs; k++) {
          const a = (k / segs) * Math.PI * 2;
          P(Math.cos(a) * rr * f.r0, y, Math.sin(a) * rr * f.r0);
        }
      }
      break;
    case 'prism':
      for (let k = 0; k < f.sides; k++) {
        const a = (k / f.sides) * Math.PI * 2;
        P(Math.cos(a) * f.r0, f.y0, Math.sin(a) * f.r0);
        P(Math.cos(a) * f.r1, f.y0 + f.h, Math.sin(a) * f.r1);
      }
      break;
    case 'slab': {
      const cr = Math.cos(f.rx), sr = Math.sin(f.rx);
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
        const ly = (y * f.h) / 2, lz = (z * f.d) / 2;
        // Tilt about local x: (y, z) → (y c - z s, y s + z c).
        P((x * f.w) / 2, f.y0 + f.h / 2 + ly * cr - lz * sr, ly * sr + lz * cr);
      }
      break;
    }
  }
  return new Float32Array(pts);
}

// --- Queries ---

function eachForm(px: number, pz: number, fn: (f: Landform) => void): void {
  const big = C / TERRAIN.bigCells, small = C / TERRAIN.smallCells, fine = C / TERRAIN.fineCells;
  const bi = Math.floor(px / big), bj = Math.floor(pz / big);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const f of bigCellForms(bi + a, bj + b)) fn(shift(f, px, pz));
  const si = Math.floor(px / small), sj = Math.floor(pz / small);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const f of smallCellForms(si + a, sj + b)) fn(shift(f, px, pz));
  const r = fineCellForm(Math.floor(px / fine), Math.floor(pz / fine));
  if (r) fn(r);
}

/** The landform's image (whole-circumference shift) nearest to (px, pz). */
function shift(f: Landform, px: number, pz: number): Landform {
  const ox = Math.round((px - f.cx) / C) * C, oz = Math.round((pz - f.cz) / C) * C;
  return ox || oz ? { ...f, cx: f.cx + ox, cz: f.cz + oz } : f;
}

/** Ground surface height (m) at (x, z): the top of the landform underfoot (overhead slabs and orbs excluded). */
export function terrainHeight(x: number, z: number): number {
  const px = mod(x, C), pz = mod(z, C);
  let h = 0;
  eachForm(px, pz, (f) => { if (!f.overhead) h = Math.max(h, landformTop(f, px, pz)); });
  return h;
}

/** Highest solid surface (m) at (x, z), overhead slabs and orbs included (obstacle clearance). */
export function terrainTop(x: number, z: number): number {
  const px = mod(x, C), pz = mod(z, C);
  let h = 0;
  eachForm(px, pz, (f) => { h = Math.max(h, landformTop(f, px, pz)); });
  return h;
}

/**
 * Every landform whose lattice cell centre lies in the canonical rectangle [x0, x1) × [z0, z1),
 * placed at the image inside it. `fine`: include rubble (only wanted up close).
 */
export function landformsInRect(x0: number, z0: number, x1: number, z1: number, fine = true): Landform[] {
  const out: Landform[] = [];
  const each = (n: number, f: (ix: number, iz: number, ox: number, oz: number) => void) => {
    const cell = C / n;
    const i0 = Math.floor(mod(x0, C) / cell) - 1, j0 = Math.floor(mod(z0, C) / cell) - 1;
    const i1 = i0 + Math.ceil((x1 - x0) / cell) + 2, j1 = j0 + Math.ceil((z1 - z0) / cell) + 2;
    for (let ix = i0; ix <= i1; ix++) for (let iz = j0; iz <= j1; iz++) {
      const cx = (mod(ix, n) + 0.5) * cell, cz = (mod(iz, n) + 0.5) * cell;
      const wx = x0 + mod(cx - x0, C), wz = z0 + mod(cz - z0, C);
      if (wx >= x1 || wz >= z1) continue;
      f(ix, iz, wx - cx, wz - cz);
    }
  };
  const put = (f: Landform, ox: number, oz: number) => out.push(ox || oz ? { ...f, cx: f.cx + ox, cz: f.cz + oz } : f);
  each(TERRAIN.bigCells, (ix, iz, ox, oz) => { for (const f of bigCellForms(ix, iz)) put(f, ox, oz); });
  each(TERRAIN.smallCells, (ix, iz, ox, oz) => { for (const f of smallCellForms(ix, iz)) put(f, ox, oz); });
  if (fine) each(TERRAIN.fineCells, (ix, iz, ox, oz) => { const f = fineCellForm(ix, iz); if (f) put(f, ox, oz); });
  return out;
}

/** Convex hulls (world metres) of every landform owned by the rectangle: exactly the terrain surface. */
export function solidHulls(x0: number, z0: number, x1: number, z1: number): Float32Array[] {
  return landformsInRect(x0, z0, x1, z1, true).map((f) => landformHull(f));
}

void GRID;
