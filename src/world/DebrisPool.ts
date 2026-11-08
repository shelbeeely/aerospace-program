import RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../tuning.ts';
import type { Block, BlockBuilding } from './BlockBuilding.ts';

/** A piece of a building that broke away: one dynamic compound body, one cuboid per block. */
export interface Chunk {
  readonly id: number;
  readonly building: BlockBuilding;
  /** The building blocks it is made of (no longer part of the building). */
  readonly blocks: readonly Block[];
  /** Block centres relative to the body origin (m), in `blocks` order. */
  readonly offsets: Float32Array;
  /** Distance from the body origin to its farthest block corner (m). */
  readonly radius: number;
  /** Total mass (kg). */
  readonly mass: number;
  readonly body: RAPIER.RigidBody;
  readonly colliders: RAPIER.Collider[];
  /** Sim time it broke away (s). */
  readonly spawnTime: number;
  /** Settled: turned into a fixed body, still solid and visible, until something near it breaks. */
  frozen: boolean;
  /** Sim time it started moving slower than the settle speed (s), or -1. */
  slowSince: number;
}

/** Collider-handle bookkeeping for chunk colliders (the town keeps one map for everything). */
export interface ChunkRegistry {
  addChunkCollider(collider: RAPIER.Collider, chunk: Chunk): void;
  deleteChunkCollider(collider: RAPIER.Collider): void;
  /** A moving chunk is being destroyed to make room under the caps (it would have smashed anyway). */
  evicted(chunk: Chunk): void;
}

/**
 * Falling rubble, with hard caps so a collapsing skyline can't stall the physics: at most
 * `maxDynamicChunks` moving chunks with `maxDynamicChunkColliders` colliders between them. A
 * new chunk past the caps destroys the oldest moving ones. Chunks that settle are frozen (fixed
 * bodies cost next to nothing) and woken again if something near them breaks; frozen rubble
 * past its own caps is removed oldest first, and anything that falls out of the world at once.
 */
export class DebrisPool {
  readonly chunks: Chunk[] = [];
  private nextId = 1;
  /** Bumped whenever a chunk is added or removed (renderers watch it). */
  version = 0;

  constructor(
    private readonly world: RAPIER.World,
    private readonly registry: ChunkRegistry,
  ) {}

  get dynamicChunks(): number {
    let n = 0;
    for (const c of this.chunks) if (!c.frozen) n++;
    return n;
  }

  get dynamicColliders(): number {
    let n = 0;
    for (const c of this.chunks) if (!c.frozen) n += c.colliders.length;
    return n;
  }

