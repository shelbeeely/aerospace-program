import { ARCHETYPES } from './BuildingArchetypeRegistry.ts';
import { primitiveArea, primitiveReach, primitiveTriangles, primitiveVolume } from './grammar.ts';
import { DARK_SURFACES, LIGHT_ROLES, SURFACES } from './palette.ts';
import type { GenRequest, Primitive, StructureSpec, ValidationCheck, ValidationReport } from './types.ts';

/**
 * Architectural validation: the ten design checks every generated building must pass. The
 * ArchitectureGenerator regenerates a structure (new seed, re-picked variant) until it passes,
 * and districts reject the ones that never do (leaving negative space instead).
 */
export interface ValidationContext {
  /** Signatures already used in this district → count (variety). */
  signatures?: Map<string, number>;
}

export const TRIANGLE_BUDGET = 24000;
export const COMPONENT_BUDGET = 700;
export const COLLIDER_BUDGET = 200;

/** A coarse fingerprint of a structure's form (variety check). */
export function signature(s: StructureSpec): string {
  return `${s.archetype}:${s.variant}:${Math.round(Math.log2(Math.max(8, s.height)) * 2)}:${Math.round((Math.max(s.w, s.d) / Math.min(s.w, s.d)) * 2)}`;
}

export function validateStructure(s: StructureSpec, req: GenRequest, required: Record<string, number>, ctx: ValidationContext = {}): ValidationReport {
  const checks: ValidationCheck[] = [];
  const add = (id: number, name: string, pass: boolean, detail: string) => checks.push({ id, name, pass, detail });
  const outer = s.components.filter((c) => !c.interior && c.surface !== 'translucent');
  const t12 = outer.filter((c) => c.tier !== 3);

  // 1. A recognisable silhouette: 2–5 dominant masses that own most of the form.
  const masses = new Set<string>();
  for (const c of outer) if (c.tier === 1) masses.add(c.mass !== undefined ? `m${c.mass}` : `c${s.components.indexOf(c)}`);
  const area1 = outer.filter((c) => c.tier === 1).reduce((a, c) => a + primitiveArea(c.prim), 0);
  const area12 = t12.reduce((a, c) => a + primitiveArea(c.prim), 0) || 1;
  add(1, 'Recognisable silhouette', masses.size >= 2 && masses.size <= 5 && area1 / area12 >= 0.2,
    `${masses.size} primary masses, ${(100 * area1 / area12).toFixed(0)}% of primary+secondary surface`);

  // 2. Communicates its computational function: a known function with its required elements.
  const gen = ARCHETYPES[s.archetype];
  const counts = new Map<string, number>();
  for (const c of s.components) counts.set(c.role, (counts.get(c.role) ?? 0) + 1);
  const missing = Object.entries(required).filter(([r, n]) => (counts.get(r) ?? 0) < n).map(([r, n]) => `${r}×${n}`);
  add(2, 'Communicates its function', !!gen && gen.functions.includes(s.function) && missing.length === 0,
    missing.length ? `missing ${missing.join(', ')}` : `${s.function}: ${Object.keys(required).join(', ') || 'form'}`);

  // 3. Belongs to a defined family.
  add(3, 'Belongs to a family', !!gen && gen.variants.includes(s.variant), `${s.archetype} / ${s.variant}`);

  // 4. Integrated with its environment: grounded on a real foundation and plugged into the network.
  const grounded = t12.filter((c) => c.y <= 0.5);
  let gx0 = Infinity, gx1 = -Infinity, gz0 = Infinity, gz1 = -Infinity;
  for (const c of grounded) {
    const r = primitiveReach(c.prim);
    if (r <= 0) continue;
    gx0 = Math.min(gx0, c.x - r); gx1 = Math.max(gx1, c.x + r);
    gz0 = Math.min(gz0, c.z - r); gz1 = Math.max(gz1, c.z + r);
  }
  const lotSq = Math.min(s.w, s.d) ** 2;
  const footArea = gx1 > gx0 ? Math.min(gx1 - gx0, s.w) * Math.min(gz1 - gz0, s.d) : 0;
  const groundLinks = s.connections.filter((c) => c.y <= 1).length;
  add(4, 'Integrated with the terrain', footArea >= 0.25 * lotSq && groundLinks >= 1,
    `grounded footprint ${(100 * footArea / lotSq).toFixed(0)}% of lot square, ${groundLinks} ground connections`);

  // 5. Purposeful illumination: lit, but sparingly: a minority of the masses' edges glow and
  // glowing faces stay a small share of the surface (large unlit surfaces are essential).
  const EDGE_SHARE: Record<string, number> = { none: 0, top: 0.33, base: 0.33, rims: 0.67, silhouette: 0.67, horizontal: 0.5, all: 1 };
  const edgeShare = t12.reduce((a, c) => a + EDGE_SHARE[c.edges], 0) / Math.max(1, t12.length);
  const lit = outer.filter((c) => c.edges !== 'none' || c.surface === 'glow');
  const glowArea = outer.filter((c) => c.surface === 'glow').reduce((a, c) => a + primitiveArea(c.prim), 0);
  const totalArea = outer.reduce((a, c) => a + primitiveArea(c.prim), 0) || 1;
  add(5, 'Purposeful illumination', lit.length >= 1 && edgeShare <= 0.45 && glowArea / totalArea <= 0.08,
    `${(100 * edgeShare).toFixed(0)}% of mass edges lit, glowing faces ${(100 * glowArea / totalArea).toFixed(1)}% of surface`);

  // 6. Not conventional architecture: no plain slab tower, no domestic vocabulary, and enough
  // distinct forms (kind + proportion) among the masses and secondary elements.
  const forms = new Set(t12.map((c) => formKey(c.prim)));
  const tallest = t12.reduce((m, c) => (c.prim.kind === 'box' && c.prim.h > (m?.prim.kind === 'box' ? m.prim.h : 0) ? c : m), t12[0]);
  const slab = tallest?.prim.kind === 'box' && tallest.prim.h > 3.5 * Math.max(tallest.prim.w, tallest.prim.d) && forms.size < 3;
  const forbidden = s.components.some((c) => c.role === 'window' || c.role === 'door-house' || c.role === 'brick');
  add(6, 'Avoids conventional architecture', !slab && !forbidden && forms.size >= 3,
    `${forms.size} distinct forms${slab ? ', plain slab tower' : ''}`);

  // 7. The 1982 visual language: palette only, dark masses dominate.
  const badSurf = s.components.filter((c) => !SURFACES.includes(c.surface));
  const badLight = s.components.filter((c) => c.light && !LIGHT_ROLES.includes(c.light));
  const darkArea = outer.filter((c) => DARK_SURFACES.has(c.surface)).reduce((a, c) => a + primitiveArea(c.prim), 0);
  add(7, '1982 visual language', !badSurf.length && !badLight.length && darkArea / totalArea >= 0.75,
    `${(100 * darkArea / totalArea).toFixed(0)}% unlit surface${badSurf.length + badLight.length ? `, ${badSurf.length + badLight.length} off-palette` : ''}`);

  // 8. Contributes variety: no more than two identical forms in a district.
  const sig = signature(s);
  const seen = ctx.signatures?.get(sig) ?? 0;
  add(8, 'Contributes variety', seen < 2, `${sig} (${seen} already in district)`);

  // 9. Scale fits the region and the lot.
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
  for (const c of s.colliders) {
    x0 = Math.min(x0, c.x - c.sx / 2); x1 = Math.max(x1, c.x + c.sx / 2);
    z0 = Math.min(z0, c.z - c.sz / 2); z1 = Math.max(z1, c.z + c.sz / 2);
    top = Math.max(top, c.y + c.sy / 2);
  }
  const [lw, ld] = s.rotation % 2 ? [s.d, s.w] : [s.w, s.d];
  const inLot = x0 >= s.x - lw / 2 - 3 && x1 <= s.x + lw / 2 + 3 && z0 >= s.z - ld / 2 - 3 && z1 <= s.z + ld / 2 + 3;
  const scaleOk = top <= req.maxHeight * 1.12 + 6 && s.height >= Math.min(req.minHeight * 0.5, 8);
  add(9, 'Scale fits region and lot', inLot && scaleOk, `${s.height.toFixed(0)} m (limit ${req.maxHeight.toFixed(0)} m), ${inLot ? 'inside' : 'outside'} its lot`);

  // 10. Real-time friendly.
  const tris = s.components.reduce((a, c) => a + primitiveTriangles(c.prim), 0);
  add(10, 'Optimised for real time', tris <= TRIANGLE_BUDGET && s.components.length <= COMPONENT_BUDGET && s.colliders.length <= COLLIDER_BUDGET,
    `${tris} triangles, ${s.components.length} components, ${s.colliders.length} colliders`);

  void primitiveVolume;
  return { pass: checks.every((c) => c.pass), checks, attempts: 1 };
}

/** Form identity for variety counting: kind plus coarsely quantised proportions. */
function formKey(p: Primitive): string {
  const q = (v: number) => Math.round(Math.log2(Math.max(0.5, v)) * 2);
  switch (p.kind) {
    case 'box': return `b${q(p.w)}.${q(p.h)}.${q(p.d)}.${p.taper ? 't' : ''}`;
    case 'prism': return `p${p.sides}.${q(p.r0)}.${q(p.r1 + 0.5)}.${q(p.h)}`;
    case 'lathe': return `l${p.profile.length}.${q(p.profile[0][0])}`;
    case 'ring': return `r${q(p.r1)}.${q(p.h)}`;
    case 'torus': return `t${q(p.R)}`;
    case 'extrude': return `e${p.outline.length}.${q(p.h)}`;
    case 'sweep': return `s${p.section.length}.${p.path.length}`;
    case 'frustum': return `f${q(p.w)}.${q(p.h)}.${q(p.wt)}`;
    case 'dome': return `d${q(p.rx)}.${q(p.h)}`;
    case 'sphere': return `o${q(p.r)}`;
  }
}
