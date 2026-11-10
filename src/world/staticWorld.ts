import RAPIER from '@dimforge/rapier3d-compat';
import type { ContactForceInfo } from '../sim/damage.ts';
import { TUNING } from '../tuning.ts';
import { airportPlan } from './Airport.ts';
import type { BlockBuilding } from './BlockBuilding.ts';
import { cityPlan } from './City.ts';
import { PLANET } from '../sim/layout.ts';
import { chunkHasTerrain, solidHulls } from '../sim/terrain.ts';
import { chunkAt, GRID, imageOffset, planetChunk } from './planetCity.ts';
import { structureMask, worldStructures, type Structures } from './structures.ts';
import type { Town } from './Town.ts';

/**
 * Every city tower, raised highway, airport building and parked airliner is destructible.
 *
 * Intact, a structure is a handful of static colliders on one fixed body (cheap: 3,000+ pieces
 * cost nothing until touched). When something hits it hard enough, the whole structure
 * FRACTURES: its static colliders go and it is rebuilt as a grid of breakable blocks
 * (BlockBuilding, the same engine as the town) sized to its shape. The blocks around the impact
 * are destroyed, then the town's anchor check runs: a breadth-first search from the living
 * ground-level blocks over the six cardinal neighbours marks what is still supported, and every
 * living block that is not (a tower top whose middle tier was blown out, a floating slab, a
 * highway span between broken pillars) detaches into falling rigid-body rubble that shatters
 * when it lands. Rubble hitting another intact structure fractures that one too (chain
 * collapses). Reset puts every structure back.
 */
export class StaticWorld {
  readonly body: RAPIER.RigidBody;
  /** Rooftop lightning conductors (tallest point of each building). */
  readonly conductors: Array<{ id: string; x: number; y: number; z: number }> = [];
  /** Structure groups currently fractured into blocks (renderers hide their intact meshes). */
  readonly fractured = new Map<number, BlockBuilding>();
  /** Bumped whenever a structure fractures or the world resets. */
  version = 0;

  private readonly pieceColliders: Array<RAPIER.Collider | null>;
  /** Planet chunks appended to the structure lists (key includes the image offset). */
  readonly outerChunks = new Map<string, { ci: number; cj: number; ox: number; oz: number; pieceStart: number; pieceEnd: number; groupStart: number; groupEnd: number }>();
  /** Bumped whenever outer chunks are registered (renderers rebuild their chunk views). */
  contentVersion = 0;
  private lastChunkKey = '';
  /** Outlands terrain near the craft: one convex hull per geometric solid (key: chunk@image). */
  private readonly terrain = new Map<string, RAPIER.Collider[]>();
  private chunksPending = false;
  /** Streaming: pieces bucketed by 250 m cells; only cells near the craft (and near fractured
   *  structures) carry colliders. Rapier walks every collider each step, so 23,000 static ones
   *  would cost ~3 ms a step; a 1 km bubble costs a few hundred µs. */
  private readonly cells = new Map<string, number[]>();
  private readonly loaded = new Set<string>();
  private centreCell = '';
  private readonly owner = new Map<number, number>();
  private readonly pending = new Map<number, { impulse: number; x: number; y: number; z: number }>();
  /** The central Grid's structures, then every planet chunk registered so far (append-only). */
  readonly structures: Structures = (() => {
    const w = worldStructures();
    return { list: [...w.list], groups: [...w.groups] };
  })();

  constructor(
    private readonly world: RAPIER.World,
    private readonly town: Town,
  ) {
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.pieceColliders = this.structures.list.map(() => null);
    this.structures.list.forEach((p, i) => {
      const key = cellKey(Math.floor(p.x / CELL), Math.floor(p.z / CELL));
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(i);
    });

    const city = cityPlan();
    for (const b of city.buildings) this.conductors.push({ id: `city:${b.id}`, x: b.x, y: b.top, z: b.z });
    for (const s of city.spires) this.conductors.push({ id: `spire:${s.x.toFixed(0)},${s.z.toFixed(0)}`, x: s.x, y: s.y1, z: s.z });
    const airport = airportPlan();
    this.conductors.push({ id: 'airport:tower', x: airport.beacon.x, y: airport.beacon.y, z: airport.beacon.z });
  }

