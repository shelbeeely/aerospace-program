import { CITY } from '../sim/layout.ts';
import { TUNING } from '../tuning.ts';
import { airportPlan } from './Airport.ts';
import { cityPlan } from './City.ts';

/**
 * Every solid, destructible structure in the world (city towers, raised highways, airport
 * buildings, parked airliners) as one list shared by the physics (static colliders, fracture)
 * and the renderer (instanced neon meshes). Pieces with the same `group` fracture together.
 */
export interface Structure {
  shape: 'box' | 'oct' | 'cyl' | 'cone';
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  taper?: number;
  color: string;
  windows: boolean;
  group: number;
}

export interface StructureGroup {
  id: number;
  name: string;
  /** Indices into `structures()`. */
  pieces: number[];
  color: string;
  /**
   * The structure's block grid: every structure is a W×H×D grid of cubic blocks of edge
   * `blockSize` (m) with its minimum corner at (x0, 0, z0). Intact, the façades draw this grid;
   * fractured, the grid becomes real breakable blocks (BlockBuilding).
   */
  blockSize: number;
  x0: number;
  z0: number;
  size: [number, number, number];
}

let cached: { list: Structure[]; groups: StructureGroup[] } | null = null;

export function worldStructures(): { list: Structure[]; groups: StructureGroup[] } {
  if (cached) return cached;
  const list: Structure[] = [];
  const groups: StructureGroup[] = [];
  const byName = new Map<string, StructureGroup>();
  const groupFor = (name: string, color: string): StructureGroup => {
    let g = byName.get(name);
    if (!g) {
      g = { id: groups.length, name, pieces: [], color, blockSize: 0, x0: 0, z0: 0, size: [1, 1, 1] };
      groups.push(g);
      byName.set(name, g);
    }
    return g;
  };
  const city = cityPlan();
  city.pieces.forEach((p, i) => {
    const color = CITY.colors[p.color];
    const g = groupFor(p.building >= 0 ? `city:${p.building}` : `highway:${i}`, color);
    g.pieces.push(list.length);
    list.push({ shape: p.shape, x: p.x, y: p.y, z: p.z, sx: p.sx, sy: p.sy, sz: p.sz, taper: p.taper, color, windows: p.windows, group: g.id });
  });
  for (const p of airportPlan().pieces) {
    if (!p.solid) continue;
    const g = groupFor(`airport:${p.group}`, p.color);
    g.pieces.push(list.length);
    list.push({ shape: p.shape, x: p.x, y: p.y, z: p.z, sx: p.sx, sy: p.sy, sz: p.sz, color: p.color, windows: p.windows, group: g.id });
  }
  for (const g of groups) gridFor(g, list);
  return (cached = { list, groups });
}

/** Choose each structure's block grid: as fine as the block budget allows. */
function gridFor(g: StructureGroup, list: readonly Structure[]): void {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = 0, volume = 0;
  for (const i of g.pieces) {
    const p = list[i];
    x0 = Math.min(x0, p.x - p.sx / 2); x1 = Math.max(x1, p.x + p.sx / 2);
    z0 = Math.min(z0, p.z - p.sz / 2); z1 = Math.max(z1, p.z + p.sz / 2);
    y1 = Math.max(y1, p.y + p.sy / 2);
    volume += p.sx * p.sy * p.sz * (p.shape === 'box' ? 1 : 0.8);
  }
  const s = Math.min(14, Math.max(TUNING.blockSize, Math.cbrt(volume / TUNING.maxFractureBlocks)));
  g.blockSize = s;
  g.x0 = x0;
  g.z0 = z0;
  g.size = [Math.max(1, Math.ceil((x1 - x0) / s)), Math.max(1, Math.ceil(y1 / s)), Math.max(1, Math.ceil((z1 - z0) / s))];
}

/** Is the block centre (cx, cy, cz) of edge `s` inside piece p? Thin pieces still get one layer. */
export function insidePiece(p: Structure, cx: number, cy: number, cz: number, s: number): boolean {
  const hy = Math.max(p.sy / 2, s / 2);
  const dy = cy - p.y;
  if (Math.abs(dy) > hy) return false;
  if (p.shape === 'box') return Math.abs(cx - p.x) <= Math.max(p.sx / 2, s / 2) && Math.abs(cz - p.z) <= Math.max(p.sz / 2, s / 2);
  // Round: radius at this height (frustums taper linearly from base to top).
  const t = Math.min(1, Math.max(0, (dy + p.sy / 2) / p.sy));
  const r = (p.sx / 2) * (p.shape === 'cone' ? 1 + ((p.taper ?? 1) - 1) * t : 1);
  return Math.hypot(cx - p.x, cz - p.z) <= Math.max(r, s / 2);
}

/** The structure's block grid as a cell mask (x, y, z → exists). */
export function structureMask(g: StructureGroup, list: readonly Structure[]): (x: number, y: number, z: number) => boolean {
  const s = g.blockSize;
  const pieces = g.pieces.map((i) => list[i]);
  return (x, y, z) => {
    const cx = g.x0 + (x + 0.5) * s, cy = (y + 0.5) * s, cz = g.z0 + (z + 0.5) * s;
    return pieces.some((p) => insidePiece(p, cx, cy, cz, s));
  };
}
