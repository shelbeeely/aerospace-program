import { Builder } from '../grammar.ts';
import { shellWalls } from '../InteriorGenerator.ts';
import { lerp, Rng } from '../rng.ts';
import type { GenRequest, InteriorConfig } from '../types.ts';
import { pickHeight, regionAccent, topOf, type FamilyGenerator, type GenOutput } from './common.ts';

/**
 * A. Circuit-board structures (The Art of TRON, pp. 12–16, 39–40).
 *
 * Rectangular extrusions rising from a large geometric foundation plate, as if the building
 * were a component soldered onto the electronic substrate: layered platforms and stepped
 * elevations, broad uninterrupted surfaces, recessed channels and narrow pathways between the
 * masses, linear lit connections running out to the plate's edge, repeating rectangular
 * subdivisions (chip rows, pin rows).
 */
export const CircuitBlockGenerator: FamilyGenerator = {
  id: 'circuit',
  label: 'Circuit-board structure',
  reference: 'The Art of TRON pp. 12–16, 39–40',
  description: 'Rectangular extrusions on a broad foundation plate; stepped elevations, recessed lit channels, repeating subdivisions.',
  functions: ['memory-storage', 'data-router', 'processing-array', 'system-bus', 'cache-bank'],
  variants: ['memory', 'router', 'array', 'bus', 'stepped'],
  variantFor: { 'memory-storage': 'memory', 'data-router': 'router', 'processing-array': 'array', 'system-bus': 'bus', 'cache-bank': 'stepped' },
  params: [
    { key: 'coverage', label: 'Plate coverage', min: 0.7, max: 0.96, step: 0.01, def: 0.86 },
    { key: 'foundation', label: 'Foundation height (m)', min: 2, max: 9, step: 0.5, def: 4 },
    { key: 'height', label: 'Mass height (0–1)', min: 0.15, max: 1, step: 0.01, def: 0.5 },
    { key: 'subdivisions', label: 'Subdivisions', min: 2, max: 8, step: 1, def: 4 },
    { key: 'steps', label: 'Stepped elevations', min: 1, max: 4, step: 1, def: 2 },
    { key: 'channelGlow', label: 'Channel glow', min: 0.3, max: 1.6, step: 0.05, def: 0.9 },
    { key: 'seamEvery', label: 'Seam spacing (m, 0 none)', min: 0, max: 24, step: 1, def: 12 },
  ],
  lot: { min: 1, max: 3, elongation: 1.6 },
  elongated: true,
  build(req: GenRequest, rng: Rng, p: Record<string, number>, func: string, variant: string): GenOutput {
    const { accent, secondary } = regionAccent(req.region, rng);
    const b = new Builder(rng, rng.chance(0.25) ? 'panel' : 'hull', accent);
    const W = req.w * p.coverage, D = req.d * p.coverage;
    const f = p.foundation;
    const H = pickHeight(req, rng, p.height);
    const glow = p.channelGlow;
    // The foundation plate (primary mass 0): broad, uninterrupted, lit only along its top rim.
    b.box(1, 'foundation', 0, 0, 0, W, f, D, { surface: 'circuit', pattern: 'circuit', edges: 'top', light: 'data', glow: 0.5, mass: 0 });
    // Lit traces from the plate's edge midpoints toward the centre (connections to the network).
    const traces = (inset: number) => {
      b.channel(-W / 2, 0, -inset, 0, f, 1.2, 'data', glow);
      b.channel(inset, 0, W / 2, 0, f, 1.2, 'data', glow);
      b.connect(-W / 2, 0, 0, 2, 'data');
      b.connect(W / 2, 0, 0, 0, 'data');
    };
    let interior: InteriorConfig | null = null;
    let roof: GenOutput['roof'];
    const required: Record<string, number> = {};

    if (variant === 'memory') {
      // A raised bank platform carrying rows of identical chips with recessed channels between.
      const bw = W * 0.82, bd = D * 0.78, bh = Math.max(4, H * 0.18);
      b.box(1, 'bank', -W * 0.06, f, 0, bw, bh, bd, { surface: 'hullDark', edges: 'top', mass: 1 });
      const rows = Math.max(3, p.subdivisions);
      const gap = Math.max(3, bd * 0.08);
      const rowD = (bd - gap * (rows + 1)) / rows;
      const chipH = Math.max(3, H * 0.22);
      const cy = f + bh;
      for (let i = 0; i < rows; i++) {
        const z = -bd / 2 + gap + rowD / 2 + i * (rowD + gap);
        b.box(2, 'cell', -W * 0.06, cy, z, bw * 0.9, chipH, rowD, { edges: i === 0 || i === rows - 1 ? 'top' : 'none', glow: 0.6, surface: i % 2 ? 'hullDark' : 'circuit', pattern: i % 2 ? 'panels' : 'circuit' });
        b.pins(-W * 0.06, z, bw * 0.9, rowD, cy, Math.max(4, bw / 18), 1.2, true);
        if (i < rows - 1) b.channel(-W * 0.06 - bw * 0.45, z + rowD / 2 + gap / 2, -W * 0.06 + bw * 0.45, z + rowD / 2 + gap / 2, cy, gap * 0.35, 'data', glow);
      }
      // The controller: a tall stepped block at the +x end (primary mass 2, 3).
      const cw = W * 0.2, cd = D * 0.5;
      const cx = W / 2 - cw / 2 - W * 0.02;
      b.box(1, 'controller', cx, f, 0, cw, H * 0.75, cd, { edges: 'silhouette', mass: 2 });
      b.box(1, 'controller', cx, f + H * 0.75, 0, cw * 0.62, H * 0.25, cd * 0.62, { edges: 'top', mass: 3 });
      b.seams(cx, 0, cw, cd, f, f + H * 0.75, p.seamEvery);
      roof = { x: cx, y: f + H, z: 0, r: Math.min(cw, cd) * 0.31 };
      traces(W * 0.3);
      required.cell = 3;
    } else if (variant === 'router') {
      // A square core with four arms reaching the plate edges; lit channels ride the arms.
      const cs = Math.min(W, D) * 0.34;
      const coreH = H;
      b.box(1, 'core', 0, f, 0, cs, coreH * 0.7, cs, { edges: 'silhouette', mass: 1 });
      b.box(1, 'core', 0, f + coreH * 0.7, 0, cs * 0.7, coreH * 0.3, cs * 0.7, { edges: 'top', mass: 2 });
      const armH = Math.max(5, coreH * 0.22);
      const armW = cs * 0.4;
      for (let k = 0; k < 4; k++) {
        const alongX = k % 2 === 0;
        const s = k < 2 ? 1 : -1;
        const len = (alongX ? W : D) / 2 - cs / 2;
        const mid = cs / 2 + len / 2;
        const ax = alongX ? s * mid : 0, az = alongX ? 0 : s * mid;
        b.box(2, 'arm', ax, f, az, alongX ? len : armW, armH, alongX ? armW : len, { edges: 'top', glow: 0.5 });
        b.channel(alongX ? s * cs / 2 : 0, alongX ? 0 : s * cs / 2, alongX ? s * (cs / 2 + len) : 0, alongX ? 0 : s * (cs / 2 + len), f + armH, armW * 0.18, 'data', glow);
        // Portal at the arm's end (entrance light) and a connection point.
        const ex = alongX ? s * (cs / 2 + len) : 0, ez = alongX ? 0 : s * (cs / 2 + len);
        b.box(3, 'portal', ex, f + armH * 0.15, ez, alongX ? 0.6 : armW * 0.55, armH * 0.6, alongX ? armW * 0.55 : 0.6, { surface: 'glow', light: 'entrance', glow: 0.9, solid: false });
        b.connect(ex, 0, ez, alongX ? (s > 0 ? 0 : 2) : (s > 0 ? 1 : 3), 'data');
      }
      b.seams(0, 0, cs, cs, f, f + coreH * 0.7, p.seamEvery, { lit: rng.chance(0.12), light: accent });
      roof = { x: 0, y: f + coreH, z: 0, r: cs * 0.35 };
      required.arm = 4;
    } else if (variant === 'array') {
      // A grid of chips of varied height: one or two tall processors among low cells.
      const n = Math.max(2, Math.min(5, p.subdivisions));
      const gx = W * 0.86 / n, gz = D * 0.86 / n;
      const gap = Math.max(3, Math.min(gx, gz) * 0.16);
      const tall = new Set([rng.int(0, n * n - 1), rng.int(0, n * n - 1)]);
      let m = 1;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x = -W * 0.43 + gx * (i + 0.5), z = -D * 0.43 + gz * (j + 0.5);
        const isTall = tall.has(i * n + j);
        const h = isTall ? H : Math.max(3, H * rng.range(0.12, 0.38));
        const cw = (gx - gap) * rng.range(0.78, 1), cd = (gz - gap) * rng.range(0.78, 1);
        if (isTall && m < 4) {
          // A tall processor: a stepped shaft with a narrower upper tier.
          b.box(1, 'cell', x, f, z, cw, h * 0.72, cd, { edges: 'silhouette', mass: m });
          b.box(1, 'cell', x, f + h * 0.72, z, cw * 0.66, h * 0.28, cd * 0.66, { edges: 'top', mass: m++, surface: 'circuit', pattern: 'circuit' });
          b.seams(x, z, cw, cd, f, f + h * 0.72, p.seamEvery);
          roof ??= { x, y: f + h, z, r: Math.min(cw, cd) * 0.3 };
        } else {
          b.box(2, 'cell', x, f, z, cw, h, cd, { edges: rng.chance(0.25) ? 'top' : 'none', glow: 0.5, surface: rng.chance(0.4) ? 'circuit' : 'hullDark', pattern: 'circuit' });
          if (rng.chance(0.5)) b.box(3, 'cap', x, f + h, z, cw * 0.5, 1.2, cd * 0.5, { surface: 'metal', solid: false });
        }
      }
      for (let i = 1; i < n; i++) {
        b.channel(-W * 0.43 + gx * i, -D * 0.43, -W * 0.43 + gx * i, D * 0.43, f, gap * 0.3, 'data', glow);
        b.channel(-W * 0.43, -D * 0.43 + gz * i, W * 0.43, -D * 0.43 + gz * i, f, gap * 0.3, 'data', glow * 0.7);
      }
      traces(W * 0.43);
      required.cell = 4;
    } else if (variant === 'bus') {
      // Long parallel bars of different heights separated by bright recessed lanes, bridged.
      const bars = Math.max(2, Math.min(3, Math.round(p.subdivisions / 2)));
      const lane = Math.max(4, D * 0.09);
      const barD = (D * 0.9 - lane * (bars - 1)) / bars;
      const L = W * 0.94;
      for (let i = 0; i < bars; i++) {
        const z = -D * 0.45 + barD / 2 + i * (barD + lane);
        const h = H * (i === Math.floor(bars / 2) ? 1 : rng.range(0.35, 0.7));
        b.box(1, 'bar', 0, f, z, L, h, barD, { edges: 'top', mass: i + 1 });
        b.seams(0, z, L, barD, f, f + h, p.seamEvery > 0 ? Math.max(6, p.seamEvery) : 0);
        if (i < bars - 1) {
          const lz = z + barD / 2 + lane / 2;
          b.channel(-L / 2, lz, L / 2, lz, f, lane * 0.5, 'data', glow * 1.2);
          // Cross-bridges at intervals over the lane.
          const nb = Math.max(2, Math.floor(L / 90));
          for (let k = 0; k < nb; k++) {
            const bx = -L / 2 + (k + 0.5) * (L / nb);
            b.box(2, 'bridge', bx, f + Math.min(h, H * 0.3) * 0.7, lz, 6, 3, lane + 2, { edges: 'base', light: 'data', glow: 0.6 });
          }
        }
        if (i === Math.floor(bars / 2)) roof = { x: 0, y: f + h, z, r: Math.min(barD, L) * 0.35 };
      }
      // End caps: entrances.
      for (const s of [-1, 1]) {
        b.box(3, 'portal', s * (L / 2 + 0.3), f + 1, 0, 0.6, Math.min(12, H * 0.3), Math.min(D * 0.3, 30), { surface: 'glow', light: 'entrance', glow: 0.8, solid: false });
        b.connect(s * W / 2, 0, 0, s > 0 ? 0 : 2, 'transport');
      }
      required.bar = 2;
    } else {
      // stepped: a ziggurat of plates, each tier lit along its top rim; the lowest tier may be
      // an accessible hall (InteriorGenerator fills it).
      const steps = Math.max(2, Math.min(4, p.steps + 1));
      let tw = W * 0.9, td = D * 0.9, y = f;
      const th = H / steps;
      const hollow = rng.chance(0.45) && th > 10 && Math.min(tw, td) > 50;
      for (let i = 0; i < steps; i++) {
        if (i === 0 && hollow) {
          interior = { accessible: true, x0: -tw / 2 + 2, x1: tw / 2 - 2, z0: -td / 2 + 2, z1: td / 2 - 2, y0: y, y1: y + th - 2, wall: 2, entrances: [{ side: 0, offset: 0, width: Math.min(24, td * 0.3), height: Math.min(th * 0.7, 14) }, { side: 2, offset: 0, width: Math.min(24, td * 0.3), height: Math.min(th * 0.7, 14) }], program: rng.chance(0.5) ? 'hall' : 'chamber' };
          shellWalls(b, interior, { surface: b.primary, pattern: 'panels', mass: 1, edges: 'top', light: accent });
          b.connect(tw / 2, 0, 0, 0, 'transport');
          b.connect(-tw / 2, 0, 0, 2, 'transport');
        } else {
          b.box(1, 'tier', 0, y, 0, tw, th, td, { edges: 'top', mass: Math.min(4, i + (hollow ? 1 : 0) + 1), surface: i === steps - 1 ? 'circuit' : b.primary, pattern: i === steps - 1 ? 'circuit' : 'panels' });
          b.seams(0, 0, tw, td, y, y + th, p.seamEvery > 0 ? Math.max(5, p.seamEvery * 0.8) : 0);
        }
        // Vertical recessed slots on two faces, lit (process light: cache activity).
        if (i > 0 || !hollow) {
          for (const s of [-1, 1]) b.box(3, 'slot', 0, y + th * 0.15, s * (td / 2 + 0.2), tw * 0.08, th * 0.7, 0.5, { surface: 'glow', light: secondary, glow: 0.6, solid: false });
        }
        y += th;
        tw *= lerp(0.62, 0.8, rng.next());
        td *= lerp(0.62, 0.8, rng.next());
      }
      b.box(2, 'crown', 0, y, 0, tw * 0.6, Math.max(3, th * 0.35), td * 0.6, { edges: 'top', light: secondary, glow: 0.8 });
      roof = undefined; // crowned: no pad
      traces(W * 0.45);
      required.tier = hollow ? 1 : 2;
    }
    void func;
    return {
      b, height: topOf(b), interior, roof, required,
      primary: b.primary, secondary: 'hullDark', accent, secondaryLight: secondary, pulse: 0.4 + rng.next() * 0.6,
    };
  },
};
