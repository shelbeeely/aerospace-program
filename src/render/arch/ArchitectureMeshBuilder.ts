import * as THREE from 'three/webgpu';
import { rotQ, primitiveReach } from '../../arch/grammar.ts';
import { LIGHT_ROLES, PATTERNS, SURFACES } from '../../arch/palette.ts';
import type { Component, EdgeMode, Primitive } from '../../arch/types.ts';

/**
 * Components → GPU geometry. Every primitive becomes non-indexed triangles with:
 * - position (f32 ×3);
 * - nrm (snorm8 ×4): face/smooth normal, w = height within its structure (0..1, the airbrushed
 *   gradient);
 * - edge (unorm8 ×4): per-triangle barycentrics/8 where a component reaches 0 only on a face
 *   edge that should glow (unlit edges and quad diagonals are pushed to FAR), w = glow / 4;
 * - uvm (f32 ×2): face coordinates in metres (surface patterns drawn by the shader);
 * - info (f32 ×2): lighting slot (structure id in the BuildingLightingController), and the
 *   packed code surface + 16·lightRole + 128·pattern.
 * Translucent components (beams, energy columns) go to a second writer drawn additively.
 *
 * LOD: 0 = everything; 1 = no interiors, no unlit tertiary detail, fewer round segments;
 * 2 = primary masses and large secondary forms only (silhouettes for the far field).
 */
export type Lod = 0 | 1 | 2;
const FAR = 8;
type V3 = [number, number, number];

export class GeometryWriter {
  pos: number[] = [];
  nrm: number[] = [];
  edge: number[] = [];
  uvm: number[] = [];
  info: number[] = [];
  /** Current per-component state. */
  hgtBase = 0;
  hgtScale = 1;
  sid = 0;
  code = 0;
  glow = 0;

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  private vert(p: V3, n: V3, e: V3, uv: [number, number]): void {
    this.pos.push(p[0], p[1], p[2]);
    const h = Math.min(1, Math.max(0, (p[1] - this.hgtBase) * this.hgtScale));
    this.nrm.push(Math.round(n[0] * 127), Math.round(n[1] * 127), Math.round(n[2] * 127), Math.round(h * 127));
    this.edge.push(Math.round((e[0] / FAR) * 255), Math.round((e[1] / FAR) * 255), Math.round((e[2] / FAR) * 255), Math.round(Math.min(1, this.glow / 4) * 255));
    this.uvm.push(uv[0], uv[1]);
    this.info.push(this.sid, this.code);
  }

  /** Triangle a-b-c; lit flags for edges bc, ca, ab (opposite a, b, c). */
  tri(a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3, ua: [number, number], ub: [number, number], uc: [number, number], litBC: boolean, litCA: boolean, litAB: boolean): void {
    const ex = litBC ? 0 : FAR, ey = litCA ? 0 : FAR, ez = litAB ? 0 : FAR;
    this.vert(a, na, [1, ey, ez], ua);
    this.vert(b, nb, [ex, 1, ez], ub);
    this.vert(c, nc, [ex, ey, 1], uc);
  }

  /** Quad a-b-c-d (counter-clockwise seen from outside) with flat normal; lit flags ab, bc, cd, da. */
  quad(a: V3, b: V3, c: V3, d: V3, lit: [boolean, boolean, boolean, boolean], uv?: [[number, number], [number, number], [number, number], [number, number]], n?: V3): void {
    const nn = n ?? faceNormal(a, b, c);
    const u = uv ?? quadUV(a, b, d);
    this.tri(a, b, c, nn, nn, nn, u[0], u[1], u[2], lit[1], false, lit[0]);
    this.tri(a, c, d, nn, nn, nn, u[0], u[2], u[3], lit[2], lit[3], false);
  }

