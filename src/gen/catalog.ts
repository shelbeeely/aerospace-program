import type { ModelInfo } from './openrouter.ts';

/**
 * What the game asks models to do. Each task maps to the modalities a model must support,
 * so the UI can offer every capable model on OpenRouter for that job. New tasks (speech for
 * radio chatter, video for replays, embeddings for part search...) slot in here.
 */
export type GenTask = 'design' | 'pilot' | 'livery' | 'music';

export interface TaskInfo {
  label: string;
  description: string;
  needsOutput: string;
  needsInput?: string;
  /** Preferred defaults in order; the first one present in the catalog wins. */
  preferred: string[];
}

export const TASKS: Record<GenTask, TaskInfo> = {
  design: {
    label: 'Designer',
    description: 'Builds craft from a description as validated JSON part graphs.',
    needsOutput: 'text',
    preferred: [
      'anthropic/claude-sonnet-5.5',
      'openai/gpt-6.1-sol',
      'google/gemini-3.8-flash',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
    ],
  },
  pilot: {
    label: 'Pilot',
    description: 'Flies by issuing autopilot targets from telemetry (for races).',
    needsOutput: 'text',
    preferred: ['anthropic/claude-haiku-5.5', 'google/gemini-3.5-flash-lite', 'nvidia/nemotron-3.5-lightning:free'],
  },
  livery: {
    label: 'Painter',
    description: 'Paints craft liveries (image generation).',
    needsOutput: 'image',
    preferred: ['google/gemini-3.1-flash-image', 'google/gemini-2.5-flash-image', 'openai/gpt-5-image-mini'],
  },
  music: {
    label: 'Composer',
    description: 'Generates soundtrack clips (audio output). Not wired into the game yet.',
    needsOutput: 'audio',
    preferred: ['google/lyria-3-clip-preview'],
  },
};

export function modelsForTask(models: ModelInfo[], task: GenTask): ModelInfo[] {
  const t = TASKS[task];
  return models
    .filter((m) => m.outputModalities.includes(t.needsOutput))
    .filter((m) => !t.needsInput || m.inputModalities.includes(t.needsInput))
    .filter((m) => !m.id.endsWith(':batch') && !m.id.startsWith('openrouter/auto'))
    .sort((a, b) => b.created - a.created);
}

export function defaultModel(models: ModelInfo[], task: GenTask): string | undefined {
  const ids = new Set(models.map((m) => m.id));
  return TASKS[task].preferred.find((id) => ids.has(id)) ?? modelsForTask(models, task)[0]?.id;
}

export function isFree(m: ModelInfo): boolean {
  return m.id.endsWith(':free') || (m.pricing.prompt === 0 && m.pricing.completion === 0);
}

/** Short price label like "$3.00 / $15.00 per M" or "free". */
export function priceLabel(m: ModelInfo): string {
  if (isFree(m)) return 'free';
  if (m.pricing.prompt < 0) return 'variable';
  const pm = (x: number) => `$${(x * 1e6).toFixed(2)}`;
  return `${pm(m.pricing.prompt)} / ${pm(m.pricing.completion)} per M tok`;
}
