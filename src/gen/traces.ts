import type { AgentTrace } from './agent.ts';

/**
 * Agent runs kept as training data (the model's reasoning, every tool call and result, and the
 * outcome), in IndexedDB so they survive reloads; downloadable as JSONL for fine-tuning. Stays in
 * this browser: nothing is uploaded. Fails soft without IndexedDB (session memory only).
 */
const DB = 'aerospace.traces';
const STORE = 'runs';
const memory: AgentTrace[] = [];

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function request<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
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

export async function saveTrace(t: AgentTrace): Promise<void> {
  const db = await open();
  if (!db) { memory.push(t); return; }
  await request(db, 'readwrite', (s) => s.add(t));
}

export async function listTraces(): Promise<AgentTrace[]> {
  const db = await open();
  if (!db) return [...memory];
  return ((await request<AgentTrace[]>(db, 'readonly', (s) => s.getAll())) ?? []);
}

export async function clearTraces(): Promise<void> {
  memory.length = 0;
  const db = await open();
  if (db) await request(db, 'readwrite', (s) => s.clear());
}

export interface TraceFilter {
  /** Only runs whose vehicle passed its test card. */
  passedOnly?: boolean;
}

/**
 * JSONL, one run per line: {"messages": [...], "tools": [...], "metadata": {...}}. Messages are
 * OpenAI chat format with tool calls; assistant turns carry the model's `reasoning` (also as
 * `reasoning_content`, the field several trainers read). Filter on metadata.passed / score.
 */
export function toJsonl(traces: AgentTrace[], filter: TraceFilter = {}): string {
  return traces
    .filter((t) => !filter.passedOnly || t.metadata.passed)
    .map((t) => JSON.stringify({
      messages: t.messages.map((m) => (m.reasoning ? { ...m, reasoning_content: m.reasoning } : m)),
      tools: t.tools,
      metadata: t.metadata,
    }))
    .join('\n') + '\n';
}
