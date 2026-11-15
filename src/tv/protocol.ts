import type { Action, ControlProfile, RawInput } from '../input/types.ts';
import { sanitizeFrame, type TvFrame } from './format.ts';

export { isPairCode, pairCode, PAIR_ALPHABET, PAIR_LENGTH } from './pair.ts';

/**
 * The phone-as-gamepad protocol between the pad (pad.html, the phone) and the TV (tv.html, a
 * Chromecast receiver or any browser on the big screen). Plain JSON, the same over every link
 * (the cast channel, the relay's pad pairing, a BroadcastChannel between two tabs). Pure data
 * and validators: no DOM, no three.js.
 *
 * Two ways to play:
 * - The TV runs the game (default): the pad sends its stick, lever and buttons (`in`, about
 *   30 a second, plus one at once for every button press); the TV answers with what the pad
 *   should show (`ctx`: the vehicle's control profile, the throttle, a few readouts), toasts
 *   and rumble.
 * - The phone runs the game (`hello.host`, for a receiver too slow to simulate): the pad runs
 *   the simulation itself and sends `frame`s (src/tv/frame.ts) for the TV to draw.
 */

export const PAD_VERSION = 1;
/** Custom message namespace on the cast channel (the receiver and the sender must agree). */
export const PAD_NAMESPACE = 'urn:x-cast:com.shelbeeely.aerospace.pad';
/** How often the pad sends its controls (Hz). */
export const PAD_INPUT_HZ = 30;
/** Controls older than this (s) are dropped: a pad that went quiet leaves the craft hands-off. */
export const PAD_STALE = 0.6;

/** Actions the TV carries out (the rest of the game's menus live in the full game). */
export const PAD_ACTIONS = [
  'reset', 'resetWorld', 'camera', 'help', 'trimReset', 'nextVehicle', 'prevVehicle', 'mute', 'autopilot', 'trail',
  'loadout', 'map', 'radarRange', 'recentre', 'foot', 'strategic',
] as const satisfies readonly Action[];
export type PadAction = (typeof PAD_ACTIONS)[number];
/** Actions only the screen cares about (the view, not the game). */
export const VIEW_ACTIONS: ReadonlySet<string> = new Set(['camera', 'help', 'map', 'radarRange', 'mute']);

/** The pad's controls: the axes and buttons of RawInput, plus one-shots since the last message. */
export interface PadInputMsg {
  t: 'in';
  s: number;
  /** pitch, roll, yaw, throttleRate, brake, trimRate, aimYaw, aimPitch */
  ax: number[];
  /** Buttons held: 1 fire, 2 fire alt, 4 hack. */
  b: number;
  /** Throttle lever moved to (latest since the last message). */
  th?: number;
  /** Flap notches stepped, and a flap cycle, since the last message. */
  fs?: number;
  fc?: 1;
  /** Buttons pressed since the last message. */
  a?: PadAction[];
}
export interface PadHelloMsg {
  t: 'hello';
  v: number;
  name: string;
  /** The phone runs the game and will send frames. */
  host: boolean;
}
export interface PadFrameMsg {
  t: 'frame';
  f: TvFrame;
}
export type PadMessage = PadHelloMsg | PadInputMsg | PadFrameMsg | { t: 'bye' };

/** What the pad shows: its layout follows the vehicle (src/hud/profiles.ts). */
export interface TvContextMsg {
  t: 'ctx';
  profile: ControlProfile;
  foot: boolean;
  thr: number;
  armed: boolean;
  craft: string;
  nav: string | null;
  /** A few readouts for the phone's own screen. */
  lines: string[];
}
export interface TvWelcomeMsg {
  t: 'welcome';
  v: number;
  /** Who runs the game: the TV, or the pad that said hello with host. */
  host: 'tv' | 'pad';
}
export type TvMessage = TvWelcomeMsg | TvContextMsg | { t: 'toast'; text: string } | { t: 'rumble'; s: number; ms: number };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: unknown, lo: number, hi: number, d = 0) => (isNum(v) ? Math.max(lo, Math.min(hi, v)) : d);
const PROFILES: readonly ControlProfile[] = ['airplane', 'rotorcraft', 'lighter-than-air', 'ground'];
const ACTION_SET: ReadonlySet<string> = new Set(PAD_ACTIONS);

