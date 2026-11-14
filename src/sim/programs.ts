import { GRID } from '../arch/grid.ts';
import { CITY, hash01, PLANET, wrapCoord } from './layout.ts';
import { nodeX, nodeZ, roadOpen } from './roads.ts';
import { terrainHeight } from './terrain.ts';
import { mulberry32 } from './atmosphere.ts';
import type { RoadClosure } from './roadDamage.ts';
import { FREELANCER, MERC_LIGHT, sideLight, type Side, type Team } from './teams.ts';

/**
 * Programs: the working population of the streets, one kind for each side in the war, beside the
 * Bits (who are everyone's). They walk the margins of the road network in small groups, from
 * corner to corner, and each kind has a job:
 *
 * - **Archivists** (Cyan): tall hexagonal carriers of a lit data cube. They wander Cyan
 *   districts and stop at the corners of blocks to upload into the buildings.
 * - **Sentinels** (Red): tapered columns under a red halo, on patrol in threes. A player on foot
 *   who is not Red is warned (NO); if Red is hostile to them (war, wanted) and they come on,
 *   derezzed. Red players are saluted.
 * - **Tenders** (Amber): squat drums with an amber band, in pairs. They walk to broken roads in
 *   reach and mend them: the closure lifts, the rubble goes.
 * - **Scavengers** (freelancers): low tetrahedra with fragments circling them, in bands. They
 *   go wherever something has just blown up and pick it over.
 * - **Brokers** (mercenaries): a cube stood on its corner over a lit disc, at street corners.
 *   Say YES beside one to renew your mercenaries' contracts.
 *
 * Deterministic: every road corner is a post or not by a hash of its indices, and what stands
 * there is chosen by who holds the district (captures change who walks a street). Streamed round
 * the player like the Bits; DOM- and scene-free.
 */

export type ProgramKind = 'archivist' | 'sentinel' | 'tender' | 'scavenger' | 'broker';
/** A program's side: a team, the freelancers, or the mercenaries. */
export type ProgramSide = Side | 'merc';

export interface ProgramKindInfo {
  side: ProgramSide;
  name: string;
  /** Group size range. */
  group: readonly [number, number];
  /** Walking pace (m/s): 0 for those who keep their corner. */
  pace: number;
  /** Height of the figure (m): what a blast or a bumper has to reach. */
  height: number;
}

export const PROGRAM_KINDS: Readonly<Record<ProgramKind, ProgramKindInfo>> = {
  archivist: { side: 0, name: 'Archivist', group: [1, 2], pace: 1.7, height: 3.6 },
  sentinel: { side: 1, name: 'Sentinel', group: [3, 3], pace: 2.3, height: 4.2 },
  tender: { side: 2, name: 'Tender', group: [2, 2], pace: 2.8, height: 1.8 },
  scavenger: { side: FREELANCER, name: 'Scavenger', group: [2, 4], pace: 3.1, height: 1.4 },
  broker: { side: 'merc', name: 'Broker', group: [1, 1], pace: 0, height: 2.8 },
};
/** A program's light colour: its side's. */
export const programLight = (side: ProgramSide): string => (side === 'merc' ? MERC_LIGHT : sideLight(side));

export const PROGRAM_KIND_LIST = Object.keys(PROGRAM_KINDS) as ProgramKind[];
/** The kind that belongs to each team (index = team). */
export const TEAM_PROGRAM: readonly ProgramKind[] = ['archivist', 'sentinel', 'tender'];

export const PROGRAMS = {
  /** Streamed disc round the player (m), and where a group is dropped. */
  radius: 480,
  despawn: 620,
  max: 180,
  /** Share of road corners with a post. */
  posts: 0.62,
  /** Of the posts, the share given to the district's own team; then scavengers; brokers the rest. */
  own: 0.72,
  scavengers: 0.18,
  /** Off a street's centreline (m): the margin of the carriageway, just inside the Bits' kerb. */
  margin: CITY.street / 2 - 1.6,
  /** Pace on the way to work (×). */
  hurry: 1.7,
  /** Spacing in file (m). */
  spacing: 2.6,
  /** Within this of a moving vehicle's centre (m), a program is run over. */
  hitRange: 1.9,
  earshot: 9,
  /** Nothing pops in nearer than this (m) once the player has been somewhere a while. */
  popIn: 140,
  /** The dead come back to their post after this long (s). */
  respawn: 180,
  sentinel: { warn: 16, fire: 9, aim: 2.5, calm: 24, salute: 10, reward: 25 },
  tender: { reach: 700, work: 24 },
  scavenger: { reach: 800, fresh: 150, loiter: 18 },
  archivist: { upload: 0.35, time: 5 },
  broker: { renew: 120, price: 150 },
} as const;

