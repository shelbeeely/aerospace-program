import { setGrowth } from '../arch/growth.ts';
import { advance, digest, newLiving } from '../living/advance.ts';
import { baseMap, livingPitch, livingRegions } from '../living/baseMap.ts';
import { growthOverlay } from '../living/overlay.ts';
import type { LivingState } from '../living/state.ts';
import type { Simulation } from '../sim/Simulation.ts';
import { diplomacy, type DTeam } from '../sim/diplomacy.ts';

/**
 * The living world in this browser (AGENTS.md §21). Offline it is the world: loaded from local
 * storage, caught up by the time away (up to sixty days), carried on every minute. Online the
 * relay's state is adopted whenever it arrives (the relay's world is the shared one) and carried
 * on locally between arrivals by the same pure function, so the two agree.
 *
 * What the world decided is applied to the game: the growth (the world generator builds it), the
 * districts captured (territory), which factions are at war (diplomacy). Coming back, the
 * player is told what happened while they were away, from the world's log.
 */
const KEY = 'grid.living';
/** The living world's seed (as on the relay, server/living.ts). */
const LIVING_SEED = 20261102;

interface Saved {
  v: 1;
  state: LivingState;
  /** World time the player last saw (for "while you were away"). */
  seen: number;
}

export class LivingKeeper {
  state: LivingState;
  private seen: number;
  private told = false;
  private warMask = -1;
  private captureKey = '';

  /** `say`: how to tell the player (a toast); else the simulation's notices. */
  constructor(private readonly sim: Simulation, private readonly say?: (text: string) => void) {
    const saved = LivingKeeper.load();
    const now = Date.now();
    this.state = saved?.state ?? newLiving(baseMap(), livingRegions(), livingPitch(), LIVING_SEED, now);
    this.seen = saved?.seen ?? now;
  }

  private static load(): Saved | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const d = JSON.parse(raw) as Partial<Saved>;
      return d.v === 1 && d.state && d.state.v === 1 && Array.isArray(d.state.factions) ? (d as Saved) : null;
    } catch {
      return null;
    }
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ v: 1, state: this.state, seen: this.seen } satisfies Saved));
    } catch { /* storage blocked or full: the relay keeps the shared world */ }
  }

  /** Carry the world on to now (the time away, at most sixty days at once) and apply it. */
  catchUp(now = Date.now()): number {
    const ran = advance(this.state, now, baseMap(), livingRegions(), livingPitch());
    this.apply();
    return ran;
  }

  /** The relay's state arrived: it is the shared world. */
  adopt(state: unknown): boolean {
    const s = state as LivingState;
    if (!s || s.v !== 1 || !Array.isArray(s.factions) || s.factions.length !== 3 || typeof s.time !== 'number') return false;
    // Keep the events this browser already has that the relay's snapshot left out.
    const since = s.log.length ? s.log[0].t : s.time;
    const kept = this.state.log.filter((e) => e.t < since);
    this.state = { ...s, log: [...kept, ...s.log].slice(-2000) };
    this.catchUp();
    this.tell();
    this.save();
    return true;
  }

  /** World time the player last saw (the relay sends the events since then). */
  get since(): number {
    return this.seen;
  }

  /** What changed while the player was away, once per session (after the first catch-up or adoption). */
  tell(): void {
    if (this.told) return;
    this.told = true;
    const lines = digest(this.state, this.seen);
    if (lines.length > 1 || (lines.length === 1 && !lines[0].endsWith('passed'))) {
      const text = `While you were away: ${lines.join(' · ')}`;
      if (this.say) this.say(text);
      else this.sim.announce(text);
    }
    this.seen = this.state.time;
  }

  /** The world as the game sees it: the growth, the captures, the wars. */
  private apply(): void {
    setGrowth(growthOverlay(this.state, livingRegions()));
    const territory = this.sim.groundTurrets.territory;
    const key = JSON.stringify(this.state.captures);
    if (key !== this.captureKey) {
      this.captureKey = key;
      territory.reset();
      const nc = baseMap().n / baseMap().chunkBlocks;
      for (const [c, f] of this.state.captures) territory.capture(c % nc, Math.floor(c / nc), f as DTeam);
    }
    let mask = 0;
    for (const [k, bit] of [['01', 1], ['02', 2], ['12', 4]] as const) if (this.state.relations[k].stance === 'war') mask |= bit;
    if (mask !== this.warMask) {
      const was = this.warMask;
      this.warMask = mask;
      // Wars the factions fought (or ended) among themselves; the player's own provocations stay the player's.
      for (const [a, b, bit] of [[0, 1, 1], [0, 2, 2], [1, 2, 4]] as const) {
        const on = (mask & bit) !== 0;
        if (was < 0 ? on : ((was & bit) !== 0) !== on) diplomacy.setWar(a, b, on, this.sim.time);
      }
    }
  }
}

/** Keep the living world going in this browser: caught up now, carried on every minute, saved as it goes. */
export function keepLiving(sim: Simulation, say?: (text: string) => void): LivingKeeper {
  const k = new LivingKeeper(sim, say);
  k.catchUp();
  // Offline the first catch-up tells the tale; online the relay's state may still arrive first.
  setTimeout(() => k.tell(), 4000);
  setInterval(() => { k.catchUp(); k.save(); }, 60_000);
  addEventListener('pagehide', () => k.save());
  return k;
}
