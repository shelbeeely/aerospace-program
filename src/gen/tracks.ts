/**
 * Vehicle theme tracks: generated music saved with a vehicle and played when you fly it.
 * Audio clips are megabytes, too big for the hangar's localStorage, so they live in IndexedDB,
 * keyed by the hangar entry id (or a built-in's id). Everything fails soft: no IndexedDB (private
 * mode, old browsers) just means themes last for the session.
 */
export interface Theme {
  /** Playable data URL. */
  audio: string;
  style: string;
  model: string;
  prompt: string;
  createdAt: string;
}

const DB = 'aerospace.tracks';
const STORE = 'themes';
const memory = new Map<string, Theme>();

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const r = fn(db.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function saveTheme(id: string, theme: Theme): Promise<void> {
  memory.set(id, theme);
  await tx('readwrite', (s) => s.put(theme, id));
}

export async function loadTheme(id: string): Promise<Theme | null> {
  const m = memory.get(id);
  if (m) return m;
  const t = (await tx<Theme>('readonly', (s) => s.get(id))) ?? null;
  if (t) memory.set(id, t);
  return t;
}

export async function deleteTheme(id: string): Promise<void> {
  memory.delete(id);
  await tx('readwrite', (s) => s.delete(id));
}

/** A style from the description, before the vehicle exists (the theme is composed in parallel). */
export function themeStyleForPrompt(text: string): string {
  const t = text.toLowerCase();
  if (/rocket|orbit|space|shuttle/.test(t)) return 'mcp';
  if (/blimp|airship|balloon|zeppelin|sailer|glider/.test(t)) return 'solar';
  if (/tank|hauler|armou?r|crawler|siege|walker/.test(t)) return 'mcp';
  if (/cycle|bike|car|racer|buggy|kart|truck|wheel|sled|rover/.test(t)) return 'lightcycle';
  if (/heli|rotor|copter|drone|lifter/.test(t)) return 'outlands';
  return 'grid';
}
