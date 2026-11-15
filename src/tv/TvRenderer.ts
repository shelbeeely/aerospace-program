import { GRID, isHighwayLine } from '../arch/grid.ts';
import { BIT_SHAPES, type BitState } from '../people/bit.ts';
import { PROFILE_UI } from '../hud/profiles.ts';
import { segmentExists } from '../sim/roadRules.ts';
import { CITY } from '../sim/layout.ts';
import { BIT_STATES, S, type CraftShape, type TvFrame } from './format.ts';
import { PIECE, type StructureStore } from './structures.ts';

/**
 * The game drawn with Canvas 2D for a TV (a Chromecast receiver, a smart TV's browser): no
 * WebGL. A small software 3D pipeline (camera, near-plane clipping, back faces dropped, whole
 * convex pieces sorted far to near) draws the 1982 world the way the full renderer does in
 * spirit: large dark masses shaded by orientation, light only where it means something (the
 * top rim of a structure, a craft's light parts, light walls, the street grid), distance haze
 * and an amber horizon band under a deep sky. It draws a TvFrame (src/tv/frame.ts) and the
 * planned architecture (src/tv/structures.ts); it never touches the simulation.
 *
 * Quality adapts: when frames take too long the draw range, the round shapes' facets and the
 * fine ground grid come down, and go back up when there is time to spare.
 */

type CameraMode = 'chase' | 'far' | 'overhead';
const CAMERA_MODES: CameraMode[] = ['chase', 'far', 'overhead'];

const NEAR = 0.4;
const SKY_TOP = '#01020a';
const SKY_MID = '#071540';
const SKY_LOW = '#183a7c';
const HORIZON = '#e08a34';
const GROUND_FAR = '#0a1a40';
const GROUND_NEAR = '#02060f';
const FOG: [number, number, number] = [9, 21, 54];
/** Light comes from the sky behind the camera's usual side: shades the masses' faces apart. */
const LIGHT = norm3(0.35, 0.85, 0.4);
const STEEL_LOW: [number, number, number] = [12, 18, 54];
const STEEL_HIGH: [number, number, number] = [34, 53, 122];

function norm3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

function hexRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A convex solid: vertices and faces (index lists, outward winding not required: normals given). */
interface Solid {
  v: number[];
  faces: Array<{ i: number[]; n: [number, number, number] }>;
}

/** Rings along an axis [(t, radius)] around `sides` facets: cylinders, cones, spheres, capsules. */
function lathe(rings: Array<[number, number]>, sides: number, axis: number): Solid {
  const v: number[] = [];
  const idx: number[][] = [];
  const put = (t: number, a: number, r: number) => {
    const c = Math.cos(a) * r, s = Math.sin(a) * r;
    if (axis === 0) v.push(t, c, s);
    else if (axis === 1) v.push(c, t, s);
    else v.push(c, s, t);
    return v.length / 3 - 1;
  };
  for (const [t, r] of rings) {
    const ring: number[] = [];
    if (r < 1e-4) ring.push(put(t, 0, 0));
    else for (let k = 0; k < sides; k++) ring.push(put(t, (k / sides) * Math.PI * 2, r));
    idx.push(ring);
  }
  const faces: Solid['faces'] = [];
  const centre = [0, 0, 0];
  for (let i = 0; i < v.length; i += 3) for (let a = 0; a < 3; a++) centre[a] += v[i + a] / (v.length / 3);
  const face = (ids: number[]) => {
    if (ids.length < 3) return;
    // Normal from the first three distinct points, flipped outward.
    const p = (k: number) => [v[ids[k] * 3], v[ids[k] * 3 + 1], v[ids[k] * 3 + 2]];
    const a = p(0), b = p(1), c = p(ids.length > 3 ? 2 : 2);
    let n = norm3(
      (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    );
    const m = [0, 0, 0];
    for (const id of ids) for (let k = 0; k < 3; k++) m[k] += v[id * 3 + k] / ids.length;
    if (n[0] * (m[0] - centre[0]) + n[1] * (m[1] - centre[1]) + n[2] * (m[2] - centre[2]) < 0) n = [-n[0], -n[1], -n[2]];
    faces.push({ i: ids, n });
  };
  face(idx[0]);
  face(idx[idx.length - 1]);
  for (let r = 0; r + 1 < idx.length; r++) {
    const A = idx[r], B = idx[r + 1];
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      const ids = [A[k % A.length], A[k1 % A.length], B[k1 % B.length], B[k % B.length]].filter((x, i, arr) => arr.indexOf(x) === i);
      face(ids);
    }
  }
  return { v, faces };
}

function boxSolid(sx: number, sy: number, sz: number): Solid {
  const x = sx / 2, y = sy / 2, z = sz / 2;
  const v = [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z];
  return {
    v,
    faces: [
      { i: [0, 1, 2, 3], n: [0, 0, -1] }, { i: [5, 4, 7, 6], n: [0, 0, 1] }, { i: [4, 0, 3, 7], n: [-1, 0, 0] },
      { i: [1, 5, 6, 2], n: [1, 0, 0] }, { i: [3, 2, 6, 7], n: [0, 1, 0] }, { i: [4, 5, 1, 0], n: [0, -1, 0] },
    ],
  };
}

/** A craft part's solid, in body coordinates. */
function partSolid(p: CraftShape['parts'][number]): Solid {
  let s: Solid;
  const [a, b, c] = p.d;
  if (p.s === 0) s = boxSolid(a, b, c);
  else if (p.s === 1) s = lathe([[-b / 2, a], [b / 2, a]], 10, c);
  else if (p.s === 2) s = lathe(p.tip === 1 ? [[-b / 2, a], [b / 2, 0]] : [[-b / 2, 0], [b / 2, a]], 10, c);
  else if (p.s === 3) s = lathe([[-a, 0], [-a * 0.7, a * 0.71], [0, a], [a * 0.7, a * 0.71], [a, 0]], 8, 1);
  else {
    const e = Math.min(a * 0.6, b / 2);
    s = lathe([[-b / 2, a * 0.45], [-b / 2 + e, a], [b / 2 - e, a], [b / 2, a * 0.45]], 10, c);
  }
  // Part rotation and position.
  const [qx, qy, qz, qw] = p.q;
  const rot = (x: number, y: number, z: number): [number, number, number] => {
    const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
  };
  for (let i = 0; i < s.v.length; i += 3) {
    const r = rot(s.v[i], s.v[i + 1], s.v[i + 2]);
    s.v[i] = r[0] + p.p[0];
    s.v[i + 1] = r[1] + p.p[1];
    s.v[i + 2] = r[2] + p.p[2];
  }
  for (const f of s.faces) f.n = rot(...f.n);
  return s;
}

/** The Bits' figures as solids (the imported meshes: each triangle a face). */
const BIT_SOLIDS: Record<BitState, Solid> = Object.fromEntries(
  BIT_STATES.map((st) => {
    const sh = BIT_SHAPES[st];
    const v = sh.positions.slice();
    const faces: Solid['faces'] = [];
    for (let i = 0; i < sh.indices.length; i += 3) {
      const [a, b, c] = [sh.indices[i], sh.indices[i + 1], sh.indices[i + 2]];
      const n = norm3(
        (v[b * 3 + 1] - v[a * 3 + 1]) * (v[c * 3 + 2] - v[a * 3 + 2]) - (v[b * 3 + 2] - v[a * 3 + 2]) * (v[c * 3 + 1] - v[a * 3 + 1]),
        (v[b * 3 + 2] - v[a * 3 + 2]) * (v[c * 3] - v[a * 3]) - (v[b * 3] - v[a * 3]) * (v[c * 3 + 2] - v[a * 3 + 2]),
        (v[b * 3] - v[a * 3]) * (v[c * 3 + 1] - v[a * 3 + 1]) - (v[b * 3 + 1] - v[a * 3 + 1]) * (v[c * 3] - v[a * 3]),
      );
      faces.push({ i: [a, b, c], n });
    }
    return [st, { v, faces }];
  }),
) as Record<BitState, Solid>;

