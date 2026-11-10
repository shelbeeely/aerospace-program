import type { Builder } from './grammar.ts';
import type { LightRole, Pattern, Surface } from './palette.ts';
import type { InteriorConfig } from './types.ts';

/**
 * Interiors in the same language as the exteriors, sized from the shell they sit in so they are
 * spatially consistent: an InteriorConfig is the inner volume of a hollow mass, and everything
 * here is placed inside it, clear of every entrance's sightline (the nave). Interior elements
 * are flagged `interior` (drawn at full detail only) but always carry colliders, so programs
 * and vehicles can drive in through the openings.
 *
 * Programmes:
 * - hall: repeating structural bays (columns and ceiling beams), a long central corridor lit
 *   along its edges, elevated walkways along the walls with a ramp, a light shaft, a recessed
 *   dais at the far end and large machinery on it;
 * - chamber: one monumental room around a central machine, a ring walkway, radial floor channels;
 * - shaft: a deep vertical void with ring walkways at several levels.
 */

/** Build the hollow shell: walls with real openings for each entrance, and a roof slab. */
export function shellWalls(b: Builder, cfg: InteriorConfig, o: { surface: Surface; pattern?: Pattern; mass: number; edges?: 'none' | 'top' | 'silhouette'; roofPattern?: Pattern; roofSurface?: Surface; light?: LightRole }): void {
  const t = cfg.wall;
  const h = cfg.y1 - cfg.y0;
  const sides = [
    // side, wall centre line, along axis length, along-axis centre
    { side: 0, alongX: false, at: cfg.x1 + t / 2, from: cfg.z0 - t, to: cfg.z1 + t },
    { side: 2, alongX: false, at: cfg.x0 - t / 2, from: cfg.z0 - t, to: cfg.z1 + t },
    { side: 1, alongX: true, at: cfg.z1 + t / 2, from: cfg.x0, to: cfg.x1 },
    { side: 3, alongX: true, at: cfg.z0 - t / 2, from: cfg.x0, to: cfg.x1 },
  ];
  for (const s of sides) {
    const mid = (s.from + s.to) / 2;
    // Openings on this side as [a, b] intervals along it, with their heights.
    const holes = cfg.entrances.filter((e) => e.side === s.side).map((e) => ({ a: mid + e.offset - e.width / 2, b: mid + e.offset + e.width / 2, h: Math.min(e.height, h - 1) })).sort((p, q) => p.a - q.a);
    let cur = s.from;
    const piece = (a: number, c: number, y0: number, y1: number) => {
      if (c - a < 0.5 || y1 - y0 < 0.5) return;
      const m = (a + c) / 2;
      b.box(1, 'wall', s.alongX ? m : s.at, y0, s.alongX ? s.at : m, s.alongX ? c - a : t, y1 - y0, s.alongX ? t : c - a, { surface: o.surface, pattern: o.pattern ?? 'panels', edges: o.edges ?? 'none', light: o.light, mass: o.mass });
    };
    for (const hole of holes) {
      piece(cur, hole.a, cfg.y0, cfg.y1);
      piece(hole.a, hole.b, cfg.y0 + hole.h, cfg.y1); // lintel
      // The geometric doorway: a lit frame around the opening (entrance light).
      const m = (hole.a + hole.b) / 2, wdt = hole.b - hole.a;
      const off = s.side === 0 || s.side === 1 ? t / 2 + 0.15 : -(t / 2 + 0.15);
      const fx = s.alongX ? m : s.at + off, fz = s.alongX ? s.at + off : m;
      b.box(3, 'portal', fx, cfg.y0 + hole.h, fz, s.alongX ? wdt : 0.3, 0.6, s.alongX ? 0.3 : wdt, { surface: 'glow', light: 'entrance', glow: 1.2, solid: false });
      for (const e of [hole.a, hole.b]) {
        b.box(3, 'portal', s.alongX ? e : fx, cfg.y0, s.alongX ? fz : e, 0.5, hole.h, 0.5, { surface: 'glow', light: 'entrance', glow: 0.9, solid: false });
      }
      cur = hole.b;
    }
    piece(cur, s.to, cfg.y0, cfg.y1);
  }
  const rt = Math.max(1.5, t * 1.2);
  b.box(1, 'roof', (cfg.x0 + cfg.x1) / 2, cfg.y1, (cfg.z0 + cfg.z1) / 2, cfg.x1 - cfg.x0 + 2 * t, rt, cfg.z1 - cfg.z0 + 2 * t, {
    surface: o.roofSurface ?? o.surface, pattern: o.roofPattern ?? 'panels', edges: o.edges === 'none' ? 'none' : 'top', light: o.light, mass: o.mass,
  });
}

