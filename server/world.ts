/**
 * The world the relay keeps: every lot's Bits (its gene pool), carried forward for as long as
 * the relay runs. Independent of the transport (server/rooms.ts routes the `lot-*` messages
 * here); one world for every room.
 *
 * - **Leases.** A client streaming a lot in asks for it and, if nobody holds it, becomes its
 *   holder: it simulates the lot's Bits in full and sends the pool back while the lot is in
 *   view and when it lets go. A lease lapses `leaseMs` after the holder's last word, or when it
 *   disconnects. Other clients near the lot get the pool to draw but do not hold it.
 * - **Away.** Every `tick` the relay carries each lot nobody holds forward by the time since
 *   it last moved, with the same genetics the clients run (`advancePool`, src/sim/evolution.ts).
 * - **Reseeding.** A restarted relay (a free Render instance loses its memory when it sleeps or
 *   redeploys) takes the pools clients offer from their own saved copies, for lots it lacks.
 *
 * Everything that arrives is decoded and range-checked; at most `maxLots` lots are kept (the
 * least recently touched go first).
 */
import { seededRand } from '../src/people/genome.ts';
import { advancePool, decodePools, DEFAULT_EVOLUTION, encodePools, EVOLUTION, fromBase64, MAX_LOT_PEOPLE, toBase64, type StoredLot } from '../src/sim/evolution.ts';

export interface WorldOptions {
  now?: () => number;
  /** A lease lapses this long after the holder's last word (ms). */
  leaseMs?: number;
  /** Most lots kept. */
  maxLots?: number;
  /** The longest absence an offered pool is carried forward for (s). */
  maxAway?: number;
}

interface Entry {
  lot: StoredLot;
  holder: string | null;
  heldUntil: number;
  /** When the lot was last carried forward (or pushed) (ms). */
  at: number;
  /** Ticks it has been carried forward (seeds its stream). */
  ticks: number;
}

/** A lot that arrived over the wire, checked: null if it is not one lot's worth of plausible Bits. */
export function checkLot(lot: StoredLot | undefined, key?: number): StoredLot | null {
  if (!lot || (key !== undefined && lot.key !== key)) return null;
  if (lot.capacity < 1 || lot.capacity > MAX_LOT_PEOPLE || lot.people.length > lot.capacity) return null;
  for (const p of lot.people) if (!(p.life > 0 && p.age >= 0 && p.energy >= 0 && p.energy <= 1.5)) return null;
  return lot;
}

export class World {
  readonly lots = new Map<number, Entry>();
  readonly startedAt: number;
  births = 0;
  deaths = 0;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly maxLots: number;
  private readonly maxAway: number;

  constructor(opts: WorldOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.maxLots = opts.maxLots ?? 30_000;
    this.maxAway = opts.maxAway ?? 30 * EVOLUTION.lifespan;
    this.startedAt = this.now();
  }

  /** Seconds the world has been running. */
  get uptime(): number {
    return (this.now() - this.startedAt) / 1000;
  }

  /** Carry every lot nobody holds forward to now; lapse stale leases. */
  tick(): void {
    const now = this.now();
    for (const [key, e] of this.lots) {
      if (e.holder && now > e.heldUntil) e.holder = null;
      if (e.holder) continue;
      this.advance(key, e, now);
    }
  }

  private advance(key: number, e: Entry, now: number): void {
    const dt = (now - e.at) / 1000;
    e.at = now;
    if (dt <= 0) return;
    const out = advancePool(e.lot, dt, seededRand(Math.imul(key + 1, 0x9e3779b1) ^ Math.imul(++e.ticks, 0x85ebca77)), DEFAULT_EVOLUTION, Infinity);
    this.births += out.births;
    for (const n of Object.values(out.deaths)) this.deaths += n ?? 0;
  }

  /** Touch a lot (most recently used last), making room if the world is full. */
  private touch(key: number, e: Entry): void {
    this.lots.delete(key);
    this.lots.set(key, e);
    while (this.lots.size > this.maxLots) {
      const [oldest] = this.lots.keys();
      this.lots.delete(oldest);
    }
  }

