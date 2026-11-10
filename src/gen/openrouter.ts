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
  /** Largest reply the model's top provider allows (tokens; 0 = unknown). */
  maxCompletionTokens: number;
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
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatContent;
  /** Assistant turn: the tools it called (OpenAI format). */
  tool_calls?: ToolCall[];
  /** Tool turn: which call this answers. */
  tool_call_id?: string;
}

/** A function the model may call (OpenAI-compatible tool schema). */
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Can this model call tools (per the OpenRouter catalog)? */
export const supportsTools = (m: ModelInfo | undefined): boolean => !!m?.supportedParameters.includes('tools');

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
  /** Tools the model may call; the reply's toolCalls lists what it called. */
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'required' | 'none';
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
  /** Tools the model called this turn (empty if none). */
  toolCalls: ToolCall[];
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
    // Audio output only comes back on a stream, with an audio config (OpenRouter docs: Audio
    // Output). Without these, music models answer with text and no audio at all.
    const wantsAudio = !!req.modalities?.includes('audio');
    if (wantsAudio) {
      body.stream = true;
      body.audio = { voice: 'alloy', format: /^openai\//.test(req.model) ? 'pcm16' : 'wav' };
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = await this.clampMaxTokens(req.maxTokens, [req.model, ...fallbacks]);
    if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };
    if (req.tools?.length) {
      body.tools = req.tools;
      if (req.toolChoice) body.tool_choice = req.toolChoice;
      delete body.response_format; // tool calls and JSON mode don't mix on most providers
    }

    let attempt = 0;
    let shrunk = false;
    for (;;) {
      try {
        return await (wantsAudio ? this.chatStream(body, req.model, req.signal) : this.chatOnce(body, req.model, req.signal));
      } catch (e) {
        // A provider that rejects the reply budget gets one retry with the old safe default.
        if (!shrunk && e instanceof OpenRouterError && e.status === 400 && typeof body.max_tokens === 'number'
          && body.max_tokens > 16000 && /max[_ ]?(completion[_ ]?)?tokens|maximum.*tokens|too (many|large)/i.test(e.message)) {
          shrunk = true;
          body.max_tokens = 16000;
          continue;
        }
        const retryable = e instanceof OpenRouterError && e.retryable;
        if (!retryable || attempt >= this.cfg.maxRetries) throw e;
        attempt++;
        await sleep(1500 * 2 ** (attempt - 1), req.signal);
      }
    }
  }

  /** Keep a requested reply budget within every listed model's known output limit. */
  private async clampMaxTokens(want: number, models: string[]): Promise<number> {
    let list: ModelInfo[];
    try {
      list = await this.models();
    } catch {
      return want;
    }
    let out = want;
    for (const id of models) {
      const m = list.find((x) => x.id === id);
      if (m?.maxCompletionTokens) out = Math.min(out, m.maxCompletionTokens);
    }
    return Math.max(1000, out);
  }

  /**
   * A streamed reply (server-sent events), for audio output: text deltas are joined, audio
   * arrives as base64 chunks in delta.audio.data (decoded and concatenated), usage comes last.
   */
  private async chatStream(body: Record<string, unknown>, model: string, signal?: AbortSignal): Promise<ChatResult> {
    const r = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok || !r.body) {
      const text = await r.text();
      let msg = `HTTP ${r.status}: ${text.slice(0, 200)}`;
      try {
        const j = JSON.parse(text);
        msg = String(j.error?.metadata?.raw ?? j.error?.message ?? msg);
      } catch { /* not JSON */ }
      throw new OpenRouterError(msg, r.status, r.status === 429 || r.status >= 500);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let content = '';
    let transcript = '';
    let usedModel = model;
    const chunks: Uint8Array[] = [];
    const urls: string[] = [];
    const usage: Usage = { promptTokens: 0, completionTokens: 0, cost: 0 };
    const take = (a: any) => {
      if (!a) return;
      if (typeof a === 'string') { chunks.push(b64Bytes(a)); return; }
      if (typeof a.transcript === 'string') transcript += a.transcript;
      const url = a.url ?? a.audio_url?.url;
      if (typeof url === 'string' && /^https?:/.test(url)) urls.push(url);
      const data = a.data ?? a.b64_json ?? (typeof url === 'string' && url.startsWith('data:') ? url : undefined);
      if (typeof data === 'string' && data) chunks.push(b64Bytes(data));
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // comments (": OPENROUTER PROCESSING"), blank lines
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j: any;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.error) {
          const status = Number(j.error.code) || 500;
          throw new OpenRouterError(String(j.error.metadata?.raw ?? j.error.message ?? 'stream error'), status, status === 429 || status >= 500);
        }
        if (j.model) usedModel = j.model;
        if (j.usage) {
          usage.promptTokens = num(j.usage.prompt_tokens);
          usage.completionTokens = num(j.usage.completion_tokens);
          usage.cost = num(j.usage.cost);
        }
        const d = j.choices?.[0]?.delta ?? j.choices?.[0]?.message ?? {};
        if (typeof d.content === 'string') content += d.content;
        else if (Array.isArray(d.content)) for (const c of d.content) {
          if (typeof c?.text === 'string') content += c.text;
          if (/audio/.test(c?.type ?? '')) take(c.audio ?? c.input_audio ?? c);
        }
        take(d.audio);
        for (const a of d.audios ?? []) take(a);
      }
      if (done) break;
    }
    this.spent += usage.cost;
    const audio = [...urls];
    if (chunks.length) {
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      audio.unshift(audioDataUrl(all));
    }
    return { model: usedModel, content: content || transcript, images: [], audio, reasoning: '', usage, toolCalls: [] };
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
    const toolCalls: ToolCall[] = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
      .filter((t: any) => t?.function?.name)
      .map((t: any, i: number) => ({
        id: String(t.id ?? `call_${i}`),
        type: 'function' as const,
        function: { name: String(t.function.name), arguments: typeof t.function.arguments === 'string' ? t.function.arguments : JSON.stringify(t.function.arguments ?? {}) },
      }));
    return { model: j.model ?? model, content: content ?? '', images, audio, reasoning, usage, toolCalls };
  }
}

/** Decode base64 (also URL-safe base64) to bytes. */
function b64Bytes(s: string): Uint8Array {
  const clean = s.replace(/^data:[^,]*,/, '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Raw 16-bit little-endian PCM (OpenAI's streamed audio: 24 kHz mono) in a WAV container. */
function pcmToWav(pcm: Uint8Array, rate = 24000, channels = 1): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) out[o + i] = t.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** A playable data URL for audio bytes: the container is sniffed from its magic bytes. */
export function audioDataUrl(bytes: Uint8Array): string {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  let mime = '';
  if (tag === 'RIFF') mime = 'audio/wav';
  else if (tag === 'OggS') mime = 'audio/ogg';
  else if (tag === 'fLaC') mime = 'audio/flac';
  else if (tag.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) mime = 'audio/mpeg';
  else if (String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') mime = 'audio/mp4';
  if (!mime) return `data:audio/wav;base64,${bytesB64(pcmToWav(bytes))}`; // headerless: raw PCM
  return `data:${mime};base64,${bytesB64(bytes)}`;
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
    maxCompletionTokens: num(m.top_provider?.max_completion_tokens),
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
