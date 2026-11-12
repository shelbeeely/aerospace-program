import RAPIER from '@dimforge/rapier3d-compat';
import { mulberry32 } from '../world/City.ts';
import { blockSummary, GRID } from '../world/planetCity.ts';
import type { ChipEmitter } from './chips.ts';
import type { ContactForceInfo } from './damage.ts';
import { CITY, hash01, PLANET, wrapCoord } from './layout.ts';
import { DEREZ_TIME, type TrailPoint, type TrailSystem } from './trails.ts';
import { OWN_WALL_GROUPS } from './collisionGroups.ts';
import { segmentExists } from './roadRules.ts';
import { isHighwayLine as gridHighway } from '../arch/grid.ts';

/**
 * AI light-cycle traffic: programs riding the planet's street grid (Rule 4: each lays a short
 * jetwall behind it). Purely kinematic and deterministic: riders keep their lane, favour the
 * data highways, turn 90° only at intersections and never onto airfields, sea or the Outlands.
 *
 * - **Streaming.** The planet is cut into cells of TRAFFIC.cellBlocks² blocks; every cell within
 *   TRAFFIC.radius of the player holds a quota of riders (from its highway and street segments).
 *   A short-handed cell spawns from its own seeded counter (deterministic per area), out at the
 *   edge of the streamed disc so nobody pops in nearby; riders past TRAFFIC.despawn are dropped.
 *   Everything is wrap-aware: riders live in the image of the planet nearest the player.
 * - **Physics near the player.** Within TRAFFIC.colliderRange a rider gets a kinematic body and
 *   its jetwall runs get static colliders, so the player can hit them. A rider struck by
 *   anything dynamic (the player, debris) derezzes.
 * - **The player's jetwall** (sim.trails) is deadly to riders: they look ahead and turn away or
 *   swing round (a U-turn across the street) when they can; one riding into it derezzes, its
 *   trail flickering out with it.
 */
export const TRAFFIC = {
  /** Streamed disc around the player (m) and the distance riders are dropped at. */
  radius: 1500,
  despawn: 1700,
  /** New riders appear at least this far out once the disc is filled (m). */
  spawnMin: 1050,
  /** Riders this close (3-D distance, m) get colliders. */
  colliderRange: 300,
  /** Lane centres from the street centreline (m): inner and outer lane each way. */
  lanes: [3.25, 9.75] as const,
  /** Jetwall reach behind a rider and its height (m). */
  trailLength: 45,
  trailHeight: 1.4,
  /** Speed ranges (m/s). */
  highwaySpeed: [30, 46] as const,
  streetSpeed: [15, 25] as const,
  /** Riders per weighted segment: a highway segment weighs 1, a street segment streetWeight. */
  density: 1.7,
  streetWeight: 0.12,
  cellBlocks: 5,
  maxRiders: 560,
  /** Cycle body (m): half extents of the collider and the nose/tail offsets from its centre. */
  half: [0.33, 0.6, 1.35] as const,
  nose: 1.4,
  colors: ['#00eaff', '#ffb347'] as const,
} as const;

/** Headings: 0 = +x, 1 = +z, 2 = -x, 3 = -z. right(h) = h + 1, left(h) = h + 3 (mod 4). */
export type Heading = 0 | 1 | 2 | 3;
export const HX = [1, 0, -1, 0] as const;
export const HZ = [0, 1, 0, -1] as const;

export interface TrafficCorner {
  x: number;
  z: number;
}

export interface Rider {
  id: number;
  /** 0 = cyan program, 1 = amber program. */
  team: 0 | 1;
  x: number;
  z: number;
  heading: Heading;
  /** Lane offset from the centreline (m), to the rider's right. */
  lane: number;
  speed: number;
  /** Grid line ridden (unbounded index): a z-line (j) for x headings, an x-line (i) for z headings. */
  line: number;
  /** Next intersection along the heading (unbounded index on the other axis). */
  node: number;
  /** Heading taken there, and the along-axis coordinate where the turn happens. */
  next: Heading;
  turnAt: number;
  /** Metres left of the sideways leg of a U-turn (0 = riding the lane). */
  uturn: number;
  /** Jetwall corners, oldest first; the wall runs on to the rider's tail. */
  trail: TrafficCorner[];
  derezAt: number | null;
  /** An EMP stalled it until then (s): it sits where it is, lights dark. */
  stalledUntil?: number;
  /** Hacked by the player until then (s): it rides in `hackColor` and its wall spares the player. */
  hackedUntil?: number;
  hackColor?: string;
  rng: () => number;
  body?: RAPIER.RigidBody;
  walls: RAPIER.Collider[];
}

