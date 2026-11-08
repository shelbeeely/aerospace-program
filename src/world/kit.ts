import data from './towerKit.json' with { type: 'json' };

/**
 * The imported tower kit ("Tron Buildings 1" by SpringSociety, CC-BY-4.0), as block grids:
 * which cubic cells of each tower are solid, and greedy boxes over them. Placed towers are
 * rotated by quarter turns about +Y and uniformly scaled.
 */
export interface KitTower {
  name: string;
  size: [number, number, number];
  cell: number;
  grid: [number, number, number];
  solid: Uint8Array;
  boxes: number[][];
  solidCount: number;
  vertexStart: number;
  vertexCount: number;
  groups: Array<{ role: string; start: number; count: number }>;
}

export const KIT_CREDIT: string = data.credit;
export const KIT_POSITION_BYTES: number = data.positionBytes;
export const KIT_INDEX_BYTES: number = data.indexBytes;

export const KIT: KitTower[] = data.towers.map((t) => {
  const [W, H, D] = t.grid as [number, number, number];
  const bits = base64(t.voxels);
  const solid = new Uint8Array(W * H * D);
  let n = 0;
  for (let i = 0; i < solid.length; i++) if (bits[i >> 3] & (1 << (i & 7))) { solid[i] = 1; n++; }
  return {
    name: t.name, size: t.size as [number, number, number], cell: t.cell, grid: [W, H, D], solid, boxes: t.boxes, solidCount: n,
    vertexStart: t.vertexStart, vertexCount: t.vertexCount, groups: t.groups,
  };
});

function base64(s: string): Uint8Array {
  if (typeof atob === 'function') return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return new Uint8Array((globalThis as unknown as { Buffer: { from(s: string, e: string): Uint8Array } }).Buffer.from(s, 'base64'));
}

export function kitSolid(t: KitTower, x: number, y: number, z: number): boolean {
  const [W, H, D] = t.grid;
  if (x < 0 || y < 0 || z < 0 || x >= W || y >= H || z >= D) return false;
  return t.solid[(y * D + z) * W + x] === 1;
}

/** Grid dims after `rot` quarter turns (X and Z swap on odd turns). */
export function rotatedGrid(t: KitTower, rot: number): [number, number, number] {
  const [W, H, D] = t.grid;
  return rot % 2 ? [D, H, W] : [W, H, D];
}

/** Rotated cell (x', z') → original cell (x, z) for a rotation of rot × 90° about +Y. */
export function unrotate(t: KitTower, rot: number, xr: number, zr: number): [number, number] {
  const [W, , D] = t.grid;
  switch (rot & 3) {
    case 1: return [W - 1 - zr, xr];
    case 2: return [W - 1 - xr, D - 1 - zr];
    case 3: return [zr, D - 1 - xr];
    default: return [xr, zr];
  }
}

/** Original cell (x, z) → rotated cell (x', z'). */
export function rotate(t: KitTower, rot: number, x: number, z: number): [number, number] {
  const [W, , D] = t.grid;
  switch (rot & 3) {
    case 1: return [z, W - 1 - x];
    case 2: return [W - 1 - x, D - 1 - z];
    case 3: return [D - 1 - z, x];
    default: return [x, z];
  }
}

/** Blocks merge k×k×k kit cells so a fractured tower stays within the block budget. */
export function kitBlockFactor(t: KitTower, budget: number): number {
  return Math.max(1, Math.ceil(Math.cbrt(t.solidCount / budget)));
}