  /** Quad split into nu × nv cells (planet curvature needs vertices on long faces); only outer edges lit. */
  quadGrid(a: V3, b: V3, c: V3, d: V3, lit: [boolean, boolean, boolean, boolean], nu: number, nv: number): void {
    if (nu <= 1 && nv <= 1) return this.quad(a, b, c, d, lit);
    const n = faceNormal(a, b, c);
    const P = (u: number, v: number): V3 => {
      // Bilinear over the quad (a → b along u, a → d along v).
      const ab = lerp3(a, b, u), dc = lerp3(d, c, u);
      return lerp3(ab, dc, v);
    };
    const lu = dist(a, b), lv = dist(a, d);
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const u0 = i / nu, u1 = (i + 1) / nu, v0 = j / nv, v1 = (j + 1) / nv;
      this.quad(P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1), [lit[0] && j === 0, lit[1] && i === nu - 1, lit[2] && j === nv - 1, lit[3] && i === 0],
        [[u0 * lu, v0 * lv], [u1 * lu, v0 * lv], [u1 * lu, v1 * lv], [u0 * lu, v1 * lv]], n);
    }
  }

  build(): THREE.BufferGeometry | null {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('nrm', new THREE.BufferAttribute(new Int8Array(this.nrm), 4, true));
    g.setAttribute('edge', new THREE.BufferAttribute(new Uint8Array(this.edge), 4, true));
    g.setAttribute('uvm', new THREE.Float32BufferAttribute(this.uvm, 2));
    g.setAttribute('info', new THREE.Float32BufferAttribute(this.info, 2));
    g.computeBoundingSphere();
    return g;
  }
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const faceNormal = (a: V3, b: V3, c: V3): V3 => norm(cross(sub(b, a), sub(c, a)));
function quadUV(a: V3, b: V3, d: V3): [[number, number], [number, number], [number, number], [number, number]] {
  const lu = dist(a, b), lv = dist(a, d);
  return [[0, 0], [lu, 0], [lu, lv], [0, lv]];
}

/** Which edge classes glow for a mode. */
function edgeFlags(mode: EdgeMode): { top: boolean; base: boolean; vert: boolean; horiz: boolean } {
  switch (mode) {
    case 'top': return { top: true, base: false, vert: false, horiz: false };
    case 'base': return { top: false, base: true, vert: false, horiz: false };
    case 'rims': return { top: true, base: true, vert: false, horiz: false };
    case 'silhouette': return { top: true, base: false, vert: true, horiz: false };
    case 'horizontal': return { top: true, base: true, vert: false, horiz: true };
    case 'all': return { top: true, base: true, vert: true, horiz: true };
    default: return { top: false, base: false, vert: false, horiz: false };
  }
}

/** Component placement: local transform then structure transform → writer space. */
export interface Placement {
  /** Structure offset in writer space and quarter-turn rotation. */
  ox: number;
  oz: number;
  rot: number;
}

const SEG_LOD = (sides: number, lod: Lod) => (sides < 12 ? sides : lod === 0 ? sides : lod === 1 ? Math.max(10, Math.round(sides / 2)) : Math.max(8, Math.round(sides / 3)));

/** Should a component be drawn at this LOD? */
export function drawAtLod(c: Component, lod: Lod): boolean {
  if (lod === 0) return true;
  if (c.interior) return false;
  if (lod === 1) return c.tier !== 3 || c.surface === 'glow';
  return c.tier === 1 || c.surface === 'translucent' || (c.tier === 2 && (primitiveReach(c.prim) > 14 || c.prim.kind === 'torus'));
}

/** Packed material code for a component. */
export function componentCode(c: Component): number {
  const s = SURFACES.indexOf(c.surface);
  const r = Math.max(0, LIGHT_ROLES.indexOf(c.light ?? 'structure'));
  const pat = PATTERNS.indexOf(c.pattern ?? (c.tier === 3 ? 'none' : c.surface === 'circuit' ? 'circuit' : 'panels'));
  return s + 16 * r + 128 * Math.max(0, pat);
}

/**
 * Emit one component. `place` maps structure-local → writer space (quarter turn + offset);
 * the component's own rx/rz tilts and ry rotation apply first.
 */
