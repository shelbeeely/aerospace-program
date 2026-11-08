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
  synthwave: { label: 'Synthwave', prompt: 'Synthwave / retrowave: warm analog polysynth pads, pulsing arpeggiated sawtooth bass, gated-reverb snare, LinnDrum-style beat, soaring lead synth melody, 80s retro-futurist night drive, 105 BPM' },
  outrun: { label: 'Outrun', prompt: 'Outrun: fast driving 80s synth music, octave-bouncing bass, bright brassy synth stabs, punchy gated drums, sunset-highway energy, 118 BPM' },
  darksynth: { label: 'Darksynth', prompt: 'Darksynth: heavy distorted analog bass, ominous minor-key arpeggios, cold digital pads, hard-hitting drum machine, cyberpunk tension, 100 BPM' },
  grid: { label: 'Grid ambient', prompt: 'Ambient electronic in a vast digital world: slow evolving glassy synth pads, sparkling arpeggios, deep sub bass, light electronic percussion, calm and wide, 90 BPM' },
  adventure: { label: 'Flying adventure', prompt: 'Breezy, optimistic orchestral-electronic flying adventure theme' },
};

export interface MusicRequest {
  model: string;
  fallbacks?: string[];
  prompt: string;
  /** A MUSIC_STYLES key (default synthwave); the free-text prompt adds to it. */
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
          `Instrumental soundtrack for a neon flying game set inside a computer world${req.craftName ? ` (the player is flying "${req.craftName}")` : ''}. ` +
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
