import RAPIER from '@dimforge/rapier3d-compat';
import { BIT, bitState, type BitAnswer, type BitState } from '../people/bit.ts';
import { mulberry32 } from '../world/City.ts';
import { GRID } from '../world/planetCity.ts';
import { CITY, hash01, isSea, PLANET, wrapCoord } from './layout.ts';
import { terrainHeight } from './terrain.ts';
import { roadBlock } from './traffic.ts';

/**
 * Bits are the people of the digital world, not vehicles. They live on a block and walk the
 * kerb around it, each at its own pace; they stop and stand a while, turn back, and when two
 * meet they stop to talk: one asks, the other answers YES or NO, and they go their ways. They
 * step back from the road and say NO when a vehicle comes past fast, they answer the player's
 * Bit when it speaks to them, and one that is run over derezzes.
 *
 * Kinematic and deterministic: who lives on a block is a pure function of the block, and each
 * Bit carries its own seeded stream. Streamed in a disc around whoever the player is (on foot
 * or in a vehicle), wrap-aware like the traffic. No three.js scene objects, no DOM.
 */
export const BITS = {
  /** Streamed disc around the player (m) and the distance a block's people are dropped at. */
  radius: 420,
  despawn: 500,
  /** People per block: 0..perBlock, fewer away from a downtown hub. */
  perBlock: 6,
  max: 220,
  /** The kerb line: this far outside the block's edge (m), on the margin of the street. */
  kerb: 0.8,
  /** Walking pace range (m/s). */
  pace: [1.4, 3.4] as const,
  /** Two Bits this close along the kerb stop to talk (m), for this long (s). */
  talkRange: 2.6,
  talkTime: 3.2,
  /** After talking (or being scared) a Bit keeps to itself this long (s). */
  cooldown: 9,
  /** A vehicle faster than scareSpeed (m/s) within scareRange (m) makes them step back and say NO. */
  scareRange: 16,
  scareSpeed: 7,
  /** Within this of a moving vehicle's centre (m), a Bit is run over. */
  hitRange: 1.7,
  /** They hear the player's Bit from this far (m). */
  earshot: 9,
} as const;

const P = CITY.block + CITY.street;
const N = GRID.blocks;
const C = PLANET.circumference;
const mod = (a: number, n: number) => ((a % n) + n) % n;
/** Side of the kerb square around a block, and its perimeter. */
const SIDE = CITY.block + 2 * BITS.kerb;
const LOOP = 4 * SIDE;

export type BitMood = 'walk' | 'stand' | 'talk' | 'scared';

export interface BitPerson {
  id: number;
  /** Home block (unbounded grid indices, in the image of the planet nearest the player). */
  gi: number;
  gj: number;
  /** Which of the block's people this is. */
  slot: number;
  /** Distance along the kerb loop (m, 0..LOOP), walking direction and pace. */
  s: number;
  dir: 1 | -1;
  pace: number;
  /** Step back from the kerb, away from the street (m): eased toward `backTo`. */
  back: number;
  backTo: number;
  mood: BitMood;
  /** When the current mood ends (s). */
  until: number;
  /** No talking or scaring before this (s). */
  quietUntil: number;
  /** What it last said, and when (drives the figure it shows). */
  answer: BitAnswer | null;
  answeredAt: number;
  /** Something it has decided to say at a later moment. */
  pending: { answer: BitAnswer; at: number } | null;
  /** Offset of its idle beat, so a street of Bits does not pulse in step (s). */
  beat: number;
  /** World pose: position (centre of the figure) and where it faces. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Its own stream of chance. */
  rand: () => number;
}

/** A vehicle the people watch out for. */
export interface BitThreat {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
}

const blockKey = (gi: number, gj: number) => mod(gi, N) * N + mod(gj, N);

/** How many Bits live on a block (0..perBlock): more toward the downtown hubs, none off the streets. */
export function blockPopulation(gi: number, gj: number): number {
  if (!roadBlock(gi, gj)) return 0;
  const cx = GRID.x0 + (gi + 0.5) * P, cz = GRID.z0 + (gj + 0.5) * P;
  if (isSea(wrapCoord(cx))) return 0;
  let urban = 0.5;
  for (const h of CITY.hubs) {
    const d = Math.hypot(wrapDelta(cx - h.x), wrapDelta(cz - h.z));
    urban = Math.max(urban, 1 - d / (h.r * 1.5));
  }
  return Math.floor(hash01(mod(gi, N), mod(gj, N), 71) * (BITS.perBlock + 1) * Math.min(1, urban + 0.15));
}