export function emitComponent(w: GeometryWriter, c: Component, place: Placement, lod: Lod): void {
  const cosY = Math.cos(c.ry ?? 0), sinY = Math.sin(c.ry ?? 0);
  const rx = c.rx ?? 0, rz = c.rz ?? 0;
  const cx = Math.cos(rx), sx = Math.sin(rx), cz = Math.cos(rz), sz = Math.sin(rz);
  const tilt = rx !== 0 || rz !== 0;
  const T = (p: V3): V3 => {
    let [x, y, z] = p;
    if (tilt) {
      // Rz then Rx (three.js matrices).
      [x, y] = [x * cz - y * sz, x * sz + y * cz];
      [y, z] = [y * cx - z * sx, y * sx + z * cx];
    }
    // Ry (three.js): x' = x cos + z sin, z' = -x sin + z cos.
    [x, z] = [x * cosY + z * sinY, -x * sinY + z * cosY];
    x += c.x; y += c.y; z += c.z;
    const [qx, qz] = rotQ(x, z, place.rot);
    return [qx + place.ox, y, qz + place.oz];
  };
  const N = (n: V3): V3 => {
    let [x, y, z] = n;
    if (tilt) {
      [x, y] = [x * cz - y * sz, x * sz + y * cz];
      [y, z] = [y * cx - z * sx, y * sx + z * cx];
    }
    [x, z] = [x * cosY + z * sinY, -x * sinY + z * cosY];
    const [qx, qz] = rotQ(x, z, place.rot);
    return [qx, y, qz];
  };
  w.code = componentCode(c);
  w.glow = c.surface === 'glow' || c.surface === 'translucent' || c.edges !== 'none' ? (c.glow ?? 1) : 0;
  const f = edgeFlags(c.edges);
  const elevated = c.y > 0.3 || tilt;
  emitPrimitive(w, c.prim, T, N, f, elevated, lod);
}

type TF = (p: V3) => V3;

function emitPrimitive(w: GeometryWriter, p: Primitive, T: TF, N: TF, f: ReturnType<typeof edgeFlags>, elevated: boolean, lod: Lod): void {
  switch (p.kind) {
    case 'box': {
      const t = p.taper ?? 1;
      return frustum(w, p.w, p.d, p.w * t, p.d * t, p.h, T, N, f, elevated);
    }
    case 'frustum': return frustum(w, p.w, p.d, p.wt, p.dt, p.h, T, N, f, elevated);
    case 'prism': return prism(w, SEG_LOD(p.sides, lod), p.r0, p.r1, p.h, p.phase ?? 0, T, N, f, elevated, p.sides >= 12);
    case 'lathe': return lathe(w, p.profile, SEG_LOD(p.sides, lod), T, N, f, p.sides >= 12);
    case 'ring': return ring(w, p.r0, p.r1, p.h, SEG_LOD(p.sides, lod), p.arc ?? Math.PI * 2, p.arcStart ?? 0, T, N, f);
    case 'torus': return torus(w, p.R, p.r, SEG_LOD(p.sides, lod), lod === 0 ? p.tube : 4, T, N);
    case 'extrude': return extrude(w, p.outline, p.h, p.taper ?? 1, T, N, f, elevated);
    case 'sweep': return sweep(w, p.section, p.path, T, N, f);
    case 'dome': return dome(w, p.rx, p.rz, p.h, lod === 0 ? 24 : lod === 1 ? 16 : 10, lod === 0 ? 7 : 4, T, N, f);
    case 'sphere': return sphere(w, p.r, lod === 0 ? 24 : 12, lod === 0 ? 12 : 6, T, N);
  }
}

function frustum(w: GeometryWriter, bw: number, bd: number, tw: number, td: number, h: number, T: TF, N: TF, f: ReturnType<typeof edgeFlags>, elevated: boolean): void {
  const b: V3[] = [[-bw / 2, 0, -bd / 2], [bw / 2, 0, -bd / 2], [bw / 2, 0, bd / 2], [-bw / 2, 0, bd / 2]];
  const t: V3[] = [[-tw / 2, h, -td / 2], [tw / 2, h, -td / 2], [tw / 2, h, td / 2], [-tw / 2, h, td / 2]];
  const B = b.map(T), Tt = t.map(T);
  const segs = (len: number) => Math.max(1, Math.ceil(len / 120));
  const pyramid = tw < 0.05 && td < 0.05;
  // Sides: each face (b_i, b_{i+1}, t_{i+1}, t_i), counter-clockwise from outside.
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const len = i % 2 === 0 ? bw : bd;
    // Order so the normal points out: b_j, b_i, t_i, t_j for this winding.
    w.quadGrid(B[j], B[i], Tt[i], Tt[j], [f.base, f.vert, f.top, f.vert], segs(len), pyramid ? 1 : Math.max(1, Math.ceil(h / 160)));
  }
  if (!pyramid) w.quadGrid(Tt[0], Tt[3], Tt[2], Tt[1], [f.top, f.top, f.top, f.top], segs(tw), segs(td));
  if (elevated) w.quadGrid(B[0], B[1], B[2], B[3], [f.base, f.base, f.base, f.base], segs(bw), segs(bd));
  void N;
}

