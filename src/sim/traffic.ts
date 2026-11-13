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
 * jetwall behind it). Kinematic and deterministic: riders keep their lane, favour the data
 * highways, turn 90° only at intersections and never onto airfields, sea or the Outlands.
 *
 * - **Driving.** Each rider follows the one ahead with the Intelligent Driver Model: it
 *   accelerates to its own speed for the road (a data highway is faster than a street), keeps
 *   a time headway, and brakes for whatever is in its lane: another cycle, the end of that
 *   cycle's jetwall, the player's vehicle, a stop line. The jetwall is as long as the ground
 *   covered in TRAFFIC.trailTime, so a queue closes up and nobody rides into the wall ahead.
 * - **Intersections.** Highway crossings are signalled (green, amber, all-red; the greens
 *   run as a wave along the highways). Where a street meets a highway the highway has
 *   priority: street riders stop and wait for a gap. Street crossings and dead ends are taken
 *   one rider at a time. A left turn waits for a gap in the oncoming lanes, and nobody enters
 *   a crossing it cannot leave.
 * - **Lanes.** Two each way. Left turns leave from the inner lane and right turns from the
 *   outer, so a rider moves over (a 90° jog, when there is room) before its turn, pulls out
 *   to pass a slower rider, and otherwise drifts back to the outer lane.
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
  /** Jetwall: the ground covered in trailTime (s), at most trailLength (m), and its height (m). */
  trailLength: 45,
  trailTime: 1.2,
  trailHeight: 1.4,
  /** Speed ranges (m/s): a rider's own speed for the road is the middle of the range times its temper. */
  highwaySpeed: [30, 46] as const,
  streetSpeed: [15, 25] as const,
  /** Car-following (IDM): acceleration, comfortable and hardest braking (m/s²), standstill gap (m), headway (s). */
  accel: 6,
  brake: 5,
  maxBrake: 12,
  gap: 3,
  headway: 0.7,
  /** Stop line: this far before the intersection's centre (m). */
  stopLine: 14,
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
  /** Lane offset from the centreline (m), to the rider's right, and its index (0 inner, 1 outer). */
  lane: number;
  laneIndex: 0 | 1;
  /** Speed now (m/s) and the acceleration it is holding (m/s²). */
  speed: number;
  accel: number;
  /** How fast it likes to ride: a factor on the road's speed (or a fixed speed, for tests). */
  temper: number;
  fixedSpeed?: number;
  /** Metres it may still ride before the nearest thing it must not pass (refreshed each control tick). */
  room: number;
  /** Metres left of a lane-change jog (0 = in lane) and the heading it returns to. */
  jog: number;
  jogBack: Heading;
  /** The lane it must be in for its next turn (-1: either). */
  wantLane: number;
  /** Intersection it holds the right of way at (-1: none), where that is, and whether it has entered. */
  token: number;
  tokenX: number;
  tokenZ: number;
  /** Intersection it is inside, or whose box its jetwall has yet to leave (-1: none), and the axis it came in on. */
  box: number;
  boxX: number;
  boxZ: number;
  boxAxisX: boolean;
  /** Intersection whose stop line holds it while it waits for a gap or its turn (-1: none). */
  held: number;
  /** Signalled intersection it is committed to cross (amber came too late to stop), or -1, and until when. */
  commit: number;
  commitUntil: number;
  /** Just spawned: its speed is settled against what is ahead at its first control tick. */
  fresh: boolean;
  /** Seconds it has stood still (a stuck rider is the sign of a jam). */
  waited: number;
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

/** Intersection control: none (a bend, a straight), signals, a priority road, or one at a time. */
export const CONTROL = { none: 1, signal: 2, priority: 3, yield: 4 } as const;
export type Light = 'green' | 'amber' | 'red';
/** Signal timing (s): the cycle, amber, all-red, and the speed (m/s) the green wave runs at. */
export const SIGNAL = { cycle: 40, amber: 3, allRed: 2, wave: 34 } as const;

/** Something else on the road that riders brake for (the player's vehicle). */
export interface RoadObstacle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  radius: number;
}

