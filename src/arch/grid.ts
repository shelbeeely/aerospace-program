import { CITY, PLANET, wrapCoord } from '../sim/layout.ts';

/**
 * The planet's seamless block lattice (shared with traffic, the ground shader and physics):
 * 370 blocks around, cut into 37 × 37 chunks of 10 × 10 blocks. A chunk is a District.
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
    /** Blocks the hand-planned centre covers (from x0, z0). */
    centralX: Math.floor((CITY.x1 - CITY.x0) / pitch),
    centralZ: Math.floor((CITY.z1 - CITY.z0) / pitch),
  };
})();

export const mod = (v: number, m: number) => ((v % m) + m) % m;

/** Is block (gi, gj) inside the planned centre (around Grid International)? */
export function isCentralBlock(gi: number, gj: number): boolean {
  return mod(gi, GRID.blocks) < GRID.centralX && mod(gj, GRID.blocks) < GRID.centralZ;
}

/** Is street line i (the line west of / north of block i) a data highway? Same rule as traffic and the ground. */
export function isHighwayLine(i: number): boolean {
  const k = Math.round((wrapCoord(GRID.x0 + mod(i, GRID.blocks) * GRID.pitch) - GRID.x0) / GRID.pitch);
  return mod(k, CITY.highwayEvery) === 0;
}

/** Buildable rectangle of block (gi, gj) (canonical coordinates, inside the streets). */
export function blockRect(gi: number, gj: number): { x0: number; z0: number; x1: number; z1: number } {
  const x0 = GRID.x0 + mod(gi, GRID.blocks) * GRID.pitch + CITY.street / 2;
  const z0 = GRID.z0 + mod(gj, GRID.blocks) * GRID.pitch + CITY.street / 2;
  return { x0, z0, x1: x0 + CITY.block, z1: z0 + CITY.block };
}

/** Block indices containing (x, z). */
export function blockAt(x: number, z: number): [number, number] {
  return [Math.floor(mod(x - GRID.x0, PLANET.circumference) / GRID.pitch), Math.floor(mod(z - GRID.z0, PLANET.circumference) / GRID.pitch)];
}
