import type { Structure } from '../world/structures.ts';

/**
 * The world's architecture as the TV draws it: every structure piece packed into a Float32Array
 * (PIECE floats each) with a grid index for "what stands near here". Packs are built where the
 * structures are planned (the host's worker, or a planning worker when the phone runs the game)
 * and moved to the page without copying. DOM-free.
 *
 * Long boxes (raised highways, slabs) are cut into pieces of at most MAX_RUN metres, so the
 * renderer's painter's sort, which orders whole pieces by distance, keeps them in order.
 */

/** shape (0 box, 1 oct, 2 cyl, 3 cone), x, y, z, sx, sy, sz, taper, group, colour */
export const PIECE = 10;
export const SHAPES = { box: 0, oct: 1, cyl: 2, cone: 3 } as const;
const MAX_RUN = 70;
const CELL = 128;
/** Pieces at least this tall are landmarks: drawn far beyond the normal range, as silhouettes. */
export const LANDMARK_HEIGHT = 45;

export interface StructurePack {
  /** Index of the first structure (in the host's list) this pack holds. */
  start: number;
  /** Structures packed (the host's list is at `start + count` after it). */
  count: number;
  data: Float32Array;
  colors: string[];
}

/** Pack `list[start..]` (structures in the host's order: group ids are kept). */
export function packStructures(list: readonly Structure[], start = 0): StructurePack {
  const colors: string[] = [];
  const ci = new Map<string, number>();
  const out: number[] = [];
  for (let i = start; i < list.length; i++) {
    const p = list[i];
    let c = ci.get(p.color);
    if (c === undefined) {
      c = colors.length;
      colors.push(p.color);
      ci.set(p.color, c);
    }
    const shape = SHAPES[p.shape];
    if (shape === 0 && (p.sx > MAX_RUN || p.sz > MAX_RUN)) {
      const nx = Math.ceil(p.sx / MAX_RUN), nz = Math.ceil(p.sz / MAX_RUN);
      const wx = p.sx / nx, wz = p.sz / nz;
      for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
        out.push(0, p.x - p.sx / 2 + (a + 0.5) * wx, p.y, p.z - p.sz / 2 + (b + 0.5) * wz, wx, p.sy, wz, 1, p.group, c);
      }
    } else out.push(shape, p.x, p.y, p.z, p.sx, p.sy, p.sz, p.taper ?? 1, p.group, c);
  }
  return { start, count: list.length - start, data: new Float32Array(out), colors };
}

/** Packed structures and their grid index. */
export class StructureStore {
  data = new Float32Array(PIECE * 4096);
  count = 0;
  readonly colors: string[] = [];
  private readonly colorIndex = new Map<string, number>();
  private readonly cells = new Map<number, number[]>();
  private readonly marks = new Map<number, number[]>();
  /** Host structures received so far (the next pack must start here). */
  received = 0;
  /** Bumped on every pack. */
  version = 0;

  /** Empty it (the game moved to another host, whose structure list may be in another order). */
  clear(): void {
    this.count = 0;
    this.received = 0;
    this.cells.clear();
    this.marks.clear();
    this.version++;
  }

  add(pack: StructurePack): boolean {
    if (pack.start !== this.received) return false;
    const n = pack.data.length / PIECE;
    if ((this.count + n) * PIECE > this.data.length) {
      const grown = new Float32Array(Math.max(this.data.length * 2, (this.count + n) * PIECE));
      grown.set(this.data.subarray(0, this.count * PIECE));
      this.data = grown;
    }
    const remap = pack.colors.map((c) => {
      let i = this.colorIndex.get(c);
      if (i === undefined) {
        i = this.colors.length;
        this.colors.push(c);
        this.colorIndex.set(c, i);
      }
      return i;
    });
    const D = this.data;
    for (let k = 0; k < n; k++) {
      const o = (this.count + k) * PIECE;
      D.set(pack.data.subarray(k * PIECE, (k + 1) * PIECE), o);
      D[o + 9] = remap[D[o + 9]] ?? 0;
      const key = cellKey(Math.floor(D[o + 1] / CELL), Math.floor(D[o + 3] / CELL));
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(this.count + k);
      if (D[o + 5] >= LANDMARK_HEIGHT) {
        const mk = cellKey(Math.floor(D[o + 1] / (CELL * 4)), Math.floor(D[o + 3] / (CELL * 4)));
        let m = this.marks.get(mk);
        if (!m) this.marks.set(mk, (m = []));
        m.push(this.count + k);
      }
    }
    this.count += n;
    this.received = pack.start + pack.count;
    this.version++;
    return true;
  }

  /** Pieces whose cell is within `r` of (x, z), appended to `out`. */
  near(x: number, z: number, r: number, out: number[]): number[] {
    return this.scan(this.cells, CELL, x, z, r, out);
  }

  /** Landmarks (tall pieces) within `r` of (x, z). */
  landmarks(x: number, z: number, r: number, out: number[]): number[] {
    return this.scan(this.marks, CELL * 4, x, z, r, out);
  }

  private scan(index: Map<number, number[]>, size: number, x: number, z: number, r: number, out: number[]): number[] {
    const i0 = Math.floor((x - r) / size), i1 = Math.floor((x + r) / size);
    const j0 = Math.floor((z - r) / size), j1 = Math.floor((z + r) / size);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const list = index.get(cellKey(i, j));
      if (list) for (const k of list) out.push(k);
    }
    return out;
  }
}

const cellKey = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
