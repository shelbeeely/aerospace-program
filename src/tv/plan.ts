import { planetChunk } from '../world/planetCity.ts';
import { worldStructures, type Structure } from '../world/structures.ts';

/**
 * The game's structure list rebuilt from its chunk list, for a TV that does not run the game
 * (the phone does): the centre, then each registered planet chunk in the host's order, with the
 * same offsets and group ids as StaticWorld gives them, so `frame.broken` names the same
 * structures. DOM-free (it runs in the TV's planning worker).
 */
export class StructurePlan {
  readonly list: Structure[];
  private groups: number;
  private chunks = 0;

  constructor() {
    const w = worldStructures();
    this.list = [...w.list];
    this.groups = w.groups.length;
  }

  /** Add the chunks of `flat` ([ci, cj, ox, oz]*, in registration order) not added yet; returns the first new index. */
  addChunks(flat: readonly number[]): number {
    const start = this.list.length;
    for (let k = this.chunks * 4; k + 3 < flat.length; k += 4) {
      const c = planetChunk(flat[k], flat[k + 1]);
      const g0 = this.groups;
      this.groups += c.structures.groups.length;
      for (const p of c.structures.list) this.list.push({ ...p, x: p.x + flat[k + 2], z: p.z + flat[k + 3], group: g0 + p.group });
      this.chunks++;
    }
    return start;
  }
}