function wrapDelta(d: number): number {
  return d - Math.round(d / C) * C;
}

/** Point on a block's kerb loop at distance s, stepped `back` toward the block; and the way along it. */
function kerbPoint(gi: number, gj: number, s: number, back: number, out: { x: number; z: number; tx: number; tz: number }): void {
  const cx = GRID.x0 + (gi + 0.5) * P, cz = GRID.z0 + (gj + 0.5) * P;
  const h = SIDE / 2 - back;
  const side = Math.min(3, Math.floor(s / SIDE));
  const u = (s - side * SIDE) / SIDE * 2 - 1; // -1..1 along the side
  const a = u * (SIDE / 2);
  // Clockwise seen from above (+X east, +Z south): north side eastward, east side southward, ...
  if (side === 0) { out.x = cx + a; out.z = cz - h; out.tx = 1; out.tz = 0; }
  else if (side === 1) { out.x = cx + h; out.z = cz + a; out.tx = 0; out.tz = 1; }
  else if (side === 2) { out.x = cx - a; out.z = cz + h; out.tx = -1; out.tz = 0; }
  else { out.x = cx - h; out.z = cz - a; out.tx = 0; out.tz = -1; }
}

const _k = { x: 0, z: 0, tx: 0, tz: 0 };

export class BitPopulation {
  readonly people: BitPerson[] = [];
  /** Stream and step the people at all (tests and tools can switch it off). */
  enabled = true;
  /** Bits run over so far. */
  derezzed = 0;
  /** Where each Bit derezzed this step: drained by the simulation (chips). */
  readonly derezEvents: Array<{ x: number; y: number; z: number; time: number }> = [];
  /** Conversations held so far. */
  talks = 0;
  private nextId = 1;
  private readonly blocks = new Map<number, { gi: number; gj: number; gone: Set<number> }>();
  private lastManage: { x: number; z: number } | null = null;
  private manageAt = -Infinity;

  reset(): void {
    this.people.length = 0;
    this.blocks.clear();
    this.derezEvents.length = 0;
    this.lastManage = null;
    this.manageAt = -Infinity;
    this.derezzed = 0;
    this.talks = 0;
  }

  /** The figure a Bit shows at `time`. */
  stateOf(p: BitPerson, time: number): BitState {
    return bitState(time + p.beat, p.answer, p.answeredAt + p.beat);
  }

  /** Put the people of one block on its kerb (deterministic for the block). */
  private populate(gi: number, gj: number, gone: Set<number>, time: number): void {
    const n = blockPopulation(gi, gj);
    for (let slot = 0; slot < n && this.people.length < BITS.max; slot++) {
      if (gone.has(slot)) continue;
      const seed = (blockKey(gi, gj) * 8 + slot) * 2654435761;
      const rand = mulberry32(seed | 0);
      const p: BitPerson = {
        id: this.nextId++, gi, gj, slot,
        s: rand() * LOOP,
        dir: rand() < 0.5 ? 1 : -1,
        pace: BITS.pace[0] + rand() * (BITS.pace[1] - BITS.pace[0]),
        back: 0, backTo: 0,
        mood: 'walk', until: time + 4 + rand() * 20, quietUntil: time + rand() * 4,
        answer: null, answeredAt: -Infinity, pending: null,
        beat: rand() * 10,
        x: 0, y: 0, z: 0, yaw: 0,
        rand,
      };
      this.place(p);
      this.people.push(p);
    }
  }

  private place(p: BitPerson): void {
    kerbPoint(p.gi, p.gj, p.s, p.back, _k);
    p.x = _k.x;
    p.z = _k.z;
    p.y = terrainHeight(wrapCoord(p.x), wrapCoord(p.z)) + BIT.hover;
    if (p.mood === 'walk') p.yaw = Math.atan2(_k.tx * p.dir, -_k.tz * p.dir);
  }

