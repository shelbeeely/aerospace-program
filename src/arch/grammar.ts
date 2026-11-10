import type { LightRole, Pattern, Surface } from './palette.ts';
import { Rng } from './rng.ts';
import type { ColliderPiece, Component, ConnectionPoint, EdgeMode, Primitive, Tier } from './types.ts';

/**
 * The procedural geometric grammar. Generators speak in masses, platforms, columns, seams and
 * channels; the Builder turns each into a Component (for the renderer) and, for solid tiers, a
 * matching axis-aligned collider (for physics). Tertiary detail never gets a collider.
 *
 * Rules the builder enforces so every family stays in the same language:
 * - every dimension is snapped to a 0.5 m module (engineered, not organic);
 * - tier 3 detail is thin (it may not change the silhouette);
 * - lit edges are opt-in per component (selective illumination).
 */
export interface Opts {
  surface?: Surface;
  edges?: EdgeMode;
  light?: LightRole;
  glow?: number;
  ry?: number;
  rx?: number;
  rz?: number;
  /** Collider (default: tiers 1 and 2). */
  solid?: boolean;
  interior?: boolean;
  /** box only: top scale (1 prism, 0 pyramid). */
  taper?: number;
  /** Primary mass id: tier-1 components with the same id read as one dominant mass. */
  mass?: number;
  pattern?: Pattern;
}

const M = 0.5;
const q = (v: number) => Math.max(M, Math.round(v / M) * M);

export class Builder {
  readonly comps: Component[] = [];
  /** Local-space colliders (the generator's frame, before the structure rotation). */
  readonly cols: ColliderPiece[] = [];
  readonly connections: ConnectionPoint[] = [];

  constructor(readonly rng: Rng, readonly primary: Surface = 'hull', readonly accent: LightRole = 'structure') {}

  private push(prim: Primitive, tier: Tier, role: string, x: number, y: number, z: number, o: Opts): Component {
    const c: Component = {
      prim, x, y, z, tier, role,
      surface: o.surface ?? (tier === 1 ? this.primary : tier === 2 ? 'hullDark' : 'metal'),
      edges: o.edges ?? 'none',
    };
    if (o.light) c.light = o.light;
    else if (c.edges !== 'none' || c.surface === 'glow' || c.surface === 'translucent') c.light = this.accent;
    if (o.glow !== undefined) c.glow = o.glow;
    if (o.ry) c.ry = o.ry;
    if (o.rx) c.rx = o.rx;
    if (o.rz) c.rz = o.rz;
    if (o.interior) c.interior = true;
    if (o.mass !== undefined) c.mass = o.mass;
    if (o.pattern) c.pattern = o.pattern;
    this.comps.push(c);
    return c;
  }

  private solid(tier: Tier, o: Opts): boolean {
    return o.solid ?? (tier !== 3 && o.surface !== 'translucent' && o.surface !== 'glow');
  }

  /** Is ry a whole number of quarter turns (so an axis-aligned collider fits)? */
  private static quarter(ry = 0): number | null {
    const k = ry / (Math.PI / 2);
    const r = Math.round(k);
    return Math.abs(k - r) < 1e-6 ? ((r % 4) + 4) % 4 : null;
  }

  /** Rectangular prism (or tapered frustum / pyramid) standing on (x, y, z). */
  box(tier: Tier, role: string, x: number, y: number, z: number, w: number, h: number, d: number, o: Opts = {}): Component {
    const thin = tier === 3;
    const prim: Primitive = { kind: 'box', w: thin ? w : q(w), h: thin ? h : q(h), d: thin ? d : q(d) };
    if (o.taper !== undefined && o.taper !== 1) prim.taper = o.taper;
    const c = this.push(prim, tier, role, x, y, z, o);
    const qt = Builder.quarter(o.ry);
    if (this.solid(tier, o) && qt !== null && !o.rx && !o.rz) {
      const [sx, sz] = qt % 2 ? [prim.d, prim.w] : [prim.w, prim.d];
      const t = prim.taper ?? 1;
      if (t >= 0.85) this.cols.push({ shape: 'box', x, y: y + prim.h / 2, z, sx, sy: prim.h, sz });
      else {
        // A strongly tapered box: stack two boxes (base half, upper half) so the slope is felt.
        const mid = 1 - (1 - t) * 0.5;
        this.cols.push({ shape: 'box', x, y: y + prim.h / 4, z, sx: sx * (1 + mid) / 2, sy: prim.h / 2, sz: sz * (1 + mid) / 2 });
        this.cols.push({ shape: 'box', x, y: y + (prim.h * 3) / 4, z, sx: sx * (mid + t) / 2, sy: prim.h / 2, sz: sz * (mid + t) / 2 });
      }
    }
    return c;
  }

