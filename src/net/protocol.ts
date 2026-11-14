/**
 * Multiplayer wire protocol, shared by the browser client (src/net/NetClient.ts) and the Bun
 * relay server (server/). Plain JSON text frames. Pure data and validators only: no DOM, no
 * three.js, no Bun, so both sides import it as is.
 *
 * Bump PROTOCOL_VERSION on any incompatible change; the server refuses other versions.
 *
 * Flow: the client opens ws://host:port/ws and sends `hello` (room '' = create a new room). The
 * server answers `welcome` with a snapshot of everyone in the room (name, colour, CraftDef, last
 * state), then relays each player's `state` (20 Hz), `craft` changes and `event`s to the rest of
 * the room. `join` / `leave` announce roster changes. No accounts; a room disappears with its
 * last player.
 *
 * The world (additive, no version bump): a relay that keeps the Bits' world says so in its
 * `welcome` (`world`). A client streaming a lot in asks for it (`lot-want`) and gets the lot's
 * gene pool, or none yet, and whether it now holds the lot (`lot`). The holder simulates the
 * lot's Bits and sends the pool back (`lot-push`) while it is in view and when it lets go
 * (`lot-release`); a Bit another client derezzes is reported (`lot-derez`) and passed on to the
 * holder. A client offers its own saved pools (`lot-offer`) so a restarted relay reseeds. Lots
 * nobody holds are carried forward by the relay itself. Pools are `encodePools` bytes in base64
 * (src/sim/evolution.ts); the relay decodes and range-checks them.
 */
import type { CraftDef } from '../craft/types.ts';

export const PROTOCOL_VERSION = 4;

/** A player's team: 0 Cyan, 1 Red, 2 Amber (sim/teams.ts). Anything else reads as Cyan. */
export type NetTeam = 0 | 1 | 2;
export const asTeam = (v: unknown): NetTeam => (v === 1 || v === 2 ? v : 0);
export const MAX_PLAYERS = 16;
export const ROOM_CODE_LENGTH = 5;
/** How often clients send their state (Hz). */
export const STATE_HZ = 20;
/** Largest hello / craft message (a 500-part CraftDef fits comfortably). */
export const MAX_CRAFT_BYTES = 256 * 1024;
/** Largest state / event / chat message. */
export const MAX_MESSAGE_BYTES = 32 * 1024;
/** Most lots named in one lot-want / lot-release, and carried in one lot-offer. */
export const MAX_LOT_KEYS = 64;
export const MAX_OFFER_LOTS = 24;
/** Largest lot key (blocks round the planet, squared, with room to spare). */
export const MAX_LOT_KEY = 2 ** 31 - 1;
export const MAX_NAME = 24;
export const MAX_CHAT = 280;
/** Trail limits per state message. */
export const MAX_TRAILS = 16;
export const MAX_TRAIL_POINTS = 256;

/** One trail point: [x, z, y0, y1, arc] (TrailPoint without time; receivers stamp local time). */
export type NetTrailPoint = [number, number, number, number, number];

/** A trail's delta since the sender's previous state message. */
export interface NetTrail {
  /** Sender-local trail id. */
  id: number;
  kind: 'wall' | 'contrail';
  color: string;
  height: number;
  /** New points (arc ascending; receivers ignore any at or below the arc they already have). */
  pts: NetTrailPoint[];
  /** Arc of the sender's oldest surviving point (receivers drop older ones: ribbons fade); -1 = the trail is empty. */
  tail: number;
  /** Still attached to its emitter. */
  active: boolean;
  /** Derezzing: flicker out and go. */
  derez: boolean;
}

export interface NetState {
  /** Sender clock (ms) for interpolation. */
  t: number;
  /** Body origin (flat world coordinates). */
  p: [number, number, number];
  /** Rotation quaternion x, y, z, w. */
  q: [number, number, number, number];
  /** Linear velocity (m/s). */
  v: [number, number, number];
  /** Controls: pitch, roll, yaw, throttle, brake, flaps. */
  c: [number, number, number, number, number, number];
  /** 'flight' or 'hangar' (hangar players are listed but not drawn). */
  m: 'flight' | 'hangar';
  /** Exploded (wreck): not drawn. */
  x: boolean;
  /** Trail mode of the sender ('wall' | 'ribbon' | 'off'). */
  tm: 'wall' | 'ribbon' | 'off';
  /** Every trail the sender has right now (trails it no longer lists derez). */
  tr: NetTrail[];
}

