import type { UiProfile } from '../hud/profiles.ts';
import type { BitState } from '../people/bit.ts';

/**
 * The TV frame's format (src/tv/frame.ts builds frames from a Simulation): the types, the
 * entity strides and caps, and the check a frame from the network goes through. Pure data, no
 * simulation and no three.js, so the TV page that only draws stays small.
 */

export const FRAME_VERSION = 1;
/** Entities further than this from the player (m, horizontal) are left out. */
export const FRAME_RANGE = 1400;

/** Strides of the entity arrays. */
export const S = {
  /** x, z, yaw, colour, fade */
  rider: 5,
  /** x0, z0, x1, z1, bottom, top, colour, alpha */
  wall: 8,
  /** x, y, z, heading, pitch, bank, colour, radius, flags (1 hostile, 2 attacking) */
  flyer: 9,
  /** x, y, z, yaw, state (0 idle1, 1 idle2, 2 yes, 3 no), colour, radius */
  bit: 7,
  /** x, y, z, yaw, state (0 idle, 1 yes, 2 no), colour */
  prog: 6,
  /** x, y, z, colour, firing */
  turret: 5,
  /** x, y, z, vx, vy, vz, colour */
  shot: 7,
  /** x, y, z, age, radius, colour */
  boom: 6,
  /** x, z, radius, colour */
  crater: 4,
  /** x, y, z, size, colour */
  block: 5,
} as const;

/** Most entities of each kind in one frame (nearest kept). */
export const CAP = { rider: 120, wall: 600, flyer: 32, bit: 160, prog: 48, turret: 24, shot: 96, boom: 24, crater: 48, block: 900 } as const;

export const BIT_STATES: readonly BitState[] = ['idle1', 'idle2', 'yes', 'no'];

/** A craft part as the TV draws it (body frame). */
export interface PartShape {
  id: string;
  /** 0 box, 1 cylinder, 2 cone, 3 sphere, 4 capsule. */
  s: 0 | 1 | 2 | 3 | 4;
  /** box: size; round shapes: [radius, length, axis 0 x / 1 y / 2 z]; sphere: [radius, 0, 0]. */
  d: [number, number, number];
  /** Cones: +1 when the tip points to the axis's positive end. */
  tip?: 1 | -1;
  p: [number, number, number];
  q: [number, number, number, number];
  c: string;
  /** A light part (accent, canopy, nozzle): drawn bright. */
  lit: 0 | 1;
}

export interface CraftShape {
  key: string;
  name: string;
  radius: number;
  parts: PartShape[];
}

export interface TvHud {
  /** Speed (m/s) and what it is called for this vehicle. */
  spd: number;
  spdLabel: string;
  alt: number;
  vs: number;
  hdg: number;
  pitch: number;
  roll: number;
  thr: number;
  fuel: number | null;
  mach: number;
  g: number;
  stall: number;
  gnd: boolean;
  profile: UiProfile;
  /** Navigator status line (null: off). */
  nav: string | null;
  /** Weapons and ammunition (null: unarmed). */
  weapons: string | null;
  /** Hostiles within 6 km, and whether we were hit in the last two seconds. */
  hostiles: number;
  underFire: boolean;
  credits: number;
  /** The player's side light. */
  team: string;
}

export interface TvFrame {
  v: number;
  /** Simulation time (s) and frame counter. */
  t: number;
  n: number;
  me: {
    /** Body origin and rotation, interpolated to the render moment. */
    p: [number, number, number];
    q: [number, number, number, number];
    vel: [number, number, number];
    /** On foot: the Bit's x, y, z, yaw (null: aboard). */
    foot: [number, number, number, number] | null;
    /** Derezzed (crashed, shot): nothing to draw until the respawn. */
    dead: boolean;
    /** Key of the craft shape (see `craft`). */
    craft: string;
    /** The player's own Bit's idle light. */
    bit: string;
  };
  /** The craft's shape: sent when it changes (and now and then, for a TV that joined late). */
  craft?: CraftShape;
  /** Parts broken off the craft. */
  hide: string[];
  hud: TvHud;
  pal: string[];
  riders: number[];
  walls: number[];
  flyers: number[];
  bits: number[];
  progs: number[];
  turrets: number[];
  shots: number[];
  booms: number[];
  craters: number[];
  blocks: number[];
  /** Fractured structure groups (their intact pieces are not drawn). */
  broken: number[];
  /** Registered planet chunks in order, flat [ci, cj, ox, oz]* (sent now and then; `nchunks` always). */
  chunks?: number[];
  nchunks: number;
  /** Toasts since the last frame. */
  notes: string[];
  /** View actions for the screen (camera, help, map, radarRange, mute). */
  ui: string[];
}

/** Relative luminance of a #rrggbb colour (0..1). */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numArray = (v: unknown, stride: number, cap: number): number[] => {
  if (!Array.isArray(v)) return [];
  const n = Math.min(v.length - (v.length % stride), stride * cap);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = isNum(v[i]) ? v[i] : 0;
  return out;
};
const str = (v: unknown, max = 64): string => (typeof v === 'string' ? v.slice(0, max) : '');
const COLOR = /^#[0-9a-f]{3,8}$/i;
const vec = <N extends number>(v: unknown, n: N): number[] | null =>
  Array.isArray(v) && v.length === n && v.every(isNum) ? (v as number[]) : null;