  /**
   * Keep colliders only within STREAM_RADIUS of `x, z` (the craft) and of every fractured
   * structure. Cheap when the craft stays in its cell; otherwise only changed cells are touched.
   */
  stream(x: number, z: number, force = false): void {
    this.registerChunks(x, z, force);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const key = cellKey(cx, cz);
    if (!force && key === this.centreCell) return;
    this.centreCell = key;
    const want = new Set<string>();
    const r = Math.ceil(STREAM_RADIUS / CELL);
    const around = (ax: number, az: number, rr: number) => {
      for (let i = -rr; i <= rr; i++) for (let j = -rr; j <= rr; j++) {
        if ((i * i + j * j) * CELL * CELL > (STREAM_RADIUS + CELL) ** 2 && rr === r) continue;
        const k = cellKey(ax + i, az + j);
        if (this.cells.has(k)) want.add(k);
      }
    };
    around(cx, cz, r);
    for (const g of this.fractured.keys()) {
      const grp = this.structures.groups[g];
      around(Math.floor((grp.x0 + (grp.size[0] * grp.blockSize) / 2) / CELL), Math.floor((grp.z0 + (grp.size[2] * grp.blockSize) / 2) / CELL), 1);
    }
    for (const k of [...this.loaded]) {
      if (want.has(k)) continue;
      for (const i of this.cells.get(k)!) this.removeCollider(i);
      this.loaded.delete(k);
    }
    for (const k of want) {
      if (this.loaded.has(k)) continue;
      for (const i of this.cells.get(k)!) if (!this.fractured.has(this.structures.list[i].group)) this.addCollider(i);
      this.loaded.add(k);
    }
  }

