import { seededRand } from '../people/genome.ts';
import {
  createLiving, FACTION_NAME, FACTIONS, GOODS, pairKey,
  type BaseMap, type Convoy, type Faction, type FactionState, type Good, type LivingEvent, type LivingState, type Relation, type Site,
} from './state.ts';

/**
 * The living world, carried forward in world time (AGENTS.md §21): the factions make goods by
 * what their districts do, consume what their people need, trade surpluses for deficits by
 * convoy and cargo flight, turn prosperity into new blocks at the edges of their cities, keep
 * relations (trade builds trust; contested blocks and lost convoys cost it), sign and break
 * treaties, now and then fall out and fight over a border district, and move Bits between
 * cities along the trade routes. Damage is repaired in time.
 *
 * One fixed tick (LIVING.tickMs of world time) at a time, seeded by (seed, tick), so catching up
 * a week at once is exactly the same as living through it tick by tick. The relay advances it
 * in real time; a browser offline advances its own copy by the time it was away.
 */
export const LIVING = {
  /** World time per tick (ms), and the most a catch-up runs (ms). */
  tickMs: 10 * 60_000,
  catchUpCap: 60 * 86_400_000,
  /** Each lot makes this much of its good per tick; each lot's people need this much of every good per tick in all. */
  make: 0.01,
  /** Blocks a faction starts a day at middling prosperity (×0.5 starved .. ×1.5 thriving). */
  buildPerDay: 3,
  /** Hours each stage of a block takes: survey, roads, foundation, structure. */
  stageHours: [2, 4, 6, 12],
  /** A block costs this many hours of its faction's materials need, and credits; people leave this share of the materials for building. */
  buildHours: 1.5,
  buildShare: 0.35,
  buildCredits: 60,
  /** Build points saved up at most (a day's worth: no bursts after a shortage). */
  budgetCap: 3,
  /** Taxes: credits per unit made. */
  tax: 0.05,
  /** The share of a faction's open blocks it may develop. */
  capShare: 0.5,
  /** Convoy speeds (m/s) and handling time (h); the share sent by air (fast, small, dear). */
  roadSpeed: 25,
  airSpeed: 120,
  handlingHours: 1,
  /** Trade is agreed every so many hours (a convoy carries that long's worth); one convoy in this many carries migrants. */
  tradeHours: 6,
  migrantOdds: 10,
  /** Chance a convoy through the Outlands is lost (more in tension). */
  lossOutlands: 0.02,
  lossTension: 0.05,
  /** Trust: drift back towards 0.5 (half-life, days), gain per unit traded, loss per dispute. */
  trustHalfLife: 7,
  trustPerTrade: 0.00004,
  trustPerDispute: 0.01,
  /** Border incidents: a day's chance for a pair (more with disputes), and the trust one costs. */
  incident: 0.04,
  incidentTrust: 0.25,
  /** The war ladder: how likely tension turns to mobilising per tick, how long mobilising lasts (h), truce length (days). */
  escalate: 0.0015,
  mobiliseHours: 24,
  truceDays: 7,
  /** Repairs: hours for a crater, for a felled tower. */
  repairHours: { crater: 6, tower: 24 },
  /** Events kept (enough for a long absence's "while you were away"). */
  logSize: 2000,
} as const;

const TICKS_PER_DAY = 86_400_000 / LIVING.tickMs;
const PLAIN = 32, LOT = 0, OUTLANDS = 64;

/** What each city region makes (transport adds trade capacity instead). */
export const REGION_GOOD: Record<string, Good | null> = {
  control: 'compute', industrial: 'materials', communication: 'bandwidth', plains: 'energy',
  caverns: 'memory', 'machine-city': 'memory', transport: null,
};

/**
 * What the living world derives from the base map and its state: districts' owners, what each
 * district makes, the open blocks that could be built on. Rebuilt when owners change; growth
 * updates it in place.
 */
export class LivingIndex {
  readonly nc: number;
  /** Goods each district makes per tick (district × good), its lots, and its transport lots. */
  readonly make: Float64Array;
  readonly lots: Int32Array;
  readonly transport: Int32Array;
  /**
   * Every plain block (an open lot on the grid plains): what a city can grow into. Blocks with
   * no lot at all (OPEN) are kept clear on purpose (airfield approaches, pylons) and are never
   * built on; open lots in other regions are the city's negative space and stay so.
   */
  readonly open: number[];
  readonly developed = new Set<number>();
  readonly siteAt = new Set<number>();
  owner: Int8Array;
  /** What the world as a whole makes of each good per tick (kept current as blocks are finished). */
  private readonly worldMake: number[] = new Array<number>(GOODS.length).fill(0);
  private readonly goodOfRegion: Array<number>;

