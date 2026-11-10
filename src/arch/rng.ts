/**
 * Deterministic randomness for the digital world. Everything procedural is a pure function of
 * integer coordinates and a world seed, so any chunk, district or structure can be regenerated
 * on its own, in any order, on any machine, and come out identical (no global RNG state).
 */

/** 32-bit avalanche mix of any number of integers → uint32. */
export function hash32(...ints: number[]): number {
  let h = 0x811c9dc5 ^ ints.length;
  for (let i = 0; i < ints.length; i++) {
    h = Math.imul(h ^ (ints[i] | 0), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  h = Math.imul(h ^ (h >>> 15), 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** hash32 → [0, 1). */
export function hashFloat(...ints: number[]): number {
  return hash32(...ints) / 4294967296;
}

/** Seed from a string (FNV-1a), for named sub-streams. */
export function strSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Small, fast, seedable PRNG (mulberry32) with the helpers generators need. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed | 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Uniform in [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Integer in [a, b] inclusive. */
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** Weighted choice from [value, weight] pairs (weights ≤ 0 never chosen). */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    let total = 0;
    for (const [, w] of entries) total += Math.max(0, w);
    let r = this.next() * total;
    for (const [v, w] of entries) {
      if (w <= 0) continue;
      r -= w;
      if (r < 0) return v;
    }
    return entries[entries.length - 1][0];
  }
  /** An independent stream for a sub-part (so adding a detail never reshuffles the rest). */
  fork(tag: number): Rng {
    return new Rng(hash32(this.s, tag));
  }
}

/** Quantise a value onto a step (generators snap dimensions to a module so forms read as engineered). */
export const snap = (v: number, step: number) => Math.round(v / step) * step;
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
