import { ARCHETYPES } from './BuildingArchetypeRegistry.ts';
import { resolveParams } from './generators/common.ts';
import { rotQ } from './grammar.ts';
import { furnishInterior, inhabit } from './InteriorGenerator.ts';
import type { ActivityState } from './palette.ts';
import { hash32, Rng } from './rng.ts';
import type { GenRequest, StructureSpec } from './types.ts';
import { signature, validateStructure, type ValidationContext } from './validation.ts';

/** Regeneration attempts before a structure is rejected. */
export const MAX_ATTEMPTS = 6;

/**
 * The entry point of the architecture system: request → validated StructureSpec.
 *
 * Deterministic: the same request (seed included) always yields the same structure. Each attempt
 * draws function, variant and parameters from its own seeded stream; a failed validation retries
 * with a derived seed (re-picking anything the request did not force).
 */
export function generateStructure(req: GenRequest, ctx: ValidationContext = {}): StructureSpec {
  const gen = ARCHETYPES[req.archetype];
  let last: StructureSpec | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const seed = attempt === 0 ? req.seed >>> 0 : hash32(req.seed, attempt, 0x5eed);
    const rng = new Rng(seed);
    const pick = rng.fork(1);
    const func = req.func && gen.functions.includes(req.func) ? req.func : pick.pick(gen.functions);
    let variant = req.variant && gen.variants.includes(req.variant) ? req.variant : pick.chance(0.72) ? gen.variantFor[func] : pick.pick(gen.variants);
    if (!req.variant && !req.landmark && gen.landmarkVariants?.includes(variant) && pick.chance(0.85)) {
      variant = pick.pick(gen.variants.filter((v) => !gen.landmarkVariants!.includes(v)));
    }
    const params = resolveParams(gen.params, rng.fork(2), req.params);
    // Orientation: elongated families lay their long axis along local x.
    let w = req.w, d = req.d;
    let rotation: 0 | 1 | 2 | 3 = req.rotation ?? (pick.chance(0.5) ? 0 : 2);
    if (gen.elongated && d > w * 1.05) {
      [w, d] = [d, w];
      rotation = ((rotation + 1) % 4) as 0 | 1 | 2 | 3;
    } else if (!gen.elongated && req.rotation === undefined) rotation = pick.int(0, 3) as 0 | 1 | 2 | 3;
    // People live in the buildings: a structure generated solid gets a commons hollowed out of
    // its largest grounded mass. If that costs it a validation check, it stays solid.
    let spec: StructureSpec | null = null;
    for (const lived of [true, false]) {
      const out = gen.build({ ...req, w, d }, rng.fork(3), params, func, variant);
      const made = lived && !out.interior;
      if (made) out.interior = inhabit(out.b, w, d, rng.fork(5));
      if (lived && !out.interior) continue; // nothing to hollow: the plain build below
      if (out.interior) furnishInterior(out.b, out.interior, out.accent);
      spec = assemble(req, seed, func, variant, params, w, d, rotation, out, rng.fork(4));
      const report = validateStructure(spec, req, out.required, ctx);
      spec.validation = report;
      if (report.pass || !made) break;
    }
    if (!spec?.validation) throw new Error('unreachable');
    spec.validation.attempts = attempt + 1;
    last = spec;
    if (spec.validation.pass) break;
  }
  const s = last!;
  if (s.validation?.pass && ctx.signatures) {
    const sig = signature(s);
    ctx.signatures.set(sig, (ctx.signatures.get(sig) ?? 0) + 1);
  }
  return s;
}

function assemble(req: GenRequest, seed: number, func: string, variant: string, params: Record<string, number>, w: number, d: number, rotation: 0 | 1 | 2 | 3, out: ReturnType<(typeof ARCHETYPES)['circuit']['build']>, rng: Rng): StructureSpec {
  const b = out.b;
  const toWorld = (x: number, z: number): [number, number] => {
    const [rx, rz] = rotQ(x, z, rotation);
    return [req.x + rx, req.z + rz];
  };
  const colliders = b.cols.map((c) => {
    const [x, z] = toWorld(c.x, c.z);
    const [sx, sz] = rotation % 2 ? [c.sz, c.sx] : [c.sx, c.sz];
    return { ...c, x, z, sx, sz };
  });
  const connections = b.connections.map((c) => {
    const [x, z] = toWorld(c.x, c.z);
    return { ...c, x, z, dir: c.dir < 0 ? -1 : (c.dir + rotation) % 4 };
  });
  let roof: StructureSpec['roof'];
  if (out.roof) {
    const [x, z] = toWorld(out.roof.x, out.roof.z);
    roof = { x, y: out.roof.y, z, r: out.roof.r };
  }
  const lights = new Set<string>();
  for (const c of b.comps) if (c.light) lights.add(c.light);
  const lit = b.comps.filter((c) => c.edges !== 'none' || c.surface === 'glow').length;
  const activity: ActivityState = req.region === 'outlands'
    ? rng.weighted([['active', 0.3], ['idle', 0.25], ['damaged', 0.2], ['inactive', 0.25]] as const)
    : rng.weighted([['active', 0.62], ['idle', 0.26], ['damaged', 0.05], ['inactive', 0.07]] as const);
  return {
    id: `${req.archetype[0]}${(req.seed >>> 0).toString(36)}`,
    archetype: req.archetype, function: func, variant, seed,
    x: req.x, y: 0, z: req.z, rotation, w, d, height: out.height, params,
    palette: { primary: out.primary, secondary: out.secondary, accent: out.accent, secondaryLight: out.secondaryLight },
    illumination: { roles: [out.accent, out.secondaryLight, ...[...lights].filter((l) => l !== out.accent && l !== out.secondaryLight)] as StructureSpec['illumination']['roles'], intensity: 1, pulse: out.pulse, edgeDensity: lit / Math.max(1, b.comps.length) },
    connections, interior: out.interior, activity,
    components: b.comps, colliders, roof,
    ...(req.landmark ? { landmark: req.landmark } : {}),
  };
}
