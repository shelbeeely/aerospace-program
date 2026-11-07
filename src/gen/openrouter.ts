/**
 * Minimal OpenRouter client. Works in the browser either through the dev-server proxy (key
 * held server-side) or directly with a player-supplied key (static hosting, e.g. GitHub
 * Pages), and in Node (direct, key from the environment).
 */

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  contextLength: number;
  inputModalities: string[];
  outputModalities: string[];
  /** USD per token (prompt / completion), per image for image output when known. */
  pricing: { prompt: number; completion: number; imageOutput?: number };
  supportedParameters: string[];
  created: number;
}

export type ChatContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatContent;
}

export interface ChatRequest {
  model: string;
  /** Backup models OpenRouter fails over to (rate limits, outages), in order. */
  fallbacks?: string[];
  messages: ChatMessage[];
  /** 'json' asks for a JSON object response (when the model supports response_format). */
  format?: 'json' | 'text';
  /** Ask for images/audio (and text) back, for generation models. */
  modalities?: Array<'text' | 'image' | 'audio'>;
  temperature?: number;
  maxTokens?: number;
  /**
   * Cap thinking on reasoning models. Free reasoning models can otherwise spend the whole
   * output budget thinking and get cut off before the answer.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** USD, as reported by OpenRouter. */
  cost: number;
}

export interface ChatResult {
  /** The model that actually answered (may be a fallback). */
  model: string;
  content: string;
  /** Data URLs of generated images, if any. */
  images: string[];
  /** Data URLs (or URLs) of generated audio, if any. */
  audio: string[];
  /** Reasoning text, if the model exposed it (some put their final answer here when cut off). */
  reasoning: string;
  usage: Usage;
}

export class OpenRouterError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export interface OpenRouterConfig {
  /** e.g. PROXY_BASE_URL in the browser, DIRECT_BASE_URL in Node. */
  baseUrl: string;
  apiKey?: string;
  /** Retries for rate limits / transient upstream errors. */
  maxRetries?: number;
  /** Refuse further requests once this much (USD) has been spent through this client. */
  maxSpendUsd?: number;
}

export const DIRECT_BASE_URL = 'https://openrouter.ai/api/v1';
export const PROXY_BASE_URL = '/api/openrouter/v1';

const num = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? Number(v) || 0 : 0);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

export class OpenRouter {
  private cfg: Required<Omit<OpenRouterConfig, 'apiKey'>> & { apiKey?: string };
  /** Running total of USD spent through this client. */
  spent = 0;
  private modelsCache: Promise<ModelInfo[]> | null = null;

  constructor(cfg: OpenRouterConfig) {
    this.cfg = { maxRetries: 3, maxSpendUsd: Infinity, ...cfg };
  }

  /** Switch endpoint/key/cap at runtime (e.g. the player pastes their own key). */
  configure(patch: Partial<OpenRouterConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }
  get hasKey(): boolean {
    return !!this.cfg.apiKey;
  }
  get maxSpendUsd(): number {
    return this.cfg.maxSpendUsd;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      'x-title': 'Aerospace Program',
    };
    if (this.cfg.apiKey) h.authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  /** The model list is public, so this works without a key. */
  models(force = false): Promise<ModelInfo[]> {
    if (!this.modelsCache || force) {
      this.modelsCache = fetch(`${this.cfg.baseUrl}/models`, { headers: this.headers() })
        .then(async (r) => {
          if (!r.ok) throw new OpenRouterError(`models: HTTP ${r.status}`, r.status, true);
          const j = (await r.json()) as { data: Record<string, any>[] };
          return j.data.map(parseModel);
        })
        .catch((e) => {
          this.modelsCache = null;
          throw e;
        });
    }
    return this.modelsCache;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    if (this.spent >= this.cfg.maxSpendUsd) {
      throw new OpenRouterError(
        `Session spend cap reached ($${this.spent.toFixed(4)} of $${this.cfg.maxSpendUsd}). Raise it in the Studio settings.`,
        402,
        false,
      );
    }
    const body: Record<string, unknown> = { messages: req.messages, usage: { include: true } };
    // With fallbacks, OpenRouter tries each model in order (rate limits, outages).
    const fallbacks = (req.fallbacks ?? []).filter((m) => m !== req.model);
    if (fallbacks.length) body.models = [req.model, ...fallbacks];
    else body.model = req.model;
    if (req.format === 'json') body.response_format = { type: 'json_object' };
    if (req.modalities) body.modalities = req.modalities;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };

