import type { ModelInfo } from './openrouter.ts';

/**
 * The crew: each job is done by its own model, chosen from the live OpenRouter catalog.
 * Defaults are FREE models, each with free backups that OpenRouter fails over to when one is
 * rate-limited. Paid models stay one click away in the same pickers.
 */
export type JobId = 'designer' | 'engineer' | 'composer';

export interface JobInfo {
  label: string;
  description: string;
  /** Output modality a model needs. */
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
    // Tested on full craft drafts; models that thought past their output budget were dropped.
    free: [
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'dots-studio/dots-3-note-preview:free',
      'google/gemma-4-31b-it:free',
    ],
    paid: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash'],
  },
  engineer: {
    label: 'Engineer',
    description: 'Fixes designs that fail validation or the flight test, using the test report.',
    outputs: ['text'],
    // Tested on repairing a failed canard design: these returned complete JSON.
    free: [
      'dots-studio/dots-3-note-preview:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
    ],
    paid: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash'],
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
    // Speech models (gpt-audio) output audio but only talk: they can't compose music.
    .filter((m) => job !== 'composer' || !/gpt-audio|tts|speech/i.test(m.id))
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
    // Keep image-output models with image-output models, text with text.
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
