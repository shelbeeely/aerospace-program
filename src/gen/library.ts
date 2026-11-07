import type { CraftDef } from '../craft/types.ts';
import { validateCraft } from '../craft/validate.ts';

/** Where a craft came from, so every generated artifact is traceable and comparable. */
export interface Provenance {
  source: 'builtin' | 'generated' | 'imported';
  model?: string;
  prompt?: string;
  notes?: string;
  score?: number;
  rounds?: number;
  costUsd?: number;
  createdAt: string;
  /** Library id of the craft this one was refined from. */
  parentId?: string;
  liveryModel?: string;
  liveryPrompt?: string;
}

export interface LibraryEntry {
  id: string;
  name: string;
  craft: CraftDef;
  provenance: Provenance;
  /** Small JPEG data URL. */
  livery?: string;
}

const KEY = 'aerospace.library.v1';

/** Craft library in localStorage (per browser). Fails soft if storage is unavailable or full. */
export class Library {
  private entries: LibraryEntry[] = [];

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? (JSON.parse(raw) as LibraryEntry[]) : [];
      this.entries = parsed.filter((e) => e && validateCraft(e.craft).length === 0);
    } catch {
      this.entries = [];
    }
  }

  list(): readonly LibraryEntry[] {
    return this.entries;
  }

  get(id: string): LibraryEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  add(entry: Omit<LibraryEntry, 'id'>): LibraryEntry {
    const e: LibraryEntry = { ...entry, id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
    this.entries.unshift(e);
    this.persist();
    return e;
  }

  update(id: string, patch: Partial<LibraryEntry>): void {
    const e = this.get(id);
    if (!e) return;
    Object.assign(e, patch);
    this.persist();
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.entries));
    } catch {
      // Storage full or blocked: drop liveries from the oldest entries and retry once.
      for (let i = this.entries.length - 1; i >= 0; i--) delete this.entries[i].livery;
      try {
        localStorage.setItem(KEY, JSON.stringify(this.entries));
      } catch {
        /* give up silently; the session copy still works */
      }
    }
  }
}

/** Export file format, shared with `npm run design` output. */
export function toExportJson(e: LibraryEntry): string {
  return JSON.stringify({ craft: e.craft, provenance: e.provenance }, null, 2);
}

export function fromImportJson(text: string): Omit<LibraryEntry, 'id'> {
  const j = JSON.parse(text);
  const craft = (j.craft ?? j) as CraftDef;
  const errors = validateCraft(craft);
  if (errors.length) throw new Error(`Invalid craft: ${errors.slice(0, 5).join('; ')}`);
  return {
    name: craft.name,
    craft,
    provenance: { ...(j.provenance ?? {}), source: j.provenance ? j.provenance.source ?? 'generated' : 'imported', createdAt: j.provenance?.createdAt ?? new Date().toISOString() },
  };
}
