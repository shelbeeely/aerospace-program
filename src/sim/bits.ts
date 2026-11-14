import RAPIER from '@dimforge/rapier3d-compat';
import { BIT, bitState, type BitAnswer, type BitState } from '../people/bit.ts';
import { mulberry32 } from '../world/City.ts';
import { GRID } from '../world/planetCity.ts';
import { CITY, hash01, isSea, PLANET, wrapCoord } from './layout.ts';
import { terrainHeight } from './terrain.ts';
import { roadBlock } from './traffic.ts';
import { districtPlan, lotAt, type Lot } from '../arch/DistrictGenerator.ts';
import { structureRoom, type Room, type RoomDoor } from '../arch/InteriorGenerator.ts';
import { kitRoomAt } from '../world/kit.ts';
import { kitRoomId } from '../world/structures.ts';

/**
 * Bits are the people of the digital world, not vehicles. They live on a lot: in its building
 * when it has an interior (most of their time is spent indoors, standing at their places down
 * the aisles), and on the kerb around it, which they walk at their own pace. They stop and
 * stand a while, turn back, go in by a door and come out again, and when two meet they stop to
 * talk: one asks, the other answers YES or NO, and they go their ways. They step back from the
 * road and say NO when a vehicle comes past fast, they answer the player's Bit when it speaks
 * to them, and one that is run over derezzes.
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
/** Share of a building's people who are indoors when its lot streams in. */
const INDOORS = 0.6;

export type BitMood = 'walk' | 'stand' | 'talk' | 'scared';

/** A lot and what its people need to know about it, in the image of the planet nearest the player. */
export interface BitHome {
  key: number;
  /** Origin block of the lot (unbounded indices). */
  gi: number;
  gj: number;
  /** The kerb line round the lot (m) and its length. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  loop: number;
  /** The building's interior, when it has one the people can use. */
  room: Room | null;
  /** The building has been wrecked: its room is no longer a place to go. */
  ruined: boolean;
  /** People of this lot who have derezzed (they stay gone while the lot is in view). */
  gone: Set<number>;
}

interface Waypoint {
  x: number;
  z: number;
}

