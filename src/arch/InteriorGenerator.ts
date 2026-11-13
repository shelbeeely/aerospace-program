import type { Builder } from './grammar.ts';
import type { LightRole, Pattern, Surface } from './palette.ts';
import { rotQ } from './grammar.ts';
import type { Rng } from './rng.ts';
import type { ColliderPiece, Entrance, InteriorConfig, StructureSpec } from './types.ts';

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
 * - shaft: a deep vertical void with ring walkways at several levels;
 * - commons: a room at the scale of the people who live in the building (the Bits): banks of
 *   terminals along the walls, memory columns, a meeting ring on the floor under a halo, and
 *   clear aisles in from every door.
 *
 * `inhabit` gives a structure that was generated solid a commons: it hollows the largest
 * grounded box mass that has nothing standing in it into a shell with doors. `structureRoom`
 * is what the people need to know to use an interior: its doors and where they can stand.
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
  else if (cfg.program === 'chamber') chamber(b, cfg, light, cfg.round ? cfg.round.r * 2 : W, cfg.round ? cfg.round.r * 2 : D, H, cx, cz);
  else if (cfg.program === 'commons') commons(b, cfg, light, W, D, H, cx, cz);
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

/** Half-width of the clear aisle in from a door (m). */
const aisleHalf = (e: Entrance) => e.width / 2 + 0.75;

/** A room for the people: nothing in it is taller than it needs to be, and every door has a clear way in. */
function commons(b: Builder, cfg: InteriorConfig, light: LightRole, W: number, D: number, H: number, cx: number, cz: number): void {
  const I = { interior: true } as const;
  const y0 = cfg.y0;
  // Aisles: doors in the ±x walls lead in along x (a strip in z), doors in the ±z walls along z.
  let ax = 0, az = 0; // half-widths of the strips |z - cz| < az (x doors) and |x - cx| < ax (z doors)
  for (const e of cfg.entrances) {
    if (e.side % 2 === 0) az = Math.max(az, aisleHalf(e));
    else ax = Math.max(ax, aisleHalf(e));
  }
  // The meeting ring where the ways in cross, under a halo.
  const rr = Math.max(2, Math.min(W, D) * 0.14);
  b.ring(3, 'meeting', cx, y0 + 0.13, cz, rr, rr + 0.35, 0.08, 24, { surface: 'glow', light, glow: 0.9, solid: false, ...I });
  b.torus(3, 'halo', cx, y0 + H - 1.2, cz, rr, 0.18, { surface: 'glow', light: 'energy', glow: 1.1, ...I });
  // Terminal banks along the two walls that run beside the main aisle, clear of the cross aisle.
  const alongX = az >= ax ? true : false; // main aisle runs along x when the x doors are the wide ones
  const L = alongX ? W : D, S = alongX ? D : W;
  const cross = alongX ? ax : az, main = alongX ? az : ax;
  const P = (u: number, v: number): [number, number] => (alongX ? [cx + u, cz + v] : [cx + v, cz + u]);
  const pitch = 2.4;
  for (const side of [-1, 1]) {
    const v = side * (S / 2 - 0.7);
    if (Math.abs(v) < main + 1) continue; // the room is no wider than its aisle
    let k = 0;
    for (let u = -L / 2 + 1.6; u <= L / 2 - 1.6 && k < 10; u += pitch) {
      if (Math.abs(u) < cross + 1) continue;
      const [x, z] = P(u, v);
      b.box(2, 'terminal', x, y0, z, alongX ? 1.4 : 0.9, 1.5, alongX ? 0.9 : 1.4, { surface: 'metal', edges: 'none', ...I });
      const [sx, sz] = P(u, v - side * 0.48);
      b.box(3, 'slot', sx, y0 + 1.0, sz, alongX ? 1.0 : 0.08, 0.35, alongX ? 0.08 : 1.0, { surface: 'glow', light: k % 3 === 0 ? 'process' : 'data', glow: 0.9, solid: false, ...I });
      k++;
    }
  }
  // Memory columns in the quarters, floor to ceiling, when the room is big enough to keep them
  // off the aisles and the walls.
  const qu = (L / 2 + Math.max(cross, rr + 1)) / 2, qv = (S / 2 + Math.max(main, rr + 1)) / 2;
  const cr = Math.min(1.4, Math.max(0.6, Math.min(W, D) * 0.03));
  if (L / 2 - qu > cr + 1.5 && S / 2 - qv > cr + 2.4 && qv - main > cr + 0.8 && qu - cross > cr + 0.8) {
    for (const su of [-1, 1]) for (const sv of [-1, 1]) {
      const [x, z] = P(su * qu, sv * qv);
      b.prism(2, 'memory', x, y0, z, 8, cr, cr, H, { surface: 'metal', pattern: 'flutes', edges: 'none', ...I });
      b.ring(3, 'band', x, y0 + Math.min(2.2, H * 0.4), z, cr, cr + 0.12, 0.25, 8, { surface: 'glow', light: 'process', glow: 0.8, solid: false, ...I });
    }
  }
  // A vast low room (the undercroft of a foundation) is carried on a grid of plain columns,
  // clear of the aisles: they establish the scale, and they are what holds the slab up.
  if (Math.min(W, D) > 44) {
    const gap = Math.max(30, Math.max(W, D) / 4.5);
    const nu = Math.floor((L - 8) / gap), nv = Math.floor((S - 8) / gap);
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
      const u = (i - nu / 2) * gap, v = (j - nv / 2) * gap;
      if (Math.abs(v) < main + 2.5 || Math.abs(u) < cross + 2.5 || Math.hypot(u, v) < rr + 3) continue;
      if (Math.abs(Math.abs(u) - qu) < cr + 2 && Math.abs(Math.abs(v) - qv) < cr + 2) continue; // a memory column stands here
      const [x, z] = P(u, v);
      b.box(2, 'column', x, y0, z, 1.6, H, 1.6, { surface: 'hullDark', edges: 'none', ...I });
    }
  }
  // A lit seam along the ceiling over the main aisle.
  const [lx, lz] = P(0, 0);
  b.box(3, 'ceiling', lx, y0 + H - 0.25, lz, alongX ? W * 0.8 : 0.3, 0.15, alongX ? 0.3 : D * 0.8, { surface: 'glow', light: 'energy', glow: 0.5, solid: false, ...I });
}

