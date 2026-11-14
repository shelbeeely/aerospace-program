import { BIT } from '../people/bit.ts';
import { GENES, type Gene, type StyleField } from '../people/genome.ts';
import { mulberry32 } from '../world/City.ts';
import { BitPopulation, kerbPoint, type BitHome, type BitThreat } from './bits.ts';
import { DEATH_CAUSES, EVOLUTION, type DeathCause } from './evolution.ts';
import { CITY } from './layout.ts';
import { terrainHeight } from './terrain.ts';
import { wrapCoord } from './layout.ts';
import { kerbNear, Sappers, SAPPERS, type BattleTarget, type BattleWorld, type ChargeKind } from './sappers.ts';
import { lotAt } from '../arch/DistrictGenerator.ts';
import { GRID } from '../world/planetCity.ts';

/**
 * The Evolution Lab: one downtown district of the real world, its real lots, rooms and Bits,
 * run fast under pressures you set, to watch the Bits evolve over hundreds of generations.
 * The same `BitPopulation` the game streams (src/sim/bits.ts), so what evolves here is what
 * would evolve in the city.
 *
 * - **Kerb traffic:** light cycles that turn in at a lot's corner and cut along its kerb at
 *   40 m/s. A Bit that flinches in time steps back off the kerb and lives; a bold one may be too
 *   late.
 * - **Blasts:** something goes off on a kerb now and then. Indoors is the only safe place.
 * - **Scarcity:** walking costs more energy.
 * - **War:** three enemy towers stand in districts beyond the lab's, defended as strongly as
 *   you set. The district drafts sappers (src/sim/sappers.ts) to set charges at their feet;
 *   a charge that goes off takes the tower down for two minutes.
 * - Mutation rate and lifespan (a short life is a fast generation).
 *
 * Seeded: the same settings and seed give the same history. DOM- and scene-free; the explorer's
 * Evo view draws it and src/ui/EvolutionPanel.ts charts it.
 */
export interface LabSettings {
  seed: number;
  /** Kerb runs per lot per minute. */
  traffic: number;
  /** Blasts per minute across the district. */
  blasts: number;
  /** Energy drain multiplier (1 is the city's). */
  scarcity: number;
  /** Chance per gene of a copying error. */
  mutation: number;
  /** Mean lifespan (s). */
  lifespan: number;
  /** Which downtown hub the lab stands in. */
  hub: number;
  /** War: how strongly the enemy towers are defended (0..1); 0 is peace (no towers, no draft). */
  war: number;
}

export const DEFAULT_LAB: LabSettings = { seed: 1, traffic: 0, blasts: 0, scarcity: 1, mutation: EVOLUTION.mutation, lifespan: EVOLUTION.lifespan, hub: 0, war: 0 };

export const LAB = {
  /** Streamed radius round the lab's centre (m). */
  radius: 260,
  /** Kerb-runner speed (m/s) and how far round the kerb it runs (share of the loop). */
  runnerSpeed: 60,
  runnerReach: 0.6,
  /** Blast: derez radius and scare radius (m). */
  blastRadius: 5,
  blastScare: 40,
  /** Census every this many simulated seconds. */
  sample: 10,
  /** The step the lab thinks at (s), as the game's people do. */
  dt: 0.2,
} as const;

export interface LabSample {
  /** Simulated time (s). */
  t: number;
  count: number;
  maxGen: number;
  meanGen: number;
  lineages: number;
  mean: Record<Gene, number>;
  style: { [F in StyleField]: Record<string, number> };
  births: number;
  deaths: Record<DeathCause, number>;
  /** Share of the people able to set each charge (by craft), and the sappers' record so far. */
  tiers: Record<ChargeKind, number>;
  combat: { sent: number; set: number; shot: number; duds: number; home: number };
}

interface Runner {
  home: BitHome;
  s: number;
  dir: 1 | -1;
  left: number;
  /** Steps run so far: it is a danger from its second (the first has no stretch behind it). */
  steps: number;
}

export class EvolutionLab {
  settings: LabSettings;
  bits!: BitPopulation;
  /** Where the district is (the streamed disc's centre). */
  centre = { x: 0, z: 0 };
  time = 0;
  readonly history: LabSample[] = [];
  private runners: Runner[] = [];
  private rand: () => number = mulberry32(0);
  private nextSample = 0;
  /** Blasts this run, and where the last went off (the view flashes it). */
  blasts = 0;
  lastBlast: { x: number; y: number; z: number; time: number } | null = null;
  readonly threats: BitThreat[] = [];
  /** War: the sappers, the enemy towers (down until when), and charges set by tier. */
  readonly sappers = new Sappers({ max: 24, perLot: 4, chance: 0.4 });
  towers: Array<BattleTarget & { downUntil: number }> = [];
  readonly charges: Record<ChargeKind, number> = { demo: 0, emp: 0, nuke: 0 };
  private readonly battle: BattleWorld = {
    sideAt: (x, z) => (this.settings.war > 0 && this.towers.some((t) => Math.hypot(t.baseX - x, t.baseZ - z) < 170) ? 1 : 0),
    atWar: (a, b) => this.settings.war > 0 && a !== b,
    targets: (side, x, z, reach) => (side !== 0 || this.settings.war <= 0 ? [] : this.towers.filter((t) => this.time >= t.downUntil && Math.hypot(t.x - x, t.z - z) <= reach)),
    defenceAt: () => 0.1 + 0.5 * this.settings.war,
    plant: (kind, x, _y, z, by, target) => {
      if (this.settings.war <= 0 || by !== 0 || this.battle.sideAt(x, z) !== 1) return false;
      const t = this.towers.find((q) => q.id === target.id);
      if (t) t.downUntil = this.time + 120;
      this.charges[kind]++;
      return true;
    },
    ground: (x, z) => terrainHeight(wrapCoord(x), wrapCoord(z)),
  };