const C = PLANET.circumference;
const N = GRID.blocks;
const P = GRID.pitch;
const CELL = GRID.pitch * TRAFFIC.cellBlocks;
const CELLS = N / TRAFFIC.cellBlocks;
const mod = (v: number, m: number) => ((v % m) + m) % m;

/** Street centreline positions of grid lines (unbounded indices). */
export const lineX = (i: number) => GRID.x0 + i * P;
export const lineZ = (j: number) => GRID.z0 + j * P;

/** Block kind byte (0 lot, 32 open plain, 64 Outlands, 128 open, 192 airfield, 255 sea), from blockSummary. */
export function blockKind(gi: number, gj: number): number {
  return blockSummary()[(mod(gj, N) * N + mod(gi, N)) * 4 + 2];
}
/** Blocks with streets around them (the ground shader draws none on airfields, sea, Outlands, open plains). */
export const roadBlock = (gi: number, gj: number) => {
  const k = blockKind(gi, gj);
  return k === 0 || k === 128;
};

/** Is grid line i a data highway? The same rule the ground shader uses (in the wrapped frame). */
export function isHighwayLine(i: number): boolean {
  return gridHighway(i);
}

/**
 * Can riders use the street segment? `alongX`: on z-line j from node i to i + 1 (blocks (i, j-1)
 * and (i, j) either side); otherwise on x-line i from node j to j + 1 (blocks (i-1, j), (i, j)).
 * The shared road rules (sim/roadRules.ts), riders' subset: city streets and highways only.
 */
export function segmentOpen(alongX: boolean, i: number, j: number): boolean {
  return segmentExists(blockSummary(), alongX, i, j, true);
}

/** The segment leaving intersection (i, j) along heading h. */
export function exitOpen(i: number, j: number, h: Heading): boolean {
  if (h === 0) return segmentOpen(true, i, j);
  if (h === 2) return segmentOpen(true, i - 1, j);
  if (h === 1) return segmentOpen(false, i, j);
  return segmentOpen(false, i, j - 1);
}

const alongX = (h: Heading) => h === 0 || h === 2;
const dirOf = (h: Heading) => (h === 0 || h === 1 ? 1 : -1);
const right = (h: Heading) => ((h + 1) % 4) as Heading;
const left = (h: Heading) => ((h + 3) % 4) as Heading;

interface CellInfo {
  segs: Array<{ alongX: boolean; i: number; j: number; highway: boolean }>;
  cum: number[];
}

/** Wall segment of the player's jetwall (solid while `b.collider` is set). */
type WallSeg = [TrailPoint, TrailPoint];
const BUCKET = 24;
const bucketKey = (ix: number, iz: number) => ix * 1_000_003 + iz;

export class TrafficSystem {
  readonly riders: Rider[] = [];
  /** Stream and step riders at all (tests and tools can switch it off). */
  enabled = true;
  /** Spawn riders around the player (off: only riders placed with spawnRider). */
  spawning = true;
  /** Riders steer clear of the player's jetwall where they can. */
  avoid = true;
  /** Riders derezzed so far (hit, or into a jetwall). */
  derezzed = 0;
  private nextId = 1;
  private steps = 0;
  private readonly cells = new Map<number, CellInfo>();
  private readonly spawnCount = new Map<number, number>();
  private readonly wallBody: RAPIER.RigidBody;
  private readonly byCollider = new Map<number, Rider>();
  private readonly byWall = new Map<number, Rider>();
  private lastManage: { x: number; z: number } | null = null;
  private readonly buckets = new Map<number, WallSeg[]>();
  private bucketVersion = '';
  private bucketStep = -Infinity;
  private player = { x: 0, y: 0, z: 0 };

  constructor(private readonly world: RAPIER.World, private readonly seed: number = CITY.seed, private readonly chips?: ChipEmitter) {
    this.wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  }