const P = GRID.pitch;
const N = GRID.blocks;
const C = PLANET.circumference;
const M = PROGRAMS.margin;
const mod = (a: number, n: number) => ((a % n) + n) % n;
const wrapDelta = (d: number) => d - Math.round(d / C) * C;

/** A corner of the road network: intersection (i, j) (unbounded) and which of its four corners. */
export interface Corner {
  i: number;
  j: number;
  qx: 1 | -1;
  qz: 1 | -1;
}

export const cornerX = (c: Corner) => nodeX(c.i) + M * c.qx;
export const cornerZ = (c: Corner) => nodeZ(c.j) + M * c.qz;

/** The road segments that run past a corner: along X (on z-line j) and along Z (on x-line i). */
function segA(c: Corner): [boolean, number, number] { return [true, c.qx > 0 ? c.i : c.i - 1, c.j]; }
function segB(c: Corner): [boolean, number, number] { return [false, c.i, c.qz > 0 ? c.j : c.j - 1]; }

type Blocked = (alongX: boolean, i: number, j: number) => boolean;

/** The ways on from a corner: along the block's edge either way, or across one of the two streets. */
export function cornerMoves(c: Corner, closed?: Blocked): Array<{ to: Corner; cross: boolean }> {
  const out: Array<{ to: Corner; cross: boolean }> = [];
  const open = (s: [boolean, number, number]) => roadOpen(...s) && !closed?.(...s);
  const okA = open(segA(c)), okB = open(segB(c));
  const acrossX: Corner = { i: c.i, j: c.j, qx: (-c.qx) as 1 | -1, qz: c.qz };
  const acrossZ: Corner = { i: c.i, j: c.j, qx: c.qx, qz: (-c.qz) as 1 | -1 };
  if (okA) out.push({ to: { i: c.i + c.qx, j: c.j, qx: (-c.qx) as 1 | -1, qz: c.qz }, cross: false });
  if (okB) out.push({ to: { i: c.i, j: c.j + c.qz, qx: c.qx, qz: (-c.qz) as 1 | -1 }, cross: false });
  // Over the street on line i: across it where it runs, or straight on along the margin where
  // the street on line j carries on past a node with no cross street.
  if (okB || (okA && open(segA(acrossX)))) out.push({ to: acrossX, cross: okB });
  if (okA || (okB && open(segB(acrossZ)))) out.push({ to: acrossZ, cross: okA });
  return out;
}

const sameCorner = (a: Corner | null, b: Corner) => !!a && a.i === b.i && a.j === b.j && a.qx === b.qx && a.qz === b.qz;

/** What stands at the post on road corner (i, j), given who holds the district there. */
export function postAt(i: number, j: number, owner: Team | null): { kind: ProgramKind; corner: Corner; size: number; key: number } | null {
  const ci = mod(i, N), cj = mod(j, N);
  if (hash01(ci, cj, 0x9a1) >= PROGRAMS.posts) return null;
  const q = hash01(ci, cj, 0x9a2);
  const corner: Corner = { i, j, qx: q < 0.5 ? 1 : -1, qz: (q * 4) % 2 < 1 ? 1 : -1 };
  if (!roadOpen(...segA(corner)) && !roadOpen(...segB(corner))) return null; // inside a lot
  const r = hash01(ci, cj, 0x9a3);
  let kind: ProgramKind;
  if (owner !== null && r < PROGRAMS.own) kind = TEAM_PROGRAM[owner];
  else if (r < PROGRAMS.own + PROGRAMS.scavengers || owner === null) kind = 'scavenger';
  else kind = 'broker';
  const [lo, hi] = PROGRAM_KINDS[kind].group;
  const size = lo + Math.floor(hash01(ci, cj, 0x9a4) * (hi - lo + 1));
  return { kind, corner, size, key: ci * N + cj };
}

export type ProgramActivity = 'walk' | 'pause' | 'work' | 'alert';

