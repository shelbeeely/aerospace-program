/**
 * The living world on the relay (AGENTS.md §21): the canonical state, carried forward in real
 * time whether anyone is connected or not, kept on the disk so a restart or a redeploy picks up
 * where it left off, and handed to every client that joins the world.
 *
 * - Advanced every minute (`tick`) by the same pure function the browsers use
 *   (src/living/advance.ts), on the shipped planet map (src/living/baseMap.json): the relay
 *   does not carry the world generator.
 * - Saved to `<dataDir>/living.json` after it changes (write a temporary file, then rename, so a
 *   crash never leaves half a file). No data directory: it lives in memory only.
 * - `snapshot(since)`: the state for a client, with the events since `since` (or the latest few
 *   hundred), so "while you were away" can be told.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { advance, newLiving } from '../src/living/advance.ts';
import { readShippedMap, type ShippedMap } from '../src/living/shippedMap.ts';
import type { LivingState } from '../src/living/state.ts';
import shipped from '../src/living/baseMap.json' with { type: 'json' };

/** The living world's seed (the same for every relay and every browser). */
export const LIVING_SEED = 20261102;

export class LivingHost {
  state: LivingState;
  readonly m: ShippedMap;
  private dirty = false;
  private readonly file: string | null;
  /** Why the last save failed (a disk not writable, full...), for /health; null when saving works. */
  saveError: string | null = null;

  constructor(opts: { dataDir?: string | null; now?: number; map?: ShippedMap } = {}) {
    const m = opts.map ?? readShippedMap(shipped);
    if (!m) throw new Error('living: the shipped planet map is missing or broken (npm run living-map)');
    this.m = m;
    this.file = opts.dataDir ? `${opts.dataDir}/living.json` : null;
    const loaded = this.file && existsSync(this.file) ? LivingHost.read(this.file) : null;
    this.state = loaded ?? newLiving(m.map, m.regions, m.pitch, LIVING_SEED, opts.now ?? Date.now());
    if (!loaded) this.dirty = true;
  }

  private static read(file: string): LivingState | null {
    try {
      const s = JSON.parse(readFileSync(file, 'utf8')) as LivingState;
      return s && s.v === 1 && typeof s.time === 'number' && Array.isArray(s.factions) && s.factions.length === 3 ? s : null;
    } catch {
      return null;
    }
  }

  /** Carry the world forward to `now`. Returns the ticks run. */
  tick(now = Date.now()): number {
    const ran = advance(this.state, now, this.m.map, this.m.regions, this.m.pitch);
    if (ran) this.dirty = true;
    return ran;
  }

  /**
   * Save it if it changed (atomically). Never throws: a disk that cannot be written is reported
   * (`saveError`, /health) and the world carries on in memory.
   */
  save(): boolean {
    if (!this.file || !this.dirty) return false;
    try {
      const dir = this.file.slice(0, this.file.lastIndexOf('/'));
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.file);
      this.dirty = false;
      this.saveError = null;
      return true;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (why !== this.saveError) console.error(`[grid] living world not saved: ${why}`);
      this.saveError = why;
      return false;
    }
  }

  /** The state for a client: everything but the log, and the events since `since` (else the last 300). */
  snapshot(since?: number): LivingState {
    const log = typeof since === 'number' && since > 0 ? this.state.log.filter((e) => e.t > since) : this.state.log.slice(-300);
    return { ...this.state, log };
  }

  /** For /health: the world's time, blocks built, sites, convoys, stances. */
  stats(): { time: number; tick: number; built: number[]; sites: number; convoys: number; stances: Record<string, string>; saved: boolean; saveError: string | null } {
    const s = this.state;
    return {
      time: s.time, tick: s.tick, built: s.factions.map((f) => f.built), sites: s.sites.length, convoys: s.convoys.length,
      stances: Object.fromEntries(Object.entries(s.relations).map(([k, r]) => [k, `${r.stance}/${r.treaty}`])),
      saved: !!this.file && !this.saveError, saveError: this.saveError,
    };
  }
}
