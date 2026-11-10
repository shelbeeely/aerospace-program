import { Builder } from '../grammar.ts';
import type { Surface } from '../palette.ts';
import { lerp, Rng } from '../rng.ts';
import type { GenRequest } from '../types.ts';
import { pickHeight, regionAccent, topOf, type FamilyGenerator, type GenOutput } from './common.ts';

/**
 * D. Electronic caverns and dense machine cities (The Art of TRON, p. 39: Harrison Ellenshaw's
 * electronic cave interior).
 *
 * Not city blocks: interlocking rectangular volumes stacked around an enormous negative space.
 * Stacks rise from the lot's perimeter cells and cantilever into a central shaft; bridges span
 * the void at several elevations; platforms project into it; an overhead slab may close part of
 * the sky; light falls down the shaft. Boundaries are drawn by narrow lit lines only.
 */
export const ElectronicCavernGenerator: FamilyGenerator = {
  id: 'cavern',
  label: 'Electronic cavern / machine city',
  reference: 'The Art of TRON p. 39 (electronic cave)',
  description: 'Interlocking stacked volumes around deep shafts and voids; cantilevers, bridges at many elevations, narrow lit boundaries.',
  functions: ['machine-city-block', 'data-warehouse', 'io-buffer', 'cache-stack', 'interconnect'],
  variants: ['shaft', 'terrace', 'lattice'],
  variantFor: { 'machine-city-block': 'shaft', 'data-warehouse': 'lattice', 'io-buffer': 'shaft', 'cache-stack': 'terrace', interconnect: 'lattice' },
  params: [
    { key: 'cells', label: 'Grid cells', min: 3, max: 5, step: 1, def: 4 },
    { key: 'height', label: 'Height (0–1)', min: 0.35, max: 1, step: 0.01, def: 0.7 },
    { key: 'levels', label: 'Stack levels', min: 2, max: 6, step: 1, def: 4 },
    { key: 'overhang', label: 'Cantilever (of cell)', min: 0, max: 0.4, step: 0.01, def: 0.2 },
    { key: 'bridges', label: 'Bridges', min: 0, max: 6, step: 1, def: 3 },
    { key: 'canopy', label: 'Overhead slab (0/1)', min: 0, max: 1, step: 1, def: 1 },
  ],
  lot: { min: 1, max: 3, elongation: 1.3 },
  elongated: false,
  build(req: GenRequest, rng: Rng, p: Record<string, number>, func: string, variant: string): GenOutput {
    const { accent, secondary } = regionAccent(req.region, rng);
    const b = new Builder(rng, 'hull', accent);
    const W = req.w * 0.94, D = req.d * 0.94;
    const H = pickHeight(req, rng, p.height);
    const surf = (): Surface => rng.weighted([['hull', 3], ['hullDark', 3], ['panel', 1.2], ['metal', 0.8]] as const);
    const required: Record<string, number> = { stack: 3 };
    let massId = 0;
    const stacks: Array<{ x: number; z: number; top: number; w: number; d: number; i: number; j: number }> = [];

    /** One stack of volumes; offsets drift toward (vx, vz) (the void) to cantilever. */
    const stack = (x: number, z: number, w: number, d: number, vx: number, vz: number, targetH: number, primary: boolean, i: number, j: number) => {
      let y = 0, cx = x, cz = z, cw = w, cd = d;
      const myMass = primary ? massId++ : 99;
      const n = rng.int(2, p.levels);
      for (let k = 0; k < n && y < targetH - 2; k++) {
        const h = k === n - 1 ? targetH - y : (targetH / n) * lerp(0.6, 1.4, rng.next());
        const hh = Math.max(4, Math.min(h, targetH - y));
        // The tallest stacks are the primary masses: every volume of one shares its mass id.
        const isPrimary = primary && myMass < 4;
        b.box(isPrimary ? 1 : 2, 'stack', cx, y, cz, cw, hh, cd, {
          surface: surf(), pattern: 'panels', edges: rng.chance(0.55) ? 'top' : 'none', light: rng.chance(0.8) ? accent : secondary, glow: 0.55, mass: isPrimary ? myMass : undefined,
        });
        // Narrow lit vertical lines on the face toward the void.
        if (rng.chance(0.35)) {
          const fx = cx + Math.sign(vx - cx) * (cw / 2 + 0.2), fz = cz + Math.sign(vz - cz) * (cd / 2 + 0.2);
          const alongX = Math.abs(vx - cx) < Math.abs(vz - cz);
          b.box(3, 'dataline', alongX ? cx : fx, y + hh * 0.1, alongX ? fz : cz, alongX ? 0.4 : 0.3, hh * 0.8, alongX ? 0.3 : 0.4, { surface: 'glow', light: 'data', glow: 0.7, solid: false });
        }
        y += hh;
        // Next volume: resized and pushed toward the void (cantilever), never off its support.
        const s = lerp(0.72, 1.12, rng.next());
        const nw = cw * s, nd = cd * lerp(0.72, 1.12, rng.next());
        const push = p.overhang * Math.min(w, d);
        const dx = Math.sign(vx - cx) * push * rng.next(), dz = Math.sign(vz - cz) * push * rng.next();
        cx += Math.max(-cw / 2 + 2, Math.min(cw / 2 - 2, dx));
        cz += Math.max(-cd / 2 + 2, Math.min(cd / 2 - 2, dz));
        cw = nw; cd = nd;
      }
      stacks.push({ x, z, top: y, w, d, i, j });
    };

    if (variant === 'shaft' || variant === 'lattice') {
      const k = Math.round(p.cells);
      const gx = W / k, gz = D / k;
      const gap = Math.max(2, Math.min(gx, gz) * 0.08);
      // The void: central cells (lattice: scattered voids instead).
      const voids = new Set<number>();
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
        const v = variant === 'shaft' ? i > 0 && j > 0 && i < k - 1 && j < k - 1 : (i + j) % 2 === 1 && rng.chance(0.55);
        if (v) voids.add(i * k + j);
      }
      const entrance = rng.int(1, k - 2); // a ground-level passage into the void on the -z side
      if (variant === 'shaft') voids.add(entrance * k);
      const order: Array<[number, number]> = [];
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) order.push([i, j]);
      const heights = order.map(() => H * lerp(0.45, 1, rng.next()));
      const tallest = [...heights.keys()].filter((n) => !voids.has(order[n][0] * k + order[n][1])).sort((a, c) => heights[c] - heights[a]).slice(0, 3);
      order.forEach(([i, j], n) => {
        if (voids.has(i * k + j)) return;
        const x = -W / 2 + (i + 0.5) * gx, z = -D / 2 + (j + 0.5) * gz;
        stack(x, z, gx - gap, gz - gap, 0, 0, heights[n], tallest.includes(n), i, j);
      });
      // Light falling down the shaft and a lit rim around its floor.
      if (variant === 'shaft') {
        const vw = (k - 2) * gx, vd = (k - 2) * gz;
        b.box(2, 'lightshaft', 0, 0.2, 0, vw * 0.5, H * 1.05, vd * 0.5, { surface: 'translucent', light: 'data', glow: 0.35, solid: false });
        b.channel(-vw / 2, -vd / 2, vw / 2, -vd / 2, 0.05, 0.8, 'data', 1);
        b.channel(-vw / 2, vd / 2, vw / 2, vd / 2, 0.05, 0.8, 'data', 1);
        b.channel(-vw / 2, -vd / 2, -vw / 2, vd / 2, 0.05, 0.8, 'data', 1);
        b.channel(vw / 2, -vd / 2, vw / 2, vd / 2, 0.05, 0.8, 'data', 1);
        b.connect(-W / 2 + (entrance + 0.5) * gx, 0, -D / 2, 3, 'transport');
        required.void = 1;
        b.box(3, 'void', 0, 0, 0, 0.1, 0.1, 0.1, { surface: 'void', solid: false });
      }
      // Bridges across voids between stacks in the same row or column, at shared elevations.
      for (let n = 0; n < p.bridges; n++) {
        const a = stacks[rng.int(0, stacks.length - 1)], c = stacks[rng.int(0, stacks.length - 1)];
        if (!a || !c || a === c || (a.i !== c.i && a.j !== c.j)) continue;
        const top = Math.min(a.top, c.top) - 4;
        if (top < 10) continue;
        const y = top * lerp(0.35, 0.9, rng.next());
        const alongX = a.j === c.j;
        const x0 = Math.min(a.x, c.x), x1 = Math.max(a.x, c.x), z0 = Math.min(a.z, c.z), z1 = Math.max(a.z, c.z);
        const len = alongX ? x1 - x0 : z1 - z0;
        b.box(2, 'bridge', (x0 + x1) / 2, y, (z0 + z1) / 2, alongX ? len : 5, 2.5, alongX ? 5 : len, { surface: 'hullDark', edges: 'base', light: 'data', glow: 0.8 });
      }
      // Overhead slab across part of the sky, carried by the two tallest stacks.
      if (p.canopy >= 1 && stacks.length > 2) {
        const sorted = [...stacks].sort((s1, s2) => s2.top - s1.top);
        const [a, c] = sorted;
        const y = Math.min(a.top, c.top);
        const x0 = Math.min(a.x - a.w / 2, c.x - c.w / 2), x1 = Math.max(a.x + a.w / 2, c.x + c.w / 2);
        const z0 = Math.min(a.z - a.d / 2, c.z - c.d / 2), z1 = Math.max(a.z + a.d / 2, c.z + c.d / 2);
        if ((x1 - x0) * (z1 - z0) < W * D * 0.7) b.box(2, 'canopy', (x0 + x1) / 2, y, (z0 + z1) / 2, x1 - x0, Math.max(4, H * 0.05), z1 - z0, { surface: 'hullDark', edges: 'base', light: accent, glow: 0.6 });
      }
    } else {
      // terrace: cascading volumes stepping up along x, each cantilevered past the last,
      // with a void on the low side and service cores behind.
      const n = rng.int(4, 6);
      const step = W / (n + 1);
      let y = 0;
      for (let i = 0; i < n; i++) {
        const x = -W / 2 + step * (i + 0.8);
        const h = (H / n) * lerp(0.8, 1.2, rng.next());
        const d = D * lerp(0.5, 0.85, rng.next());
        const z = (D - d) / 2 * (rng.next() * 2 - 1) * 0.5;
        b.box(i < 3 ? 1 : 2, 'stack', x, y, z, step * (1 + p.overhang * 1.5), h, d, { surface: surf(), pattern: 'panels', edges: 'top', light: accent, glow: 0.6, mass: i < 3 ? i : undefined });
        if (y > 0) b.box(2, 'core', x + step * 0.3, 0, z, step * 0.35, y, d * 0.4, { surface: 'hullDark', edges: 'none' });
        stacks.push({ x, z, top: y + h, w: step, d, i, j: 0 });
        b.box(3, 'dataline', x - step * 0.5 * (1 + p.overhang * 1.5) - 0.2, y + h * 0.15, z, 0.3, h * 0.7, d * 0.08, { surface: 'glow', light: 'data', glow: 0.7, solid: false });
        y += h * lerp(0.55, 0.85, rng.next());
      }
      b.channel(-W / 2, 0, W / 2, 0, 0.05, 1, 'data', 0.9);
      b.connect(-W / 2, 0, 0, 2, 'transport');
    }
    b.connect(W / 2, 0, 0, 0, 'data');
    b.connect(0, 0, D / 2, 1, 'data');
    void func;
    return { b, height: topOf(b), interior: null, required, primary: 'hull', secondary: 'hullDark', accent, secondaryLight: secondary, pulse: 0.5 + rng.next() * 0.8 };
  },
};
