import { Builder } from '../grammar.ts';
import { lerp, Rng } from '../rng.ts';
import type { GenRequest } from '../types.ts';
import { pickHeight, regionAccent, TAU, topOf, type FamilyGenerator, type GenOutput } from './common.ts';

/**
 * E. Radial and communication structures (The Art of TRON, pp. 10, 16, 39, 53–58).
 *
 * Circular, symmetrical, concentric: I/O towers on stepped radial bases with an elevated
 * central platform and a beam; the stepped concentric tiers of the I/O chamber with light
 * fanning from the peak (p. 58); elevated communication dishes on rings of slender columns;
 * energy distributors of concentric walls and radial conduits; transit hubs (a ring building,
 * radial bridges, a translucent paned plaza, p. 10); floating ring platforms (the ring game,
 * p. 39, and the hovering rings of Chris Lane's concept, p. 10).
 */
export const RadialStructureGenerator: FamilyGenerator = {
  id: 'radial',
  label: 'Radial / communication structure',
  reference: 'The Art of TRON pp. 10, 16, 39, 53–58',
  description: 'Concentric rings, stepped radial bases, elevated central platforms, slender connectors, beams and bridges.',
  functions: ['io-tower', 'comm-node', 'energy-distributor', 'transit-hub', 'beacon'],
  variants: ['io', 'stepped', 'dish', 'distributor', 'hub', 'rings'],
  variantFor: { 'io-tower': 'io', 'comm-node': 'dish', 'energy-distributor': 'distributor', 'transit-hub': 'hub', beacon: 'stepped' },
  params: [
    { key: 'height', label: 'Height (0–1)', min: 0.3, max: 1, step: 0.01, def: 0.7 },
    { key: 'rings', label: 'Rings', min: 1, max: 5, step: 1, def: 3 },
    { key: 'spokes', label: 'Spokes', min: 4, max: 12, step: 1, def: 8 },
    { key: 'elevation', label: 'Platform elevation', min: 0.2, max: 0.75, step: 0.01, def: 0.5 },
    { key: 'core', label: 'Core radius (of lot)', min: 0.05, max: 0.2, step: 0.01, def: 0.1 },
    { key: 'beam', label: 'Beam (0/1)', min: 0, max: 1, step: 1, def: 1 },
  ],
  lot: { min: 1, max: 3, elongation: 1 },
  elongated: false,
  build(req: GenRequest, rng: Rng, p: Record<string, number>, func: string, variant: string): GenOutput {
    const { accent, secondary } = regionAccent(req.region, rng);
    const b = new Builder(rng, rng.chance(0.35) ? 'panel' : 'hull', accent);
    const R = (Math.min(req.w, req.d) / 2) * 0.94;
    const H = pickHeight(req, rng, p.height);
    const core = Math.max(3, R * p.core);
    const required: Record<string, number> = { ring: 1 };
    const beamLight = rng.chance(0.7) ? 'energy' : 'structure';
    const spokesOnGround = (y: number, r0: number, r1: number, light = accent) => {
      for (let k = 0; k < p.spokes; k++) {
        const a = (k / p.spokes) * TAU;
        b.box(3, 'spoke', Math.cos(a) * (r0 + r1) / 2, y, Math.sin(a) * (r0 + r1) / 2, r1 - r0, 0.12, 0.8, { surface: 'glow', light, glow: 0.8, ry: -a, solid: false });
      }
    };
    const fourLinks = (r: number, kind: 'data' | 'energy' | 'transport') => {
      for (let k = 0; k < 4; k++) {
        const [cx, cz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][k];
        b.connect(cx * r, 0, cz * r, k, kind);
      }
    };

    if (variant === 'io') {
      const st = Math.max(2.5, H * 0.03);
      const prof: Array<[number, number]> = [];
      for (let i = 0; i < 3; i++) prof.push([R * (1 - i * 0.22), i * st], [R * (1 - i * 0.22), (i + 1) * st]);
      b.lathe(1, 'base', 0, 0, 0, prof, 32, { surface: 'hullDark', pattern: 'panels', edges: 'horizontal', light: accent, glow: 0.7, mass: 0 });
      const by = 3 * st;
      spokesOnGround(by, core * 1.5, R * 0.55);
      b.prism(1, 'core', 0, by, 0, 12, core, core * 0.8, H * 0.86 - by, { pattern: 'flutes', edges: 'none', mass: 1 });
      const py = Math.max(by + 10, H * p.elevation);
      const pr = R * 0.5;
      b.lathe(1, 'platform', 0, py, 0, [[core, 0], [pr, 2.5], [pr, 4.5], [pr * 0.8, 6], [core, 7]], 32, { surface: b.primary, edges: 'horizontal', light: accent, glow: 0.8, mass: 2 });
      for (let i = 0; i < p.rings; i++) b.torus(2, 'ring', 0, py + 14 + i * Math.max(6, (H - py) * 0.12), 0, pr * (0.75 - i * 0.12), Math.max(0.35, pr * 0.01), { surface: 'glow', light: i === 0 ? secondary : accent, glow: 1.5 });
      // Slender struts from the platform rim down to the base (tilted: drawn, not collided).
      const struts = Math.min(8, Math.max(4, Math.round(p.spokes / 1.5)));
      for (let k = 0; k < struts; k++) {
        const a = (k / struts) * TAU;
        const r0 = R * 0.62, r1 = pr * 0.95;
        const dh = py - by, dr = r0 - r1;
        const len = Math.hypot(dh, dr);
        const tilt = Math.atan2(dr, dh);
        b.prism(2, 'strut', Math.cos(a) * r0, by, Math.sin(a) * r0, 6, 0.8, 0.6, len, { surface: 'metal', edges: 'none', solid: false, rx: Math.sin(a) * -tilt, rz: Math.cos(a) * tilt });
      }
      if (p.beam >= 1) b.prism(2, 'beam', 0, H * 0.86, 0, 12, core * 0.5, core * 0.5, Math.max(300, H * 1.5), { surface: 'translucent', light: beamLight, glow: 1.4, solid: false });
      b.box(3, 'tip', 0, H * 0.86, 0, core * 1.2, 1.5, core * 1.2, { surface: 'glow', light: beamLight, glow: 1.8, solid: false });
      fourLinks(R, 'data');
      required.platform = 1;
    } else if (variant === 'stepped') {
      // Concentric stepped tiers to a peak, a lit enclosure on top, light fanning out (p. 58).
      const steps = rng.int(5, 8);
      const prof: Array<[number, number]> = [];
      const sh = (H * 0.7) / steps;
      for (let i = 0; i < steps; i++) {
        const r = R * (1 - (i / steps) * 0.82);
        prof.push([r, i * sh], [r, (i + 1) * sh]);
      }
      b.lathe(1, 'tiers', 0, 0, 0, prof, 48, { surface: b.primary, pattern: 'panels', edges: 'horizontal', light: accent, glow: 0.75, mass: 0 });
      const topR = R * (1 - ((steps - 1) / steps) * 0.82);
      const ty = steps * sh;
      b.prism(1, 'enclosure', 0, ty, 0, 8, topR * 0.6, topR * 0.25, H - ty, { surface: 'translucent', light: 'energy', glow: 1.2, solid: false, mass: 1 });
      b.prism(1, 'core', 0, ty, 0, 8, topR * 0.3, topR * 0.25, (H - ty) * 0.4, { surface: 'metal', edges: 'silhouette', glow: 0.6, mass: 2 });
      // Fanning rays: thin translucent slabs raking up and out from the peak.
      const rays = 6;
      for (let k = 0; k < rays; k++) {
        const a = (k / rays) * TAU + 0.3;
        b.box(3, 'ray', Math.cos(a) * topR * 0.4, ty, Math.sin(a) * topR * 0.4, 0.6, H * 0.9, R * 0.04, { surface: 'translucent', light: 'energy', glow: 0.5, ry: -a, rz: 0.75 * Math.cos(a), rx: -0.75 * Math.sin(a), solid: false });
      }
      b.torus(2, 'ring', 0, ty + (H - ty) * 0.7, 0, topR * 1.6, Math.max(0.6, R * 0.015), { surface: 'glow', light: 'warning', glow: 1.3 });
      fourLinks(R, 'data');
      required.tiers = 1;
    } else if (variant === 'dish') {
      const py = Math.max(14, H * p.elevation);
      b.prism(1, 'core', 0, 0, 0, 16, core * 1.4, core, py, { pattern: 'flutes', edges: 'none', mass: 0 });
      const cr = R * 0.62;
      for (let k = 0; k < p.spokes; k++) {
        const a = (k / p.spokes) * TAU;
        b.prism(2, 'column', Math.cos(a) * cr, 0, Math.sin(a) * cr, 6, Math.max(0.8, R * 0.025), Math.max(0.6, R * 0.02), py, { surface: 'metal', edges: 'none' });
      }
      const dr = R * 0.92;
      b.lathe(1, 'platform', 0, py, 0, [[core, -3], [dr * 0.8, -1], [dr, 0], [dr, 2.5], [dr * 0.96, 3.5]], 48, { surface: b.primary, pattern: 'panels', edges: 'horizontal', light: accent, glow: 0.8, mass: 1 });
      for (let i = 0; i < p.rings; i++) {
        const r1 = dr * (0.88 - i * 0.16);
        b.ring(2, 'ring', 0, py + 3.5, 0, r1 - 2.5, r1, 1.2 + i * 1.2, 48, { surface: 'hullDark', edges: 'top', light: i % 2 ? secondary : accent, glow: 0.9 });
      }
      spokesOnGround(py + 3.6, core * 2, dr * 0.85);
      b.prism(1, 'spire', 0, py + 3.5, 0, 8, core * 0.7, 0.3, Math.max(10, H - py - 3.5), { surface: 'metal', edges: 'silhouette', glow: 0.6, mass: 2 });
      fourLinks(R * 0.7, 'data');
      required.column = 4;
    } else if (variant === 'distributor') {
      const eh = Math.max(12, H * 0.5);
      b.prism(1, 'core', 0, 0, 0, 32, core * 1.6, core * 1.4, eh, { surface: b.primary, pattern: 'flutes', edges: 'top', light: 'energy', glow: 1, mass: 0 });
      b.prism(2, 'beam', 0, eh, 0, 16, core * 0.6, core * 0.6, Math.max(80, H), { surface: 'translucent', light: 'energy', glow: 0.9, solid: false });
      for (let i = 0; i < p.rings; i++) {
        const r1 = core * 2.2 + (R - core * 2.2) * ((i + 1) / p.rings);
        const h = Math.max(3, eh * (0.4 - i * 0.06));
        b.ring(i === p.rings - 1 ? 1 : 2, 'ring', 0, 0, 0, r1 - 2.5, r1, h, 48, { surface: 'hullDark', edges: 'top', light: 'energy', glow: 0.8, mass: i === p.rings - 1 ? 1 : undefined, arc: TAU - 0.5, arcStart: 0.25 });
      }
      const n = p.spokes >= 8 ? 8 : 4;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU;
        const axis = k % (n / 4) === 0;
        const r0 = core * 1.6, r1 = R * 0.98;
        const cx = Math.cos(a) * (r0 + r1) / 2, cz = Math.sin(a) * (r0 + r1) / 2;
        b.box(2, 'conduit', cx, 3, cz, r1 - r0, 2.2, 2.4, { surface: 'metal', edges: 'top', light: 'energy', glow: 1.1, ry: -a, solid: axis });
        if (axis) b.connect(Math.cos(a) * R, 0, Math.sin(a) * R, Math.round(a / (Math.PI / 2)) % 4, 'energy');
        for (let t = 1; t < 4; t++) {
          const r = r0 + ((r1 - r0) * t) / 4;
          b.box(3, 'pylon', Math.cos(a) * r, 0, Math.sin(a) * r, 1.2, 3, 1.2, { surface: 'hullDark', solid: false });
        }
      }
      required.conduit = 4;
    } else if (variant === 'hub') {
      const ro = R * 0.95, ri = R * 0.68, rh = Math.max(14, H * 0.32);
      for (let q = 0; q < 4; q++) {
        b.ring(1, 'ring', 0, 0, 0, ri, ro, rh, 48, { surface: b.primary, pattern: 'panels', edges: 'top', light: accent, glow: 0.8, mass: 0, arc: Math.PI / 2 - 0.22, arcStart: q * (Math.PI / 2) + 0.11 });
      }
      const th = Math.max(rh * 1.6, H);
      b.prism(1, 'core', 0, 0, 0, 8, core * 1.6, core * 1.1, th, { pattern: 'flutes', edges: 'silhouette', glow: 0.5, mass: 1 });
      b.prism(1, 'crown', 0, th, 0, 8, core * 1.1, core * 2, Math.max(6, th * 0.08), { surface: 'hullDark', edges: 'rims', light: secondary, glow: 0.9, mass: 2 });
      const by = rh * 0.6;
      for (let q = 0; q < 4; q++) {
        const alongX = q % 2 === 0;
        const s = q < 2 ? 1 : -1;
        const len = ri - core * 1.6;
        const m = core * 1.6 + len / 2;
        b.box(2, 'bridge', alongX ? s * m : 0, by, alongX ? 0 : s * m, alongX ? len : 5, 2.5, alongX ? 5 : len, { surface: 'hullDark', edges: 'base', light: 'data', glow: 0.8 });
      }
      // Elevated ring track on posts, outside the ring building.
      b.ring(2, 'track', 0, rh + 4, 0, ro - 3, ro + 1, 1.5, 64, { surface: 'metal', edges: 'top', light: 'structure', glow: 1 });
      // The plaza: a floor of large translucent glowing panes (p. 10).
      b.prism(3, 'plaza', 0, 0, 0, 32, ri - 1, ri - 1, 0.2, { surface: 'hullDark', pattern: 'skylight', solid: false });
      fourLinks(R, 'transport');
      required.bridge = 4;
    } else {
      // rings: floating ring platforms over a radial base, a slender mast through them.
      const bh = Math.max(3, H * 0.04);
      b.lathe(1, 'base', 0, 0, 0, [[R, 0], [R, bh], [R * 0.7, bh * 1.6], [R * 0.7, bh * 2]], 48, { surface: 'hullDark', edges: 'horizontal', light: accent, glow: 0.7, mass: 0 });
      for (let i = 1; i <= p.rings; i++) b.ring(3, 'ring', 0, bh * 2, 0, R * 0.7 * (i / (p.rings + 1)) - 0.6, R * 0.7 * (i / (p.rings + 1)), 0.2, 48, { surface: 'glow', light: accent, glow: 0.8, solid: false });
      b.prism(1, 'core', 0, bh * 2, 0, 8, core * 0.6, core * 0.4, H - bh * 2, { surface: 'metal', edges: 'none', mass: 1 });
      const fl = Math.max(2, Math.min(4, p.rings));
      for (let i = 0; i < fl; i++) {
        const y = lerp(H * 0.3, H * 0.85, i / Math.max(1, fl - 1));
        const r1 = R * lerp(0.5, 0.25, i / Math.max(1, fl - 1));
        b.ring(i === 0 ? 1 : 2, 'ring', 0, y, 0, r1 * 0.55, r1, 2, 48, { surface: b.primary, edges: i === 0 ? 'rims' : 'top', light: i % 2 ? 'warning' : accent, glow: 1, mass: i === 0 ? 2 : undefined });
        b.ring(3, 'ring', 0, y + 2.05, 0, r1 * 0.6, r1 * 0.66, 0.1, 48, { surface: 'glow', light: accent, glow: 1, solid: false });
      }
      if (p.beam >= 1) b.prism(2, 'beam', 0, H, 0, 8, core * 0.3, core * 0.3, Math.max(200, H), { surface: 'translucent', light: beamLight, glow: 1.2, solid: false });
      fourLinks(R, 'data');
    }
    void func;
    return { b, height: topOf(b), interior: null, required, primary: b.primary, secondary: 'hullDark', accent, secondaryLight: secondary, pulse: 0.3 + rng.next() * 0.6 };
  },
};
