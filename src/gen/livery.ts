import { extractJson, type OpenRouter } from './openrouter.ts';

export interface LiveryResult {
  /** Downscaled JPEG data URL, small enough to keep in the library. */
  image: string;
  /** The model that actually answered. */
  model: string;
  cost: number;
  /** How it was made: an image model painted it, or a text model designed a pattern. */
  method: 'image' | 'pattern';
  spec?: PatternSpec;
}

export const PATTERNS = ['solid', 'stripes', 'bands', 'chevrons', 'checker', 'dots', 'camo', 'sunburst', 'split'] as const;
export type PatternName = (typeof PATTERNS)[number];

/** What a text model returns; drawn procedurally by `renderPattern`. */
export interface PatternSpec {
  base: string;
  colors: string[];
  pattern: PatternName;
  /** Repeats across the texture, 1..10. */
  scale: number;
  /** Degrees, -90..90. */
  angle: number;
  /** 0..1 grime and fading. */
  weathering: number;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Clamp/clean an untrusted spec so any model output renders something sensible. */
export function sanitizePattern(raw: unknown): PatternSpec {
  const r = (typeof raw === 'object' && raw ? raw : {}) as Record<string, unknown>;
  const color = (v: unknown, d: string) => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : d);
  const n = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  const colors = (Array.isArray(r.colors) ? r.colors : []).map((c) => color(c, '')).filter(Boolean).slice(0, 4);
  return {
    base: color(r.base, '#e8e4da'),
    colors: colors.length ? colors : ['#c94f3d'],
    pattern: (PATTERNS as readonly string[]).includes(r.pattern as string) ? (r.pattern as PatternName) : 'stripes',
    scale: Math.round(n(r.scale, 1, 10, 3)),
    angle: n(r.angle, -90, 90, 0),
    weathering: n(r.weathering, 0, 1, 0.15),
  };
}