  constructor(settings: Partial<LabSettings> = {}) {
    this.settings = { ...DEFAULT_LAB, ...settings };
    this.reset();
  }

  /** Start again (with new settings, if given): the district's founders, a fresh history. */
  reset(settings: Partial<LabSettings> = {}): void {
    this.settings = { ...this.settings, ...settings };
    const s = this.settings;
    const hub = CITY.hubs[((s.hub % CITY.hubs.length) + CITY.hubs.length) % CITY.hubs.length];
    this.centre = { x: hub.x, z: hub.z };
    const evolution = { lifespanScale: s.lifespan / EVOLUTION.lifespan, energyScale: s.scarcity, mutation: s.mutation };
    // One population for the lab's whole life (views hold on to it): reset, re-seeded.
    if (!this.bits) this.bits = new BitPopulation({ radius: LAB.radius, despawn: LAB.radius + 60, seed: s.seed, evolution });
    else {
      this.bits.clearEvolution();
      this.bits.opts.seed = s.seed;
      Object.assign(this.bits.opts.evolution, evolution);
      this.bits.clock = 0;
      this.bits.moves = 0;
    }
    this.rand = mulberry32(s.seed * 7919 + 17);
    this.time = 0;
    this.runners = [];
    this.history.length = 0;
    this.nextSample = 0;
    this.blasts = 0;
    this.lastBlast = null;
    this.threats.length = 0;
    this.sappers.reset();
    this.charges.demo = this.charges.emp = this.charges.nuke = 0;
    this.towers = this.placeTowers();
    this.bits.step(LAB.dt, 0, this.centre);
    this.sampleNow();
  }

  /** Change pressures mid-run (the history carries on). */
  tune(settings: Partial<LabSettings>): void {
    const s = (this.settings = { ...this.settings, ...settings });
    this.bits.opts.evolution.energyScale = s.scarcity;
    this.bits.opts.evolution.mutation = s.mutation;
    this.bits.opts.evolution.lifespanScale = s.lifespan / EVOLUTION.lifespan;
  }

  /** One step of the lab (`LAB.dt` seconds). */
  step(): void {
    const dt = LAB.dt, s = this.settings;
    this.time += dt;
    // Kerb runners: new ones start on lots at the traffic rate, run part way round, and go.
    const homes = [...this.bits.homes.values()];
    const pRun = 1 - Math.exp(-(s.traffic / 60) * dt);
    for (const h of homes) {
      if (this.rand() >= pRun) continue;
      // It turns in at a corner of the lot, as a vehicle off the cross street would.
      const wx = h.x1 - h.x0, wz = h.z1 - h.z0;
      const corners = [0, wx, wx + wz, 2 * wx + wz];
      this.runners.push({ home: h, s: corners[Math.floor(this.rand() * 4)], dir: this.rand() < 0.5 ? 1 : -1, left: h.loop * LAB.runnerReach, steps: 0 });
    }
    this.threats.length = 0;
    const k = { x: 0, z: 0, tx: 0, tz: 0 };
    for (let i = this.runners.length - 1; i >= 0; i--) {
      const r = this.runners[i];
      const d = LAB.runnerSpeed * dt;
      r.s = (((r.s + r.dir * d) % r.home.loop) + r.home.loop) % r.home.loop;
      r.left -= d;
      if (r.left <= 0 || !this.bits.homes.has(r.home.key)) { this.runners.splice(i, 1); continue; }
      if (r.steps++ === 0) continue;
      kerbPoint(r.home, r.s, 0, k);
      this.threats.push({ x: k.x, y: terrainHeight(wrapCoord(k.x), wrapCoord(k.z)) + BIT.hover, z: k.z, vx: k.tx * r.dir * LAB.runnerSpeed, vz: k.tz * r.dir * LAB.runnerSpeed });
    }
    // Blasts on the kerbs.
    if (homes.length && this.rand() < 1 - Math.exp(-(s.blasts / 60) * dt)) {
      const h = homes[Math.floor(this.rand() * homes.length)];
      kerbPoint(h, this.rand() * h.loop, 0, k);
      const y = terrainHeight(wrapCoord(k.x), wrapCoord(k.z)) + BIT.hover;
      this.bits.scare(k.x, k.z, LAB.blastScare, this.time);
      this.bits.strike(k.x, y, k.z, LAB.blastRadius, this.time);
      this.blasts++;
      this.lastBlast = { x: k.x, y, z: k.z, time: this.time };
    }
    this.bits.step(dt, this.time, this.centre, this.threats);
    this.sappers.step(dt, this.time, this.bits, this.battle, this.centre);
    this.bits.derezEvents.length = 0;
    if (this.time >= this.nextSample) this.sampleNow();
  }

