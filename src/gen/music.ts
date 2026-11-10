import type { OpenRouter } from './openrouter.ts';

export interface MusicResult {
  /** Playable URL (data URL or remote URL). */
  audio: string;
  model: string;
  cost: number;
  /** Any text the model returned alongside the audio (lyrics, notes). */
  text: string;
}

/** Genre presets: the model follows concrete instrumentation far better than a genre name. */
export const MUSIC_STYLES: Record<string, { label: string; prompt: string }> = {
  grid: { label: 'The Grid (1982)', prompt: 'Early-80s electronic film score: analog modular synthesizer voices blended with a symphony orchestra and pipe organ, stately brass, crystalline sequenced arpeggios, vast and mysterious, a monumental digital world, 84 BPM' },
  lightcycle: { label: 'Light cycle race', prompt: 'Driving early-80s analog synth action cue: pulsing sequencer ostinato, timpani and orchestral strings, urgent brass stabs, racing through a digital arena, 132 BPM' },
  solar: { label: 'Solar sailer', prompt: 'Slow, luminous early-80s synthesizer and string-orchestra drift: sustained choir pads, gentle sequenced chimes, floating over a glowing geometric landscape, 70 BPM' },
  outlands: { label: 'Outlands', prompt: 'Sparse, eerie analog synth ambience: low drones, distant metallic pulses, slow organ chords, a lonely electronic wilderness, 60 BPM' },
  mcp: { label: 'Master control', prompt: 'Ominous early-80s synth and orchestra: deep pipe organ, minor-key brass, heavy sequenced bass, a towering control program, 92 BPM' },
};

export interface MusicRequest {
  model: string;
  fallbacks?: string[];
  prompt: string;
  /** A MUSIC_STYLES key (default grid); the free-text prompt adds to it. */
  style?: string;
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
          `Instrumental soundtrack for a game set inside a 1982-style digital world of monumental electronic architecture${req.craftName ? ` (the player is in "${req.craftName}")` : ''}. ` +
          `${req.style ? `${MUSIC_STYLES[req.style]?.prompt ?? req.style}. ` : ''}${req.prompt ? `${req.prompt}. ` : ''}Loopable, no vocals.`,
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
