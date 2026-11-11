import { GRID } from '../arch/grid.ts';
import { hash32 } from '../arch/rng.ts';
import { regionAt, regionSites } from '../arch/WorldRegionManager.ts';
import { chunkAt } from '../world/planetCity.ts';
import type { Team } from './teams.ts';

/**
 * Who holds each district. At the start a district belongs to the team of the region cell its
 * centre lies in (each region cell is given a team by a hash of its indices, so territory comes
 * in large contiguous patches, about a third each); the sea belongs to no one. Captures override
 * that until the world is reset.
 */

const SEED = 0x7ea3;
const n = () => GRID.chunks;
const key = (ci: number, cj: number) => `${((ci % n()) + n()) % n()},${((cj % n()) + n()) % n()}`;

let dealt: Map<string, Team> | null = null;

/**
 * The team a region cell starts with: the cells are dealt round the three teams in an order
 * shuffled by a hash of their indices, so each team holds a third of them.
 */
export function regionTeam(i: number, j: number): Team {
  if (!dealt) {
    const cells = regionSites().map((s) => ({ k: `${s.i},${s.j}`, h: hash32(SEED, s.i, s.j) })).sort((a, b) => a.h - b.h);
    dealt = new Map(cells.map((c, r) => [c.k, (r % 3) as Team]));
  }
  return dealt.get(`${i},${j}`) ?? ((hash32(SEED, i, j) % 3) as Team);
}

const baseCache = new Map<string, Team | null>();

/** The team a district starts with (null: open sea). */
export function baseOwner(ci: number, cj: number): Team | null {
  const k = key(ci, cj);
  if (baseCache.has(k)) return baseCache.get(k)!;
  const x = GRID.x0 + (ci + 0.5) * GRID.chunkSize, z = GRID.z0 + (cj + 0.5) * GRID.chunkSize;
  const site = regionAt(x, z).site;
  const team = site.kind === 'sea' ? null : regionTeam(site.i, site.j);
  baseCache.set(k, team);
  return team;
}

export class Territory {
  private readonly captured = new Map<string, Team>();
  /** Bumped on every capture and reset (the planet map redraws its wash). */
  version = 0;

  ownerOf(ci: number, cj: number): Team | null {
    return this.captured.get(key(ci, cj)) ?? baseOwner(ci, cj);
  }

  ownerAt(x: number, z: number): Team | null {
    const [ci, cj] = chunkAt(x, z);
    return this.ownerOf(ci, cj);
  }

  /** A team takes the district. True if it changed hands. */
  capture(ci: number, cj: number, team: Team): boolean {
    if (this.ownerOf(ci, cj) === team) return false;
    this.captured.set(key(ci, cj), team);
    this.version++;
    return true;
  }

  /** Districts taken from their starting owner, for the map. */
  captures(): Array<{ ci: number; cj: number; team: Team }> {
    return [...this.captured].map(([k, team]) => {
      const [ci, cj] = k.split(',').map(Number);
      return { ci, cj, team };
    });
  }

  reset(): void {
    if (!this.captured.size) return;
    this.captured.clear();
    this.version++;
  }
}