export type NetEvent =
  /** A structure fractured. `group` is StaticWorld's stable group name (planet chunks carry an `@ox,oz` image suffix). */
  | { k: 'fracture'; group: string; hit: { impulse: number; x: number; y: number; z: number }; crater: boolean }
  | { k: 'explosion'; x: number; y: number; z: number; radius: number }
  /** The sender's vehicle derezzed (crash or respawn): its trails go with it. */
  | { k: 'derez' }
  /** The sender's round struck `target` (that player's game applies the damage). */
  | { k: 'hit'; target: string; kind: string; x: number; y: number; z: number }
  /** The sender was shot down by `by` (the kill feed; the shooter is paid). */
  | { k: 'kill'; by: string }
  /** A strategic weapon of the sender's went off (every game plays it out). */
  | { k: 'nuke' | 'emp'; x: number; y: number; z: number }
  /** Teams `a` and `b` are now at war (`on`) or have a cease fire (v4). The world starts at peace. */
  | { k: 'war'; a: NetTeam; b: NetTeam; on: boolean }
  | { k: 'chat'; text: string };

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
  team: NetTeam;
  craft: CraftDef;
  state: NetState | null;
}

export type ClientMessage =
  | { t: 'hello'; v: number; room: string; name: string; color: string; craft: CraftDef; team?: NetTeam }
  | { t: 'team'; team: NetTeam }
  | { t: 'state'; s: NetState }
  | { t: 'craft'; craft: CraftDef }
  | { t: 'event'; e: NetEvent }
  | { t: 'ping' }
  /** The world: lots streaming in (and lots in view this client does not hold yet). */
  | { t: 'lot-want'; keys: number[] }
  /** The holder's lot as it is now (one lot, base64 encodePools). */
  | { t: 'lot-push'; key: number; pool: string }
  | { t: 'lot-release'; keys: number[] }
  /** A Bit of a lot this client does not hold was derezzed here. */
  | { t: 'lot-derez'; key: number; slot: number }
  /** Saved pools for a relay that lacks them (several lots, base64), each away so many seconds. */
  | { t: 'lot-offer'; pool: string; away: number[] };

/** What a world-keeping relay says about its world in `welcome`. */
export interface WorldInfo {
  /** How long the relay has been running (s), and how many lots it keeps. */
  uptime: number;
  lots: number;
}

export type ServerMessage =
  | { t: 'welcome'; v: number; id: string; room: string; players: PlayerInfo[]; world?: WorldInfo }
  /** A lot asked for: its pool (null: the relay has none yet), and whether the asker now holds it. */
  | { t: 'lot'; key: number; pool: string | null; holder: boolean }
  /** One of your lot's Bits was derezzed in another player's game. */
  | { t: 'lot-derez'; key: number; slot: number }
  | { t: 'join'; player: PlayerInfo }
  | { t: 'leave'; id: string; reason: string }
  | { t: 'state'; id: string; s: NetState }
  | { t: 'craft'; id: string; craft: CraftDef }
  | { t: 'team'; id: string; team: NetTeam }
  | { t: 'event'; id: string; e: NetEvent }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong' };

export type ErrorCode = 'bad-message' | 'too-large' | 'version' | 'room-full' | 'bad-room' | 'rate-limited' | 'not-joined';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function normalizeRoom(code: string): string {
  return code.trim().toUpperCase();
}

export function isRoomCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Z]{5}$/.test(code);
}

/**
 * The shared world: every client joins this room on load. When it is full the relay seats the
 * newcomer in the first overflow room with space (WORLA, WORLB, ...): everyone shares the one
 * world, the room only decides whose craft you see.
 */