export interface Program {
  /** Group key × 8 + place in the group. */
  key: number;
  kind: ProgramKind;
  side: ProgramSide;
  k: number;
  group: ProgramGroup;
  x: number;
  /** Ground height under it (the figure stands on it). */
  y: number;
  z: number;
  yaw: number;
  answer: 'yes' | 'no' | null;
  answeredAt: number;
  /** Offset of its idle motion, so a group does not move in step. */
  beat: number;
  gx: number;
  gz: number;
}

export interface ProgramGroup {
  key: number;
  kind: ProgramKind;
  side: ProgramSide;
  post: Corner;
  at: Corner;
  /** The corner it walks to, and how far along (m) of how long. */
  to: Corner | null;
  along: number;
  len: number;
  last: Corner | null;
  activity: ProgramActivity;
  until: number;
  /** Where its work is (a crater, a building, a wreck), while working or on its way. */
  goal: { x: number; z: number } | null;
  /** A tender's job, a scavenger's site. */
  job: RoadClosure | null;
  site: number;
  /** Leader's footsteps, newest last: the others walk them in file. */
  trail: Array<{ x: number; z: number }>;
  members: Program[];
  rand: () => number;
  /** A sentinel group: how long the player has been inside firing range since the warning (s). */
  aim: number;
  saluted: number;
}

/** What the programs need to know of the world, each step. */
export interface ProgramWorld {
  /** Who holds the district at (x, z). */
  owner(x: number, z: number): Team | null;
  /** Is this road segment closed (a crater)? */
  closed?: Blocked;
  /** Broken roads (tenders mend them). */
  closures?: readonly RoadClosure[];
  /** Mend one: called when a tender has finished. */
  repair?(c: RoadClosure): void;
  /** Places that just blew up (scavengers go to them). */
  sites?: ReadonlyArray<{ x: number; z: number; time: number }>;
  /** The player on foot, and their team. */
  walker?: { active: boolean; downAt: number | null; x: number; y: number; z: number };
  team?: Team;
  /** Is Red hostile to the player now (war, wanted, renegade)? Sentinels fire only then; at
   *  peace they warn and stand their ground. Missing: hostile to every stranger. */
  hostile?: () => boolean;
  /** Vehicles they can be run over by. */
  threats?: ReadonlyArray<{ x: number; y: number; z: number; vx: number; vz: number }>;
}

export interface ProgramShot { x: number; y: number; z: number; tx: number; ty: number; tz: number; time: number }

export class Programs {
  readonly people: Program[] = [];
  readonly groups = new Map<number, ProgramGroup>();
  /** Derezzed members (key → when): they come back to their post after a while. */
  private readonly gone = new Map<number, number>();
  /** Programs that derezzed this step (drained by the simulation: chips, credits). */
  readonly derezEvents: Array<{ x: number; y: number; z: number; side: ProgramSide; kind: ProgramKind; byPlayer: boolean }> = [];
  /** Sentinel shots, newest last (kept a second, for the renderer). */
  readonly shots: ProgramShot[] = [];
  /** Roads mended so far, and sites picked over (tests, stats). */
  repaired = 0;
  enabled = true;
  private lastManage: { x: number; z: number } | null = null;
  private manageAt = -Infinity;
  private worked = new Set<RoadClosure>();
  private visited = new Set<number>();

  reset(): void {
    this.people.length = 0;
    this.groups.clear();
    this.gone.clear();
    this.derezEvents.length = 0;
    this.shots.length = 0;
    this.lastManage = null;
    this.manageAt = -Infinity;
    this.worked.clear();
    this.visited.clear();
    this.repaired = 0;
  }

  /** Stream groups in and out round (x, z). */
  private manage(x: number, z: number, time: number, world: ProgramWorld): void {
    const lm = this.lastManage;
    // Somewhere new (start, reset, a long jump): fill the view at once.
    const fresh = !lm || Math.hypot(wrapDelta(x - lm.x), wrapDelta(z - lm.z)) > 300;
    for (const [key, g] of this.groups) {
      const l = g.members[0];
      const far = !l || Math.hypot(wrapDelta(l.x - x), wrapDelta(l.z - z)) > PROGRAMS.despawn;
      if (far) this.drop(key);
    }
    const i0 = Math.round((x - GRID.x0) / P), j0 = Math.round((z - GRID.z0) / P);
    const ring = Math.ceil(PROGRAMS.radius / P) + 1;
    for (let di = -ring; di <= ring; di++) for (let dj = -ring; dj <= ring; dj++) {
      if (this.people.length >= PROGRAMS.max) return;
      const i = i0 + di, j = j0 + dj;
      const d = Math.hypot(nodeX(i) - x, nodeZ(j) - z);
      if (d > PROGRAMS.radius || (!fresh && d < PROGRAMS.popIn)) continue;
      const post = postAt(i, j, world.owner(wrapCoord(nodeX(i)), wrapCoord(nodeZ(j))));
      if (!post || this.groups.has(post.key)) continue;
      this.spawn(post, time);
    }
  }