function prism(w: GeometryWriter, n: number, r0: number, r1: number, h: number, phase: number, T: TF, N: TF, f: ReturnType<typeof edgeFlags>, elevated: boolean, smooth: boolean): void {
  const ring0: V3[] = [], ring1: V3[] = [];
  for (let k = 0; k < n; k++) {
    const a = phase + (k / n) * Math.PI * 2;
    ring0.push([Math.cos(a) * r0, 0, Math.sin(a) * r0]);
    ring1.push([Math.cos(a) * r1, h, Math.sin(a) * r1]);
  }
  const slope = (r0 - r1) / Math.max(1e-6, h);
  const sn = (a: number): V3 => norm([Math.cos(a), slope, Math.sin(a)]);
  const circ = 2 * Math.PI * Math.max(r0, r1);
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const a0 = T(ring0[k]), a1 = T(ring0[j]), b0 = T(ring1[k]), b1 = T(ring1[j]);
    const u0 = (k / n) * circ, u1 = ((k + 1) / n) * circ;
    const sh = Math.hypot(h, r0 - r1);
    if (smooth) {
      const n0 = N(sn(phase + (k / n) * Math.PI * 2)), n1 = N(sn(phase + ((k + 1) / n) * Math.PI * 2));
      if (r1 < 0.05) {
        w.tri(a1, a0, b0, n1, n0, n0, [u1, 0], [u0, 0], [u0, sh], false, false, f.base);
      } else {
        w.tri(a1, a0, b0, n1, n0, n0, [u1, 0], [u0, 0], [u0, sh], false, false, f.base);
        w.tri(a1, b0, b1, n1, n0, n1, [u1, 0], [u0, sh], [u1, sh], f.top, false, false);
      }
    } else if (r1 < 0.05) {
      const nn = faceNormal(a1, a0, b0);
      w.tri(a1, a0, b0, nn, nn, nn, [u1, 0], [u0, 0], [u0, sh], f.vert, f.vert, f.base);
    } else {
      w.quad(a1, a0, b0, b1, [f.base, f.vert, f.top, f.vert], [[u1, 0], [u0, 0], [u0, sh], [u1, sh]]);
    }
  }
  const c1 = T([0, h, 0]), c0 = T([0, 0, 0]);
  const up = N([0, 1, 0]), down = N([0, -1, 0]);
  if (r1 >= 0.05) for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const p0 = ring1[k], p1 = ring1[j];
    w.tri(c1, T(p1), T(p0), up, up, up, [0, 0], [p1[0], p1[2]], [p0[0], p0[2]], f.top, false, false);
  }
  if (elevated) for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const p0 = ring0[k], p1 = ring0[j];
    w.tri(c0, T(p0), T(p1), down, down, down, [0, 0], [p0[0], p0[2]], [p1[0], p1[2]], f.base, false, false);
  }
}