export const WORLD_ROOM = 'WORLD';
export function worldOverflowRooms(): string[] {
  return [WORLD_ROOM, ...'ABCEFGHJKLMNPQRSTUVWXYZ'.split('').map((c) => `WORL${c}`)];
}
export const isWorldRoom = (code: string): boolean => /^WORL[A-Z]$/.test(code);

/** A random room code (letters only, no I/O so codes read aloud cleanly). */
export function randomRoomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) s += ROOM_ALPHABET[Math.floor(rand() * ROOM_ALPHABET.length)];
  return s;
}

// --- Validation (the server trusts nothing; clients re-check what peers send)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown, lim = 1e7): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
const isNumArr = (v: unknown, n: number, lim = 1e7) => Array.isArray(v) && v.length === n && v.every((x) => isNum(x, lim));
const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

const isKey = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_LOT_KEY;
const isKeyList = (v: unknown, max: number): v is number[] => Array.isArray(v) && v.length > 0 && v.length <= max && v.every(isKey);
const isPool = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_MESSAGE_BYTES && /^[A-Za-z0-9+/=]+$/.test(v);

export function sanitizeName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, MAX_NAME) : '';
  return s || 'Program';
}

function validTrail(v: unknown): v is NetTrail {
  if (!isObj(v)) return false;
  if (!isNum(v.id, 1e9) || (v.kind !== 'wall' && v.kind !== 'contrail') || !isColor(v.color) || !isNum(v.height, 100)) return false;
  if (!isNum(v.tail) || typeof v.active !== 'boolean' || typeof v.derez !== 'boolean') return false;
  return Array.isArray(v.pts) && v.pts.length <= MAX_TRAIL_POINTS && v.pts.every((p) => isNumArr(p, 5));
}

export function validState(v: unknown): v is NetState {
  if (!isObj(v)) return false;
  if (!isNum(v.t, 1e13) || !isNumArr(v.p, 3) || !isNumArr(v.q, 4, 2) || !isNumArr(v.v, 3, 1e5) || !isNumArr(v.c, 6, 2)) return false;
  if (v.m !== 'flight' && v.m !== 'hangar') return false;
  if (typeof v.x !== 'boolean' || (v.tm !== 'wall' && v.tm !== 'ribbon' && v.tm !== 'off')) return false;
  if (!Array.isArray(v.tr) || v.tr.length > MAX_TRAILS || !v.tr.every(validTrail)) return false;
  let pts = 0;
  for (const t of v.tr as NetTrail[]) pts += t.pts.length;
  return pts <= MAX_TRAIL_POINTS;
}

/** Shape check for a CraftDef on the wire (full physics validation is the client's validateCraft). */
export function validCraftShape(v: unknown): v is CraftDef {
  return isObj(v) && typeof v.name === 'string' && Array.isArray(v.parts) && v.parts.length > 0 && v.parts.length <= 500 &&
    v.parts.every((p) => isObj(p) && isObj(p.shape) && Array.isArray(p.position));
}

/** The weapons a hit can be reported for. */
export const HIT_KINDS = ['gun', 'cannon', 'bomb', 'missile', 'laser', 'disc', 'pulse', 'rail'];

export function validEvent(v: unknown): v is NetEvent {
  if (!isObj(v)) return false;
  switch (v.k) {
    case 'fracture':
      return typeof v.group === 'string' && v.group.length > 0 && v.group.length <= 128 && isObj(v.hit) &&
        isNum(v.hit.impulse, 1e12) && isNum(v.hit.x) && isNum(v.hit.y) && isNum(v.hit.z) && typeof v.crater === 'boolean';
    case 'explosion':
      return isNum(v.x) && isNum(v.y) && isNum(v.z) && isNum(v.radius, 500) && v.radius > 0;
    case 'derez':
      return true;
    case 'hit':
      return typeof v.target === 'string' && v.target.length > 0 && v.target.length <= 64 && typeof v.kind === 'string' && HIT_KINDS.includes(v.kind) && isNum(v.x) && isNum(v.y) && isNum(v.z);
    case 'kill':
      return typeof v.by === 'string' && v.by.length > 0 && v.by.length <= 64;
    case 'nuke':
    case 'emp':
      return isNum(v.x) && isNum(v.y) && isNum(v.z);
    case 'war':
      return (v.a === 0 || v.a === 1 || v.a === 2) && (v.b === 0 || v.b === 1 || v.b === 2) && v.a !== v.b && typeof v.on === 'boolean';
    case 'chat':
      return typeof v.text === 'string' && v.text.trim().length > 0 && v.text.length <= MAX_CHAT;
    default:
      return false;
  }
}

