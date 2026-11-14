import { BIT_STYLE_CHOICES, DEFAULT_BIT_STYLE, STYLE_SIZE, type BitStyle } from './bitStyle.ts';

/**
 * A Bit's genes: what it inherits from the two Bits that compiled it and passes on to its own.
 * Pure data, no three.js, no DOM, no physics: the relay (server/) runs the same code.
 *
 * Behaviour genes (0..1, 0.5 is the Bit as it always was):
 * - **pace**: how fast it walks (and what walking costs it).
 * - **boldness**: how late it flinches from a fast vehicle (the timidest see one coming four
 *   times as far off as a middle Bit, the boldest a quarter as far). Timid Bits step back in time
 *   and live; each scare costs them a conversation.
 * - **sociability**: how far off it stops to talk, and how soon it is ready to talk again.
 * - **agreeable**: how readily it answers YES. Two YESes between grown Bits compile a child.
 * - **homebody**: how much of its life it spends indoors, where it recharges and is safe.
 * - **pickiness**: how much a partner's look matters to its YES (Bits prefer their own kind).
 *
 * Combat genes (they matter only once the sides draft sappers): **nerve**, **stealth** and
 * **craft** (sapper skill, which climbs the ladder of charges a Bit can set by hand).
 *
 * Its look is inherited too: the four `bitStyle` choices (idle light, size, idle figure, spin).
 * YES stays the yellow octahedron and NO the red stellation for every Bit.
 */
export const GENES = ['pace', 'boldness', 'sociability', 'agreeable', 'homebody', 'pickiness', 'nerve', 'stealth', 'craft'] as const;
export type Gene = (typeof GENES)[number];
/** The genes that shape everyday behaviour (charted in the lab and the census). */
export const BEHAVIOUR_GENES: readonly Gene[] = ['pace', 'boldness', 'sociability', 'agreeable', 'homebody', 'pickiness'];
export const COMBAT_GENES: readonly Gene[] = ['nerve', 'stealth', 'craft'];
export const GENE_LABEL: Record<Gene, string> = {
  pace: 'Pace', boldness: 'Boldness', sociability: 'Sociability', agreeable: 'Agreeable', homebody: 'Homebody',
  pickiness: 'Pickiness', nerve: 'Nerve', stealth: 'Stealth', craft: 'Craft',
};

export type BitGenome = Record<Gene, number> & { style: BitStyle };

export const STYLE_FIELDS = ['light', 'size', 'idle', 'spin'] as const satisfies ReadonlyArray<keyof BitStyle>;
export type StyleField = (typeof STYLE_FIELDS)[number];