export interface BitPerson {
  id: number;
  home: BitHome;
  /** Which of the lot's people this is. */
  slot: number;
  /** Where it is: on the kerb, on its way through a door, or indoors. */
  place: 'kerb' | 'way' | 'inside';
  /** Distance along the kerb loop (m), walking direction and pace. */
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
  /** The door it is heading for (or came in by), and where on the kerb that door lets out. */
  door: RoomDoor | null;
  doorS: number;
  /** The way it is walking now (through a door), and what it does at the end of it. */
  path: Waypoint[];
  then: 'inside' | 'spot' | 'kerb';
  /** Indoors: when it next moves to another place in the room (s). */
  shiftAt: number;
  /** Indoors: when it will leave (s). */
  stayUntil: number;
  /** What it last said, and when (drives the figure it shows). */
  answer: BitAnswer | null;
  answeredAt: number;
  /** Something it has decided to say at a later moment. */
  pending: { answer: BitAnswer; at: number } | null;
  /** Running for its life (out of a collapsing building): it does not stop to talk. */
  hurry: boolean;
  /** Offset of its idle beat, so a street of Bits does not pulse in step (s). */
  beat: number;
  /** World pose: position (centre of the figure) and where it faces. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Its own stream of chance. */
  rand: () => number;
  /** Where the ground was last sampled under it, and its height there (sampling terrain is not free). */
  gx: number;
  gz: number;
  gh: number;
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

/** How many Bits a block adds to its lot (0..perBlock): more toward the downtown hubs, none off the streets. */
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

/** How many Bits live on a lot: what its blocks add up to. */
export function lotPopulation(lot: Lot): number {
  let n = 0;
  for (let a = 0; a < lot.wb; a++) for (let b = 0; b < lot.db; b++) n += blockPopulation(lot.gi + a, lot.gj + b);
  return Math.min(n, 3 * BITS.perBlock);
}

/** The interior of a lot's building as its people use it (canonical coordinates), if it has one. */
export function lotRoom(lot: Lot): Room | null {
  if (lot.kind === 'kit' && lot.kit) {
    // A kit tower: the room cut into its ground floor at import.
    const cx = (lot.rect.x0 + lot.rect.x1) / 2, cz = (lot.rect.z0 + lot.rect.z1) / 2;
    const r = kitRoomAt(lot.kit.type, lot.kit.rot, lot.kit.scale, cx, cz);
    if (!r) return null;
    return {
      id: kitRoomId(cx, cz), program: 'commons', y: 0, x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1,
      doors: r.doors.map((d) => ({
        x: d.x, z: d.z, nx: d.nx, nz: d.nz, width: d.width, height: d.height, inset: d.through / 2, rise: 0, floor: [],
        // Clear all the way across: a kit room has no furniture.
        depth: d.through / 2 + (Math.abs(d.nx) > 0.5 ? r.x1 - r.x0 : r.z1 - r.z0) - 1,
      })),
    };
  }
  if (lot.kind !== 'structure' && lot.kind !== 'landmark') return null;
  const plan = districtPlan(Math.floor(mod(lot.gi, N) / GRID.chunkBlocks), Math.floor(mod(lot.gj, N) / GRID.chunkBlocks));
  const i = plan.lots.findIndex((l) => l.gi === lot.gi && l.gj === lot.gj);
  return i < 0 ? null : structureRoom(plan.structures[i]);
}

function wrapDelta(d: number): number {
  return d - Math.round(d / C) * C;
}

/** Point on a home's kerb loop at distance s, stepped `back` toward the lot; and the way along it. */
function kerbPoint(h: BitHome, s: number, back: number, out: { x: number; z: number; tx: number; tz: number }): void {
  const wx = h.x1 - h.x0, wz = h.z1 - h.z0;
  // Clockwise seen from above (+X east, +Z south): north side eastward, east side southward, ...
  if (s < wx) { out.x = h.x0 + s; out.z = h.z0 + back; out.tx = 1; out.tz = 0; }
  else if (s < wx + wz) { out.x = h.x1 - back; out.z = h.z0 + (s - wx); out.tx = 0; out.tz = 1; }
  else if (s < 2 * wx + wz) { out.x = h.x1 - (s - wx - wz); out.z = h.z1 - back; out.tx = -1; out.tz = 0; }
  else { out.x = h.x0 + back; out.z = h.z1 - (s - 2 * wx - wz); out.tx = 0; out.tz = -1; }
}

/** Where on a home's kerb loop a door lets out: straight out from the door to the kerb. */
function doorKerb(h: BitHome, d: RoomDoor): number {
  const wx = h.x1 - h.x0, wz = h.z1 - h.z0;
  const cx = Math.max(h.x0, Math.min(h.x1, d.x)), cz = Math.max(h.z0, Math.min(h.z1, d.z));
  if (d.nz < -0.5) return cx - h.x0;
  if (d.nx > 0.5) return wx + (cz - h.z0);
  if (d.nz > 0.5) return wx + wz + (h.x1 - cx);
  return 2 * wx + wz + (h.z1 - cz);
}

/** A place to stand down the aisle behind a door. */
function spotBehind(d: RoomDoor, rand: () => number): Waypoint {
  const t0 = d.inset + 1.5;
  const t = t0 + rand() * Math.max(0, d.depth - t0);
  const side = (rand() - 0.5) * Math.max(0, d.width - 2.6);
  return { x: d.x - d.nx * t - d.nz * side, z: d.z - d.nz * t + d.nx * side };
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
  /** Conversations held so far, and times a Bit has gone in or come out by a door. */
  talks = 0;
  entries = 0;
  exits = 0;
  private nextId = 1;
  readonly homes = new Map<number, BitHome>();
  private lastManage: { x: number; z: number } | null = null;
  private manageAt = -Infinity;

  reset(): void {
    this.people.length = 0;
    this.homes.clear();
    this.derezEvents.length = 0;
    this.lastManage = null;
    this.manageAt = -Infinity;
    this.derezzed = 0;
    this.talks = 0;
    this.entries = 0;
    this.exits = 0;
  }

  /** The figure a Bit shows at `time`. */
  stateOf(p: BitPerson, time: number): BitState {
    return bitState(time + p.beat, p.answer, p.answeredAt + p.beat);
  }

  /** How many are indoors now. */
  get indoors(): number {
    let n = 0;
    for (const p of this.people) if (p.place === 'inside') n++;
    return n;
  }

  /** Put the people of one lot in its building and on its kerb (deterministic for the lot). */
  private populate(h: BitHome, lot: Lot, time: number): void {
    const n = lotPopulation(lot);
    for (let slot = 0; slot < n && this.people.length < BITS.max; slot++) {
      if (h.gone.has(slot)) continue;
      const seed = (h.key * 32 + slot) * 2654435761;
      const rand = mulberry32(seed | 0);
      const p: BitPerson = {
        id: this.nextId++, home: h, slot, place: 'kerb',
        s: rand() * h.loop,
        dir: rand() < 0.5 ? 1 : -1,
        pace: BITS.pace[0] + rand() * (BITS.pace[1] - BITS.pace[0]),
        back: 0, backTo: 0,
        mood: 'walk', until: time + 4 + rand() * 20, quietUntil: time + rand() * 4,
        door: null, doorS: 0, path: [], then: 'kerb', shiftAt: 0, stayUntil: 0,
        answer: null, answeredAt: -Infinity, pending: null, hurry: false,
        beat: rand() * 10,
        x: 0, y: 0, z: 0, yaw: 0,
        rand, gx: Infinity, gz: Infinity, gh: 0,
      };
      const indoors = rand() < INDOORS;
      if (h.room && !h.ruined && indoors) {
        // At home when the lot streams in: standing at its place down an aisle.
        const d = h.room.doors[Math.floor(rand() * h.room.doors.length)];
        const spot = spotBehind(d, rand);
        p.place = 'inside';
        p.mood = 'stand';
        p.door = d;
        p.doorS = doorKerb(h, d);
        p.x = spot.x;
        p.z = spot.z;
        p.yaw = rand() * Math.PI * 2;
        p.stayUntil = p.until = time + 20 + rand() * 160;
        p.shiftAt = time + 3 + rand() * 12;
      }
      this.place(p);
      this.people.push(p);
    }
  }

  /** Ground height under a Bit, sampled afresh only once it has moved a couple of metres. */
  private ground(p: BitPerson): number {
    if (Math.abs(p.x - p.gx) + Math.abs(p.z - p.gz) > 2) {
      p.gx = p.x;
      p.gz = p.z;
      p.gh = terrainHeight(wrapCoord(p.x), wrapCoord(p.z));
    }
    return p.gh;
  }

  private place(p: BitPerson): void {
    if (p.place === 'way' && p.door && p.door.rise > 0.3) {
      // On the steps outside a raised door: it glides up to the threshold as it nears the wall.
      const d = p.door;
      const out = (p.x - d.x) * d.nx + (p.z - d.z) * d.nz;
      const ground = this.ground(p);
      // Over whatever is underfoot there (ledge, step or ground), taking the higher of the two
      // samples it is between so it never dips into a riser.
      const i = Math.floor(Math.max(0, out) * 2);
      const f = out <= 0.5 ? d.rise : Math.max(d.floor[i - 1] ?? 0, d.floor[i] ?? 0, d.floor[i + 1] ?? 0);
      p.y = ground + f + BIT.hover;
      return;
    }
    if (p.place === 'kerb') {
      kerbPoint(p.home, p.s, p.back, _k);
      p.x = _k.x;
      p.z = _k.z;
      if (p.mood === 'walk') p.yaw = Math.atan2(_k.tx * p.dir, -_k.tz * p.dir);
    }
    const r = p.home.room;
    p.y = r && p.x > r.x0 - 0.5 && p.x < r.x1 + 0.5 && p.z > r.z0 - 0.5 && p.z < r.z1 + 0.5 ? r.y + BIT.hover : this.ground(p) + BIT.hover;
  }

  /** Make the home for the lot whose origin block is (gi, gj) in this image, or null if nobody lives there. */
  private home(gi: number, gj: number, lot: Lot): BitHome | null {
    if (lotPopulation(lot) === 0) return null;
    // The lot's rectangle is canonical: carry it into the image this block is in.
    const sx = Math.floor(gi / N) * C, sz = Math.floor(gj / N) * C;
    const k = BITS.kerb;
    const x0 = lot.rect.x0 + sx - k, x1 = lot.rect.x1 + sx + k, z0 = lot.rect.z0 + sz - k, z1 = lot.rect.z1 + sz + k;
    const canon = lotRoom(lot);
    const room: Room | null = canon && {
      ...canon, x0: canon.x0 + sx, x1: canon.x1 + sx, z0: canon.z0 + sz, z1: canon.z1 + sz,
      doors: canon.doors.map((d) => ({ ...d, x: d.x + sx, z: d.z + sz })),
      ...(canon.round ? { round: { ...canon.round, x: canon.round.x + sx, z: canon.round.z + sz } } : {}),
    };
    return { key: blockKey(gi, gj), gi, gj, x0, x1, z0, z1, loop: 2 * (x1 - x0 + z1 - z0), room, ruined: false, gone: new Set() };
  }

  /** Fill the lots near the player and drop the far ones. */
  private manage(cx: number, cz: number, time: number): void {
    const gi0 = Math.floor((cx - GRID.x0) / P), gj0 = Math.floor((cz - GRID.z0) / P);
    const ring = Math.ceil(BITS.radius / P) + 3; // a lot spans up to four blocks: reach its origin
    const seen = new Set<number>();
    for (let dj = -ring; dj <= ring; dj++) for (let di = -ring; di <= ring; di++) {
      const gi = gi0 + di, gj = gj0 + dj;
      const lot = lotAt(gi, gj);
      // One home per lot, made at its origin block.
      if (!lot || mod(lot.gi, N) !== mod(gi, N) || mod(lot.gj, N) !== mod(gj, N)) continue;
      const sx = Math.floor(gi / N) * C, sz = Math.floor(gj / N) * C;
      const lx = Math.max(lot.rect.x0 + sx, Math.min(lot.rect.x1 + sx, cx)), lz = Math.max(lot.rect.z0 + sz, Math.min(lot.rect.z1 + sz, cz));
      if (Math.hypot(lx - cx, lz - cz) > BITS.radius) continue;
      const key = blockKey(gi, gj);
      seen.add(key);
      const old = this.homes.get(key);
      if (old) {
        if (old.gi !== gi || old.gj !== gj) {
          // The player crossed a wrap edge: carry the lot and its people into the nearer image.
          const mx = (gi - old.gi) * P, mz = (gj - old.gj) * P;
          old.gi = gi; old.gj = gj;
          old.x0 += mx; old.x1 += mx; old.z0 += mz; old.z1 += mz;
          if (old.room) {
            old.room.x0 += mx; old.room.x1 += mx; old.room.z0 += mz; old.room.z1 += mz;
            for (const d of old.room.doors) { d.x += mx; d.z += mz; }
          }
          for (const p of this.people) if (p.home === old) {
            p.x += mx; p.z += mz;
            for (const w of p.path) { w.x += mx; w.z += mz; }
          }
        }
        continue;
      }
      const h = this.home(gi, gj, lot);
      if (!h) continue;
      this.homes.set(key, h);
      this.populate(h, lot, time);
    }
    for (const [key, h] of this.homes) {
      if (seen.has(key)) continue;
      const lx = Math.max(h.x0, Math.min(h.x1, cx)), lz = Math.max(h.z0, Math.min(h.z1, cz));
      if (Math.hypot(lx - cx, lz - cz) < BITS.despawn) continue;
      this.homes.delete(key);
      for (let i = this.people.length - 1; i >= 0; i--) if (this.people[i].home === h) this.people.splice(i, 1);
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

  /**
   * The building with this room has been wrecked (it fractured). Its people say NO and run:
   * those indoors, or on their way in, make for the door they know and out to the kerb at a
   * run. Nobody goes in again. Returns how many were indoors.
   */
  collapse(roomId: string, time: number): number {
    let n = 0;
    for (const h of this.homes.values()) {
      if (!h.room || h.room.id !== roomId || h.ruined) continue;
      h.ruined = true;
      for (const p of this.people) {
        if (p.home !== h) continue;
        this.say(p, 'no', time);
        if (p.place === 'kerb') { if (p.door) p.door = null; this.frighten(p, time); continue; }
        if (p.place === 'way' && p.then === 'kerb') { p.hurry = true; continue; }
        const d = p.door!;
        n++;
        kerbPoint(h, p.doorS, 0, _k);
        // Already through the door going in, or still outside it: either way, out by the door.
        const outside = (p.x - d.x) * d.nx + (p.z - d.z) * d.nz > 0;
        p.path = outside ? [{ x: _k.x, z: _k.z }] : [{ x: d.x - d.nx * 1.6, z: d.z - d.nz * 1.6 }, { x: d.x + d.nx * 1.6, z: d.z + d.nz * 1.6 }, { x: _k.x, z: _k.z }];
        p.then = 'kerb';
        p.place = 'way';
        p.mood = 'walk';
        p.hurry = true;
        p.pending = null;
      }
    }
    return n;
  }

  /** Something lands or goes off at (x, y, z): every Bit within `r` of it derezzes. Returns how many. */
  strike(x: number, y: number, z: number, r: number, time: number): number {
    let n = 0;
    for (let i = this.people.length - 1; i >= 0; i--) {
      const p = this.people[i];
      const dx = p.x - x, dy = p.y - y, dz = p.z - z;
      if (dx * dx + dy * dy + dz * dz > r * r) continue;
      this.derez(p, i, time);
      n++;
    }
    return n;
  }

  private derez(p: BitPerson, i: number, time: number): void {
    this.derezzed++;
    this.derezEvents.push({ x: p.x, y: p.y, z: p.z, time });
    if (this.derezEvents.length > 32) this.derezEvents.shift();
    p.home.gone.add(p.slot);
    this.people.splice(i, 1);
  }

  private frighten(p: BitPerson, time: number): void {
    if (p.mood !== 'scared') this.say(p, 'no', time);
    p.mood = 'scared';
    if (p.place === 'kerb') p.backTo = 2.6;
    p.until = time + 2.2;
    p.quietUntil = p.until + 1;
    p.pending = null;
  }

  /** Head for a door of its building: round the kerb the short way to where the door lets out. */
  private seekDoor(p: BitPerson, time: number): void {
    const h = p.home;
    const doors = h.room!.doors;
    p.door = doors[Math.floor(p.rand() * doors.length)];
    p.doorS = doorKerb(h, p.door);
    const ahead = mod(p.doorS - p.s, h.loop);
    p.dir = ahead <= h.loop / 2 ? 1 : -1;
    p.until = time + Math.min(ahead, h.loop - ahead) / p.pace + 30;
  }

  /** Walk the current path; true when it is done. */
  private follow(p: BitPerson, dt: number): boolean {
    let left = p.pace * (p.hurry ? 2.5 : 1) * dt;
    while (left > 0 && p.path.length) {
      const w = p.path[0];
      const dx = w.x - p.x, dz = w.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-6) p.yaw = Math.atan2(dx, -dz);
      if (d <= left) { p.x = w.x; p.z = w.z; left -= d; p.path.shift(); }
      else { p.x += (dx / d) * left; p.z += (dz / d) * left; left = 0; }
    }
    return p.path.length === 0;
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
      const h = p.home;
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
        this.derez(p, i, time);
        continue;
      }
      if (p.pending && time >= p.pending.at) {
        this.say(p, p.pending.answer, time);
        p.pending = null;
      }
      if (p.place === 'way') {
        // Through a door: it stops to talk or flinch, otherwise it keeps walking.
        if (p.mood !== 'walk' && (p.hurry || time >= p.until)) p.mood = 'walk';
        if (p.mood === 'walk' && this.follow(p, dt)) {
          if (p.then === 'inside') {
            p.place = 'inside';
            p.mood = 'stand';
            p.stayUntil = p.until = time + 40 + p.rand() * 160;
            p.shiftAt = time + 4 + p.rand() * 14;
            this.entries++;
          } else if (p.then === 'spot') {
            p.place = 'inside';
            p.mood = 'stand';
            p.until = Math.max(p.stayUntil, time + 2);
            p.shiftAt = time + 6 + p.rand() * 18;
          } else {
            p.place = 'kerb';
            p.hurry = false;
            p.s = p.doorS;
            p.door = null;
            p.dir = p.rand() < 0.5 ? 1 : -1;
            p.until = time + 8 + p.rand() * 24;
            this.exits++;
          }
        }
      } else if (p.place === 'inside') {
        if (p.mood === 'stand' && p.door && time >= p.shiftAt && time < p.stayUntil - 4) {
          // Move to another place down the aisle: beside a housemate on the same aisle, if there is one.
          const d = p.door;
          let spot = spotBehind(d, p.rand);
          for (const q of people) {
            if (q === p || q.home !== h || q.place !== 'inside' || q.door !== d) continue;
            const t = Math.max(d.inset + 1.5, Math.min(d.depth, (d.x - q.x) * d.nx + (d.z - q.z) * d.nz + (p.rand() < 0.5 ? 1.8 : -1.8)));
            const side = (p.rand() - 0.5) * Math.max(0, d.width - 2.6);
            spot = { x: d.x - d.nx * t - d.nz * side, z: d.z - d.nz * t + d.nx * side };
            break;
          }
          p.path = [spot];
          p.then = 'spot';
          p.place = 'way';
          p.mood = 'walk';
        } else if (time >= p.until) {
          if (p.mood !== 'stand') { p.mood = 'stand'; p.until = Math.max(p.stayUntil, time + 1); }
          else if (p.door) {
            // Time to go out: back up the aisle, through the door, to the kerb.
            const d = p.door;
            kerbPoint(h, p.doorS, 0, _k);
            p.path = [{ x: d.x - d.nx * 1.6, z: d.z - d.nz * 1.6 }, { x: d.x + d.nx * 1.6, z: d.z + d.nz * 1.6 }, { x: _k.x, z: _k.z }];
            p.then = 'kerb';
            p.place = 'way';
            p.mood = 'walk';
          }
        }
      } else if (p.mood === 'walk') {
        const before = p.s;
        p.s = mod(p.s + p.dir * p.pace * dt, h.loop);
        if (p.door) {
          // Heading for a door: has it reached (or just passed) where the door lets out?
          const was = mod((p.doorS - before) * p.dir, h.loop), now = mod((p.doorS - p.s) * p.dir, h.loop);
          if (was < 1 || now > was) {
            const d = p.door;
            p.s = p.doorS;
            this.place(p);
            const spot = spotBehind(d, p.rand);
            p.path = [{ x: d.x + d.nx * 1.6, z: d.z + d.nz * 1.6 }, { x: d.x - d.nx * 1.6, z: d.z - d.nz * 1.6 }, spot];
            p.then = 'inside';
            p.place = 'way';
          } else if (time >= p.until) p.door = null; // never got there: give up
        } else if (time >= p.until) {
          // Stand a while, turn back the way it came, go home indoors, or go and find a neighbour.
          const r = p.rand();
          if (r < 0.2) { p.mood = 'stand'; p.until = time + 1.5 + p.rand() * 5; }
          else if (r < 0.3) { p.dir = -p.dir as 1 | -1; p.until = time + 6 + p.rand() * 20; }
          else if (r < 0.85 && h.room && !h.ruined) this.seekDoor(p, time);
          else {
            let gap = Infinity;
            for (const q of people) {
              if (q === p || q.home !== h || q.place !== 'kerb') continue;
              const ahead = mod(q.s - p.s, h.loop); // the way round the loop to q, going forward
              const d = Math.min(ahead, h.loop - ahead);
              if (d < gap) { gap = d; p.dir = ahead <= h.loop / 2 ? 1 : -1; }
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
    // Meetings: two of a lot's people close together, both on the kerb or both indoors, stop to talk.
    for (let i = 0; i < people.length; i++) {
      const a = people[i];
      if (a.place === 'way' || a.hurry || a.mood === 'talk' || a.mood === 'scared' || time < a.quietUntil) continue;
      for (let j = i + 1; j < people.length; j++) {
        const b = people[j];
        if (b.home !== a.home || b.place !== a.place || b.mood === 'talk' || b.mood === 'scared' || time < b.quietUntil) continue;
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
  /** Derezzed (struck by rubble or a blast) at this time; null while it lives. */
  downAt: number | null = null;
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
    this.downAt = null;
  }

  board(): void {
    this.active = false;
    this.downAt = null;
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
    if (!this.active || this.downAt !== null) return;
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
