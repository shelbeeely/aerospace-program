/**
 * Minimal OpenRouter client that works in the browser (through the dev-server proxy, so the
 * API key never reaches the page) and in Node (direct, key from the environment).
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
  messages: ChatMessage[];
  /** 'json' asks for a JSON object response (when the model supports response_format). */
  format?: 'json' | 'text';
  /** Ask for images (and text) back, for image-generation models. */
  modalities?: Array<'text' | 'image' | 'audio'>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** USD, as reported by OpenRouter. */
  cost: number;
}

export interface ChatResult {
  model: string;
  content: string;
  /** Data URLs of generated images, if any. */
  images: string[];
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
  /** e.g. '/api/openrouter/v1' in the browser, 'https://openrouter.ai/api/v1' in Node. */
  baseUrl: string;
  apiKey?: string;
  /** Retries for rate limits / transient upstream errors. */
  maxRetries?: number;
}

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
  private readonly cfg: Required<Omit<OpenRouterConfig, 'apiKey'>> & { apiKey?: string };
  /** Running total of USD spent through this client. */
  spent = 0;
  private modelsCache: Promise<ModelInfo[]> | null = null;

  constructor(cfg: OpenRouterConfig) {
    this.cfg = { maxRetries: 3, ...cfg };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      'x-title': 'Aerospace Program',
    };
    if (this.cfg.apiKey) h.authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

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
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      usage: { include: true },
    };
    if (req.format === 'json') body.response_format = { type: 'json_object' };
    if (req.modalities) body.modalities = req.modalities;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

    let attempt = 0;
    for (;;) {
      try {
        return await this.chatOnce(body, req.signal);
      } catch (e) {
        const retryable = e instanceof OpenRouterError && e.retryable;
        if (!retryable || attempt >= this.cfg.maxRetries) throw e;
        attempt++;
        await sleep(1500 * 2 ** (attempt - 1), req.signal);
      }
    }
  }

  private async chatOnce(body: Record<string, unknown>, signal?: AbortSignal): Promise<ChatResult> {
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
      const status = j.error?.code ?? r.status;
      const msg = j.error?.metadata?.raw ?? j.error?.message ?? `HTTP ${r.status}`;
      // 429 = rate limit, 5xx = upstream hiccup. 402/403 (credits, key limits) are not retryable.
      throw new OpenRouterError(String(msg), Number(status), status === 429 || status >= 500);
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
    let content = msg.content;
    if (Array.isArray(content)) content = content.map((c: any) => c.text ?? '').join('');
    return { model: j.model ?? String(body.model), content: content ?? '', images, usage };
  }
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

/** Browser default: same-origin proxy (see vite.config.ts). */
export function browserClient(): OpenRouter {
  return new OpenRouter({ baseUrl: '/api/openrouter/v1' });
}