  /** Fill the blocks near the player and drop the far ones. */
  private manage(cx: number, cz: number, time: number): void {
    const gi0 = Math.floor((cx - GRID.x0) / P), gj0 = Math.floor((cz - GRID.z0) / P);
    const ring = Math.ceil(BITS.radius / P);
    const seen = new Set<number>();
    for (let dj = -ring; dj <= ring; dj++) for (let di = -ring; di <= ring; di++) {
      const gi = gi0 + di, gj = gj0 + dj;
      const bx = GRID.x0 + (gi + 0.5) * P, bz = GRID.z0 + (gj + 0.5) * P;
      if (Math.hypot(bx - cx, bz - cz) > BITS.radius) continue;
      const key = blockKey(gi, gj);
      seen.add(key);
      const b = this.blocks.get(key);
      if (b) {
        if (b.gi !== gi || b.gj !== gj) {
          // The player crossed a wrap edge: carry the block's people into the nearer image.
          for (const p of this.people) if (p.gi === b.gi && p.gj === b.gj) { p.gi = gi; p.gj = gj; this.place(p); }
          b.gi = gi; b.gj = gj;
        }
        continue;
      }
      const made = { gi, gj, gone: new Set<number>() };
      this.blocks.set(key, made);
      this.populate(gi, gj, made.gone, time);
    }
    for (const [key, b] of this.blocks) {
      if (seen.has(key)) continue;
      const bx = GRID.x0 + (b.gi + 0.5) * P, bz = GRID.z0 + (b.gj + 0.5) * P;
      if (Math.hypot(wrapDelta(bx - cx), wrapDelta(bz - cz)) < BITS.despawn) continue;
      this.blocks.delete(key);
      for (let i = this.people.length - 1; i >= 0; i--) if (this.people[i].gi === b.gi && this.people[i].gj === b.gj) this.people.splice(i, 1);
    }
  }

  private say(p: BitPerson, answer: BitAnswer, time: number): void {
    p.answer = answer;
    p.answeredAt = time;
  }