  constructor(readonly map: BaseMap, readonly regions: readonly string[], readonly pitch: number, state: LivingState) {
    const { n, chunkBlocks: cb } = map;
    this.nc = n / cb;
    this.goodOfRegion = regions.map((r) => { const g = REGION_GOOD[r]; return g ? GOODS.indexOf(g) : -1; });
    this.make = new Float64Array(this.nc * this.nc * GOODS.length);
    this.lots = new Int32Array(this.nc * this.nc);
    this.transport = new Int32Array(this.nc * this.nc);
    this.open = [];
    for (let b = 0; b < n * n; b++) {
      const k = map.kind[b];
      if (k === PLAIN) { this.open.push(b); continue; }
      if (k === LOT) this.addLot(b, map.region[b]);
    }
    for (const [b, , region] of state.developed) { this.developed.add(b); this.addLot(b, region); }
    for (const s of state.sites) this.siteAt.add(s.b);
    this.owner = Int8Array.from(map.owner);
    for (const [c, f] of state.captures) this.owner[c] = f;
  }

  /**
   * What a faction's people need of good g per tick: their share of everything made, in the
   * proportions the world as a whole makes it (so the world can balance; trade evens out the
   * factions).
   */
  need(lots: number, g: number): number {
    const all = this.worldMake.reduce((a, b) => a + b, 0) || 1;
    // People leave a share of the materials for building.
    const keep = GOODS[g] === 'materials' ? 1 - LIVING.buildShare : 1;
    return lots * LIVING.make * (this.worldMake[g] / all) * keep;
  }

  chunkOf(b: number): number {
    const n = this.map.n, cb = this.map.chunkBlocks;
    return Math.floor((b % n) / cb) + Math.floor(Math.floor(b / n) / cb) * this.nc;
  }

  addLot(b: number, region: number): void {
    const c = this.chunkOf(b);
    this.lots[c]++;
    const g = this.goodOfRegion[region] ?? -1;
    if (g >= 0) { this.make[c * GOODS.length + g] += LIVING.make; this.worldMake[g] += LIVING.make; }
    if (this.regions[region] === 'transport') this.transport[c]++;
  }

  /** Built (a lot, or developed) at block b (wrapping). */
  built(b: number): boolean {
    return this.map.kind[b] === LOT || this.developed.has(b);
  }

  neighbours(b: number): number[] {
    const n = this.map.n, gi = b % n, gj = Math.floor(b / n);
    return [((gi + 1) % n) + gj * n, ((gi + n - 1) % n) + gj * n, gi + ((gj + 1) % n) * n, gi + ((gj + n - 1) % n) * n];
  }

  /** A faction's totals: goods made per tick, lots (its people), transport lots. */
  totals(f: Faction): { make: number[]; lots: number; transport: number } {
    const make = new Array<number>(GOODS.length).fill(0);
    let lots = 0, transport = 0;
    for (let c = 0; c < this.owner.length; c++) {
      if (this.owner[c] !== f) continue;
      lots += this.lots[c];
      transport += this.transport[c];
      for (let g = 0; g < GOODS.length; g++) make[g] += this.make[c * GOODS.length + g];
    }
    return { make, lots, transport };
  }

  /** Open blocks in a faction's districts (what it could ever build on). */
  openBlocks(f: Faction): number {
    let open = 0;
    for (const b of this.open) if (this.owner[this.chunkOf(b)] === f) open++;
    return open;
  }

  /** The middle of a faction's land (district centres, a circular mean on the wrapping planet), in blocks. */
  centre(f: Faction): { x: number; z: number } {
    let sx = 0, cx = 0, sz = 0, cz = 0, k = 0;
    const T = (2 * Math.PI) / this.nc;
    for (let c = 0; c < this.owner.length; c++) {
      if (this.owner[c] !== f) continue;
      const i = c % this.nc, j = Math.floor(c / this.nc);
      sx += Math.sin(i * T); cx += Math.cos(i * T); sz += Math.sin(j * T); cz += Math.cos(j * T); k++;
    }
    if (!k) return { x: 0, z: 0 };
    const cb = this.map.chunkBlocks;
    const ang = (s: number, c: number) => ((Math.atan2(s, c) / T + this.nc) % this.nc + 0.5) * cb;
    return { x: ang(sx, cx), z: ang(sz, cz) };
  }