  /** n-sided prism, cylinder, cone, truncated cone or flared column. */
  prism(tier: Tier, role: string, x: number, y: number, z: number, sides: number, r0: number, r1: number, h: number, o: Opts & { phase?: number } = {}): Component {
    const prim: Primitive = { kind: 'prism', sides, r0: tier === 3 ? r0 : q(r0), r1: tier === 3 ? r1 : Math.max(0, Math.round(r1 / M) * M), h: tier === 3 ? h : q(h) };
    if (o.phase) prim.phase = o.phase;
    const c = this.push(prim, tier, role, x, y, z, o);
    if (this.solid(tier, o) && !o.rx && !o.rz) this.roundCollider(x, y, z, prim.r0, prim.r1, prim.h, sides);
    return c;
  }

  private roundCollider(x: number, y: number, z: number, r0: number, r1: number, h: number, sides: number): void {
    if (h <= 0 || Math.max(r0, r1) <= 0) return;
    const shape: ColliderPiece['shape'] = sides >= 10 ? 'cyl' : 'oct';
    if (Math.abs(r0 - r1) < 0.05 * Math.max(r0, r1)) {
      this.cols.push({ shape, x, y: y + h / 2, z, sx: 2 * r0, sy: h, sz: 2 * r0 });
    } else if (r1 < r0) {
      this.cols.push({ shape: 'cone', x, y: y + h / 2, z, sx: 2 * r0, sy: h, sz: 2 * r0, taper: Math.max(0.05, r1 / r0) });
    } else {
      // Flares outward going up: two drums (the cone collider only tapers inward).
      this.cols.push({ shape, x, y: y + h / 4, z, sx: r0 + (r0 + r1) / 2, sy: h / 2, sz: r0 + (r0 + r1) / 2 });
      this.cols.push({ shape, x, y: y + (3 * h) / 4, z, sx: (r0 + r1) / 2 + r1, sy: h / 2, sz: (r0 + r1) / 2 + r1 });
    }
  }

  /** Revolved (radius, height) profile: trumpet bases, stepped radial platforms, domes. */
  lathe(tier: Tier, role: string, x: number, y: number, z: number, profile: Array<[number, number]>, sides: number, o: Opts = {}): Component {
    const c = this.push({ kind: 'lathe', profile, sides }, tier, role, x, y, z, o);
    if (this.solid(tier, o)) {
      for (let i = 0; i + 1 < profile.length; i++) {
        const [ra, ya] = profile[i];
        const [rb, yb] = profile[i + 1];
        if (yb - ya < 0.25) continue;
        this.roundCollider(x, y + ya, z, ra, rb, yb - ya, sides);
      }
    }
    return c;
  }

