import RAPIER from '@dimforge/rapier3d-compat';
import type { ContactForceInfo } from '../sim/damage.ts';
import { TOWN } from '../sim/layout.ts';
import { TUNING } from '../tuning.ts';
import { BlockBuilding, connectedGroups, type Block, type BuildingDef } from './BlockBuilding.ts';
import { DebrisPool, type Chunk } from './DebrisPool.ts';

/** Deterministic PRNG (same town on every load). */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seeded building list of the town in LAYOUT's TOWN (one building per lot). */
export function townBuildings(town = TOWN, blockSize = TUNING.blockSize): BuildingDef[] {
  const rnd = mulberry32(town.seed);
  const pick = ([lo, hi]: readonly [number, number]) => lo + Math.floor(rnd() * (hi - lo + 1));
  const out: BuildingDef[] = [];
  for (let row = 0; row < town.rows; row++)
    for (let col = 0; col < town.columns; col++) {
      const cx = town.centerX + (col - (town.columns - 1) / 2) * town.lot;
      const cz = town.centerZ + (row - (town.rows - 1) / 2) * town.lot;
      const w = pick(town.footprint);
      const d = pick(town.footprint);
      const h = pick(town.floors);
      // Jitter within the lot, keeping at least a 12 m street between neighbours.
      const slackX = Math.max(0, (town.lot - 12 - w * blockSize) / 2);
      const slackZ = Math.max(0, (town.lot - 12 - d * blockSize) / 2);
      const x = cx - (w * blockSize) / 2 + (rnd() * 2 - 1) * slackX;
      const z = cz - (d * blockSize) / 2 + (rnd() * 2 - 1) * slackZ;
      out.push({
        id: `b${out.length}`,
        origin: [Math.round(x * 10) / 10, 0, Math.round(z * 10) / 10],
        size: [w, h, d],
        color: town.colors[Math.floor(rnd() * town.colors.length)],
      });
    }
  return out;
}

/** A block that just died (render effects). */
export interface BlockBreak {
  x: number;
  y: number;
  z: number;
  color: string;
  time: number;
}

type Owner = { block: Block; chunk?: undefined } | { chunk: Chunk; block?: undefined };

/**
 * The town: breakable block buildings plus the rubble pool, living in the simulation's Rapier
 * world. Feed it the world's contact-force events (`onContact`) and call `update` once per step
 * after they're dispatched:
 *
 * - a block whose contact impulse in one step exceeds `blockBreakImpulse` is destroyed;
 * - the building's anchor check then finds blocks no longer connected to the ground, splits them
 *   into face-connected chunks and hands each to the DebrisPool as one dynamic body, so the top
 *   of a building falls;
 * - a chunk that lands (or is hit) hard enough shatters: its blocks are destroyed.
 *
 * The craft side of a collision is the damage model's job (impact damage breaks parts off).
 */
export class Town {
  readonly buildings: BlockBuilding[] = [];
  readonly pool: DebrisPool;
  /** Recently destroyed blocks, newest last (capped; for render effects). */
  readonly breaks: BlockBreak[] = [];
  /** Blocks destroyed since the last reset. */
  destroyed = 0;
  /** Bumped on every change to any building or the rubble (renderers watch it). */
  version = 0;
  /** Collider handle -> what it belongs to. */
  private readonly owners = new Map<number, Owner>();
  private readonly blockImpulse = new Map<Block, number>();
  private readonly shatter = new Set<Chunk>();

  constructor(
    world: RAPIER.World,
    defs: readonly BuildingDef[] = townBuildings(),
  ) {
    const registry = {
      add: (c: RAPIER.Collider, block: Block) => void this.owners.set(c.handle, { block }),
      delete: (c: RAPIER.Collider) => void this.owners.delete(c.handle),
    };
    for (const def of defs) this.buildings.push(new BlockBuilding(world, def, registry));
    this.pool = new DebrisPool(world, {
      addChunkCollider: (c, chunk) => void this.owners.set(c.handle, { chunk }),
      deleteChunkCollider: (c) => void this.owners.delete(c.handle),
    });
  }

