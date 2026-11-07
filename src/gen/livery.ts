import type { OpenRouter } from './openrouter.ts';

export interface LiveryResult {
  /** Downscaled JPEG data URL, small enough to keep in the library. */
  image: string;
  model: string;
  cost: number;
}

/**
 * Ask an image model for a tileable paint-scheme texture and shrink it to 512 px. It's applied
 * to every part's material (tinted by the part colour), so patterns and colour schemes work
 * best. Browser-only (uses a canvas).
 */
export async function paintLivery(
  client: OpenRouter,
  model: string,
  prompt: string,
  craftName: string,
  signal?: AbortSignal,
): Promise<LiveryResult> {
  const res = await client.chat({
    model,
    modalities: ['image', 'text'],
    messages: [
      {
        role: 'user',
        content:
          `Create a square, seamless, tileable texture to be used as an aircraft paint scheme for "${craftName}". ` +
          `Style: ${prompt}. Flat graphic surface pattern filling the whole frame, viewed straight on. ` +
          `No aircraft, no background scene, no text, no borders, no shadows.`,
      },
    ],
    signal,
  });
  const src = res.images[0];
  if (!src) throw new Error(`${model} returned no image${res.content ? `: ${res.content.slice(0, 160)}` : ''}`);
  return { image: await downscale(src, 512), model: res.model, cost: res.usage.cost };
}

async function downscale(src: string, size: number): Promise<string> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  // Centre-crop to square.
  const s = Math.min(img.width, img.height);
  g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.82);
}