/** Parse and shape-check a client frame. Returns the message or an error code. */
export function parseClientMessage(raw: string, bytes = raw.length): ClientMessage | { error: ErrorCode; message: string } {
  if (bytes > MAX_CRAFT_BYTES) return { error: 'too-large', message: `message of ${bytes} bytes is over the ${MAX_CRAFT_BYTES} byte limit` };
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return { error: 'bad-message', message: 'not JSON' }; }
  if (!isObj(m)) return { error: 'bad-message', message: 'not an object' };
  if (m.t !== 'hello' && m.t !== 'craft' && bytes > MAX_MESSAGE_BYTES) {
    return { error: 'too-large', message: `message of ${bytes} bytes is over the ${MAX_MESSAGE_BYTES} byte limit` };
  }
  const bad = (what: string) => ({ error: 'bad-message' as const, message: what });
  switch (m.t) {
    case 'hello':
      if (m.v !== PROTOCOL_VERSION) return { error: 'version', message: `protocol ${String(m.v)} (server speaks ${PROTOCOL_VERSION})` };
      if (typeof m.room !== 'string') return bad('room must be a string');
      if (!validCraftShape(m.craft)) return bad('invalid craft');
      return { t: 'hello', v: m.v, room: normalizeRoom(m.room), name: sanitizeName(m.name), color: isColor(m.color) ? m.color : '#00eaff', craft: m.craft, team: asTeam(m.team) };
    case 'team':
      return m.team === 0 || m.team === 1 || m.team === 2 ? { t: 'team', team: m.team } : bad('team must be 0, 1 or 2');
    case 'state':
      return validState(m.s) ? { t: 'state', s: m.s } : bad('invalid state');
    case 'craft':
      return validCraftShape(m.craft) ? { t: 'craft', craft: m.craft } : bad('invalid craft');
    case 'event':
      return validEvent(m.e) ? { t: 'event', e: m.e } : bad('invalid event');
    case 'ping':
      return { t: 'ping' };
    case 'lot-want':
    case 'lot-release':
      return isKeyList(m.keys, MAX_LOT_KEYS) ? { t: m.t, keys: m.keys } : bad('keys must be up to 64 lot keys');
    case 'lot-push':
      return isKey(m.key) && isPool(m.pool) ? { t: 'lot-push', key: m.key, pool: m.pool } : bad('invalid lot push');
    case 'lot-derez':
      return isKey(m.key) && isKey(m.slot) ? { t: 'lot-derez', key: m.key, slot: m.slot } : bad('invalid lot derez');
    case 'lot-offer':
      return isPool(m.pool) && Array.isArray(m.away) && m.away.length <= MAX_OFFER_LOTS && m.away.every((a) => isNum(a, 1e9) && a >= 0)
        ? { t: 'lot-offer', pool: m.pool, away: m.away } : bad('invalid lot offer');
    default:
      return bad('unknown message type');
  }
}

/** Planet-chunk group names end in `@ox,oz` (the wrap image they were registered at). */
export function splitGroupName(name: string): { base: string; ox: number; oz: number } {
  const m = /^(.*)@(-?[\d.]+),(-?[\d.]+)$/.exec(name);
  return m ? { base: m[1], ox: Number(m[2]), oz: Number(m[3]) } : { base: name, ox: 0, oz: 0 };
}

/** Round for the wire (cm precision keeps state frames small). */
export const r2 = (v: number) => Math.round(v * 100) / 100;
export const r4 = (v: number) => Math.round(v * 10000) / 10000;
