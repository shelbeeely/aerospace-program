import { Builder } from '../grammar.ts';
import { shellWalls } from '../InteriorGenerator.ts';
import { lerp, Rng } from '../rng.ts';
import type { GenRequest, InteriorConfig } from '../types.ts';
import { pickHeight, regionAccent, topOf, type FamilyGenerator, type GenOutput } from './common.ts';

/**
 * C. Industrial megastructures (The Art of TRON, pp. 35–38, 53).
 *
 * Engineered infrastructure at a scale far beyond a single program: enormous enclosed halls
 * whose walls are deep recesses between oversized pylons, broad geometric portals at the ends,
 * skylight-gridded roofs over a pale fluted interior (the solar-sailer hangar, p. 53); the
 * carrier: a long pale hull with red edge lines held in a dock of pylons (pp. 35–37); open
 * gantries of repeating portal frames carrying suspended masses; and stepped processing
 * facilities with recessed bands and energy stacks. Seams are lit, most surfaces are not.
 */
export const IndustrialMegastructureGenerator: FamilyGenerator = {
  id: 'industrial',
  label: 'Industrial megastructure',
  reference: 'The Art of TRON pp. 35–38, 53',
  description: 'Enormous enclosed halls of repeating bays and oversized pylons, carriers in docks, open gantries, stepped facilities.',
  functions: ['transport-terminal', 'carrier-dock', 'processing-facility', 'assembly-hall', 'power-plant'],
  variants: ['hall', 'carrier', 'gantry', 'stepped'],
  variantFor: { 'transport-terminal': 'hall', 'carrier-dock': 'carrier', 'processing-facility': 'stepped', 'assembly-hall': 'gantry', 'power-plant': 'stepped' },
  params: [
    { key: 'length', label: 'Length (of lot)', min: 0.7, max: 0.96, step: 0.01, def: 0.9 },
    { key: 'width', label: 'Width (of lot)', min: 0.45, max: 0.85, step: 0.01, def: 0.7 },
    { key: 'height', label: 'Height (0–1)', min: 0.2, max: 0.8, step: 0.01, def: 0.45 },
    { key: 'bay', label: 'Bay pitch (m)', min: 12, max: 32, step: 1, def: 20 },
    { key: 'pylonDepth', label: 'Pylon / recess depth (m)', min: 2, max: 9, step: 0.5, def: 5 },
    { key: 'portal', label: 'Portal width (of end)', min: 0.25, max: 0.6, step: 0.01, def: 0.42 },
  ],
  lot: { min: 1, max: 4, elongation: 2.2 },
  elongated: true,
  build(req: GenRequest, rng: Rng, p: Record<string, number>, func: string, variant: string): GenOutput {
    const { accent: a0, secondary } = regionAccent(req.region, rng);
    // Pale or muted-cyan hulls with warm edge lines (the carrier's red on blue), or dark navy.
    const pale = rng.chance(variant === 'carrier' ? 0.85 : 0.55);
    const accent = pale ? (rng.chance(0.6) ? 'warning' : 'process') : a0;
    const b = new Builder(rng, pale ? (rng.chance(0.5) ? 'pale' : 'panel') : 'hull', accent);
    const L = req.w * p.length, Wd = req.d * p.width;
    const H = pickHeight(req, rng, p.height);
    const required: Record<string, number> = {};
    let interior: InteriorConfig | null = null;
    let roof: GenOutput['roof'];

    if (variant === 'hall') {
      const pd = p.pylonDepth;
      const Hh = Math.max(18, H);
      interior = {
        accessible: true, x0: -L / 2 + pd, x1: L / 2 - pd, z0: -Wd / 2 + pd, z1: Wd / 2 - pd, y0: 0, y1: Hh, wall: 2,
        entrances: [0, 2].map((side) => ({ side, offset: 0, width: Math.min((Wd - 2 * pd) * p.portal, 60), height: Math.min(Hh * 0.62, 30) })),
        program: 'hall',
      };
      shellWalls(b, interior, { surface: b.primary, pattern: 'flutes', mass: 0, edges: 'none', roofPattern: 'skylight', roofSurface: 'hullDark', light: accent });
      // Oversized pylons along both long walls: the recesses between them are the walls.
      const n = Math.max(3, Math.round((L - 2 * pd) / p.bay));
      for (let i = 0; i <= n; i++) {
        const x = -L / 2 + pd + (i * (L - 2 * pd)) / n;
        for (const s of [-1, 1]) {
          b.box(2, 'pylon', x, 0, s * (Wd / 2 - pd / 2), Math.max(2.5, p.bay * 0.18), Hh + 4, pd, { surface: 'hullDark', edges: 'top', light: accent, glow: 0.8 });
        }
        if (i < n) {
          const xm = x + (L - 2 * pd) / n / 2;
          for (const s of [-1, 1]) b.box(3, 'seam', xm, Hh * 0.66, s * (Wd / 2 - pd - 1.2), ((L - 2 * pd) / n) * 0.82, 0.6, 0.5, { surface: 'glow', light: accent, glow: 0.7, solid: false });
        }
      }
      // Portal frames: thick jambs and a lit lintel at both ends.
      for (const s of [-1, 1]) {
        const pw = interior.entrances[0].width, ph = interior.entrances[0].height;
        const x = s * (L / 2 - pd + 1.2);
        for (const t of [-1, 1]) b.box(2, 'portal', x, 0, t * (pw / 2 + 2), 3, ph + 4, 4, { surface: 'hullDark', edges: 'silhouette', light: 'entrance', glow: 0.9 });
        b.box(2, 'portal', x, ph + 2, 0, 3, 3, pw + 8, { surface: 'hullDark', edges: 'all', light: 'entrance', glow: 1 });
        b.connect(s * L / 2, 0, 0, s > 0 ? 0 : 2, 'transport');
      }
      // A stepped control annex against one long side.
      const aw = Math.min(L * 0.3, 90), ad = Math.max(10, (req.d - Wd) / 2 - 2);
      if (ad > 8) {
        b.box(1, 'annex', -L * 0.2, 0, Wd / 2 + ad / 2, aw, Hh * 0.75, ad, { surface: 'hullDark', edges: 'top', light: secondary, glow: 0.8, mass: 1 });
        b.box(1, 'annex', -L * 0.2, Hh * 0.75, Wd / 2 + ad * 0.4, aw * 0.6, Hh * 0.3, ad * 0.8, { edges: 'top', light: secondary, glow: 0.8, mass: 2 });
        roof = { x: -L * 0.2, y: Hh * 1.05, z: Wd / 2 + ad * 0.4, r: Math.min(aw * 0.3, ad * 0.4) };
      } else {
        // No room for an annex: a raised clerestory lantern along the roof's spine instead.
        b.box(1, 'lantern', 0, Hh + 2, 0, (L - 2 * pd) * 0.6, Math.max(5, Hh * 0.18), (Wd - 2 * pd) * 0.3, { surface: 'hullDark', pattern: 'skylight', edges: 'top', light: accent, glow: 0.8, mass: 1 });
      }
      // An energy beam slanting in through the skylights (the hangar's light, p. 53).
      if (rng.chance(0.5)) b.prism(2, 'beam', L * 0.1, Hh * 0.2, 0, 8, 1.2, 1.2, Hh * 2.5, { surface: 'translucent', light: 'energy', glow: 1.1, rz: 0.55, solid: false });
      required.pylon = 4;
      required.portal = 1;
    } else if (variant === 'carrier') {
      // Dock platform, pylons, and the long hull swept from an angular section, tapered at bow
      // and stern; a stepped bridge pod on top; vertical rib rings around the bow.
      const dockH = Math.max(3, H * 0.05);
      b.box(1, 'dock', 0, 0, 0, L, dockH, Wd, { surface: 'circuit', pattern: 'circuit', edges: 'top', light: 'data', glow: 0.5, mass: 0 });
      const hw = Wd * 0.32, hh = Math.max(12, H * 0.35);
      const ye = dockH + Math.max(10, H * 0.35);
      const sec: Array<[number, number]> = [[-1, -0.35], [-0.6, -1], [0.6, -1], [1, -0.35], [1, 0.45], [0.72, 1], [-0.72, 1], [-1, 0.45]].map(([x, y]) => [x * hw, (y * hh) / 2] as [number, number]);
      const hl = L * 0.92;
      b.sweep(1, 'hull', sec, [[-hl / 2, ye, 0, 0.35], [-hl / 2 + hl * 0.16, ye, 0, 1], [hl / 2 - hl * 0.22, ye, 0, 1], [hl / 2, ye + hh * 0.08, 0, 0.55]], { surface: b.primary, pattern: 'panels', edges: 'all', light: accent, glow: 0.9, mass: 1 });
      const np = Math.max(2, Math.round(hl / 70));
      for (let i = 0; i < np; i++) {
        const x = -hl / 2 + hl * 0.2 + (i * hl * 0.6) / Math.max(1, np - 1);
        for (const s of [-1, 1]) b.box(2, 'pylon', x, dockH, s * hw * 0.6, Math.max(3, hw * 0.25), ye - hh / 2 - dockH, Math.max(3, hw * 0.25), { surface: 'hullDark', taper: 0.75, edges: 'none' });
      }
      const podY = ye + hh / 2;
      b.box(1, 'pod', hl * 0.12, podY, 0, hl * 0.22, hh * 0.45, hw * 1.2, { surface: b.primary, edges: 'silhouette', light: accent, glow: 0.9, mass: 2 });
      b.box(1, 'pod', hl * 0.14, podY + hh * 0.45, 0, hl * 0.12, hh * 0.3, hw * 0.8, { surface: 'hullDark', edges: 'top', light: accent, glow: 0.9, mass: 3 });
      for (let k = 0; k < 3; k++) {
        b.ring(2, 'rib', -hl / 2 + hl * (0.08 + k * 0.06), ye - hh * 0.9, 0, hh * 0.9, hh * 1.0, 1.2, 32, { surface: 'glow', light: accent, glow: 1.1, rz: Math.PI / 2, solid: false, arc: Math.PI, arcStart: 0 });
      }
      b.channel(-L / 2, 0, L / 2, 0, dockH, 2, 'data', 1);
      b.connect(-L / 2, 0, 0, 2, 'transport');
      b.connect(L / 2, 0, 0, 0, 'transport');
      roof = { x: hl * 0.14, y: podY + hh * 0.75, z: 0, r: Math.min(hl * 0.06, hw * 0.4) };
      required.hull = 1;
      required.pylon = 2;
    } else if (variant === 'gantry') {
      // Open frames: negative space with structure drawn by repeating portals.
      const Hg = Math.max(20, H * 0.9);
      const n = Math.max(3, Math.round(L / (p.bay * 1.6)));
      const cs = Math.max(2, Wd * 0.04);
      for (let i = 0; i <= n; i++) {
        const x = -L / 2 + (i * L) / n;
        for (const s of [-1, 1]) b.box(2, 'frame', x, 0, s * (Wd / 2 - cs / 2), cs, Hg, cs, { surface: 'hullDark', edges: 'none' });
        b.box(2, 'frame', x, Hg - cs * 1.5, 0, cs, cs * 1.5, Wd, { surface: 'hullDark', edges: 'base', light: accent, glow: 0.6 });
      }
      for (const s of [-1, 1]) b.box(1, 'beam', 0, Hg - cs * 3, s * Wd * 0.22, L, cs * 1.5, cs * 2, { surface: b.primary, edges: 'base', light: 'structure', glow: 0.5, mass: 0 });
      const ms = rng.int(2, 3);
      for (let k = 0; k < ms; k++) {
        const x = -L * 0.3 + (k * L * 0.6) / Math.max(1, ms - 1);
        const mh = Hg * lerp(0.25, 0.45, rng.next());
        b.box(1, 'suspended', x, Hg - cs * 3 - mh, 0, Math.min(L / (ms + 1), Wd * 0.7), mh, Wd * 0.5, { surface: b.primary, pattern: 'panels', edges: 'silhouette', glow: 0.7, mass: 1 + k });
        for (const s2 of [-1, 1]) b.box(3, 'underlight', x, Hg - cs * 3 - mh - 0.2, s2 * Wd * 0.2, Math.min(L / (ms + 1), Wd * 0.7) * 0.8, 0.2, 0.6, { surface: 'glow', light: 'process', glow: 0.8, solid: false });
      }
      for (const s of [-1, 1]) b.channel(-L / 2, s * Wd * 0.22, L / 2, s * Wd * 0.22, 0.05, 1.2, 'data', 1);
      b.connect(-L / 2, 0, 0, 2, 'transport');
      b.connect(L / 2, 0, 0, 0, 'transport');
      required.frame = 3;
    } else {
      // stepped facility: tiers with recessed bands and protruding frames, energy stacks.
      const tiers = rng.int(2, 3);
      let w = L, d = Wd, y = 0;
      for (let i = 0; i < tiers; i++) {
        const h = (H * (i === 0 ? 0.5 : 0.5 / (tiers - 1)));
        b.box(1, 'tier', 0, y, 0, w * 0.94, h, d * 0.94, { pattern: 'panels', edges: 'top', glow: 0.8, mass: i });
        const nf = Math.max(2, Math.round(w / p.bay));
        for (let k = 0; k <= nf; k++) {
          const x = -w / 2 + (k * w) / nf;
          for (const s of [-1, 1]) b.box(2, 'pylon', x, y, s * d / 2, Math.max(2, p.bay * 0.15), h, Math.max(2, d * 0.03), { surface: 'hullDark', edges: i === tiers - 1 ? 'top' : 'none', light: accent, glow: 0.6 });
        }
        b.box(3, 'seam', 0, y + h * 0.5, d * 0.47 + 0.2, w * 0.9, 0.6, 0.4, { surface: 'glow', light: accent, glow: 0.6, solid: false });
        b.box(3, 'seam', 0, y + h * 0.5, -d * 0.47 - 0.2, w * 0.9, 0.6, 0.4, { surface: 'glow', light: accent, glow: 0.6, solid: false });
        y += h;
        w *= lerp(0.55, 0.75, rng.next());
        d *= lerp(0.6, 0.85, rng.next());
      }
      const stacks = func === 'power-plant' ? rng.int(3, 5) : rng.int(1, 3);
      for (let k = 0; k < stacks; k++) {
        const x = -w / 2 + ((k + 0.5) * w) / stacks;
        const r = Math.min(w / stacks, d) * 0.3;
        const sh = H * lerp(0.25, 0.5, rng.next());
        b.prism(2, 'stack', x, y, 0, 16, r, r * 0.8, sh, { surface: 'metal', pattern: 'flutes', edges: 'none' });
        b.torus(3, 'stackring', x, y + sh - 2, 0, r * 0.85, 0.5, { surface: 'glow', light: func === 'power-plant' ? 'energy' : 'process', glow: 1.3 });
      }
      b.box(3, 'portal', L * 0.47 + 0.3, 0, 0, 0.6, Math.min(16, H * 0.3), Math.min(Wd * 0.3, 40), { surface: 'glow', light: 'entrance', glow: 0.9, solid: false });
      b.connect(L / 2, 0, 0, 0, 'transport');
      b.connect(-L / 2, 0, 0, 2, 'energy');
      required.tier = 2;
    }
    return { b, height: topOf(b), interior, roof, required, primary: b.primary, secondary: 'hullDark', accent, secondaryLight: secondary, pulse: 0.3 + rng.next() * 0.4 };
  },
};
