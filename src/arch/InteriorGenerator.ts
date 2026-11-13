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
  else if (cfg.program === 'chamber') chamber(b, cfg, light, W, D, H, cx, cz);
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
  // A lit seam along the ceiling over the main aisle.
  const [lx, lz] = P(0, 0);
  b.box(3, 'ceiling', lx, y0 + H - 0.25, lz, alongX ? W * 0.8 : 0.3, 0.15, alongX ? 0.3 : D * 0.8, { surface: 'glow', light: 'energy', glow: 0.5, solid: false, ...I });
}

const overlap = (c: ColliderPiece, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
  c.x + c.sx / 2 > x0 && c.x - c.sx / 2 < x1 && c.y + c.sy / 2 > y0 && c.y - c.sy / 2 < y1 && c.z + c.sz / 2 > z0 && c.z - c.sz / 2 < z1;

/** Smallest box mass worth living in (m), the people's door (m), and the steps up to a raised one. */
const HOME = { side: 14, height: 7, wall: 1, roof: 1.5, door: 8, doorHeight: 6, raised: 6.5, riser: 0.5, tread: 0.8 } as const;

interface Step { t: number; top: number; base: number }

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
    const dh = Math.min(HOME.doorHeight, p.h - HOME.roof - 1.5);
    for (let side = 0; side < 4; side++) {
      const len = side % 2 === 0 ? p.d : p.w;
      const width = Math.min(HOME.door, Math.max(4, Math.round(len * 0.3)));
      const hw = width / 2 + 0.6;
      // The way out: a strip as wide as the door, from the wall (t = 0) to the edge of the lot.
      const reach = Math.max(2, side === 0 ? w / 2 - x1 : side === 2 ? x0 + w / 2 : side === 1 ? d / 2 - z1 : z0 + d / 2);
      const strip = (ta: number, tb: number): [number, number, number, number] =>
        side === 0 ? [x1 + ta, x1 + tb, c.z - hw, c.z + hw] : side === 2 ? [x0 - tb, x0 - ta, c.z - hw, c.z + hw]
        : side === 1 ? [c.x - hw, c.x + hw, z1 + ta, z1 + tb] : [c.x - hw, c.x + hw, z0 - tb, z0 - ta];
      const [sx0, sx1, sz0, sz1] = strip(0, reach);
      // Anything rising above the threshold in the strip blocks the door.
      if (b.cols.some((k, j) => j !== col && k.y + k.sy / 2 > c.y + 0.3 && overlap(k, sx0, sx1, 0.3, c.y + dh, sz0, sz1))) continue;
      // What is left in the strip is floor: ledges below the threshold. Step down off each.
      const floor = (ta: number, tb: number): number => {
        const [fx0, fx1, fz0, fz1] = strip(ta, tb);
        let f = 0;
        for (let j = 0; j < b.cols.length; j++) {
          const k = b.cols[j];
          if (j !== col && overlap(k, fx0, fx1, -1, c.y + 0.3, fz0, fz1)) f = Math.max(f, k.y + k.sy / 2);
        }
        return f;
      };
      const steps: Step[] = [];
      let level = c.y, t = 0, ok = true;
      while (t < reach && ok) {
        const f = floor(t, t + 0.5);
        if (f > level + 0.3) ok = false; // a ledge higher than where we stand
        else if (f >= level - HOME.riser) { level = Math.min(level, Math.max(f, 0)); t += 0.5; }
        else {
          // A drop: a flight from `level` down to `f`, treads going outward from here.
          const n = Math.ceil((level - f) / HOME.riser), riser = (level - f) / n;
          const run = (n - 1) * HOME.tread;
          if (t + run > reach + 1.5 || floor(t, t + run + 0.5) > f + 0.3) ok = false;
          for (let k = 1; k < n && ok; k++) steps.push({ t: t + (k - 1) * HOME.tread, top: level - k * riser, base: f });
          level = f;
          t += Math.max(0.5, run);
        }
      }
      if (ok && level <= HOME.riser && steps.length <= 40) doors.push({ e: { side, offset: 0, width, height: dh }, steps });
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
  // The steps: plain dark treads the width of the door, outside it.
  for (const q of doors) for (const st of q.steps) {
    const m = st.t + HOME.tread / 2, e = q.e;
    const x = e.side === 0 ? c.x + p.w / 2 + m : e.side === 2 ? c.x - p.w / 2 - m : c.x;
    const z = e.side === 1 ? c.z + p.d / 2 + m : e.side === 3 ? c.z - p.d / 2 - m : c.z;
    const sw = e.side % 2 === 0 ? HOME.tread : e.width, sd = e.side % 2 === 0 ? e.width : HOME.tread;
    b.comps.push({ prim: { kind: 'box', w: sw, h: st.top - st.base, d: sd }, x, y: st.base, z, tier: 2, role: 'stair', surface: 'hullDark', edges: 'none' });
    b.cols.push({ shape: 'box', x, y: (st.top + st.base) / 2, z, sx: sw, sy: st.top - st.base, sz: sd });
  }
  return cfg;
}

/** A door of a room, in world space. */
export interface RoomDoor {
  /** Centre of the opening on the wall line, and the way out (unit, axis-aligned). */
  x: number;
  z: number;
  nx: number;
  nz: number;
  width: number;
  /** How far in from the door the aisle runs clear (m). */
  depth: number;
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
  const [ax, az] = W(I.x0, I.z0), [bx, bz] = W(I.x1, I.z1);
  const room: Room = { id: s.id, program: I.program, y: s.y + I.y0, x0: Math.min(ax, bx), x1: Math.max(ax, bx), z0: Math.min(az, bz), z1: Math.max(az, bz), doors: [] };
  for (const e of I.entrances) {
    const out: [number, number] = e.side === 0 ? [1, 0] : e.side === 1 ? [0, 1] : e.side === 2 ? [-1, 0] : [0, -1];
    const lx = e.side === 0 ? I.x1 + I.wall / 2 : e.side === 2 ? I.x0 - I.wall / 2 : cx + e.offset;
    const lz = e.side === 1 ? I.z1 + I.wall / 2 : e.side === 3 ? I.z0 - I.wall / 2 : cz + e.offset;
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
    if (depth < 3) continue;
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
    room.doors.push({ x, z, nx: nx + 0, nz: nz + 0, width: e.width, depth, rise: Math.max(0, I.y0), floor });
  }
  return room.doors.length ? room : null;
}