/** Deterministic PRNG so the same spec always draws the same texture. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw a pattern spec to a 512 px texture (browser only). */
export function renderPattern(spec: PatternSpec, size = 512): string {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const { colors } = spec;
  const col = (i: number) => colors[i % colors.length];
  const cell = size / spec.scale;
  g.fillStyle = spec.base;
  g.fillRect(0, 0, size, size);

  g.save();
  // Rotate around the centre, drawing on an oversized area so corners stay covered.
  g.translate(size / 2, size / 2);
  g.rotate((spec.angle * Math.PI) / 180);
  g.translate(-size, -size);
  const span = size * 2;
  const rand = rng(spec.scale * 997 + Math.round(spec.angle) * 13 + colors.length);
  switch (spec.pattern) {
    case 'solid':
      break;
    case 'stripes':
      for (let i = 0, x = 0; x < span; i++, x += cell) {
        g.fillStyle = col(i);
        g.fillRect(x, 0, cell * 0.35, span);
      }
      break;
    case 'bands':
      for (let i = 0, y = 0; y < span; i++, y += cell) {
        g.fillStyle = col(i);
        g.fillRect(0, y + cell * 0.3, span, cell * 0.12);
        g.fillRect(0, y + cell * 0.5, span, cell * 0.06);
      }
      break;
    case 'chevrons':
      g.lineWidth = cell * 0.22;
      for (let i = 0, y = -cell; y < span + cell; i++, y += cell) {
        g.strokeStyle = col(i);
        g.beginPath();
        for (let x = 0; x <= span; x += cell) g.lineTo(x, y + (((x / cell) | 0) % 2 ? cell * 0.5 : 0));
        g.stroke();
      }
      break;
    case 'checker':
      for (let y = 0, j = 0; y < span; y += cell / 2, j++)
        for (let x = 0, i = 0; x < span; x += cell / 2, i++)
          if ((i + j) % 2) {
            g.fillStyle = col(((i / 2) | 0) + j);
            g.fillRect(x, y, cell / 2, cell / 2);
          }
      break;
    case 'dots':
      for (let y = 0, j = 0; y < span; y += cell / 2, j++)
        for (let x = (j % 2) * (cell / 4), i = 0; x < span; x += cell / 2, i++) {
          g.fillStyle = col(i + j);
          g.beginPath();
          g.arc(x, y, cell * 0.12, 0, Math.PI * 2);
          g.fill();
        }
      break;
    case 'camo':
      for (let k = 0; k < spec.scale * spec.scale * 40; k++) {
        g.fillStyle = col(k);
        g.beginPath();
        const x = rand() * span;
        const y = rand() * span;
        const r = cell * (0.15 + rand() * 0.35);
        for (let a = 0; a < Math.PI * 2; a += Math.PI / 5) {
          const rr = r * (0.6 + rand() * 0.6);
          g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        }
        g.fill();
      }
      break;
    case 'sunburst': {
      const rays = spec.scale * 4;
      for (let i = 0; i < rays; i++) {
        if (i % 2) continue;
        g.fillStyle = col(i / 2);
        g.beginPath();
        g.moveTo(size, size);
        g.arc(size, size, span, (i / rays) * Math.PI * 2, ((i + 1) / rays) * Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'split':
      g.fillStyle = col(0);
      g.fillRect(0, size, span, size);
      if (colors.length > 1) {
        g.fillStyle = col(1);
        g.fillRect(0, size - cell * 0.08, span, cell * 0.16);
      }
      break;
  }
  g.restore();

  // Weathering: speckle and soft fade.
  if (spec.weathering > 0) {
    const n = Math.round(spec.weathering * 6000);
    for (let i = 0; i < n; i++) {
      g.fillStyle = rand() < 0.6 ? 'rgba(40,30,20,0.12)' : 'rgba(255,255,255,0.10)';
      g.fillRect(rand() * size, rand() * size, 1 + rand() * 3, 1 + rand() * 3);
    }
    g.fillStyle = `rgba(200,190,170,${spec.weathering * 0.15})`;
    g.fillRect(0, 0, size, size);
  }
  return c.toDataURL('image/jpeg', 0.85);
}

export interface PaintRequest {
  model: string;
  fallbacks?: string[];
  /** True if the chosen model outputs images (otherwise it designs a pattern). */
  imageModel: boolean;
  prompt: string;
  craftName: string;
  signal?: AbortSignal;
}

/** Paint a livery with whichever kind of model the Painter job was given. */
export async function paintLivery(client: OpenRouter, req: PaintRequest): Promise<LiveryResult> {
  return req.imageModel ? paintWithImageModel(client, req) : designPatternLivery(client, req);
}

async function designPatternLivery(client: OpenRouter, req: PaintRequest): Promise<LiveryResult> {
  const res = await client.chat({
    model: req.model,
    fallbacks: req.fallbacks,
    format: 'json',
    temperature: 0.8,
    maxTokens: 3000,
    reasoningEffort: 'low',
    signal: req.signal,
    messages: [
      {
        role: 'system',
        content:
          'You design aircraft paint schemes for a game. Reply ONLY with JSON: ' +
          '{"base":"#rrggbb","colors":["#rrggbb", up to 4],"pattern":one of ' +
          PATTERNS.map((p) => `"${p}"`).join('|') +
          ',"scale":1-10 (repeats across a panel),"angle":-90..90 degrees,"weathering":0..1}. ' +
          'Pick colours that work together and suit the request.',
      },
      { role: 'user', content: `Aircraft: "${req.craftName}". Paint scheme request: ${req.prompt}` },
    ],
  });
  const spec = sanitizePattern(extractJson(res.content));
  return { image: renderPattern(spec), model: res.model, cost: res.usage.cost, method: 'pattern', spec };
}

async function paintWithImageModel(client: OpenRouter, req: PaintRequest): Promise<LiveryResult> {
  const res = await client.chat({
    model: req.model,
    fallbacks: req.fallbacks,
    modalities: ['image', 'text'],
    signal: req.signal,
    messages: [
      {
        role: 'user',
        content:
          `Create a square, seamless, tileable texture to be used as an aircraft paint scheme for "${req.craftName}". ` +
          `Style: ${req.prompt}. Flat graphic surface pattern filling the whole frame, viewed straight on. ` +
          `No aircraft, no background scene, no text, no borders, no shadows.`,
      },
    ],
  });
  const src = res.images[0];
  if (!src) throw new Error(`${res.model} returned no image${res.content ? `: ${res.content.slice(0, 160)}` : ''}`);
  return { image: await downscale(src, 512), model: res.model, cost: res.usage.cost, method: 'image' };
}

async function downscale(src: string, size: number): Promise<string> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const s = Math.min(img.width, img.height); // centre-crop to square
  g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.82);
}
