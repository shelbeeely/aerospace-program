import { Builder } from '../grammar.ts';
import { lerp, Rng } from '../rng.ts';
import type { GenRequest } from '../types.ts';
import { pickHeight, regionAccent, TAU, topOf, type FamilyGenerator, type GenOutput } from './common.ts';

const SIDES = [6, 8, 12, 32] as const;

/**
 * B. Monumental processing towers (The Art of TRON, pp. 13–16, 40, 60–62).
 *
 * Strong vertical, symmetrical silhouettes on wide foundations: concave trumpet flares wrapped
 * in survey lines with a glowing waist ring (p. 13); pyramidal bases carrying needle spires
 * under floating red halo rings (p. 40); stacked polygonal drums; a square core with corner
 * pylons holding a suspended mass aloft; and the control cylinder: a fluted drum of vertical
 * slats on a pedestal, on a mesa ringed with sawtooth teeth and radial lines, sending a beam
 * into the sky (pp. 60–62). Illumination is limited and deliberate: rims, rings, a tip.
 */
export const ProcessingTowerGenerator: FamilyGenerator = {
  id: 'tower',
  label: 'Monumental processing tower',
  reference: 'The Art of TRON pp. 13–16, 40, 60–62',
  description: 'Cylindrical and polygonal cores on flared trumpet or pyramidal bases; radial platforms, suspended masses, halo rings, beams.',
  functions: ['central-processor', 'control-tower', 'compute-core', 'arithmetic-unit', 'scheduler'],
  variants: ['control', 'trumpet', 'stack', 'pylon', 'spire', 'suspended'],
  variantFor: { 'central-processor': 'control', 'control-tower': 'trumpet', 'compute-core': 'stack', 'arithmetic-unit': 'pylon', scheduler: 'spire' },
  params: [
    { key: 'height', label: 'Height (0–1)', min: 0.45, max: 1, step: 0.01, def: 0.8 },
    { key: 'base', label: 'Base radius (of lot)', min: 0.45, max: 0.98, step: 0.01, def: 0.8 },
    { key: 'flare', label: 'Flare / base share', min: 0.2, max: 0.6, step: 0.01, def: 0.38 },
    { key: 'taper', label: 'Shaft taper (top/base)', min: 0.35, max: 1, step: 0.01, def: 0.7 },
    { key: 'sides', label: 'Core sides (6/8/12/32)', min: 0, max: 3, step: 1, def: 1 },
    { key: 'platforms', label: 'Radial platforms', min: 0, max: 5, step: 1, def: 2 },
    { key: 'halos', label: 'Halo rings', min: 0, max: 3, step: 1, def: 1 },
  ],
  lot: { min: 1, max: 3, elongation: 1 },
  elongated: false,
  landmarkVariants: ['control'],
  build(req: GenRequest, rng: Rng, p: Record<string, number>, func: string, variant: string): GenOutput {
    const { accent, secondary } = regionAccent(req.region, rng);
    const pale = variant === 'spire' || variant === 'trumpet' || rng.chance(0.3);
    const b = new Builder(rng, pale ? (rng.chance(0.5) ? 'pale' : 'panel') : 'hull', accent);
    const half = (Math.min(req.w, req.d) / 2) * 0.94;
    const H = pickHeight(req, rng, p.height);
    const Rb = half * p.base;
    const sides = SIDES[Math.round(p.sides)];
    const ringLight = rng.chance(0.65) ? 'warning' : 'entrance';
    const required: Record<string, number> = { core: 1 };
    const halos = (y0: number, r: number) => {
      for (let i = 0; i < p.halos; i++) {
        const y = y0 + i * Math.max(8, r * 0.35);
        b.torus(2, 'halo', 0, y, 0, r * (1 + i * 0.25), Math.max(0.45, r * 0.012), { surface: 'glow', light: ringLight, glow: 1.6 });
      }
    };
    const baseLinks = () => {
      for (let k = 0; k < 4; k++) {
        const [cx, cz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][k];
        b.connect(cx * Rb, 0, cz * Rb, k, k % 2 ? 'energy' : 'data');
      }
    };

    if (variant === 'control') {
      // The mesa: a broad low plateau ringed with sawtooth teeth, radial light lines to the core.
      const mR = half * 0.98, mh = Math.max(6, H * 0.06);
      b.prism(1, 'mesa', 0, 0, 0, 24, mR, mR * 0.97, mh, { surface: 'hullDark', pattern: 'panels', edges: 'top', light: accent, glow: 0.7, mass: 0 });
      const teeth = 28;
      for (let k = 0; k < teeth; k++) {
        const a = (k / teeth) * TAU;
        b.prism(3, 'tooth', Math.cos(a) * mR * 0.93, mh, Math.sin(a) * mR * 0.93, 4, mR * 0.045, 0, mR * 0.09, { surface: 'metal', edges: 'all', light: 'warning', glow: 0.6, solid: false, phase: a });
      }
      const spokes = 16;
      for (let k = 0; k < spokes; k++) {
        const a = (k / spokes) * TAU;
        const r0 = mR * 0.22, r1 = mR * 0.88;
        b.box(3, 'spoke', Math.cos(a) * (r0 + r1) / 2, mh, Math.sin(a) * (r0 + r1) / 2, r1 - r0, 0.12, 0.9, { surface: 'glow', light: k % 4 === 0 ? 'warning' : 'structure', glow: 0.8, ry: -a, solid: false });
      }
      // Pedestal and the fluted drum of vertical slats.
      const cR = Math.max(10, mR * lerp(0.2, 0.3, p.base));
      const pedH = H * 0.12;
      b.prism(2, 'pedestal', 0, mh, 0, 16, cR * 0.55, cR * 0.45, pedH, { surface: 'hullDark', edges: 'top' });
      const drumY = mh + pedH, drumH = H * 0.5;
      b.prism(1, 'core', 0, drumY, 0, 32, cR, cR, drumH, { surface: b.primary, pattern: 'flutes', edges: 'rims', mass: 1 });
      const slats = 24;
      for (let k = 0; k < slats; k++) {
        const a = (k / slats) * TAU;
        b.box(2, 'slat', Math.cos(a) * cR * 1.04, drumY + drumH * 0.06, Math.sin(a) * cR * 1.04, cR * 0.12, drumH * 0.88, cR * 0.16, { surface: 'metal', edges: k % 3 === 0 ? 'silhouette' : 'none', light: 'structure', glow: 0.6, ry: -a, solid: false });
      }
      b.ring(2, 'collar', 0, drumY + drumH, 0, cR * 0.7, cR * 1.12, 2, 32, { surface: 'hullDark', edges: 'top', light: 'structure' });
      // The beam to the sky (energy): translucent, drawn far beyond the tower's own height.
      b.prism(2, 'beam', 0, drumY + drumH, 0, 12, cR * 0.22, cR * 0.22, Math.max(H * 1.6, 400), { surface: 'translucent', light: 'energy', glow: 1.6, solid: false });
      // The red line on the floor leading to it (p. 60).
      b.channel(0, -mR, 0, -cR * 0.5, mh, 1.6, 'warning', 1.3);
      b.connect(0, 0, -mR, 3, 'transport');
      baseLinks();
      required.slat = 12;
    } else if (variant === 'trumpet') {
      const Hf = H * p.flare;
      const Rc = Math.max(4, Rb * lerp(0.12, 0.22, rng.next()));
      const prof: Array<[number, number]> = [[Rb, 0], [Rb, 1.5]];
      for (let i = 1; i <= 9; i++) {
        const t = i / 9;
        prof.push([Rc + (Rb - Rc) * Math.pow(1 - t, 2.6), 1.5 + (Hf - 1.5) * t]);
      }
      b.lathe(1, 'flare', 0, 0, 0, prof, 32, { surface: b.primary, pattern: 'grid', edges: 'base', light: accent, glow: 0.6, mass: 0 });
      b.torus(2, 'waist', 0, Hf - 2, 0, Rc * 1.18, Math.max(0.6, Rc * 0.05), { surface: 'glow', light: ringLight, glow: 1.8 });
      const Hs = Hf + (H - Hf) * 0.72;
      const r0 = Rc * 0.92, r1 = r0 * p.taper;
      b.prism(1, 'core', 0, Hf, 0, sides, r0, r1, Hs - Hf, { pattern: sides >= 12 ? 'flutes' : 'panels', edges: sides < 12 ? 'silhouette' : 'none', glow: 0.5, mass: 1 });
      for (let i = 0; i < p.platforms; i++) {
        const t = (i + 1) / (p.platforms + 1);
        const y = Hf + (Hs - Hf) * t;
        const rr = lerp(r0, r1, t);
        b.prism(2, 'platform', 0, y, 0, sides, rr * lerp(1.7, 2.6, rng.next()), rr * 1.5, 1.6, { surface: 'hullDark', edges: 'top', glow: 0.8 });
      }
      // The head: a lens-shaped suspended disc, then the crown needle.
      const Rh = Math.max(r1 * 3, Rb * 0.32), hh = Math.max(6, (H - Hs) * 0.32);
      b.lathe(1, 'head', 0, Hs, 0, [[r1, 0], [Rh, hh * 0.35], [Rh, hh * 0.55], [r1 * 1.2, hh]], sides >= 12 ? 32 : sides, { surface: b.primary, edges: 'horizontal', glow: 0.7, mass: 2 });
      b.prism(1, 'crown', 0, Hs + hh, 0, 8, r1 * 0.7, 0.3, Math.max(4, H - Hs - hh), { surface: 'metal', edges: 'silhouette', glow: 0.5, mass: 3 });
      b.box(3, 'tip', 0, H - 1.5, 0, 1.4, 1.4, 1.4, { surface: 'glow', light: 'warning', glow: 2, solid: false });
      halos(Hs + hh * 1.5, Rh * 1.4);
      baseLinks();
      b.connect(0, H, 0, -1, 'energy');
      required.platform = p.platforms > 0 ? 1 : 0;
    } else if (variant === 'spire') {
      // Pyramidal base (four-sided frustum), a collar, and a needle spire with a lit tip; red
      // halo rings float above (p. 40).
      const Hb = H * lerp(0.28, 0.4, p.flare);
      const s = Rb * 1.6;
      b.box(1, 'base', 0, 0, 0, s, Hb, s, { surface: b.primary, pattern: 'panels', taper: lerp(0.14, 0.3, rng.next()), edges: 'base', light: accent, glow: 0.6, mass: 0 });
      const top = s * 0.2;
      b.box(1, 'collar', 0, Hb, 0, top * 1.1, Math.max(4, H * 0.04), top * 1.1, { surface: 'hullDark', edges: 'rims', glow: 0.8, mass: 1 });
      let y = Hb + Math.max(4, H * 0.04);
      const nr = Math.max(1.6, top * 0.28);
      const segs = rng.int(2, 3);
      for (let i = 0; i < segs; i++) {
        const h = (H - y) * (i === segs - 1 ? 1 : lerp(0.3, 0.45, rng.next()));
        const ra = nr * (1 - i * 0.28), rb = i === segs - 1 ? 0.25 : nr * (1 - (i + 1) * 0.28);
        b.prism(i === 0 ? 1 : 2, i === 0 ? 'core' : 'needle', 0, y, 0, 8, ra, rb, h, { surface: 'metal', edges: 'silhouette', glow: 0.4, mass: i === 0 ? 2 : undefined });
        if (i < segs - 1) b.prism(2, 'node', 0, y + h, 0, 8, ra * 1.6, ra * 1.6, Math.max(1.5, h * 0.06), { surface: 'glow', light: 'energy', glow: 0.9, solid: false });
        y += h;
      }
      b.box(3, 'tip', 0, H - 1, 0, 1.2, 2, 1.2, { surface: 'glow', light: 'energy', glow: 2.4, solid: false });
      halos(lerp(Hb, H, 0.75), Math.max(top * 1.4, H * 0.08));
      baseLinks();
      required.halo = p.halos > 0 ? 1 : 0;
    } else if (variant === 'stack') {
      const n = rng.int(3, 4);
      let y = 0, r = Rb * 0.8;
      for (let i = 0; i < n; i++) {
        const h = (H * (i === n - 1 ? 0.3 : 0.7)) / (i === n - 1 ? 1 : n - 1);
        const rTop = r * lerp(0.9, 1, rng.next());
        b.prism(1, i === 0 ? 'base' : 'core', 0, y, 0, sides, r, rTop, h, { surface: i % 2 ? 'hullDark' : b.primary, pattern: sides >= 12 ? 'flutes' : 'panels', edges: sides < 12 ? 'silhouette' : 'top', glow: 0.5, mass: Math.min(4, i) });
        y += h;
        if (i < n - 1) b.prism(2, 'platform', 0, y, 0, sides, rTop * 1.25, rTop * 1.25, 1.5, { surface: 'hullDark', edges: 'top', light: i === n - 2 ? secondary : accent, glow: 0.9 });
        r = rTop * lerp(0.55, 0.75, rng.next());
      }
      b.prism(2, 'crown', 0, y, 0, sides, r * 0.6, 0.2, Math.max(5, H * 0.08), { surface: 'metal', edges: 'silhouette', glow: 0.5 });
      halos(y * 0.85, r * 2.4);
      baseLinks();
    } else if (variant === 'pylon') {
      // A square core, four corner pylons, and a suspended mass cantilevered over them.
      const fs = Rb * 1.8, fh = Math.max(3, H * 0.03);
      b.box(1, 'foundation', 0, 0, 0, fs, fh, fs, { surface: 'circuit', pattern: 'circuit', edges: 'top', light: 'data', glow: 0.5, mass: 0 });
      const cs = fs * 0.32, coreH = H * 0.7;
      b.box(1, 'core', 0, fh, 0, cs, coreH, cs, { edges: 'none', mass: 1 });
      b.seams(0, 0, cs, cs, fh, fh + coreH, Math.max(14, H / 8), { lit: rng.chance(0.25), light: accent, glow: 0.4 });
      const po = fs * 0.36;
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        b.box(2, 'pylon', sx * po, fh, sz * po, cs * 0.34, coreH, cs * 0.34, { surface: 'hullDark', taper: 0.7, edges: 'none' });
      }
      const ms = fs * 0.92, mh = H * 0.18;
      b.box(1, 'suspended', 0, fh + coreH, 0, ms, mh, ms, { surface: b.primary === 'hull' ? 'panel' : b.primary, pattern: 'panels', edges: 'silhouette', mass: 2 });
      b.box(1, 'cap', 0, fh + coreH + mh, 0, ms * 0.5, H - (fh + coreH + mh), ms * 0.5, { edges: 'top', light: secondary, glow: 0.9, mass: 3 });
      for (const s2 of [-1, 1]) {
        b.box(3, 'underlight', 0, fh + coreH - 0.3, s2 * ms * 0.4, ms * 0.8, 0.3, 0.6, { surface: 'glow', light: accent, glow: 0.6, solid: false });
        b.box(3, 'underlight', s2 * ms * 0.4, fh + coreH - 0.3, 0, 0.6, 0.3, ms * 0.8, { surface: 'glow', light: accent, glow: 0.6, solid: false });
      }
      baseLinks();
      required.pylon = 4;
    } else {
      // suspended: a stepped radial base, slender legs and an inverted frustum held aloft.
      const steps = 3;
      const prof: Array<[number, number]> = [];
      for (let i = 0; i < steps; i++) {
        const r = Rb * (1 - i * 0.2), y = i * Math.max(2.5, H * 0.025);
        prof.push([r, y], [r, y + Math.max(2.5, H * 0.025)]);
      }
      b.lathe(1, 'base', 0, 0, 0, prof, 24, { surface: 'hullDark', edges: 'horizontal', glow: 0.6, mass: 0 });
      const by = prof[prof.length - 1][1];
      const legs = rng.pick([3, 4, 6]);
      const lr = Rb * 0.45;
      const ly = H * 0.62;
      for (let k = 0; k < legs; k++) {
        const a = (k / legs) * TAU + Math.PI / legs;
        b.prism(2, 'leg', Math.cos(a) * lr, by, Math.sin(a) * lr, 6, Math.max(1.2, Rb * 0.05), Math.max(0.8, Rb * 0.035), ly - by, { surface: 'metal', edges: 'none' });
      }
      b.prism(1, 'core', 0, by, 0, sides, Rb * 0.12, Rb * 0.1, H - by, { pattern: 'flutes', edges: 'none', mass: 1 });
      const mh = H * 0.24;
      b.prism(1, 'suspended', 0, ly, 0, sides >= 12 ? 24 : sides, lr * 0.7, Rb * 0.95, mh, { surface: b.primary === 'hull' ? 'panel' : b.primary, edges: 'rims', glow: 0.8, mass: 2 });
      b.prism(2, 'platform', 0, ly + mh, 0, sides >= 12 ? 24 : sides, Rb * 0.95, Rb * 0.9, 1.5, { surface: 'hullDark', edges: 'top', light: secondary, glow: 0.8 });
      halos(ly + mh + 12, Rb * 1.1);
      baseLinks();
      required.leg = 3;
    }
    void func;
    return { b, height: topOf(b), interior: null, required, primary: b.primary, secondary: 'hullDark', accent, secondaryLight: secondary, pulse: 0.25 + rng.next() * 0.5 };
  },
};
