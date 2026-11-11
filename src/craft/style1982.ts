import * as THREE from 'three';
import type { CraftDef, PartDef } from './types.ts';

/**
 * The 1982 vehicle palette (AGENTS.md §4-5), enforced on every craft whatever its source
 * (built-in, Studio, AI designer): large dark bodies of deep blue, navy, near-black or
 * desaturated metallic blue, and light that is selective and means something: thin accent
 * strips, canopies, tips, nozzles and the trail, in electric cyan, bright blue, red, orange,
 * amber or white. Pure and idempotent: styling a styled craft changes nothing.
 */

/** Body surfaces, cool (most programs) and warm (red-team vehicles: the tank, recognisers). */
export const BODY_COOL = ['#070b14', '#0b1a33', '#10284f', '#2a4466', '#6f8aa8'] as const;
export const BODY_WARM = ['#0d0605', '#1a0a08', '#2a0e08', '#4a1a10', '#6a3020'] as const;
/** Light: electric cyan, bright blue, red, orange, amber, white. */
export const LIGHTS = ['#00d4ff', '#3d7cff', '#ff2a12', '#ff6a00', '#ffb000', '#dff6ff'] as const;
const LIGHT_HUES = [190, 222, 6, 25, 41]; // degrees, matching LIGHTS[0..4]
/** At most this share of the craft's surface may be lit. */
const LIGHT_SHARE = 0.25;

/** Kinds that are light by function: accents, lamps, canopies, tips, nozzles, light lines. */
const LIGHT_KIND = /light|lamp|accent|stripe|trim|glow|led|beacon|canopy|visor|cockpit.?glass|windshield|edge|line|tip|exhaust|nozzle|thruster|emitter|halo|ring.?light/i;

function hsl(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hue * 60, s, l];
}

const hueDist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/** Snap a colour to the nearest 1982 light colour by hue (unsaturated: white). */
export function snapLight(color: string): string {
  if ((LIGHTS as readonly string[]).includes(color.toLowerCase())) return color.toLowerCase(); // already a 1982 light
  const c = hsl(color);
  if (!c || c[1] < 0.2) return LIGHTS[5];
  let best = 0;
  for (let i = 1; i < LIGHT_HUES.length; i++) if (hueDist(c[0], LIGHT_HUES[i]) < hueDist(c[0], LIGHT_HUES[best])) best = i;
  return LIGHTS[best];
}

/** Is this a warm (red/orange) colour, with some saturation? */
function warm(color: string): boolean {
  const c = hsl(color);
  return !!c && c[1] > 0.3 && (c[0] < 40 || c[0] > 330);
}

/** Snap a colour to a 1982 body surface: its lightness picks the step, warm hues stay warm. */
export function snapBody(color: string, warmBody: boolean): string {
  const c = hsl(color);
  const l = c ? c[2] : 0.2;
  const set = warmBody ? BODY_WARM : BODY_COOL;
  // Bodies stay dark: even a white or pastel part becomes pale steel at most.
  const i = l < 0.1 ? 0 : l < 0.22 ? 1 : l < 0.4 ? 2 : l < 0.65 ? 3 : 4;
  return set[i];
}

const isPalette = (c: string, set: readonly string[]) => set.includes(c.toLowerCase());

function dims(p: PartDef): number[] {
  const s = p.shape;
  return s.type === 'box' ? [...s.size] : s.type === 'sphere' ? [2 * s.radius, 2 * s.radius, 2 * s.radius] : [2 * s.radius, 2 * s.radius, s.length];
}

function area(p: PartDef): number {
  const [a, b, c] = dims(p);
  return 2 * (a * b + b * c + a * c);
}

/** Lit by function or form: a light kind, a thin visual strip, or already a 1982 light colour. */
function lightCandidate(p: PartDef): boolean {
  if (LIGHT_KIND.test(p.kind) || LIGHT_KIND.test(p.id)) return true;
  if (isPalette(p.color, LIGHTS)) return true;
  if (/strut|leg|pylon|fairing|arm\b|arm\.|brace|boom|mast|gear/i.test(`${p.kind} ${p.id}`)) return false; // structure, not light
  const d = dims(p).sort((x, y) => x - y);
  return p.collider === false && d[0] <= 0.15 && d[2] >= 4 * d[0] && !(p.modules?.length);
}

/** The craft's circuit colour: its trail's light, else the light its parts use most, else cyan. */
export function circuitOf(def: CraftDef): string {
  for (const p of def.parts) for (const m of p.modules ?? []) if (m.type === 'trail' && m.color) return snapLight(m.color);
  const tally = new Map<string, number>();
  for (const p of def.parts) {
    const c = hsl(p.color);
    if (!c || c[1] < 0.35 || c[2] < 0.3) continue; // only saturated, lit-looking colours vote
    const l = snapLight(p.color);
    tally.set(l, (tally.get(l) ?? 0) + area(p));
  }
  let best: string = LIGHTS[0], n = 0;
  for (const [c, a] of tally) if (a > n) { best = c; n = a; }
  return best;
}

/**
 * Functional light for craft drawn without any: a thin strip along the leading edge of each
 * lifting surface (wings, tail, fin) at least 1 m across. Inside the surface's own box (so it
 * stays connected), no collider, 10 g. Ids start with "light.auto." so restyling never doubles them.
 */