/** Fill a shell with its programme. */
export function furnishInterior(b: Builder, cfg: InteriorConfig, light: LightRole): void {
  if (!cfg.accessible) return;
  const W = cfg.x1 - cfg.x0, D = cfg.z1 - cfg.z0, H = cfg.y1 - cfg.y0;
  const cx = (cfg.x0 + cfg.x1) / 2, cz = (cfg.z0 + cfg.z1) / 2;
  const y0 = cfg.y0;
  const I = { interior: true } as const;
  // Floor plate with circuit traces, and lit lines from each entrance toward the centre.
  b.box(3, 'floor', cx, y0, cz, W - 0.5, 0.12, D - 0.5, { surface: 'circuit', pattern: 'circuit', solid: false, ...I });
  for (const e of cfg.entrances) {
    const xSide = e.side % 2 === 0; // openings in the ±x walls lead in along x
    const sgn = e.side === 0 || e.side === 1 ? 1 : -1;
    for (const s of [-1, 1]) {
      if (xSide) {
        const z = cz + e.offset + s * e.width * 0.45;
        const xa = sgn > 0 ? cfg.x1 : cfg.x0;
        b.channel(xa, z, xa - sgn * W * 0.35, z, y0 + 0.13, 0.5, 'entrance', 0.8);
      } else {
        const x = cx + e.offset + s * e.width * 0.45;
        const za = sgn > 0 ? cfg.z1 : cfg.z0;
        b.channel(x, za, x, za - sgn * D * 0.35, y0 + 0.13, 0.5, 'entrance', 0.8);
      }
    }
  }
  if (cfg.program === 'hall') hall(b, cfg, light, W, D, H, cx, cz);
  else if (cfg.program === 'chamber') chamber(b, cfg, light, W, D, H, cx, cz);
  else shaft(b, cfg, light, W, D, H, cx, cz);
}

/** Half-width of the clear nave along the hall's long axis (from the widest entrance). */
function naveHalf(cfg: InteriorConfig): number {
  let w = 8;
  for (const e of cfg.entrances) w = Math.max(w, e.width);
  return w / 2 + 2;
}