  /**
   * Turn blocks (already taken out of their building) into one falling chunk carrying
   * `velocity`. Returns null if the group alone is bigger than the collider cap (it is
   * destroyed instead).
   */
  spawn(building: BlockBuilding, blocks: readonly Block[], time: number, velocity = { x: 0, y: 0, z: 0 }): Chunk | null {
    const n = blocks.length;
    if (n === 0 || n > TUNING.maxDynamicChunkColliders) return null;
    this.makeRoom(n);

    // Body at the group's centroid (world), blocks as offsets from it.
    const p = { x: 0, y: 0, z: 0 };
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const centres = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      building.worldCentre(blocks[i], p);
      centres[i * 3] = p.x;
      centres[i * 3 + 1] = p.y;
      centres[i * 3 + 2] = p.z;
      cx += p.x;
      cy += p.y;
      cz += p.z;
    }
    cx /= n;
    cy /= n;
    cz /= n;
    const s = building.blockSize;
    const offsets = new Float32Array(n * 3);
    let radius = 0;
    for (let i = 0; i < n; i++) {
      offsets[i * 3] = centres[i * 3] - cx;
      offsets[i * 3 + 1] = centres[i * 3 + 1] - cy;
      offsets[i * 3 + 2] = centres[i * 3 + 2] - cz;
      radius = Math.max(radius, Math.hypot(offsets[i * 3], offsets[i * 3 + 1], offsets[i * 3 + 2]));
    }
    radius += (s * Math.sqrt(3)) / 2;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(cx, cy, cz)
        .setLinvel(velocity.x, velocity.y, velocity.z)
        .setLinearDamping(0.02)
        .setAngularDamping(0.2)
        .setCcdEnabled(true),
    );
    // Slightly undersized so the chunk doesn't start in contact with what it broke away from.
    const half = (s / 2) * 0.97;
    const density = TUNING.blockMass / (2 * half) ** 3;
    const chunk: Chunk = {
      id: this.nextId++,
      building,
      blocks: [...blocks],
      offsets,
      radius,
      mass: n * TUNING.blockMass,
      body,
      colliders: [],
      spawnTime: time,
      frozen: false,
      slowSince: -1,
    };
    // Report every contact worth more than a 1 m/s knock on one block; resting weight stays quiet.
    const threshold = TUNING.blockMass * 1 * TUNING.physicsHz;
    for (let i = 0; i < n; i++) {
      const col = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(half, half, half)
          .setTranslation(offsets[i * 3], offsets[i * 3 + 1], offsets[i * 3 + 2])
          .setDensity(density)
          .setFriction(0.7)
          .setRestitution(0.05)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(threshold),
        body,
      );
      chunk.colliders.push(col);
      this.registry.addChunkCollider(col, chunk);
    }
    this.chunks.push(chunk);
    this.version++;
    return chunk;
  }

  /** Room under the dynamic caps for one more chunk of `incoming` colliders? */
  private fits(incoming: number): boolean {
    return this.dynamicChunks + 1 <= TUNING.maxDynamicChunks && this.dynamicColliders + incoming <= TUNING.maxDynamicChunkColliders;
  }

  /** Destroy the oldest moving chunks until `incoming` more colliders fit under the caps. */
  private makeRoom(incoming: number): void {
    while (!this.fits(incoming)) {
      const oldest = this.chunks.find((c) => !c.frozen);
      if (!oldest) break;
      this.registry.evicted(oldest);
      this.remove(oldest);
    }
  }

  private freeze(c: Chunk): void {
    if (c.frozen) return;
    c.frozen = true;
    c.body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
  }

  /**
   * Something at (x, y, z) broke: frozen chunks that could have been resting on it fall again
   * (as far as the dynamic caps allow).
   */
  wake(x: number, y: number, z: number, reach: number): void {
    for (const c of this.chunks) {
      if (!c.frozen) continue;
      const t = c.body.translation();
      if (Math.hypot(t.x - x, t.y - y, t.z - z) > c.radius + reach) continue;
      if (!this.fits(c.colliders.length)) return;
      c.frozen = false;
      c.slowSince = -1;
      c.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    }
  }

  /** Remove a chunk from the world (shattered, fell out of the world, or pruned). */
  remove(c: Chunk): void {
    const i = this.chunks.indexOf(c);
    if (i < 0) return;
    this.chunks.splice(i, 1);
    for (const col of c.colliders) this.registry.deleteChunkCollider(col);
    this.world.removeRigidBody(c.body);
    this.version++;
  }

  /** Per step: freeze settled chunks, drop ones that left the world, prune old frozen rubble. */
  update(time: number): void {
    if (!this.chunks.length) return;
    const v = TUNING.chunkSettleSpeed;
    let frozenChunks = 0;
    let frozenColliders = 0;
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i];
      if (c.frozen) {
        frozenChunks++;
        frozenColliders += c.colliders.length;
        continue;
      }
      const t = c.body.translation();
      if (!Number.isFinite(t.x + t.y + t.z) || t.y < -50) {
        this.remove(c);
        continue;
      }
      const lv = c.body.linvel();
      const av = c.body.angvel();
      const slow = c.body.isSleeping() || (Math.hypot(lv.x, lv.y, lv.z) < v && Math.hypot(av.x, av.y, av.z) < v);
      if (!slow) c.slowSince = -1;
      else if (c.slowSince < 0) c.slowSince = time;
      else if (time - c.slowSince >= TUNING.chunkSettleTime) {
        this.freeze(c);
        frozenChunks++;
        frozenColliders += c.colliders.length;
      }
    }
    if (frozenChunks <= TUNING.maxFrozenChunks && frozenColliders <= TUNING.maxFrozenChunkColliders) return;
    // Oldest first (chunks are in spawn order).
    const prune: Chunk[] = [];
    for (const c of this.chunks) {
      if (frozenChunks <= TUNING.maxFrozenChunks && frozenColliders <= TUNING.maxFrozenChunkColliders) break;
      if (!c.frozen) continue;
      prune.push(c);
      frozenChunks--;
      frozenColliders -= c.colliders.length;
    }
    for (const c of prune) this.remove(c);
  }

  /** Remove all rubble. */
  clear(): void {
    while (this.chunks.length) this.remove(this.chunks[this.chunks.length - 1]);
  }
}
