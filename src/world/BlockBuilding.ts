import RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../tuning.ts';

/**
 * Breakable block buildings: a W×H×D grid of cubes kept in a spatial dictionary keyed "x,y,z".
 * When blocks die, an anchor check (BFS from the ground layer over the 6 face neighbours) finds
 * which living blocks are no longer connected to the ground; those break away as rubble.
 *
 * The support functions are pure (no Rapier) so they can be unit-tested headless.
 */

/** What the support check needs to know about a block. */
export interface BlockCell {
  /** Grid coordinates (y = 0 is the ground layer). */
  x: number;
  y: number;
  z: number;
  alive: boolean;
  supported: boolean;
}

export const blockKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Anchor check: clear `supported` on every block, then breadth-first search from all living
 * ground-layer (y = 0) blocks over the 6 cardinal neighbours, marking each living block reached
 * as supported.
 */
export function markSupport<T extends BlockCell>(blocks: ReadonlyMap<string, T>): void {
  const queue: T[] = [];
  for (const b of blocks.values()) {
    b.supported = b.alive && b.y === 0;
    if (b.supported) queue.push(b);
  }
  for (let i = 0; i < queue.length; i++) {
    const b = queue[i];
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const n = blocks.get(blockKey(b.x + dx, b.y + dy, b.z + dz));
      if (n && n.alive && !n.supported) {
        n.supported = true;
        queue.push(n);
      }
    }
  }
}

/** Living blocks the last `markSupport` didn't reach: they have nothing holding them up. */
export function findUnsupported<T extends BlockCell>(blocks: ReadonlyMap<string, T>): T[] {
  const out: T[] = [];
  for (const b of blocks.values()) if (b.alive && !b.supported) out.push(b);
  return out;
}

/**
 * Split a set of blocks into face-connected groups (flood fill restricted to `cells`). Each group
 * falls as one rigid chunk.
 */
