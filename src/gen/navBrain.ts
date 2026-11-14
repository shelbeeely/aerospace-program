/**
 * The Navigator's OpenRouter brain (src/sim/navBrain.ts for the contract): one short chat
 * request per decision, answered with a JSON object naming one option per question. The model
 * sees the situation, the player's instructions and options the Navigator has already checked;
 * it never steers. Small fast models do this well; reasoning is kept low so answers come back
 * in a second or two rather than after a long think.
 */
import type { BrainAnswer, BrainDecision, NavBrain } from '../sim/navBrain.ts';
import { extractJson, OpenRouterError, type ChatRequest, type ChatResult } from './openrouter.ts';

export const NAV_SYSTEM = [
  'You are the tactical navigator of a vehicle in a 1982-style digital world: a vast electronic grid of',
  'machine cities, data highways and abstract Outlands. A built-in autopilot drives or flies the vehicle',
  'and keeps it safe at every moment; you never steer. Each turn you get the situation and one or more',
  'questions, each with options the autopilot has already checked are safe to fly. Pick one option id',
  'per question.',
  'Priorities: 1) the player\'s instructions, when given; 2) a safety margin (hostile territory, weather,',
  'wind, obstacles, fuel); 3) getting there efficiently. Keep the current option unless another is',
  'clearly better: every change costs a little. Units: metres, seconds, m/s, degrees (0 = north).',
  'Reply with one JSON object and nothing else:',
  '{"choices":{"<question id>":"<option id>"},"reason":"<one short sentence, at most 15 words>"}',
].join('\n');

/** The user turn: the decision as compact JSON, then the exact answer shape. */
export function navPrompt(d: BrainDecision): string {
  const body: Record<string, unknown> = {
    trigger: d.trigger,
    vehicle: d.vehicle,
    situation: d.situation,
  };
  if (d.instructions) body.player_instructions = d.instructions;
  body.questions = d.questions.map((q) => ({
    id: q.id,
    ask: q.ask,
    current: q.current,
    options: q.options.map((o) => ({ id: o.id, label: o.label, ...o.facts })),
  }));
  const shape = d.questions.map((q) => `"${q.id}":"<${q.options.map((o) => o.id).join('|')}>"`).join(',');
  return `${JSON.stringify(body)}\n\nAnswer with JSON only: {"choices":{${shape}},"reason":"..."}`;
}

/**
 * Read a model's reply: tolerates ```json fences and chatter, {"answers": ...} instead of
 * "choices", and question ids at the top level. Throws if no JSON object is found.
 */
export function parseNavReply(text: string, d: BrainDecision): { choices: Record<string, string>; reason: string } {
  const j = extractJson(text) as Record<string, unknown>;
  const raw = (j.choices ?? j.answers ?? j.choice ?? j) as Record<string, unknown>;
  const choices: Record<string, string> = {};
  for (const q of d.questions) {
    let v = raw?.[q.id];
    if (v && typeof v === 'object') v = (v as Record<string, unknown>).id ?? (v as Record<string, unknown>).choice;
    if (typeof v === 'string' || typeof v === 'number') choices[q.id] = String(v);
  }
  const reason = typeof j.reason === 'string' ? j.reason.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  return { choices, reason };
}

/** What the brain needs of a client (the OpenRouter class, or a stand-in in the checks). */
export interface ChatClient {
  chat(req: ChatRequest): Promise<ChatResult>;
}

/** "inclusionai/ling-3.2-flash:free" → "ling-3.2-flash". */
export const shortModel = (id: string) => id.replace(/^[^/]*\//, '').replace(/:free$/, '');

/** A signal that fires on either (AbortSignal.any where it exists). */
function anySignal(a: AbortSignal, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn([a, timeout]);
  const c = new AbortController();
  const stop = () => c.abort();
  a.addEventListener('abort', stop);
  timeout.addEventListener('abort', stop);
  return c.signal;
}

export class OpenRouterBrain implements NavBrain {
  /**
   * `pick` names the model (and free backups) at the moment of asking, so changing the model
   * in the panel takes effect on the next decision.
   */
  constructor(
    private readonly client: ChatClient,
    private readonly pick: () => { model: string; fallbacks: string[] },
    private readonly timeoutMs = 15000,
  ) {}

  get name(): string {
    const m = this.pick().model;
    return m ? `OpenRouter · ${shortModel(m)}` : 'OpenRouter (no model chosen)';
  }

  async decide(d: BrainDecision, signal: AbortSignal): Promise<BrainAnswer> {
    const { model, fallbacks } = this.pick();
    if (!model) throw new OpenRouterError('choose a model in the Navigator panel', 400, false);
    const t0 = Date.now();
    let res: ChatResult;
    try {
      res = await this.client.chat({
        model,
        fallbacks,
        messages: [
          { role: 'system', content: NAV_SYSTEM },
          { role: 'user', content: navPrompt(d) },
        ],
        format: 'json',
        temperature: 0.2,
        maxTokens: 1000,
        reasoningEffort: 'low',
        signal: anySignal(signal, this.timeoutMs),
      });
    } catch (e) {
      // Static hosting has no proxy behind /api/openrouter: say what to do, not the HTML 404.
      if (e instanceof OpenRouterError && e.status === 404 && /<html|not proxied|HTTP 404/i.test(e.message)) {
        throw new OpenRouterError('OpenRouter is not reachable here: add your key under Studio → Key & spend', 401, false);
      }
      // A refused key: say where the key lives, not just what OpenRouter said.
      if (e instanceof OpenRouterError && (e.status === 401 || e.status === 403)) {
        throw new OpenRouterError(`OpenRouter refused the key (${e.message.slice(0, 60)}): check it under Studio → Key & spend, or OPENROUTER_API_KEY for the dev server`, e.status, false);
      }
      if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError') && !signal.aborted) {
        throw new Error(`no answer in ${Math.round(this.timeoutMs / 1000)} s`);
      }
      throw e;
    }
    // Some models put the answer in the reasoning when they run short.
    let parsed: { choices: Record<string, string>; reason: string };
    try {
      parsed = parseNavReply(res.content, d);
    } catch {
      parsed = parseNavReply(res.reasoning, d);
    }
    return { ...parsed, model: res.model, latencyMs: Date.now() - t0, costUsd: res.usage.cost };
  }
}