function hall(b: Builder, cfg: InteriorConfig, light: LightRole, W: number, D: number, H: number, cx: number, cz: number): void {
  const I = { interior: true } as const;
  const y0 = cfg.y0;
  const alongX = W >= D;
  const L = alongX ? W : D, S = alongX ? D : W;
  const nave = Math.min(naveHalf(cfg), S * 0.3);
  const bay = Math.max(10, Math.min(28, L / Math.max(3, Math.round(L / 20))));
  const n = Math.max(2, Math.floor(L / bay));
  const colR = Math.max(0.8, S * 0.02);
  const sideOff = Math.max(nave + colR + 1, S * 0.32);
  const P = (u: number, v: number): [number, number] => (alongX ? [cx + u, cz + v] : [cx + v, cz + u]);
  // Repeating structural bays: column pairs and a ceiling beam across each bay.
  for (let i = 1; i < n; i++) {
    const u = -L / 2 + (i * L) / n;
    for (const s of [-1, 1]) {
      const [x, z] = P(u, s * sideOff);
      b.box(2, 'column', x, y0, z, colR * 2, H, colR * 2, { surface: 'hullDark', edges: 'none', ...I });
    }
    const [bx, bz] = P(u, 0);
    b.box(2, 'beam', bx, y0 + H - 2.2, bz, alongX ? colR * 1.6 : S - 1, 2, alongX ? S - 1 : colR * 1.6, { surface: 'metal', edges: 'base', light, glow: 0.5, ...I });
    b.box(3, 'ceiling', bx, y0 + H - 2.4, bz, alongX ? 0.4 : S * 0.5, 0.2, alongX ? S * 0.5 : 0.4, { surface: 'glow', light: 'energy', glow: 0.5, solid: false, ...I });
  }
  // The long corridor: lit edges down the nave.
  for (const s of [-1, 1]) {
    const [ax, az] = P(-L / 2 + 2, s * nave), [bx2, bz2] = P(L / 2 - 2, s * nave);
    b.channel(ax, az, bx2, bz2, y0 + 0.14, 0.35, light, 0.9);
  }
  // Elevated walkways along both long walls (when tall enough), with a ramp at one end.
  const wy = Math.min(H * 0.45, 14);
  if (H > 12 && S > 3 * nave) {
    const ww = Math.max(3, (S / 2 - sideOff) * 0.8);
    for (const s of [-1, 1]) {
      const v = s * (S / 2 - ww / 2 - 0.3);
      const [x, z] = P(L * 0.05, v);
      b.box(2, 'walkway', x, y0 + wy, z, alongX ? L * 0.8 : ww, 0.8, alongX ? ww : L * 0.8, { surface: 'hullDark', edges: 'top', light: 'structure', glow: 0.7, ...I });
      const rv = v - s * (ww / 2);
      const [r0x, r0z] = P(-L * 0.35, rv), [r1x, r1z] = P(L * 0.45, rv);
      b.channel(r0x, r0z, r1x, r1z, y0 + wy + 1.1, 0.15, 'structure', 1);
    }
    // Ramp from the floor up to the first walkway, along the wall.
    const rv = -(S / 2 - 2.2);
    const a: [number, number] = P(-L * 0.35 - wy * 2.2, rv), c: [number, number] = P(-L * 0.35, rv);
    b.sweep(2, 'ramp', [[-1.8, -0.4], [1.8, -0.4], [1.8, 0], [-1.8, 0]], [[a[0], y0 + 0.4, a[1]], [c[0], y0 + wy + 0.4, c[1]]], { surface: 'hullDark', edges: 'top', light: 'structure', glow: 0.5, ...I, solid: false });
  }
  // A light shaft rising through the hall's middle bay to a skylight.
  const [sx, sz] = P(L * 0.12, 0);
  b.prism(2, 'shaft', sx, y0 + 0.2, sz, 16, Math.min(nave * 0.6, 5), Math.min(nave * 0.6, 5), H - 0.4, { surface: 'translucent', light: 'energy', glow: 0.7, solid: false, ...I });
  b.ring(3, 'shaftring', sx, y0 + 0.15, sz, Math.min(nave * 0.6, 5), Math.min(nave * 0.6, 5) + 0.8, 0.2, 24, { surface: 'glow', light: 'energy', glow: 1, solid: false, ...I });
  // The recessed dais at the far end with large machinery on it.
  const dl = Math.min(L * 0.22, 60), dh = Math.min(3, H * 0.12);
  const [dx, dz] = P(L / 2 - dl / 2 - 1, 0);
  b.box(2, 'dais', dx, y0, dz, alongX ? dl : S * 0.7, dh, alongX ? S * 0.7 : dl, { surface: 'hullDark', edges: 'top', light, glow: 0.8, ...I });
  const m = Math.max(2, Math.min(4, Math.floor((S * 0.6) / 10)));
  for (let k = 0; k < m; k++) {
    const v = -S * 0.3 + (k + 0.5) * ((S * 0.6) / m);
    if (Math.abs(v) < nave * 0.5 && m > 2) continue;
    const [mx, mz] = P(L / 2 - dl / 2 - 1, v);
    const mr = Math.min((S * 0.6) / m * 0.35, dl * 0.3, H * 0.25);
    b.prism(2, 'machinery', mx, y0 + dh, mz, 12, mr, mr * 0.85, Math.min(H * 0.55, mr * 3), { surface: 'metal', pattern: 'flutes', edges: 'top', light: 'process', glow: 0.9, ...I });
    b.box(3, 'slot', mx, y0 + dh + mr, mz + (alongX ? 0 : mr), alongX ? 0.4 : mr * 0.6, mr * 0.9, alongX ? mr * 0.6 : 0.4, { surface: 'glow', light: 'process', glow: 1, solid: false, ...I });
  }
}