function lathe(w: GeometryWriter, profile: ReadonlyArray<readonly [number, number]>, n: number, T: TF, N: TF, f: ReturnType<typeof edgeFlags>, smooth: boolean): void {
  let v = 0;
  for (let i = 0; i + 1 < profile.length; i++) {
    const [ra, ya] = profile[i], [rb, yb] = profile[i + 1];
    const seg = Math.hypot(rb - ra, yb - ya);
    if (seg < 1e-4) continue;
    const nr = (yb - ya) / seg, ny = -(rb - ra) / seg;
    // Lit edges: the profile breaks (horizontal), the first ring (base) and the last (top).
    const litA = (i === 0 && f.base) || (i > 0 && f.horiz);
    const litB = (i + 2 === profile.length && f.top) || (i + 2 < profile.length && f.horiz);
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      const P = (r: number, y: number, a: number) => T([Math.cos(a) * r, y, Math.sin(a) * r]);
      const Nn = (a: number) => N(smooth ? [Math.cos(a) * nr, ny, Math.sin(a) * nr] : [Math.cos((a0 + a1) / 2) * nr, ny, Math.sin((a0 + a1) / 2) * nr]);
      const circ = Math.PI * (ra + rb);
      const p00 = P(ra, ya, a0), p01 = P(ra, ya, a1), p10 = P(rb, yb, a0), p11 = P(rb, yb, a1);
      const u0 = (k / n) * circ, u1 = ((k + 1) / n) * circ;
      if (rb < 0.05) {
        w.tri(p01, p00, p10, Nn(a1), Nn(a0), Nn(a0), [u1, v], [u0, v], [u0, v + seg], false, false, litA);
      } else if (ra < 0.05) {
        w.tri(p00, p10, p11, Nn(a0), Nn(a0), Nn(a1), [u0, v], [u0, v + seg], [u1, v + seg], litB, false, false);
      } else {
        w.tri(p01, p00, p10, Nn(a1), Nn(a0), Nn(a0), [u1, v], [u0, v], [u0, v + seg], false, false, litA);
        w.tri(p01, p10, p11, Nn(a1), Nn(a0), Nn(a1), [u1, v], [u0, v + seg], [u1, v + seg], litB, false, false);
      }
    }
    v += seg;
  }
  // Cap the top if the profile ends with a radius.
  const [rt, yt] = profile[profile.length - 1];
  if (rt > 0.05) {
    const up = N([0, 1, 0]);
    const c = T([0, yt, 0]);
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      w.tri(c, T([Math.cos(a1) * rt, yt, Math.sin(a1) * rt]), T([Math.cos(a0) * rt, yt, Math.sin(a0) * rt]), up, up, up, [0, 0], [Math.cos(a1) * rt, Math.sin(a1) * rt], [Math.cos(a0) * rt, Math.sin(a0) * rt], f.top, false, false);
    }
  }
}

function ring(w: GeometryWriter, r0: number, r1: number, h: number, n: number, arc: number, start: number, T: TF, N: TF, f: ReturnType<typeof edgeFlags>): void {
  const full = arc >= Math.PI * 2 - 1e-6;
  const segs = Math.max(2, Math.round((n * arc) / (Math.PI * 2)));
  const up = N([0, 1, 0]), down = N([0, -1, 0]);
  for (let k = 0; k < segs; k++) {
    const a0 = start + (k / segs) * arc, a1 = start + ((k + 1) / segs) * arc;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const o00 = T([c0 * r1, 0, s0 * r1]), o01 = T([c1 * r1, 0, s1 * r1]), o10 = T([c0 * r1, h, s0 * r1]), o11 = T([c1 * r1, h, s1 * r1]);
    const i00 = T([c0 * r0, 0, s0 * r0]), i01 = T([c1 * r0, 0, s1 * r0]), i10 = T([c0 * r0, h, s0 * r0]), i11 = T([c1 * r0, h, s1 * r0]);
    const no0 = N([c0, 0, s0]), no1 = N([c1, 0, s1]), ni0 = N([-c0, 0, -s0]), ni1 = N([-c1, 0, -s1]);
    const L = r1 * (arc / segs);
    // Outer wall.
    w.tri(o01, o00, o10, no1, no0, no0, [L, 0], [0, 0], [0, h], false, false, f.base);
    w.tri(o01, o10, o11, no1, no0, no1, [L, 0], [0, h], [L, h], f.top, false, false);
    // Inner wall.
    w.tri(i00, i01, i11, ni0, ni1, ni1, [0, 0], [L, 0], [L, h], false, false, f.base);
    w.tri(i00, i11, i10, ni0, ni1, ni0, [0, 0], [L, h], [0, h], f.top, false, false);
    // Top and bottom annulus.
    w.quad(i10, i11, o11, o10, [f.top, false, f.top, false], undefined, up);
    w.quad(o00, o01, i01, i00, [f.base, false, f.base, false], undefined, down);
  }
  if (!full) for (const a of [start, start + arc]) {
    const c = Math.cos(a), s = Math.sin(a);
    const pts: V3[] = [[c * r0, 0, s * r0], [c * r1, 0, s * r1], [c * r1, h, s * r1], [c * r0, h, s * r0]];
    const P = pts.map(T);
    if (a === start) w.quad(P[1], P[0], P[3], P[2], [f.base, f.vert, f.top, f.vert]);
    else w.quad(P[0], P[1], P[2], P[3], [f.base, f.vert, f.top, f.vert]);
  }
}