/** A message from the pad, checked: numbers clamped, unknown actions dropped. Null if malformed. */
export function parsePadMessage(raw: unknown): PadMessage | null {
  const m = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case 'hello':
      return { t: 'hello', v: clamp(o.v, 0, 1e6), name: typeof o.name === 'string' ? o.name.slice(0, 24) : 'Pad', host: o.host === true };
    case 'bye':
      return { t: 'bye' };
    case 'in': {
      const ax = Array.isArray(o.ax) ? o.ax : [];
      const msg: PadInputMsg = {
        t: 'in',
        s: clamp(o.s, 0, Number.MAX_SAFE_INTEGER),
        ax: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => clamp(ax[i], i === 4 ? 0 : -1, 1)),
        b: clamp(o.b, 0, 7) | 0,
      };
      if (isNum(o.th)) msg.th = clamp(o.th, 0, 1);
      if (isNum(o.fs) && o.fs !== 0) msg.fs = Math.round(clamp(o.fs, -3, 3));
      if (o.fc === 1) msg.fc = 1;
      if (Array.isArray(o.a)) {
        const a = o.a.slice(0, 16).filter((x): x is PadAction => typeof x === 'string' && ACTION_SET.has(x));
        if (a.length) msg.a = a;
      }
      return msg;
    }
    case 'frame': {
      const f = sanitizeFrame(o.f);
      return f ? { t: 'frame', f } : null;
    }
    default:
      return null;
  }
}

/** A message from the TV, checked. Null if malformed. */
export function parseTvMessage(raw: unknown): TvMessage | null {
  const m = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case 'welcome':
      return { t: 'welcome', v: clamp(o.v, 0, 1e6), host: o.host === 'pad' ? 'pad' : 'tv' };
    case 'ctx':
      return {
        t: 'ctx',
        profile: PROFILES.includes(o.profile as ControlProfile) ? (o.profile as ControlProfile) : 'airplane',
        foot: o.foot === true,
        thr: clamp(o.thr, 0, 1),
        armed: o.armed === true,
        craft: typeof o.craft === 'string' ? o.craft.slice(0, 48) : '',
        nav: typeof o.nav === 'string' ? o.nav.slice(0, 120) : null,
        lines: Array.isArray(o.lines) ? o.lines.slice(0, 6).filter((l): l is string => typeof l === 'string').map((l) => l.slice(0, 40)) : [],
      };
    case 'toast':
      return typeof o.text === 'string' ? { t: 'toast', text: o.text.slice(0, 200) } : null;
    case 'rumble':
      return { t: 'rumble', s: clamp(o.s, 0, 1), ms: clamp(o.ms, 0, 3000) };
    default:
      return null;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Collects the pad's controls between sends: axes and held buttons are the latest; the lever
 * position, flap steps and button presses accumulate until `take()`.
 */
export class PadInputPacker {
  private seq = 0;
  private th: number | undefined;
  private fs = 0;
  private fc = false;
  private actions: PadAction[] = [];
  private last: RawInput | null = null;

  /** Add one poll of the pad's devices. */
  add(raw: RawInput, actions: Action[]): void {
    this.last = { ...raw };
    if (raw.throttleSet !== null) this.th = raw.throttleSet;
    this.fs += raw.flapSteps;
    if (raw.flapCycle) this.fc = true;
    for (const a of actions) if (ACTION_SET.has(a)) this.actions.push(a as PadAction);
  }

  /** Is there a one-shot waiting (send now rather than at the next tick)? */
  get urgent(): boolean {
    return this.actions.length > 0 || this.th !== undefined || this.fc || this.fs !== 0;
  }

  take(): PadInputMsg {
    const r = this.last;
    const q = (v: number) => Math.round(v * 1000) / 1000;
    const msg: PadInputMsg = {
      t: 'in',
      s: ++this.seq,
      ax: r ? [r.pitch, r.roll, r.yaw, r.throttleRate, r.brake, r.trimRate, r.aimYaw, r.aimPitch].map(q) : [0, 0, 0, 0, 0, 0, 0, 0],
      b: r ? (r.fire ? 1 : 0) | (r.fireAlt ? 2 : 0) | (r.hack ? 4 : 0) : 0,
    };
    if (this.th !== undefined) msg.th = q(this.th);
    if (this.fs) msg.fs = this.fs;
    if (this.fc) msg.fc = 1;
    if (this.actions.length) msg.a = this.actions;
    this.th = undefined;
    this.fs = 0;
    this.fc = false;
    this.actions = [];
    return msg;
  }
}
