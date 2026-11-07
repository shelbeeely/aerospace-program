import type { ModelInfo } from './openrouter.ts';

/**
 * The crew: each job is done by its own model, chosen from the live OpenRouter catalog.
 * Defaults are FREE models, each with free backups that OpenRouter fails over to when one is
 * rate-limited. Paid models stay one click away in the same pickers.
 */
export type JobId = 'designer' | 'engineer' | 'painter' | 'composer';

export interface JobInfo {
  label: string;
  description: string;
  /** Output modality a model needs. A job may accept several (painter: image or text). */
  outputs: string[];
  /** Free models in order of preference (checked against the live catalog). */
  free: string[];
  /** Suggested paid upgrades, shown under "Recommended". */
  paid: string[];
}

export const JOBS: Record<JobId, JobInfo> = {
  designer: {
    label: 'Designer',
    description: 'Turns your description into a craft (JSON part graph). Needs strong reasoning.',
    outputs: ['text'],
    free: [
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'stealth/crouton-alpha',
      'nvidia/nemotron-3.5-super-vl:free',
      'google/gemma-4-31b-it:free',
    ],
    paid: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash'],
  },
  engineer: {
    label: 'Engineer',
    description: 'Fixes designs that fail validation or the flight test, using the test report.',
    outputs: ['text'],
    free: [
      'nvidia/nemotron-3.5-super-vl:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'dots-studio/dots-3-note-preview:free',
    ],
    paid: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash'],
  },
  painter: {
    label: 'Painter',
    description:
      'Paints liveries. Image models paint a texture; text models (free) design a pattern that the game draws.',
    outputs: ['image', 'text'],
    free: ['cohere/north-mini-code:free', 'nvidia/nemotron-3.5-super-vl:free', 'dots-studio/dots-3-note-preview:free'],
    paid: ['google/gemini-3.1-flash-image', 'google/gemini-2.5-flash-image', 'openai/gpt-5-image-mini'],
  },
  composer: {
    label: 'Composer',
    description: 'Writes the soundtrack (audio output).',
    outputs: ['audio'],
    free: ['google/lyria-3-clip-preview', 'google/lyria-3-pro-preview'],
    paid: [],
  },
};

export function isFree(m: ModelInfo): boolean {
  return m.id.endsWith(':free') || (m.pricing.prompt === 0 && m.pricing.completion === 0 && !m.id.startsWith('openrouter/auto'));
}

/** Every catalog model that can do this job, newest first. */
export function modelsForJob(models: ModelInfo[], job: JobId, freeOnly = false): ModelInfo[] {
  const j = JOBS[job];
  return models
    .filter((m) => j.outputs.some((o) => m.outputModalities.includes(o)))
    // Audio/image jobs need that output; plain text-only routers can't paint pictures etc.
    .filter((m) => job !== 'composer' || m.outputModalities.includes('audio'))
    .filter((m) => !m.id.endsWith(':batch') && !m.id.startsWith('openrouter/auto') && m.id !== 'openrouter/free')
    .filter((m) => !freeOnly || isFree(m))
    .sort((a, b) => b.created - a.created);
}

/** Default model for a job: the first available free preference, else any free capable model. */
export function defaultModel(models: ModelInfo[], job: JobId, freeOnly = true): string | undefined {
  const ids = new Set(models.map((m) => m.id));
  const j = JOBS[job];
  const pref = [...j.free, ...(freeOnly ? [] : j.paid)].find((id) => ids.has(id));
  return pref ?? modelsForJob(models, job, true)[0]?.id ?? modelsForJob(models, job, freeOnly)[0]?.id;
}

/**
 * Backup models OpenRouter should fail over to if `primary` is rate-limited or down. Only free
 * models are used as backups for a free primary, so "free first" never silently costs money.
 */
export function fallbacksFor(models: ModelInfo[], job: JobId, primary: string): string[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const p = byId.get(primary);
  const primaryFree = p ? isFree(p) : primary.endsWith(':free');
  const sameKind = (id: string) => {
    const m = byId.get(id);
    if (!m) return false;
    if (primaryFree && !isFree(m)) return false;
    // Keep image painters with image painters, text with text.
    return !p || p.outputModalities.includes('image') === m.outputModalities.includes('image');
  };
  return JOBS[job].free.filter((id) => id !== primary && sameKind(id)).slice(0, 2);
}

/** Short price label like "$3.00 / $15.00 per M" or "free". */
export function priceLabel(m: ModelInfo): string {
  if (isFree(m)) return 'free';
  if (m.pricing.prompt < 0) return 'variable';
  const pm = (x: number) => `$${(x * 1e6).toFixed(2)}`;
  return `${pm(m.pricing.prompt)} / ${pm(m.pricing.completion)} per M tok`;
}
