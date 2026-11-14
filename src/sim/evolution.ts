import {
  BEHAVIOUR_GENES, COMBAT_GENES, GENES, STYLE_FIELDS, crossover, express, mutate, packStyle, seededRand, unpackStyle, yesChance,
  type BitGenome, type Gene, type StyleField,
} from '../people/genome.ts';
import { BIT_STYLE_CHOICES } from '../people/bitStyle.ts';

/**
 * Evolution of the Bits: how they age, live on their energy, pair up and die, and how a lot's
 * people carry on while nobody is there to see them. The people themselves walk in
 * `sim/bits.ts`; this is the part they share with the Evolution Lab and the relay (server/),
 * so it needs nothing but the genome: no world, no three.js, no DOM.
 *
 * - **Life.** A Bit lives about ten minutes (±20%) and is grown at a fifth of that.
 * - **Energy.** Walking drains it (more, the faster it walks); indoors, in its building's room,
 *   it recharges. A Bit that runs dry fades out; one running low goes home.
 * - **Children.** Two grown Bits of one lot who meet and both answer YES, each with energy to
 *   spare, compile a child: each gene from one parent or the other, then copying errors. A lot
 *   holds at most one and a half times the people it started with.
 * - **Away.** A lot out of view is carried forward in 10 s steps by `advancePool`: the same
 *   ageing, the same genetics, meetings drawn at the rate the people's sociability gives.
 *
 * Everything is driven by seeded streams: the same history gives the same Bits.
 */
export const EVOLUTION = {
  /** Lifespan (s) and its spread (±), and the share of it before a Bit is grown. */
  lifespan: 600,
  lifespanJitter: 0.2,
  maturity: 0.15,
  /** Energy: full is 1 × size. Drain per second walking at the middle pace, and the base cost of being. */
  walkDrain: 1 / 1100,
  idleDrain: 1 / 4000,
  /** Recharge per second indoors, and on the kerb of a lot that has no room. */
  recharge: 1 / 80,
  kerbRecharge: 1 / 700,
  /** What a conversation costs, what a child costs each parent, what a child starts with. */
  talkCost: 0.005,
  birthCost: 0.25,
  childEnergy: 0.55,
  /** Below this it heads home to recharge; at or above this it may breed. */
  low: 0.25,
  breed: 0.35,
  /** A lot's room holds at most this share of the people the lot can hold (the rest keep to the kerb). */
  roomShare: 0.45,
  /** A lot holds at most this many times its founders (and at least `minCapacity`). */
  capacity: 1.5,
  minCapacity: 3,
  /** Chance per gene of a copying error, and its size. */
  mutation: 0.08,
  sigma: 0.08,
  /** Off-screen: step (s), meetings per second for a middle Bit, and the longest catch-up (lifespans). */
  awayStep: 10,
  meetRate: 1 / 90,
  catchUp: 3,
} as const;

/** Settings that the lab (and tests) change: everything else stays as above. */
export interface EvolutionOptions {
  /** Multiplies every lifespan (and so the generation time). */
  lifespanScale: number;
  /** Multiplies energy drain: scarcity. */
  energyScale: number;
  /** Chance per gene of a copying error. */
  mutation: number;
}

export const DEFAULT_EVOLUTION: EvolutionOptions = { lifespanScale: 1, energyScale: 1, mutation: EVOLUTION.mutation };

export type DeathCause = 'run-over' | 'blast' | 'old-age' | 'spent' | 'shot';
export const DEATH_CAUSES: readonly DeathCause[] = ['run-over', 'blast', 'old-age', 'spent', 'shot'];

/** One Bit as a lot remembers it while it is out of view (and as the relay keeps it). */
export interface StoredBit {
  genome: BitGenome;
  /** Age and lifespan (s). */
  age: number;
  life: number;
  /** Energy, 0..size. */
  energy: number;
  /** Generation: founders are 0. */
  gen: number;
  /** Which of the lot's people it is (founders 0..; children 10000 + birth count). */
  slot: number;
  /** The founder its line descends from (by the asking parent). */
  lineage: number;
  /** A sapper back from a mission: others look up to it (0..1). */
  prestige: number;
}

