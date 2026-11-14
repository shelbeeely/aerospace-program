import { mulberry32 } from '../world/City.ts';
import { GRID } from '../world/planetCity.ts';
import { CITY } from './layout.ts';
import { roadOpen, segmentAt } from './roads.ts';

/**
 * Roads break. A blast big enough, on or beside a road, throws the ground up into a field of
 * broken slabs across the carriageway and closes that stretch of road:
 *
 * - the slabs are real (static boxes: a vehicle cannot drive straight through them);
 * - a **barrier** lies across the road at each rim of the field. Riders and the flight computer
 *   already know what to do about a wall across the road (turn another way, swing round,
 *   re-route), so a barrier is given to them as exactly that;
 * - the closed segment is known to the route planner, so new routes avoid it from the start;
 * - the barriers are drawn as red bars across the road, so the ground says what the graph knows.
 *
 * Pure data, deterministic for the crater (seeded by where it is). Lasts until a world reset.
 */
export const ROAD_DAMAGE = {
  /** Smaller craters only scar the surface (m). */
  minRadius: 5,
  /** Most closures at once (each is up to ~24 slab colliders). */
  max: 24,
  /** Half the carriageway (m), and the outer lane's centre from the centreline. */
  half: CITY.street / 2,
  lane: 9.75,
} as const;

const P = GRID.pitch;

export interface RoadSlab {
  /** Centre and full size (m). */
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
}

export interface RoadClosure {
  /** The closed segment (same indexing as roads.roadOpen, canonical). */
  alongX: boolean;
  i: number;
  j: number;
  /** The crater that did it. */
  x: number;
  z: number;
  radius: number;
  /** Walls across the road at each rim of the slab field: [x0, z0, x1, z1]. */
  barriers: Array<[number, number, number, number]>;
  slabs: RoadSlab[];
}

const key = (alongX: boolean, i: number, j: number) => `${alongX ? 1 : 0},${i},${j}`;

export class RoadDamage {
  readonly closures: RoadClosure[] = [];
  /** Every barrier of every closure (the same array for its whole life: hand it out once). */
  readonly barriers: Array<[number, number, number, number]> = [];
  /** Bumped whenever a road closes or everything reopens (renderers watch it). */
  version = 0;
  private readonly keys = new Map<string, number>();

  /** Is this road segment closed? (Same indexing as roads.roadOpen; any indices, wrapped.) */
  readonly closed = (alongX: boolean, i: number, j: number): boolean => {
    const n = GRID.blocks;
    return this.keys.has(key(alongX, ((i % n) + n) % n, ((j % n) + n) % n));
  };

  /**
   * A crater of `radius` at (x, z), ground height `y`. If it is big enough and reaches a lane of
   * a road, that stretch closes: returns the closure (for the host to make the slabs solid).
   */
  add(x: number, y: number, z: number, radius: number): RoadClosure | null {
    if (radius < ROAD_DAMAGE.minRadius || this.closures.length >= ROAD_DAMAGE.max) return null;
    const [alongX, i, j] = segmentAt(x, z);
    if (!roadOpen(alongX, i, j)) return null;
    // The road's centreline nearest the crater, and how far off it the crater is.
    const line = alongX ? GRID.z0 + Math.round((z - GRID.z0) / P) * P : GRID.x0 + Math.round((x - GRID.x0) / P) * P;
    const off = (alongX ? z : x) - line;
    if (Math.abs(off) > radius + ROAD_DAMAGE.lane) return null;
    // One closure per stretch of road is enough: a second crater in the same field adds nothing.
    const along = alongX ? x : z;
    if (this.closures.some((c) => c.alongX === alongX && c.i === i && c.j === j && Math.abs((alongX ? c.x : c.z) - along) < c.radius + radius)) return null;
    const rand = mulberry32((Math.round(x * 7) * 73856093) ^ (Math.round(z * 7) * 19349663));
    const slabs: RoadSlab[] = [];
    const slab = (u: number, v: number, big: number) => {
      // u along the road from the crater, v across it from the centreline.
      const w = (1.6 + rand() * 2.4) * big, d = (1.2 + rand() * 2) * big, h = 0.6 + rand() * 1.1 * big;
      const px = alongX ? along + u : line + v, pz = alongX ? line + v : along + u;
      slabs.push({ x: px, y: y + h / 2, z: pz, sx: alongX ? w : d, sy: h, sz: alongX ? d : w });
    };
    // A row right across the carriageway, so no lane is left clear, then the rest of the field.
    const H = ROAD_DAMAGE.half;
    for (let v = -H + 1.4; v <= H - 1.4; v += 2.9) slab((rand() - 0.5) * Math.min(4, radius * 0.4), v + (rand() - 0.5) * 0.8, 1);
    const extra = Math.min(12, Math.round(radius * 0.8));
    for (let k = 0; k < extra; k++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * radius * 0.9;
      const v = off + Math.sin(a) * r;
      if (Math.abs(v) > H + 6) continue; // off the road and into the lots: leave the buildings alone
      slab(Math.cos(a) * r, v, 0.8);
    }
    const rim = radius + 1.5;
    const barriers: Array<[number, number, number, number]> = [-rim, rim].map((u) => (alongX
      ? [along + u, line - H, along + u, line + H]
      : [line - H, along + u, line + H, along + u]) as [number, number, number, number]);
    const c: RoadClosure = { alongX, i, j, x, z, radius, barriers, slabs };
    this.closures.push(c);
    this.barriers.push(...barriers);
    this.keys.set(key(alongX, i, j), (this.keys.get(key(alongX, i, j)) ?? 0) + 1);
    this.version++;
    return c;
  }

  /** Mend one closure (Amber tenders): the stretch opens again. True if it was there. */
  repair(c: RoadClosure): boolean {
    const i = this.closures.indexOf(c);
    if (i < 0) return false;
    this.closures.splice(i, 1);
    for (const b of c.barriers) { const k = this.barriers.indexOf(b); if (k >= 0) this.barriers.splice(k, 1); }
    const k = key(c.alongX, c.i, c.j);
    const n = (this.keys.get(k) ?? 1) - 1;
    if (n > 0) this.keys.set(k, n); else this.keys.delete(k);
    this.version++;
    return true;
  }

  /** Every road open again (world reset). */
  reset(): void {
    if (!this.closures.length) return;
    this.closures.length = 0;
    this.barriers.length = 0;
    this.keys.clear();
    this.version++;
  }
}
