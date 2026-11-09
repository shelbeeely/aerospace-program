import { CITY, GROUND_HELIPADS, hash01, inCentral, isSea, PLANET, PLANET_HUBS, RUNWAYS, wrapCoord } from './layout.ts';

/**
 * The Off-Grid: wasteland between the cities. Height = wasteland mask × geometric solids. Both halves are evaluated identically on the CPU (physics colliders, altitude, the
 * autopilot) and the GPU (the ground disc, see render/terrainNode.ts): the mask lives in one
 * byte per city block (blockSummary's alpha channel, bilinearly blended by hand), and the
 * solids sit on lattices that divide the circumference, so the terrain is seamless.
 *
 * The mask noise is periodic, integer-hashed value noise; the elevations are geometric solids
 * (pyramids and mesas), per the Grid's design rules.
 */
export const TERRAIN = {
  /** Highest apex (m). */
  peak: 320,
  /** Lattices of solids: the circumference split this many times (~393 m and ~98 m cells). */
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
 * Geometric elevations (Rule 1: geometry is the foundation): square pyramids and flat-topped
 * mesas on a lattice that divides the circumference. Each lattice cell holds one solid (or a
 * flat plain), its height and kind from the cell's hash; faces are planes, ridgelines are
 * straight diagonals, and height contours are concentric squares.
 */
export function solid(x: number, z: number, n: number, seed: number): number {
  const cell = C / n;
  const fx = mod(x, C) / cell, fz = mod(z, C) / cell;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const s = solidCell(ix, iz, n, seed);
  if (!s) return 0;
  const u = fx - ix - 0.5, v = fz - iz - 0.5;
  const shape = Math.max(0, 0.9 - 2 * Math.max(Math.abs(u), Math.abs(v))) / 0.9; // 1 apex, 0 at the inset base
  return (Math.min(shape, s.mesa) / s.mesa) * s.height;
}

/**
 * The solid in lattice cell (ix, iz): its height as a fraction of the peak (the cell's hash
 * scaled by the wasteland mask² at the cell centre, so every face stays a plane) and its kind
 * (mesa = 0.6: truncated at 60% of the way up; 1: a pyramid). Null for an open plain.
 */
export function solidCell(ix: number, iz: number, n: number, seed: number): { height: number; mesa: number; cx: number; cz: number } | null {
  const a = mod(ix, n), b = mod(iz, n);
  const h = hashLattice(a, b, seed);
  if (h < 0.3) return null;
  const cell = C / n;
  const cx = (a + 0.5) * cell, cz = (b + 0.5) * cell;
  const w = wastelandAt(cx, cz);
  if (w <= 0) return null;
  return { height: ((h - 0.3) / 0.7) * w * w, mesa: hashLattice(a, b, seed + 7) < 0.35 ? 0.6 : 1, cx, cz };
}

/**
 * Every solid whose cell centre lies in the canonical rectangle [x0, x1) × [z0, z1), as a
 * convex hull (8 points for a mesa, 5 for a pyramid) in world metres: the union of these hulls
 * is exactly the terrain surface, so physics can use them directly.
 */
export function solidHulls(x0: number, z0: number, x1: number, z1: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (const [n, seed, scale] of [[TERRAIN.bigCells, 101, 1], [TERRAIN.smallCells, 211, 0.3]] as const) {
    const cell = C / n;
    for (let ix = Math.floor(mod(x0, C) / cell) - 1; ix <= Math.ceil(mod(x0, C) / cell + (x1 - x0) / cell) + 1; ix++) {
      for (let iz = Math.floor(mod(z0, C) / cell) - 1; iz <= Math.ceil(mod(z0, C) / cell + (z1 - z0) / cell) + 1; iz++) {
        const s = solidCell(ix, iz, n, seed);
        if (!s) continue;
        // The cell centre, moved to the image of the rectangle.
        const cx = x0 + mod(s.cx - x0, C), cz = z0 + mod(s.cz - z0, C);
        if (cx >= x1 || cz >= z1) continue;
        const H = s.height * scale * TERRAIN.peak;
        if (H < 0.5) continue;
        const base = 0.45 * cell;
        const pts: number[] = [];
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) pts.push(cx + sx * base, 0, cz + sz * base);
        if (s.mesa < 1) {
          const top = base * (1 - s.mesa);
          for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) pts.push(cx + sx * top, H, cz + sz * top);
        } else pts.push(cx, H, cz);
        out.push(new Float32Array(pts));
      }
    }
  }
  return out;
}

/** Wasteland strength of block (gi, gj) as a byte (0 = city, 255 = deep Off-Grid). */
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

/** Terrain height (m) above the street level at (x, z): 0 in the Grid, mountains Off-Grid. */
export function terrainHeight(x: number, z: number): number {
  const big = solid(x, z, TERRAIN.bigCells, 101);
  const small = solid(x, z, TERRAIN.smallCells, 211) * 0.3;
  return Math.max(big, small) * TERRAIN.peak;
}

/** Is block (gi, gj) or any neighbour Off-Grid (so no tower sits on a slope)? */
export function nearWasteland(gi: number, gj: number): boolean {
  const n = TERRAIN.blocks;
  const m = wastelandMask();
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (m[mod(gj + b, n) * n + mod(gi + a, n)] > 0) return true;
  return false;
}

/** Does planet chunk (ci, cj) (10 × 10 blocks) have any Off-Grid terrain, including its border? */
export function chunkHasTerrain(ci: number, cj: number): boolean {
  const n = TERRAIN.blocks;
  const m = wastelandMask();
  for (let a = -1; a <= 10; a++) for (let b = -1; b <= 10; b++) if (m[mod(cj * 10 + b, n) * n + mod(ci * 10 + a, n)] > 0) return true;
  return false;
}