  /** Is this collider a rider's cycle? */
  isRider(handle: number): boolean {
    return this.byCollider.has(handle);
  }

  /** Is this collider part of a rider's jetwall? */
  isRiderWall(handle: number): boolean {
    return this.byWall.has(handle);
  }

  /** Riders that are riding (not derezzing). */
  get active(): number {
    let n = 0;
    for (const r of this.riders) if (r.derezAt === null) n++;
    return n;
  }

  /** Physics colliders currently held (cycles + jetwall runs). */
  get colliderCount(): number {
    return this.byCollider.size + this.byWall.size;
  }

  /** Derez the rider whose cycle (or jetwall) owns this collider (a weapon hit). True if there was one. */
  derezCollider(handle: number, time: number): boolean {
    const r = this.byCollider.get(handle) ?? this.byWall.get(handle);
    if (r) this.derez(r, time);
    return !!r;
  }

  /** Derez every rider within `radius` of a point (a blast). Returns how many went. */
  derezWithin(x: number, z: number, radius: number, time: number): number {
    let n = 0;
    for (const r of this.riders) {
      if (r.derezAt !== null) continue;
      // The rider, or any corner of its jetwall, inside the blast: the light goes, and the rider with it.
      const near = (r.x - x) ** 2 + (r.z - z) ** 2 <= radius * radius
        || r.trail.some((c) => (c.x - x) ** 2 + (c.z - z) ** 2 <= radius * radius);
      if (!near) continue;
      this.derez(r, time);
      n++;
    }
    return n;
  }

  /** A contact on a rider's cycle (the player, debris): it derezzes. */
  onContact(e: ContactForceInfo): void {
    const r = this.byCollider.get(e.collider1) ?? this.byCollider.get(e.collider2);
    if (r) this.derez(r, e.time);
  }

  /** Remove everyone (world reset). */
  clear(): void {
    for (const r of this.riders) this.dropPhysics(r);
    this.riders.length = 0;
    this.spawnCount.clear();
    this.lastManage = null;
    this.buckets.clear();
    this.bucketVersion = '';
  }

  /**
   * Put a rider on the grid (tests, tools): on `line` with heading h, at along-axis coordinate
   * `along`, in lane `laneIndex` (0 inner, 1 outer).
   */
  spawnRider(o: { heading: Heading; line: number; along: number; laneIndex?: 0 | 1; speed?: number; team?: 0 | 1; seed?: number }): Rider {
    const h = o.heading;
    const lane = TRAFFIC.lanes[o.laneIndex ?? 0];
    const rng = mulberry32(o.seed ?? this.nextId * 7919 + this.seed);
    const ax = alongX(h);
    const perp = (ax ? lineZ(o.line) : lineX(o.line)) + (ax ? HX[h] : -HZ[h]) * lane;
    const r: Rider = {
      id: this.nextId++, team: o.team ?? 0, x: ax ? o.along : perp, z: ax ? perp : o.along, heading: h, lane,
      speed: o.speed ?? 30, line: o.line, node: 0, next: h, turnAt: 0, uturn: 0, trail: [], derezAt: null, rng, walls: [],
    };
    r.node = this.nodeAhead(r);
    r.trail.push({ x: r.x - HX[h] * TRAFFIC.nose, z: r.z - HZ[h] * TRAFFIC.nose });
    this.plan(r);
    this.riders.push(r);
    return r;
  }

