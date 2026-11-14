import type { BitState } from './bit.ts';

/**
 * How the player's own Bit looks. Only what does not change what a Bit says: YES stays the
 * yellow octahedron and NO the red stellation for everyone, so the choices are the idle light
 * (one of the 1982 lights that is neither yellow nor red), its size, which idle figure it shows
 * (or both, pulsing), and how fast it turns.
 */
export interface BitStyle {
  light: 'blue' | 'cyan' | 'white';
  size: 'small' | 'medium' | 'large';
  idle: 'pulse' | 'compound' | 'triambic';
  spin: 'calm' | 'steady' | 'lively';
}

export const DEFAULT_BIT_STYLE: BitStyle = { light: 'blue', size: 'medium', idle: 'pulse', spin: 'steady' };

/** The choices and what each is called in the hangar, in order. */
export const BIT_STYLE_CHOICES: { [K in keyof BitStyle]: Array<[BitStyle[K], string]> } = {
  light: [['blue', 'Bright blue'], ['cyan', 'Electric cyan'], ['white', 'White']],
  size: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']],
  idle: [['pulse', 'Both figures, pulsing'], ['compound', 'Compound only'], ['triambic', 'Triambic only']],
  spin: [['calm', 'Calm'], ['steady', 'Steady'], ['lively', 'Lively']],
};

export const STYLE_LIGHT: Record<BitStyle['light'], string> = { blue: '#3d7cff', cyan: '#00d4ff', white: '#dff6ff' };
export const STYLE_SIZE: Record<BitStyle['size'], number> = { small: 0.85, medium: 1, large: 1.2 };
export const STYLE_SPIN: Record<BitStyle['spin'], number> = { calm: 0.5, steady: 1, lively: 2.2 };

/** A style read from storage (or anywhere): anything unknown falls back to the default. */
export function sanitizeBitStyle(v: unknown): BitStyle {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const pick = <K extends keyof BitStyle>(k: K): BitStyle[K] => (BIT_STYLE_CHOICES[k].some(([c]) => c === o[k]) ? (o[k] as BitStyle[K]) : DEFAULT_BIT_STYLE[k]);
  return { light: pick('light'), size: pick('size'), idle: pick('idle'), spin: pick('spin') };
}

/** The figure a styled Bit shows for a state: idle may be held to one figure; answers never change. */
export function styledState(state: BitState, style: BitStyle): BitState {
  if ((state === 'idle1' || state === 'idle2') && style.idle !== 'pulse') return style.idle === 'compound' ? 'idle1' : 'idle2';
  return state;
}