  /** Annulus (or arc section) of inner r0 / outer r1. Solid rings get box colliders around. */
  ring(tier: Tier, role: string, x: number, y: number, z: number, r0: number, r1: number, h: number, sides: number, o: Opts & { arc?: number; arcStart?: number } = {}): Component {
    const prim: Primitive = { kind: 'ring', r0, r1, h, sides };
    if (o.arc !== undefined) prim.arc = o.arc;
    if (o.arcStart !== undefined) prim.arcStart = o.arcStart;
    const c = this.push(prim, tier, role, x, y, z, o);
    if (this.solid(tier, o) && !o.rx && !o.rz) {
      // Boxes approximating the ring (or the arc's share of it): enough for craft not to slip through.
      const rm = (r0 + r1) / 2, t = r1 - r0;
      const n = 16;
      const seg = 2 * rm * Math.tan(Math.PI / n);
      const a0 = o.arcStart ?? 0, span = o.arc ?? Math.PI * 2;
      for (let k = 0; k < n; k++) {
        const a = ((k + 0.5) / n) * Math.PI * 2;
        const rel = (((a - a0) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        if (span < Math.PI * 2 - 1e-6 && rel > span) continue;
        const cx = x + Math.cos(a) * rm, cz = z + Math.sin(a) * rm;
        const c2 = Math.abs(Math.cos(a)), s2 = Math.abs(Math.sin(a));
        // Axis-aligned box covering the segment's chord and thickness.
        const sx = c2 * t + s2 * seg, sz = s2 * t + c2 * seg;
        this.cols.push({ shape: 'box', x: cx, y: y + h / 2, z: cz, sx, sy: h, sz });
      }
    }
    return c;
  }

  torus(tier: Tier, role: string, x: number, y: number, z: number, R: number, r: number, o: Opts = {}): Component {
    return this.push({ kind: 'torus', R, r, sides: Math.max(24, Math.round(R / 2)), tube: 6 }, tier, role, x, y, z, { solid: false, ...o });
  }

  /** Custom polygon outline extruded up; collider: its bounding box when the outline is nearly rectangular. */
  extrude(tier: Tier, role: string, x: number, y: number, z: number, outline: Array<[number, number]>, h: number, o: Opts & { taper?: number } = {}): Component {
    const prim: Primitive = { kind: 'extrude', outline, h };
    if (o.taper !== undefined) prim.taper = o.taper;
    const c = this.push(prim, tier, role, x, y, z, o);
    if (this.solid(tier, o) && Builder.quarter(o.ry) !== null) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, area = 0;
      for (let i = 0; i < outline.length; i++) {
        const [ax, az] = outline[i], [bx, bz] = outline[(i + 1) % outline.length];
        x0 = Math.min(x0, ax); x1 = Math.max(x1, ax); z0 = Math.min(z0, az); z1 = Math.max(z1, az);
        area += ax * bz - bx * az;
      }
      const fill = Math.abs(area / 2) / ((x1 - x0) * (z1 - z0));
      const s = Math.sqrt(Math.min(1, fill));
      const qt = Builder.quarter(o.ry)!;
      const [sx, sz] = qt % 2 ? [(z1 - z0) * s, (x1 - x0) * s] : [(x1 - x0) * s, (z1 - z0) * s];
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const [rx, rz] = rotQ(cx, cz, qt);
      this.cols.push({ shape: 'box', x: x + rx, y: y + h / 2, z: z + rz, sx, sy: h, sz });
    }
    return c;
  }

  /** Cross-section swept along a path (bridges, sweeping ramps, conduits). Colliders: a box per straight run. */
  sweep(tier: Tier, role: string, section: Array<[number, number]>, path: Array<[number, number, number] | [number, number, number, number]>, o: Opts = {}): Component {
    const c = this.push({ kind: 'sweep', section, path }, tier, role, 0, 0, 0, o);
    if (this.solid(tier, o)) {
      let w = 0, y0 = Infinity, y1 = -Infinity;
      for (const [sx, sy] of section) { w = Math.max(w, Math.abs(sx) * 2); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy); }
      for (let i = 0; i + 1 < path.length; i++) {
        const [ax, ay, az] = path[i], [bx, by, bz] = path[i + 1];
        const alongX = Math.abs(bx - ax) >= Math.abs(bz - az);
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        const ym = (ay + by) / 2;
        const rise = Math.abs(by - ay);
        this.cols.push({
          shape: 'box', x: (ax + bx) / 2, y: ym + (y0 + y1) / 2, z: (az + bz) / 2,
          sx: alongX ? len : w, sy: y1 - y0 + rise, sz: alongX ? w : len,
        });
      }
    }
    return c;
  }

  // --- Higher-level grammar (secondary and tertiary vocabulary) ---

  /** Horizontal seam bands around a rectangular mass (tertiary: four thin strips per band, lit or dark). */
  seams(cx: number, cz: number, w: number, d: number, y0: number, y1: number, every: number, o: { light?: LightRole; lit?: boolean; glow?: number } = {}): void {
    if (every <= 0) return;
    const t = 0.35;
    // Unlit seams are dark recessed strips (no light): only a lit seam glows, and sparingly.
    const opts: Opts = { surface: o.lit ? 'glow' : 'hullDark', edges: 'none', light: o.light, glow: o.glow ?? 0.55, solid: false };
    for (let y = y0 + every; y < y1 - every * 0.4; y += every) {
      this.box(3, 'seam', cx, y, cz + d / 2 + t / 2, w + 2 * t, 0.4, t, opts);
      this.box(3, 'seam', cx, y, cz - d / 2 - t / 2, w + 2 * t, 0.4, t, opts);
      this.box(3, 'seam', cx + w / 2 + t / 2, y, cz, t, 0.4, d, opts);
      this.box(3, 'seam', cx - w / 2 - t / 2, y, cz, t, 0.4, d, opts);
    }
  }

  /** A lit channel strip on a surface at height y, from (x0, z0) to (x1, z1), axis-aligned. */
  channel(x0: number, z0: number, x1: number, z1: number, y: number, width: number, light: LightRole = 'data', glow = 1): void {
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
    const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    if (len < 0.5) return;
    this.box(3, 'channel', (x0 + x1) / 2, y, (z0 + z1) / 2, alongX ? len : width, 0.15, alongX ? width : len, { surface: 'glow', light, glow, solid: false });
  }