    let attempt = 0;
    for (;;) {
      try {
        return await this.chatOnce(body, req.model, req.signal);
      } catch (e) {
        const retryable = e instanceof OpenRouterError && e.retryable;
        if (!retryable || attempt >= this.cfg.maxRetries) throw e;
        attempt++;
        await sleep(1500 * 2 ** (attempt - 1), req.signal);
      }
    }
  }

  private async chatOnce(body: Record<string, unknown>, model: string, signal?: AbortSignal): Promise<ChatResult> {
    const r = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    const text = await r.text();
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      throw new OpenRouterError(`HTTP ${r.status}: ${text.slice(0, 200)}`, r.status, r.status >= 500);
    }
    if (!r.ok || j.error) {
      const status = Number(j.error?.code ?? r.status) || r.status;
      const msg = j.error?.metadata?.raw ?? j.error?.message ?? `HTTP ${r.status}`;
      // 429 = rate limit, 5xx = upstream hiccup. 401/402/403 (auth, credits, limits) are final.
      throw new OpenRouterError(String(msg), status, status === 429 || status >= 500);
    }
    const msg = j.choices?.[0]?.message ?? {};
    const usage: Usage = {
      promptTokens: num(j.usage?.prompt_tokens),
      completionTokens: num(j.usage?.completion_tokens),
      cost: num(j.usage?.cost),
    };
    this.spent += usage.cost;
    const images: string[] = (msg.images ?? [])
      .map((im: any) => im?.image_url?.url)
      .filter((u: unknown): u is string => typeof u === 'string');
    const audio = findAudio(msg);
    let content = msg.content;
    if (Array.isArray(content)) content = content.map((c: any) => c.text ?? '').join('');
    const reasoning = typeof msg.reasoning === 'string' ? msg.reasoning : '';
    return { model: j.model ?? model, content: content ?? '', images, audio, reasoning, usage };
  }
}

/**
 * Audio output shapes differ between providers, so look in all the known places:
 * message.audio {data|url, format}, message.audios[], or content parts of an audio type.
 */
function findAudio(msg: any): string[] {
  const out: string[] = [];
  const add = (a: any, fallbackFormat = 'mp3') => {
    if (!a) return;
    if (typeof a === 'string') {
      out.push(a.startsWith('data:') || a.startsWith('http') ? a : `data:audio/${fallbackFormat};base64,${a}`);
      return;
    }
    const fmt = a.format ?? a.mime_type?.split('/')[1] ?? fallbackFormat;
    const url = a.url ?? a.audio_url?.url ?? a.input_audio?.url;
    const data = a.data ?? a.audio_url?.data ?? a.input_audio?.data ?? a.b64_json;
    if (typeof url === 'string') out.push(url);
    else if (typeof data === 'string') out.push(data.startsWith('data:') ? data : `data:audio/${fmt};base64,${data}`);
  };
  add(msg.audio);
  for (const a of msg.audios ?? []) add(a);
  if (Array.isArray(msg.content)) for (const c of msg.content) if (/audio/.test(c?.type ?? '')) add(c);
  return out;
}

function parseModel(m: Record<string, any>): ModelInfo {
  return {
    id: m.id,
    name: m.name ?? m.id,
    description: m.description ?? '',
    contextLength: num(m.context_length),
    inputModalities: m.architecture?.input_modalities ?? ['text'],
    outputModalities: m.architecture?.output_modalities ?? ['text'],
    pricing: {
      prompt: num(m.pricing?.prompt),
      completion: num(m.pricing?.completion),
      imageOutput: m.pricing?.image_output !== undefined ? num(m.pricing.image_output) : undefined,
    },
    supportedParameters: m.supported_parameters ?? [],
    created: num(m.created),
  };
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences and chatter). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object found in model reply');
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Browser client. With a player-supplied key it talks to OpenRouter directly (bring your own
 * key, works on static hosting like GitHub Pages). Without one it uses the dev-server proxy,
 * which holds the key server-side.
 */
export function browserClient(userKey: string | null, maxSpendUsd: number): OpenRouter {
  return new OpenRouter(
    userKey ? { baseUrl: DIRECT_BASE_URL, apiKey: userKey, maxSpendUsd } : { baseUrl: PROXY_BASE_URL, maxSpendUsd },
  );
}