/** A program: a tall dark octahedron. A flyer: a delta with a spine. */
const PROGRAM_SOLID = lathe([[-0.9, 0], [0, 0.45], [0.9, 0]], 4, 1);
const FLYER_SOLID: Solid = (() => {
  // Nose at -z; unit size (scaled by the flyer's radius).
  const v = [0, 0, -1, -0.95, 0, 0.7, 0.95, 0, 0.7, 0, 0.18, 0.55, 0, -0.08, 0.6];
  const faces: Solid['faces'] = [
    { i: [0, 1, 3], n: norm3(-0.2, 1, -0.15) }, { i: [0, 3, 2], n: norm3(0.2, 1, -0.15) },
    { i: [0, 4, 1], n: norm3(-0.1, -1, 0) }, { i: [0, 2, 4], n: norm3(0.1, -1, 0) },
    { i: [1, 4, 3], n: norm3(0, 0, 1) }, { i: [2, 3, 4], n: norm3(0, 0, 1) },
  ];
  return { v, faces };
})();
const CYCLE_SOLID = boxSolid(0.9, 1.1, 2.8);
const BLOCK_SOLID = boxSolid(1, 1, 1);

export interface RenderStats {
  pieces: number;
  ms: number;
  quality: number;
  /** Milliseconds per stage: sky, ground, solids, light, HUD. */
  stages: number[];
}