/** A lot's people while it is out of view. */
export interface StoredLot {
  key: number;
  /** Children compiled on the lot so far (names the next child's slot and stream). */
  births: number;
  /** Most people the lot can hold. */
  capacity: number;
  people: StoredBit[];
}

/** The first slot number a child takes. */
export const CHILD_SLOT = 10000;

export const lotCapacity = (founders: number): number => Math.max(EVOLUTION.minCapacity, Math.ceil(founders * EVOLUTION.capacity));

/** A Bit's lifespan (s), from its own draw (0..1). */
export const lifespanOf = (draw: number, opts: EvolutionOptions = DEFAULT_EVOLUTION): number =>
  EVOLUTION.lifespan * opts.lifespanScale * (1 + EVOLUTION.lifespanJitter * (2 * draw - 1));

export const isGrown = (age: number, life: number): boolean => age >= life * EVOLUTION.maturity;

/** Energy drained per second while walking at `pace` m/s (relative to the middle pace, 2.4 m/s). */
export const walkDrain = (pace: number, opts: EvolutionOptions = DEFAULT_EVOLUTION): number =>
  EVOLUTION.walkDrain * (pace / 2.4) ** 2 * opts.energyScale;

/** Can these two compile a child now? (Grown, energy to spare; the caller checks room on the lot.) */
export function canBreed(a: { age: number; life: number; energy: number; genome: BitGenome }, b: typeof a): boolean {
  return isGrown(a.age, a.life) && isGrown(b.age, b.life)
    && a.energy >= EVOLUTION.breed * express(a.genome).size && b.energy >= EVOLUTION.breed * express(b.genome).size;
}

/** A child's genes from its parents: crossover, then copying errors. */
export function childGenome(a: BitGenome, b: BitGenome, rand: () => number, rate: number = EVOLUTION.mutation): BitGenome {
  return mutate(crossover(a, b, rand), rate, rand, EVOLUTION.sigma);
}

/** The stream a lot's `n`th child is drawn from: a pure function of the lot and the count. */
export const childRand = (lotKey: number, n: number, seed = 0): (() => number) => seededRand(Math.imul(lotKey + 0x3c6ef372, 0x9e3779b1) ^ Math.imul(n + 1, 0x85ebca77) ^ Math.imul(seed, 0xc2b2ae35));

/**
 * Carry a lot's people forward by `elapsed` seconds while nobody watches: in steps of
 * `EVOLUTION.awayStep`, each ages and lives on its energy (indoors for its homebody share of the
 * time), dies of age or of running dry, and grown Bits meet at their sociability's rate and,
 * both saying YES, compile children while the lot has room. At most `maxElapsed` seconds are
 * simulated (by default `EVOLUTION.catchUp` lifespans; the relay passes its own tick).
 * Returns the births and the deaths by cause.
 */