function leadingEdgeLights(def: CraftDef, circuit: string): PartDef[] {
  const out: PartDef[] = [];
  for (const p of def.parts) {
    if (p.shape.type !== 'box' || p.id.startsWith('light.auto.') || !p.modules?.some((m) => m.type === 'aero')) continue;
    const [sx, sy, sz] = p.shape.size;
    if (sx < 1 || sz < 0.2) continue;
    const r = p.rotationDeg ?? [0, 0, 0];
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180, 'XYZ'));
    const local = new THREE.Vector3(0, 0, -sz / 2 + Math.min(0.04, sz * 0.1)).applyQuaternion(q);
    out.push({
      id: `light.auto.${p.id}`, kind: 'accent light', mass: 0.01,
      position: [p.position[0] + local.x, p.position[1] + local.y, p.position[2] + local.z],
      ...(p.rotationDeg ? { rotationDeg: p.rotationDeg } : {}),
      shape: { type: 'box', size: [sx * 0.92, Math.min(0.05, sy * 0.9), Math.min(0.06, sz * 0.15)] },
      collider: false, color: circuit,
    });
  }
  return out;
}

/** Restyle a craft into the 1982 palette (a new definition; the input is not modified). */
export function style1982(def: CraftDef): CraftDef {
  if (def.parts.filter(lightCandidate).length < 2 && !def.parts.some((p) => p.id.startsWith('light.auto.'))) {
    const lights = leadingEdgeLights(def, circuitOf(def));
    if (lights.length) def = { ...def, parts: [...def.parts, ...lights] };
  }
  const circuit = circuitOf(def);
  // Red-team craft (a warm circuit, or mostly warm parts) get warm dark bodies.
  const warmArea = def.parts.reduce((s, p) => s + (warm(p.color) ? area(p) : 0), 0);
  const total = def.parts.reduce((s, p) => s + area(p), 0) || 1;
  const warmBody = (circuit === LIGHTS[2] || circuit === LIGHTS[3]) && warmArea / total > 0.3
    || def.parts.every((p) => isPalette(p.color, BODY_WARM) || isPalette(p.color, LIGHTS) || !hsl(p.color) || warm(p.color));
  // Pick the lit parts, smallest first, within the light budget.
  const lit = new Set<string>();
  let litArea = 0;
  for (const p of [...def.parts].filter(lightCandidate).sort((a, b) => area(a) - area(b))) {
    if (litArea + area(p) > LIGHT_SHARE * total && lit.size > 0) continue;
    lit.add(p.id);
    litArea += area(p);
  }
  // Still no light at all (a drone): its powered parts (motors, engines) carry it, smallest first.
  if (lit.size === 0) {
    for (const p of [...def.parts].filter((q) => q.modules?.some((m) => m.type === 'rotor' || m.type === 'engine' || m.type === 'motor')).sort((a, b) => area(a) - area(b))) {
      if (litArea + area(p) > LIGHT_SHARE * total) break;
      lit.add(p.id);
      litArea += area(p);
    }
  }
  const parts = def.parts.map((p) => {
    let color: string;
    if (lit.has(p.id)) {
      // Accents follow the circuit, unless the designer chose a distinct second light (amber,
      // red, white) on purpose.
      const own = snapLight(p.color);
      color = isPalette(p.color, LIGHTS) || own !== LIGHTS[5] ? own : circuit;
    } else color = isPalette(p.color, warmBody ? BODY_WARM : BODY_COOL) ? p.color.toLowerCase() : snapBody(p.color, warmBody);
    const modules = p.modules?.map((m) => (m.type === 'trail' ? { ...m, color: circuit } : m));
    return { ...p, color, ...(modules ? { modules } : {}) };
  });
  return { ...def, parts };
}

/**
 * The same craft in a side's livery: every light in `light` (a 1982 light colour), every body
 * surface the same step of the warm or the cool body set, the trail in `light`. Idempotent, and
 * still a 1982 craft (the light budget is the one style1982 already kept).
 */
export function livery(def: CraftDef, light: string, warmBody: boolean): CraftDef {
  const styled = style1982(def);
  const to = warmBody ? BODY_WARM : BODY_COOL, from = warmBody ? BODY_COOL : BODY_WARM;
  const parts = styled.parts.map((p) => {
    const c = p.color.toLowerCase();
    const i = (from as readonly string[]).indexOf(c);
    const color = isPalette(c, LIGHTS) ? light : i >= 0 ? to[i] : isPalette(c, to) ? c : snapBody(c, warmBody);
    const modules = p.modules?.map((m) => (m.type === 'trail' ? { ...m, color: light } : m));
    return { ...p, color, ...(modules ? { modules } : {}) };
  });
  return style1982({ ...styled, parts });
}

/** The same craft in red-team colours: red light, warm near-black bodies. */
export function redTeam(def: CraftDef): CraftDef {
  return livery(def, LIGHTS[2], true);
}

/** Is this colour a dark body surface (dim structural edges) rather than light? */
export function isBodyColor(color: string): boolean {
  if (isPalette(color, BODY_COOL) || isPalette(color, BODY_WARM)) return true;
  const c = hsl(color);
  return !!c && c[2] < 0.45 && !isPalette(color, LIGHTS);
}