  /** Blocks between two points (wrapping), and whether a straight line between them crosses the Outlands. */
  route(a: { x: number; z: number }, b: { x: number; z: number }): { blocks: number; outlands: boolean } {
    const n = this.map.n;
    const d = (u: number, v: number) => { let x = (v - u) % n; if (x > n / 2) x -= n; if (x < -n / 2) x += n; return x; };
    const dx = d(a.x, b.x), dz = d(a.z, b.z);
    let outlands = false;
    for (let k = 1; k < 24 && !outlands; k++) {
      const gi = Math.floor(((a.x + (dx * k) / 24) % n + n) % n), gj = Math.floor(((a.z + (dz * k) / 24) % n + n) % n);
      if (this.map.kind[gi + gj * n] === OUTLANDS) outlands = true;
    }
    return { blocks: Math.hypot(dx, dz), outlands };
  }
}

/** A fresh living world on this map: each faction's growth cap is a share of its open blocks. */
export function newLiving(map: BaseMap, regions: readonly string[], pitch: number, seed: number, time: number): LivingState {
  const blank = createLiving(seed, time, [0, 0, 0]);
  const idx = new LivingIndex(map, regions, pitch, blank);
  for (const f of FACTIONS) {
    const t = idx.totals(f);
    blank.factions[f].cap = Math.floor(idx.openBlocks(f) * LIVING.capShare);
    // Three days of what its people need, of everything.
    GOODS.forEach((g, gi) => { blank.factions[f].stock[g] = idx.need(t.lots, gi) * 3 * TICKS_PER_DAY; });
  }
  return blank;
}

/** Carry the world forward to `toMs` (at most LIVING.catchUpCap at once). Returns the ticks run. */
export function advance(state: LivingState, toMs: number, map: BaseMap, regions: readonly string[], pitch: number): number {
  const until = Math.min(toMs, state.time + LIVING.catchUpCap);
  let idx = new LivingIndex(map, regions, pitch, state);
  let ran = 0;
  while (state.time + LIVING.tickMs <= until) {
    state.time += LIVING.tickMs;
    state.tick++;
    if (tick(state, idx)) idx = new LivingIndex(map, regions, pitch, state);
    ran++;
  }
  return ran;
}

/** Report damage to be repaired (a crater, a felled tower) at world time `now`. */
export function reportDamage(state: LivingState, id: string, kind: 'crater' | 'tower', now: number): void {
  if (state.repairs.some((r) => r.id === id)) return;
  state.repairs.push({ id, kind, at: now + LIVING.repairHours[kind] * 3_600_000 });
}

function log(state: LivingState, e: Omit<LivingEvent, 't'>): void {
  state.log.push({ t: state.time, ...e });
  if (state.log.length > LIVING.logSize) state.log.splice(0, state.log.length - LIVING.logSize);
}

const fname = (f: number) => FACTION_NAME[f];
const fmt = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : x.toFixed(0));

