import RAPIER from '@dimforge/rapier3d-compat';
import { BIT, bitState, type BitAnswer, type BitState } from '../people/bit.ts';
import { STYLE_LIGHT } from '../people/bitStyle.ts';
import { express, founderGenome, yesChance, type BitGenome, type Phenotype } from '../people/genome.ts';
import { hash32 } from '../arch/rng.ts';
import { mulberry32 } from '../world/City.ts';
import { GRID } from '../world/planetCity.ts';
import { CITY, hash01, isSea, PLANET, wrapCoord } from './layout.ts';
import { terrainHeight } from './terrain.ts';
import { roadBlock } from './traffic.ts';
import { districtPlan, lotAt, type Lot } from '../arch/DistrictGenerator.ts';
import { structureRoom, type Room, type RoomDoor } from '../arch/InteriorGenerator.ts';
import { kitRoomAt } from '../world/kit.ts';
import { kitRoomId } from '../world/structures.ts';
import {
  advancePool, census, CHILD_SLOT, childGenome, childRand, DEATH_CAUSES, DEFAULT_EVOLUTION, EVOLUTION, isGrown, lifespanOf, lotCapacity, walkDrain,
  canBreed, type Census, type DeathCause, type EvolutionOptions, type StoredBit, type StoredLot,
} from './evolution.ts';

/**
 * Bits are the people of the digital world, not vehicles. They live on a lot: in its building
 * when it has an interior (most of their time is spent indoors, standing at their places down
 * the aisles), and on the kerb around it, which they walk at their own pace. They stop and
 * stand a while, turn back, go in by a door and come out again, and when two meet they stop to
 * talk: one asks, the other answers YES or NO, and they go their ways. They step back from the
 * road and say NO when a vehicle comes past fast, they answer the player's Bit when it speaks
 * to them, and one that is run over derezzes.
 *
 * They evolve (sim/evolution.ts, people/genome.ts). Each carries genes that set its pace, its
 * nerve near traffic, how sociable, agreeable and home-loving it is, how picky about looks, and
 * its look itself (idle light, size, idle figure, spin). It ages, lives on its energy (walking
 * drains it, its room recharges it) and fades out when old or spent. Two grown Bits of a lot who
 * meet and both say YES, with energy to spare, compile a child beside them with genes from both.
 * When a lot streams out its people are kept (its gene pool) and carried forward while away, so
 * coming back finds them older, fewer or more, and changed.
 *
 * Kinematic and deterministic: who lives on a block the first time it is seen is a pure function
 * of the block, and each Bit carries its own seeded stream. Streamed in a disc around whoever the
 * player is (on foot or in a vehicle), wrap-aware like the traffic. No three.js scene objects,
 * no DOM.
 */
export const BITS = {
  /** Streamed disc around the player (m) and the distance a block's people are dropped at. */
  radius: 420,
  despawn: 500,
  /** People per block: 0..perBlock, fewer away from a downtown hub. */
  perBlock: 9,
  max: 340,
  /** The kerb line: this far outside the block's edge (m), on the margin of the street. */
  kerb: 0.8,
  /** Walking pace range (m/s) of the founders (genes can take it further). */
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
  /** People it started with, the most it can hold, and the children compiled on it so far. */
  founders: number;
  capacity: number;
  births: number;
  /** Times the lot has streamed in (seeds the streams of people brought back from its pool). */
  visit: number;
}

interface Waypoint {
  x: number;
  z: number;
  /** Ground height there, when known (a trail walked by the player). */
  y?: number;
}

export interface BitPerson {
  id: number;
  home: BitHome;
  /** Which of the lot's people this is (founders 0..; children and newcomers CHILD_SLOT..). */
  slot: number;
  /** Where it is: on the kerb, on its way through a door, or indoors. */
  place: 'kerb' | 'way' | 'inside' | 'follow';
  /** Following the player: the height of the ground it is on (from the trail it walks). */
  footY: number;
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
  /** Moving house: the lot it is off to, and where on its own kerb it crosses over. */
  bound: BitHome | null;
  boundS: number;
  /** Its genes, and what they make of it. */
  genome: BitGenome;
  ph: Phenotype;
  /** Age and lifespan (s), energy (0..size), generation, founder line, standing (0..1). */
  age: number;
  life: number;
  energy: number;
  gen: number;
  lineage: number;
  prestige: number;
}

/** A vehicle the people watch out for. */
export interface BitThreat {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
}

/** A lot's people while it is out of view, and when (on the population's clock) they were left. */
interface Pool extends StoredLot {
  at: number;
}