/** A small seeded stream (mulberry32), here so the genome needs nothing from the world. */
export function seededRand(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A standard normal draw from a uniform stream (Box-Muller). */
export function gauss(rand: () => number): number {
  const u = Math.max(1e-9, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function choiceIndex<F extends StyleField>(f: F, v: BitStyle[F]): number {
  return BIT_STYLE_CHOICES[f].findIndex(([c]) => c === v);
}

/**
 * A founder: one of the Bits a lot has when it is first seen. `paceDraw` is the draw that set a
 * Bit's pace before Bits had genes, so founders walk exactly as they always did; the rest comes
 * from `rand` (its own stream). `district` (0..1, a hash of the district) gives each district a
 * variant look that a minority of its founders wear.
 */
export function founderGenome(rand: () => number, paceDraw: number, district: number): BitGenome {
  const g = {} as BitGenome;
  for (const k of GENES) g[k] = 0.25 + rand() * 0.5;
  // Today's pace range (1.4..3.4 m/s) is the middle two thirds of the gene's.
  g.pace = 1 / 6 + paceDraw * (4 / 6);
  // Sapper skill has to be earned: founders are barely able to set a charge at all.
  g.craft = 0.05 + rand() * 0.12;
  const style = { ...DEFAULT_BIT_STYLE };
  for (const [i, f] of STYLE_FIELDS.entries()) {
    const choices = BIT_STYLE_CHOICES[f];
    const r = rand();
    if (r < 0.15) {
      // The district's variant for this field (never the default itself).
      const others = choices.filter(([c]) => c !== DEFAULT_BIT_STYLE[f]);
      const pick = others[Math.floor(((district * 7.31 + i * 0.37) % 1) * others.length)];
      (style as Record<StyleField, string>)[f] = pick[0];
    } else if (r < 0.17) {
      (style as Record<StyleField, string>)[f] = choices[Math.floor(rand() * choices.length)][0];
    }
  }
  g.style = style;
  return g;
}

/** A child's genes before mutation: each gene and each style field from one parent or the other. */
export function crossover(a: BitGenome, b: BitGenome, rand: () => number): BitGenome {
  const g = {} as BitGenome;
  for (const k of GENES) g[k] = rand() < 0.5 ? a[k] : b[k];
  const style = {} as BitStyle;
  for (const f of STYLE_FIELDS) (style as Record<StyleField, string>)[f] = rand() < 0.5 ? a.style[f] : b.style[f];
  g.style = style;
  return g;
}

/**
 * Copying errors: each gene has a chance `rate` of a Gaussian step (σ `sigma`), clamped to
 * 0..1; each style field a chance `rate / 4` of turning into another of its choices.
 */
export function mutate(g: BitGenome, rate: number, rand: () => number, sigma = 0.08): BitGenome {
  for (const k of GENES) if (rand() < rate) g[k] = clamp01(g[k] + gauss(rand) * sigma);
  for (const f of STYLE_FIELDS) {
    if (rand() >= rate / 4) continue;
    const choices = BIT_STYLE_CHOICES[f];
    const at = choiceIndex(f, g.style[f]);
    const next = (at + 1 + Math.floor(rand() * (choices.length - 1))) % choices.length;
    g.style = { ...g.style, [f]: choices[next][0] };
  }
  return g;
}

/** How different two Bits look: the share of the four style fields they do not share (0..1). */
export function styleDistance(a: BitStyle, b: BitStyle): number {
  let n = 0;
  for (const f of STYLE_FIELDS) if (a[f] !== b[f]) n++;
  return n / STYLE_FIELDS.length;
}

/** What the genes do: the numbers behaviour reads. A genome of all 0.5 gives the constants Bits had before. */
export interface Phenotype {
  /** Walking pace (m/s). */
  pace: number;
  /** Multipliers on the scare range and on the speed that scares it. */
  scareRange: number;
  scareSpeed: number;
  /** Multipliers on the talk range and the cooldown after talking. */
  talkRange: number;
  cooldown: number;
  /** Chance of answering YES (before pickiness): 0.5 for a middle Bit, as before. */
  yes: number;
  /** Share of its people indoors when a lot streams in, the weight of going home, and how long it stays. */
  indoors: number;
  homeWeight: number;
  stay: number;
  /** Its size: hit range and energy capacity scale with it. */
  size: number;
}

export function express(g: BitGenome): Phenotype {
  const social = 2 ** (2 * g.sociability - 1);
  return {
    pace: 0.9 + 3 * g.pace,
    // The timidest see trouble coming four times as far off; the boldest a quarter as far.
    scareRange: 2 ** (2 - 4 * g.boldness),
    scareSpeed: 2 ** (2 * g.boldness - 1),
    talkRange: Math.sqrt(social),
    cooldown: 1 / social,
    yes: 0.2 + 0.6 * g.agreeable,
    indoors: 0.2 + 0.8 * g.homebody,
    homeWeight: 0.3 + 1.4 * g.homebody,
    stay: 2 ** (2 * g.homebody - 1),
    size: STYLE_SIZE[g.style.size],
  };
}

/**
 * The chance that `listener` answers YES to `speaker`: its own readiness, lowered by how picky it
 * is and how different the speaker looks. `prestige` (0..1) raises it for a speaker others look
 * up to (a sapper back from a mission).
 */
export function yesChance(listener: BitGenome, speaker: BitGenome, prestige = 0): number {
  const base = (0.2 + 0.6 * listener.agreeable) * (1 - listener.pickiness * styleDistance(listener.style, speaker.style));
  return Math.min(1, base + prestige * (1 - base) * 0.5);
}

/** The middle genome: what a Bit was before genes. */
export function midGenome(): BitGenome {
  const g = {} as BitGenome;
  for (const k of GENES) g[k] = 0.5;
  g.style = { ...DEFAULT_BIT_STYLE };
  return g;
}

/** A genome read from anywhere (storage, the network): anything malformed is refused (null). */
export function sanitizeGenome(v: unknown): BitGenome | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const g = {} as BitGenome;
  for (const k of GENES) {
    const x = o[k];
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) return null;
    g[k] = x;
  }
  const s = o.style as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object') return null;
  const style = {} as BitStyle;
  for (const f of STYLE_FIELDS) {
    if (!BIT_STYLE_CHOICES[f].some(([c]) => c === s[f])) return null;
    (style as Record<StyleField, unknown>)[f] = s[f];
  }
  g.style = style;
  return g;
}

/** Style fields packed into one byte (two bits each) and back: for the compact pool encoding. */
export function packStyle(s: BitStyle): number {
  let b = 0;
  for (const [i, f] of STYLE_FIELDS.entries()) b |= Math.max(0, choiceIndex(f, s[f])) << (i * 2);
  return b;
}

export function unpackStyle(b: number): BitStyle | null {
  const style = {} as BitStyle;
  for (const [i, f] of STYLE_FIELDS.entries()) {
    const c = BIT_STYLE_CHOICES[f][(b >> (i * 2)) & 3];
    if (!c) return null;
    (style as Record<StyleField, unknown>)[f] = c[0];
  }
  return style;
}
