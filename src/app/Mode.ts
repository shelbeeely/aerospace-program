/**
 * The app's two top-level modes.
 * - hangar: physics paused, the craft on the turntable, Studio and craft card visible.
 * - flight: the sim runs; HUD, touch controls, F3 panel and help are available.
 * CSS shows and hides UI through the `mode-hangar` / `mode-flight` body classes.
 */
export type AppMode = 'hangar' | 'flight';

/** `?mode=fly` (or `flight`) starts flying; anything else starts in the hangar. */
export function modeFromQuery(search: string): AppMode {
  return parseMode(new URLSearchParams(search).get('mode') ?? '') ?? 'hangar';
}

/** Accepts the URL spellings too (`fly`), so `game.setMode('fly')` works from the console. */
export function parseMode(m: string): AppMode | null {
  if (m === 'fly' || m === 'flight') return 'flight';
  if (m === 'hangar') return 'hangar';
  return null;
}

export function applyModeClass(mode: AppMode, body: HTMLElement = document.body): void {
  body.classList.toggle('mode-hangar', mode === 'hangar');
  body.classList.toggle('mode-flight', mode === 'flight');
}