export function advancePool(lot: StoredLot, elapsed: number, rand: () => number, opts: EvolutionOptions = DEFAULT_EVOLUTION, maxElapsed = EVOLUTION.catchUp * EVOLUTION.lifespan * opts.lifespanScale, seed = 0): { births: number; deaths: Partial<Record<DeathCause, number>> } {
  const out = { births: 0, deaths: {} as Partial<Record<DeathCause, number>> };
  let left = Math.min(Math.max(0, elapsed), maxElapsed);
  const people = lot.people;
  while (left > 1e-6) {
    const dt = Math.min(EVOLUTION.awayStep, left);
    left -= dt;
    for (let i = people.length - 1; i >= 0; i--) {
      const p = people[i];
      const ph = express(p.genome);
      p.age += dt;
      // Out on the kerb (walking half the time) or home recharging, in its homebody share.
      const inside = Math.min(EVOLUTION.roomShare, ph.indoors);
      const net = inside * EVOLUTION.recharge - (1 - inside) * (0.5 * walkDrain(ph.pace, opts)) - EVOLUTION.idleDrain * opts.energyScale;
      p.energy = Math.min(ph.size, p.energy + net * dt);
      p.prestige = Math.max(0, p.prestige - dt / (EVOLUTION.lifespan * opts.lifespanScale));
      const cause: DeathCause | null = p.age >= p.life ? 'old-age' : p.energy <= 0 ? 'spent' : null;
      if (cause) {
        people.splice(i, 1);
        out.deaths[cause] = (out.deaths[cause] ?? 0) + 1;
      }
    }
    // Meetings: each grown Bit with energy to spare may meet another; both YES, a child.
    const n = people.length;
    if (n < 2) continue;
    for (let i = 0; i < n && people.length < lot.capacity; i++) {
      const a = people[i];
      if (!a) break;
      const pa = express(a.genome);
      const rate = EVOLUTION.meetRate * (1 / pa.cooldown);
      if (rand() >= 1 - Math.exp(-rate * dt)) continue;
      const b = people[Math.floor(rand() * people.length)];
      if (b === a || !canBreed(a, b)) continue;
      if (rand() >= yesChance(b.genome, a.genome, a.prestige) || rand() >= yesChance(a.genome, b.genome, b.prestige)) continue;
      people.push(compileChild(lot, a, b, opts, seed));
      out.births++;
    }
  }
  return out;
}

/** The record of a child two stored Bits compile (they pay its energy). */
export function compileChild(lot: StoredLot, a: StoredBit, b: StoredBit, opts: EvolutionOptions = DEFAULT_EVOLUTION, seed = 0): StoredBit {
  const n = lot.births++;
  const rand = childRand(lot.key, n, seed);
  const genome = childGenome(a.genome, b.genome, rand, opts.mutation);
  a.energy -= EVOLUTION.birthCost * express(a.genome).size;
  b.energy -= EVOLUTION.birthCost * express(b.genome).size;
  return {
    genome, age: 0, life: lifespanOf(rand(), opts), energy: EVOLUTION.childEnergy * express(genome).size,
    gen: Math.max(a.gen, b.gen) + 1, slot: CHILD_SLOT + n, lineage: a.lineage, prestige: 0,
  };
}

// --- Census

export interface Census {
  count: number;
  /** Mean and standard deviation of every gene. */
  mean: Record<Gene, number>;
  sd: Record<Gene, number>;
  /** Share of the people wearing each choice of each style field. */
  style: { [F in StyleField]: Record<string, number> };
  /** Highest and mean generation, and how many founder lines are still alive. */
  maxGen: number;
  meanGen: number;
  lineages: number;
}

export function census(people: ReadonlyArray<{ genome: BitGenome; gen: number; lineage: number }>): Census {
  const n = people.length;
  const mean = {} as Record<Gene, number>, sd = {} as Record<Gene, number>;
  for (const k of GENES) {
    let s = 0;
    for (const p of people) s += p.genome[k];
    const m = n ? s / n : 0;
    let v = 0;
    for (const p of people) v += (p.genome[k] - m) ** 2;
    mean[k] = m;
    sd[k] = n ? Math.sqrt(v / n) : 0;
  }
  const style = {} as Census['style'];
  for (const f of STYLE_FIELDS) {
    const shares: Record<string, number> = {};
    for (const [c] of BIT_STYLE_CHOICES[f]) shares[c] = 0;
    for (const p of people) shares[p.genome.style[f]] += n ? 1 / n : 0;
    (style as Record<StyleField, Record<string, number>>)[f] = shares;
  }
  let maxGen = 0, sumGen = 0;
  const lines = new Set<number>();
  for (const p of people) {
    maxGen = Math.max(maxGen, p.gen);
    sumGen += p.gen;
    lines.add(p.lineage);
  }
  return { count: n, mean, sd, style, maxGen, meanGen: n ? sumGen / n : 0, lineages: lines.size };
}