export class TvRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private W = 1280;
  private H = 720;
  // Camera.
  private ex = 0; private ey = 0; private ez = 0;
  private rx = 1; private ry = 0; private rz = 0;
  private ux = 0; private uy = 1; private uz = 0;
  private fx = 0; private fy = 0; private fz = -1;
  private F = 600;
  private camYaw = 0;
  private camPitch = -0.2;
  private camRoll = 0;
  private camInit = false;
  mode: CameraMode = 'chase';
  // Buffers.
  private readonly cx = new Float64Array(64);
  private readonly cy = new Float64Array(64);
  private readonly cz = new Float64Array(64);
  private readonly tx = new Float64Array(64);
  private readonly ty = new Float64Array(64);
  private readonly tz = new Float64Array(64);
  private readonly sx = new Float64Array(64);
  private readonly sy = new Float64Array(64);
  private readonly wv = new Float64Array(3 * 64);
  private readonly near: number[] = [];
  private readonly farMarks: number[] = [];
  private items: Array<{ d: number; k: number; i: number }> = [];
  private itemCount = 0;
  private readonly rgbCache = new Map<number, string>();
  private readonly colorRgb = new Map<string, [number, number, number]>();
  private craft: { key: string; name: string; radius: number; solids: Solid[]; parts: CraftShape['parts'] } | null = null;
  private toasts: Array<{ text: string; at: number }> = [];
  private helpUntil = 0;
  radarRange = 2000;
  /** 0.4 .. 1: range, facets and detail. */
  quality = 1;
  private msAvg = 16;
  private lastStats: RenderStats = { pieces: 0, ms: 0, quality: 1, stages: [] };
  showStats = false;
  private viewed: TvFrame | null = null;
  /**
   * The planet's block summary (from the worker that planned it): which road segments exist,
   * read the same way the road graph reads it (src/sim/roadRules.ts). No roads until it comes.
   */
  roads: Uint8Array | null = null;
  /** The game's own timing (from its worker), for the stats line. */
  simLine = '';
  /** Shown at the bottom of the help card (how the pad is linked). */
  linkLine = '';

  constructor(private readonly canvas: HTMLCanvasElement, private readonly store: StructureStore) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
  }

  /** Forget the architecture's camera smoothing (a new game started). */
  restart(): void {
    this.camInit = false;
    this.craft = null;
  }

  get stats(): RenderStats {
    return this.lastStats;
  }

  resize(w: number, h: number): void {
    this.W = w;
    this.H = h;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  cycleCamera(): void {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.toast(this.mode === 'chase' ? 'Camera: chase' : this.mode === 'far' ? 'Camera: far chase' : 'Camera: overhead');
  }

  toast(text: string, now = performance.now() / 1000): void {
    this.toasts.push({ text, at: now });
    if (this.toasts.length > 4) this.toasts.shift();
  }

  /** Apply the frame's view actions (camera, help, map, radar range). */
  private view(f: TvFrame, now: number): void {
    for (const a of f.ui) {
      if (a === 'camera') this.cycleCamera();
      else if (a === 'map') { this.mode = this.mode === 'overhead' ? 'chase' : 'overhead'; }
      else if (a === 'help') this.helpUntil = this.helpUntil > now ? 0 : now + 12;
      else if (a === 'radarRange') { this.radarRange = this.radarRange >= 4000 ? 1000 : this.radarRange * 2; this.toast(`Radar ${this.radarRange / 1000} km`, now); }
      else if (a === 'mute') this.toast('The TV view has no sound yet', now);
    }
    for (const n of f.notes) this.toast(n, now);
  }

  // --- Colour helpers

  private rgb(r: number, g: number, b: number, a = 1): string {
    const R = Math.max(0, Math.min(255, r | 0)), G = Math.max(0, Math.min(255, g | 0)), B = Math.max(0, Math.min(255, b | 0));
    const A = Math.max(0, Math.min(15, Math.round(a * 15)));
    const key = ((R * 256 + G) * 256 + B) * 16 + A;
    let s = this.rgbCache.get(key);
    if (!s) {
      s = A === 15 ? `rgb(${R},${G},${B})` : `rgba(${R},${G},${B},${(A / 15).toFixed(2)})`;
      if (this.rgbCache.size > 20000) this.rgbCache.clear();
      this.rgbCache.set(key, s);
    }
    return s;
  }

  private col(hex: string): [number, number, number] {
    let c = this.colorRgb.get(hex);
    if (!c) this.colorRgb.set(hex, (c = hexRgb(hex)));
    return c;
  }

  /** A dark surface lit by orientation and hazed by distance. */
  private surface(base: [number, number, number], nx: number, ny: number, nz: number, d: number, bright = 1): string {
    const k = (0.5 + 0.5 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2])) * bright;
    const f = this.fog(d);
    return this.rgb(base[0] * k * (1 - f) + FOG[0] * f, base[1] * k * (1 - f) + FOG[1] * f, base[2] * k * (1 - f) + FOG[2] * f);
  }

  private fog(d: number): number {
    return smooth(this.range() * 0.25, this.range() * 1.15, d) * 0.92;
  }

  private range(): number {
    return 450 + 750 * this.quality;
  }

  // --- Camera and projection

  private setCamera(f: TvFrame, dt: number): void {
    const [qx, qy, qz, qw] = f.me.q;
    // Nose direction (-Z in the body frame).
    const nx = -2 * (qx * qz + qw * qy), ny = -2 * (qy * qz - qw * qx), nz = -(1 - 2 * (qx * qx + qy * qy));
    // Right wing (+X) for the bank.
    const wy = 2 * (qx * qy + qw * qz);
    const foot = f.me.foot;
    const radius = foot ? 2.4 : Math.max(2, this.craft?.radius ?? 6);
    const tx = foot ? foot[0] : f.me.p[0], ty = foot ? foot[1] + 1 : f.me.p[1], tz = foot ? foot[2] : f.me.p[2];
    const ground = f.hud.profile === 'ground' || !!foot;
    let yaw = foot ? foot[3] : Math.atan2(nx, -nz);
    if (!Number.isFinite(yaw)) yaw = this.camYaw;
    const pitchNose = Math.asin(Math.max(-1, Math.min(1, ny)));
    const k = 1 - Math.exp(-dt * (this.mode === 'overhead' ? 3 : 4.5));
    if (!this.camInit) { this.camYaw = yaw; this.camInit = true; }
    let dy = yaw - this.camYaw;
    dy -= Math.PI * 2 * Math.round(dy / (Math.PI * 2));
    this.camYaw += dy * k;
    let pitch: number, dist: number, roll = 0;
    const speed = Math.hypot(...f.me.vel);
    if (this.mode === 'overhead') {
      pitch = -1.35;
      dist = 160 + Math.min(900, Math.max(0, f.hud.alt) * 0.6) + speed * 1.5;
    } else {
      const far = this.mode === 'far' ? 2.6 : 1;
      dist = (radius * 2.8 + 7 + Math.min(25, speed * 0.12)) * far;
      pitch = -0.2 - (ground ? 0.06 : 0) + (ground ? 0 : pitchNose * 0.55);
      // Bank with the craft (half as far): a right bank tilts the right axis down.
      roll = ground ? 0 : Math.asin(Math.max(-1, Math.min(1, wy))) * 0.5;
    }
    this.camPitch += (pitch - this.camPitch) * k;
    this.camRoll += (roll - this.camRoll) * k;
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch), cyw = Math.cos(this.camYaw), syw = Math.sin(this.camYaw);
    this.fx = syw * cp; this.fy = sp; this.fz = -cyw * cp;
    let rx = cyw, ry = 0, rz = syw;
    let ux = ry * this.fz - rz * this.fy, uy = rz * this.fx - rx * this.fz, uz = rx * this.fy - ry * this.fx;
    // Roll the right and up axes about the view direction.
    const cr = Math.cos(this.camRoll), sr = Math.sin(this.camRoll);
    [rx, ry, rz, ux, uy, uz] = [rx * cr + ux * sr, ry * cr + uy * sr, rz * cr + uz * sr, ux * cr - rx * sr, uy * cr - ry * sr, uz * cr - rz * sr];
    this.rx = rx; this.ry = ry; this.rz = rz; this.ux = ux; this.uy = uy; this.uz = uz;
    this.ex = tx - this.fx * dist;
    this.ey = Math.max(1.2, ty + radius * 0.35 - this.fy * dist);
    this.ez = tz - this.fz * dist;
    const fov = this.mode === 'overhead' ? 55 : 62;
    this.F = (this.H / 2) / Math.tan((fov * Math.PI) / 360);
  }

  /** World to camera space (x right, y up, z depth). */
  private toCam(x: number, y: number, z: number, i: number): void {
    const dx = x - this.ex, dy = y - this.ey, dz = z - this.ez;
    this.cx[i] = dx * this.rx + dy * this.ry + dz * this.rz;
    this.cy[i] = dx * this.ux + dy * this.uy + dz * this.uz;
    this.cz[i] = dx * this.fx + dy * this.fy + dz * this.fz;
  }

  /** Clip the camera-space polygon cx/cy/cz[0..n) at the near plane and project; returns the point count. */
  private clipProject(n: number): number {
    let m = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ai = this.cz[i] >= NEAR, aj = this.cz[j] >= NEAR;
      if (ai) { this.tx[m] = this.cx[i]; this.ty[m] = this.cy[i]; this.tz[m] = this.cz[i]; m++; }
      if (ai !== aj) {
        const t = (NEAR - this.cz[i]) / (this.cz[j] - this.cz[i]);
        this.tx[m] = this.cx[i] + (this.cx[j] - this.cx[i]) * t;
        this.ty[m] = this.cy[i] + (this.cy[j] - this.cy[i]) * t;
        this.tz[m] = NEAR;
        m++;
      }
      if (m >= 60) break;
    }
    const hw = this.W / 2, hh = this.H / 2, F = this.F;
    for (let i = 0; i < m; i++) {
      this.sx[i] = hw + (F * this.tx[i]) / this.tz[i];
      this.sy[i] = hh - (F * this.ty[i]) / this.tz[i];
    }
    return m;
  }

  /** Fill (and optionally stroke) the polygon of world points wv[0..n). */
  private polygon(n: number, fill: string | null, stroke: string | null = null, width = 1): boolean {
    for (let i = 0; i < n; i++) this.toCam(this.wv[i * 3], this.wv[i * 3 + 1], this.wv[i * 3 + 2], i);
    const m = this.clipProject(n);
    if (m < 3) return false;
    const g = this.ctx;
    g.beginPath();
    g.moveTo(this.sx[0], this.sy[0]);
    for (let i = 1; i < m; i++) g.lineTo(this.sx[i], this.sy[i]);
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = width; g.stroke(); }
    return true;
  }

  /** A world-space line (clipped at the near plane). */
  private line(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    this.toCam(x0, y0, z0, 0);
    this.toCam(x1, y1, z1, 1);
    let az = this.cz[0], bz = this.cz[1];
    if (az < NEAR && bz < NEAR) return false;
    let ax = this.cx[0], ay = this.cy[0], bx = this.cx[1], by = this.cy[1];
    if (az < NEAR) { const t = (NEAR - az) / (bz - az); ax += (bx - ax) * t; ay += (by - ay) * t; az = NEAR; }
    if (bz < NEAR) { const t = (NEAR - bz) / (az - bz); bx += (ax - bx) * t; by += (ay - by) * t; bz = NEAR; }
    const hw = this.W / 2, hh = this.H / 2, F = this.F;
    this.ctx.moveTo(hw + (F * ax) / az, hh - (F * ay) / az);
    this.ctx.lineTo(hw + (F * bx) / bz, hh - (F * by) / bz);
    return true;
  }

  /** Projected screen point (null behind the camera). */
  private project(x: number, y: number, z: number): [number, number, number] | null {
    this.toCam(x, y, z, 0);
    if (this.cz[0] < NEAR) return null;
    return [this.W / 2 + (this.F * this.cx[0]) / this.cz[0], this.H / 2 - (this.F * this.cy[0]) / this.cz[0], this.cz[0]];
  }

  /** Is a sphere at (x, y, z) of radius r possibly on screen? Also its depth. */
  private inView(x: number, y: number, z: number, r: number): number {
    const dx = x - this.ex, dy = y - this.ey, dz = z - this.ez;
    const d = dx * this.fx + dy * this.fy + dz * this.fz;
    if (d < -r) return -1;
    const sx = Math.abs(dx * this.rx + dy * this.ry + dz * this.rz), sy = Math.abs(dx * this.ux + dy * this.uy + dz * this.uz);
    const lim = Math.max(d, 0.1) / this.F;
    if (sx - r > (this.W / 2 + 40) * lim + r || sy - r > (this.H / 2 + 40) * lim + r) return -1;
    return Math.hypot(dx, dy, dz);
  }

  // --- Solids

  /**
   * Draw a convex solid transformed by rotation (quaternion) and translation, scaled by `scale`.
   * Faces turned away are skipped; fill from `fillOf(face normal world, distance)`.
   */
  private solid(s: Solid, px: number, py: number, pz: number, q: readonly number[] | null, yaw: number, scale: number,
    fillOf: (nx: number, ny: number, nz: number) => string | null, stroke: string | null, width = 1): void {
    const n = s.v.length / 3;
    const W = this.wvSolid.length < n * 3 ? (this.wvSolid = new Float64Array(n * 3)) : this.wvSolid;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const rot = (x: number, y: number, z: number, out: Float64Array, o: number) => {
      if (q) {
        const [qx, qy, qz, qw] = q;
        const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
        out[o] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
        out[o + 1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
        out[o + 2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
      } else {
        // Yaw about +Y, as three.js turns things (a rider's or a Bit's yaw).
        out[o] = x * cy + z * sy;
        out[o + 1] = y;
        out[o + 2] = -x * sy + z * cy;
      }
    };
    for (let i = 0; i < n; i++) {
      rot(s.v[i * 3] * scale, s.v[i * 3 + 1] * scale, s.v[i * 3 + 2] * scale, W, i * 3);
      W[i * 3] += px; W[i * 3 + 1] += py; W[i * 3 + 2] += pz;
    }
    const nn = this.nrm;
    for (const f of s.faces) {
      rot(f.n[0], f.n[1], f.n[2], nn, 0);
      const a = f.i[0];
      if ((this.ex - W[a * 3]) * nn[0] + (this.ey - W[a * 3 + 1]) * nn[1] + (this.ez - W[a * 3 + 2]) * nn[2] <= 0) continue;
      const fill = fillOf(nn[0], nn[1], nn[2]);
      const m = Math.min(f.i.length, 60);
      for (let k = 0; k < m; k++) {
        const id = f.i[k];
        this.wv[k * 3] = W[id * 3]; this.wv[k * 3 + 1] = W[id * 3 + 1]; this.wv[k * 3 + 2] = W[id * 3 + 2];
      }
      this.polygon(m, fill, stroke, width);
    }
  }
  private wvSolid = new Float64Array(3 * 256);

  /** Four world points into wv (a quad), without an array per face. */
  private v4(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number): void {
    const W = this.wv;
    W[0] = ax; W[1] = ay; W[2] = az; W[3] = bx; W[4] = by; W[5] = bz; W[6] = cx; W[7] = cy; W[8] = cz; W[9] = dx; W[10] = dy; W[11] = dz;
  }
  private readonly nrm = new Float64Array(3);

  // --- The world

  private sky(): void {
    const g = this.ctx, W = this.W, H = this.H;
    // Horizon: where two far points ahead (left and right) land.
    const fl = Math.hypot(this.fx, this.fz) || 1;
    const hx = this.fx / fl, hz = this.fz / fl;
    const a = this.project(this.ex + (hx * 0.94 - hz * 0.34) * 1e6, this.ey, this.ez + (hz * 0.94 + hx * 0.34) * 1e6);
    const b = this.project(this.ex + (hx * 0.94 + hz * 0.34) * 1e6, this.ey, this.ez + (hz * 0.94 - hx * 0.34) * 1e6);
    g.fillStyle = GROUND_NEAR;
    g.fillRect(0, 0, W, H);
    if (!a || !b || this.camPitch < -1.2) {
      // Looking down: ground only, hazier toward the top.
      const gr = g.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, GROUND_FAR);
      gr.addColorStop(1, GROUND_NEAR);
      g.fillStyle = gr;
      g.fillRect(0, 0, W, H);
      return;
    }
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const R = Math.hypot(W, H) * 1.5;
    g.save();
    g.translate(mx, my);
    g.rotate(ang);
    const sky = g.createLinearGradient(0, -H * 1.1, 0, 0);
    sky.addColorStop(0, SKY_TOP);
    sky.addColorStop(0.55, SKY_MID);
    sky.addColorStop(0.93, SKY_LOW);
    sky.addColorStop(1, '#3b4f8a');
    g.fillStyle = sky;
    g.fillRect(-R, -R, 2 * R, R);
    const ground = g.createLinearGradient(0, 0, 0, H * 0.9);
    ground.addColorStop(0, GROUND_FAR);
    ground.addColorStop(0.35, '#061230');
    ground.addColorStop(1, GROUND_NEAR);
    g.fillStyle = ground;
    g.fillRect(-R, 0, 2 * R, R);
    // The amber band where the plain meets the sky (p. 15).
    const band = g.createLinearGradient(0, -14, 0, 6);
    band.addColorStop(0, 'rgba(224,138,52,0)');
    band.addColorStop(0.7, 'rgba(224,138,52,0.55)');
    band.addColorStop(1, 'rgba(224,138,52,0)');
    g.fillStyle = band;
    g.fillRect(-R, -14, 2 * R, 20);
    g.fillStyle = HORIZON;
    g.globalAlpha = 0.8;
    g.fillRect(-R, -0.75, 2 * R, 1.5);
    g.globalAlpha = 1;
    g.restore();
  }

  /** The street grid (every road the Navigator drives) and a fine tile grid near the camera. */
  private groundGrid(cx: number, cz: number): void {
    const g = this.ctx;
    const P = CITY.block + CITY.street;
    const R = Math.min(this.range() * 0.85, 1000);
    const i0 = Math.floor((cx - R - CITY.x0) / P), i1 = Math.ceil((cx + R - CITY.x0) / P);
    const j0 = Math.floor((cz - R - CITY.z0) / P), j1 = Math.ceil((cz + R - CITY.z0) / P);
    const hw = CITY.street / 2;
    // Fine grid: tiles on the lots, for a sense of speed.
    if (this.quality > 0.55) {
      const step = P / 4, Rf = Math.min(R, 520);
      g.beginPath();
      for (let x = Math.ceil((cx - Rf) / step) * step; x <= cx + Rf; x += step) this.line(x, 0, cz - Rf, x, 0, cz + Rf);
      for (let z = Math.ceil((cz - Rf) / step) * step; z <= cz + Rf; z += step) this.line(cx - Rf, 0, z, cx + Rf, 0, z);
      g.strokeStyle = 'rgba(40,90,170,0.16)';
      g.lineWidth = 1;
      g.stroke();
    }
    // Road surfaces, then their edges (streets dim, data highways bright).
    const roads: Array<[number, number, number, number, boolean]> = [];
    const sum = this.roads;
    const nodeX = (i: number) => GRID.x0 + i * GRID.pitch, nodeZ = (j: number) => GRID.z0 + j * GRID.pitch;
    if (sum) for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const x = nodeX(i), z = nodeZ(j);
      if (segmentExists(sum, true, i, j, false)) roads.push([x, z, nodeX(i + 1), z, isHighwayLine(j)]);
      if (segmentExists(sum, false, i, j, false)) roads.push([x, z, x, nodeZ(j + 1), isHighwayLine(i)]);
    }
    g.fillStyle = '#050d24';
    for (const [x0, z0, x1, z1] of roads) {
      const ax = x0 === x1;
      if (ax) { this.v4(x0 - hw, 0.02, z0, x0 + hw, 0.02, z0, x0 + hw, 0.02, z1, x0 - hw, 0.02, z1); }
      else { this.v4(x0, 0.02, z0 - hw, x1, 0.02, z0 - hw, x1, 0.02, z0 + hw, x0, 0.02, z0 + hw); }
      this.polygon(4, '#050d24');
    }
    for (const hwy of [false, true]) {
      g.beginPath();
      for (const [x0, z0, x1, z1, h] of roads) {
        if (h !== hwy) continue;
        if (x0 === x1) { this.line(x0 - hw, 0.05, z0, x0 - hw, 0.05, z1); this.line(x0 + hw, 0.05, z0, x0 + hw, 0.05, z1); }
        else { this.line(x0, 0.05, z0 - hw, x1, 0.05, z0 - hw); this.line(x0, 0.05, z0 + hw, x1, 0.05, z0 + hw); }
      }
      g.strokeStyle = hwy ? 'rgba(0,234,255,0.55)' : 'rgba(30,110,190,0.35)';
      g.lineWidth = hwy ? 1.6 : 1;
      g.stroke();
    }
  }

  /** Distant landmarks: the tall structures beyond the draw range, as hazy silhouettes with lit tips. */
  private landmarks(cx: number, cz: number, broken: Set<number>): void {
    const D = this.store.data, g = this.ctx;
    const R0 = this.range(), R1 = 3600;
    this.farMarks.length = 0;
    this.store.landmarks(cx, cz, R1, this.farMarks);
    const list: Array<[number, number]> = [];
    for (const k of this.farMarks) {
      const o = k * PIECE;
      if (broken.has(D[o + 8])) continue;
      const d = Math.hypot(D[o + 1] - cx, D[o + 3] - cz);
      if (d < R0 * 0.9 || d > R1) continue;
      if (this.inView(D[o + 1], D[o + 2], D[o + 3], D[o + 5] / 2 + D[o + 4]) < 0) continue;
      list.push([d, o]);
    }
    // The nearest few hundred are the skyline; the rest are lost in the haze anyway.
    const cap = Math.round(120 + 280 * this.quality);
    if (list.length > cap) list.sort((a, b) => a[0] - b[0]).length = cap;
    list.sort((a, b) => b[0] - a[0]);
    for (const [d, o] of list) {
      const x = D[o + 1], y = D[o + 2], z = D[o + 3], hy = D[o + 5] / 2;
      const top = this.project(x, y + hy, z), bot = this.project(x, y - hy, z);
      if (!top || !bot) continue;
      const w = Math.max(1, (this.F * Math.max(D[o + 4], D[o + 6])) / top[2]) * (D[o] === 3 ? 0.6 : 1);
      const f = smooth(R0, R1, d);
      g.fillStyle = this.rgb(10 + 8 * f, 24 + 12 * f, 66 + 20 * f, 0.9 - 0.5 * f);
      g.fillRect(top[0] - w / 2, top[1], w, Math.max(1, bot[1] - top[1]));
      const c = this.col(this.store.colors[D[o + 9]] ?? '#36e2ff');
      g.fillStyle = this.rgb(c[0], c[1], c[2], 0.8 - 0.5 * f);
      g.fillRect(top[0] - Math.max(1, w * 0.35), top[1] - 1, Math.max(2, w * 0.7), 2);
    }
  }

  private pushItem(d: number, k: number, i: number): void {
    let it = this.items[this.itemCount];
    if (!it) this.items[this.itemCount] = it = { d: 0, k: 0, i: 0 };
    it.d = d;
    it.k = k;
    it.i = i;
    this.itemCount++;
  }

  /** One structure piece. */
  private piece(o: number, d: number): void {
    const D = this.store.data;
    const shape = D[o], x = D[o + 1], y = D[o + 2], z = D[o + 3], sx = D[o + 4], sy = D[o + 5], sz = D[o + 6], taper = D[o + 7];
    const lit = this.col(this.store.colors[D[o + 9]] ?? '#36e2ff');
    const h = smooth(0, 220, y + sy / 2);
    const base: [number, number, number] = [
      STEEL_LOW[0] + (STEEL_HIGH[0] - STEEL_LOW[0]) * h, STEEL_LOW[1] + (STEEL_HIGH[1] - STEEL_LOW[1]) * h, STEEL_LOW[2] + (STEEL_HIGH[2] - STEEL_LOW[2]) * h,
    ];
    const f = this.fog(d);
    const size = (this.F * Math.max(sx, sy, sz)) / Math.max(1, d);
    const g = this.ctx;
    const y0 = y - sy / 2, y1 = y + sy / 2;
    if (size < 5) {
      // Far and small: a hazy block.
      const top = this.project(x, y1, z), bot = this.project(x, y0, z);
      if (!top || !bot) return;
      const w = Math.max(1, (this.F * Math.max(sx, sz)) / top[2]);
      g.fillStyle = this.surface(base, 0, 0.2, 1, d);
      g.fillRect(top[0] - w / 2, top[1], w, Math.max(1, bot[1] - top[1]));
      return;
    }
    const rimAlpha = (1 - f) * (size > 30 ? 0.85 : 0.55);
    const rim = rimAlpha > 0.05 ? this.rgb(lit[0], lit[1], lit[2], rimAlpha) : null;
    const W = this.wv;
    if (shape === 0) {
      const hx = sx / 2, hz = sz / 2;
      // Sides facing the camera.
      const sides: Array<[number, number, number, number, number, number]> = [
        [x - hx, z - hz, x + hx, z - hz, 0, -1], [x + hx, z - hz, x + hx, z + hz, 1, 0],
        [x + hx, z + hz, x - hx, z + hz, 0, 1], [x - hx, z + hz, x - hx, z - hz, -1, 0],
      ];
      for (const [ax, az, bx, bz, nx, nz] of sides) {
        if ((this.ex - ax) * nx + (this.ez - az) * nz <= 0) continue;
        this.v4(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
        this.polygon(4, this.surface(base, nx, 0, nz, d));
      }
      if (this.ey > y1) {
        this.v4(x - hx, y1, z - hz, x + hx, y1, z - hz, x + hx, y1, z + hz, x - hx, y1, z + hz);
        this.polygon(4, this.surface(base, 0, 1, 0, d, 1.15), rim, size > 60 ? 1.5 : 1);
      } else if (rim) {
        g.beginPath();
        this.line(x - hx, y1, z - hz, x + hx, y1, z - hz); this.line(x + hx, y1, z - hz, x + hx, y1, z + hz);
        this.line(x + hx, y1, z + hz, x - hx, y1, z + hz); this.line(x - hx, y1, z + hz, x - hx, y1, z - hz);
        g.strokeStyle = rim; g.lineWidth = 1; g.stroke();
      }
      return;
    }
    // Round shapes: prisms (octagons stay octagons), cones taper to `taper` at the top.
    const sides = shape === 1 ? 8 : size > 120 && this.quality > 0.7 ? 14 : size > 40 ? 10 : 6;
    const r0x = sx / 2, r0z = sz / 2, k1 = shape === 3 ? taper : 1;
    const off = shape === 1 ? Math.PI / 8 : 0;
    for (let s = 0; s < sides; s++) {
      const a0 = off + (s / sides) * Math.PI * 2, a1 = off + ((s + 1) / sides) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const nx = Math.cos(am), nz = Math.sin(am);
      const bx0 = x + Math.cos(a0) * r0x, bz0 = z + Math.sin(a0) * r0z, bx1 = x + Math.cos(a1) * r0x, bz1 = z + Math.sin(a1) * r0z;
      if ((this.ex - (bx0 + bx1) / 2) * nx + (this.ez - (bz0 + bz1) / 2) * nz <= -Math.abs(1 - k1) * Math.max(r0x, r0z)) continue;
      const tx0 = x + Math.cos(a0) * r0x * k1, tz0 = z + Math.sin(a0) * r0z * k1, tx1 = x + Math.cos(a1) * r0x * k1, tz1 = z + Math.sin(a1) * r0z * k1;
      this.v4(bx0, y0, bz0, bx1, y0, bz1, tx1, y1, tz1, tx0, y1, tz0);
      const slope = shape === 3 ? (1 - k1) * Math.max(r0x, r0z) / Math.max(1, sy) : 0;
      this.polygon(4, this.surface(base, nx, slope, nz, d));
    }
    if (k1 > 0.02) {
      for (let s = 0; s < sides; s++) {
        const a = off + (s / sides) * Math.PI * 2;
        W[s * 3] = x + Math.cos(a) * r0x * k1; W[s * 3 + 1] = y1; W[s * 3 + 2] = z + Math.sin(a) * r0z * k1;
      }
      if (this.ey > y1) this.polygon(sides, this.surface(base, 0, 1, 0, d, 1.15), rim, 1);
      else if (rim) this.polygon(sides, null, rim, 1);
    } else if (rim) {
      // A spire: its lit tip (p. 40).
      const tip = this.project(x, y1, z);
      if (tip) { g.fillStyle = rim; g.fillRect(tip[0] - 1.5, tip[1] - 1.5, 3, 3); }
    }
  }

  // --- Frame

  draw(f: TvFrame, dt: number, sinceFrame = 0): void {
    const t0 = performance.now();
    const now = t0 / 1000;
    // View actions and toasts once per frame, however often it is drawn.
    if (f !== this.viewed) { this.viewed = f; this.view(f, now); }
    // Between frames (the phone sends ~15 a second), carry the player on along its velocity.
    const lead = Math.min(0.12, Math.max(0, sinceFrame));
    if (lead > 0 && !f.me.foot) {
      f = { ...f, me: { ...f.me, p: [f.me.p[0] + f.me.vel[0] * lead, f.me.p[1] + f.me.vel[1] * lead, f.me.p[2] + f.me.vel[2] * lead] } };
    }
    if (f.craft && f.craft.key !== this.craft?.key) {
      this.craft = { key: f.craft.key, name: f.craft.name, radius: f.craft.radius, parts: f.craft.parts, solids: f.craft.parts.map(partSolid) };
    }
    this.setCamera(f, dt);
    const g = this.ctx;
    g.globalCompositeOperation = 'source-over';
    g.lineJoin = 'round';
    this.sky();
    const tSky = performance.now();
    const cx = f.me.foot ? f.me.foot[0] : f.me.p[0], cz = f.me.foot ? f.me.foot[2] : f.me.p[2];
    // Look ahead of the vehicle: what is in front matters most.
    const ax = cx + this.fx * this.range() * 0.35, az = cz + this.fz * this.range() * 0.35;
    const broken = new Set(f.broken);
    this.landmarks(ax, az, broken);
    this.groundGrid(this.mode === 'overhead' ? cx : ax * 0.5 + cx * 0.5, this.mode === 'overhead' ? cz : az * 0.5 + cz * 0.5);
    // Craters on the ground.
    for (let i = 0; i < f.craters.length; i += S.crater) {
      const [x, z, r, c] = [f.craters[i], f.craters[i + 1], f.craters[i + 2], f.craters[i + 3]];
      if (this.inView(x, 0, z, r) < 0) continue;
      const W = this.wv;
      for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; W[k * 3] = x + Math.cos(a) * r; W[k * 3 + 1] = 0.1; W[k * 3 + 2] = z + Math.sin(a) * r; }
      const lc = this.col(f.pal[c] ?? '#ff5a3c');
      this.polygon(16, '#010208', this.rgb(lc[0], lc[1], lc[2], 0.8), 1.5);
    }

    // Everything solid, far to near.
    const tGround = performance.now();
    this.itemCount = 0;
    const D = this.store.data;
    const R = this.range();
    this.near.length = 0;
    this.store.near(ax, az, R * 0.75 + 200, this.near);
    let pieces = 0;
    const minPx = 1.2 + (1 - this.quality) * 2.5;
    for (const k of this.near) {
      const o = k * PIECE;
      if (broken.has(D[o + 8])) continue;
      const r = 0.5 * Math.hypot(D[o + 4], D[o + 5], D[o + 6]);
      const d = this.inView(D[o + 1], D[o + 2], D[o + 3], r);
      if (d < 0 || d > R) continue;
      if ((this.F * r * 2) / Math.max(1, d) < minPx) continue;
      this.pushItem(d, 0, o);
      pieces++;
    }
    const add = (list: number[], stride: number, kind: number, y = (i: number) => list[i + 1], r = 3) => {
      for (let i = 0; i < list.length; i += stride) {
        const d = this.inView(list[i], y(i), list[i + 2], r);
        if (d >= 0 && d < R) this.pushItem(d, kind, i);
      }
    };
    add(f.blocks, S.block, 1, undefined, 4);
    for (let i = 0; i < f.riders.length; i += S.rider) {
      const d = this.inView(f.riders[i], 0.6, f.riders[i + 1], 2);
      if (d >= 0 && d < R) this.pushItem(d, 2, i);
    }
    for (let i = 0; i < f.walls.length; i += S.wall) {
      const mx = (f.walls[i] + f.walls[i + 2]) / 2, mz = (f.walls[i + 1] + f.walls[i + 3]) / 2;
      const r = Math.hypot(f.walls[i + 2] - f.walls[i], f.walls[i + 3] - f.walls[i + 1]) / 2 + f.walls[i + 5];
      const d = this.inView(mx, (f.walls[i + 4] + f.walls[i + 5]) / 2, mz, r);
      if (d >= 0 && d < R) this.pushItem(d, 3, i);
    }
    add(f.flyers, S.flyer, 4, undefined, 8);
    add(f.bits, S.bit, 5, undefined, 1);
    add(f.progs, S.prog, 6, undefined, 1);
    add(f.turrets, S.turret, 7, undefined, 4);
    if (!f.me.dead && this.craft) {
      if (f.me.foot) {
        const d = this.inView(f.me.foot[0], f.me.foot[1], f.me.foot[2], 1);
        if (d >= 0) this.pushItem(d, 9, 0);
      }
      const hidden = new Set(f.hide);
      for (let i = 0; i < this.craft.parts.length; i++) {
        const p = this.craft.parts[i];
        if (hidden.has(p.id)) continue;
        const w = this.bodyToWorld(f, p.p[0], p.p[1], p.p[2]);
        const d = this.inView(w[0], w[1], w[2], 4);
        if (d >= 0) this.pushItem(d - 0.01, 8, i);
      }
    }
    const items = this.items;
    const n = this.itemCount;
    const order = items.slice(0, n).sort((a, b) => b.d - a.d);
    for (const it of order) this.drawItem(f, it.k, it.i, it.d, now);

    // Light: shots, explosions, blasts (added on top).
    const tSolid = performance.now();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    for (let i = 0; i < f.shots.length; i += S.shot) {
      const [x, y, z, vx, vy, vz, c] = f.shots.slice(i, i + S.shot);
      const lc = this.col(f.pal[c] ?? '#ffffff');
      g.beginPath();
      if (this.line(x - vx * 0.03, y - vy * 0.03, z - vz * 0.03, x, y, z)) {
        g.strokeStyle = this.rgb(lc[0], lc[1], lc[2], 0.95);
        g.lineWidth = 2;
        g.stroke();
      }
    }
    for (let i = 0; i < f.booms.length; i += S.boom) {
      const [x, y, z, age, radius, c] = f.booms.slice(i, i + S.boom);
      const p = this.project(x, y, z);
      if (!p) continue;
      const big = radius > 300;
      const life = big ? 8 : 2.5;
      const rr = (this.F * radius * Math.min(1, 0.25 + age / (big ? 3 : 0.6))) / p[2];
      const a = Math.max(0, 1 - age / life);
      const lc = this.col(f.pal[c] ?? '#ff9a3c');
      const gr = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], Math.max(2, rr));
      gr.addColorStop(0, this.rgb(255, 250, 230, a * (age < 0.3 ? 1 : 0.6)));
      gr.addColorStop(0.4, this.rgb(lc[0], lc[1], lc[2], a * 0.6));
      gr.addColorStop(1, this.rgb(lc[0], lc[1], lc[2], 0));
      g.fillStyle = gr;
      g.beginPath();
      g.arc(p[0], p[1], Math.max(2, rr), 0, Math.PI * 2);
      g.fill();
      if (big && age < 0.8) {
        g.fillStyle = this.rgb(255, 248, 230, (0.8 - age) * 0.6);
        g.fillRect(0, 0, this.W, this.H);
      }
    }
    g.globalCompositeOperation = 'source-over';
    const tLight = performance.now();
    this.hud(f, now);
    const tEnd = performance.now();
    const ms = tEnd - t0;
    this.adapt(ms);
    const r = (v: number) => Math.round(v * 10) / 10;
    this.lastStats = { pieces, ms, quality: this.quality, stages: [r(tSky - t0), r(tGround - tSky), r(tSolid - tGround), r(tLight - tSolid), r(tEnd - tLight)] };
    if (this.showStats) {
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(this.W - 470, 8, 462, 40);
      g.fillStyle = '#9fd8ff';
      g.font = '14px ui-monospace, monospace';
      g.textAlign = 'right';
      g.fillText(`${ms.toFixed(1)} ms · ${pieces} pieces · q ${this.quality.toFixed(2)}`, this.W - 14, 24);
      g.fillText(`sky ${this.lastStats.stages.join(' · ')} hud${this.simLine ? ` · ${this.simLine}` : ''}`, this.W - 14, 42);
    }
  }

  /** Quality follows the draw time: under ~16 ms leaves room for 30 fps on a slow receiver. */
  private adapt(ms: number): void {
    this.msAvg += (ms - this.msAvg) * 0.05;
    if (this.msAvg > 16) this.quality = Math.max(0.35, this.quality - 0.01);
    else if (this.msAvg < 9) this.quality = Math.min(1, this.quality + 0.004);
  }

  private bodyToWorld(f: TvFrame, x: number, y: number, z: number): [number, number, number] {
    const [qx, qy, qz, qw] = f.me.q;
    const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    return [
      ix * qw + iw * -qx + iy * -qz - iz * -qy + f.me.p[0],
      iy * qw + iw * -qy + iz * -qx - ix * -qz + f.me.p[1],
      iz * qw + iw * -qz + ix * -qy - iy * -qx + f.me.p[2],
    ];
  }

  private drawItem(f: TvFrame, k: number, i: number, d: number, now: number): void {
    const pal = (c: number, fallback = '#36e2ff') => this.col(f.pal[c] ?? fallback);
    switch (k) {
      case 0: this.piece(i, d); break;
      case 1: {
        const [x, y, z, s, c] = f.blocks.slice(i, i + S.block);
        const lc = pal(c);
        const edge = this.rgb(lc[0], lc[1], lc[2], 0.35 * (1 - this.fog(d)));
        this.solid(BLOCK_SOLID, x, y, z, null, 0, s, (nx, ny, nz) => this.surface(STEEL_HIGH, nx, ny, nz, d), edge);
        break;
      }
      case 2: {
        const [x, z, yaw, c, fade] = f.riders.slice(i, i + S.rider);
        const lc = pal(c);
        const edge = this.rgb(lc[0], lc[1], lc[2], 0.9 * fade);
        this.solid(CYCLE_SOLID, x, 0.6, z, null, yaw, 1, (nx, ny, nz) => (ny > 0.5 ? this.rgb(lc[0] * 0.5, lc[1] * 0.5, lc[2] * 0.5, fade) : this.surface([10, 16, 40], nx, ny, nz, d)), edge, 1.2);
        break;
      }
      case 3: {
        const [x0, z0, x1, z1, b, t, c, a] = f.walls.slice(i, i + S.wall);
        const lc = pal(c);
        this.v4(x0, b, z0, x1, b, z1, x1, t, z1, x0, t, z0);
        const fa = a * (1 - this.fog(d) * 0.7);
        this.polygon(4, this.rgb(lc[0], lc[1], lc[2], 0.32 * fa));
        this.ctx.beginPath();
        if (this.line(x0, t, z0, x1, t, z1)) {
          this.ctx.strokeStyle = this.rgb(Math.min(255, lc[0] + 90), Math.min(255, lc[1] + 90), Math.min(255, lc[2] + 90), 0.95 * fa);
          this.ctx.lineWidth = 2;
          this.ctx.stroke();
        }
        break;
      }
      case 4: {
        const [x, y, z, heading, pitch, bank, c, r, flags] = f.flyers.slice(i, i + S.flyer);
        const lc = pal(c);
        // Heading (0 = -Z, clockwise), pitch, bank as a quaternion: yaw · pitch · roll.
        const q = eulerQuat(-heading, pitch, -bank);
        const edge = this.rgb(lc[0], lc[1], lc[2], flags & 2 ? 1 : 0.75);
        this.solid(FLYER_SOLID, x, y, z, q, 0, r, (nx, ny, nz) => this.surface(flags & 1 ? [40, 10, 12] : [12, 20, 50], nx, ny, nz, d), edge, 1.4);
        break;
      }
      case 5: {
        const [x, y, z, yaw, si, c, r] = f.bits.slice(i, i + S.bit);
        const state = BIT_STATES[si] ?? 'idle1';
        const lc = pal(c, '#3d7cff');
        if (d > 90) {
          const p = this.project(x, y, z);
          if (p) { const s = Math.max(1.5, (this.F * r) / p[2]); this.ctx.fillStyle = this.rgb(lc[0], lc[1], lc[2]); this.ctx.beginPath(); this.ctx.moveTo(p[0], p[1] - s); this.ctx.lineTo(p[0] + s * 0.7, p[1]); this.ctx.lineTo(p[0], p[1] + s); this.ctx.lineTo(p[0] - s * 0.7, p[1]); this.ctx.fill(); }
          break;
        }
        const spin = yaw + now * Math.PI * 2 * (state === 'yes' || state === 'no' ? 0.6 : 0.18);
        this.solid(BIT_SOLIDS[state], x, y, z, null, spin, r, (nx, ny, nz) => {
          const k2 = 0.55 + 0.45 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
          return this.rgb(lc[0] * k2, lc[1] * k2, lc[2] * k2);
        }, null);
        break;
      }
      case 6: {
        const [x, y, z, yaw, st, c] = f.progs.slice(i, i + S.prog);
        const lc = st === 1 ? this.col('#ffe14a') : st === 2 ? this.col('#ff3b30') : pal(c);
        this.solid(PROGRAM_SOLID, x, y, z, null, yaw, 1.1, (nx, ny, nz) => this.surface([14, 16, 30], nx, ny, nz, d), this.rgb(lc[0], lc[1], lc[2], 0.9), 1.2);
        break;
      }
      case 7: {
        const [x, y, z, c, firing] = f.turrets.slice(i, i + S.turret);
        const lc = pal(c, '#ff3b30');
        this.solid(BLOCK_SOLID, x, y + 1.2, z, null, 0, 2.4, (nx, ny, nz) => this.surface([30, 12, 14], nx, ny, nz, d), this.rgb(lc[0], lc[1], lc[2], firing ? 1 : 0.6), firing ? 2 : 1);
        break;
      }
      case 8: {
        const p = this.craft!.parts[i], s = this.craft!.solids[i];
        const c = this.col(p.c);
        const team = this.col(f.hud.team);
        const edge = this.rgb(team[0], team[1], team[2], p.lit ? 0.9 : 0.4);
        this.solid(s, f.me.p[0], f.me.p[1], f.me.p[2], f.me.q, 0, 1,
          (nx, ny, nz) => (p.lit ? this.rgb(c[0], c[1], c[2]) : this.surface([Math.max(14, c[0]), Math.max(20, c[1]), Math.max(46, c[2])], nx, ny, nz, d, 1.3)), edge, p.lit ? 1.4 : 1);
        break;
      }
      case 9: {
        const foot = f.me.foot!;
        const lc = this.col(f.me.bit);
        this.solid(BIT_SOLIDS.idle1, foot[0], foot[1], foot[2], null, foot[3] + now * 1.1, 0.5, (nx, ny, nz) => {
          const k2 = 0.55 + 0.45 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
          return this.rgb(lc[0] * k2, lc[1] * k2, lc[2] * k2);
        }, this.rgb(255, 255, 255, 0.5));
        break;
      }
    }
  }

  // --- HUD: big, few, readable from the sofa.

  private hud(f: TvFrame, now: number): void {
    const g = this.ctx, W = this.W, H = this.H, h = f.hud;
    const s = Math.max(0.75, Math.min(1.6, H / 720));
    const team = this.col(h.team);
    const tc = this.rgb(team[0], team[1], team[2]);
    const font = (px: number, weight = 600) => `${weight} ${Math.round(px * s)}px "Segoe UI", Roboto, system-ui, sans-serif`;
    const safe = Math.round(36 * s); // TV overscan margin
    g.textBaseline = 'alphabetic';
    // Bottom strip: the readouts for this vehicle (src/hud/profiles.ts).
    const ui = PROFILE_UI[h.profile];
    const cells: Array<[string, string]> = [];
    if (h.profile !== 'foot') {
      cells.push([ui.speedLabel, `${Math.round(h.spd * 1.944)}`]);
      if (h.profile !== 'ground') cells.push(['ALT', `${Math.round(h.alt)}`]);
      if (h.profile !== 'ground') cells.push(['V/S', `${h.vs >= 0 ? '+' : ''}${h.vs.toFixed(0)}`]);
      cells.push(['HDG', `${Math.round(((h.hdg % 360) + 360) % 360).toString().padStart(3, '0')}`]);
      if (ui.lever) cells.push([ui.lever, `${Math.round(h.thr * 100)}`]);
      if (h.fuel !== null && h.profile === 'ground') cells.push(['FUEL', `${Math.round(h.fuel * 100)}`]);
      if (h.mach > 0.8) cells.push(['MACH', h.mach.toFixed(2)]);
    }
    const cw = 128 * s;
    let x = W / 2 - (cells.length * cw) / 2;
    const y = H - safe;
    if (cells.length) {
      g.fillStyle = 'rgba(2,6,18,0.62)';
      g.fillRect(x - 12 * s, y - 62 * s, cells.length * cw + 24 * s, 74 * s);
      g.fillStyle = tc;
      g.fillRect(x - 12 * s, y - 62 * s, cells.length * cw + 24 * s, 2);
    }
    g.textAlign = 'center';
    for (const [label, value] of cells) {
      g.fillStyle = 'rgba(160,200,255,0.8)';
      g.font = font(14, 600);
      g.fillText(label, x + cw / 2, y - 40 * s);
      g.fillStyle = '#eaf6ff';
      g.font = font(34, 700);
      g.fillText(value, x + cw / 2, y - 4 * s);
      x += cw;
    }
    // Stall / under fire / Navigator warnings above it.
    const warn: string[] = [];
    if (h.stall > 0.6 && !h.gnd && h.profile === 'airplane') warn.push('STALL');
    if (h.underFire) warn.push('UNDER FIRE');
    if (f.me.dead) warn.push('DEREZZED · NEW VEHICLE ON THE PAD MENU');
    if (warn.length) {
      g.font = font(26, 800);
      g.fillStyle = Math.sin(now * 8) > 0 ? '#ff4a3c' : '#ffb347';
      g.fillText(warn.join(' · '), W / 2, y - 84 * s);
    }
    // Top left: the craft and the Navigator; top right: weapons, hostiles, credits.
    g.textAlign = 'left';
    g.font = font(22, 700);
    g.fillStyle = '#eaf6ff';
    g.fillText(f.me.foot ? 'On foot' : this.craft?.name ?? '', safe, safe + 10 * s);
    g.font = font(16, 600);
    g.fillStyle = tc;
    if (h.nav) g.fillText(h.nav, safe, safe + 34 * s);
    g.textAlign = 'right';
    const right: string[] = [];
    if (h.weapons) right.push(h.weapons);
    if (h.hostiles) right.push(`${h.hostiles} HOSTILE`);
    right.push(`${h.credits} CR`);
    g.font = font(18, 700);
    right.forEach((r, k) => { g.fillStyle = r.includes('HOSTILE') ? '#ff6a5c' : '#cfe8ff'; g.fillText(r, W - safe, safe + 10 * s + k * 24 * s); });
    // Toasts.
    this.toasts = this.toasts.filter((t) => now - t.at < 4.5);
    g.textAlign = 'center';
    this.toasts.forEach((t, k) => {
      const a = Math.min(1, (4.5 - (now - t.at)) / 0.6);
      g.font = font(20, 600);
      const w = g.measureText(t.text).width + 36 * s;
      const ty = safe + 70 * s + k * 40 * s;
      g.fillStyle = `rgba(2,6,18,${(0.7 * a).toFixed(2)})`;
      g.fillRect(W / 2 - w / 2, ty - 26 * s, w, 36 * s);
      g.fillStyle = `rgba(234,246,255,${a.toFixed(2)})`;
      g.fillText(t.text, W / 2, ty);
    });
    this.radar(f, W - safe - 96 * s, H - safe - 110 * s, 92 * s, tc);
    if (this.helpUntil > now) this.help(f, s, font);
  }

  /** Heading-up radar: traffic as dots, aircraft as carets (hostiles red), turrets as squares. */
  private radar(f: TvFrame, cx: number, cy: number, r: number, tc: string): void {
    const g = this.ctx;
    const px = f.me.foot ? f.me.foot[0] : f.me.p[0], pz = f.me.foot ? f.me.foot[2] : f.me.p[2];
    const k = r / this.radarRange;
    const h = this.camYaw;
    const ch = Math.cos(h), sh = Math.sin(h);
    const to = (x: number, z: number): [number, number] | null => {
      const dx = x - px, dz = z - pz;
      const rx = dx * ch + dz * sh, fz = dx * sh - dz * ch;
      const sx = rx * k, sy = -fz * k;
      return sx * sx + sy * sy > r * r ? null : [cx + sx, cy + sy];
    };
    g.fillStyle = 'rgba(2,6,18,0.62)';
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(80,140,220,0.35)'; g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, r * 0.5, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = tc; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < f.riders.length; i += S.rider) {
      const p = to(f.riders[i], f.riders[i + 1]);
      if (!p) continue;
      const c = this.col(f.pal[f.riders[i + 3]] ?? '#00eaff');
      g.fillStyle = this.rgb(c[0], c[1], c[2], 0.8);
      g.fillRect(p[0] - 1, p[1] - 1, 2, 2);
    }
    for (let i = 0; i < f.turrets.length; i += S.turret) {
      const p = to(f.turrets[i], f.turrets[i + 2]);
      if (!p) continue;
      g.strokeStyle = '#ff5a4a';
      g.strokeRect(p[0] - 3, p[1] - 3, 6, 6);
    }
    for (let i = 0; i < f.flyers.length; i += S.flyer) {
      const p = to(f.flyers[i], f.flyers[i + 2]);
      if (!p) continue;
      const a = f.flyers[i + 3] - h;
      const foe = f.flyers[i + 8] & 1;
      g.fillStyle = foe ? '#ff4a3c' : '#bfe6ff';
      g.beginPath();
      g.moveTo(p[0] + Math.sin(a) * 6, p[1] - Math.cos(a) * 6);
      g.lineTo(p[0] + Math.sin(a + 2.5) * 4, p[1] - Math.cos(a + 2.5) * 4);
      g.lineTo(p[0] + Math.sin(a - 2.5) * 4, p[1] - Math.cos(a - 2.5) * 4);
      g.fill();
    }
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(cx, cy - 6); g.lineTo(cx + 4, cy + 4); g.lineTo(cx - 4, cy + 4); g.fill();
    g.fillStyle = 'rgba(160,200,255,0.8)';
    g.font = '600 12px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(`${this.radarRange / 1000} km`, cx, cy + r + 14);
  }

  private help(f: TvFrame, s: number, font: (px: number, w?: number) => string): void {
    const g = this.ctx, W = this.W, H = this.H;
    const ui = PROFILE_UI[f.hud.profile];
    const rows: Array<[string, string]> = [
      ['Left thumb', ui.leftHint.replace(/\n/g, ' · ') || '—'],
      ['Right thumb', ui.rightHint.replace(/\n/g, ' · ')],
      ['FIRE / DROP', f.hud.profile === 'foot' ? 'say YES / NO' : 'guns · bombs and missiles'],
      ['☰ menu', 'next vehicle, camera, Navigator hold, trail, weapons, on foot, reset'],
    ];
    const w = Math.min(W - 80, 820 * s), h = (80 + rows.length * 40 + 40) * s;
    const x = (W - w) / 2, y = (H - h) / 2;
    g.fillStyle = 'rgba(2,6,18,0.86)';
    g.fillRect(x, y, w, h);
    g.strokeStyle = '#36e2ff';
    g.strokeRect(x, y, w, h);
    g.textAlign = 'left';
    g.fillStyle = '#eaf6ff';
    g.font = font(26, 700);
    g.fillText('Your phone is the gamepad', x + 28 * s, y + 46 * s);
    rows.forEach(([a, b], k) => {
      g.font = font(18, 700);
      g.fillStyle = '#36e2ff';
      g.fillText(a, x + 28 * s, y + (92 + k * 40) * s);
      g.font = font(18, 500);
      g.fillStyle = '#cfe8ff';
      g.fillText(b, x + 200 * s, y + (92 + k * 40) * s);
    });
    if (this.linkLine) {
      g.font = font(15, 500);
      g.fillStyle = 'rgba(160,200,255,0.8)';
      g.fillText(this.linkLine, x + 28 * s, y + h - 20 * s);
    }
  }
}

/** Quaternion from yaw (about +Y), pitch (about +X), roll (about -Z, the nose axis), applied in that order. */
function eulerQuat(yaw: number, pitch: number, roll: number): [number, number, number, number] {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2), cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  // q = qy * qp * qr with qy = (0, sy, 0, cy), qp = (sp, 0, 0, cp), qr = (0, 0, sr, cr)
  const ax = cy * sp, ay = sy * cp, az = -sy * sp, aw = cy * cp; // qy * qp
  return [ax * cr + ay * sr, ay * cr - ax * sr, aw * sr + az * cr, aw * cr - az * sr];
}
