import RAPIER from '@dimforge/rapier3d-compat';
import { mulberry32 } from '../sim/atmosphere.ts';
import type { ContactForceInfo } from '../sim/damage.ts';
import type { ChipEmitter } from '../sim/chips.ts';
import { TOWN } from '../sim/layout.ts';
import { TUNING } from '../tuning.ts';
import { BlockBuilding, connectedGroups, type Block, type BuildingDef } from './BlockBuilding.ts';
import { DebrisPool, type Chunk } from './DebrisPool.ts';

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
        color: town.colors[(col * 2 + row * 3) % town.colors.length],
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
  /** Bumped by every reset (renderers drop their effects). */
  resets = 0;
  /** Visual chips knocked off blocks (set by the simulation). */
  chips: ChipEmitter | null = null;
  /** Velocity of whatever last struck each block this step (chips fly with it). */
  private readonly blockHitVel = new Map<Block, { x: number; y: number; z: number }>();
  /** Collider handle -> what it belongs to. */
  private readonly owners = new Map<number, Owner>();
  private readonly blockImpulse = new Map<Block, number>();
  /** Impulse taken by each chunk this step (N·s). */
  private readonly chunkImpulse = new Map<Chunk, number>();
  private readonly touched = new Set<BlockBuilding>();
  /** Buildings that lost blocks outside `update` (ripped out by wind): support is rechecked next update. */
  private readonly pendingSupport = new Set<BlockBuilding>();
  private readonly _p = { x: 0, y: 0, z: 0 };
  private readonly world: RAPIER.World;
  private readonly registry: { add(c: RAPIER.Collider, block: Block): void; delete(c: RAPIER.Collider): void };

  constructor(
    world: RAPIER.World,
    defs: readonly BuildingDef[] = townBuildings(),
  ) {
    this.world = world;
    this.registry = {
      add: (c: RAPIER.Collider, block: Block) => void this.owners.set(c.handle, { block }),
      delete: (c: RAPIER.Collider) => void this.owners.delete(c.handle),
    };
    for (const def of defs) this.buildings.push(new BlockBuilding(world, def, this.registry));
    this.pool = new DebrisPool(world, {
      addChunkCollider: (c, chunk) => void this.owners.set(c.handle, { chunk }),
      deleteChunkCollider: (c) => void this.owners.delete(c.handle),
      evicted: (chunk) => this.breakChunk(chunk, this.lastTime),
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
    const a = this.owners.get(e.collider1);
    const b = this.owners.get(e.collider2);
    if (a) this.hit(a, b, impulse, e.collider2);
    if (b) this.hit(b, a, impulse, e.collider1);
  }

  private velocityOf(handle: number): { x: number; y: number; z: number } {
    const v = this.world.getCollider(handle)?.parent()?.linvel();
    return v ? { x: v.x, y: v.y, z: v.z } : { x: 0, y: 0, z: 0 };
  }

  private hit(o: Owner, other: Owner | undefined, impulse: number, otherHandle = -1): void {
    if (o.block && otherHandle >= 0 && !this.blockHitVel.has(o.block)) this.blockHitVel.set(o.block, this.velocityOf(otherHandle));
    if (o.block) {
      // Rubble merely lying on a block (its weight, step after step) doesn't wear it down;
      // only a real impact from it counts.
      if (other?.chunk && impulse < 0.5 * o.block.building.blockMass * TUNING.chunkShatterSpeed) return;
      if (o.block.alive) this.blockImpulse.set(o.block, (this.blockImpulse.get(o.block) ?? 0) + impulse);
    } else {
      this.chunkImpulse.set(o.chunk, (this.chunkImpulse.get(o.chunk) ?? 0) + impulse);
    }
  }

  private lastTime = 0;

  /**
   * Earthquake shaking (ground acceleration, m/s²). Upper floors of slender buildings sway more
   * (amplification 1 + 0.6 × floor / footprint); a block whose amplified horizontal acceleration
   * beats `quakeBlockStrength` × its fragility gives way, and the support check does the rest.
   */
  shake(accel: { x: number; z: number }): void {
    const a = Math.hypot(accel.x, accel.z);
    const weakest = TUNING.quakeBlockStrength * 0.7;
    if (a < weakest / 4) return;
    for (let bi = 0; bi < this.buildings.length; bi++) {
      const building = this.buildings[bi];
      const [w, h, d] = building.def.size;
      const footprint = Math.max(1, Math.min(w, d));
      if (a * (1 + (0.6 * (h - 1)) / footprint) < weakest) continue;
      for (const b of building.list) {
        if (!b.alive) continue;
        const amp = 1 + (0.6 * b.y) / footprint;
        if (a * amp > TUNING.quakeBlockStrength * fragility(bi, b.index)) this.blockImpulse.set(b, Infinity);
      }
    }
  }

  /** Apply this step's hits: destroy blocks, drop what lost support, shatter hard landings. */
  update(time: number): void {
    this.lastTime = time;
    if (!this.blockImpulse.size && !this.chunkImpulse.size && !this.pool.chunks.length && !this.pendingSupport.size) return;
    const touched = this.touched;
    touched.clear();
    for (const b of this.pendingSupport) touched.add(b);
    this.pendingSupport.clear();
    const s = TUNING.blockSize;
    if (this.blockImpulse.size) {
      for (const [b, j] of this.blockImpulse) {
        if (!b.alive) continue;
        const bs = b.building.blockSize;
        const v = this.blockHitVel.get(b) ?? { x: 0, y: 0, z: 0 };
        if (j <= b.building.breakImpulse) {
          // A knock that doesn't break the block still chips its face.
          const share = j / b.building.breakImpulse;
          if (share > 0.12 && this.chips) {
            const c = b.building.worldCentre(b, this._p);
            this.chips.emit({ x: c.x, y: c.y, z: c.z, radius: bs / 2, vx: v.x * 0.25, vy: v.y * 0.25, vz: v.z * 0.25, speed: 3 + 6 * share, count: Math.min(8, Math.ceil(share * 8)), size: Math.min(0.9, Math.max(0.3, bs / 8)), color: b.building.def.color });
          }
          continue;
        }
        b.building.remove(b);
        const p = this.recordBreak(b.building, b, time);
        if (this.chips) {
          // The block bursts into small voxels thrown along with whatever hit it.
          const n = Math.min(32, Math.round(10 * (bs / TUNING.blockSize) ** 1.5));
          this.chips.emit({ x: p.x, y: p.y, z: p.z, radius: bs / 2, vx: v.x * 0.35, vy: v.y * 0.35 + 2, vz: v.z * 0.35, speed: Number.isFinite(j) ? Math.min(16, 5 + 4 * Math.log2(1 + j / b.building.breakImpulse)) : 6, count: n, size: Math.min(1.2, Math.max(0.4, bs / 5)), color: b.building.def.color });
        }
        this.pool.wake(p.x, p.y, p.z, bs * 1.5);
        touched.add(b.building);
      }
      this.blockImpulse.clear();
      this.blockHitVel.clear();
    }
    if (this.chunkImpulse.size) {
      // A chunk shatters when the step's impulse would change its whole velocity by more than
      // `chunkShatterSpeed`: the same drop height smashes a lone block or a ten-storey slab.
      for (const [c, j] of this.chunkImpulse) {
        if (j / c.mass <= TUNING.chunkShatterSpeed || !this.pool.chunks.includes(c)) continue;
        const t = c.body.translation();
        this.breakChunk(c, time);
        this.pool.remove(c);
        this.pool.wake(t.x, t.y, t.z, c.radius + s);
      }
      this.chunkImpulse.clear();
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

  /** Record every block of a chunk as destroyed (the caller removes the chunk). */
  private breakChunk(c: Chunk, time: number): void {
    const t = c.body.translation();
    const r = c.body.rotation();
    const p = this._p;
    const v = c.body.linvel();
    const every = Math.max(1, Math.ceil(c.blocks.length / 40));
    for (let i = 0; i < c.blocks.length; i++) {
      rotate(r, c.offsets[i * 3], c.offsets[i * 3 + 1], c.offsets[i * 3 + 2], p);
      this.pushBreak(t.x + p.x, t.y + p.y, t.z + p.z, c.building.def.color, time);
      if (this.chips && i % every === 0) {
        const bs = c.building.blockSize;
        this.chips.emit({ x: t.x + p.x, y: t.y + p.y, z: t.z + p.z, radius: bs / 2, vx: v.x * 0.3, vy: Math.abs(v.y) * 0.2 + 2, vz: v.z * 0.3, speed: 6, count: Math.min(12, Math.round(6 * (bs / TUNING.blockSize))), size: Math.min(1.2, Math.max(0.4, bs / 5)), color: c.building.def.color });
      }
    }
    this.version++;
  }

  private recordBreak(building: BlockBuilding, b: Block, time: number): { x: number; y: number; z: number } {
    const p = building.worldCentre(b, this._p);
    this.pushBreak(p.x, p.y, p.z, building.def.color, time);
    return p;
  }

  private pushBreak(x: number, y: number, z: number, color: string, time: number): void {
    this.destroyed++;
    this.breaks.push({ x, y, z, color, time });
    if (this.breaks.length > 256) this.breaks.splice(0, this.breaks.length - 256);
  }

  /** Add a breakable building at runtime (a city tower that just fractured). */
  addBuilding(def: BuildingDef): BlockBuilding {
    const b = new BlockBuilding(this.world, def, this.registry);
    this.buildings.push(b);
    this.version++;
    return b;
  }

  /** Take a runtime building out of the world entirely (its rubble stays until it settles). */
  removeBuilding(b: BlockBuilding): void {
    const i = this.buildings.indexOf(b);
    if (i < 0) return;
    this.buildings.splice(i, 1);
    b.dispose();
    this.version++;
  }

  /**
   * Destroy every block of `building` within `radius` of a world point (an impact crater), and
   * queue the support check. Returns how many blocks went.
   */
  blast(building: BlockBuilding, x: number, y: number, z: number, radius: number, time: number): number {
    let n = 0;
    const p = this._p;
    for (const b of building.list) {
      if (!b.alive) continue;
      building.worldCentre(b, p);
      if ((p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2 > radius * radius) continue;
      this.blockImpulse.set(b, Infinity);
      n++;
    }
    void time;
    return n;
  }

  /**
   * Wind tearing blocks out whole (a tornado): each block leaves its building as its own rubble
   * body carrying `velocity(block)`, so the wind can take it; what it held up falls on the next
   * update. A block the rubble caps can't take is destroyed instead. Returns the blocks taken.
   */
  rip(building: BlockBuilding, blocks: readonly Block[], time: number, velocity: (b: Block) => { x: number; y: number; z: number }): number {
    let n = 0;
    for (const b of blocks) {
      if (!b.alive) continue;
      const v = velocity(b);
      building.remove(b);
      if (!this.pool.spawn(building, [b], time, v)) this.recordBreak(building, b, time);
      else this.destroyed++;
      n++;
    }
    if (n) {
      this.pendingSupport.add(building);
      this.version++;
    }
    return n;
  }

  /** Destroy these blocks outright on the next update (they burst into chips). */
  destroy(blocks: readonly Block[]): number {
    let n = 0;
    for (const b of blocks) if (b.alive) { this.blockImpulse.set(b, Infinity); n++; }
    return n;
  }

  /** Every building whole again, all rubble gone. */
  reset(): void {
    this.pendingSupport.clear();
    this.pool.clear();
    for (const b of this.buildings) b.restore();
    this.blockImpulse.clear();
    this.blockHitVel.clear();
    this.chunkImpulse.clear();
    this.breaks.length = 0;
    this.chips?.reset();
    this.destroyed = 0;
    this.version++;
    this.resets++;
  }
}

/** Seeded per-block strength factor 0.7..1.3 (same every run). */
function fragility(building: number, block: number): number {
  let h = Math.imul(building + 1, 0x9e3779b1) ^ Math.imul(block + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 13;
  return 0.7 + 0.6 * ((h >>> 0) / 4294967296);
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