  /** Rows of small pins along the base of a block (like the legs of an integrated circuit). */
  pins(cx: number, cz: number, w: number, d: number, y: number, pitch: number, size: number, alongX: boolean): void {
    const len = alongX ? w : d;
    const n = Math.floor(len / pitch);
    if (n < 2) return;
    const start = -((n - 1) * pitch) / 2;
    for (let i = 0; i < n; i++) {
      const o = start + i * pitch;
      for (const s of [-1, 1]) {
        const px = alongX ? cx + o : cx + s * (w / 2 + size / 2);
        const pz = alongX ? cz + s * (d / 2 + size / 2) : cz + o;
        this.box(3, 'pin', px, y, pz, alongX ? size * 0.6 : size, size * 0.8, alongX ? size : size * 0.6, { surface: 'metal', solid: false });
      }
    }
  }

  /** Columns on a regular grid under a slab (secondary), returns how many. */
  columnGrid(cx: number, cz: number, w: number, d: number, y: number, h: number, pitch: number, r: number, o: Opts = {}): number {
    const nx = Math.max(1, Math.floor(w / pitch)), nz = Math.max(1, Math.floor(d / pitch));
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const px = cx - w / 2 + (i + 0.5) * (w / nx), pz = cz - d / 2 + (j + 0.5) * (d / nz);
      this.box(2, 'column', px, y, pz, r * 2, h, r * 2, o);
    }
    return nx * nz;
  }

  connect(x: number, y: number, z: number, dir: number, kind: ConnectionPoint['kind']): void {
    this.connections.push({ x, y, z, dir, kind });
  }
}

/** Rotate local (x, z) by quarter turns (three.js Ry convention: x' = x cos + z sin, z' = -x sin + z cos). */
export function rotQ(x: number, z: number, q: number): [number, number] {
  switch (((q % 4) + 4) % 4) {
    case 1: return [z, -x];
    case 2: return [-x, -z];
    case 3: return [-z, x];
    default: return [x, z];
  }
}

/** Rough triangle count of a primitive at full detail (validation budget, debug stats). */
export function primitiveTriangles(p: Primitive): number {
  switch (p.kind) {
    case 'box': return 12 + (Math.max(p.w, p.d) > 120 ? 24 : 0);
    case 'prism': return p.sides * (p.r1 > 0 ? 4 : 3);
    case 'lathe': return (p.profile.length - 1) * p.sides * 2 + p.sides * 2;
    case 'ring': return p.sides * 8 + 4;
    case 'torus': return p.sides * p.tube * 2;
    case 'extrude': return p.outline.length * 2 + (p.outline.length - 2) * 2;
    case 'sweep': return (p.path.length - 1) * p.section.length * 2 + (p.section.length - 2) * 2;
    case 'frustum': return 12;
    case 'dome': return 24 * 8 * 2;
    case 'sphere': return 24 * 12 * 2;
  }
}

/** Approximate volume (m³), for silhouette dominance checks. */
export function primitiveVolume(p: Primitive): number {
  switch (p.kind) {
    case 'box': { const t = p.taper ?? 1; return p.w * p.d * p.h * (1 + t + t * t) / 3; }
    case 'prism': {
      const area = (r: number) => 0.5 * p.sides * r * r * Math.sin((2 * Math.PI) / p.sides);
      const a0 = area(p.r0), a1 = area(p.r1);
      return (p.h / 3) * (a0 + a1 + Math.sqrt(a0 * a1));
    }
    case 'lathe': {
      let v = 0;
      for (let i = 0; i + 1 < p.profile.length; i++) {
        const [ra, ya] = p.profile[i], [rb, yb] = p.profile[i + 1];
        v += (Math.PI * Math.abs(yb - ya) / 3) * (ra * ra + ra * rb + rb * rb);
      }
      return v;
    }
    case 'ring': return Math.PI * (p.r1 * p.r1 - p.r0 * p.r0) * p.h * ((p.arc ?? Math.PI * 2) / (Math.PI * 2));
    case 'torus': return 2 * Math.PI * Math.PI * p.R * p.r * p.r;
    case 'extrude': {
      let a = 0;
      for (let i = 0; i < p.outline.length; i++) {
        const [ax, az] = p.outline[i], [bx, bz] = p.outline[(i + 1) % p.outline.length];
        a += ax * bz - bx * az;
      }
      const t = p.taper ?? 1;
      return Math.abs(a / 2) * p.h * (1 + t + t * t) / 3;
    }
    case 'sweep': {
      let a = 0, len = 0;
      for (let i = 0; i < p.section.length; i++) {
        const [ax, ay] = p.section[i], [bx, by] = p.section[(i + 1) % p.section.length];
        a += ax * by - bx * ay;
      }
      for (let i = 0; i + 1 < p.path.length; i++) len += Math.hypot(p.path[i + 1][0] - p.path[i][0], p.path[i + 1][1] - p.path[i][1], p.path[i + 1][2] - p.path[i][2]);
      return Math.abs(a / 2) * len;
    }
    case 'frustum': return (p.h / 3) * (p.w * p.d + p.wt * p.dt + Math.sqrt(p.w * p.d * p.wt * p.dt));
    case 'dome': return (2 / 3) * Math.PI * p.rx * p.rz * p.h;
    case 'sphere': return (4 / 3) * Math.PI * p.r ** 3;
  }
}