  /**
   * The player's Bit spoke at (x, z): the people in earshot turn to it and answer, each in its
   * own time and with its own mind. Returns how many heard.
   */
  hear(x: number, z: number, time: number): number {
    let n = 0;
    for (const p of this.people) {
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz > BITS.earshot * BITS.earshot || p.mood === 'scared') continue;
      p.mood = 'talk';
      p.until = time + BITS.talkTime;
      p.quietUntil = p.until + 2;
      p.yaw = Math.atan2(-dx, dz);
      p.pending = { answer: p.rand() < 0.5 ? 'yes' : 'no', at: time + 0.5 + p.rand() * 0.7 };
      n++;
    }
    return n;
  }

  /** Something frightening at (x, z) (an explosion, gunfire): everyone within `range` says NO and backs away. */
  scare(x: number, z: number, range: number, time: number): void {
    for (const p of this.people) {
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz < range * range) this.frighten(p, time);
    }
  }

  private frighten(p: BitPerson, time: number): void {
    if (p.mood !== 'scared') this.say(p, 'no', time);
    p.mood = 'scared';
    p.backTo = 2.6;
    p.until = time + 2.2;
    p.quietUntil = p.until + 1;
    p.pending = null;
  }

  /**
   * Advance the people by dt. `centre` is whoever the player is; `threats` are the vehicles they
   * watch for (the player's craft, when it is down among them).
   */
  step(dt: number, time: number, centre: { x: number; z: number }, threats: readonly BitThreat[] = []): void {
    if (!this.enabled) return;
    const lm = this.lastManage;
    if (!lm || time - this.manageAt > 1 || Math.hypot(centre.x - lm.x, centre.z - lm.z) > 40) {
      this.manage(centre.x, centre.z, time);
      this.lastManage = { x: centre.x, z: centre.z };
      this.manageAt = time;
    }
    const people = this.people;
    for (let i = people.length - 1; i >= 0; i--) {
      const p = people[i];
      // Vehicles: run over, or frightened off the kerb.
      let hit = false;
      for (const t of threats) {
        const dx = p.x - t.x, dz = p.z - t.z;
        const d2 = dx * dx + dz * dz, speed = Math.hypot(t.vx, t.vz);
        if (Math.abs(t.y - p.y) > 6) continue;
        if (d2 < BITS.hitRange * BITS.hitRange && speed > 2) { hit = true; break; }
        // Coming this way, fast: closing speed along the line to the Bit.
        if (d2 < BITS.scareRange * BITS.scareRange && speed > BITS.scareSpeed && t.vx * dx + t.vz * dz > 0) this.frighten(p, time);
      }
      if (hit) {
        this.derezzed++;
        this.derezEvents.push({ x: p.x, y: p.y, z: p.z, time });
        if (this.derezEvents.length > 32) this.derezEvents.shift();
        this.blocks.get(blockKey(p.gi, p.gj))?.gone.add(p.slot);
        people.splice(i, 1);
        continue;
      }
      if (p.pending && time >= p.pending.at) {
        this.say(p, p.pending.answer, time);
        p.pending = null;
      }
      if (p.mood === 'walk') {
        p.s = mod(p.s + p.dir * p.pace * dt, LOOP);
        if (time >= p.until) {
          // Stand a while, turn back the way it came, or go and find a neighbour to talk to.
          const r = p.rand();
          if (r < 0.45) { p.mood = 'stand'; p.until = time + 1.5 + p.rand() * 5; }
          else if (r < 0.65) { p.dir = -p.dir as 1 | -1; p.until = time + 6 + p.rand() * 20; }
          else {
            let gap = Infinity;
            for (const q of people) {
              if (q === p || q.gi !== p.gi || q.gj !== p.gj) continue;
              const ahead = mod(q.s - p.s, LOOP); // the way round the loop to q, going forward
              const d = Math.min(ahead, LOOP - ahead);
              if (d < gap) { gap = d; p.dir = ahead <= LOOP / 2 ? 1 : -1; }
            }
            p.until = time + (gap < Infinity ? Math.min(60, gap / p.pace + 3) : 6 + p.rand() * 20);
          }
        }
      } else if (time >= p.until) {
        p.mood = 'walk';
        p.backTo = 0;
        p.until = time + 6 + p.rand() * 24;
      }
      p.back += (p.backTo - p.back) * Math.min(1, dt * 5);
      this.place(p);
    }
    // Meetings: two of a block's people close together on the kerb stop to talk.
    for (let i = 0; i < people.length; i++) {
      const a = people[i];
      if (a.mood === 'talk' || a.mood === 'scared' || time < a.quietUntil) continue;
      for (let j = i + 1; j < people.length; j++) {
        const b = people[j];
        if (b.gi !== a.gi || b.gj !== a.gj || b.mood === 'talk' || b.mood === 'scared' || time < b.quietUntil) continue;
        const dx = a.x - b.x, dz = a.z - b.z;
        if (dx * dx + dz * dz > BITS.talkRange * BITS.talkRange) continue;
        this.talks++;
        for (const [p, q] of [[a, b], [b, a]] as const) {
          p.mood = 'talk';
          p.until = time + BITS.talkTime;
          p.quietUntil = p.until + BITS.cooldown;
          p.yaw = Math.atan2(q.x - p.x, -(q.z - p.z));
        }
        // b answers a's question; sometimes a has something to say back.
        b.pending = { answer: b.rand() < 0.5 ? 'yes' : 'no', at: time + 0.8 };
        if (a.rand() < 0.5) a.pending = { answer: a.rand() < 0.5 ? 'yes' : 'no', at: time + 1.9 };
        break;
      }
    }
  }
}

/**
 * The player as a Bit, on foot: out of its vehicle and walking where it likes. It glides over
 * the ground at a walking pace, turns where it stands, sidesteps, climbs kerbs and low steps,
 * and is stopped by walls. Kinematic: rays against the physics world, no body of its own.
 */
export const ON_FOOT = {
  speed: 7,
  backSpeed: 4,
  sideSpeed: 4,
  /** Turn rate (rad/s) and how quickly it reaches its pace (1/s). */
  turn: 2.6,
  accel: 8,
  /** Its girth for walls (m) and the highest step it climbs (m). */
  radius: 0.7,
  step: 0.6,
  /** It may leave a vehicle slower than this (m/s) and board one within reach (m). */
  exitSpeed: 3,
  reach: 9,
} as const;

export interface WalkInput {
  /** -1..1: forward (+) or back. */
  forward: number;
  /** -1..1: turn right (+) or left. */
  turn: number;
  /** -1..1: sidestep right (+) or left. */
  strafe: number;
}