export interface BitPopulationOptions {
  /** Births, ageing and energy (false: a fixed population, as before Bits evolved). */
  evolve: boolean;
  /** Streamed disc (m) and the distance a lot's people are dropped at. */
  radius: number;
  despawn: number;
  evolution: EvolutionOptions;
  /** Mixed into every stream (founders, children, people): 0 is the world's own (the lab varies it). */
  seed: number;
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

/** How many Bits live on a lot when it is first seen (its founders): what its blocks add up to. */
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

/** A district's hash (0..1): the variant look a minority of its founders wear. */
export function districtLook(gi: number, gj: number): number {
  return hash01(Math.floor(mod(gi, N) / GRID.chunkBlocks), Math.floor(mod(gj, N) / GRID.chunkBlocks), 97);
}

function wrapDelta(d: number): number {
  return d - Math.round(d / C) * C;
}

/** Point on a home's kerb loop at distance s, stepped `back` toward the lot; and the way along it. */
export function kerbPoint(h: BitHome, s: number, back: number, out: { x: number; z: number; tx: number; tz: number }): void {
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

/** Distance along a home's kerb loop of a point on it (the inverse of kerbPoint at back 0). */
function kerbS(h: BitHome, x: number, z: number): number {
  const wx = h.x1 - h.x0, wz = h.z1 - h.z0;
  const dN = Math.abs(z - h.z0), dE = Math.abs(x - h.x1), dS = Math.abs(z - h.z1), dW = Math.abs(x - h.x0);
  const m = Math.min(dN, dE, dS, dW);
  if (m === dN) return Math.max(0, Math.min(wx, x - h.x0));
  if (m === dE) return wx + Math.max(0, Math.min(wz, z - h.z0));
  if (m === dS) return wx + wz + Math.max(0, Math.min(wx, h.x1 - x));
  return 2 * wx + wz + Math.max(0, Math.min(wz, h.z1 - z));
}

/** A place to stand down the aisle behind a door: mostly in the first few tens of metres, where people gather. */
function spotBehind(d: RoomDoor, rand: () => number): Waypoint {
  const t0 = d.inset + 1.5;
  const t = t0 + Math.min(Math.max(0, d.depth - t0), -Math.log(1 - rand() * 0.999) * 10);
  const side = (rand() - 0.5) * Math.max(0, d.width - 2.6);
  return { x: d.x - d.nx * t - d.nz * side, z: d.z - d.nz * t + d.nx * side };
}

const _k = { x: 0, z: 0, tx: 0, tz: 0 };
/** A vehicle whose path passes farther off than this (m) does not frighten a Bit. */
const PASS_CLOSE = 8;

/** How many of a lot's people its room holds at once (the rest keep to the kerb). */
export const roomPlaces = (capacity: number): number => Math.max(2, Math.ceil(capacity * EVOLUTION.roomShare));

/** A Bit's own stream: a pure function of its lot, its slot and which visit brought it into view. */
const personRand = (key: number, slot: number, visit: number, seed = 0) => mulberry32(visit === 0 && seed === 0 ? ((key * 32 + slot) * 2654435761) | 0 : hash32(key, slot, visit, 0xb17 ^ seed));

export class BitPopulation {
  readonly people: BitPerson[] = [];
  /** Stream and step the people at all (tests and tools can switch it off). */
  enabled = true;
  readonly opts: BitPopulationOptions;
  /** Bits derezzed so far, all causes (run over, blasts, age, spent). */
  derezzed = 0;
  /** Deaths by cause, and children compiled, since the population was made. */
  readonly deaths: Record<DeathCause, number> = Object.fromEntries(DEATH_CAUSES.map((c) => [c, 0])) as Record<DeathCause, number>;
  births = 0;
  /** Where each Bit derezzed this step, why, and its light: drained by the simulation (chips). */
  readonly derezEvents: Array<{ x: number; y: number; z: number; time: number; cause: DeathCause; color: string }> = [];
  /** Conversations held so far, times a Bit has gone in or come out by a door, and moved house. */
  moves = 0;
  talks = 0;
  entries = 0;
  exits = 0;
  private nextId = 1;
  readonly homes = new Map<number, BitHome>();
  /** The people of lots out of view (gene pools), by lot key. Survives a world reset. */
  readonly pools = new Map<number, Pool>();
  /** Times each lot has streamed in. */
  private readonly visits = new Map<number, number>();
  /** The population's own clock (s): it keeps running across world resets. */
  clock = 0;
  private lastManage: { x: number; z: number } | null = null;
  private manageAt = -Infinity;
  /** Two Bits who both said YES: their child appears when the second answer shows. */
  private readonly pendingBirths: Array<{ a: BitPerson; b: BitPerson; at: number }> = [];

  constructor(opts: Partial<BitPopulationOptions> = {}) {
    this.opts = { evolve: true, radius: BITS.radius, despawn: BITS.despawn, seed: 0, ...opts, evolution: { ...DEFAULT_EVOLUTION, ...opts.evolution } };
  }

  /**
   * Back to an empty street (a world reset): the lots in view keep their people as gene pools,
   * so evolution carries on. `clearEvolution` forgets them as well.
   */
  reset(): void {
    for (const h of this.homes.values()) this.store(h);
    this.people.length = 0;
    this.homes.clear();
    this.derezEvents.length = 0;
    this.pendingBirths.length = 0;
    this.lastManage = null;
    this.manageAt = -Infinity;
    this.derezzed = 0;
    this.talks = 0;
    this.entries = 0;
    this.exits = 0;
  }

  /** Forget every gene pool too: the world's Bits start again from their founders. */
  clearEvolution(): void {
    this.reset();
    this.pools.clear();
    this.visits.clear();
    this.births = 0;
    for (const c of DEATH_CAUSES) this.deaths[c] = 0;
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

  /** The census of the people in view now. */
  census(): Census {
    return census(this.people);
  }

  /** A Bit's idle light (its look; YES and NO keep their own colours). */
  static light(p: BitPerson): string {
    return STYLE_LIGHT[p.genome.style.light];
  }

  /**
   * Every lot's people as they stand now: the pools of lots out of view and a snapshot of the
   * lots in view (for saving, and for the relay). `away` is how long ago (s) each was last seen.
   */
  exportPools(): Array<StoredLot & { away: number }> {
    const out: Array<StoredLot & { away: number }> = [];
    for (const p of this.pools.values()) out.push({ key: p.key, births: p.births, capacity: p.capacity, people: p.people, away: this.clock - p.at });
    for (const h of this.homes.values()) out.push({ ...this.snapshot(h), away: 0 });
    return out;
  }

  /**
   * Take in lots' people from elsewhere (saved from an earlier visit, or from the relay). A lot
   * in view now keeps its own people. `away` (s) is carried forward when the lot next streams in.
   */
  importPools(lots: ReadonlyArray<StoredLot & { away?: number }>): number {
    let n = 0;
    for (const l of lots) {
      if (this.homes.has(l.key)) continue;
      this.pools.set(l.key, { key: l.key, births: l.births, capacity: l.capacity, people: l.people.map((p) => ({ ...p })), at: this.clock - Math.max(0, l.away ?? 0) });
      n++;
    }
    return n;
  }

  /** The lot's people as records (followers belong to whoever they follow, not to the lot). */
  private snapshot(h: BitHome): StoredLot {
    const people: StoredBit[] = [];
    for (const p of this.people) {
      if (p.home !== h || p.place === 'follow') continue;
      people.push({ genome: p.genome, age: p.age, life: p.life, energy: p.energy, gen: p.gen, slot: p.slot, lineage: p.lineage, prestige: p.prestige });
    }
    return { key: h.key, births: h.births, capacity: h.capacity, people };
  }

  /** Keep a lot's people as its gene pool (it is streaming out). */
  private store(h: BitHome): void {
    this.pools.set(h.key, { ...this.snapshot(h), at: this.clock });
  }

  /** A new Bit on a home, placed on its kerb or (by its homebody share) indoors. */
  private spawn(h: BitHome, slot: number, rec: StoredBit, rand: () => number, time: number, paceDraw?: number): BitPerson {
    const ph = express(rec.genome);
    const p: BitPerson = {
      id: this.nextId++, home: h, slot, place: 'kerb',
      s: rand() * h.loop,
      dir: rand() < 0.5 ? 1 : -1,
      pace: ph.pace,
      back: 0, backTo: 0,
      mood: 'walk', until: 0, quietUntil: 0,
      door: null, doorS: 0, path: [], then: 'kerb', shiftAt: 0, stayUntil: 0,
      answer: null, answeredAt: -Infinity, pending: null, hurry: false,
      beat: 0,
      x: 0, y: 0, z: 0, yaw: 0,
      rand, gx: Infinity, gz: Infinity, gh: 0, footY: 0, bound: null, boundS: 0,
      genome: rec.genome, ph, age: rec.age, life: rec.life, energy: rec.energy, gen: rec.gen, lineage: rec.lineage, prestige: rec.prestige,
    };
    if (paceDraw === undefined) rand(); // the draw a founder's pace takes, so streams line up
    p.until = time + 4 + rand() * 20;
    p.quietUntil = time + rand() * 4;
    p.beat = rand() * 10;
    const indoors = rand() < ph.indoors;
    if (h.room && !h.ruined && indoors && !this.roomFull(h)) {
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
      p.stayUntil = p.until = time + (20 + rand() * 160) * ph.stay;
      p.shiftAt = time + 3 + rand() * 12;
    }
    this.place(p);
    this.people.push(p);
    return p;
  }

  /**
   * Put a lot's people in its building and on its kerb: its founders the first time it is seen
   * (deterministic for the lot), afterwards its pool, carried forward for the time it was away.
   */
  private populate(h: BitHome, lot: Lot, time: number): void {
    const pool = this.pools.get(h.key);
    if (pool) {
      this.pools.delete(h.key);
      h.births = pool.births;
      h.capacity = Math.max(h.capacity, pool.capacity);
      const store: StoredLot = { key: h.key, births: pool.births, capacity: h.capacity, people: pool.people };
      if (this.opts.evolve) {
        const away = advancePool(store, this.clock - pool.at, mulberry32(hash32(h.key, h.visit, 0xa11 ^ this.opts.seed)), this.opts.evolution, undefined, this.opts.seed);
        this.births += away.births;
        for (const c of DEATH_CAUSES) this.deaths[c] += away.deaths[c] ?? 0;
        h.births = store.births;
      }
      for (const rec of store.people) {
        if (this.people.length >= BITS.max) break;
        this.spawn(h, rec.slot, rec, personRand(h.key, rec.slot, h.visit, this.opts.seed), time);
      }
      return;
    }
    const look = districtLook(lot.gi, lot.gj);
    for (let slot = 0; slot < h.founders && this.people.length < BITS.max; slot++) {
      const rand = personRand(h.key, slot, 0, this.opts.seed);
      const s = rand(), dir = rand(), paceDraw = rand();
      const grand = mulberry32(hash32(h.key, slot, 0x9e7 ^ this.opts.seed));
      const genome = founderGenome(grand, paceDraw, look);
      const life = lifespanOf(grand(), this.opts.evolution);
      const size = express(genome).size;
      const rec: StoredBit = { genome, age: grand() * life * 0.85, life, energy: (0.6 + 0.4 * grand()) * size, gen: 0, slot, lineage: h.key * 32 + slot, prestige: 0 };
      // Founders take the draws Bits always took (kerb place, direction, pace), in order.
      const replay = [s, dir];
      const p = this.spawn(h, slot, rec, () => (replay.length ? replay.shift()! : rand()), time, paceDraw);
      p.rand = rand;
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
    if (p.place === 'follow') { p.y = p.footY + BIT.hover; return; }
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
    const founders = lotPopulation(lot);
    const key = blockKey(gi, gj);
    if (founders === 0 && !this.pools.get(key)?.people.length) return null;
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
    const visit = this.visits.get(key) ?? 0;
    this.visits.set(key, visit + 1);
    return {
      key, gi, gj, x0, x1, z0, z1, loop: 2 * (x1 - x0 + z1 - z0), room, ruined: false,
      founders, capacity: lotCapacity(founders), births: 0, visit,
    };
  }

  /** Fill the lots near the player and drop the far ones. */
  private manage(cx: number, cz: number, time: number): void {
    const gi0 = Math.floor((cx - GRID.x0) / P), gj0 = Math.floor((cz - GRID.z0) / P);
    const ring = Math.ceil(this.opts.radius / P) + 3; // a lot spans up to four blocks: reach its origin
    const seen = new Set<number>();
    for (let dj = -ring; dj <= ring; dj++) for (let di = -ring; di <= ring; di++) {
      const gi = gi0 + di, gj = gj0 + dj;
      const lot = lotAt(gi, gj);
      // One home per lot, made at its origin block.
      if (!lot || mod(lot.gi, N) !== mod(gi, N) || mod(lot.gj, N) !== mod(gj, N)) continue;
      const sx = Math.floor(gi / N) * C, sz = Math.floor(gj / N) * C;
      const lx = Math.max(lot.rect.x0 + sx, Math.min(lot.rect.x1 + sx, cx)), lz = Math.max(lot.rect.z0 + sz, Math.min(lot.rect.z1 + sz, cz));
      if (Math.hypot(lx - cx, lz - cz) > this.opts.radius) continue;
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
      if (Math.hypot(lx - cx, lz - cz) < this.opts.despawn) continue;
      this.store(h);
      this.homes.delete(key);
      for (let i = this.people.length - 1; i >= 0; i--) if (this.people[i].home === h && this.people[i].place !== 'follow') this.people.splice(i, 1);
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
      if (dx * dx + dz * dz > BITS.earshot * BITS.earshot || p.mood === 'scared' || p.place === 'follow') continue;
      p.mood = 'talk';
      p.until = time + BITS.talkTime;
      p.quietUntil = p.until + 2;
      p.yaw = Math.atan2(-dx, dz);
      p.pending = { answer: p.rand() < p.ph.yes ? 'yes' : 'no', at: time + 0.5 + p.rand() * 0.7 };
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
        if (p.place === 'follow') continue;
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

  /** A Bit starts to follow the player (the trail is fed by whoever leads it). */
  lead(p: BitPerson, time: number): void {
    p.place = 'follow';
    p.bound = null;
    p.path = [];
    p.door = null;
    p.pending = null;
    p.footY = p.y - BIT.hover;
    this.say(p, 'yes', time);
  }

  /** A followed Bit reaches the building it was taken to: it goes in by the door and lives there now. */
  arrive(p: BitPerson, h: BitHome, time: number): boolean {
    const r = h.room;
    if (!r || !this.people.includes(p)) return false;
    const d = r.doors.reduce((a, q) => (Math.hypot(q.x - p.x, q.z - p.z) < Math.hypot(a.x - p.x, a.z - p.z) ? q : a));
    p.home = h;
    p.slot = CHILD_SLOT + h.births++; // a newcomer: not one of the lot's own people (its genes come with it)
    p.door = d;
    p.doorS = doorKerb(h, d);
    p.path = [{ x: d.x + d.nx * 1.6, z: d.z + d.nz * 1.6 }, { x: d.x - d.nx * 1.6, z: d.z - d.nz * 1.6 }, spotBehind(d, p.rand)];
    p.then = 'inside';
    p.place = 'way';
    p.mood = 'walk';
    this.say(p, 'yes', time);
    return true;
  }

  /** A followed Bit is let go: it says NO and walks back the way it came to its own kerb (or, its lot gone, fades out). */
  release(p: BitPerson, time: number, back: ReadonlyArray<{ x: number; z: number; y?: number }> = []): void {
    const i = this.people.indexOf(p);
    if (i < 0 || p.place !== 'follow') return;
    this.say(p, 'no', time);
    if (!this.homes.has(p.home.key) || this.homes.get(p.home.key) !== p.home) {
      // Its lot is out of view: it goes home to the lot's pool.
      this.pools.get(p.home.key)?.people.push({ genome: p.genome, age: p.age, life: p.life, energy: p.energy, gen: p.gen, slot: p.slot, lineage: p.lineage, prestige: p.prestige });
      this.people.splice(i, 1);
      return;
    }
    kerbPoint(p.home, p.s, 0, _k);
    p.path = [...back.map((w) => ({ x: w.x, z: w.z })), { x: _k.x, z: _k.z }]; // back the way it came
    p.then = 'kerb';
    p.place = 'way';
    p.door = null;
  }

  /** Something lands or goes off at (x, y, z): every Bit within `r` of it derezzes. Returns how many. */
  strike(x: number, y: number, z: number, r: number, time: number): number {
    let n = 0;
    for (let i = this.people.length - 1; i >= 0; i--) {
      const p = this.people[i];
      const dx = p.x - x, dy = p.y - y, dz = p.z - z;
      if (dx * dx + dy * dy + dz * dz > r * r) continue;
      this.derez(p, i, time, 'blast');
      n++;
    }
    return n;
  }

  /** A Bit leaves the world (`cause`: run over, a blast, old age, energy spent, shot). */
  derez(p: BitPerson, i: number, time: number, cause: DeathCause): void {
    if (this.people[i] !== p) i = this.people.indexOf(p);
    if (i < 0) return;
    this.derezzed++;
    this.deaths[cause]++;
    this.derezEvents.push({ x: p.x, y: p.y, z: p.z, time, cause, color: BitPopulation.light(p) });
    if (this.derezEvents.length > 32) this.derezEvents.shift();
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

  /** Head for a door of its building (the nearest, more often than not): round the kerb the short way to where it lets out. */
  private seekDoor(p: BitPerson, time: number): void {
    const h = p.home;
    const doors = h.room!.doors;
    const along = (d: RoomDoor) => { const a = mod(doorKerb(h, d) - p.s, h.loop); return Math.min(a, h.loop - a); };
    p.door = p.rand() < 0.7 ? doors.reduce((a, d) => (along(d) < along(a) ? d : a)) : doors[Math.floor(p.rand() * doors.length)];
    p.doorS = doorKerb(h, p.door);
    const ahead = mod(p.doorS - p.s, h.loop);
    p.dir = ahead <= h.loop / 2 ? 1 : -1;
    p.until = time + Math.min(ahead, h.loop - ahead) / p.pace + 30;
  }

  /** Walk the current path; true when it is done. */
  private follow(p: BitPerson, dt: number): boolean {
    let left = (p.place === 'follow' ? Math.max(p.pace, 7.5) : p.pace * (p.hurry ? 2.5 : 1)) * dt;
    while (left > 0 && p.path.length) {
      const w = p.path[0];
      const dx = w.x - p.x, dz = w.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-6) p.yaw = Math.atan2(dx, -dz);
      if (d <= left) { p.x = w.x; p.z = w.z; if (w.y !== undefined) p.footY = w.y; left -= d; p.path.shift(); }
      else { p.x += (dx / d) * left; p.z += (dz / d) * left; left = 0; }
    }
    return p.path.length === 0;
  }

  /** The chance a grown Bit at a loose end moves house: now and then, and often from a crowded lot. */
  private moveChance(h: BitHome): number {
    return this.headcount(h) >= h.capacity - 1 ? 0.25 : 0.015;
  }

  /**
   * Move house: across the street to a neighbouring lot with room (the emptier the likelier),
   * straight over from its kerb to the nearest point of the new kerb, never through a lot. It
   * belongs to the new lot from the moment it sets off. False if no neighbour has room.
   */
  private move(p: BitPerson, time: number): boolean {
    const from = p.home;
    let best: BitHome | null = null, bestScore = 0;
    for (const h of this.homes.values()) {
      if (h === from || h.ruined) continue;
      // Across one street (or one crossing): the gap between the two kerb rectangles is all road.
      const gx = Math.max(0, h.x0 - from.x1, from.x0 - h.x1), gz = Math.max(0, h.z0 - from.z1, from.z0 - h.z1);
      if (Math.hypot(gx, gz) > CITY.street + 4 * BITS.kerb) continue;
      const room = h.capacity - this.headcount(h);
      if (room <= 0) continue;
      const score = (room / h.capacity) * (0.5 + p.rand());
      if (score > bestScore) { bestScore = score; best = h; }
    }
    if (!best) return false;
    // It walks round its own kerb to the point facing the new lot, and crosses there.
    const cx = Math.max(from.x0, Math.min(from.x1, (best.x0 + best.x1) / 2)), cz = Math.max(from.z0, Math.min(from.z1, (best.z0 + best.z1) / 2));
    p.bound = best;
    p.boundS = kerbS(from, cx, cz);
    const ahead = mod(p.boundS - p.s, from.loop);
    p.dir = ahead <= from.loop / 2 ? 1 : -1;
    p.until = time + Math.min(ahead, from.loop - ahead) / p.pace + 30;
    return true;
  }

  /** At its crossing point: straight over the street to the nearest point of the new lot's kerb. */
  private cross(p: BitPerson): boolean {
    const to = p.bound!;
    p.bound = null;
    if (!this.homes.has(to.key) || this.homes.get(to.key) !== to || to.ruined || this.headcount(to) >= to.capacity) return false;
    const nx = Math.max(to.x0, Math.min(to.x1, p.x)), nz = Math.max(to.z0, Math.min(to.z1, p.z));
    // Onto the kerb line itself: snap the nearer edge.
    const ex = Math.min(Math.abs(nx - to.x0), Math.abs(nx - to.x1)), ez = Math.min(Math.abs(nz - to.z0), Math.abs(nz - to.z1));
    const tx = ex <= ez ? (Math.abs(nx - to.x0) < Math.abs(nx - to.x1) ? to.x0 : to.x1) : nx;
    const tz = ex <= ez ? nz : (Math.abs(nz - to.z0) < Math.abs(nz - to.z1) ? to.z0 : to.z1);
    // Only straight over the street: a line that would cut through a lot (its own, from the far
    // side) waits for a better moment.
    for (const h of this.homes.values()) {
      for (let k = 1; k < 8; k++) {
        const x = p.x + (tx - p.x) * (k / 8), z = p.z + (tz - p.z) * (k / 8);
        if (x > h.x0 + 0.5 && x < h.x1 - 0.5 && z > h.z0 + 0.5 && z < h.z1 - 0.5) return false;
      }
    }
    p.home = to;
    p.slot = CHILD_SLOT + to.births++;
    p.door = null;
    p.doorS = kerbS(to, tx, tz);
    p.path = [{ x: tx, z: tz }];
    p.then = 'kerb';
    p.place = 'way';
    p.mood = 'walk';
    p.back = p.backTo = 0;
    this.moves++;
    return true;
  }

  /** Is the lot's room as full as it gets (indoors, or on the way in)? */
  private roomFull(h: BitHome): boolean {
    let n = 0;
    for (const p of this.people) if (p.home === h && (p.place === 'inside' || (p.place === 'way' && p.then !== 'kerb'))) n++;
    return n >= roomPlaces(h.capacity);
  }

  /** People on a lot now (in view), followers included. */
  private headcount(h: BitHome): number {
    let n = 0;
    for (const p of this.people) if (p.home === h) n++;
    return n;
  }

  /** Two Bits who both said YES compile a child beside them, if the lot has room. */
  private birth(a: BitPerson, b: BitPerson, time: number): BitPerson | null {
    const h = a.home;
    if (b.home !== h || !this.people.includes(a) || !this.people.includes(b)) return null;
    if (!canBreed(a, b) || this.headcount(h) >= h.capacity || this.people.length >= BITS.max) return null;
    const n = h.births++;
    const rand = childRand(h.key, n, this.opts.seed);
    const genome = childGenome(a.genome, b.genome, rand, this.opts.evolution.mutation);
    const ph = express(genome);
    a.energy -= EVOLUTION.birthCost * a.ph.size;
    b.energy -= EVOLUTION.birthCost * b.ph.size;
    const slot = CHILD_SLOT + n;
    const rec: StoredBit = { genome, age: 0, life: lifespanOf(rand(), this.opts.evolution), energy: EVOLUTION.childEnergy * ph.size, gen: Math.max(a.gen, b.gen) + 1, slot, lineage: a.lineage, prestige: 0 };
    const c = this.spawn(h, slot, rec, personRand(h.key, slot, h.visit, this.opts.seed), time);
    // Beside its parents: on the kerb between them, or down the aisle they stand in (or, the
    // room being full, just outside their door).
    const roomy = c.place === 'inside' || !this.roomFull(h);
    if (a.place === 'kerb') {
      const gap = mod(b.s - a.s, h.loop);
      const mid = gap <= h.loop / 2 ? a.s + gap / 2 : a.s - (h.loop - gap) / 2;
      c.place = 'kerb';
      c.door = null;
      c.s = mod(mid, h.loop);
    } else if (a.place === 'inside' && a.door && !roomy) {
      c.place = 'kerb';
      c.door = null;
      c.s = a.doorS;
    } else if (a.place === 'inside' && a.door) {
      const spot = spotBehind(a.door, c.rand);
      c.place = 'inside';
      c.door = a.door;
      c.doorS = a.doorS;
      c.x = spot.x;
      c.z = spot.z;
      c.stayUntil = time + (30 + c.rand() * 120) * ph.stay;
      c.shiftAt = time + 4 + c.rand() * 10;
    }
    c.mood = 'stand';
    c.until = time + 3;
    c.quietUntil = time + 3 + BITS.cooldown * ph.cooldown;
    c.yaw = Math.atan2(a.x - c.x, -(a.z - c.z));
    this.say(c, 'yes', time);
    this.place(c);
    this.births++;
    return c;
  }

  /** Age and energy for dt: walking drains, indoors recharges; old or spent, it fades out. True if it died. */
  private live(p: BitPerson, i: number, dt: number, time: number): boolean {
    const evo = this.opts.evolution;
    p.age += dt;
    const h = p.home;
    let rate = -EVOLUTION.idleDrain * evo.energyScale;
    if (p.place === 'inside' && h.room && !h.ruined) rate += EVOLUTION.recharge;
    else if ((p.mood === 'walk' && p.place !== 'inside') || p.place === 'follow') rate -= walkDrain(p.pace, evo) * (p.hurry ? 2.5 : 1);
    // Its own building feeds it a little on the kerb round it; a lot with no room, a little more.
    if (p.place === 'kerb') rate += h.room && !h.ruined ? EVOLUTION.kerbRecharge * 0.5 : EVOLUTION.kerbRecharge;
    p.energy = Math.min(p.ph.size, p.energy + rate * dt);
    if (p.prestige > 0) p.prestige = Math.max(0, p.prestige - dt / (EVOLUTION.lifespan * evo.lifespanScale));
    if (p.place === 'follow') return false; // escorted: it lives through the errand
    const cause: DeathCause | null = p.age >= p.life ? 'old-age' : p.energy <= 0 ? 'spent' : null;
    if (!cause) return false;
    this.derez(p, i, time, cause);
    return true;
  }

  /**
   * Advance the people by dt. `centre` is whoever the player is; `threats` are the vehicles they
   * watch for (the player's craft, when it is down among them).
   */
  step(dt: number, time: number, centre: { x: number; z: number }, threats: readonly BitThreat[] = []): void {
    if (!this.enabled) return;
    this.clock += dt;
    const evolve = this.opts.evolve;
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
      // Vehicles: run over, or frightened off the kerb (how soon depends on its nerve).
      let hit = false;
      const hitR = BITS.hitRange * p.ph.size, scareR = BITS.scareRange * p.ph.scareRange, scareV = BITS.scareSpeed * p.ph.scareSpeed;
      for (const t of threats) {
        const dx = p.x - t.x, dz = p.z - t.z;
        const d2 = dx * dx + dz * dz, speed = Math.hypot(t.vx, t.vz);
        if (Math.abs(t.y - p.y) > 6) continue;
        // Over the stretch it covered since the last step, so a fast vehicle cannot skip past.
        if (speed > 2) {
          const sx = t.vx * dt, sz = t.vz * dt, l2 = sx * sx + sz * sz;
          const k = l2 > 0 ? Math.max(0, Math.min(1, (dx * sx + dz * sz) / l2 + 1)) : 1;
          const ex = p.x - (t.x - sx + sx * k), ez = p.z - (t.z - sz + sz * k);
          if (ex * ex + ez * ez < hitR * hitR) { hit = true; break; }
        }
        // Coming this way, fast, on a line that passes close: closing along the line to the
        // Bit, and its path within PASS_CLOSE of it (one in the far lane goes by).
        if (d2 < scareR * scareR && speed > scareV && t.vx * dx + t.vz * dz > 0 && Math.abs(t.vx * dz - t.vz * dx) < PASS_CLOSE * speed) this.frighten(p, time);
      }
      if (hit) {
        this.derez(p, i, time, 'run-over');
        continue;
      }
      if (evolve && this.live(p, i, dt, time)) continue;
      if (p.pending && time >= p.pending.at) {
        this.say(p, p.pending.answer, time);
        p.pending = null;
      }
      if (p.place === 'follow') {
        // Following the player along the trail it walked, keeping a couple of metres back.
        if (p.path.length) this.follow(p, dt);
        p.mood = 'walk';
      } else if (p.place === 'way') {
        // Through a door: it stops to talk or flinch, otherwise it keeps walking.
        if (p.mood !== 'walk' && (p.hurry || time >= p.until)) p.mood = 'walk';
        if (p.mood === 'walk' && this.follow(p, dt)) {
          if (p.then === 'inside') {
            p.place = 'inside';
            p.mood = 'stand';
            p.stayUntil = p.until = time + (40 + p.rand() * 160) * p.ph.stay;
            p.shiftAt = time + 4 + p.rand() * 14;
            this.entries++;
          } else if (p.then === 'spot') {
            p.place = 'inside';
            p.mood = 'stand';
            p.until = Math.max(p.stayUntil, time + 2);
            p.shiftAt = time + 6 + p.rand() * 18;
          } else {
            if (p.door) this.exits++;
            p.place = 'kerb';
            p.hurry = false;
            p.s = p.doorS;
            p.door = null;
            p.dir = p.rand() < 0.5 ? 1 : -1;
            p.until = time + 8 + p.rand() * 24;
          }
        }
      } else if (p.place === 'inside') {
        // Low on energy, it stays in to recharge.
        if (evolve && time >= p.stayUntil - 4 && p.energy < 0.6 * p.ph.size && h.room && !h.ruined) p.stayUntil = p.until = Math.max(p.until, time + 20);
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
        if (p.bound) {
          // Moving house: has it reached its crossing point?
          const was = mod((p.boundS - before) * p.dir, h.loop), now = mod((p.boundS - p.s) * p.dir, h.loop);
          if (was < 1 || now > was) {
            p.s = p.boundS;
            this.place(p);
            this.cross(p);
          } else if (time >= p.until) p.bound = null; // never got there: it stays
        } else if (p.door) {
          // Heading for a door: has it reached (or just passed) where the door lets out?
          const was = mod((p.doorS - before) * p.dir, h.loop), now = mod((p.doorS - p.s) * p.dir, h.loop);
          if ((was < 1 || now > was) && this.roomFull(h)) {
            // The room is full: it stands by the door a moment and walks on.
            p.s = p.doorS;
            p.door = null;
            p.mood = 'stand';
            p.until = time + 2 + p.rand() * 4;
          } else if (was < 1 || now > was) {
            const d = p.door!;
            p.s = p.doorS;
            this.place(p);
            const spot = spotBehind(d, p.rand);
            p.path = [{ x: d.x + d.nx * 1.6, z: d.z + d.nz * 1.6 }, { x: d.x - d.nx * 1.6, z: d.z - d.nz * 1.6 }, spot];
            p.then = 'inside';
            p.place = 'way';
          } else if (time >= p.until) p.door = null; // never got there: give up
        } else if (evolve && p.energy < EVOLUTION.low * p.ph.size && h.room && !h.ruined) {
          this.seekDoor(p, time); // running low: home to recharge
        } else if (time >= p.until) {
          // Stand a while, turn back the way it came, go home indoors, or go and find a neighbour.
          // A grown Bit with energy to spare is out for company: it goes looking more often.
          const r = p.rand();
          const courting = evolve && isGrown(p.age, p.life) && p.energy >= EVOLUTION.breed * p.ph.size;
          const home = Math.min(0.68, 0.55 * p.ph.homeWeight) * (courting ? 0.6 : 1);
          if (evolve && isGrown(p.age, p.life) && p.rand() < this.moveChance(h) && this.move(p, time)) { /* moving next door */ }
          else if (r < 0.2) { p.mood = 'stand'; p.until = time + 1.5 + p.rand() * 5; }
          else if (r < 0.3) { p.dir = -p.dir as 1 | -1; p.until = time + 6 + p.rand() * 20; }
          else if (r < 0.3 + home && h.room && !h.ruined) this.seekDoor(p, time);
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
      // Stepping back (or in again) takes a moment, however often the people think.
      p.back += (p.backTo - p.back) * (1 - Math.exp(-dt * 5));
      this.place(p);
    }
    // Meetings: two of a lot's people close together, both on the kerb or both indoors, stop to talk.
    for (let i = 0; i < people.length; i++) {
      const a = people[i];
      if (a.place === 'way' || a.place === 'follow' || a.hurry || a.mood === 'talk' || a.mood === 'scared' || time < a.quietUntil) continue;
      for (let j = i + 1; j < people.length; j++) {
        const b = people[j];
        if (b.home !== a.home || b.place !== a.place || b.mood === 'talk' || b.mood === 'scared' || time < b.quietUntil) continue;
        const dx = a.x - b.x, dz = a.z - b.z;
        const range = BITS.talkRange * (a.ph.talkRange + b.ph.talkRange) / 2;
        if (dx * dx + dz * dz > range * range) continue;
        this.talks++;
        for (const [p, q] of [[a, b], [b, a]] as const) {
          p.mood = 'talk';
          p.until = time + BITS.talkTime;
          p.quietUntil = p.until + BITS.cooldown * p.ph.cooldown;
          p.yaw = Math.atan2(q.x - p.x, -(q.z - p.z));
          if (evolve) p.energy -= EVOLUTION.talkCost;
        }
        // b answers a's question; when b says YES, a answers back (and two YESes between grown
        // Bits with energy to spare compile a child); otherwise a sometimes has a word to say.
        const bYes = b.rand() < yesChance(b.genome, a.genome, a.prestige);
        b.pending = { answer: bYes ? 'yes' : 'no', at: time + 0.8 };
        if (bYes || a.rand() < 0.5) {
          // A YES is easier to answer with a YES.
          const c = yesChance(a.genome, b.genome, b.prestige);
          const aYes = a.rand() < (bYes ? 1 - (1 - c) * (1 - c) : c);
          a.pending = { answer: aYes ? 'yes' : 'no', at: time + 1.9 };
          if (evolve && bYes && aYes && isGrown(a.age, a.life) && isGrown(b.age, b.life)) this.pendingBirths.push({ a, b, at: time + 1.9 });
        }
        break;
      }
    }
    for (let i = this.pendingBirths.length - 1; i >= 0; i--) {
      const pb = this.pendingBirths[i];
      if (time < pb.at) continue;
      this.pendingBirths.splice(i, 1);
      this.birth(pb.a, pb.b, time);
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