/** One tick. Returns true when owners changed (the index is rebuilt). */
function tick(state: LivingState, idx: LivingIndex): boolean {
  const rand = seededRand((Math.imul(state.seed, 0x9e3779b1) ^ Math.imul(state.tick, 0x85ebca77)) >>> 0);
  const t = state.time;
  const tot = FACTIONS.map((f) => idx.totals(f));
  const day = state.tick % TICKS_PER_DAY === 0;
  let ownersChanged = false;

  // 1. Make, tax, consume; prosperity follows how well needs were met.
  for (const f of FACTIONS) {
    const F = state.factions[f], T = tot[f];
    let need = 0, met = 0;
    GOODS.forEach((g, gi) => {
      F.stock[g] += T.make[gi];
      state.totals.produced[g] += T.make[gi];
      F.treasury += T.make[gi] * LIVING.tax;
      state.totals.taxed += T.make[gi] * LIVING.tax;
      const want = idx.need(T.lots, gi);
      const eat = Math.min(want, F.stock[g]);
      F.stock[g] -= eat;
      state.totals.consumed[g] += eat;
      need += want;
      met += eat;
    });
    const k = 1 - Math.pow(0.5, 1 / TICKS_PER_DAY); // half-life a day
    F.prosperity += ((need > 0 ? met / need : 1) - F.prosperity) * k;
  }

  // 2. Trade (every few hours): surpluses for deficits, between factions not at war or under embargo.
  const tradeTicks = (LIVING.tradeHours * 3_600_000) / LIVING.tickMs;
  const worldMake = GOODS.map((_, gi) => tot.reduce((a, T) => a + T.make[gi], 0));
  const worldNeed = GOODS.map((_, gi) => tot.reduce((a, T) => a + idx.need(T.lots, gi), 0));
  const centres = state.tick % tradeTicks === 0 ? FACTIONS.map((f) => idx.centre(f)) : [];
  const capacity = FACTIONS.map((f) => (tot[f].transport * LIVING.make * 6 + tot[f].lots * LIVING.make * 0.2) * tradeTicks);
  const used = [0, 0, 0];
  if (state.tick % tradeTicks === 0) GOODS.forEach((g, gi) => {
    const price = Math.max(0.5, Math.min(3, worldNeed[gi] / Math.max(1e-6, worldMake[gi])));
    // What a faction keeps in store: two days of its people's needs, and for materials, two blocks' worth to build with.
    const reserve = (f: Faction) => idx.need(tot[f].lots, gi) * TICKS_PER_DAY * 2 + (g === 'materials' ? 2 * buildCost(idx, tot[f].lots) : 0);
    for (const buyer of FACTIONS) {
      const B = state.factions[buyer];
      const short = reserve(buyer) - B.stock[g] - inTransit(state, buyer, g);
      if (short <= 0) continue;
      for (const seller of FACTIONS) {
        if (seller === buyer) continue;
        const rel = state.relations[pairKey(buyer, seller)];
        if (rel.stance === 'war' || rel.stance === 'mobilising' || rel.treaty === 'embargo') continue;
        const S = state.factions[seller];
        const spare = S.stock[g] - reserve(seller);
        if (spare <= 0) continue;
        const room = Math.min(capacity[seller] - used[seller], capacity[buyer] - used[buyer]) * (rel.treaty === 'alliance' ? 2 : rel.treaty === 'pact' ? 1.5 : 1) * (rel.stance === 'tension' ? 0.5 : 1);
        const affordable = B.treasury / price;
        const amount = Math.min(spare, short, room, affordable);
        if (amount < 1) continue;
        used[seller] += amount;
        used[buyer] += amount;
        S.stock[g] -= amount;
        const air = B.prosperity < 0.5 && rand() < 0.3;
        const r = idx.route(centres[seller], centres[buyer]);
        const metres = r.blocks * idx.pitch;
        const hours = metres / (air ? LIVING.airSpeed : LIVING.roadSpeed) / 3600 + LIVING.handlingHours * (air ? 0.5 : 1);
        const c: Convoy = {
          id: state.nextId++, from: seller, to: buyer, good: g, amount, price: price * (air ? 1.5 : 1), mode: air ? 'air' : 'road',
          departs: t, arrives: t + hours * 3_600_000, migrants: !air && rand() < 1 / LIVING.migrantOdds ? 1 + Math.floor(rand() * 3) : 0, outlands: !air && r.outlands,
        };
        state.convoys.push(c);
        rel.trade += amount;
        break;
      }
    }
  });

  // 3. Convoys arrive (paid on arrival), or are lost on the way.
  for (let k = state.convoys.length - 1; k >= 0; k--) {
    const c = state.convoys[k];
    if (c.arrives > t) continue;
    state.convoys.splice(k, 1);
    const rel = state.relations[pairKey(c.from, c.to)];
    const risk = (c.outlands ? LIVING.lossOutlands : 0) + (rel.stance === 'tension' ? LIVING.lossTension : 0);
    if (rand() < risk) {
      state.totals.lost[c.good] += c.amount;
      rel.disputes += 1;
      rel.trust = Math.max(0, rel.trust - LIVING.trustPerDispute * 2);
      log(state, { kind: 'convoyLost', factions: [c.from, c.to], text: `A ${fname(c.from)} convoy of ${fmt(c.amount)} ${c.good} for ${fname(c.to)} was lost${c.outlands ? ' in the Outlands' : ''}` });
      continue;
    }
    const B = state.factions[c.to], S = state.factions[c.from];
    const pay = Math.min(B.treasury, c.amount * c.price);
    B.treasury -= pay;
    S.treasury += pay;
    B.stock[c.good] += c.amount;
    rel.trust = Math.min(1, rel.trust + c.amount * LIVING.trustPerTrade * (rel.stance === 'tension' ? 0.5 : 1));
    if (c.migrants) state.migrants[c.from][c.to] += c.migrants;
  }

  // 4. Growth: each faction saves build points by prosperity and starts blocks at its edges.
  for (const f of FACTIONS) {
    const F = state.factions[f];
    F.budget = Math.min(LIVING.budgetCap, F.budget + (LIVING.buildPerDay / TICKS_PER_DAY) * (0.5 + F.prosperity));
    const matNeed = buildCost(idx, tot[f].lots);
    while (F.budget >= 1 && F.built + sitesOf(state, f) < F.cap && F.stock.materials >= matNeed && F.treasury >= LIVING.buildCredits) {
      const b = chooseBlock(state, idx, f, rand, tot[f]);
      if (b < 0) { F.budget = Math.min(F.budget, 1); break; }
      F.budget -= 1;
      F.stock.materials -= matNeed;
      state.totals.built.materials += matNeed;
      F.treasury -= LIVING.buildCredits;
      state.totals.spent += LIVING.buildCredits;
      const region = regionFor(idx, b);
      const s: Site = { b, f, stage: 0, since: t, region };
      state.sites.push(s);
      idx.siteAt.add(b);
      // Next to another faction's district: a contested edge.
      for (const nb of idx.neighbours(b)) {
        const other = idx.owner[idx.chunkOf(nb)];
        if (other >= 0 && other !== f) {
          const rel = state.relations[pairKey(f, other)];
          rel.disputes += 1;
          rel.trust = Math.max(0, rel.trust - LIVING.trustPerDispute);
          break;
        }
      }
    }
  }
  for (let k = state.sites.length - 1; k >= 0; k--) {
    const s = state.sites[k];
    if (t - s.since < LIVING.stageHours[s.stage] * 3_600_000) continue;
    s.stage++;
    s.since = t;
    if (s.stage < LIVING.stageHours.length) continue;
    state.sites.splice(k, 1);
    idx.siteAt.delete(s.b);
    // A district may have changed hands while it was built: the block goes to whoever holds it now.
    const holder = idx.owner[idx.chunkOf(s.b)];
    const f = (holder >= 0 ? holder : s.f) as Faction;
    state.developed.push([s.b, f, s.region, t]);
    idx.developed.add(s.b);
    idx.addLot(s.b, s.region);
    state.factions[f].built++;
    log(state, { kind: 'built', factions: [f], at: s.b, text: `${fname(f)} finished a ${idx.regions[s.region] ?? 'new'} block at ${s.b % idx.map.n},${Math.floor(s.b / idx.map.n)}` });
  }

  // 5. Relations: trust drifts back to the middle; treaties follow trust; the war ladder, rarely.
  const drift = 1 - Math.pow(0.5, 1 / (LIVING.trustHalfLife * TICKS_PER_DAY));
  for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as Array<[Faction, Faction]>) {
    const rel = state.relations[pairKey(a, b)];
    rel.trust += (0.5 - rel.trust) * drift;
    rel.disputes *= 1 - 1 / (3 * TICKS_PER_DAY);
    rel.trade *= 1 - 1 / TICKS_PER_DAY;
    // Now and then a border incident, likelier where the two keep contesting the same edges.
    if (day && rel.stance === 'peace' && rand() < LIVING.incident * (1 + Math.min(3, rel.disputes / 3))) {
      rel.trust = Math.max(0, rel.trust - LIVING.incidentTrust * (0.5 + rand()));
      rel.disputes += 2;
      log(state, { kind: 'stance', factions: [a, b], text: `A border incident between ${fname(a)} and ${fname(b)}` });
    }
    if (relations(state, idx, rel, a, b, rand, tot)) ownersChanged = true;
  }

  // 6. Repairs come due.
  const due = state.repairs.filter((r) => r.at <= t);
  if (due.length) {
    state.repairs = state.repairs.filter((r) => r.at > t);
    const craters = due.filter((r) => r.kind === 'crater').length, towers = due.length - craters;
    log(state, { kind: 'repair', factions: [], text: `Repaired ${[craters && `${craters} crater${craters > 1 ? 's' : ''}`, towers && `${towers} tower${towers > 1 ? 's' : ''}`].filter(Boolean).join(' and ')}` });
  }

  // 7. Once a day: the day's trade and migration, in the log.
  if (day) {
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
      const rel = state.relations[pairKey(a, b)];
      if (rel.trade > 1) log(state, { kind: 'trade', factions: [a, b], text: `${fname(a)} and ${fname(b)} traded ${fmt(rel.trade)} units` });
    }
  }
  return ownersChanged;
}