export function connectedGroups<T extends BlockCell>(cells: readonly T[]): T[][] {
  const byKey = new Map<string, T>();
  for (const c of cells) byKey.set(blockKey(c.x, c.y, c.z), c);
  const seen = new Set<T>();
  const groups: T[][] = [];
  for (const start of cells) {
    if (seen.has(start)) continue;
    seen.add(start);
    const group = [start];
    for (let i = 0; i < group.length; i++) {
      const b = group[i];
      for (const [dx, dy, dz] of NEIGHBOURS) {
        const n = byKey.get(blockKey(b.x + dx, b.y + dy, b.z + dz));
        if (n && !seen.has(n)) {
          seen.add(n);
          group.push(n);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/** A filled W×H×D grid of cells, all alive (for tests and buildings). */
export function makeGrid(w: number, h: number, d: number): Map<string, BlockCell> {
  const m = new Map<string, BlockCell>();
  for (let y = 0; y < h; y++)
    for (let z = 0; z < d; z++)
      for (let x = 0; x < w; x++) m.set(blockKey(x, y, z), { x, y, z, alive: true, supported: true });
  return m;
}

// ---------------------------------------------------------------- physics side

export interface BuildingDef {
  id: string;
  /** World position of the building's minimum corner at ground level (m). */
  origin: [number, number, number];
  /** Blocks along X, Y (floors), Z. */
  size: [number, number, number];
  /** Neon edge colour (render only). */
  color: string;
  /** Block edge length (m). Default TUNING.blockSize; skyscrapers use bigger blocks. */
  blockSize?: number;
  /** Which grid cells exist (stepped towers, octagonal shafts). Default: all of them. */
  mask?: (x: number, y: number, z: number) => boolean;
}

/** One block of a building. */
export interface Block extends BlockCell {
  key: string;
  /** Index into `BlockBuilding.list` (= render instance id). */
  index: number;
  building: BlockBuilding;
  /** Its collider on the building's fixed body while it's part of the building. */
  collider: RAPIER.Collider | null;
}

/** Keeps the collider-handle -> owner map of the whole town up to date. */
export interface ColliderRegistry {
  add(collider: RAPIER.Collider, block: Block): void;
  delete(collider: RAPIER.Collider): void;
}

/**
 * One building: ONE fixed Rapier body with one cuboid collider per living block. Blocks that die
 * (struck hard) or break away (unsupported) lose their collider; the town turns the latter into
 * falling rubble.
 */
export class BlockBuilding {
  readonly def: BuildingDef;
  readonly blockSize: number;
  /** Mass of one block (kg) and the impulse that destroys it (N·s), scaled from the 3 m
   *  reference block: mass with volume, strength with face area. */
  readonly blockMass: number;
  readonly breakImpulse: number;
  readonly blocks = new Map<string, Block>();
  /** Blocks in a fixed order (render instance ids). */
  readonly list: Block[] = [];
  readonly body: RAPIER.RigidBody;
  /** Bumped whenever a block dies, breaks away or comes back (renderers watch it). */
  version = 0;

  constructor(
    private readonly world: RAPIER.World,
    def: BuildingDef,
    private readonly registry: ColliderRegistry,
  ) {
    this.def = def;
    this.blockSize = def.blockSize ?? TUNING.blockSize;
    const k = this.blockSize / TUNING.blockSize;
    this.blockMass = TUNING.blockMass * k ** 3;
    this.breakImpulse = TUNING.blockBreakImpulse * k ** 2;
    const [ox, oy, oz] = def.origin;
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(ox, oy, oz));
    const [w, h, d] = def.size;
    for (let y = 0; y < h; y++)
      for (let z = 0; z < d; z++)
        for (let x = 0; x < w; x++) {
          if (def.mask && !def.mask(x, y, z)) continue;
          const key = blockKey(x, y, z);
          const b: Block = { x, y, z, key, index: this.list.length, alive: true, supported: true, building: this, collider: null };
          this.blocks.set(key, b);
          this.list.push(b);
          this.addCollider(b);
        }
  }

  /** Block centre relative to the building origin (m). */
  localCentre(b: BlockCell, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const s = this.blockSize;
    out.x = (b.x + 0.5) * s;
    out.y = (b.y + 0.5) * s;
    out.z = (b.z + 0.5) * s;
    return out;
  }

  /** Block centre in the world (m). */
  worldCentre(b: BlockCell, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    this.localCentre(b, out);
    out.x += this.def.origin[0];
    out.y += this.def.origin[1];
    out.z += this.def.origin[2];
    return out;
  }

  get aliveCount(): number {
    let n = 0;
    for (const b of this.list) if (b.alive) n++;
    return n;
  }

  private addCollider(b: Block): void {
    const half = this.blockSize / 2;
    const c = this.localCentre(b, { x: 0, y: 0, z: 0 });
    const desc = RAPIER.ColliderDesc.cuboid(half, half, half)
      .setTranslation(c.x, c.y, c.z)
      .setFriction(0.7)
      .setRestitution(0.05)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      // Rapier reports a pair when either collider's threshold is crossed; the town decides.
      .setContactForceEventThreshold(0.1 * this.breakImpulse * TUNING.physicsHz);
    b.collider = this.world.createCollider(desc, this.body);
    this.registry.add(b.collider, b);
  }

  /** Take a block out of the building (destroyed, or handed to the rubble pool). */
  remove(b: Block): void {
    if (!b.alive) return;
    b.alive = false;
    b.supported = false;
    if (b.collider) {
      this.registry.delete(b.collider);
      this.world.removeCollider(b.collider, false);
      b.collider = null;
    }
    this.version++;
  }

  /** Recompute support; returns the living blocks that lost their connection to the ground. */
  unsupported(): Block[] {
    markSupport(this.blocks);
    return findUnsupported(this.blocks);
  }

  /** Remove every collider and the body (the building is being taken out of the world). */
  dispose(): void {
    for (const b of this.list) {
      if (b.collider) {
        this.registry.delete(b.collider);
        this.world.removeCollider(b.collider, false);
        b.collider = null;
      }
      b.alive = false;
    }
    this.world.removeRigidBody(this.body);
    this.version++;
  }

  /** Every block back in place (town reset). */
  restore(): void {
    let changed = false;
    for (const b of this.list) {
      b.supported = true;
      if (b.alive) continue;
      b.alive = true;
      this.addCollider(b);
      changed = true;
    }
    if (changed) this.version++;
  }
}
