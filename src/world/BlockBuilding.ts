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
 * as supported. `anchor`: blocks held by something other than the ground (a bridge's ends in
 * the buildings it spans); they count as standing on it.
 */
export function markSupport<T extends BlockCell>(blocks: ReadonlyMap<string, T>, anchor?: (b: T) => boolean): void {
  const queue: T[] = [];
  for (const b of blocks.values()) {
    b.supported = b.alive && (b.y === 0 || (!!anchor && anchor(b)));
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

/**
 * What each supported block carries (in block weights), after `markSupport`.
 *
 * - A **column** cell is on the ground layer or stands on a column cell: its weight goes
 *   straight down.
 * - Every other supported block **hangs**: it is held sideways (or from above) by the nearest
 *   column cells, found by a breadth-first search outward from the columns. Its `reach` is how
 *   many blocks away they are, and its weight is shared among them.
 * - A column cell's `load` is its own weight, what hangs on it, and everything on the column
 *   cells above it.
 */
export interface LoadReport<T extends BlockCell> {
  load: Map<T, number>;
  reach: Map<T, number>;
  maxReach: number;
}

export function analyseLoad<T extends BlockCell>(blocks: ReadonlyMap<string, T>, anchor?: (b: T) => boolean): LoadReport<T> {
  const live: T[] = [];
  for (const b of blocks.values()) if (b.alive && b.supported) live.push(b);
  live.sort((a, b) => a.y - b.y);
  const column = new Set<T>();
  for (const b of live) {
    if (b.y === 0 || (anchor && anchor(b))) column.add(b);
    else {
      const below = blocks.get(blockKey(b.x, b.y - 1, b.z));
      if (below && column.has(below)) column.add(b);
    }
  }
  // Hanging blocks: distance to the nearest column cell (multi-source BFS from the columns).
  const reach = new Map<T, number>();
  const queue: T[] = [];
  for (const c of column) { reach.set(c, 0); queue.push(c); }
  let maxReach = 0;
  for (let i = 0; i < queue.length; i++) {
    const b = queue[i];
    const r = reach.get(b)!;
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const n = blocks.get(blockKey(b.x + dx, b.y + dy, b.z + dz));
      if (!n || !n.alive || !n.supported || reach.has(n)) continue;
      reach.set(n, r + 1);
      if (r + 1 > maxReach) maxReach = r + 1;
      queue.push(n);
    }
  }
  // Weight flows inward: each hanging block hands its own and what it holds to the neighbours
  // one step nearer a column, in equal shares, so equally placed supports carry equal loads.
  const held = new Map<T, number>();
  for (let i = queue.length - 1; i >= 0; i--) {
    const b = queue[i];
    const r = reach.get(b)!;
    if (r === 0) break; // the columns come first in the queue
    const w = 1 + (held.get(b) ?? 0);
    const nearer: T[] = [];
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const n = blocks.get(blockKey(b.x + dx, b.y + dy, b.z + dz));
      if (n && reach.get(n) === r - 1) nearer.push(n);
    }
    for (const n of nearer) held.set(n, (held.get(n) ?? 0) + w / nearer.length);
  }
  const load = new Map<T, number>();
  for (const c of column) load.set(c, 1 + (held.get(c) ?? 0));
  for (const c of column) reach.delete(c);
  // Down the columns, top first.
  for (let i = live.length - 1; i >= 0; i--) {
    const b = live[i];
    if (!column.has(b) || b.y === 0) continue;
    const below = blocks.get(blockKey(b.x, b.y - 1, b.z));
    if (below && column.has(below)) load.set(below, load.get(below)! + load.get(b)!); // an anchored cell hands its load to what holds it
  }
  return { load, reach, maxReach };
}

/** What a structure can bear, taken from how it stood when whole (see `BlockBuilding`). */
export interface LoadLimits<T extends BlockCell> {
  /** The most each column cell can carry (block weights); cells not listed carry `floor`. */
  capacity: ReadonlyMap<T, number>;
  floor: number;
  /** The farthest a block may hang from a column (blocks). */
  reach: number;
}

/** Limits from the structure as it stands now (call on the intact structure). */
export function loadLimits<T extends BlockCell>(blocks: ReadonlyMap<string, T>, safety: number, overhang: number, anchor?: (b: T) => boolean): LoadLimits<T> {
  markSupport(blocks, anchor);
  const r = analyseLoad(blocks, anchor);
  const capacity = new Map<T, number>();
  for (const [b, l] of r.load) capacity.set(b, Math.max(l * safety, l + 2));
  return { capacity, floor: 1 + 2 * safety, reach: Math.max(r.maxReach + 1, overhang) };
}

/**
 * The structural check, after `markSupport`: which supported blocks fail under load. `crushed`
 * are column cells carrying more than they can bear; `snapped` are blocks hanging farther from
 * a column than the structure allows.
 */
export function findOverloaded<T extends BlockCell>(blocks: ReadonlyMap<string, T>, limits: LoadLimits<T>, anchor?: (b: T) => boolean): { crushed: T[]; snapped: T[] } {
  const r = analyseLoad(blocks, anchor);
  const crushed: T[] = [], snapped: T[] = [];
  for (const [b, l] of r.load) if (l > (limits.capacity.get(b) ?? limits.floor) + 1e-9) crushed.push(b);
  for (const [b, d] of r.reach) if (d > limits.reach) snapped.push(b);
  return { crushed, snapped };
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
  /**
   * Cells held up by something other than the ground (a bridge's ends, while the buildings it
   * spans still hold them). Asked again at every structural check, so it can stop being true.
   */
  anchor?: (x: number, y: number, z: number) => boolean;
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
  /** What the structure can bear: from how it stands when whole, so being whole never fails it. */
  readonly limits: LoadLimits<Block>;
  private get anchored(): ((b: Block) => boolean) | undefined {
    const a = this.def.anchor;
    return a ? (b) => a(b.x, b.y, b.z) : undefined;
  }

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
    this.limits = loadLimits(this.blocks, TUNING.loadSafety, Math.max(2, Math.round(TUNING.maxOverhang / this.blockSize)), def.anchor ? (b) => def.anchor!(b.x, b.y, b.z) : undefined);
  }

  /**
   * The structural check, after `unsupported()` has run: blocks crushed by what now rests on
   * them, and blocks hanging too far out. Losing them shifts the load again, so the caller
   * checks again next step until nothing fails (a collapse takes a few steps to run its course).
   */
  overloaded(): { crushed: Block[]; snapped: Block[] } {
    return findOverloaded(this.blocks, this.limits, this.anchored);
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
    markSupport(this.blocks, this.anchored);
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
