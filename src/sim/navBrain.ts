/**
 * An outside brain for the Navigator (an OpenRouter model: src/gen/navBrain.ts), after the
 * jevpilot pattern: the brain never touches the controls. The Navigator lays out a few options
 * it has already checked (routes, paces, cruise heights, runways, pads), the brain picks one per
 * question, and the Navigator's own controller flies the pick at full rate. Until an answer
 * comes, and whenever one fails, comes late, belongs to an earlier request or names something
 * not on offer, the built-in choice stands, so the vehicle is never waiting on the network.
 *
 * Pure and DOM-free: timing is the simulation's clock, and answers are only ever applied inside
 * the Navigator's own step (never from a network callback).
 */

export type BrainFact = string | number | boolean | null;

export interface BrainOption {
  /** Short id the brain answers with (e.g. "R2", "p28", "rwy-3"). */
  id: string;
  /** What a person would call it ("Route B by the data highway", "28 m/s"). */
  label: string;
  facts: Record<string, BrainFact>;
}

export interface BrainQuestion {
  id: string;
  /** One line: what is being chosen. */
  ask: string;
  options: BrainOption[];
  /** The option in force now (the built-in choice, or the brain's last pick). */
  current: string;
}

export type BrainVehicle = 'ground vehicle' | 'airplane' | 'rotorcraft';

export interface BrainDecision {
  seq: number;
  vehicle: BrainVehicle;
  /** Why it is asked now: engage, periodic, reroute, blocked, stuck, go-around. */
  trigger: string;
  /** An answer applies only while this still holds (the same engagement and mode). */
  context: string;
  situation: Record<string, unknown>;
  questions: BrainQuestion[];
  /** The player's own words for the Navigator ('' if none). */
  instructions: string;
  /** Ask again after this many seconds (null: only when something happens). */
  every: number | null;
}

export interface BrainAnswer {
  /** Question id → option id. */
  choices: Record<string, string>;
  reason: string;
  /** The model that answered, its round-trip time and cost (when known). */
  model?: string;
  latencyMs?: number;
  costUsd?: number;
}

export interface NavBrain {
  /** Shown in the panel, e.g. "OpenRouter · ling-3.2-flash". */
  readonly name: string;
  decide(d: BrainDecision, signal: AbortSignal): Promise<BrainAnswer>;
}

export interface AdvisorStatus {
  /** The brain's name, or null when the built-in computer decides alone. */
  brain: string | null;
  state: 'off' | 'idle' | 'thinking' | 'error' | 'stopped';
  /** The last reason given, or what went wrong. */
  message: string;
  /** What the last applied answer chose, in words ("Route B · 28 m/s"). */
  lastPick: string;
  model: string;
  latencyMs: number;
  decisions: number;
  /** Answers thrown away (late, stale or naming nothing on offer). */
  discarded: number;
  spentUsd: number;
}

/** Map a raw answer onto the questions: unknown or missing choices keep the current option. */
export function validateAnswer(d: BrainDecision, choices: Record<string, unknown>): { picks: Record<string, BrainOption>; invalid: string[] } {
  const picks: Record<string, BrainOption> = {};
  const invalid: string[] = [];
  for (const q of d.questions) {
    const raw = choices[q.id];
    if (raw === undefined || raw === null || raw === '') continue;
    const want = String(raw).trim();
    const lower = want.toLowerCase();
    // The id, or (models sometimes answer with the words) the label.
    const opt = q.options.find((o) => o.id === want) ?? q.options.find((o) => o.id.toLowerCase() === lower || o.label.toLowerCase() === lower);
    if (opt) picks[q.id] = opt;
    else invalid.push(`${q.id}=${want}`);
  }
  return { picks, invalid };
}

/** Longest the Navigator waits for an answer (simulation seconds) before giving up on it. */
export const ANSWER_MAX_AGE = 20;

/**
 * The scheduler between the Navigator and its brain: at most one question in flight, asked when
 * something happens (engage, a reroute, a wall, stuck) or when the decision's period runs out,
 * with a back-off after failures. The Navigator calls step() every tick while engaged.
 */
export class NavAdvisor {
  /** Null: the built-in computer decides alone (the default). */
  brain: NavBrain | null = null;
  /** The player's words for the brain (the panel's Instructions field). */
  instructions = '';
  readonly status: AdvisorStatus = {
    brain: null, state: 'off', message: '', lastPick: '', model: '', latencyMs: 0, decisions: 0, discarded: 0, spentUsd: 0,
  };
  private seq = 0;
  private context = '';
  private nextAt = -Infinity;
  private failures = 0;
  private pending: { d: BrainDecision; at: number; ctrl: AbortController } | null = null;
  private result: { d: BrainDecision; at: number; a: BrainAnswer | null; error: string; fatal: boolean } | null = null;
  private readonly queued = new Set<string>();

  get thinking(): boolean {
    return !!this.pending;
  }

  /** Next decision number (builders stamp it on their decision). */
  nextSeq(): number {
    return ++this.seq;
  }