/** A stretch of lane that is taken: a cycle and the jetwall behind it, a wall run, an obstacle. */
interface LaneEntry {
  lo: number;
  hi: number;
  /** Velocity along the lane's axis (m/s, signed). */
  v: number;
  rider: Rider | null;
  /** The cycle itself (it moves on); false for a run of wall left in another lane. */
  body: boolean;
  /** A jetwall (or, `soft`, the path of a rider already in the intersection) across this lane. */
  cross: boolean;
  soft: boolean;
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

const controls = new Uint8Array(N * N);
export const nodeKey = (i: number, j: number) => mod(i, N) * N + mod(j, N);

/** How intersection (i, j) is run (CONTROL): by what meets there. */
export function controlAt(i: number, j: number): number {
  const key = nodeKey(i, j);
  if (controls[key]) return controls[key];
  let exits = 0;
  for (const h of [0, 1, 2, 3] as Heading[]) if (exitOpen(i, j, h)) exits++;
  const hx = isHighwayLine(j), hz = isHighwayLine(i);
  // A dead end is taken one at a time too: swinging round crosses the lane alongside.
  const c = exits === 1 ? CONTROL.yield : exits < 3 ? CONTROL.none : hx && hz ? CONTROL.signal : hx || hz ? CONTROL.priority : CONTROL.yield;
  return (controls[key] = c);
}

/**
 * The light an approach along x (or along z) faces at signalled intersection (i, j). A pure
 * function of time: x green, amber, all-red, then z. The offset grows with distance along +x
 * and +z, so a rider at the wave speed meets green after green.
 */
export function signalLight(i: number, j: number, axisX: boolean, time: number): Light {
  return signalPhase(i, j, axisX, time)[0];
}

/** The light, and how long it has left (s; for red: until green). */
export function signalPhase(i: number, j: number, axisX: boolean, time: number): [Light, number] {
  const green = SIGNAL.cycle / 2 - SIGNAL.amber - SIGNAL.allRed;
  const t = mod(time - ((mod(i, N) + mod(j, N)) * P) / SIGNAL.wave, SIGNAL.cycle);
  const u = mod(axisX ? t : t - SIGNAL.cycle / 2, SIGNAL.cycle);
  return u < green ? ['green', green - u] : u < green + SIGNAL.amber ? ['amber', green + SIGNAL.amber - u] : ['red', SIGNAL.cycle - u];
}

const degrees = new Uint8Array(N * N);
/** Does intersection (i, j) lead nowhere (one way in, the same way out)? */
export function deadEnd(i: number, j: number): boolean {
  const key = nodeKey(i, j);
  if (!degrees[key]) {
    let exits = 0;
    for (const h of [0, 1, 2, 3] as Heading[]) if (exitOpen(i, j, h)) exits++;
    degrees[key] = exits + 1;
  }
  return degrees[key] === 2;
}

const alongX = (h: Heading) => h === 0 || h === 2;
const dirOf = (h: Heading) => (h === 0 || h === 1 ? 1 : -1);
const right = (h: Heading) => ((h + 1) % 4) as Heading;
const left = (h: Heading) => ((h + 3) % 4) as Heading;
const back = (h: Heading) => ((h + 2) % 4) as Heading;
const NOSE = TRAFFIC.nose;
const STOP = TRAFFIC.stopLine;
const LANE_GAP = TRAFFIC.lanes[1] - TRAFFIC.lanes[0];
/** Lanes are keyed by axis and the coordinate across it (lane centres are exact). */
const laneKey = (ax: boolean, perp: number) => (ax ? 4_000_000 : 8_000_000) + Math.round(perp * 4);
/** Centre of the lane with offset `lane` for heading h on its line (a z-line for x headings). */
const lanePerp = (h: Heading, line: number, lane: number) => (alongX(h) ? lineZ(line) + HX[h] * lane : lineX(line) - HZ[h] * lane);
/** The jetwall a rider carries at its speed (m). */
export const trailLength = (r: { speed: number }) => Math.min(TRAFFIC.trailLength, r.speed * TRAFFIC.trailTime);
/** Seconds to cover `dist` from speed v, accelerating gently. */
const travelTime = (dist: number, v: number) => (dist <= 0 ? 0 : (-v + Math.sqrt(v * v + 10 * dist)) / 5);
/** IDM acceleration at speed v wanting v0, `gap` metres behind something doing `lv`. */
function idm(v: number, v0: number, gap: number, lv: number): number {
  if (v0 < 0.1) return v > 0 ? -TRAFFIC.brake : 0;
  const free = 1 - (v / v0) ** 4;
  if (gap === Infinity) return TRAFFIC.accel * free;
  const want = TRAFFIC.gap + Math.max(0, v * TRAFFIC.headway + (v * (v - lv)) / (2 * Math.sqrt(TRAFFIC.accel * TRAFFIC.brake)));
  return Math.max(-TRAFFIC.maxBrake, TRAFFIC.accel * (free - (want / Math.max(gap, 0.1)) ** 2));
}

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
  /** Riders obey the intersections (signals, priority, one at a time); off: they ride straight through. */
  control = true;
  /** Other things on the road riders brake for (the player's vehicle), set by the host each step. */
  obstacles: RoadObstacle[] = [];
  /**
   * Walls across the road that are not jetwalls (the rims of a field of broken road), each
   * [x0, z0, x1, z1]: riders treat them as they treat the player's jetwall. Set by the host.
   */
  barriers: ReadonlyArray<readonly [number, number, number, number]> = [];
  private readonly lanes = new Map<number, LaneEntry[]>();
  private readonly laneLists: LaneEntry[][] = [];
  private readonly entryPool: LaneEntry[] = [];
  private entryCount = 0;
  private readonly tokens = new Map<number, Rider>();
  private readonly boxes = new Map<number, Rider[]>();
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

  /** Where the traffic is streamed around (the player), for the renderer. */
  get centre(): { x: number; z: number } {
    return this.player;
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
    this.tokens.clear();
    this.spawnCount.clear();
    this.lastManage = null;
    this.buckets.clear();
    this.bucketVersion = '';
  }