/** Outer surface area estimate (m²), for illumination share checks. */
export function primitiveArea(p: Primitive): number {
  switch (p.kind) {
    case 'box': return 2 * (p.w * p.d) + 2 * p.h * (p.w + p.d);
    case 'prism': { const r = (p.r0 + p.r1) / 2; return 2 * Math.PI * r * p.h + Math.PI * (p.r0 * p.r0 + p.r1 * p.r1); }
    case 'lathe': {
      let a = 0;
      for (let i = 0; i + 1 < p.profile.length; i++) {
        const [ra, ya] = p.profile[i], [rb, yb] = p.profile[i + 1];
        a += Math.PI * (ra + rb) * Math.hypot(rb - ra, yb - ya);
      }
      return a;
    }
    case 'ring': return (2 * Math.PI * (p.r0 + p.r1) * p.h + 2 * Math.PI * (p.r1 * p.r1 - p.r0 * p.r0)) * ((p.arc ?? Math.PI * 2) / (Math.PI * 2));
    case 'torus': return 4 * Math.PI * Math.PI * p.R * p.r;
    case 'extrude': {
      let per = 0, a = 0;
      for (let i = 0; i < p.outline.length; i++) {
        const [ax, az] = p.outline[i], [bx, bz] = p.outline[(i + 1) % p.outline.length];
        per += Math.hypot(bx - ax, bz - az);
        a += ax * bz - bx * az;
      }
      return per * p.h + Math.abs(a);
    }
    case 'sweep': {
      let per = 0, len = 0;
      for (let i = 0; i < p.section.length; i++) {
        const [ax, ay] = p.section[i], [bx, by] = p.section[(i + 1) % p.section.length];
        per += Math.hypot(bx - ax, by - ay);
      }
      for (let i = 0; i + 1 < p.path.length; i++) len += Math.hypot(p.path[i + 1][0] - p.path[i][0], p.path[i + 1][1] - p.path[i][1], p.path[i + 1][2] - p.path[i][2]);
      return per * len;
    }
    case 'frustum': return p.w * p.d + p.wt * p.dt + (p.w + p.wt + p.d + p.dt) * p.h;
    case 'dome': return Math.PI * p.rx * p.rz + Math.PI * (p.rx + p.rz) * p.h * 0.6;
    case 'sphere': return 4 * Math.PI * p.r * p.r;
  }
}

/** Highest point of a primitive above its base (m). */
export function primitiveHeight(p: Primitive): number {
  switch (p.kind) {
    case 'box': case 'prism': case 'ring': case 'extrude': case 'frustum': case 'dome': return p.h;
    case 'sphere': return 2 * p.r;
    case 'lathe': return Math.max(...p.profile.map((v) => v[1]));
    case 'torus': return p.r * 2;
    case 'sweep': {
      let y0 = Infinity, y1 = -Infinity;
      for (const s of p.section) { y0 = Math.min(y0, s[1]); y1 = Math.max(y1, s[1]); }
      return Math.max(...p.path.map((v) => v[1])) + y1;
    }
  }
}

/** Horizontal half extent of a primitive about its base centre (bounding radius / half-diagonal). */
export function primitiveReach(p: Primitive): number {
  switch (p.kind) {
    case 'box': return Math.hypot(p.w, p.d) / 2;
    case 'prism': return Math.max(p.r0, p.r1);
    case 'lathe': return Math.max(...p.profile.map((v) => v[0]));
    case 'ring': return p.r1;
    case 'torus': return p.R + p.r;
    case 'extrude': return Math.max(...p.outline.map(([x, z]) => Math.hypot(x, z)));
    case 'sweep': return 0;
    case 'frustum': return Math.hypot(p.w, p.d) / 2;
    case 'dome': return Math.max(p.rx, p.rz);
    case 'sphere': return p.r;
  }
}
