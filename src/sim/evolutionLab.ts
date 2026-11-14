import { BIT } from '../people/bit.ts';
import { GENES, type Gene, type StyleField } from '../people/genome.ts';
import { mulberry32 } from '../world/City.ts';
import { BitPopulation, kerbPoint, type BitHome, type BitThreat } from './bits.ts';
import { DEATH_CAUSES, EVOLUTION, type DeathCause } from './evolution.ts';
import { CITY } from './layout.ts';
import { terrainHeight } from './terrain.ts';
import { wrapCoord } from './layout.ts';

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
}

export const DEFAULT_LAB: LabSettings = { seed: 1, traffic: 0, blasts: 0, scarcity: 1, mutation: EVOLUTION.mutation, lifespan: EVOLUTION.lifespan, hub: 0 };

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
    this.bits = new BitPopulation({
      radius: LAB.radius, despawn: LAB.radius + 60, seed: s.seed,
      evolution: { lifespanScale: s.lifespan / EVOLUTION.lifespan, energyScale: s.scarcity, mutation: s.mutation },
    });
    this.rand = mulberry32(s.seed * 7919 + 17);
    this.time = 0;
    this.runners = [];
    this.history.length = 0;
    this.nextSample = 0;
    this.blasts = 0;
    this.lastBlast = null;
    this.threats.length = 0;
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

  private sampleNow(): void {
    const c = this.bits.census();
    const deaths = {} as Record<DeathCause, number>;
    for (const d of DEATH_CAUSES) deaths[d] = this.bits.deaths[d];
    const mean = {} as Record<Gene, number>;
    for (const g of GENES) mean[g] = c.mean[g];
    this.history.push({ t: this.time, count: c.count, maxGen: c.maxGen, meanGen: c.meanGen, lineages: c.lineages, mean, style: c.style, births: this.bits.births, deaths });
    this.nextSample = this.time + LAB.sample;
  }
}