  /** One fixed step: stream, ride, avoid and collide. `player` is the player's position. */
  step(dt: number, time: number, player: { x: number; y: number; z: number }, trails: TrailSystem | null): void {
    if (!this.enabled) return;
    this.steps++;
    this.player.x = player.x;
    this.player.y = player.y;
    this.player.z = player.z;
    // Gone riders, wrap images, the stream.
    for (let i = this.riders.length - 1; i >= 0; i--) {
      const r = this.riders[i];
      this.reimage(r);
      if (r.derezAt !== null) {
        if (time - r.derezAt > DEREZ_TIME) this.riders.splice(i, 1);
        continue;
      }
      if (Math.hypot(r.x - player.x, r.z - player.z) > TRAFFIC.despawn) {
        this.dropPhysics(r);
        this.riders.splice(i, 1);
      }
    }
    if (this.spawning && this.steps % 30 === 1) this.manage();
    if (trails) this.bucketWalls(trails);
    const walls = this.buckets.size > 0;
    for (const r of this.riders) {
      if (r.derezAt !== null) continue;
      if (r.stalledUntil !== undefined && time < r.stalledUntil) continue; // EMP: stalled
      const fx = r.x + HX[r.heading] * TRAFFIC.nose, fz = r.z + HZ[r.heading] * TRAFFIC.nose;
      if (walls && this.avoid && (r.id + this.steps) % 6 === 0) this.lookAhead(r);
      this.ride(r, r.speed * dt);
      this.trimTrail(r);
      if (walls && this.crossesWall(fx, fz, r.x + HX[r.heading] * TRAFFIC.nose, r.z + HZ[r.heading] * TRAFFIC.nose)) {
        this.derez(r, time);
        continue;
      }
      this.syncPhysics(r);
    }
  }

  // --- Riding.

  private ride(r: Rider, dist: number): void {
    for (let guard = 0; dist > 1e-9 && guard < 8; guard++) {
      if (r.uturn > 0) {
        const m = Math.min(dist, r.uturn);
        this.move(r, m);
        dist -= m;
        r.uturn -= m;
        if (r.uturn <= 1e-9) {
          // Second left: riding back the other way in the inner lane.
          r.uturn = 0;
          this.corner(r);
          r.heading = left(r.heading);
          r.lane = TRAFFIC.lanes[0];
          const perp = alongX(r.heading) ? r.z : r.x;
          const sign = alongX(r.heading) ? HX[r.heading] : -HZ[r.heading];
          r.line = Math.round((perp - sign * r.lane - (alongX(r.heading) ? GRID.z0 : GRID.x0)) / P);
          r.node = this.nodeAhead(r);
          this.plan(r);
        }
        continue;
      }
      const h = r.heading, d = dirOf(h);
      const a = alongX(h) ? r.x : r.z;
      const toTurn = (r.turnAt - a) * d;
      if (toTurn > dist) {
        this.move(r, dist);
        return;
      }
      this.move(r, Math.max(0, toTurn));
      dist -= Math.max(0, toTurn);
      this.arrive(r);
    }
  }

  private move(r: Rider, m: number): void {
    r.x += HX[r.heading] * m;
    r.z += HZ[r.heading] * m;
  }

  /** At the turn point of intersection r.node: carry on, turn, or (dead end) swing round. */
  private arrive(r: Rider): void {
    const h = r.heading, n = r.next;
    if (n === h) {
      r.node += dirOf(h);
      this.plan(r);
      return;
    }
    if (n === ((h + 2) % 4)) {
      this.startUturn(r);
      return;
    }
    this.corner(r);
    const crossed = r.node;
    r.heading = n;
    r.node = r.line + dirOf(n);
    r.line = crossed;
    this.plan(r);
  }

  /** Swing round across the street: left, over to the inner lane opposite, left again. */
  private startUturn(r: Rider): void {
    this.corner(r);
    r.uturn = r.lane + TRAFFIC.lanes[0];
    r.heading = left(r.heading);
  }

  /** The first intersection strictly ahead of the rider along its heading. */
  private nodeAhead(r: Rider): number {
    const h = r.heading;
    const u = ((alongX(h) ? r.x - GRID.x0 : r.z - GRID.z0)) / P;
    return dirOf(h) > 0 ? Math.floor(u + 1e-9) + 1 : Math.ceil(u - 1e-9) - 1;
  }