  /** Total blocks in the town (alive or not). */
  get blockCount(): number {
    return this.buildings.reduce((n, b) => n + b.list.length, 0);
  }

  /** The building block owning this collider, if any. */
  blockForCollider(handle: number): Block | undefined {
    return this.owners.get(handle)?.block;
  }

  /** The rubble chunk owning this collider, if any. */
  chunkForCollider(handle: number): Chunk | undefined {
    return this.owners.get(handle)?.chunk;
  }

  /** Rubble that broke away less than a second ago (the damage model ignores it, like part debris). */
  isFreshDebris(handle: number, time: number): boolean {
    const c = this.owners.get(handle)?.chunk;
    return c !== undefined && time - c.spawnTime < 1;
  }

  /** One contact-force event (the object is reused by the sender: nothing is kept). */
  onContact(e: ContactForceInfo): void {
    const impulse = e.totalForceMagnitude * e.dt;
    this.hit(e.collider1, impulse);
    this.hit(e.collider2, impulse);
  }

  private hit(handle: number, impulse: number): void {
    const o = this.owners.get(handle);
    if (!o) return;
    if (o.block) {
      if (o.block.alive) this.blockImpulse.set(o.block, (this.blockImpulse.get(o.block) ?? 0) + impulse);
    } else if (impulse > TUNING.blockMass * TUNING.chunkShatterSpeed) this.shatter.add(o.chunk);
  }

  /** Apply this step's hits: destroy blocks, drop what lost support, shatter hard landings. */
  update(time: number): void {
    const touched = new Set<BlockBuilding>();
    if (this.blockImpulse.size) {
      for (const [b, j] of this.blockImpulse) {
        if (!b.alive || j <= TUNING.blockBreakImpulse) continue;
        b.building.remove(b);
        this.recordBreak(b.building, b, time);
        touched.add(b.building);
      }
      this.blockImpulse.clear();
    }
    if (this.shatter.size) {
      const p = { x: 0, y: 0, z: 0 };
      for (const c of this.shatter) {
        if (!this.pool.chunks.includes(c)) continue;
        const t = c.body.translation();
        const r = c.body.rotation();
        for (let i = 0; i < c.blocks.length; i++) {
          rotate(r, c.offsets[i * 3], c.offsets[i * 3 + 1], c.offsets[i * 3 + 2], p);
          this.pushBreak(t.x + p.x, t.y + p.y, t.z + p.z, c.building.def.color, time);
        }
        this.pool.remove(c);
      }
      this.shatter.clear();
      this.version++;
    }
    for (const building of touched) {
      const loose = building.unsupported();
      if (!loose.length) continue;
      for (const group of connectedGroups(loose)) {
        for (const b of group) building.remove(b);
        // A group too big for the rubble caps is destroyed outright.
        if (!this.pool.spawn(building, group, time)) for (const b of group) this.recordBreak(building, b, time);
      }
    }
    if (touched.size) this.version++;
    const pv = this.pool.version;
    this.pool.update(time);
    if (pv !== this.pool.version) this.version++;
  }

  private recordBreak(building: BlockBuilding, b: Block, time: number): void {
    const p = building.worldCentre(b, { x: 0, y: 0, z: 0 });
    this.pushBreak(p.x, p.y, p.z, building.def.color, time);
  }

  private pushBreak(x: number, y: number, z: number, color: string, time: number): void {
    this.destroyed++;
    this.breaks.push({ x, y, z, color, time });
    if (this.breaks.length > 256) this.breaks.splice(0, this.breaks.length - 256);
  }

  /** Every building whole again, all rubble gone. */
  reset(): void {
    this.pool.clear();
    for (const b of this.buildings) b.restore();
    this.blockImpulse.clear();
    this.shatter.clear();
    this.breaks.length = 0;
    this.destroyed = 0;
    this.version++;
  }
}

/** Rotate (x, y, z) by quaternion q into out. */
function rotate(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number, out: { x: number; y: number; z: number }) {
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  out.x = x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = z + q.w * tz + (q.x * ty - q.y * tx);
}