function chamber(b: Builder, cfg: InteriorConfig, light: LightRole, W: number, D: number, H: number, cx: number, cz: number): void {
  const I = { interior: true } as const;
  const y0 = cfg.y0;
  const R = Math.min(W, D) * 0.18;
  // Central machine: a stepped revolved core, lit at its rim, with process light.
  b.lathe(2, 'machinery', cx, y0, cz, [[R, 0], [R, H * 0.08], [R * 0.7, H * 0.12], [R * 0.6, H * 0.6], [R * 0.85, H * 0.66], [R * 0.4, H * 0.75]], 24, { surface: 'metal', pattern: 'flutes', edges: 'horizontal', light: 'process', glow: 0.8, ...I });
  b.torus(3, 'halo', cx, y0 + H * 0.4, cz, R * 1.4, 0.4, { surface: 'glow', light: 'process', glow: 1.3, ...I });
  // Radial floor channels from the machine to the walls.
  const n = 8;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const r0 = R * 1.2, r1 = Math.min(W, D) * 0.45;
    b.box(3, 'channel', cx + Math.cos(a) * (r0 + r1) / 2, y0 + 0.14, cz + Math.sin(a) * (r0 + r1) / 2, r1 - r0, 0.12, 0.6, { surface: 'glow', light, glow: 0.8, ry: -a, solid: false, ...I });
  }
  // Ring walkway on columns.
  if (H > 14) {
    const rr = Math.min(W, D) * 0.36;
    b.ring(2, 'walkway', cx, y0 + H * 0.4, cz, rr - 3, rr, 0.8, 32, { surface: 'hullDark', edges: 'top', light: 'structure', glow: 0.7, ...I });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      b.box(2, 'column', cx + Math.cos(a) * (rr - 1.5), y0, cz + Math.sin(a) * (rr - 1.5), 1.4, H * 0.4, 1.4, { surface: 'hullDark', ...I });
    }
  }
}

function shaft(b: Builder, cfg: InteriorConfig, light: LightRole, W: number, D: number, H: number, cx: number, cz: number): void {
  const I = { interior: true } as const;
  const y0 = cfg.y0;
  const r = Math.min(W, D) * 0.3;
  const levels = Math.max(2, Math.floor(H / 12));
  for (let i = 1; i < levels; i++) {
    const y = y0 + (i * H) / levels;
    b.ring(2, 'walkway', cx, y, cz, r, r + Math.min(W, D) * 0.12, 0.8, 4, { surface: 'hullDark', edges: 'top', light: i % 2 ? light : 'structure', glow: 0.8, ...I });
  }
  b.prism(2, 'shaft', cx, y0 + 0.2, cz, 4, r * 0.9, r * 0.9, H - 0.4, { surface: 'translucent', light: 'data', glow: 0.4, solid: false, phase: Math.PI / 4, ...I });
}