  /** Choose what to do at r.node: highways keep their riders, streets feed them on. */
  private plan(r: Rider, avoid = this.avoid && this.buckets.size > 0): void {
    const h = r.heading, ax = alongX(h), d = dirOf(h);
    const i = ax ? r.node : r.line, j = ax ? r.line : r.node;
    const nodePos = ax ? lineX(r.node) : lineZ(r.node);
    const a = ax ? r.x : r.z;
    const onHighway = isHighwayLine(r.line);
    let total = 0;
    const options: Array<[Heading, number, number]> = [];
    for (const h2 of [h, right(h), left(h)] as Heading[]) {
      if (!exitOpen(i, j, h2)) continue;
      // Where the turn happens: the lane of the new street (straight on: the node itself).
      const offset = h2 === h ? 0 : (ax ? -HZ[h2] : HX[h2]) * r.lane;
      const at = nodePos + offset;
      if ((at - a) * d < 0) continue;
      const highway2 = isHighwayLine(alongX(h2) ? j : i);
      let w = h2 === h ? (onHighway ? 8 : 2) : highway2 ? 3 : onHighway ? 0.4 : 1;
      if (avoid) {
        const px = ax ? at : r.x, pz = ax ? r.z : at;
        if (this.wallAhead(px, pz, h2, 50) < Infinity) w = 0;
      }
      if (w <= 0) continue;
      options.push([h2, at, w]);
      total += w;
    }
    if (!options.length) {
      // Dead end (or every way walled off): swing round at the intersection.
      r.next = ((h + 2) % 4) as Heading;
      r.turnAt = (nodePos - a) * d >= 0 ? nodePos : a;
      return;
    }
    let pick = r.rng() * total;
    let choice = options[options.length - 1];
    for (const o of options) {
      pick -= o[2];
      if (pick <= 0) { choice = o; break; }
    }
    r.next = choice[0];
    r.turnAt = choice[1];
  }

  /** The tail light: where the jetwall leaves the cycle (never back past the last corner). */
  tail(r: Rider): TrafficCorner {
    const c = r.trail[r.trail.length - 1];
    if (c && Math.hypot(r.x - c.x, r.z - c.z) < TRAFFIC.nose) return { x: c.x, z: c.z };
    return { x: r.x - HX[r.heading] * TRAFFIC.nose, z: r.z - HZ[r.heading] * TRAFFIC.nose };
  }

  /** A corner of the jetwall where the rider turns (the turn point itself). */
  private corner(r: Rider): void {
    r.trail.push({ x: r.x, z: r.z });
  }

  /** Keep the jetwall TRAFFIC.trailLength long behind the tail. */
  private trimTrail(r: Rider): void {
    const t = r.trail;
    const head = this.tail(r);
    let len = 0;
    let prev = head;
    for (let k = t.length - 1; k >= 0; k--) {
      const seg = Math.hypot(prev.x - t[k].x, prev.z - t[k].z);
      if (len + seg >= TRAFFIC.trailLength) {
        const f = (TRAFFIC.trailLength - len) / Math.max(seg, 1e-9);
        t[k].x = prev.x + (t[k].x - prev.x) * f;
        t[k].z = prev.z + (t[k].z - prev.z) * f;
        if (k > 0) t.splice(0, k);
        return;
      }
      len += seg;
      prev = t[k];
    }
  }

  /** Keep the rider in the planet image nearest the player. */
  private reimage(r: Rider): void {
    const sx = -C * Math.round((r.x - this.player.x) / C);
    const sz = -C * Math.round((r.z - this.player.z) / C);
    if (!sx && !sz) return;
    r.x += sx;
    r.z += sz;
    for (const c of r.trail) { c.x += sx; c.z += sz; }
    const kx = Math.round(sx / P), kz = Math.round(sz / P);
    if (alongX(r.heading)) { r.node += kx; r.line += kz; r.turnAt += sx; }
    else { r.line += kx; r.node += kz; r.turnAt += sz; }
    if (r.body) r.body.setTranslation({ x: r.x, y: TRAFFIC.half[1] + 0.2, z: r.z }, true);
  }

  // --- Streaming.

  private cellInfo(ci: number, cj: number): CellInfo {
    const key = ci * CELLS + cj;
    let c = this.cells.get(key);
    if (c) return c;
    c = { segs: [], cum: [] };
    let total = 0;
    const B = TRAFFIC.cellBlocks;
    for (let a = 0; a < B; a++) for (let b = 0; b < B; b++) {
      const i = ci * B + a, j = cj * B + b;
      for (const ax of [true, false]) {
        if (!segmentOpen(ax, i, j)) continue;
        const highway = isHighwayLine(ax ? j : i);
        total += highway ? 1 : TRAFFIC.streetWeight;
        c.segs.push({ alongX: ax, i, j, highway });
        c.cum.push(total);
      }
    }
    this.cells.set(key, c);
    return c;
  }

