import { seasonOf } from '../brain/season.ts';
import type { StyleBook } from '../brain/style.ts';

/**
 * What each side has learned about how you fly, kept in this browser for the season
 * (src/brain/style.ts, src/brain/season.ts): load it at start, save it every 20 s and when the
 * page goes away. A new season starts with a clean slate. Fails soft when storage is blocked or
 * full; nothing here leaves the browser.
 */
const KEY = 'grid.style';

interface Saved {
  v: 1;
  season: number;
  savedAt: number;
  sides: ReturnType<StyleBook['toJSON']>;
}

export function saveStyle(book: StyleBook, now = Date.now()): boolean {
  const data: Saved = { v: 1, season: seasonOf(now).id, savedAt: now, sides: book.toJSON() };
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** Load this season's memory into `book`. False if there is none (or it belongs to another season). */
export function loadStyle(book: StyleBook, now = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const d = JSON.parse(raw) as Partial<Saved>;
    if (d.v !== 1 || d.season !== seasonOf(now).id || !d.sides) return false;
    book.load(d.sides);
    return true;
  } catch {
    return false;
  }
}

export function clearStyle(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

/** Keep `book` saved for the season. */
export function keepStyle(book: StyleBook): void {
  loadStyle(book);
  setInterval(() => saveStyle(book), 20_000);
  addEventListener('pagehide', () => saveStyle(book));
}
