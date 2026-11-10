import { primitiveHeight, type Builder } from '../grammar.ts';
import type { LightRole, Surface } from '../palette.ts';
import { clamp, lerp, Rng } from '../rng.ts';
import type { GenRequest, InteriorConfig, ParamDef } from '../types.ts';

/** What a family generator hands back to the ArchitectureGenerator. */
export interface GenOutput {
  b: Builder;
  height: number;
  interior: InteriorConfig | null;
  /** Flat roof (local centre, height, half-size) usable as a helipad. */
  roof?: { x: number; y: number; z: number; r: number };
  /** Roles the function requires (validation check 2): role → minimum count. */
  required: Record<string, number>;
  primary: Surface;
  secondary: Surface;
  accent: LightRole;
  secondaryLight: LightRole;
  pulse: number;
}

export interface FamilyGenerator {
  id: string;
  label: string;
  /** Source of the visual language (book pages). */
  reference: string;
  description: string;
  functions: readonly string[];
  variants: readonly string[];
  /** Which variant each function builds by default. */
  variantFor: Record<string, string>;
  params: readonly ParamDef[];
  /** Lot preferences in blocks: smallest/largest side, and elongation (1 square .. 3 long). */
  lot: { min: number; max: number; elongation: number };
  /** True if the generator lays its long axis along local x (lots are rotated to fit). */
  elongated: boolean;
  /** Variants reserved (mostly) for landmarks: ordinary lots rarely get them. */
  landmarkVariants?: readonly string[];
  build(req: GenRequest, rng: Rng, p: Record<string, number>, func: string, variant: string): GenOutput;
}

/** Resolve parameters: overrides win, otherwise a seeded draw in [min, max] snapped to the step. */
export function resolveParams(defs: readonly ParamDef[], rng: Rng, overrides?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of defs) {
    const r = rng.next(); // always drawn, so overriding one parameter never reshuffles the others
    const v = overrides && overrides[d.key] !== undefined ? overrides[d.key] : d.min + (d.max - d.min) * r;
    out[d.key] = clamp(Math.round(v / d.step) * d.step, d.min, d.max);
  }
  return out;
}

/** Overall height for a request: between the lot's limits, pushed up by monumentality. */
export function pickHeight(req: GenRequest, rng: Rng, frac: number): number {
  const t = clamp(frac * (0.55 + 0.45 * req.intensity) + rng.range(-0.08, 0.08), 0, 1);
  return Math.max(req.minHeight, Math.min(req.maxHeight, lerp(req.minHeight, req.maxHeight, t)));
}

/** Pick a light accent for a region (cool by default; warm accents where they mean something). */
export function regionAccent(region: string, rng: Rng): { accent: LightRole; secondary: LightRole } {
  switch (region) {
    case 'industrial': return { accent: rng.chance(0.6) ? 'process' : 'structure', secondary: 'entrance' };
    case 'communication': return { accent: 'structure', secondary: rng.chance(0.5) ? 'energy' : 'data' };
    case 'control': return { accent: 'structure', secondary: rng.chance(0.3) ? 'process' : 'energy' };
    case 'transport': return { accent: 'structure', secondary: 'entrance' };
    case 'machine-city': return { accent: rng.chance(0.75) ? 'structure' : 'data', secondary: 'data' };
    case 'caverns': return { accent: 'data', secondary: 'structure' };
    case 'outlands': return { accent: rng.chance(0.5) ? 'process' : 'entrance', secondary: 'warning' };
    default: return { accent: 'structure', secondary: 'data' };
  }
}

export const TAU = Math.PI * 2;

/** Highest point of everything built so far (m above the lot base). */
export function topOf(b: Builder): number {
  let m = 0;
  for (const c of b.comps) if (c.surface !== 'translucent') m = Math.max(m, c.y + primitiveHeight(c.prim));
  return m;
}