  /**
   * `id` streams these lots in: each comes back with its pool brought up to now (null if the
   * world has none yet: the asker registers it), and whether `id` holds it.
   */
  want(id: string, keys: readonly number[]): Array<{ key: number; pool: string | null; holder: boolean }> {
    const now = this.now();
    return keys.map((key) => {
      const e = this.lots.get(key);
      if (!e) return { key, pool: null, holder: true };
      if (e.holder && now > e.heldUntil) e.holder = null;
      if (!e.holder) this.advance(key, e, now);
      if (!e.holder || e.holder === id) {
        e.holder = id;
        e.heldUntil = now + this.leaseMs;
      }
      this.touch(key, e);
      return { key, pool: toBase64(encodePools([e.lot])), holder: e.holder === id };
    });
  }

  /** The holder's lot as it is now. False if `id` may not write it (someone else holds it, or it is malformed). */
  push(id: string, key: number, pool: string): boolean {
    const e = this.lots.get(key);
    if (e && e.holder && e.holder !== id && this.now() <= e.heldUntil) return false;
    const bytes = fromBase64(pool);
    const lots = bytes && decodePools(bytes);
    const lot = lots && lots.length === 1 ? checkLot(lots[0], key) : null;
    if (!lot) return false;
    const now = this.now();
    const next: Entry = { lot, holder: id, heldUntil: now + this.leaseMs, at: now, ticks: e?.ticks ?? 0 };
    this.touch(key, next);
    return true;
  }

  /** `id` lets go of these lots (its last push came first). */
  release(id: string, keys: readonly number[]): void {
    const now = this.now();
    for (const key of keys) {
      const e = this.lots.get(key);
      if (e?.holder === id) { e.holder = null; e.at = now; }
    }
  }

  /**
   * A Bit of lot `key` was derezzed in `id`'s game. Returns the holder to tell (someone else),
   * or null when nobody else holds the lot (then it is taken out of the pool here).
   */
  derez(id: string, key: number, slot: number): string | null {
    const e = this.lots.get(key);
    if (!e) return null;
    if (e.holder && e.holder !== id && this.now() <= e.heldUntil) return e.holder;
    if (!e.holder) {
      const i = e.lot.people.findIndex((p) => p.slot === slot);
      if (i >= 0) { e.lot.people.splice(i, 1); this.deaths++; }
    }
    return null;
  }

  /** Saved pools offered by a client: taken for lots the world lacks. Returns how many. */
  offer(pool: string, away: readonly number[]): number {
    const bytes = fromBase64(pool);
    const lots = bytes && decodePools(bytes);
    if (!lots || lots.length !== away.length) return 0;
    const now = this.now();
    let n = 0;
    lots.forEach((raw, i) => {
      const lot = checkLot(raw);
      if (!lot || this.lots.has(lot.key)) return;
      const e: Entry = { lot, holder: null, heldUntil: 0, at: now - Math.min(this.maxAway, Math.max(0, away[i])) * 1000, ticks: 0 };
      this.advance(lot.key, e, now);
      this.touch(lot.key, e);
      n++;
    });
    return n;
  }

  /** `id` left: its lots go back to the world. */
  drop(id: string): void {
    const now = this.now();
    for (const e of this.lots.values()) if (e.holder === id) { e.holder = null; e.at = now; }
  }

  stats(): { lots: number; held: number; bits: number; births: number; deaths: number; maxGen: number; uptime: number } {
    let held = 0, bits = 0, maxGen = 0;
    for (const e of this.lots.values()) {
      if (e.holder) held++;
      bits += e.lot.people.length;
      for (const p of e.lot.people) maxGen = Math.max(maxGen, p.gen);
    }
    return { lots: this.lots.size, held, bits, births: this.births, deaths: this.deaths, maxGen, uptime: Math.round(this.uptime) };
  }
}