  /** Top up short-handed cells in the streamed disc (deterministic per cell and spawn count). */
  private manage(): void {
    const p = this.player;
    const fill = !this.lastManage || Math.hypot(wrapCoord(p.x - this.lastManage.x), wrapCoord(p.z - this.lastManage.z)) > 400;
    this.lastManage = { x: p.x, z: p.z };
    const counts = new Map<number, number>();
    const cellIndex = (x: number, z: number) => [Math.floor((x - GRID.x0) / CELL), Math.floor((z - GRID.z0) / CELL)];
    for (const r of this.riders) {
      if (r.derezAt !== null) continue;
      const [ci, cj] = cellIndex(r.x, r.z);
      const k = mod(ci, CELLS) * CELLS + mod(cj, CELLS);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const [pci, pcj] = cellIndex(p.x, p.z);
    const reach = Math.ceil(TRAFFIC.radius / CELL) + 1;
    const cand: Array<[number, number, number]> = [];
    for (let a = -reach; a <= reach; a++) for (let b = -reach; b <= reach; b++) {
      const ci = pci + a, cj = pcj + b;
      const cx = GRID.x0 + (ci + 0.5) * CELL, cz = GRID.z0 + (cj + 0.5) * CELL;
      const d = Math.hypot(cx - p.x, cz - p.z);
      if (d > TRAFFIC.radius + CELL * 0.71) continue;
      cand.push([ci, cj, d]);
    }
    // Nearest cells first, so a fresh disc fills from the middle out.
    cand.sort((u, v) => u[2] - v[2] || u[0] - v[0] || u[1] - v[1]);
    let n = this.riders.length; // derezzing riders count too (the renderer draws them all)
    for (const [ci, cj] of cand) {
      const cci = mod(ci, CELLS), ccj = mod(cj, CELLS);
      const info = this.cellInfo(cci, ccj);
      const key = cci * CELLS + ccj;
      if (!info.segs.length) continue;
      // Bring the canonical cell's segments next to the player; the quota covers the part of
      // the cell inside the disc.
      const ox = Math.round((ci - cci) / CELLS) * N, oz = Math.round((cj - ccj) / CELLS) * N;
      let inside = 0;
      for (const sg of info.segs) {
        const mx = sg.alongX ? lineX(sg.i + ox + 0.5) : lineX(sg.i + ox), mz = sg.alongX ? lineZ(sg.j + oz) : lineZ(sg.j + oz + 0.5);
        if (Math.hypot(mx - p.x, mz - p.z) < TRAFFIC.radius) inside += sg.highway ? 1 : TRAFFIC.streetWeight;
      }
      let need = Math.round(inside * TRAFFIC.density) - (counts.get(key) ?? 0);
      if (need <= 0) continue;
      for (let tries = need * 2; need > 0 && tries > 0 && n < TRAFFIC.maxRiders; tries--) {
        const serial = this.spawnCount.get(key) ?? 0;
        this.spawnCount.set(key, serial + 1);
        const rng = mulberry32(Math.floor(hash01(key, serial, this.seed) * 4294967296));
        const pick = rng() * info.cum[info.cum.length - 1];
        let s = info.segs.findIndex((_, k) => info.cum[k] >= pick);
        if (s < 0) s = info.segs.length - 1;
        const seg = info.segs[s];
        const heading = (seg.alongX ? (rng() < 0.5 ? 0 : 2) : (rng() < 0.5 ? 1 : 3)) as Heading;
        const t = 0.15 + rng() * 0.7;
        const along = seg.alongX ? lineX(seg.i + ox + t) : lineZ(seg.j + oz + t);
        const line = seg.alongX ? seg.j + oz : seg.i + ox;
        const laneIndex = (rng() < (seg.highway ? 0.5 : 0.75) ? 0 : 1) as 0 | 1;
        const speedRange = seg.highway ? TRAFFIC.highwaySpeed : TRAFFIC.streetSpeed;
        const speed = speedRange[0] + rng() * (speedRange[1] - speedRange[0]);
        const team = (rng() < 0.6 ? 0 : 1) as 0 | 1;
        const riderSeed = Math.floor(rng() * 4294967296);
        const x = seg.alongX ? along : lineX(line), z = seg.alongX ? lineZ(line) : along;
        const d = Math.hypot(x - p.x, z - p.z);
        if (d > TRAFFIC.radius || d < 60 || (!fill && d < TRAFFIC.spawnMin)) continue;
        this.spawnRider({ heading, line, along, laneIndex, speed, team, seed: riderSeed });
        need--;
        n++;
      }
    }
  }

  // --- The player's jetwall.

  /**
   * Spatial buckets of the player's solid jetwall segments near the streamed disc (rebuilt when
   * it grows or a segment turns solid, at most every 4 steps).
   */
  private bucketWalls(trails: TrailSystem): void {
    const signature = `${trails.version}:${trails.colliderCount}`;
    if (signature === this.bucketVersion || this.steps - this.bucketStep < 4) return;
    this.bucketVersion = signature;
    const reach = TRAFFIC.despawn + 100;
    const p = this.player;
    this.bucketStep = this.steps;
    this.buckets.clear();
    for (const t of trails.trails) {
      if (t.kind !== 'wall' || t.derezAt !== null) continue;
      for (let k = 1; k < t.points.length; k++) {
        const a = t.points[k - 1], b = t.points[k];
        if (!b.collider || Math.abs(b.x - p.x) > reach || Math.abs(b.z - p.z) > reach) continue;
        const ix0 = Math.floor(Math.min(a.x, b.x) / BUCKET), ix1 = Math.floor(Math.max(a.x, b.x) / BUCKET);
        const iz0 = Math.floor(Math.min(a.z, b.z) / BUCKET), iz1 = Math.floor(Math.max(a.z, b.z) / BUCKET);
        for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
          const key = bucketKey(ix, iz);
          let list = this.buckets.get(key);
          if (!list) this.buckets.set(key, (list = []));
          list.push([a, b]);
        }
      }
    }
  }

