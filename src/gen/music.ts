import type { OpenRouter } from './openrouter.ts';

export interface MusicResult {
  /** Playable URL (data URL or remote URL). */
  audio: string;
  model: string;
  cost: number;
  /** Any text the model returned alongside the audio (lyrics, notes). */
  text: string;
}

export interface MusicRequest {
  model: string;
  fallbacks?: string[];
  prompt: string;
  /** Optional context so the track fits what's on screen. */
  craftName?: string;
  signal?: AbortSignal;
}

/**
 * Ask an audio-output model (Google Lyria via OpenRouter, free at the time of writing) for a
 * soundtrack clip. Audio response shapes vary by provider; `OpenRouter.chat` collects them.
 */
export async function composeMusic(client: OpenRouter, req: MusicRequest): Promise<MusicResult> {
  const res = await client.chat({
    model: req.model,
    fallbacks: req.fallbacks,
    modalities: ['text', 'audio'],
    signal: req.signal,
    messages: [
      {
        role: 'user',
        content:
          `Instrumental soundtrack for a flying game${req.craftName ? ` (the player is flying "${req.craftName}")` : ''}. ` +
          `${req.prompt}. Loopable, no vocals.`,
      },
    ],
  });
  const audio = res.audio[0];
  if (!audio) {
    throw new Error(
      `${res.model} returned no audio${res.content ? `: ${res.content.slice(0, 200)}` : ''}. ` +
        'If this keeps happening, the audio response format may have changed (see findAudio in openrouter.ts).',
    );
  }
  return { audio, model: res.model, cost: res.usage.cost, text: res.content };
}