const PROFILES: readonly UiProfile[] = ['airplane', 'rotorcraft', 'lighter-than-air', 'ground', 'foot'];

/**
 * A frame that came over the network (the phone runs the game): shape-checked, numbers made
 * finite, lists capped, colours kept to hex. Null when it is not a frame at all.
 */
export function sanitizeFrame(raw: unknown): TvFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const me = f.me as Record<string, unknown> | undefined;
  if (f.v !== FRAME_VERSION || !me || !isNum(f.t) || !isNum(f.n)) return null;
  const p = vec(me.p, 3), q = vec(me.q, 4), vel = vec(me.vel, 3);
  if (!p || !q || !vel) return null;
  const foot = me.foot === null ? null : vec(me.foot, 4);
  const pal = Array.isArray(f.pal) ? f.pal.slice(0, 64).map((c) => (typeof c === 'string' && COLOR.test(c) ? c : '#36e2ff')) : [];
  const h = (f.hud ?? {}) as Record<string, unknown>;
  const n = (v: unknown, d = 0) => (isNum(v) ? v : d);
  const hud: TvHud = {
    spd: n(h.spd), spdLabel: str(h.spdLabel, 12) || 'SPEED', alt: n(h.alt), vs: n(h.vs), hdg: n(h.hdg), pitch: n(h.pitch), roll: n(h.roll),
    thr: n(h.thr), fuel: isNum(h.fuel) ? h.fuel : null, mach: n(h.mach), g: n(h.g, 1), stall: n(h.stall), gnd: h.gnd === true,
    profile: PROFILES.includes(h.profile as UiProfile) ? (h.profile as UiProfile) : 'airplane',
    nav: typeof h.nav === 'string' ? h.nav.slice(0, 120) : null, weapons: typeof h.weapons === 'string' ? h.weapons.slice(0, 80) : null,
    hostiles: n(h.hostiles), underFire: h.underFire === true, credits: n(h.credits),
    team: typeof h.team === 'string' && COLOR.test(h.team) ? h.team : '#36e2ff',
  };
  let craft: CraftShape | undefined;
  const c = f.craft as Record<string, unknown> | undefined;
  if (c && typeof c === 'object' && Array.isArray(c.parts)) {
    const parts: PartShape[] = [];
    for (const x of c.parts.slice(0, 500) as Array<Record<string, unknown>>) {
      const d = vec(x?.d, 3), pp = vec(x?.p, 3), qq = vec(x?.q, 4);
      if (!d || !pp || !qq || ![0, 1, 2, 3, 4].includes(x.s as number)) continue;
      parts.push({
        id: str(x.id), s: x.s as PartShape['s'], d: d as PartShape['d'], ...(x.tip === 1 ? { tip: 1 as const } : {}),
        p: pp as PartShape['p'], q: qq as PartShape['q'], c: typeof x.c === 'string' && COLOR.test(x.c) ? x.c : '#22357a', lit: x.lit === 1 ? 1 : 0,
      });
    }
    craft = { key: str(c.key), name: str(c.name, 48), radius: n(c.radius, 5), parts };
  }
  const strings = (v: unknown, cap: number, max: number) => (Array.isArray(v) ? v.slice(0, cap).map((s) => str(s, max)).filter(Boolean) : []);
  return {
    v: FRAME_VERSION, t: f.t, n: f.n,
    me: {
      p: p as TvFrame['me']['p'], q: q as TvFrame['me']['q'], vel: vel as TvFrame['me']['vel'],
      foot: foot as TvFrame['me']['foot'], dead: me.dead === true, craft: str(me.craft),
      bit: typeof me.bit === 'string' && COLOR.test(me.bit) ? me.bit : '#3d7cff',
    },
    ...(craft ? { craft } : {}),
    hide: strings(f.hide, 500, 64),
    hud, pal,
    riders: numArray(f.riders, S.rider, CAP.rider),
    walls: numArray(f.walls, S.wall, CAP.wall),
    flyers: numArray(f.flyers, S.flyer, CAP.flyer),
    bits: numArray(f.bits, S.bit, CAP.bit),
    progs: numArray(f.progs, S.prog, CAP.prog),
    turrets: numArray(f.turrets, S.turret, CAP.turret),
    shots: numArray(f.shots, S.shot, CAP.shot),
    booms: numArray(f.booms, S.boom, CAP.boom),
    craters: numArray(f.craters, S.crater, CAP.crater),
    blocks: numArray(f.blocks, S.block, CAP.block),
    broken: numArray(f.broken, 1, 4096),
    ...(Array.isArray(f.chunks) ? { chunks: numArray(f.chunks, 4, 2048) } : {}),
    nchunks: n(f.nchunks),
    notes: strings(f.notes, 8, 160),
    ui: strings(f.ui, 8, 16),
  };
}