const overlap = (c: ColliderPiece, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
  c.x + c.sx / 2 > x0 && c.x - c.sx / 2 < x1 && c.y + c.sy / 2 > y0 && c.y - c.sy / 2 < y1 && c.z + c.sz / 2 > z0 && c.z - c.sz / 2 < z1;

/** Smallest box mass worth living in (m), the people's door (m), and the steps up to a raised one. */
const HOME = { side: 14, height: 5.5, wall: 1, roof: 1.5, door: 8, doorHeight: 6, raised: 6.5, riser: 0.5, tread: 0.8 } as const;

interface Step { t: number; top: number; base: number }

/**
 * The way out of a door: a strip `hw` either side of the point (fx, fz) on the wall's outer
 * face, running out along `side` to the edge of the lot. Null if anything rises above the
 * threshold `y` in it. Otherwise the steps needed to get down to the ground: what is left in
 * the strip is floor (ledges below the threshold), and each drop gets a flight. `skip`: the
 * collider being hollowed.
 */
function wayOut(b: Builder, skip: number | ReadonlySet<number>, side: number, fx: number, fz: number, y: number, dh: number, hw: number, w: number, d: number): Step[] | null {
  const skipped = (j: number) => (typeof skip === 'number' ? j === skip : skip.has(j));
  const reach = Math.max(2, side === 0 ? w / 2 - fx : side === 2 ? fx + w / 2 : side === 1 ? d / 2 - fz : fz + d / 2);
  const strip = (ta: number, tb: number): [number, number, number, number] =>
    side === 0 ? [fx + ta, fx + tb, fz - hw, fz + hw] : side === 2 ? [fx - tb, fx - ta, fz - hw, fz + hw]
    : side === 1 ? [fx - hw, fx + hw, fz + ta, fz + tb] : [fx - hw, fx + hw, fz - tb, fz - ta];
  const [sx0, sx1, sz0, sz1] = strip(0, reach);
  if (b.cols.some((k, j) => !skipped(j) && k.y + k.sy / 2 > y + 0.3 && overlap(k, sx0, sx1, 0.3, y + dh, sz0, sz1))) return null;
  const floor = (ta: number, tb: number): number => {
    const [fx0, fx1, fz0, fz1] = strip(ta, tb);
    let f = 0;
    for (let j = 0; j < b.cols.length; j++) {
      const k = b.cols[j];
      if (!skipped(j) && overlap(k, fx0, fx1, -1, y + 0.3, fz0, fz1)) f = Math.max(f, k.y + k.sy / 2);
    }
    return f;
  };
  const steps: Step[] = [];
  let level = y, t = 0;
  while (t < reach) {
    const f = floor(t, t + 0.5);
    if (f > level + 0.3) return null; // a ledge higher than where we stand
    if (f >= level - HOME.riser) { level = Math.min(level, Math.max(f, 0)); t += 0.5; continue; }
    // A drop: a flight from `level` down to `f`, treads going outward from here.
    const n = Math.ceil((level - f) / HOME.riser), riser = (level - f) / n;
    const run = (n - 1) * HOME.tread;
    if (t + run > reach + 1.5 || floor(t, t + run + 0.5) > f + 0.3) return null;
    for (let k = 1; k < n; k++) steps.push({ t: t + (k - 1) * HOME.tread, top: level - k * riser, base: f });
    level = f;
    t += Math.max(0.5, run);
  }
  return level <= HOME.riser && steps.length <= 40 ? steps : null;
}

/** Build the treads of a door's steps: plain dark, the width of the door, outside the face at (fx, fz). */
function buildSteps(b: Builder, steps: readonly Step[], side: number, fx: number, fz: number, width: number): void {
  for (const st of steps) {
    const m = st.t + HOME.tread / 2;
    const x = side === 0 ? fx + m : side === 2 ? fx - m : fx;
    const z = side === 1 ? fz + m : side === 3 ? fz - m : fz;
    const sw = side % 2 === 0 ? HOME.tread : width, sd = side % 2 === 0 ? width : HOME.tread;
    b.comps.push({ prim: { kind: 'box', w: sw, h: st.top - st.base, d: sd }, x, y: st.base, z, tier: 2, role: 'stair', surface: 'hullDark', edges: 'none' });
    b.cols.push({ shape: 'box', x, y: (st.top + st.base) / 2, z, sx: sw, sy: st.top - st.base, sz: sd });
  }
}

/**
 * Give a solid structure an interior for its people: the largest box mass standing on the
 * ground, or on a low foundation, with nothing else inside it becomes a shell (same surface,
 * same place in the silhouette) with a door in each side that has a way out to the edge of the
 * lot (two at most, opposite if possible). Where the door is above the ground (the mass stands
 * on a slab), a flight of steps goes down from each ledge on the way out. Returns null,
 * changing nothing, when no mass qualifies. `w`, `d`: the lot (the local frame is centred on it).
 */
export function inhabit(b: Builder, w: number, d: number, rng: Rng): InteriorConfig | null {
  let best: { comp: number; col: number; doors: Array<{ e: Entrance; steps: Step[] }>; area: number } | null = null;
  for (let i = 0; i < b.comps.length; i++) {
    const c = b.comps[i];
    const p = c.prim;
    if (p.kind !== 'box' || p.taper !== undefined || c.ry || c.rx || c.rz || c.tier === 3 || c.interior) continue;
    if (c.surface === 'glow' || c.surface === 'translucent') continue;
    if (c.y > HOME.raised || c.y < -0.5 || p.w < HOME.side || p.d < HOME.side || p.h < HOME.height) continue;
    if (best && p.w * p.d <= best.area) continue;
    const col = b.cols.findIndex((k) => k.shape === 'box' && Math.abs(k.x - c.x) < 0.01 && Math.abs(k.z - c.z) < 0.01 && Math.abs(k.y - (c.y + p.h / 2)) < 0.01 && Math.abs(k.sx - p.w) < 0.01 && Math.abs(k.sz - p.d) < 0.01 && Math.abs(k.sy - p.h) < 0.01);
    if (col < 0) continue;
    const x0 = c.x - p.w / 2, x1 = c.x + p.w / 2, z0 = c.z - p.d / 2, z1 = c.z + p.d / 2;
    // Nothing else may stand in the room (things resting on its roof are fine).
    const yTop = c.y + p.h - HOME.roof;
    if (b.cols.some((k, j) => j !== col && overlap(k, x0 + 0.3, x1 - 0.3, c.y + 0.3, yTop - 0.3, z0 + 0.3, z1 - 0.3))) continue;
    const doors: Array<{ e: Entrance; steps: Step[] }> = [];
    const dh = Math.min(HOME.doorHeight, p.h - HOME.roof - 1);
    for (let side = 0; side < 4; side++) {
      const len = side % 2 === 0 ? p.d : p.w;
      const width = Math.min(HOME.door, Math.max(4, Math.round(len * 0.3)));
      const hw = width / 2 + 0.6;
      const steps = wayOut(b, col, side, side === 0 ? x1 : side === 2 ? x0 : c.x, side === 1 ? z1 : side === 3 ? z0 : c.z, c.y, dh, hw, w, d);
      if (steps) doors.push({ e: { side, offset: 0, width, height: dh }, steps });
    }
    if (doors.length) best = { comp: i, col, doors, area: p.w * p.d };
  }
  if (!best) return null;
  const c = b.comps[best.comp];
  const p = c.prim as { kind: 'box'; w: number; h: number; d: number };
  // Two doors at most: an opposite pair when there is one (a way through), else any.
  let doors = best.doors;
  if (doors.length > 2) {
    const pairs = [[0, 2], [1, 3]].filter(([a, e]) => doors.some((q) => q.e.side === a) && doors.some((q) => q.e.side === e));
    const pick = pairs.length ? pairs[rng.int(0, pairs.length - 1)] : [doors[0].e.side, doors[1].e.side];
    doors = doors.filter((q) => pick.includes(q.e.side));
  }
  const t = HOME.wall;
  const cfg: InteriorConfig = {
    accessible: true,
    x0: c.x - p.w / 2 + t, x1: c.x + p.w / 2 - t, z0: c.z - p.d / 2 + t, z1: c.z + p.d / 2 - t,
    y0: c.y, y1: c.y + p.h - HOME.roof, wall: t, entrances: doors.map((q) => q.e), program: 'commons',
  };
  b.comps.splice(best.comp, 1);
  b.cols.splice(best.col, 1);
  const from = b.comps.length;
  shellWalls(b, cfg, { surface: c.surface, pattern: c.pattern, mass: c.mass ?? 90, edges: c.edges === 'none' ? 'none' : c.edges === 'silhouette' ? 'silhouette' : 'top', light: c.light });
  // The shell stands where the mass stood: same tier and role, so the structure reads as before.
  for (let i = from; i < b.comps.length; i++) {
    const k = b.comps[i];
    if (k.role === 'wall' || k.role === 'roof') { k.tier = c.tier; k.role = c.role; }
  }
  for (const q of doors) buildSteps(b, q.steps, q.e.side, q.e.side === 0 ? c.x + p.w / 2 : q.e.side === 2 ? c.x - p.w / 2 : c.x, q.e.side === 1 ? c.z + p.d / 2 : q.e.side === 3 ? c.z - p.d / 2 : c.z, q.e.width);
  return cfg;
}

/**
 * The same for round masses: a solid drum (a prism of near-constant radius) standing on the
 * ground or a low foundation has its foot rebuilt as a ring wall with real gaps for doors, a
 * roof disc, and the rest of the drum carried on above. Doors face the four axes, where the way
 * out is clear. The room is round; it is furnished as a chamber.
 */
export function inhabitRound(b: Builder, w: number, d: number, rng: Rng): InteriorConfig | null {
  const T = HOME.wall + 0.5; // a drum's wall is a little thicker
  let best: { comp: number; cols: number[]; doors: Array<{ side: number; width: number; steps: Step[] }>; r: number; band: number } | null = null;
  for (let i = 0; i < b.comps.length; i++) {
    const c = b.comps[i];
    const p = c.prim;
    if (p.kind !== 'prism' || p.sides < 6 || c.rx || c.rz || c.tier === 3 || c.interior || c.surface === 'glow' || c.surface === 'translucent') continue;
    if (c.y > HOME.raised || c.y < -0.5 || p.h < HOME.height || Math.min(p.r0, p.r1) < 9 || Math.abs(p.r1 - p.r0) > 0.2 * p.r0) continue;
    // The foot of the drum: all of a low one, the first eight metres of a tall one.
    const band = p.h <= 10 ? p.h : 8;
    const r = Math.min(p.r0, p.r0 + ((p.r1 - p.r0) * band) / p.h);
    if (best && r <= best.r) continue;
    const cols: number[] = [];
    b.cols.forEach((k, j) => {
      if (k.shape !== 'box' && Math.abs(k.x - c.x) < 0.01 && Math.abs(k.z - c.z) < 0.01 && k.y - k.sy / 2 >= c.y - 0.01 && k.y + k.sy / 2 <= c.y + p.h + 0.01 && k.sx <= 2 * Math.max(p.r0, p.r1) + 0.6 && k.sx >= 2 * Math.min(p.r0, p.r1) - 0.6) cols.push(j);
    });
    if (!cols.length) continue;
    const skip = new Set(cols);
    const rin = r - T, q = rin * 0.72;
    if (b.cols.some((k, j) => !skip.has(j) && overlap(k, c.x - q, c.x + q, c.y + 0.3, c.y + band - HOME.roof - 0.3, c.z - q, c.z + q))) continue;
    const dh = Math.min(HOME.doorHeight, band - HOME.roof - 1);
    const width = Math.min(HOME.door, Math.max(4, Math.round(r * 0.35)));
    const doors: Array<{ side: number; width: number; steps: Step[] }> = [];
    for (let side = 0; side < 4; side++) {
      const steps = wayOut(b, skip, side, c.x + (side === 0 ? r : side === 2 ? -r : 0), c.z + (side === 1 ? r : side === 3 ? -r : 0), c.y, dh, width / 2 + 0.6, w, d);
      if (steps) doors.push({ side, width, steps });
    }
    if (doors.length) best = { comp: i, cols, doors, r, band };
  }
  if (!best) return null;
  const c = b.comps[best.comp];
  const p = c.prim as { kind: 'prism'; sides: number; r0: number; r1: number; h: number; phase?: number };
  let doors = best.doors;
  if (doors.length > 2) {
    const pairs = [[0, 2], [1, 3]].filter(([a, e]) => doors.some((q) => q.side === a) && doors.some((q) => q.side === e));
    const pick = pairs.length ? pairs[rng.int(0, pairs.length - 1)] : [doors[0].side, doors[1].side];
    doors = doors.filter((q) => pick.includes(q.side));
  }
  const { r, band } = best;
  const rin = r - T, wallH = band - HOME.roof, dh = Math.min(HOME.doorHeight, wallH - 1);
  const side = rin / Math.SQRT2 - 0.3;
  const cfg: InteriorConfig = {
    accessible: true,
    x0: c.x - side, x1: c.x + side, z0: c.z - side, z1: c.z + side, y0: c.y, y1: c.y + wallH, wall: T,
    entrances: doors.map((q) => ({ side: q.side, offset: 0, width: q.width, height: dh })),
    program: 'chamber', round: { cx: c.x, cz: c.z, r: rin },
  };
  const round = p.sides >= 10;
  b.comps.splice(best.comp, 1);
  for (const j of [...best.cols].sort((m, n) => n - m)) b.cols.splice(j, 1);
  const look = { surface: c.surface, pattern: c.pattern, light: c.light, mass: c.mass ?? 91 } as const;
  const from = b.comps.length;
  // The wall: arcs of ring between the doors (drawn; the colliders are laid by hand below so
  // the doorways are exactly open).
  const gap = (wd: number) => Math.asin(Math.min(0.9, (wd / 2 + 0.2) / r));
  const angles = doors.map((q) => ({ a: q.side * (Math.PI / 2), g: gap(q.width) })).sort((m, n) => m.a - n.a);
  for (let k = 0; k < angles.length; k++) {
    const cur = angles[k], next = angles[(k + 1) % angles.length];
    const start = cur.a + cur.g, end = (k + 1 < angles.length ? next.a : next.a + Math.PI * 2) - next.g;
    b.ring(c.tier, c.role, c.x, c.y, c.z, rin, r, wallH, Math.max(16, p.sides), { ...look, edges: c.edges === 'none' ? 'none' : 'base', arc: end - start, arcStart: start, solid: false });
  }
  for (const q of doors) {
    // Above each doorway the wall carries on over a lintel.
    const a = q.side * (Math.PI / 2), g = gap(q.width);
    if (wallH - dh > 0.5) b.ring(c.tier, c.role, c.x, c.y + dh, c.z, rin, r, wallH - dh, Math.max(16, p.sides), { ...look, edges: 'none', arc: 2 * g, arcStart: a - g, solid: false });
  }
  b.prism(c.tier, c.role, c.x, c.y + wallH, c.z, p.sides, r, r, HOME.roof, { ...look, edges: band >= p.h ? c.edges : 'none', phase: p.phase });
  if (p.h > band) {
    const rb = p.r0 + ((p.r1 - p.r0) * band) / p.h;
    b.prism(c.tier, c.role, c.x, c.y + band, c.z, p.sides, rb, p.r1, p.h - band, { ...look, edges: c.edges, phase: p.phase });
  }
  for (let i = from; i < b.comps.length; i++) if (c.glow !== undefined) b.comps[i].glow = c.glow;
  // Wall colliders: boxes round the ring, left out where they would reach into a doorway, and
  // a jamb box each side of every door to close the wall up to the opening.
  const rm = (rin + r) / 2, N = Math.min(48, Math.max(16, Math.ceil((2 * Math.PI * rm) / 9))), step = (Math.PI * 2) / N;
  const seg = 2 * rm * Math.tan(Math.PI / N) * 1.1 + 0.6;
  const rel = (a: number, to: number) => Math.abs((((a - to) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
  for (let k = 0; k < N; k++) {
    const a = (k + 0.5) * step;
    if (angles.some((q) => rel(a, q.a) < q.g + step / 2 + 0.01)) continue;
    const c2 = Math.abs(Math.cos(a)), s2 = Math.abs(Math.sin(a));
    b.cols.push({ shape: 'box', x: c.x + Math.cos(a) * rm, y: c.y + wallH / 2, z: c.z + Math.sin(a) * rm, sx: c2 * T + s2 * seg, sy: wallH, sz: s2 * T + c2 * seg });
  }
  for (const q of doors) {
    const a = q.side * (Math.PI / 2), g = gap(q.width);
    // The first box kept on each side of the door starts at this angle from it.
    let edge = Math.PI;
    for (let k = 0; k < N; k++) {
      const da = rel((k + 0.5) * step, a);
      if (da >= g + step / 2 + 0.01) edge = Math.min(edge, da - step / 2);
    }
    const lat0 = q.width / 2, lat1 = rm * Math.sin(Math.min(edge + step, Math.PI / 2)) + 0.6; // overlapping the first box kept
    const out: [number, number] = q.side === 0 ? [1, 0] : q.side === 1 ? [0, 1] : q.side === 2 ? [-1, 0] : [0, -1];
    if (lat1 - lat0 > 0.3) {
      const near = rin * Math.cos(Math.min(edge + step, Math.PI / 2)) - 0.6; // from here out to the face
      const depth = r - near, mid = (near + r) / 2;
      for (const sgn of [-1, 1]) {
        const lat = sgn * (lat0 + lat1) / 2;
        b.cols.push({
          shape: 'box', x: c.x + out[0] * mid - out[1] * lat, y: c.y + wallH / 2, z: c.z + out[1] * mid + out[0] * lat,
          sx: out[0] ? depth : lat1 - lat0, sy: wallH, sz: out[0] ? lat1 - lat0 : depth,
        });
      }
    }
    // The lintel, and the lit frame of the doorway (entrance light).
    if (wallH - dh > 0.5) b.cols.push({ shape: 'box', x: c.x + out[0] * rm, y: c.y + dh + (wallH - dh) / 2, z: c.z + out[1] * rm, sx: out[0] ? T : q.width, sy: wallH - dh, sz: out[0] ? q.width : T });
    const fx = c.x + out[0] * (r + 0.15), fz = c.z + out[1] * (r + 0.15);
    b.box(3, 'portal', fx, c.y + dh, fz, out[0] ? 0.3 : q.width, 0.6, out[0] ? q.width : 0.3, { surface: 'glow', light: 'entrance', glow: 1.2, solid: false });
    for (const sgn of [-1, 1]) b.box(3, 'portal', fx - out[1] * sgn * (q.width / 2), c.y, fz + out[0] * sgn * (q.width / 2), 0.5, dh, 0.5, { surface: 'glow', light: 'entrance', glow: 0.9, solid: false });
    buildSteps(b, q.steps, q.side, c.x + out[0] * r, c.z + out[1] * r, q.width);
  }
  void round;
  return cfg;
}

/**
 * The foot of any other solid mass, kept to its own outline: a tapered prism (radial cores,
 * tower cores), a square tapered box (the pyramid base of a spire) or a lathe (a trumpet's
 * flare, stepped radial tiers, a stepped tower base). The band from its base up to 5.5–10 m is
 * rebuilt as a shell that follows the outer surface exactly (closed-profile lathe arcs on the
 * mass's own polygon) with an inner wall straight up, real doorways on the axes where the way
 * out is clear, and the rest of the mass carried on above it (its underside the ceiling).
 * Where the wall is thick (a low pyramid) a doorway is a short tunnel through it.
 */
export function inhabitShell(b: Builder, w: number, d: number, rng: Rng, only?: number): InteriorConfig | null {
  interface Cand {
    comp: number; cols: number[]; n: number; phase: number; band: number; rin: number;
    /** Outer surface as (vertex radius, height) points from height y0 to y1 (relative to the base). */
    outer: (y0: number, y1: number) => Array<[number, number]>;
    upper: (wallH: number) => void;
    doors: Array<{ side: number; width: number; steps: Step[] }>;
  }
  const T = HOME.wall + 0.5;
  let best: Cand | null = null;
  for (let i = 0; i < b.comps.length; i++) {
    if (only !== undefined && i !== only) continue;
    const c = b.comps[i];
    const p = c.prim;
    if (c.rx || c.rz || c.tier === 3 || c.interior || c.surface === 'glow' || c.surface === 'translucent') continue;
    if (c.y > HOME.raised || c.y < -0.5) continue;
    const look = { surface: c.surface, pattern: c.pattern, light: c.light, mass: c.mass, glow: c.glow } as const;
    // The mass as a radius profile on a polygon.
    let n: number, phase: number, H: number, pts: Array<[number, number]>;
    let upper: (wallH: number) => void;
    if (p.kind === 'prism') {
      if (p.sides < 4) continue;
      n = p.sides; phase = p.phase ?? 0; H = p.h; pts = [[p.r0, 0], [p.r1, p.h]];
      upper = (wh) => { const r = p.r0 + ((p.r1 - p.r0) * wh) / p.h; b.prism(c.tier, c.role, c.x, c.y + wh, c.z, p.sides, r, p.r1, p.h - wh, { ...look, edges: c.edges, phase: p.phase }); };
    } else if (p.kind === 'box') {
      if (c.ry || Math.abs(p.w - p.d) > 0.5 || (p.taper ?? 1) >= 0.98) continue; // plain boxes are inhabit's
      const t = p.taper ?? 1, R = (p.w / 2) * Math.SQRT2;
      n = 4; phase = Math.PI / 4; H = p.h; pts = [[R, 0], [R * t, p.h]];
      upper = (wh) => { const k = 1 - ((1 - t) * wh) / p.h; b.box(c.tier, c.role, c.x, c.y + wh, c.z, p.w * k, p.h - wh, p.d * k, { ...look, edges: c.edges, taper: t / k }); };
    } else if (p.kind === 'lathe') {
      if (p.arc !== undefined || Math.abs(p.profile[0][1]) > 0.01 || p.profile[0][0] < 1) continue;
      let ok = true;
      for (let k = 1; k < p.profile.length; k++) if (p.profile[k][1] < p.profile[k - 1][1] - 1e-6) ok = false; // goes back down
      if (!ok) continue;
      n = p.sides; phase = p.phase ?? 0; pts = p.profile.map((q) => [q[0], q[1]]); H = pts[pts.length - 1][1];
      const prof = pts;
      upper = (wh) => {
        const out: Array<[number, number]> = [[0, 0], [radiusAt(prof, wh), 0]];
        for (const q of prof) if (q[1] > wh + 1e-6) out.push([q[0], q[1] - wh]);
        b.lathe(c.tier, c.role, c.x, c.y + wh, c.z, out, p.sides, { ...look, edges: c.edges, phase: p.phase });
      };
    } else continue;
    const band = H <= 10 ? H : 8;
    if (band < HOME.height) continue;
    const wallH = band - HOME.roof;
    const outer = (y0: number, y1: number) => clip(pts, y0, y1);
    // The narrowest the outer surface gets over the band, as an inscribed radius.
    const k = Math.cos(Math.PI / n);
    let minR = Infinity, maxR = 0;
    for (const q of outer(0, wallH)) { minR = Math.min(minR, q[0]); maxR = Math.max(maxR, q[0]); }
    const rin = minR * k - T;
    if (rin < 6 || (best && rin <= best.rin)) continue;
    // Its colliders: round (or, for a box, boxes) centred on it, within its height.
    const cols: number[] = [];
    b.cols.forEach((q, j) => {
      if (Math.abs(q.x - c.x) > 0.01 || Math.abs(q.z - c.z) > 0.01) return;
      if (q.y - q.sy / 2 < c.y - 0.01 || q.y + q.sy / 2 > c.y + H + 0.01) return;
      if ((p.kind === 'box') !== (q.shape === 'box')) return;
      if (q.sx > 2 * maxR + 1 + (p.kind === 'lathe' ? 2 * Math.max(...pts.map((v) => v[0])) : 0)) return;
      cols.push(j);
    });
    if (!cols.length) continue;
    const skip = new Set(cols);
    const q = rin * 0.72;
    if (b.cols.some((k2, j) => !skip.has(j) && overlap(k2, c.x - q, c.x + q, c.y + 0.3, c.y + wallH - 0.3, c.z - q, c.z + q))) continue;
    // Doors on the axes, where the way out to the lot edge is clear.
    const dh = Math.min(HOME.doorHeight, wallH - 1);
    const width = Math.min(HOME.door, Math.max(4, Math.round(rin * 0.35)));
    const doors: Array<{ side: number; width: number; steps: Step[] }> = [];
    for (let side = 0; side < 4; side++) {
      const a = side * (Math.PI / 2);
      const face = pts[0][0] * polyFactor(a, n, phase);
      const steps = wayOut(b, skip, side, c.x + Math.cos(a) * face, c.z + Math.sin(a) * face, c.y, dh, width / 2 + 0.6, w, d);
      if (steps) doors.push({ side, width, steps });
    }
    if (doors.length) best = { comp: i, cols, n, phase, band, rin, outer, upper, doors };
  }
  if (!best) return null;
  const c = b.comps[best.comp];
  const { n, phase, band, rin, outer, doors: found } = best;
  let doors = found;
  if (doors.length > 2) {
    const pairs = [[0, 2], [1, 3]].filter(([a, e]) => doors.some((q) => q.side === a) && doors.some((q) => q.side === e));
    const pick = pairs.length ? pairs[rng.int(0, pairs.length - 1)] : [doors[0].side, doors[1].side];
    doors = doors.filter((q) => pick.includes(q.side));
  }
  const wallH = band - HOME.roof, dh = Math.min(HOME.doorHeight, wallH - 1);
  const k = Math.cos(Math.PI / n);
  const rinV = rin / k; // the inner wall on the same polygon, by its vertex radius
  const out0 = outer(0, wallH);
  const thick = out0[0][0] * k - rin; // at the floor
  const square = n === 4;
  const cfg: InteriorConfig = {
    accessible: true,
    x0: c.x - (square ? rin : rin / Math.SQRT2 - 0.3), x1: c.x + (square ? rin : rin / Math.SQRT2 - 0.3),
    z0: c.z - (square ? rin : rin / Math.SQRT2 - 0.3), z1: c.z + (square ? rin : rin / Math.SQRT2 - 0.3),
    y0: c.y, y1: c.y + wallH, wall: thick,
    entrances: doors.map((q) => ({ side: q.side, offset: 0, width: q.width, height: dh })),
    program: square ? 'commons' : 'chamber', ...(square ? {} : { round: { cx: c.x, cz: c.z, r: rin } }),
  };
  b.comps.splice(best.comp, 1);
  for (const j of [...best.cols].sort((m, o) => o - m)) b.cols.splice(j, 1);
  const look = { surface: c.surface, pattern: c.pattern, light: c.light, mass: c.mass ?? 92, glow: c.glow, solid: false } as const;
  // A closed profile (outer surface up, inner wall down), relative to its own bottom.
  const shell = (y0: number, y1: number) => { const o = outer(y0, y1); return [...o, [rinV, y1 - y0], [rinV, 0], o[0]] as Array<[number, number]>; };
  // The wall between the doorways, and a lintel over each.
  const gap = (wd: number) => Math.asin(Math.min(0.9, (wd / 2 + 0.2) / rin));
  const angles = doors.map((q) => ({ a: q.side * (Math.PI / 2), g: gap(q.width) })).sort((m, o) => m.a - o.a);
  const wall = shell(0, wallH);
  for (let j = 0; j < angles.length; j++) {
    const cur = angles[j], next = angles[(j + 1) % angles.length];
    const start = cur.a + cur.g, end = (j + 1 < angles.length ? next.a : next.a + Math.PI * 2) - next.g;
    b.lathe(c.tier, c.role, c.x, c.y, c.z, wall, n, { ...look, edges: 'none', phase, arc: end - start, arcStart: start });
  }
  for (const q of angles) if (wallH - dh > 0.5) b.lathe(c.tier, c.role, c.x, c.y + dh, c.z, shell(dh, wallH), n, { ...look, edges: 'none', phase, arc: 2 * q.g, arcStart: q.a - q.g });
  best.upper(wallH);
  // Colliders: boxes round the wall (left out at the doorways), the doorway's two sides and its lintel.
  const N = Math.min(48, Math.max(16, Math.ceil((2 * Math.PI * (rin + 1)) / 9))), step = (Math.PI * 2) / N;
  const rOut = (y: number) => radiusAt(out0, y) * k; // inscribed outer radius at a height
  const rel = (a: number, to: number) => Math.abs((((a - to) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
  const layer = (y0: number, y1: number) => {
    const ro = rOut((y0 + y1) / 2), rm = (rin + ro) / 2, t = ro - rin + 0.8; // a little proud of both faces, so the corners close
    const seg = 2 * rm * Math.tan(Math.PI / N) * 1.1 + 0.6;
    for (let j = 0; j < N; j++) {
      const a = (j + 0.5) * step;
      if (angles.some((q) => rel(a, q.a) < q.g + step / 2 + 0.01)) continue;
      const c2 = Math.abs(Math.cos(a)), s2 = Math.abs(Math.sin(a));
      b.cols.push({ shape: 'box', x: c.x + Math.cos(a) * rm, y: c.y + (y0 + y1) / 2, z: c.z + Math.sin(a) * rm, sx: c2 * t + s2 * seg, sy: y1 - y0, sz: s2 * t + c2 * seg });
    }
  };
  // A square shell: its four walls as boxes, exactly, cut at the doorways.
  const sides = (y0: number, y1: number) => {
    const ro = rOut((y0 + y1) / 2);
    for (let sd = 0; sd < 4; sd++) {
      const door = doors.find((q) => q.side === sd);
      const ux = sd === 0 ? 1 : sd === 2 ? -1 : 0, uz = sd === 1 ? 1 : sd === 3 ? -1 : 0;
      const mid = (rin + ro) / 2, t = ro - rin;
      const runs: Array<[number, number]> = door ? [[-ro, -door.width / 2], [door.width / 2, ro]] : [[-ro, ro]];
      for (const [l0, l1] of runs) {
        const lat = (l0 + l1) / 2, len = l1 - l0;
        b.cols.push({ shape: 'box', x: c.x + ux * mid - uz * lat, y: c.y + (y0 + y1) / 2, z: c.z + uz * mid + ux * lat, sx: ux ? t : len, sy: y1 - y0, sz: ux ? len : t });
      }
    }
  };
  const lay = square ? sides : layer;
  // A sloped wall in two layers, so the collider follows it.
  if (rOut(0) - rOut(wallH) > 2) { lay(0, wallH / 2); lay(wallH / 2, wallH); } else lay(0, wallH);
  for (const q of doors) {
    const a = q.side * (Math.PI / 2), g = gap(q.width);
    const out: [number, number] = q.side === 0 ? [1, 0] : q.side === 1 ? [0, 1] : q.side === 2 ? [-1, 0] : [0, -1];
    let edge = Math.PI;
    for (let j = 0; j < N; j++) {
      const da = rel((j + 0.5) * step, a);
      if (da >= g + step / 2 + 0.01) edge = Math.min(edge, da - step / 2);
    }
    const ro = rOut(0) + 0.3;
    const lat0 = q.width / 2, lat1 = ro * Math.sin(Math.min(edge + step, Math.PI / 2)) + 0.6; // overlapping the first box kept
    if (!square && lat1 - lat0 > 0.3) {
      const near = rin * Math.cos(Math.min(edge + step, Math.PI / 2)) - 0.6;
      const depth = ro - near, mid = (near + ro) / 2;
      for (const sgn of [-1, 1]) {
        const lat = (sgn * (lat0 + lat1)) / 2;
        b.cols.push({ shape: 'box', x: c.x + out[0] * mid - out[1] * lat, y: c.y + wallH / 2, z: c.z + out[1] * mid + out[0] * lat, sx: out[0] ? depth : lat1 - lat0, sy: wallH, sz: out[0] ? lat1 - lat0 : depth });
      }
    }
    if (wallH - dh > 0.5) {
      const mid = (rin + rOut(dh)) / 2, t = rOut(dh) - rin;
      b.cols.push({ shape: 'box', x: c.x + out[0] * mid, y: c.y + dh + (wallH - dh) / 2, z: c.z + out[1] * mid, sx: out[0] ? t : q.width, sy: wallH - dh, sz: out[0] ? q.width : t });
    }
    // The lit frame at the mouth of the doorway, and steps down from it if it is raised.
    const mouth = rOut(dh) + 0.15, face = rOut(0);
    const fx = c.x + out[0] * mouth, fz = c.z + out[1] * mouth;
    b.box(3, 'portal', fx, c.y + dh, fz, out[0] ? 0.3 : q.width, 0.6, out[0] ? q.width : 0.3, { surface: 'glow', light: 'entrance', glow: 1.2, solid: false });
    for (const sgn of [-1, 1]) b.box(3, 'portal', fx - out[1] * sgn * (q.width / 2), c.y, fz + out[0] * sgn * (q.width / 2), 0.5, dh, 0.5, { surface: 'glow', light: 'entrance', glow: 0.9, solid: false });
    buildSteps(b, q.steps, q.side, c.x + out[0] * face, c.z + out[1] * face, q.width);
  }
  return cfg;
}

/**
 * An entrance hall, for a structure none of the other passes could open: a low secondary
 * volume set against its foot in its family's language (a round drum for the radial family, a
 * battered square block for towers), placed on whichever side has room in the lot, then
 * hollowed like any other mass. Returns null, changing nothing, when no side has room.
 */
export function addHall(b: Builder, w: number, d: number, round: boolean, rng: Rng): InteriorConfig | null {
  const h = 7.5;
  // Clear ground for a hall of half-size m at (x, z), inside the lot.
  const clear = (x: number, z: number, m: number) => Math.abs(x) + m <= w / 2 - 1 && Math.abs(z) + m <= d / 2 - 1 && !b.cols.some((c) => overlap(c, x - m, x + m, 0.3, h, z - m, z + m));
  // How close the structure comes to (x, z) at its foot: the hall must stand against it.
  const gapTo = (x: number, z: number) => {
    let g = Infinity;
    for (const c of b.cols) {
      if (c.y - c.sy / 2 > 3) continue;
      const dx = Math.max(Math.abs(x - c.x) - c.sx / 2, 0), dz = Math.max(Math.abs(z - c.z) - c.sz / 2, 0);
      g = Math.min(g, Math.hypot(dx, dz));
    }
    return g;
  };
  const tryAt = (x: number, z: number, r: number): InteriorConfig | null => {
    const comps = b.comps.length, cols = b.cols.length;
    const look = { surface: 'hullDark' as const, pattern: 'panels' as const, edges: 'top' as const, light: b.accent, glow: 0.7 };
    if (round) b.prism(2, 'hall', x, 0, z, 16, r, r * 0.97, h, look);
    else b.box(2, 'hall', x, 0, z, 2 * r, h, 2 * r, { ...look, taper: 0.9 });
    const cfg = inhabitShell(b, w, d, rng, comps); // the hall, and nothing else
    if (cfg) return cfg;
    // The hall could not be opened here: take it away again.
    b.comps.length = comps;
    b.cols.length = cols;
    return null;
  };
  // First against the foot of the structure along the axes and diagonals...
  const reach = (ux: number, uz: number) => {
    let m = 0;
    for (const c of b.cols) if (c.y - c.sy / 2 <= 3) m = Math.max(m, (c.x + (Math.sign(ux) * c.sx) / 2) * ux + (c.z + (Math.sign(uz) * c.sz) / 2) * uz);
    return m;
  };
  const dirs: Array<[number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1], [Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2]];
  const first = rng.int(0, 3);
  for (const r of [10, 8]) for (let k = 0; k < dirs.length; k++) {
    const [ux, uz] = dirs[(k + first) % dirs.length];
    const dist = reach(ux, uz) + r - 1;
    const x = ux * dist, z = uz * dist;
    if (!clear(x, z, r - 1.2)) continue;
    const cfg = tryAt(x, z, r);
    if (cfg) return cfg;
  }
  // ...then anywhere clear in the lot that stands against it (between its parts).
  const r = 8;
  const spots: Array<[number, number, number]> = [];
  for (let x = -w / 2 + r + 1; x <= w / 2 - r - 1; x += 3) for (let z = -d / 2 + r + 1; z <= d / 2 - r - 1; z += 3) {
    if (!clear(x, z, r - 0.2) || gapTo(x, z) > r + 0.5) continue;
    spots.push([x, z, Math.hypot(x, z)]);
  }
  spots.sort((p, q) => p[2] - q[2]);
  for (const [x, z] of spots.slice(0, 8)) {
    const cfg = tryAt(x, z, r);
    if (cfg) return cfg;
  }
  return null;
}

/** Radius factor of a polygon of n sides (vertices at phase + k·2π/n) at angle a: 1 at a vertex. */
function polyFactor(a: number, n: number, phase: number): number {
  const step = (Math.PI * 2) / n;
  const t = ((((a - phase) % step) + step) % step) - step / 2;
  return Math.cos(step / 2) / Math.cos(t);
}

/** Radius of a (radius, height) profile at a height (the last point at or below it, interpolated). */
function radiusAt(prof: ReadonlyArray<readonly [number, number]>, y: number): number {
  for (let k = prof.length - 1; k > 0; k--) {
    const [ra, ya] = prof[k - 1], [rb, yb] = prof[k];
    if (y >= ya - 1e-9 && y <= yb + 1e-9) return yb - ya < 1e-9 ? rb : ra + ((rb - ra) * (y - ya)) / (yb - ya);
  }
  return y <= prof[0][1] ? prof[0][0] : prof[prof.length - 1][0];
}

/** The part of a rising profile between two heights, shifted so y0 is 0. */
function clip(prof: ReadonlyArray<readonly [number, number]>, y0: number, y1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [[radiusAt(prof, y0), y0]];
  for (const q of prof) if (q[1] > y0 + 1e-6 && q[1] < y1 - 1e-6) out.push([q[0], q[1]]);
  out.push([radiusAt(prof, y1), y1]);
  return out.map(([r, y]) => [r, y - y0]);
}

/** A door of a room, in world space. */
export interface RoomDoor {
  /** Centre of the opening on the wall line, and the way out (unit, axis-aligned). */
  x: number;
  z: number;
  nx: number;
  nz: number;
  width: number;
  /** Height of the opening (m). */
  height: number;
  /** How far in from the door the aisle runs clear (m). */
  depth: number;
  /** From the door to the room's inner face (m): half the wall, the length of a doorway's tunnel inside. */
  inset: number;
  /** Height of the threshold over the ground outside (m): there are steps down when it is not 0. */
  rise: number;
  /**
   * The floor on the way out, as heights over the ground every half metre from the wall
   * (ledges and steps), ending where it reaches the ground. Empty when the door is at ground level.
   */
  floor: number[];
}

/** An interior as the people use it: world-space floor, doors and aisles. */
export interface Room {
  id: string;
  program: InteriorConfig['program'];
  /** A round room: its centre and inner radius (world, m). */
  round?: { x: number; z: number; r: number };
  /** Floor height and the room's rectangle (world, m). */
  y: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  doors: RoomDoor[];
}

/**
 * The room of a structure, for whoever lives there: each door with the depth of the clear
 * aisle behind it (measured against the structure's own colliders, so nobody stands in the
 * machinery). Null when the structure has no accessible interior or no usable door.
 */
export function structureRoom(s: StructureSpec): Room | null {
  const I = s.interior;
  if (!I || !I.accessible) return null;
  const cx = (I.x0 + I.x1) / 2, cz = (I.z0 + I.z1) / 2;
  const W = (lx: number, lz: number): [number, number] => { const [x, z] = rotQ(lx, lz, s.rotation); return [s.x + x, s.z + z]; };
  // A round room is known to the people by the square round its floor.
  const R = I.round;
  const [ax, az] = R ? W(R.cx - R.r, R.cz - R.r) : W(I.x0, I.z0), [bx, bz] = R ? W(R.cx + R.r, R.cz + R.r) : W(I.x1, I.z1);
  const room: Room = { id: s.id, program: I.program, y: s.y + I.y0, x0: Math.min(ax, bx), x1: Math.max(ax, bx), z0: Math.min(az, bz), z1: Math.max(az, bz), doors: [] };
  if (R) { const [rx, rz] = W(R.cx, R.cz); room.round = { x: rx, z: rz, r: R.r }; }
  for (const e of I.entrances) {
    const out: [number, number] = e.side === 0 ? [1, 0] : e.side === 1 ? [0, 1] : e.side === 2 ? [-1, 0] : [0, -1];
    const reach = R ? R.r + I.wall / 2 : 0; // a drum's door is on its wall, not on the square inside it
    const lx = e.side === 0 ? (R ? R.cx + reach : I.x1 + I.wall / 2) : e.side === 2 ? (R ? R.cx - reach : I.x0 - I.wall / 2) : cx + e.offset;
    const lz = e.side === 1 ? (R ? R.cz + reach : I.z1 + I.wall / 2) : e.side === 3 ? (R ? R.cz - reach : I.z0 - I.wall / 2) : cz + e.offset;
    const [x, z] = W(lx, lz);
    const [nx, nz] = rotQ(out[0], out[1], s.rotation);
    // March in from the door until something stands in the way (or the far wall).
    const span = (Math.abs(nx) > 0.5 ? room.x1 - room.x0 : room.z1 - room.z0) + I.wall / 2;
    const half = Math.max(0.8, e.width / 2 - 1);
    let depth = 0;
    for (let t = 1; t <= span - 1.5; t += 0.5) {
      const px = x - nx * t, pz = z - nz * t;
      const x0 = px - (Math.abs(nz) > 0.5 ? half : 0.6), x1 = px + (Math.abs(nz) > 0.5 ? half : 0.6);
      const z0 = pz - (Math.abs(nx) > 0.5 ? half : 0.6), z1 = pz + (Math.abs(nx) > 0.5 ? half : 0.6);
      if (s.colliders.some((c) => overlap(c, x0, x1, room.y + 0.4, room.y + 2.4, z0, z1))) break;
      depth = t;
    }
    if (depth < I.wall / 2 + 3) continue;
    // The way out: what is underfoot, from the wall to the ground.
    const floor: number[] = [];
    if (I.y0 > 0.3) {
      const ax = Math.abs(nx) > 0.5;
      for (let t = 0; t < 120; t += 0.5) {
        const px = x + nx * (t + I.wall / 2), pz = z + nz * (t + I.wall / 2);
        let f = 0;
        for (const c of s.colliders) {
          const top = c.y + c.sy / 2;
          if (top <= room.y + 0.3 && top > s.y + f && overlap(c, px - (ax ? 0.5 : half), px + (ax ? 0.5 : half), s.y - 1, room.y + 0.3, pz - (ax ? half : 0.5), pz + (ax ? half : 0.5))) f = top - s.y;
        }
        floor.push(f);
        if (f < 0.05 && floor.length > 6 && floor.slice(-6).every((v) => v < 0.05)) break;
      }
    }
    room.doors.push({ x, z, nx: nx + 0, nz: nz + 0, width: e.width, height: e.height, depth, inset: I.wall / 2, rise: Math.max(0, I.y0), floor });
  }
  return room.doors.length ? room : null;
}