/** The materials a block costs a faction of this size. */
function buildCost(idx: LivingIndex, lots: number): number {
  return (idx.need(lots, GOODS.indexOf('materials')) / (1 - LIVING.buildShare)) * (LIVING.buildHours * 3_600_000) / LIVING.tickMs;
}

function inTransit(state: LivingState, to: Faction, g: Good): number {
  let s = 0;
  for (const c of state.convoys) if (c.to === to && c.good === g) s += c.amount;
  return s;
}

const sitesOf = (state: LivingState, f: Faction) => state.sites.reduce((n, s) => n + (s.f === f ? 1 : 0), 0);

/**
 * The faction's commander picks the next block (the scripted rule; a network takes over in W5):
 * an open block in its own district next to built ones, preferring more built neighbours and a
 * region that makes the good it is shortest of, with a little seeded variety.
 */
function chooseBlock(state: LivingState, idx: LivingIndex, f: Faction, rand: () => number, T: { make: number[]; lots: number }): number {
  void state;
  // The good it makes least of against what its people need.
  const cover = (gi: number) => T.make[gi] / Math.max(1e-9, idx.need(T.lots, gi));
  const shortest = GOODS.reduce((best, g, gi) => (cover(gi) < cover(GOODS.indexOf(best)) ? g : best), GOODS[0]);
  let best = -1, bestScore = -Infinity;
  for (const b of idx.open) {
    if (idx.developed.has(b) || idx.siteAt.has(b) || idx.owner[idx.chunkOf(b)] !== f) continue;
    const nb = idx.neighbours(b);
    const builtNear = nb.filter((x) => idx.built(x)).length;
    if (!builtNear) continue;
    const region = regionFor(idx, b);
    const good = REGION_GOOD[idx.regions[region]] ?? null;
    const score = builtNear * 2 + (good === shortest ? 3 : 0) + rand();
    if (score > bestScore) { bestScore = score; best = b; }
  }
  return best;
}