  /** Run `seconds` of simulated time as fast as it goes (turbo). */
  run(seconds: number): void {
    const end = this.time + seconds;
    while (this.time < end) this.step();
  }

  /** Generations so far (the highest alive). */
  get generation(): number {
    return this.history.length ? this.history[this.history.length - 1].maxGen : 0;
  }

  /**
   * Three enemy towers on lots beyond the lab's district (220-380 m from its centre, in reach
   * of its sappers): their kerb points are the targets, their lots' centres the towers' feet.
   */
  private placeTowers(): Array<BattleTarget & { downUntil: number }> {
    const P = CITY.block + CITY.street;
    const c = this.centre, rand = mulberry32(this.settings.seed * 131 + 7);
    const found: Array<BattleTarget & { downUntil: number }> = [];
    const gi0 = Math.floor((c.x - GRID.x0) / P), gj0 = Math.floor((c.z - GRID.z0) / P);
    const cands: Array<{ x: number; z: number }> = [];
    for (let dj = -5; dj <= 5; dj++) for (let di = -5; di <= 5; di++) {
      const lot = lotAt(gi0 + di, gj0 + dj);
      if (!lot) continue;
      const x = (lot.rect.x0 + lot.rect.x1) / 2, z = (lot.rect.z0 + lot.rect.z1) / 2;
      const d = Math.hypot(x - c.x, z - c.z);
      if (d >= 220 && d <= 380 && !cands.some((q) => Math.hypot(q.x - x, q.z - z) < 60)) cands.push({ x, z });
    }
    while (found.length < 3 && cands.length) {
      const { x, z } = cands.splice(Math.floor(rand() * cands.length), 1)[0];
      const k = kerbNear(x, z);
      if (!k || Math.hypot(k.x - x, k.z - z) > 160) continue;
      // Spread round the district, so every lot has one in reach.
      if (found.some((t) => Math.hypot(t.baseX - x, t.baseZ - z) < 200)) continue;
      found.push({ id: `tower${found.length}`, side: 1, x: k.x, z: k.z, baseX: x, baseZ: z, roofY: 90, downUntil: 0 });
    }
    return found;
  }

  private sampleNow(): void {
    this.history.push(censusSample(this.bits, this.time, this.sappers));
    this.nextSample = this.time + LAB.sample;
  }
}

/** A census of a population at time `t` (and its sappers' record), as the charts read it. */
export function censusSample(bits: BitPopulation, t: number, sappers: Sappers | null = null): LabSample {
  const c = bits.census();
  const deaths = {} as Record<DeathCause, number>;
  for (const d of DEATH_CAUSES) deaths[d] = bits.deaths[d];
  const mean = {} as Record<Gene, number>;
  for (const g of GENES) mean[g] = c.mean[g];
  const n = Math.max(1, bits.people.length);
  const tiers = {
    demo: bits.people.filter((p) => p.genome.craft >= 0.4).length / n,
    emp: bits.people.filter((p) => p.genome.craft >= SAPPERS.emp).length / n,
    nuke: bits.people.filter((p) => p.genome.craft >= SAPPERS.nuke).length / n,
  };
  return { t, count: c.count, maxGen: c.maxGen, meanGen: c.meanGen, lineages: c.lineages, mean, style: c.style, births: bits.births, deaths, tiers, combat: { ...(sappers?.stats ?? { sent: 0, set: 0, shot: 0, duds: 0, home: 0 }) } };
}

/**
 * The game's census over time (the K inspector's Bits tab): a sample of the people in view every
 * `every` seconds of the population's clock, the last `keep` of them.
 */
export class CensusRecorder {
  readonly history: LabSample[] = [];
  private next = 0;
  constructor(readonly bits: BitPopulation, private readonly sappers: Sappers | null = null, private readonly every = 15, private readonly keep = 480) {}

  update(): void {
    if (this.bits.clock < this.next || this.bits.people.length === 0) return;
    this.history.push(censusSample(this.bits, this.bits.clock, this.sappers));
    if (this.history.length > this.keep) this.history.splice(0, this.history.length - this.keep);
    this.next = this.bits.clock + this.every;
  }

  clear(): void {
    this.history.length = 0;
    this.next = 0;
  }
}