  /** Does the move from (ax, az) to (bx, bz) cross a solid segment of the player's jetwall? */
  private crossesWall(ax: number, az: number, bx: number, bz: number): boolean {
    return this.firstHit(ax, az, bx, bz) <= 1;
  }

  /** Fraction (0..1) along a→b of the first solid jetwall crossing, or Infinity. */
  private firstHit(ax: number, az: number, bx: number, bz: number): number {
    let best = Infinity;
    const ix0 = Math.floor(Math.min(ax, bx) / BUCKET), ix1 = Math.floor(Math.max(ax, bx) / BUCKET);
    const iz0 = Math.floor(Math.min(az, bz) / BUCKET), iz1 = Math.floor(Math.max(az, bz) / BUCKET);
    const dx = bx - ax, dz = bz - az;
    for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
      const list = this.buckets.get(bucketKey(ix, iz));
      if (!list) continue;
      for (const [p, q] of list) {
        if (!q.collider) continue;
        const ex = q.x - p.x, ez = q.z - p.z;
        const den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-9) continue;
        const wx = p.x - ax, wz = p.z - az;
        const t = (wx * ez - wz * ex) / den;
        const u = (wx * dz - wz * dx) / den;
        if (t >= 0 && t <= 1 && u >= -0.02 && u <= 1.02 && t < best) best = t;
      }
    }
    return best;
  }

  /** Distance (m) along heading h from (x, z) to the player's jetwall, within `len` (else Infinity). */
  private wallAhead(x: number, z: number, h: Heading, len: number): number {
    const t = this.firstHit(x, z, x + HX[h] * len, z + HZ[h] * len);
    return t <= 1 ? t * len : Infinity;
  }

  /** See the player's jetwall coming: turn another way at the next intersection, or swing round. */
  private lookAhead(r: Rider): void {
    if (r.uturn > 0) return;
    const h = r.heading, d = dirOf(h), ax = alongX(h);
    const fx = r.x + HX[h] * TRAFFIC.nose, fz = r.z + HZ[h] * TRAFFIC.nose;
    const reach = r.speed * 1.2 + 12;
    const toTurn = (r.turnAt - (ax ? r.x : r.z)) * d;
    if (this.wallAhead(fx, fz, h, Math.min(reach, toTurn + TRAFFIC.nose)) < Infinity) {
      // Walled off before the intersection: swing round (if the way back is clear).
      if (this.wallAhead(r.x, r.z, left(h), r.lane + TRAFFIC.lanes[0] + 2) === Infinity) this.startUturn(r);
      return;
    }
    if (toTurn > reach || toTurn < 2) return;
    const tx = ax ? r.turnAt : r.x, tz = ax ? r.z : r.turnAt;
    if (this.wallAhead(tx, tz, r.next, Math.max(40, reach - toTurn)) < Infinity) this.plan(r, true);
  }

  // --- Physics and derez.

  private syncPhysics(r: Rider): void {
    const p = this.player;
    const near = Math.hypot(r.x - p.x, r.z - p.z, Math.max(0, p.y - 2)) < TRAFFIC.colliderRange;
    if (!near) {
      if (r.body || r.walls.length) this.dropPhysics(r);
      return;
    }
    const h = r.heading;
    const yaw = Math.atan2(-HX[h], -HZ[h]); // the cycle's nose is local -z
    const rot = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    const pos = { x: r.x, y: TRAFFIC.half[1] + 0.2, z: r.z };
    if (!r.body) {
      r.body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z).setRotation(rot));
      const col = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(...TRAFFIC.half).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(50).setFriction(0.4),
        r.body,
      );
      this.byCollider.set(col.handle, r);
    } else {
      r.body.setNextKinematicTranslation(pos);
      r.body.setNextKinematicRotation(rot);
    }
    // Jetwall runs: one thin box per straight run, from the oldest corner to the tail.
    const pts = [...r.trail, this.tail(r)];
    let w = 0;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.3) continue;
      const half = { x: 0.09, y: TRAFFIC.trailHeight / 2, z: len / 2 };
      const ry = Math.atan2(b.x - a.x, b.z - a.z);
      const t = { x: (a.x + b.x) / 2, y: TRAFFIC.trailHeight / 2, z: (a.z + b.z) / 2 };
      const q = { x: 0, y: Math.sin(ry / 2), z: 0, w: Math.cos(ry / 2) };
      let c = r.walls[w];
      const fresh = !c;
      if (!c) {
        c = this.world.createCollider(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(t.x, t.y, t.z).setRotation(q).setFriction(0.4).setRestitution(0.1), this.wallBody);
        r.walls.push(c);
        this.byWall.set(c.handle, r);
      }
      // A hacked rider's wall spares the player's craft, like the player's own walls.
      const groups = r.hackColor ? OWN_WALL_GROUPS : 0xffffffff;
      if (c.collisionGroups() !== groups) c.setCollisionGroups(groups);
      if (!fresh) {
        c.setHalfExtents(half);
        c.setTranslationWrtParent(t);
        c.setRotationWrtParent(q);
      }
      w++;
    }
    while (r.walls.length > w) {
      const c = r.walls.pop()!;
      this.byWall.delete(c.handle);
      this.world.removeCollider(c, false);
    }
  }

  private dropPhysics(r: Rider): void {
    if (r.body) {
      for (let i = 0; i < r.body.numColliders(); i++) this.byCollider.delete(r.body.collider(i).handle);
      this.world.removeRigidBody(r.body);
      r.body = undefined;
    }
    for (const c of r.walls) {
      this.byWall.delete(c.handle);
      this.world.removeCollider(c, false);
    }
    r.walls.length = 0;
  }

  /** The rider derezzes: physics gone at once, cycle and jetwall flicker out over DEREZ_TIME. */
  derez(r: Rider, time: number): void {
    if (r.derezAt !== null) return;
    r.derezAt = time;
    this.derezzed++;
    this.dropPhysics(r);
    // Derez: the rider shatters into voxels of its circuit colour that stay on the Grid; at
    // speed the energy rises as a liquid-like splash first.
    const color = TRAFFIC.colors[r.team];
    this.chips?.emit({
      x: r.x, y: 0.8, z: r.z, radius: 1, vx: HX[r.heading] * r.speed * 0.4, vy: 2, vz: HZ[r.heading] * r.speed * 0.4,
      speed: 6, count: 220, size: 0.2, color, persist: true,
    });
    if (r.speed > 20) {
      this.chips?.emit({
        x: r.x, y: 0, z: r.z, radius: 0.6, vx: HX[r.heading] * r.speed, vy: 0, vz: HZ[r.heading] * r.speed,
        speed: Math.min(30, 8 + r.speed * 0.3), count: 160, size: 0.15, color, splash: true,
      });
    }
  }
}
