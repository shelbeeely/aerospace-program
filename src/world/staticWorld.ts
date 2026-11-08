import RAPIER from '@dimforge/rapier3d-compat';
import type { ContactForceInfo } from '../sim/damage.ts';
import { TUNING } from '../tuning.ts';
import { airportPlan } from './Airport.ts';
import type { BlockBuilding } from './BlockBuilding.ts';
import { cityPlan } from './City.ts';
import { structureMask, worldStructures } from './structures.ts';
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
  /** Streaming: pieces bucketed by 250 m cells; only cells near the craft (and near fractured
   *  structures) carry colliders. Rapier walks every collider each step, so 23,000 static ones
   *  would cost ~3 ms a step; a 1 km bubble costs a few hundred µs. */
  private readonly cells = new Map<string, number[]>();
  private readonly loaded = new Set<string>();
  private centreCell = '';
  private readonly owner = new Map<number, number>();
  private readonly pending = new Map<number, { impulse: number; x: number; y: number; z: number }>();
  private readonly structures = worldStructures();

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

  /** Rebuild a structure as its block grid of breakable blocks and blow a crater where it was hit. */
  fracture(group: number, hit: { impulse: number; x: number; y: number; z: number }, time: number): BlockBuilding {
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
const cellKey = (x: number, z: number) => `${x},${z}`;