function torus(w: GeometryWriter, R: number, r: number, n: number, m: number, T: TF, N: TF): void {
  const P = (a: number, b: number): [V3, V3] => {
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    return [T([(R + r * cb) * ca, r + r * sb, (R + r * cb) * sa]), N([cb * ca, sb, cb * sa])];
  };
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, b0 = (j / m) * Math.PI * 2, b1 = ((j + 1) / m) * Math.PI * 2;
    const [p00, n00] = P(a0, b0), [p10, n10] = P(a1, b0), [p11, n11] = P(a1, b1), [p01, n01] = P(a0, b1);
    w.tri(p00, p01, p11, n00, n01, n11, [0, 0], [0, 1], [1, 1], false, false, false);
    w.tri(p00, p11, p10, n00, n11, n10, [0, 0], [1, 1], [1, 0], false, false, false);
  }
}

function extrude(w: GeometryWriter, outline: ReadonlyArray<readonly [number, number]>, h: number, taper: number, T: TF, N: TF, f: ReturnType<typeof edgeFlags>, elevated: boolean): void {
  let cx = 0, cz = 0;
  for (const [x, z] of outline) { cx += x; cz += z; }
  cx /= outline.length; cz /= outline.length;
  const top = outline.map(([x, z]) => [cx + (x - cx) * taper, cz + (z - cz) * taper] as [number, number]);
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a: V3 = [outline[i][0], 0, outline[i][1]], b: V3 = [outline[j][0], 0, outline[j][1]];
    const c: V3 = [top[j][0], h, top[j][1]], d: V3 = [top[i][0], h, top[i][1]];
    w.quad(T(b), T(a), T(d), T(c), [f.base, f.vert, f.top, f.vert]);
  }
  const tris = earcut(outline);
  const up = N([0, 1, 0]), down = N([0, -1, 0]);
  for (const [i, j, k] of tris) {
    w.tri(T([top[i][0], h, top[i][1]]), T([top[k][0], h, top[k][1]]), T([top[j][0], h, top[j][1]]), up, up, up, top[i], top[k], top[j], false, false, false);
    if (elevated) w.tri(T([outline[i][0], 0, outline[i][1]]), T([outline[j][0], 0, outline[j][1]]), T([outline[k][0], 0, outline[k][1]]), down, down, down, outline[i] as [number, number], outline[j] as [number, number], outline[k] as [number, number], false, false, false);
  }
}