export class BitWalker {
  /** On foot at all (false: the player is in its vehicle). */
  active = false;
  /** Feet: the ground point under the figure. */
  x = 0;
  y = 0;
  z = 0;
  /** Heading as a rotation about +Y (0 faces -Z). */
  yaw = 0;
  vx = 0;
  vz = 0;
  prevX = 0;
  prevY = 0;
  prevZ = 0;
  prevYaw = 0;
  answer: BitAnswer | null = null;
  answeredAt = -Infinity;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  /** Step out at (x, z), facing `yaw`. */
  exit(x: number, y: number, z: number, yaw: number): void {
    this.active = true;
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    this.z = this.prevZ = z;
    this.yaw = this.prevYaw = yaw;
    this.vx = this.vz = 0;
    this.answer = null;
  }

  board(): void {
    this.active = false;
  }

  say(answer: BitAnswer, time: number): boolean {
    if (this.answer === answer && time - this.answeredAt < BIT.answerTime) return false; // a held key is one answer
    this.answer = answer;
    this.answeredAt = time;
    return true;
  }

  state(time: number): BitState {
    return bitState(time, this.answer, this.answeredAt);
  }

  /** The floor under (x, z), looking down from `fromY`: the highest thing within reach, else the terrain. */
  private floor(world: RAPIER.World, x: number, z: number, fromY: number, ground: number, skip?: RAPIER.RigidBody): number {
    this.ray.origin.x = x; this.ray.origin.y = fromY; this.ray.origin.z = z;
    this.ray.dir.x = 0; this.ray.dir.y = -1; this.ray.dir.z = 0;
    const hit = world.castRay(this.ray, Math.max(0.1, fromY - ground), true, undefined, undefined, undefined, skip);
    return hit ? Math.max(ground, fromY - hit.timeOfImpact) : ground;
  }

  /**
   * Walk for dt. `ground(x, z)` is the terrain height; `skip` is a body it passes through (its
   * own parked vehicle, so it can get back to the door).
   */
  step(dt: number, input: WalkInput, world: RAPIER.World, ground: (x: number, z: number) => number, skip?: RAPIER.RigidBody): void {
    if (!this.active) return;
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z; this.prevYaw = this.yaw;
    this.yaw -= input.turn * ON_FOOT.turn * dt;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw); // forward
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw); // right
    const f = input.forward * (input.forward > 0 ? ON_FOOT.speed : ON_FOOT.backSpeed);
    const s = input.strafe * ON_FOOT.sideSpeed;
    const k = Math.min(1, ON_FOOT.accel * dt);
    this.vx += (fx * f + rx * s - this.vx) * k;
    this.vz += (fz * f + rz * s - this.vz) * k;
    let dx = this.vx * dt, dz = this.vz * dt;
    const dist = Math.hypot(dx, dz);
    if (dist > 1e-6) {
      // Walls: a ray at chest height along the way it is going; slide along what it meets.
      const ux = dx / dist, uz = dz / dist;
      this.ray.origin.x = this.x; this.ray.origin.y = this.y + ON_FOOT.step + 0.3; this.ray.origin.z = this.z;
      this.ray.dir.x = ux; this.ray.dir.y = 0; this.ray.dir.z = uz;
      const hit = world.castRayAndGetNormal(this.ray, dist + ON_FOOT.radius, true, undefined, undefined, undefined, skip);
      if (hit) {
        const allow = Math.max(0, hit.timeOfImpact - ON_FOOT.radius);
        let nx = hit.normal.x, nz = hit.normal.z;
        const nl = Math.hypot(nx, nz);
        if (nl > 1e-3) { nx /= nl; nz /= nl; } else { nx = -ux; nz = -uz; }
        // Up to the wall, then what is left of the step along it.
        const rest = dist - allow;
        const tx = ux - (ux * nx + uz * nz) * nx, tz = uz - (ux * nx + uz * nz) * nz;
        dx = ux * allow + tx * rest;
        dz = uz * allow + tz * rest;
        const into = this.vx * nx + this.vz * nz;
        if (into < 0) { this.vx -= into * nx; this.vz -= into * nz; }
      }
    }
    const nx = this.x + dx, nz = this.z + dz;
    const g = ground(nx, nz);
    const top = this.floor(world, nx, nz, this.y + ON_FOOT.step, g, skip);
    // It climbs what is within a step and never sinks through the ground; a drop it glides down.
    this.x = nx;
    this.z = nz;
    const target = Math.max(g, top);
    this.y = target > this.y ? target : Math.max(target, this.y - 12 * dt);
  }
}
