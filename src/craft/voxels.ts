import type { ShapeDef } from './types.ts';

/** Aircraft voxel edge (m). Large parts coarsen so no part exceeds MAX_VOXELS. */
export const AIRCRAFT_VOXEL = 0.25;
const MAX_VOXELS = 6000;

/**
 * A craft part as a grid of small voxels in its own frame (centred on the part origin, axes as
 * the part's shape). Impacts bite voxels out where they hit; the part's integrity (fraction of
 * voxels left) scales its mass, lift, thrust and decides when it finally breaks off.
 */
export class PartVoxels {
  readonly cell: number;
  readonly grid: [number, number, number];
  readonly origin: [number, number, number];
  readonly alive: Uint8Array;
  readonly total: number;
  aliveCount: number;
  /** Bumped on every bite (renderers rebuild the voxel view). */
  version = 0;

  constructor(shape: ShapeDef) {
    const ext = extents(shape);
    const volume = ext[0] * ext[1] * ext[2];
    this.cell = Math.max(AIRCRAFT_VOXEL, Math.cbrt(volume / MAX_VOXELS));
    const c = this.cell;
    this.grid = [Math.max(1, Math.round(ext[0] / c)), Math.max(1, Math.round(ext[1] / c)), Math.max(1, Math.round(ext[2] / c))];
    this.origin = [-(this.grid[0] * c) / 2, -(this.grid[1] * c) / 2, -(this.grid[2] * c) / 2];
    const [W, H, D] = this.grid;
    this.alive = new Uint8Array(W * H * D);
    let n = 0;
    for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      const [px, py, pz] = this.centre(x, y, z);
      if (insideShape(shape, px, py, pz, c)) {
        this.alive[(y * D + z) * W + x] = 1;
        n++;
      }
    }
    this.total = Math.max(1, n);
    this.aliveCount = n;
  }

  get integrity(): number {
    return this.aliveCount / this.total;
  }

  centre(x: number, y: number, z: number): [number, number, number] {
    const c = this.cell;
    return [this.origin[0] + (x + 0.5) * c, this.origin[1] + (y + 0.5) * c, this.origin[2] + (z + 0.5) * c];
  }

  /** Visit every living voxel centre (part frame). */
  forEachAlive(fn: (x: number, y: number, z: number, i: number) => void): void {
    const [W, H, D] = this.grid;
    for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      const i = (y * D + z) * W + x;
      if (this.alive[i]) {
        const [px, py, pz] = this.centre(x, y, z);
        fn(px, py, pz, i);
      }
    }
  }

  /**
   * Remove the living voxels within `radius` of a part-frame point. Returns the centres of
   * the removed voxels (part frame) so the caller can throw them off as chips.
   */
  bite(px: number, py: number, pz: number, radius: number): Array<[number, number, number]> {
    const c = this.cell;
    const [W, H, D] = this.grid;
    const lo = (v: number, o: number) => Math.max(0, Math.floor((v - radius - o) / c));
    const hi = (v: number, o: number, n: number) => Math.min(n - 1, Math.floor((v + radius - o) / c));
    const out: Array<[number, number, number]> = [];
    // Snap the point onto the part if it lies just outside (contact points are on the surface).
    for (let y = lo(py, this.origin[1]); y <= hi(py, this.origin[1], H); y++)
      for (let z = lo(pz, this.origin[2]); z <= hi(pz, this.origin[2], D); z++)
        for (let x = lo(px, this.origin[0]); x <= hi(px, this.origin[0], W); x++) {
          const i = (y * D + z) * W + x;
          if (!this.alive[i]) continue;
          const [cx, cy, cz] = this.centre(x, y, z);
          if ((cx - px) ** 2 + (cy - py) ** 2 + (cz - pz) ** 2 > radius * radius) continue;
          this.alive[i] = 0;
          this.aliveCount--;
          out.push([cx, cy, cz]);
        }
    if (out.length) this.version++;
    return out;
  }

  /** Nearest living voxel centre to a part-frame point (the bite lands on the actual skin). */
  nearestAlive(px: number, py: number, pz: number): [number, number, number] | null {
    let best: [number, number, number] | null = null;
    let bd = Infinity;
    this.forEachAlive((x, y, z) => {
      const d = (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2;
      if (d < bd) { bd = d; best = [x, y, z]; }
    });
    return best;
  }

  restore(): void {
    // Rebuild from scratch is cheap enough on reset; callers make a new PartVoxels instead.
  }
}

function extents(s: ShapeDef): [number, number, number] {
  if (s.type === 'box') return [s.size[0], s.size[1], s.size[2]];
  if (s.type === 'sphere') return [2 * s.radius, 2 * s.radius, 2 * s.radius];
  const d = 2 * s.radius;
  return s.axis === 'x' ? [s.length, d, d] : s.axis === 'z' ? [d, d, s.length] : [d, s.length, d];
}

/** Voxel centre inside the shape? Thin shapes still get one layer. */
function insideShape(s: ShapeDef, x: number, y: number, z: number, c: number): boolean {
  if (s.type === 'box') return true; // the grid is the box
  if (s.type === 'sphere') return Math.hypot(x, y, z) <= Math.max(s.radius, c / 2);
  const axis = s.axis ?? 'y';
  const along = axis === 'x' ? x : axis === 'z' ? z : y;
  const radial = axis === 'x' ? Math.hypot(y, z) : axis === 'z' ? Math.hypot(x, y) : Math.hypot(x, z);
  let r = s.radius;
  if (s.type === 'cone') {
    // Radius grows from the tip (at tip·length/2) to the base.
    const tip = s.tip ?? -1;
    const t = (s.length / 2 - along * tip) / s.length; // 0 at the tip, 1 at the base
    r = s.radius * Math.min(1, Math.max(0, t));
  } else if (s.type === 'capsule') {
    const flat = s.length / 2 - s.radius;
    const over = Math.abs(along) - flat;
    if (over > 0) r = Math.sqrt(Math.max(0, s.radius * s.radius - over * over));
  }
  return radial <= Math.max(r, c / 2);
}
