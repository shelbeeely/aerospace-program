import type { BitPopulation } from '../sim/bits.ts';
import { decodePools, encodePools, fromBase64, toBase64, type StoredLot } from '../sim/evolution.ts';

/**
 * The Bits' gene pools kept in this browser, so evolution carries on between sessions: every
 * lot's people as they were last seen, and how long ago. On load each lot is carried forward by
 * the real time it was away (capped at a few lifespans, `advancePool`). Fails soft when storage
 * is blocked or full. The relay keeps the shared world; this is the local copy (offline play,
 * and what a restarted relay is reseeded from).
 */
const KEY = 'grid.bits.pools';
/** Most lots kept (the most recently seen): about a megabyte at most. */
const MAX_LOTS = 1500;

interface Saved {
  v: 1;
  /** Wall-clock time of the save (ms). */
  savedAt: number;
  /** encodePools, base64. */
  pools: string;
  /** Seconds each lot had been out of view at the save, in the same order. */
  away: number[];
}

/** Save the population's pools. Returns how many lots were kept (0 if storage refused). */
export function saveBitPools(bits: BitPopulation, now = Date.now()): number {
  const lots = bits.exportPools().sort((a, b) => a.away - b.away).slice(0, MAX_LOTS);
  const data: Saved = { v: 1, savedAt: now, pools: toBase64(encodePools(lots)), away: lots.map((l) => Math.round(l.away)) };
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return lots.length;
  } catch {
    return 0;
  }
}

/** The saved lots, each with the seconds it has been away until `now`; [] if none or unreadable. */
export function loadBitPools(now = Date.now()): Array<StoredLot & { away: number }> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const d = JSON.parse(raw) as Partial<Saved>;
    if (d.v !== 1 || typeof d.pools !== 'string' || !Array.isArray(d.away) || typeof d.savedAt !== 'number') return [];
    const bytes = fromBase64(d.pools);
    const lots = bytes && decodePools(bytes);
    if (!lots) return [];
    const since = Math.max(0, (now - d.savedAt) / 1000);
    return lots.map((l, i) => ({ ...l, away: Math.max(0, Number(d.away![i]) || 0) + since }));
  } catch {
    return [];
  }
}

/** Forget the saved pools (the K inspector's "Reset evolution"). */
export function clearBitPools(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

/**
 * Keep `bits` saved: load what this browser remembers into it, then save every minute and when
 * the page is hidden. Returns how many lots were loaded.
 */
export function keepBitPools(bits: BitPopulation): number {
  const n = bits.importPools(loadBitPools());
  setInterval(() => saveBitPools(bits), 60_000);
  const save = () => saveBitPools(bits);
  addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
  return n;
}
