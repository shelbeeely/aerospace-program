/**
 * What happened to each agent, recorded as it happened: routes set and changed, closures heard
 * of, waits and why, yields, decisions. The player's "why is this ambulance late?" is answered
 * only from these records (`explain`), never made up afterwards.
 */
export type LogKind = 'route' | 'closure' | 'reroute' | 'wait' | 'yield' | 'merge' | 'job' | 'arrive' | 'policy';

export interface LogEntry {
  t: number;
  kind: LogKind;
  text: string;
}

/** The agent's story as a chain: what shaped its current (or last) trip, from where it set off. */
export function explain(log: readonly LogEntry[], max = 7): string {
  const keep = log.filter((e) => e.kind !== 'merge' && e.kind !== 'policy');
  let start = 0;
  for (let i = keep.length - 1; i >= 0; i--) if (keep[i].kind === 'route') { start = i; break; }
  return keep.slice(start).slice(0, max).map((e) => e.text).join(' → ') || 'no events yet';
}

/** m:ss for the log. */
export function clock(t: number): string {
  const s = Math.max(0, Math.round(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
