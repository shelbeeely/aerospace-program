import { CITY, COAST, isSea, TOWN, wrapCoord, type LandingSite } from '../sim/layout.ts';
import { terrainHeight } from '../sim/terrain.ts';
import { obstacleTop } from './structures.ts';

/**
 * Where a craft can be spawned: any runway (its threshold, facing down the strip), any helipad
 * (its centre, at pad height) or, for ground vehicles, the street nearest to where the craft was.
 */
export type SpawnSite = LandingSite | { kind: 'street'; id: 'street'; name: string };

export const STREET_SITE: SpawnSite = { kind: 'street', id: 'street', name: 'Nearest street' };

/** A spawn point: ground position (x, y, z) and heading as a rotation about +Y (0 faces -Z). */
export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** How far in from a runway's threshold the craft starts (Grid International: z = 360). */
const RUNWAY_INSET = 40;

/** The spawn point of a runway or helipad. */
export function siteSpawnPoint(site: LandingSite): SpawnPoint {
  if (site.kind === 'helipad') return { x: site.x, y: site.y, z: site.z, yaw: 0 };
  const along = site.length / 2 - Math.min(RUNWAY_INSET, site.length / 4);
  // Start at the + end, facing down the strip toward the - end.
  return site.axis === 'z'
    ? { x: site.x, y: site.y, z: site.z + along, yaw: 0 }
    : { x: site.x + along, y: site.y, z: site.z, yaw: Math.PI / 2 };
}

const PITCH = CITY.block + CITY.street;
/** Points along a street, as fractions of a block from an intersection: clear of crossings and of the freeway pillars at mid-block. */
const ALONG = [0.3, 0.7];
const TOWN_HALF_X = (TOWN.columns * TOWN.lot) / 2 + 30;
const TOWN_HALF_Z = (TOWN.rows * TOWN.lot) / 2 + 30;

/** Nothing standing on the street around (x, z) along the given axis (no tower, pillar, deck or town block), on level ground. */
function streetClear(x: number, z: number, axis: 'x' | 'z'): boolean {
  if (isSea(x)) return false;
  if (Math.abs(wrapCoord(x - TOWN.centerX)) < TOWN_HALF_X && Math.abs(wrapCoord(z - TOWN.centerZ)) < TOWN_HALF_Z) return false;
  const ground = terrainHeight(x, z);
  for (const d of [-6, 0, 6]) {
    const px = axis === 'x' ? x + d : x;
    const pz = axis === 'z' ? z + d : z;
    const h = terrainHeight(px, pz);
    // Level ground (not on the face of an Outlands solid) with nothing standing on it.
    if (Math.abs(h - ground) > 0.3 || obstacleTop(px, pz) > h + 0.5) return false;
  }
  return true;
}

/**
 * The nearest clear point on a street centreline to (x, z), facing along the street. Streets
 * run on the city grid lines (x0 + i·pitch, z0 + j·pitch) all the way round the planet; points
 * are tried in order of distance, skipping the sea, the town and anything standing in the way.
 * Null if none within six blocks is clear.
 */
export function nearestStreetPoint(x: number, z: number): SpawnPoint | null {
  if (!Number.isFinite(x + z)) { x = 0; z = 0; }
  // Over the sea: start from the nearer shore.
  if (isSea(x)) {
    const into = wrapCoord(x - COAST.x);
    x = into < COAST.width / 2 ? x - into - 60 : x + (COAST.width - into) + 60;
  }
  const i0 = Math.round((x - CITY.x0) / PITCH);
  const j0 = Math.round((z - CITY.z0) / PITCH);
  const candidates: Array<SpawnPoint & { d: number; axis: 'x' | 'z' }> = [];
  for (let a = -6; a <= 6; a++) for (let b = -6; b <= 6; b++) for (const f of ALONG) {
    // A street along Z (constant x) and one along X (constant z), each a fraction f into the block.
    const sx = CITY.x0 + (i0 + a) * PITCH;
    const sz = CITY.z0 + (j0 + b + f) * PITCH;
    candidates.push({ x: sx, z: sz, y: 0, yaw: 0, axis: 'z', d: Math.hypot(sx - x, sz - z) });
    const tx = CITY.x0 + (i0 + a + f) * PITCH;
    const tz = CITY.z0 + (j0 + b) * PITCH;
    candidates.push({ x: tx, z: tz, y: 0, yaw: Math.PI / 2, axis: 'x', d: Math.hypot(tx - x, tz - z) });
  }
  candidates.sort((p, q) => p.d - q.d);
  const best = candidates.find((c) => streetClear(c.x, c.z, c.axis));
  if (!best) return null; // nothing clear nearby: the caller falls back to the runway
  return { x: best.x, y: terrainHeight(best.x, best.z), z: best.z, yaw: best.yaw };
}