  /** Something happened worth a fresh decision (taken at the next step). */
  notify(trigger: string): void {
    if (this.brain) this.queued.add(trigger);
  }

  /** Drop any question in flight and forget the schedule (disengage, or the brain changed). */
  reset(): void {
    this.pending?.ctrl.abort();
    this.pending = null;
    this.result = null;
    this.queued.clear();
    this.context = '';
    this.nextAt = -Infinity;
    this.failures = 0;
    this.status.state = this.brain ? 'idle' : 'off';
    this.status.brain = this.brain?.name ?? null;
  }

  /**
   * One tick. `context` names the engagement (a change starts afresh with an 'engage'
   * decision); `build` lays out a decision for a trigger, or null when there is nothing to ask;
   * `apply` carries out the valid picks and says what was done.
   */
  step(now: number, context: string, build: (trigger: string) => BrainDecision | null, apply: (d: BrainDecision, picks: Record<string, BrainOption>) => string): void {
    const st = this.status;
    const name = this.brain?.name ?? null;
    const renamed = name !== st.brain;
    st.brain = name;
    if (!this.brain) {
      if (this.pending || st.state !== 'off') this.reset();
      st.state = 'off';
      return;
    }
    // A new engagement or another model starts afresh (and gets past an earlier refusal).
    if (context !== this.context || renamed) {
      this.pending?.ctrl.abort();
      this.pending = null;
      this.result = null;
      this.queued.clear();
      this.context = context;
      this.queued.add('engage');
      this.nextAt = now;
      this.failures = 0;
      st.lastPick = st.message = '';
      if (st.state === 'stopped' || st.state === 'error' || st.state === 'off') st.state = 'idle';
    }
    // An answer (or a failure) came back since the last tick: apply it here, inside the step.
    const r = this.result;
    if (r) {
      this.result = null;
      if (r.a) {
        st.decisions++;
        st.model = r.a.model ?? st.model;
        st.latencyMs = r.a.latencyMs ?? 0;
        st.spentUsd += r.a.costUsd ?? 0;
        const stale = r.d.context !== this.context;
        const late = now - r.at > ANSWER_MAX_AGE;
        const { picks, invalid } = validateAnswer(r.d, r.a.choices);
        if (stale || late) {
          st.discarded++;
          st.message = stale ? 'Answer came after the plan changed: ignored' : `Answer took over ${ANSWER_MAX_AGE} s: ignored`;
        } else {
          const did = Object.keys(picks).length ? apply(r.d, picks) : '';
          if (invalid.length && !Object.keys(picks).length) st.discarded++;
          st.lastPick = did || st.lastPick;
          st.message = (r.a.reason || (did ? '' : 'Kept the current plan')) + (invalid.length ? ` (ignored ${invalid.join(', ')}: not offered)` : '');
        }
        this.failures = 0;
        st.state = 'idle';
      } else {
        this.failures++;
        st.message = r.error;
        st.state = r.fatal ? 'stopped' : 'error';
        // Back off: 5, 10, 20, 40, 60 s. A fatal error (no key, spend cap) waits for a new engagement.
        this.nextAt = r.fatal ? Infinity : now + Math.min(60, 5 * 2 ** (this.failures - 1));
        this.queued.clear();
      }
    }
    if (this.pending) {
      if (now - this.pending.at > ANSWER_MAX_AGE) {
        this.pending.ctrl.abort();
        this.pending = null;
        st.discarded++;
        st.state = 'error';
        st.message = `No answer in ${ANSWER_MAX_AGE} s: kept the current plan`;
        this.failures++;
        this.nextAt = now + Math.min(60, 5 * 2 ** (this.failures - 1));
      }
      return;
    }
    if (st.state === 'stopped') return;
    const due = now >= this.nextAt;
    if (!this.queued.size && !due) return;
    const trigger = this.queued.has('engage') ? 'engage' : [...this.queued][0] ?? 'periodic';
    this.queued.clear();
    const d = build(trigger);
    if (!d) {
      this.nextAt = now + 5;
      return;
    }
    d.instructions = this.instructions.trim().slice(0, 300);
    this.nextAt = d.every === null ? Infinity : now + d.every;
    const ctrl = new AbortController();
    this.pending = { d, at: now, ctrl };
    st.state = 'thinking';
    const brain = this.brain;
    brain.decide(d, ctrl.signal).then(
      (a) => {
        if (this.pending?.d !== d) return; // aborted or superseded
        this.pending = null;
        this.result = { d, at: now, a, error: '', fatal: false };
      },
      (e: unknown) => {
        if (this.pending?.d !== d) return;
        this.pending = null;
        const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 0;
        const msg = e instanceof Error ? e.message : String(e);
        // No key, no credit, spend cap: asking again will not help until something changes.
        const fatal = status === 401 || status === 402 || status === 403;
        this.result = { d, at: now, a: null, error: `${brain.name}: ${msg.slice(0, 160)}`, fatal };
      },
    );
  }
}