  private drop(key: number): void {
    const g = this.groups.get(key);
    if (!g) return;
    this.groups.delete(key);
    for (let i = this.people.length - 1; i >= 0; i--) if (this.people[i].group === g) this.people.splice(i, 1);
    if (g.job) this.worked.delete(g.job);
  }

  private spawn(post: { kind: ProgramKind; corner: Corner; size: number; key: number }, time: number): void {
    const info = PROGRAM_KINDS[post.kind];
    const rand = mulberry32(post.key * 2654435761 + 0x51ed);
    const g: ProgramGroup = {
      key: post.key, kind: post.kind, side: info.side, post: post.corner, at: post.corner, to: null, along: 0, len: 0, last: null,
      activity: 'pause', until: time + rand() * 4, goal: null, job: null, site: -1, trail: [], members: [], rand, aim: 0, saluted: -Infinity,
    };
    const x = cornerX(post.corner), z = cornerZ(post.corner);
    // The file stands back along the block's edge from the corner.
    const back = roadOpen(...segA(post.corner)) ? { x: post.corner.qx, z: 0 } : { x: 0, z: post.corner.qz };
    // Footsteps as fine as a walk lays them, so the file never cuts a corner on its first turn.
    const steps = Math.ceil(((post.size - 1) * PROGRAMS.spacing) / 0.4);
    for (let k = steps; k >= 0; k--) g.trail.push({ x: x + back.x * k * 0.4, z: z + back.z * k * 0.4 });
    for (let k = 0; k < post.size; k++) {
      const key = post.key * 8 + k;
      const at = this.gone.get(key);
      if (at !== undefined && time - at < PROGRAMS.respawn) continue;
      this.gone.delete(key);
      const t = g.trail[Math.max(0, g.trail.length - 1 - Math.round((k * PROGRAMS.spacing) / 0.4))];
      const p: Program = {
        key, kind: post.kind, side: info.side, k, group: g, x: t.x, y: 0, z: t.z, yaw: rand() * Math.PI * 2,
        answer: null, answeredAt: -Infinity, beat: rand() * 10, gx: Infinity, gz: Infinity,
      };
      p.y = this.ground(p);
      g.members.push(p);
      this.people.push(p);
    }
    if (!g.members.length) return;
    this.groups.set(post.key, g);
  }

  private ground(p: Program): number {
    if (Math.abs(p.x - p.gx) + Math.abs(p.z - p.gz) > 2) {
      p.gx = p.x;
      p.gz = p.z;
      p.y = terrainHeight(wrapCoord(p.x), wrapCoord(p.z));
    }
    return p.y;
  }

  /** Blasts and rubble: whoever is inside r of (x, y, z) derezzes. Returns how many. */
  strike(x: number, y: number, z: number, r: number, time: number): number {
    let n = 0;
    for (let i = this.people.length - 1; i >= 0; i--) {
      const p = this.people[i];
      const h = PROGRAM_KINDS[p.kind].height / 2;
      if ((p.x - x) ** 2 + (p.y + h - y) ** 2 + (p.z - z) ** 2 < r * r) { this.derez(p, time, false); n++; }
    }
    return n;
  }

  private derez(p: Program, time: number, byPlayer: boolean): void {
    const i = this.people.indexOf(p);
    if (i >= 0) this.people.splice(i, 1);
    const g = p.group;
    g.members.splice(g.members.indexOf(p), 1);
    this.gone.set(p.key, time);
    this.derezEvents.push({ x: p.x, y: p.y + PROGRAM_KINDS[p.kind].height / 2, z: p.z, side: p.side, kind: p.kind, byPlayer });
    if (!g.members.length) {
      this.groups.delete(g.key);
      if (g.job) this.worked.delete(g.job);
    }
  }