/** What a new block becomes: the region most of its built neighbours belong to (else its own). */
function regionFor(idx: LivingIndex, b: number): number {
  const counts = new Map<number, number>();
  for (const nb of idx.neighbours(b)) if (idx.built(nb)) {
    const r = idx.map.kind[nb] === LOT ? idx.map.region[nb] : idx.map.region[nb];
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let best = idx.map.region[b], n = 0;
  for (const [r, k] of counts) if (k > n || (k === n && r < best)) { best = r; n = k; }
  return best;
}

/** One pair's relations for a tick. Returns true when a district changed hands. */
function relations(state: LivingState, idx: LivingIndex, rel: Relation, a: Faction, b: Faction, rand: () => number, tot: Array<{ make: number[] }>): boolean {
  const t = state.time, hours = (t - rel.since) / 3_600_000;
  const set = (stance: Relation['stance'], text: string) => {
    rel.stance = stance;
    rel.since = t;
    log(state, { kind: 'stance', factions: [a, b], text });
  };
  const treaty = (tr: Relation['treaty'], text: string) => {
    rel.treaty = tr;
    rel.treatySince = t;
    log(state, { kind: 'treaty', factions: [a, b], text });
  };
  const pair = `${fname(a)} and ${fname(b)}`;
  // Treaties follow trust, at peace.
  if (rel.stance === 'peace') {
    if (rel.treaty === 'none' && rel.trust > 0.7 && rand() < 0.01) treaty('pact', `${pair} signed a trade pact`);
    else if (rel.treaty === 'pact' && rel.trust > 0.85 && (t - rel.treatySince) > 7 * 86_400_000 && rand() < 0.01) treaty('alliance', `${pair} became allies`);
    else if ((rel.treaty === 'pact' || rel.treaty === 'alliance') && rel.trust < 0.45) treaty('none', `${pair} let their ${rel.treaty === 'alliance' ? 'alliance' : 'trade pact'} lapse`);
    else if (rel.treaty === 'embargo' && rel.trust > 0.35) treaty('none', `${pair} lifted their embargo`);
  }
  switch (rel.stance) {
    case 'peace':
      if (rel.trust < 0.35 && rel.disputes > 2) set('tension', `Tension between ${pair} over contested blocks`);
      break;
    case 'tension':
      if (rel.trust > 0.4) set('peace', `${pair} settled their differences`);
      else if (rel.treaty !== 'embargo' && rel.trust < 0.2 && rand() < 0.01) treaty('embargo', `${fname(a)} and ${fname(b)} declared an embargo`);
      else if (rel.trust < 0.3 && rand() < LIVING.escalate) set('mobilising', `${pair} are mobilising`);
      break;
    case 'mobilising':
      if (rel.trust > 0.35) set('tension', `${pair} stood down`);
      else if (hours >= LIVING.mobiliseHours) {
        if (rel.treaty === 'pact' || rel.treaty === 'alliance') treaty('none', `${pair} tore up their treaty`);
        set('war', `War between ${pair}`);
      }
      break;
    case 'war': {
      // Once a day, the stronger side may take a border district from the weaker.
      let changed = false;
      if (state.tick % TICKS_PER_DAY === 0) {
        const strength = (f: Faction) => (tot[f].make[GOODS.indexOf('compute')] + tot[f].make[GOODS.indexOf('materials')]) * state.factions[f].prosperity;
        const [win, lose] = strength(a) * (0.8 + rand() * 0.4) >= strength(b) * (0.8 + rand() * 0.4) ? [a, b] : [b, a];
        const border: number[] = [];
        for (let c = 0; c < idx.owner.length; c++) {
          if (idx.owner[c] !== lose) continue;
          const i = c % idx.nc, j = Math.floor(c / idx.nc);
          const nb = [((i + 1) % idx.nc) + j * idx.nc, ((i + idx.nc - 1) % idx.nc) + j * idx.nc, i + ((j + 1) % idx.nc) * idx.nc, i + ((j + idx.nc - 1) % idx.nc) * idx.nc];
          if (nb.some((x) => idx.owner[x] === win)) border.push(c);
        }
        if (border.length && rand() < 0.5) {
          const c = border[Math.floor(rand() * border.length)];
          const k = state.captures.findIndex(([x]) => x === c);
          if (idx.map.owner[c] === win) { if (k >= 0) state.captures.splice(k, 1); }
          else if (k >= 0) state.captures[k][1] = win;
          else state.captures.push([c, win]);
          idx.owner[c] = win;
          changed = true;
          log(state, { kind: 'capture', factions: [win, lose], at: c, text: `${fname(win)} took a district from ${fname(lose)} (${c % idx.nc},${Math.floor(c / idx.nc)})` });
        }
      }
      const days = hours / 24;
      if (rand() < Math.min(0.02, 0.0005 * days)) set('truce', `${pair} agreed a truce`);
      return changed;
    }
    case 'truce':
      if (hours >= LIVING.truceDays * 24) { rel.trust = Math.max(rel.trust, 0.45); set('peace', `${pair} are at peace`); }
      break;
  }
  return false;
}

/**
 * "While you were away": the log since `since`, gathered up (blocks built per faction, treaties,
 * stances, captures, trade, lost convoys, migration, repairs). Built only from recorded events.
 */
export function digest(state: LivingState, since: number): string[] {
  const ev = state.log.filter((e) => e.t > since);
  const out: string[] = [];
  const days = (state.time - since) / 86_400_000;
  if (days > 0.04) out.push(days >= 1 ? `${days.toFixed(days < 10 ? 1 : 0)} days have passed` : `${Math.round(days * 24)} hours have passed`);
  const built = FACTIONS.map((f) => ev.filter((e) => e.kind === 'built' && e.factions[0] === f).length);
  const parts = FACTIONS.filter((f) => built[f]).map((f) => `${fname(f)} ${built[f]}`);
  if (parts.length) out.push(`Blocks built: ${parts.join(', ')}`);
  for (const e of ev) if (e.kind === 'treaty' || e.kind === 'stance' || e.kind === 'capture') out.push(e.text);
  const lost = ev.filter((e) => e.kind === 'convoyLost').length;
  if (lost) out.push(`${lost} convoy${lost > 1 ? 's' : ''} lost`);
  return out;
}

/** The faction totals as the UI shows them. */
export function factionSummary(state: LivingState, idx: LivingIndex, f: Faction): FactionState & { lots: number } {
  return { ...state.factions[f], lots: idx.totals(f).lots };
}