export { BEHAVIOUR_GENES, COMBAT_GENES };

// --- Compact encoding (storage and the relay)

const FORMAT = 1;
/** Bytes per Bit: 9 genes, style, age, life, energy, gen, slot, lineage, prestige. */
const BIT_BYTES = GENES.length + 1 + 2 + 2 + 1 + 2 + 4 + 4 + 1;
/** Bytes per lot header: key, births, capacity, count. */
const LOT_BYTES = 4 + 4 + 1 + 1;
/** Most people one lot may hold in an encoding (anything more is refused). */
export const MAX_LOT_PEOPLE = 64;

const q8 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
const q16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v)));

/** Pools packed into bytes: a format byte, then each lot's header and its people. */
export function encodePools(lots: readonly StoredLot[]): Uint8Array {
  let size = 1;
  for (const l of lots) size += LOT_BYTES + Math.min(l.people.length, MAX_LOT_PEOPLE) * BIT_BYTES;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  let o = 0;
  buf[o++] = FORMAT;
  for (const l of lots) {
    const people = l.people.slice(0, MAX_LOT_PEOPLE);
    dv.setUint32(o, l.key >>> 0); o += 4;
    dv.setUint32(o, l.births >>> 0); o += 4;
    buf[o++] = Math.min(255, l.capacity);
    buf[o++] = people.length;
    for (const p of people) {
      for (const k of GENES) buf[o++] = q8(p.genome[k]);
      buf[o++] = packStyle(p.genome.style);
      dv.setUint16(o, q16(p.age)); o += 2;
      dv.setUint16(o, q16(p.life)); o += 2;
      buf[o++] = q8(p.energy / 1.5);
      dv.setUint16(o, q16(p.gen)); o += 2;
      dv.setUint32(o, p.slot >>> 0); o += 4;
      dv.setUint32(o, p.lineage >>> 0); o += 4;
      buf[o++] = q8(p.prestige);
    }
  }
  return buf;
}

/** Bytes back into pools; null if they are not a valid encoding (wrong format, truncated, out of range). */
export function decodePools(buf: Uint8Array): StoredLot[] | null {
  if (buf.length < 1 || buf[0] !== FORMAT) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const lots: StoredLot[] = [];
  let o = 1;
  while (o < buf.length) {
    if (o + LOT_BYTES > buf.length) return null;
    const key = dv.getUint32(o); o += 4;
    const births = dv.getUint32(o); o += 4;
    const capacity = buf[o++];
    const count = buf[o++];
    if (count > MAX_LOT_PEOPLE || o + count * BIT_BYTES > buf.length) return null;
    const people: StoredBit[] = [];
    for (let i = 0; i < count; i++) {
      const genes = {} as Record<Gene, number>;
      for (const k of GENES) genes[k] = buf[o++] / 255;
      const style = unpackStyle(buf[o++]);
      if (!style) return null;
      const age = dv.getUint16(o); o += 2;
      const life = dv.getUint16(o); o += 2;
      const energy = (buf[o++] / 255) * 1.5;
      const gen = dv.getUint16(o); o += 2;
      const slot = dv.getUint32(o); o += 4;
      const lineage = dv.getUint32(o); o += 4;
      const prestige = buf[o++] / 255;
      if (life <= 0) return null;
      people.push({ genome: { ...genes, style }, age, life, energy, gen, slot, lineage, prestige });
    }
    lots.push({ key, births, capacity, people });
  }
  return lots;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without the platform (the same in the browser, Node and Bun). */
export function toBase64(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i += 3) {
    const n = (buf[i] << 16) | ((buf[i + 1] ?? 0) << 8) | (buf[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < buf.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < buf.length ? B64[n & 63] : '=');
  }
  return s;
}

export function fromBase64(s: string): Uint8Array | null {
  if (s.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(s)) return null;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | ((s[i + 2] === '=' ? 0 : B64.indexOf(s[i + 2])) << 6) | (s[i + 3] === '=' ? 0 : B64.indexOf(s[i + 3]));
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