  /**
   * Put a rider on the grid (tests, tools): on `line` with heading h, at along-axis coordinate
   * `along`, in lane `laneIndex` (0 inner, 1 outer).
   */
  spawnRider(o: { heading: Heading; line: number; along: number; laneIndex?: 0 | 1; speed?: number; temper?: number; team?: 0 | 1; seed?: number }): Rider {
    const h = o.heading;
    const laneIndex = o.laneIndex ?? 0;
    const lane = TRAFFIC.lanes[laneIndex];
    const rng = mulberry32(o.seed ?? this.nextId * 7919 + this.seed);
    const ax = alongX(h);
    const perp = (ax ? lineZ(o.line) : lineX(o.line)) + (ax ? HX[h] : -HZ[h]) * lane;
    const r: Rider = {
      id: this.nextId++, team: o.team ?? 0, x: ax ? o.along : perp, z: ax ? perp : o.along, heading: h, lane, laneIndex,
      speed: 0, accel: 0, temper: o.temper ?? 1, fixedSpeed: o.temper === undefined ? o.speed ?? 30 : undefined, room: Infinity,
      jog: 0, jogBack: h, wantLane: -1, token: -1, tokenX: 0, tokenZ: 0, box: -1, boxX: 0, boxZ: 0, boxAxisX: false, held: -1, commit: -1, commitUntil: 0, fresh: true, waited: 0,
      line: o.line, node: 0, next: h, turnAt: 0, uturn: 0, trail: [], derezAt: null, rng, walls: [],
    };
    r.speed = this.desired(r);
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
        this.release(r);
        this.riders.splice(i, 1);
      }
    }
    if (this.spawning && this.steps % 30 === 1) this.manage();
    if (trails) this.bucketWalls(trails);
    const walls = this.buckets.size > 0 || this.barriers.length > 0;
    // Driving decisions run at a quarter of the physics rate; riding is integrated every step.
    const tick = this.steps % 4 === 0;
    if (tick) {
      for (const r of this.riders) if (r.derezAt === null && r.stalledUntil !== undefined && time < r.stalledUntil) r.speed = r.accel = 0;
      this.buildLanes();
      for (const r of this.riders) {
        if (r.derezAt !== null || (r.stalledUntil !== undefined && time < r.stalledUntil)) continue;
        this.drive(r, time);
        r.waited = r.speed < 0.3 ? r.waited + dt * 4 : 0;
      }
    }
    for (const r of this.riders) {
      if (r.derezAt !== null) continue;
      if (r.stalledUntil !== undefined && time < r.stalledUntil) continue; // EMP: stalled
      const fx = r.x + HX[r.heading] * TRAFFIC.nose, fz = r.z + HZ[r.heading] * TRAFFIC.nose;
      if (walls && this.avoid && (r.id + this.steps) % 6 === 0) this.lookAhead(r);
      r.speed = Math.max(0, r.speed + r.accel * dt);
      let dist = r.speed * dt;
      if (dist > r.room) {
        // Never past what it must not pass (a stop line, the wall ahead), however late it saw it.
        dist = Math.max(0, r.room);
        r.speed = dist / dt;
      }
      r.room -= dist;
      this.ride(r, dist);
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
      if (r.jog > 0) {
        const m = Math.min(dist, r.jog);
        this.move(r, m);
        dist -= m;
        r.jog -= m;
        if (r.jog <= 1e-9) {
          // In the new lane (exactly on its centre), riding on.
          r.jog = 0;
          r.heading = r.jogBack;
          const perp = lanePerp(r.heading, r.line, r.lane);
          if (alongX(r.heading)) r.z = perp; else r.x = perp;
          this.corner(r);
          r.turnAt = this.turnPoint(r, r.next);
        }
        continue;
      }
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
          r.laneIndex = 0;
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
    r.commit = -1;
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
    r.room = Infinity;
    r.speed = Math.max(r.speed, 5);
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
  private plan(r: Rider, avoid = this.avoid && this.buckets.size > 0, inLane = false): void {
    const h = r.heading, ax = alongX(h), d = dirOf(h);
    r.wantLane = -1;
    // Left turns leave from the inner lane, right turns from the outer. `inLane`: too late to
    // move over, so only what this lane allows (anything, where the road just bends).
    const natural = (h2: Heading) => h2 === h || h2 === (r.laneIndex === 0 ? left(h) : right(h));
    if (inLane && !([h, right(h), left(h)] as Heading[]).some((h2) => natural(h2) && exitOpen(ax ? r.node : r.line, ax ? r.line : r.node, h2))) inLane = false;
    const i = ax ? r.node : r.line, j = ax ? r.line : r.node;
    const nodePos = ax ? lineX(r.node) : lineZ(r.node);
    const a = ax ? r.x : r.z;
    const onHighway = isHighwayLine(r.line);
    let total = 0;
    const options: Array<[Heading, number, number]> = [];
    for (const h2 of [h, right(h), left(h)] as Heading[]) {
      if (!exitOpen(i, j, h2) || (inLane && !natural(h2))) continue;
      // Where the turn happens: the lane of the new street (straight on: the node itself).
      const offset = h2 === h ? 0 : (ax ? -HZ[h2] : HX[h2]) * r.lane;
      const at = nodePos + offset;
      if ((at - a) * d < 0) continue;
      const highway2 = isHighwayLine(alongX(h2) ? j : i);
      let w = h2 === h ? (onHighway ? 8 : 2) : highway2 ? 3 : onHighway ? 0.4 : 1;
      // A road that ends at the next intersection is a last resort.
      if (deadEnd(i + HX[h2], j + HZ[h2])) w *= 0.02;
      // Left turns across a signalled crossing are the slow way round: fewer take them.
      if (h2 === left(h) && controlAt(i, j) === CONTROL.signal) w *= 0.4;
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
    // The wrong lane for the turn, with a straight exit alongside: move over on the way there.
    if (!natural(r.next) && exitOpen(i, j, h)) r.wantLane = 1 - r.laneIndex;
  }

  /** Where along its street the rider turns onto heading `next` at r.node (straight on: the node). */
  private turnPoint(r: Rider, next: Heading): number {
    const h = r.heading, ax = alongX(h);
    const nodePos = ax ? lineX(r.node) : lineZ(r.node);
    return next === h || next === back(h) ? nodePos : nodePos + (ax ? -HZ[next] : HX[next]) * r.lane;
  }

  /** The speed the rider wants on the road it is on (m/s). */
  desired(r: Rider): number {
    if (r.fixedSpeed !== undefined) return r.fixedSpeed;
    const range = isHighwayLine(r.line) ? TRAFFIC.highwaySpeed : TRAFFIC.streetSpeed;
    return ((range[0] + range[1]) / 2) * r.temper;
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

  /** Keep the jetwall as long as the rider's speed makes it (trailLength), behind the tail. */
  private trimTrail(r: Rider): void {
    const t = r.trail;
    const head = this.tail(r);
    const L = trailLength(r);
    let len = 0;
    let prev = head;
    for (let k = t.length - 1; k >= 0; k--) {
      const seg = Math.hypot(prev.x - t[k].x, prev.z - t[k].z);
      if (len + seg >= L) {
        const f = (L - len) / Math.max(seg, 1e-9);
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
    r.tokenX += sx;
    r.tokenZ += sz;
    r.boxX += sx;
    r.boxZ += sz;
    // The street it is on: mid-jog and mid-swing it faces across it.
    const street = r.jog > 0 ? r.jogBack : r.uturn > 0 ? right(r.heading) : r.heading;
    if (alongX(street)) { r.node += kx; r.line += kz; r.turnAt += sx; }
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
        // In the first half of the segment, so the intersection ahead sees it coming.
        const t0 = 0.15 + rng() * 0.4;
        const t = heading < 2 ? t0 : 1 - t0;
        const along = seg.alongX ? lineX(seg.i + ox + t) : lineZ(seg.j + oz + t);
        const line = seg.alongX ? seg.j + oz : seg.i + ox;
        const laneIndex = (rng() < (seg.highway ? 0.5 : 0.75) ? 0 : 1) as 0 | 1;
        // Its temper: how fast it rides for the road, across the road's speed range.
        const speedRange = seg.highway ? TRAFFIC.highwaySpeed : TRAFFIC.streetSpeed;
        const temper = (speedRange[0] + rng() * (speedRange[1] - speedRange[0])) / ((speedRange[0] + speedRange[1]) / 2);
        const team = (rng() < 0.6 ? 0 : 1) as 0 | 1;
        const riderSeed = Math.floor(rng() * 4294967296);
        const x = seg.alongX ? along : lineX(line), z = seg.alongX ? lineZ(line) : along;
        const d = Math.hypot(x - p.x, z - p.z);
        if (d > TRAFFIC.radius || d < 60 || (!fill && d < TRAFFIC.spawnMin)) continue;
        // Not on top of anyone, nor inside an intersection.
        const u = (along - (seg.alongX ? GRID.x0 : GRID.z0)) / P;
        if (Math.abs(u - Math.round(u)) * P < STOP + 6) continue;
        if (this.riders.some((o) => o.derezAt === null && Math.abs(o.x - x) + Math.abs(o.z - z) < 60 && o.heading === heading && o.line === line && o.laneIndex === laneIndex)) continue;
        this.spawnRider({ heading, line, along, laneIndex, temper, team, seed: riderSeed });
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
    for (const [px, pz, qx, qz] of this.barriers) {
      const ex = qx - px, ez = qz - pz;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const wx = px - ax, wz = pz - az;
      const t = (wx * ez - wz * ex) / den;
      const u = (wx * dz - wz * dx) / den;
      if (t >= 0 && t <= 1 && u >= -0.02 && u <= 1.02 && t < best) best = t;
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

  // --- Driving: who is ahead, the intersections, lane changes.

  private entry(key: number, lo: number, hi: number, v: number, rider: Rider | null, body: boolean, cross = false, soft = false): void {
    let e = this.entryPool[this.entryCount];
    if (!e) this.entryPool.push((e = { lo: 0, hi: 0, v: 0, rider: null, body: false, cross: false, soft: false }));
    e.cross = cross;
    e.soft = soft;
    this.entryCount++;
    e.lo = Math.min(lo, hi);
    e.hi = Math.max(lo, hi);
    e.v = v;
    e.rider = rider;
    e.body = body;
    let list = this.lanes.get(key);
    if (!list) {
      if (this.lanes.size > 4000) this.lanes.clear(); // lanes left far behind
      this.lanes.set(key, (list = []));
    }
    if (!list.length) this.laneLists.push(list);
    list.push(e);
  }

  /**
   * What is in every lane: each cycle with the jetwall behind it, the wall runs it has left in
   * other lanes (after a turn or a lane change, until they shorten away) and the obstacles.
   */
  private buildLanes(): void {
    for (const l of this.laneLists) l.length = 0;
    this.laneLists.length = 0;
    this.entryCount = 0;
    this.boxes.clear();
    for (const r of this.riders) {
      if (r.derezAt !== null) continue;
      if (r.box >= 0) {
        // Through and clear, the wall with it?
        if (Math.hypot(r.x - r.boxX, r.z - r.boxZ) > STOP + NOSE + trailLength(r) + 1) {
          if (r.token === r.box) this.release(r);
          r.box = -1;
        } else {
          const l = this.boxes.get(r.box);
          if (l) l.push(r); else this.boxes.set(r.box, [r]);
        }
      }
      if (r.jog > 0 || r.uturn > 0) {
        // Across the street: it takes up both lanes it is between (a swing round: the one it joins too).
        const street = r.jog > 0 ? r.jogBack : right(r.heading);
        const ax = alongX(street), a = ax ? r.x : r.z;
        const sv = r.jog > 0 ? dirOf(street) * r.speed : 0; // a jog is over in a moment: it is still going
        for (const lane of TRAFFIC.lanes) this.entry(laneKey(ax, lanePerp(street, r.line, lane)), a - NOSE, a + NOSE, sv, r, true);
        if (r.uturn > 0) this.entry(laneKey(ax, lanePerp(back(street), r.line, TRAFFIC.lanes[0])), a - NOSE - 2, a + NOSE + 2, 0, r, true);
        continue;
      }
      const h = r.heading, ax = alongX(h), d = dirOf(h);
      const a = ax ? r.x : r.z, perp = ax ? r.z : r.x;
      let rear = a - d * NOSE;
      // Back along the jetwall: the run in this lane lengthens the cycle; older runs lie elsewhere.
      let k = r.trail.length - 1;
      for (; k >= 0; k--) {
        const c = r.trail[k];
        if (Math.abs((ax ? c.z : c.x) - perp) > 0.01) break;
        const ca = ax ? c.x : c.z;
        if ((ca - rear) * d < 0) rear = ca;
      }
      this.entry(laneKey(ax, perp), rear, a + d * NOSE, d * r.speed, r, true);
      for (k++; k >= 1; k--) {
        const p = r.trail[k], q = r.trail[k - 1];
        const runX = Math.abs(p.x - q.x) > Math.abs(p.z - q.z);
        const across = runX ? p.z : p.x;
        const off = Math.abs(across - (runX ? lineZ(Math.round((across - GRID.z0) / P)) : lineX(Math.round((across - GRID.x0) / P))));
        if (Math.abs(off - TRAFFIC.lanes[0]) > 0.05 && Math.abs(off - TRAFFIC.lanes[1]) > 0.05) continue; // across a street
        const from = runX ? q.x : q.z, to = runX ? p.x : p.z;
        // Only the oldest run is still shortening (toward its newer end).
        this.entry(laneKey(runX, across), from, to, k === 1 ? Math.sign(to - from) * r.speed : 0, r, false);
      }
      if (r.box >= 0) this.crossLanes(r);
    }
    for (const o of this.obstacles) {
      if (o.y > 4) continue;
      const reach = o.radius + 1.6;
      for (const ax of [true, false]) {
        const across = ax ? o.z : o.x, along = ax ? o.x : o.z;
        const line = ax ? lineZ(Math.round((across - GRID.z0) / P)) : lineX(Math.round((across - GRID.x0) / P));
        for (const lane of TRAFFIC.lanes) for (const side of [-1, 1]) {
          if (Math.abs(across - (line + side * lane)) < reach) this.entry(laneKey(ax, line + side * lane), along - o.radius - 0.5, along + o.radius + 0.5, ax ? o.vx : o.vz, null, true);
        }
      }
    }
  }

  /**
   * A rider inside an intersection: its jetwall, and the path it is committed to through the
   * box, lie across the other lanes there. Whoever comes up to them brakes.
   */
  private crossLanes(r: Rider): void {
    const mark = (ax: number, az: number, bx: number, bz: number, soft: boolean) => {
      const runX = Math.abs(bx - ax) > Math.abs(bz - az);
      const c = runX ? az : ax, a0 = Math.min(runX ? ax : az, runX ? bx : bz), a1 = Math.max(runX ? ax : az, runX ? bx : bz);
      if (a1 - a0 < 0.05) return;
      const base = runX ? r.boxX : r.boxZ;
      for (const lane of TRAFFIC.lanes) for (const side of [-1, 1]) {
        const lc = base + side * lane;
        if (lc >= a0 - 0.3 && lc <= a1 + 0.3) this.entry(laneKey(!runX, lc), c - 0.7, c + 0.7, 0, r, false, true, soft);
      }
    };
    const h = r.heading, ax = alongX(h), d = dirOf(h);
    const nx = r.x + HX[h] * NOSE, nz = r.z + HZ[h] * NOSE;
    let px = nx, pz = nz;
    for (let k = r.trail.length - 1; k >= 0; k--) {
      const c = r.trail[k];
      mark(c.x, c.z, px, pz, false);
      px = c.x;
      pz = c.z;
    }
    // The way out: on to the turn and round it, or straight to the far side.
    const i = ax ? r.node : r.line, j = ax ? r.line : r.node;
    const within = (x: number, z: number) => Math.abs(x - r.boxX) <= STOP && Math.abs(z - r.boxZ) <= STOP;
    if (nodeKey(i, j) === r.box && r.next !== h && r.next !== back(h)) {
      const tx = ax ? r.turnAt : r.x, tz = ax ? r.z : r.turnAt;
      mark(nx, nz, tx, tz, true);
      mark(tx, tz, alongX(r.next) ? r.boxX + HX[r.next] * STOP : tx, alongX(r.next) ? tz : r.boxZ + HZ[r.next] * STOP, true);
    } else if (within(nx, nz)) {
      const ex = ax ? r.boxX + d * STOP : nx, ez = ax ? nz : r.boxZ + d * STOP;
      if (((ax ? ex - nx : ez - nz)) * d > 0) mark(nx, nz, ex, ez, true);
    }
  }

  /** Nearest thing ahead of along-coordinate `from` in a lane (direction d): [gap (m), its speed our way]. */
  private ahead(key: number, from: number, d: number, self: Rider): [number, number] {
    let gap = Infinity, lv = 0;
    const list = this.lanes.get(key);
    // A wall across the lane is gone in a couple of seconds: it only matters if we would be there by then.
    const soon = Math.max(32, self.speed * 2.5 + 6);
    if (list) for (const e of list) {
      if (e.rider === self || ((d > 0 ? e.hi : e.lo) - from) * d <= 0) continue;
      const g = Math.max(0, ((d > 0 ? e.lo : e.hi) - from) * d);
      // Two paths that cross inside an intersection: the lower id rides on, the other brakes.
      // (nor does anyone wait for the path of a rider that is itself standing).
      if (e.cross && (g > soon || (e.soft && (self.id < e.rider!.id || e.rider!.speed < 1)))) continue;
      if (g < gap) { gap = g; lv = e.v * d; }
    }
    return [gap, lv];
  }

  /**
   * Is a lane clear for `need` seconds at along-coordinate c (riders in it travel in direction
   * dir)? Not clear: something stands there, or a rider would reach it in that time. Riders
   * held at this intersection's stop line behind us in the order (and whoever queues behind
   * them) are not coming.
   */
  private laneClear(key: number, c: number, dir: number, need: number, r: Rider, node: number, stopping = false): boolean {
    const list = this.lanes.get(key);
    if (!list) return true;
    let heldAt = Infinity;
    for (const e of list) {
      const o = e.rider;
      if (!o || o === r || !e.body || o.held !== node) continue;
      if (r.token === node || (o.next === left(o.heading) && r.id < o.id)) heldAt = Math.min(heldAt, (c - (dir > 0 ? e.hi : e.lo)) * dir);
    }
    for (const e of list) {
      if (e.rider === r) continue;
      const reach = (c - (dir > 0 ? e.hi : e.lo)) * dir, passed = (c - (dir > 0 ? e.lo : e.hi)) * dir;
      if (passed < -1.5 || reach > 400 || reach >= heldAt - 0.1) continue;
      if (reach <= 2.5) return false;
      if (!e.body) continue;
      // On amber, whoever is not committed (and not in the intersection) is stopping.
      if (stopping && e.rider && e.rider.commit !== node && e.rider.box !== node) continue;
      if ((reach - 2.5) / Math.max(e.v * dir * 1.1 + 2, 9) < need) return false;
    }
    return true;
  }

  private release(r: Rider): void {
    if (r.token >= 0 && this.tokens.get(r.token) === r) this.tokens.delete(r.token);
    r.token = -1;
  }

  /** Is someone who came in on the other axis still inside the intersection (or its wall is)? */
  private crossBusy(node: number, axisX: boolean, r: Rider): boolean {
    const l = this.boxes.get(node);
    if (l) for (const o of l) if (o !== r && o.boxAxisX !== axisX) return true;
    return false;
  }

  /** One control tick for a rider: its acceleration, and how far it may ride before the next. */
  private drive(r: Rider, time: number): void {
    r.held = -1;
    // Right of way it never used (it went another way): given up.
    if (r.token >= 0 && r.box !== r.token && Math.hypot(r.x - r.tokenX, r.z - r.tokenZ) > 150) this.release(r);
    if (r.jog > 0 || r.uturn > 0) {
      // Square across the street at a steady pace, whatever it was doing.
      r.accel = 0;
      r.speed = Math.max(r.speed, 5);
      r.room = Infinity;
      return;
    }
    const h = r.heading, ax = alongX(h), d = dirOf(h);
    const a = ax ? r.x : r.z, perp = ax ? r.z : r.x;
    const nose = a + d * NOSE;
    const v = r.speed, v0 = this.desired(r);
    let [gap, lv] = this.ahead(laneKey(ax, perp), nose, d, r);
    const leadGap = gap, leadV = lv;
    const i = ax ? r.node : r.line, j = ax ? r.line : r.node;
    const nodePos = ax ? lineX(r.node) : lineZ(r.node);
    const toStop = (nodePos - d * STOP - nose) * d;
    if (this.control && toStop <= -0.5 && toStop > -2 * STOP && r.box !== nodeKey(i, j) && controlAt(i, j) !== CONTROL.none) {
      // Over the stop line: in the intersection until it and its wall are out the other side.
      r.box = nodeKey(i, j);
      r.boxX = lineX(i);
      r.boxZ = lineZ(j);
      r.boxAxisX = ax;
    }
    if (this.control && toStop > -0.5 && toStop < 250) {
      const key = nodeKey(i, j);
      const kind = controlAt(i, j);
      // Committed to this lane now: a turn it can't make from here is planned again.
      if (toStop < 45 && r.wantLane >= 0 && r.wantLane !== r.laneIndex) this.plan(r, undefined, true);
      const next = r.next, turning = next !== h && next !== back(h);
      const toTurn = (r.turnAt - a) * d;
      // The lane it turns into: whoever is there is its leader through the turn.
      let exitGap = leadGap - toStop - 2 * STOP, exitV = leadV;
      if (turning) {
        const d2 = dirOf(next), p2 = lanePerp(next, alongX(next) ? j : i, r.lane);
        const [g2, v2] = this.ahead(laneKey(alongX(next), p2), perp + d2 * NOSE, d2, r);
        exitGap = g2;
        exitV = v2;
        if (toTurn - NOSE + g2 < gap) { gap = Math.max(0, toTurn - NOSE + g2); lv = v2; }
      }
      // Nobody enters a crossing it cannot leave.
      const blocked = next !== back(h) && exitGap < 2 * NOSE + TRAFFIC.gap + 2 && exitV < 2;
      let stop = blocked;
      if (kind === CONTROL.signal) {
        const [light, remains] = signalPhase(i, j, ax, time);
        // Committed, then held up on the way: not through on a later red.
        if (r.commit === key && time > r.commitUntil) r.commit = -1;
        if (r.commit !== key) {
          // A left turn that has waited out the green goes as the oncoming lanes stop: on
          // amber, or in the first second of the all-red (cross traffic waits for it to clear).
          const waitedLeft = next === left(h) && !blocked && toStop < 14 && v < 12 && this.leftTurnFirst(r, key);
          if (light === 'red') {
            if (waitedLeft && remains > SIGNAL.cycle / 2 + SIGNAL.allRed - 1 && this.oncomingClear(r, key, toTurn, true)) { r.commit = key; r.commitUntil = time + remains - (SIGNAL.cycle / 2 + SIGNAL.allRed - 1); }
            else stop = true;
          } else if (light === 'amber') {
            if (r.fresh && toStop > v * remains) stop = true; // just placed, and it would not make it: it starts slower
            else if ((v * v) / 20 > toStop && toStop < v * remains + 2) { r.commit = key; r.commitUntil = time + remains; } // too close to stop, and it makes it: through on amber
            else if (waitedLeft && remains < SIGNAL.amber - 0.25 && this.oncomingClear(r, key, toTurn, true)) { r.commit = key; r.commitUntil = time + remains + 1; }
            else { stop = true; if (next === left(h)) r.held = key; }
          }
          // Green: a left turn gives way to the oncoming lanes; nobody starts into cross traffic still clearing.
          else if (next === left(h) && toStop < (v * v) / 8 + 20 && !this.oncomingClear(r, key, toTurn, false)) { stop = true; r.held = key; }
          else if (toStop < (v * v) / 8 + 20 && this.crossBusy(key, ax, r)) stop = true;
        }
      } else if (kind !== CONTROL.none) {
        // The priority road rides through (and turns right) freely; everyone else takes the
        // crossing one at a time, and gives way to the priority road.
        const major = kind === CONTROL.priority && isHighwayLine(r.line);
        if (!major || next === left(h) || next === back(h)) {
          // The first in its lane asks for the crossing as it comes up to the line.
          if (r.token !== key && !stop && leadGap > toStop && toStop < Math.max(30, v * 2.5)) {
            const holder = this.tokens.get(key);
            if (!holder || holder.derezAt !== null || holder.token !== key) {
              if (r.token >= 0) this.release(r);
              this.tokens.set(key, r);
              r.token = key;
              r.tokenX = lineX(i);
              r.tokenZ = lineZ(j);
            }
          }
          if (r.token !== key) { stop = true; r.held = key; }
          else if (!stop && this.crossBusy(key, ax, r)) stop = true;
          else if (!stop && kind === CONTROL.priority && !(major ? this.oncomingClear(r, key, toTurn, false) : this.crossClear(r, key, toStop))) { stop = true; r.held = key; }
        }
      }
      if (stop && toStop + 2 < gap) { gap = Math.max(0, toStop) + 2; lv = 0; }
    }
    if (r.fresh) {
      // Just placed: at a speed it can stop from.
      r.fresh = false;
      if (gap < Infinity) r.speed = Math.min(r.speed, lv + Math.sqrt(2 * TRAFFIC.brake * gap));
    }
    r.accel = Math.min(TRAFFIC.accel, idm(r.speed, v0, gap, lv));
    r.room = Math.max(0, gap - 2.3);
    if (this.control && (this.steps / 4 + r.id) % 8 === 0) this.changeLane(r, leadGap, leadV, toStop);
  }

  /** Two left turns waiting face to face cross each other: the one that has waited longer goes first. */
  private leftTurnFirst(r: Rider, node: number): boolean {
    const o = back(r.heading);
    for (const lane of TRAFFIC.lanes) for (const e of this.lanes.get(laneKey(alongX(o), lanePerp(o, r.line, lane))) ?? []) {
      const w = e.rider;
      if (!w || !e.body || w.held !== node || w.next !== left(w.heading)) continue;
      if (w.waited > r.waited + 0.5 || (w.waited > r.waited - 0.5 && w.id < r.id)) return false;
    }
    return true;
  }

  /** May a left-turner cross the oncoming lanes of its own street? */
  private oncomingClear(r: Rider, node: number, toTurn: number, stopping: boolean): boolean {
    const h = r.heading, o = back(h);
    for (const lane of TRAFFIC.lanes) {
      const need = travelTime(toTurn + r.lane + lane + NOSE + 1, r.speed) + TRAFFIC.trailTime + 0.4;
      if (!this.laneClear(laneKey(alongX(h), lanePerp(o, r.line, lane)), r.turnAt, dirOf(o), need, r, node, stopping)) return false;
    }
    return true;
  }

  /** May a rider on the minor street cross or join the priority road at r.node? */
  private crossClear(r: Rider, node: number, toStop: number): boolean {
    const h = r.heading, ax = alongX(h), d = dirOf(h);
    const perp = ax ? r.z : r.x;
    const i = ax ? r.node : r.line, j = ax ? r.line : r.node;
    const nodePos = ax ? lineX(r.node) : lineZ(r.node);
    const n = r.next;
    if (n === back(h)) return true;
    for (const hc of [right(h), left(h)]) for (let k = 0; k < 2; k++) {
      // Lanes it crosses or joins: all four straight on; a right turn the near lanes out to its
      // own; a left turn the near lanes and the far ones in to its own.
      if (n === right(h) && (hc !== n || k < r.laneIndex)) continue;
      if (n === left(h) && hc === n && k > r.laneIndex) continue;
      const pc = lanePerp(hc, alongX(hc) ? j : i, TRAFFIC.lanes[k]);
      const joins = hc === n && k === r.laneIndex;
      const need = travelTime(toStop + STOP + (pc - nodePos) * d + 2 * NOSE + 1, r.speed) + TRAFFIC.trailTime + (joins ? 2.8 : 0.8);
      if (!this.laneClear(laneKey(!ax, pc), perp, dirOf(hc), need, r, node)) return false;
    }
    return true;
  }

  /**
   * Lane changes: into the lane the next turn leaves from; out to pass a slower rider; back to
   * the outer lane when it is empty. Only between intersections and only into a real gap.
   */
  private changeLane(r: Rider, leadGap: number, leadV: number, toStop: number): void {
    // Between the intersections; close to one only a rider going straight on moves over.
    if (toStop < 6 || toStop > P - 2 * STOP - 12 || (toStop < 45 && r.next !== r.heading)) return;
    const h = r.heading, ax = alongX(h), d = dirOf(h);
    const a = ax ? r.x : r.z;
    const other = (1 - r.laneIndex) as 0 | 1;
    const must = r.wantLane === other;
    const v0 = this.desired(r);
    const slowed = leadGap < 90 && leadV < v0 - 3;
    const keepRight = r.laneIndex === 0 && r.wantLane < 0 && r.next !== left(h) && !slowed && r.speed > 8 && r.rng() < 0.1;
    if (!must && !slowed && !keepRight) return;
    if (!must && r.wantLane === r.laneIndex) return;
    const list = this.lanes.get(laneKey(ax, lanePerp(h, r.line, TRAFFIC.lanes[other])));
    let gap = Infinity, lv = 0;
    if (list) for (const e of list) {
      const front = d > 0 ? e.hi : e.lo, rear = d > 0 ? e.lo : e.hi;
      const ahead = (rear - (a + d * NOSE)) * d, behind = (a - d * NOSE - front) * d;
      if (behind > 0) {
        // Someone coming up behind in that lane: room for it to see us and ease off.
        const ov = e.v * d;
        if (behind < 4 + ov * 1.1 + Math.max(0, ov - r.speed) * 2) return;
      } else if (ahead < 4 + r.speed * 0.3) return; // alongside, or too close ahead
      else if (ahead < gap) { gap = ahead; lv = e.v * d; }
    }
    if (!must) {
      const gain = idm(r.speed, v0, gap, lv) - idm(r.speed, v0, leadGap, leadV);
      if (slowed ? gain < 0.8 : gap < 120) return;
    }
    // A light cycle changes lane the way it turns: square.
    this.corner(r);
    r.jogBack = h;
    r.heading = other === 1 ? right(h) : left(h);
    r.jog = LANE_GAP;
    r.speed = Math.max(r.speed, 5); // pulling out of a queue
    r.room = Infinity;
    r.laneIndex = other;
    r.lane = TRAFFIC.lanes[other];
    // Out of the lane its turn leaves from (to pass): it wants back before the intersection.
    const turn = r.next !== h && r.next !== back(h);
    r.wantLane = turn && r.next !== (other === 0 ? left(h) : right(h)) ? 1 - other : -1;
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
    this.release(r);
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