/** Ear-clipping triangulation of a simple polygon (either winding); returns index triples wound CCW (x right, z down). */
function earcut(poly: ReadonlyArray<readonly [number, number]>): Array<[number, number, number]> {
  const idx = poly.map((_, i) => i);
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    area += ax * bz - bx * az;
  }
  if (area < 0) idx.reverse();
  const out: Array<[number, number, number]> = [];
  const crossZ = (a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let guard = 0;
  while (idx.length > 3 && guard++ < 1000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = poly[idx[(i + idx.length - 1) % idx.length]], b = poly[idx[i]], c = poly[idx[(i + 1) % idx.length]];
      if (crossZ(a, b, c) <= 0) continue;
      let inside = false;
      for (const k of idx) {
        const p = poly[k];
        if (p === a || p === b || p === c) continue;
        if (crossZ(a, b, p) > 0 && crossZ(b, c, p) > 0 && crossZ(c, a, p) > 0) { inside = true; break; }
      }
      if (inside) continue;
      out.push([idx[(i + idx.length - 1) % idx.length], idx[i], idx[(i + 1) % idx.length]]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

function sweep(w: GeometryWriter, section: ReadonlyArray<readonly [number, number]>, path: ReadonlyArray<ReadonlyArray<number>>, T: TF, N: TF, f: ReturnType<typeof edgeFlags>): void {
  const rings: V3[][] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const prev = path[Math.max(0, i - 1)], next = path[Math.min(path.length - 1, i + 1)];
    const t = norm([next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]]);
    let s = cross([0, 1, 0], t);
    if (Math.hypot(...s) < 1e-3) s = [1, 0, 0];
    s = norm(s);
    const u = cross(t, s);
    const k = p[3] ?? 1;
    rings.push(section.map(([sx, sy]) => [p[0] + (s[0] * sx + u[0] * sy) * k, p[1] + (s[1] * sx + u[1] * sy) * k, p[2] + (s[2] * sx + u[2] * sy) * k] as V3));
  }
  const m = section.length;
  for (let i = 0; i + 1 < rings.length; i++) for (let k = 0; k < m; k++) {
    const j = (k + 1) % m;
    const a = T(rings[i][k]), b = T(rings[i][j]), c = T(rings[i + 1][j]), d = T(rings[i + 1][k]);
    // Lengthwise edges (section corners) glow when 'all' or 'silhouette'.
    w.quad(a, b, c, d, [i === 0 && f.base, f.vert || f.horiz, i + 2 === rings.length && f.base, f.vert || f.horiz]);
  }
  // End caps.
  for (const [ri, flip] of [[0, true], [rings.length - 1, false]] as const) {
    const pts = rings[ri].map(T);
    const tris = earcut(section);
    for (const [a, b, c] of tris) {
      const nn = faceNormal(pts[a], pts[b], pts[c]);
      if (flip) w.tri(pts[a], pts[c], pts[b], N([0, 0, 0]).map((_, q) => -nn[q]) as V3, N([0, 0, 0]).map((_, q) => -nn[q]) as V3, N([0, 0, 0]).map((_, q) => -nn[q]) as V3, [0, 0], [0, 0], [0, 0], false, false, false);
      else w.tri(pts[a], pts[b], pts[c], nn, nn, nn, [0, 0], [0, 0], [0, 0], false, false, false);
    }
  }
}

function dome(w: GeometryWriter, rx: number, rz: number, h: number, n: number, m: number, T: TF, N: TF, f: ReturnType<typeof edgeFlags>): void {
  const P = (a: number, t: number): [V3, V3] => {
    // t: 0 at the rim, 1 at the apex; elliptical cap of an ellipsoid.
    const phi = (t * Math.PI) / 2;
    const r = Math.cos(phi), y = Math.sin(phi);
    const ca = Math.cos(a), sa = Math.sin(a);
    return [T([ca * r * rx, y * h, sa * r * rz]), N(norm([(ca * r) / rx, y / h, (sa * r) / rz]))];
  };
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, t0 = j / m, t1 = (j + 1) / m;
    const [p00, n00] = P(a0, t0), [p10, n10] = P(a1, t0), [p11, n11] = P(a1, t1), [p01, n01] = P(a0, t1);
    const u0 = a0 * rx, u1 = a1 * rx, v0 = t0 * h * 1.5, v1 = t1 * h * 1.5;
    w.tri(p10, p00, p01, n10, n00, n01, [u1, v0], [u0, v0], [u0, v1], false, false, j === 0 && f.base);
    if (j + 1 < m) w.tri(p10, p01, p11, n10, n01, n11, [u1, v0], [u0, v1], [u1, v1], false, false, false);
  }
}

function sphere(w: GeometryWriter, r: number, n: number, m: number, T: TF, N: TF): void {
  const P = (a: number, b: number): [V3, V3] => {
    const cb = Math.cos(b), sb = Math.sin(b), ca = Math.cos(a), sa = Math.sin(a);
    return [T([ca * cb * r, r + sb * r, sa * cb * r]), N([ca * cb, sb, sa * cb])];
  };
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const b0 = -Math.PI / 2 + (j / m) * Math.PI, b1 = -Math.PI / 2 + ((j + 1) / m) * Math.PI;
    const [p00, n00] = P(a0, b0), [p10, n10] = P(a1, b0), [p11, n11] = P(a1, b1), [p01, n01] = P(a0, b1);
    w.tri(p10, p00, p01, n10, n00, n01, [a1 * r, b0 * r], [a0 * r, b0 * r], [a0 * r, b1 * r], false, false, false);
    w.tri(p10, p01, p11, n10, n01, n11, [a1 * r, b0 * r], [a0 * r, b1 * r], [a1 * r, b1 * r], false, false, false);
  }
}