  /**
   * Bring the planet chunks within REGISTER_RADIUS of (x, z) into the structure lists (at most
   * a few per call so streaming never hitches), placed at the image nearest the craft.
   */
  private registerChunks(x: number, z: number, force: boolean): void {
    const [ci, cj] = chunkAt(x, z);
    const key = `${ci},${cj},${Math.round(x / PLANET.circumference)},${Math.round(z / PLANET.circumference)}`;
    if (!force && key === this.lastChunkKey && !this.chunksPending) return;
    this.lastChunkKey = key;
    this.chunksPending = false;
    let budget = 3;
    const S = GRID.chunkSize;
    this.streamTerrain(ci, cj, x, z);
    for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
      const c = planetChunk(ci + di, cj + dj);
      const ox = imageOffset(c.x + S / 2, x);
      const oz = imageOffset(c.z + S / 2, z);
      const dx = Math.max(c.x + ox - x, 0, x - (c.x + ox + S));
      const dz = Math.max(c.z + oz - z, 0, z - (c.z + oz + S));
      if (dx * dx + dz * dz > REGISTER_RADIUS * REGISTER_RADIUS) continue;
      const k = `${c.key}@${ox},${oz}`;
      if (this.outerChunks.has(k)) continue;
      if (budget-- <= 0) {
        this.chunksPending = true;
        continue;
      }
      const L = this.structures.list;
      const G = this.structures.groups;
      const pieceStart = L.length;
      const groupStart = G.length;
      for (const g of c.structures.groups) {
        const id = G.length;
        G.push({
          ...g, id, name: `${g.name}@${ox},${oz}`, x0: g.x0 + ox, z0: g.z0 + oz,
          pieces: g.pieces.map((i) => pieceStart + i),
          kit: g.kit ? { ...g.kit, x: g.kit.x + ox, z: g.kit.z + oz } : undefined,
        });
      }
      for (const p of c.structures.list) {
        const i = L.length;
        L.push({ ...p, x: p.x + ox, z: p.z + oz, group: groupStart + p.group });
        this.pieceColliders.push(null);
        const ck = cellKey(Math.floor((p.x + ox) / CELL), Math.floor((p.z + oz) / CELL));
        let list = this.cells.get(ck);
        if (!list) this.cells.set(ck, (list = []));
        list.push(i);
        if (this.loaded.has(ck)) this.addCollider(i);
      }
      this.outerChunks.set(k, { ci: c.ci, cj: c.cj, ox, oz, pieceStart, pieceEnd: L.length, groupStart, groupEnd: G.length });
      this.centreCell = ''; // new cells may need loading
      this.contentVersion++;
    }
  }

  /** Heightfields for Outlands chunks within TERRAIN_RADIUS; far ones are released. */
  private streamTerrain(ci: number, cj: number, x: number, z: number): void {
    const S = GRID.chunkSize;
    const keep = new Set<string>();
    for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
      const a = ci + di, b = cj + dj;
      const cx0 = GRID.x0 + (((a % GRID.chunks) + GRID.chunks) % GRID.chunks) * S;
      const cz0 = GRID.z0 + (((b % GRID.chunks) + GRID.chunks) % GRID.chunks) * S;
      const ox = imageOffset(cx0 + S / 2, x), oz = imageOffset(cz0 + S / 2, z);
      const dx = Math.max(cx0 + ox - x, 0, x - (cx0 + ox + S));
      const dz = Math.max(cz0 + oz - z, 0, z - (cz0 + oz + S));
      if (dx * dx + dz * dz > TERRAIN_RADIUS * TERRAIN_RADIUS) continue;
      if (!chunkHasTerrain(a, b)) continue;
      const k = `${a},${b}@${ox},${oz}`;
      keep.add(k);
      if (this.terrain.has(k)) continue;
      // Exact: the union of the solids' hulls is the terrain surface.
      const list: RAPIER.Collider[] = [];
      for (const pts of solidHulls(cx0, cz0, cx0 + S, cz0 + S)) {
        for (let i = 0; i < pts.length; i += 3) { pts[i] += ox; pts[i + 2] += oz; }
        const desc = RAPIER.ColliderDesc.convexHull(pts);
        if (desc) list.push(this.world.createCollider(desc.setFriction(0.9).setRestitution(0.05), this.body));
      }
      this.terrain.set(k, list);
    }
    for (const [k, list] of this.terrain) if (!keep.has(k)) {
      for (const c of list) this.world.removeCollider(c, false);
      this.terrain.delete(k);
    }
  }

  private removeCollider(i: number): void {
    const c = this.pieceColliders[i];
    if (!c) return;
    this.owner.delete(c.handle);
    this.world.removeCollider(c, false);
    this.pieceColliders[i] = null;
  }

  private isLoaded(i: number): boolean {
    const p = this.structures.list[i];
    return this.loaded.has(cellKey(Math.floor(p.x / CELL), Math.floor(p.z / CELL)));
  }

  get colliderCount(): number {
    return this.pieceColliders.reduce((n, c) => n + (c ? 1 : 0), 0);
  }

  private addCollider(i: number): void {
    if (this.pieceColliders[i]) return;
    const p = this.structures.list[i];
    // Round shapes are cylinders; a frustum uses its mean radius.
    const desc = p.shape === 'box'
      ? RAPIER.ColliderDesc.cuboid(p.sx / 2, p.sy / 2, p.sz / 2)
      : RAPIER.ColliderDesc.cylinder(p.sy / 2, (p.sx / 2) * (p.shape === 'cone' ? (1 + (p.taper ?? 1)) / 2 : 1));
    desc.setTranslation(p.x, p.y, p.z).setFriction(0.7).setRestitution(0.05)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(0.25 * TUNING.structureFractureImpulse * TUNING.physicsHz);
    const c = this.world.createCollider(desc, this.body);
    this.pieceColliders[i] = c;
    this.owner.set(c.handle, i);
  }

  /** One contact-force event (reused object: nothing kept). */
  onContact(e: ContactForceInfo): void {
    const a = this.owner.get(e.collider1);
    const b = this.owner.get(e.collider2);
    if (a === undefined && b === undefined) return;
    const impulse = e.totalForceMagnitude * e.dt;
    if (a !== undefined) this.note(a, e.collider2, impulse);
    if (b !== undefined) this.note(b, e.collider1, impulse);
  }

  private note(piece: number, otherHandle: number, impulse: number): void {
    const group = this.structures.list[piece].group;
    const other = this.world.getCollider(otherHandle);
    const t = other?.parent()?.translation() ?? { x: 0, y: 0, z: 0 };
    const prev = this.pending.get(group);
    if (prev) prev.impulse += impulse;
    else this.pending.set(group, { impulse, x: t.x, y: t.y, z: t.z });
  }

  /** Apply this step's hits: fracture what was struck hard enough. */
  update(time: number): void {
    if (!this.pending.size) return;
    for (const [group, hit] of this.pending) {
      if (hit.impulse < TUNING.structureFractureImpulse || this.fractured.has(group)) continue;
      if (this.fractured.size >= TUNING.maxFracturedStructures) break;
      this.fracture(group, hit, time);
    }
    this.pending.clear();
  }

  private lastShake = -Infinity;

  /**
   * Earthquake: intact structures within QUAKE_RADIUS of `cx, cz` (the craft) whose top would
   * shake past the block strength (tall and slender amplify the ground motion, as in Town.shake)
   * fracture into blocks, nearest first, so Town.shake can bring them down block by block.
   * Checked a few times a second; the fracture cap still applies.
   */
  shake(accel: { x: number; z: number }, cx: number, cz: number, time: number): number {
    if (time - this.lastShake < 0.2) return 0;
    this.lastShake = time;
    const a = Math.hypot(accel.x, accel.z);
    if (a < TUNING.quakeBlockStrength * 0.05) return 0;
    const candidates: Array<{ g: number; d: number }> = [];
    for (const g of this.structures.groups) {
      if (this.fractured.has(g.id)) continue;
      const mx = g.x0 + (g.size[0] * g.blockSize) / 2 - cx;
      const mz = g.z0 + (g.size[2] * g.blockSize) / 2 - cz;
      const d = mx * mx + mz * mz;
      if (d > QUAKE_RADIUS * QUAKE_RADIUS) continue;
      const [w, h, dd] = g.size;
      const footprint = Math.max(1, Math.min(w, dd));
      const top = a * (1 + (0.6 * (h - 1)) / footprint);
      if (top > TUNING.quakeBlockStrength * 0.8 * quakeFragility(g.id)) candidates.push({ g: g.id, d });
    }
    candidates.sort((p, q) => p.d - q.d);
    let n = 0;
    for (const c of candidates) {
      if (this.fractured.size >= TUNING.maxFracturedStructures) break;
      this.fracture(c.g, { impulse: 0, x: 0, y: 0, z: 0 }, time, false);
      n++;
    }
    return n;
  }

  /** Rebuild a structure as its block grid of breakable blocks and blow a crater where it was hit. */
  fracture(group: number, hit: { impulse: number; x: number; y: number; z: number }, time: number, crater = true): BlockBuilding {
    const g = this.structures.groups[group];
    const s = g.blockSize;
    // Static colliders out, blocks in. The grid sits on the ground (y = 0), so the anchor
    // check knows what reaches the street; pieces in the air (floating slabs) have no anchor.
    for (const i of g.pieces) this.removeCollider(i);
    const building = this.town.addBuilding({
      id: g.name, origin: [g.x0, 0, g.z0], size: g.size, color: g.color, blockSize: s,
      mask: structureMask(g, this.structures.list),
    });
    this.fractured.set(group, building);
    this.centreCell = ''; // re-stream so the cells around the collapse stay loaded
    if (!crater) {
      this.version++;
      return building;
    }
    // Crater at the point of impact (nearest point of the structure to the striking body).
    const x1 = g.x0 + g.size[0] * s, y1 = g.size[1] * s, z1 = g.z0 + g.size[2] * s;
    const ix = Math.min(x1, Math.max(g.x0, hit.x));
    const iy = Math.min(y1, Math.max(0, hit.y));
    const iz = Math.min(z1, Math.max(g.z0, hit.z));
    const radius = s * (0.9 + 0.7 * Math.log2(1 + hit.impulse / TUNING.structureFractureImpulse));
    this.town.blast(building, ix, iy, iz, radius, time);
    this.version++;
    return building;
  }

  /** An explosion: fracture every intact structure within `radius` and crater it. */
  blastAt(x: number, y: number, z: number, radius: number, time: number): void {
    for (const g of this.structures.groups) {
      const x1 = g.x0 + g.size[0] * g.blockSize, z1 = g.z0 + g.size[2] * g.blockSize, y1 = g.size[1] * g.blockSize;
      const dx = Math.max(g.x0 - x, 0, x - x1), dz = Math.max(g.z0 - z, 0, z - z1), dy = Math.max(0, y - y1);
      if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
      const b = this.fractured.get(g.id) ?? (this.fractured.size < TUNING.maxFracturedStructures ? this.fracture(g.id, { impulse: TUNING.structureFractureImpulse * 4, x, y, z }, time) : null);
      if (b) this.town.blast(b, x, y, z, radius, time);
    }
  }

  /** Every structure whole again (call before Town.reset). */
  reset(): void {
    for (const [group, building] of this.fractured) {
      this.town.removeBuilding(building);
      for (const i of this.structures.groups[group].pieces) if (this.isLoaded(i)) this.addCollider(i);
    }
    const changed = this.fractured.size > 0;
    this.fractured.clear();
    this.centreCell = '';
    this.pending.clear();
    if (changed) this.version++;
  }
}


/** Streaming cell size and radius (m). */
const CELL = 250;
const STREAM_RADIUS = 1000;
/** Outlands terrain colliders within this distance of the craft (m). */
const TERRAIN_RADIUS = 2200;

/** Planet chunks within this distance of the craft are registered (physics + near render). */
const REGISTER_RADIUS = 2000;
/** Earthquakes bring down structures this close to the craft (m). */
const QUAKE_RADIUS = 1200;
/** Per-structure build quality for earthquakes: 0.8-1.4 × (some stand, some fall). */
function quakeFragility(id: number): number {
  let h = Math.imul(id + 7, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 13;
  return 0.8 + 0.6 * ((h >>> 0) / 4294967296);
}
const cellKey = (x: number, z: number) => `${x},${z}`;
