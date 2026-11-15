/**
 * Pairing codes for the phone-as-gamepad link on the relay (server/pads.ts): four letters, no
 * lookalikes. Its own module, free of imports, so the relay can use it without the game.
 */
export const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PAIR_LENGTH = 4;

/** A fresh pairing code. `random`: 0..1 (the pages pass crypto-backed randomness). */
export function pairCode(random: () => number): string {
  let s = '';
  for (let i = 0; i < PAIR_LENGTH; i++) s += PAIR_ALPHABET[Math.floor(random() * PAIR_ALPHABET.length) % PAIR_ALPHABET.length];
  return s;
}

export const isPairCode = (v: unknown): v is string =>
  typeof v === 'string' && v.length === PAIR_LENGTH && [...v].every((c) => PAIR_ALPHABET.includes(c));