  /** Is a program on the player's side, or one of theirs? */
  static friendly(p: { side: ProgramSide; kind: ProgramKind }, team: Team): boolean {
    if (p.kind === 'sentinel') return team === 1;
    if (p.kind === 'archivist') return team === 0;
    return true; // tenders, scavengers and brokers deal with anyone
  }

  /** The player on foot says YES or NO: the programs in earshot answer. Returns the broker heard, if any. */
  hear(x: number, z: number, answer: 'yes' | 'no', team: Team, time: number): Program | null {
    let broker: Program | null = null, bd = Infinity;
    for (const p of this.people) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > PROGRAMS.earshot) continue;
      p.yaw = Math.atan2(x - p.x, -(z - p.z));
      p.answer = Programs.friendly(p, team) ? (answer === 'yes' ? 'yes' : 'no') : 'no';
      p.answeredAt = time + 0.3 + (p.beat % 1) * 0.4;
      if (p.kind === 'broker' && d < bd) { broker = p; bd = d; }
    }
    return broker;
  }

  /** Advance by dt round the player at `centre`. */
  step(dt: number, time: number, centre: { x: number; z: number }, world: ProgramWorld): { shotPlayer: boolean } {
    let shotPlayer = false;
    if (!this.enabled) return { shotPlayer };
    const lm = this.lastManage;
    if (!lm || time - this.manageAt > 1 || Math.hypot(centre.x - lm.x, centre.z - lm.z) > 40) {
      this.manage(centre.x, centre.z, time, world);
      this.lastManage = { x: centre.x, z: centre.z };
      this.manageAt = time;
    }
    for (let i = this.shots.length - 1; i >= 0; i--) if (time - this.shots[i].time > 1) this.shots.splice(i, 1);
    // Run over.
    for (const t of world.threats ?? []) {
      const speed = Math.hypot(t.vx, t.vz);
      if (speed < 2) continue;
      for (let i = this.people.length - 1; i >= 0; i--) {
        const p = this.people[i];
        if (t.y - p.y > PROGRAM_KINDS[p.kind].height + 2 || t.y < p.y - 3) continue;
        if ((p.x - t.x) ** 2 + (p.z - t.z) ** 2 < PROGRAMS.hitRange ** 2) this.derez(p, time, true);
      }
    }
    const w = world.walker && world.walker.active && world.walker.downAt === null ? world.walker : null;
    for (const g of [...this.groups.values()]) {
      if (g.kind === 'sentinel' && w && world.team !== undefined) {
        if (this.guard(g, w, world.team, dt, time, world.hostile ? world.hostile() : true)) shotPlayer = true;
      }
      if (g.activity === 'alert') { this.file(g); continue; }
      if (g.activity === 'walk' && g.to) {
        const l = g.members[0];
        // With a job to get to, they hurry.
        const pace = PROGRAM_KINDS[g.kind].pace * (g.goal ? PROGRAMS.hurry : 1);
        g.along = Math.min(g.len, g.along + pace * dt);
        const f = g.len > 0 ? g.along / g.len : 1;
        const ax = cornerX(g.at), az = cornerZ(g.at), bx = cornerX(g.to), bz = cornerZ(g.to);
        const x = ax + (bx - ax) * f, z = az + (bz - az) * f;
        if (l) l.yaw = Math.atan2(bx - ax, -(bz - az));
        this.lead(g, x, z);
        if (g.along >= g.len) this.arrive(g, time, world);
      } else if (time >= g.until) {
        if (g.activity === 'work') this.finishWork(g, world);
        this.next(g, time, world);
      }
      this.file(g);
    }
    return { shotPlayer };
  }

  /** The leader steps to (x, z): its footsteps join the trail. */
  private lead(g: ProgramGroup, x: number, z: number): void {
    // The newest point is the leader itself; a new one is laid each 0.4 m past the one before.
    const n = g.trail.length, head = g.trail[n - 1], before = g.trail[n - 2];
    if (!head || !before || Math.hypot(x - before.x, z - before.z) > 0.4) g.trail.push({ x, z });
    else { head.x = x; head.z = z; }
    const keep = Math.ceil((g.members.length * PROGRAMS.spacing + 4) / 0.4) + 2;
    if (g.trail.length > keep) g.trail.splice(0, g.trail.length - keep);
  }

  /** Each member stands its spacing back along the trail. */
  private file(g: ProgramGroup): void {
    const tr = g.trail;
    for (const p of g.members) {
      let want = p.k * PROGRAMS.spacing;
      let x = tr[tr.length - 1].x, z = tr[tr.length - 1].z;
      for (let i = tr.length - 1; i > 0 && want > 0; i--) {
        const a = tr[i], b = tr[i - 1];
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        if (d >= want) { x = a.x + (b.x - a.x) * (want / d); z = a.z + (b.z - a.z) * (want / d); want = 0; break; }
        want -= d;
        x = b.x; z = b.z;
      }
      if (p.k > 0 && (Math.abs(x - p.x) + Math.abs(z - p.z) > 1e-3)) p.yaw = Math.atan2(x - p.x, -(z - p.z));
      p.x = x;
      p.z = z;
      this.ground(p);
    }
  }

  private arrive(g: ProgramGroup, time: number, world: ProgramWorld): void {
    g.last = g.at;
    g.at = g.to!;
    g.to = null;
    const r = g.rand();
    const x = cornerX(g.at), z = cornerZ(g.at);
    if (g.kind === 'tender' && g.job) {
      const c = g.job;
      const ends = c.alongX ? [[c.i, c.j], [c.i + 1, c.j]] : [[c.i, c.j], [c.i, c.j + 1]];
      if (ends.some(([i, j]) => mod(i, N) === mod(g.at.i, N) && mod(j, N) === mod(g.at.j, N))) {
        g.activity = 'work'; g.until = time + PROGRAMS.tender.work; g.goal = { x: c.x, z: c.z };
        return;
      }
    }
    if (g.kind === 'scavenger' && g.goal && g.site >= 0 && Math.hypot(wrapDelta(g.goal.x - x), wrapDelta(g.goal.z - z)) < 60) {
      g.activity = 'work'; g.until = time + PROGRAMS.scavenger.loiter;
      return;
    }
    if (g.kind === 'archivist' && r < PROGRAMS.archivist.upload) {
      // Upload into the block behind the corner.
      g.activity = 'work'; g.until = time + PROGRAMS.archivist.time;
      g.goal = { x: x + g.at.qx * 12, z: z + g.at.qz * 12 };
      return;
    }
    const pause = g.kind === 'sentinel' ? 0.25 : 0.15;
    if (r > 1 - pause) { g.activity = 'pause'; g.until = time + 2 + g.rand() * 4; return; }
    this.next(g, time, world);
  }

  private finishWork(g: ProgramGroup, world: ProgramWorld): void {
    if (g.kind === 'tender' && g.job) {
      const c = g.job;
      if (world.closures?.includes(c)) { world.repair?.(c); this.repaired++; }
      this.worked.delete(c);
      g.job = null;
    }
    if (g.kind === 'scavenger' && g.site >= 0) { this.visited.add(g.site); g.site = -1; }
    g.goal = null;
  }

  /** Choose where to walk next. */
  private next(g: ProgramGroup, time: number, world: ProgramWorld): void {
    if (PROGRAM_KINDS[g.kind].pace === 0 || !g.members.length) { g.activity = 'pause'; g.until = time + 5 + g.rand() * 5; return; }
    const x = cornerX(g.at), z = cornerZ(g.at);
    // Find work.
    if (g.kind === 'tender' && !g.job) {
      let best: RoadClosure | null = null, bd: number = PROGRAMS.tender.reach;
      for (const c of world.closures ?? []) {
        if (this.worked.has(c)) continue;
        const d = Math.hypot(wrapDelta(c.x - x), wrapDelta(c.z - z));
        if (d < bd) { bd = d; best = c; }
      }
      if (best) { g.job = best; this.worked.add(best); }
    }
    if (g.kind === 'tender' && g.job) {
      const c = g.job;
      if (!world.closures?.includes(c)) { this.worked.delete(c); g.job = null; g.goal = null; }
      else {
        // The nearer end of the broken segment.
        const ends = c.alongX ? [[c.i, c.j], [c.i + 1, c.j]] : [[c.i, c.j], [c.i, c.j + 1]];
        let gx = 0, gz = 0, gd = Infinity;
        for (const [i, j] of ends) {
          const ex = x + wrapDelta(nodeX(i) - x), ez = z + wrapDelta(nodeZ(j) - z);
          const d = Math.hypot(ex - x, ez - z);
          if (d < gd) { gd = d; gx = ex; gz = ez; }
        }
        g.goal = { x: gx, z: gz };
      }
    }
    if (g.kind === 'scavenger' && g.site < 0) {
      let best = -1, bt = -Infinity;
      (world.sites ?? []).forEach((s, k) => {
        const id = Math.round(s.time * 1000);
        if (this.visited.has(id) || time - s.time > PROGRAMS.scavenger.fresh || s.time <= bt) return;
        if (Math.hypot(wrapDelta(s.x - x), wrapDelta(s.z - z)) > PROGRAMS.scavenger.reach) return;
        best = k; bt = s.time;
      });
      if (best >= 0) { const s = world.sites![best]; g.site = Math.round(s.time * 1000); g.goal = { x: x + wrapDelta(s.x - x), z: z + wrapDelta(s.z - z) }; }
    }
    // Far from home with nothing to do: head back.
    let goal = g.goal;
    if (!goal && Math.hypot(x - cornerX(g.post), z - cornerZ(g.post)) > 900) goal = { x: cornerX(g.post), z: cornerZ(g.post) };
    const moves = cornerMoves(g.at, world.closed);
    if (!moves.length) { g.activity = 'pause'; g.until = time + 4; return; }
    let pick = moves[0];
    if (goal) {
      // Greedy toward the goal, never straight back the way it came.
      let bd = Infinity;
      for (const m of moves) {
        if (moves.length > 1 && sameCorner(g.last, m.to)) continue;
        const d = Math.hypot(cornerX(m.to) - goal.x, cornerZ(m.to) - goal.z) + (m.cross ? 2 : 0) + g.rand() * 6;
        if (d < bd) { bd = d; pick = m; }
      }
    } else {
      const team = typeof g.side === 'number' && g.side !== FREELANCER ? (g.side as Team) : null;
      const weights = moves.map((m) => {
        let wgt = m.cross ? 0.5 : 1;
        if (sameCorner(g.last, m.to)) wgt *= 0.1;
        if (team !== null && world.owner(wrapCoord(cornerX(m.to)), wrapCoord(cornerZ(m.to))) !== team) wgt *= 0.12;
        return wgt;
      });
      let r = g.rand() * weights.reduce((a, b) => a + b, 0);
      for (let k = 0; k < moves.length; k++) { r -= weights[k]; if (r <= 0) { pick = moves[k]; break; } }
    }
    g.to = pick.to;
    g.along = 0;
    g.len = Math.hypot(cornerX(pick.to) - x, cornerZ(pick.to) - z);
    g.activity = 'walk';
  }

  /**
   * A sentinel patrol and the player on foot: a stranger close by is warned and, if they keep
   * coming, derezzed; a Red player is saluted. True if it fired at the player.
   */
  private guard(g: ProgramGroup, w: { x: number; y: number; z: number }, team: Team, dt: number, time: number, hostile: boolean): boolean {
    const S = PROGRAMS.sentinel;
    let near: Program | null = null, nd = Infinity;
    for (const p of g.members) { const d = Math.hypot(p.x - w.x, p.z - w.z); if (d < nd) { nd = d; near = p; } }
    if (!near) return false;
    if (team === 1) {
      if (nd < S.salute && time - g.saluted > 20) {
        g.saluted = time;
        for (const p of g.members) { p.answer = 'yes'; p.answeredAt = time + p.k * 0.25; }
      }
      return false;
    }
    if (g.activity !== 'alert') {
      if (nd > S.warn) return false;
      g.activity = 'alert';
      g.aim = 0;
      g.until = time;
      for (const p of g.members) { p.answer = 'no'; p.answeredAt = time + p.k * 0.2; }
    }
    for (const p of g.members) p.yaw = Math.atan2(w.x - p.x, -(w.z - p.z));
    if (nd > S.calm) {
      // Gone: back to the beat after a few seconds.
      if (time - g.until > 4) { g.activity = g.to ? 'walk' : 'pause'; g.until = time + 2; }
      return false;
    }
    g.until = time;
    if (!hostile) { g.aim = 0; return false; } // at peace: a warning, nothing more
    if (nd < S.fire) g.aim += dt;
    if (g.aim < S.aim) return false;
    g.aim = 0;
    this.shots.push({ x: near.x, y: near.y + PROGRAM_KINDS.sentinel.height * 0.85, z: near.z, tx: w.x, ty: w.y + 0.9, tz: w.z, time });
    return true;
  }
}
