import { hash32 } from '../arch/rng.ts';
import { wrapDelta } from './contacts.ts';
import type { AiFlyer } from './aiTraffic.ts';
import { HX, HZ, TRAFFIC, type Rider } from './traffic.ts';
import { FREELANCER, hostile, sideLight, sideName, type Side, type Team } from './teams.ts';
import { terrainHeight } from './terrain.ts';

/**
 * ADS-B for every vehicle: what a transponder would broadcast (callsign, type, position, altitude,
 * ground speed, track, vertical rate, squawk), plus what the simulation knows about what it is
 * doing. The strike globe and the cockpit draw their data tags, cards and track trails from it.
 *
 * - Callsigns are fixed for a vehicle's life: a prefix for its side or role plus its number
 *   (CYN, RED, AMB, FRL freelancer, MRC mercenary, STK strike bomber, CIV, LC light cycle).
 *   Players broadcast their name; the craft is YOU.
 * - Squawk: four octal digits from the callsign; 7700 (emergency) when badly hit, 7600 (radio
 *   failure) while an EMP has it.
 */

export type AdsbCategory = 'air' | 'rotor' | 'lta' | 'ground' | 'player' | 'self';

export interface AdsbRecord {
  /** Matches the contact / lock id (air:…, rider:…, player:…, self). */
  id: string;
  callsign: string;
  /** The design (aircraft type). */
  type: string;
  category: AdsbCategory;
  side: Side | null;
  sideName: string;
  /** Its light colour. */
  color: string;
  /** A side the player's team fights. */
  foe: boolean;
  x: number;
  z: number;
  /** Altitude above the datum (m) and above the ground under it (m). */
  alt: number;
  agl: number;
  /** Ground speed (m/s), track over the ground (rad, 0 = north, clockwise), vertical rate (m/s). */
  gs: number;
  track: number;
  vs: number;
  squawk: string;
  status: string;
  /** Distance from the player's craft (m). */
  range: number;
}

const ROLE_PREFIX: Record<string, string> = { civil: 'CIV', merc: 'MRC', strike: 'STK', free: 'FRL' };
const TEAM_PREFIX = ['CYN', 'RED', 'AMB'];

/** Four octal digits from a callsign, never one of the emergency codes. */
export function squawkOf(callsign: string): string {
  let h = 0;
  for (let i = 0; i < callsign.length; i++) h = hash32(h, callsign.charCodeAt(i));
  const d = [1 + (h % 6), (h >>> 3) & 7, (h >>> 6) & 7, (h >>> 9) & 7];
  return d.join('');
}

export function flyerCallsign(f: AiFlyer): string {
  const prefix = ROLE_PREFIX[f.role] ?? (f.side !== null && f.side !== FREELANCER ? TEAM_PREFIX[f.side] : 'FRL');
  return `${prefix}-${f.id}`;
}

const kt = 1.943844;
/** A tag's speed in knots, the way aviation reads it. */
export const knots = (ms: number): number => Math.round(ms * kt);

/** The record for an AI aircraft (null once it has derezzed). */
export function flyerRecord(f: AiFlyer, team: Team, time: number, from: { x: number; z: number }): AdsbRecord | null {
  if (f.derezAt !== null) return null;
  const callsign = flyerCallsign(f);
  const gs = Math.hypot(f.vel.x, f.vel.z);
  const disabled = time < f.disabledUntil;
  let status: string;
  if (disabled) status = 'disabled (EMP)';
  else if (f.run && !f.run.dropped) status = 'strike run';
  else if (f.leaving) status = 'leaving';
  else if (f.target) status = `attacking ${f.target.kind === 'player' ? 'you' : f.target.kind === 'turret' ? 'a turret' : f.target.kind === 'remote' ? 'a player' : f.target.flyer ? flyerCallsign(f.target.flyer) : 'a target'}`;
  else if (f.order) status = 'on order';
  else if (f.role === 'friend' || f.role === 'merc') status = 'escort';
  else if (f.hostile) status = 'patrol';
  else status = f.state === 'loiter' ? 'holding' : 'en route';
  const hurt = f.hostile && f.hp < f.maxHp * 0.4;
  return {
    id: `air:${f.id}`, callsign, type: f.name,
    category: f.kind === 'rotorcraft' ? 'rotor' : f.kind === 'lighter-than-air' ? 'lta' : 'air',
    side: f.side, sideName: f.side === null ? 'Civil' : f.role === 'merc' ? 'Mercenary' : sideName(f.side),
    color: f.color, foe: f.side !== null && hostile(team, f.side),
    x: f.pos.x, z: f.pos.z, alt: f.pos.y, agl: f.pos.y - terrainHeight(f.pos.x, f.pos.z),
    gs, track: gs > 1 ? Math.atan2(f.vel.x, -f.vel.z) : f.heading, vs: f.vel.y,
    squawk: disabled ? '7600' : hurt ? '7700' : squawkOf(callsign),
    status, range: Math.hypot(wrapDelta(from.x, f.pos.x), wrapDelta(from.z, f.pos.z)),
  };
}

/** The record for a light cycle (null once derezzed). */
export function riderRecord(r: Rider, time: number, from: { x: number; z: number }): AdsbRecord | null {
  if (r.derezAt !== null) return null;
  const callsign = `LC-${r.id}`;
  const stalled = (r.stalledUntil ?? -Infinity) > time;
  const gs = stalled ? 0 : r.speed;
  return {
    id: `rider:${r.id}`, callsign, type: 'Light cycle', category: 'ground', side: null,
    sideName: r.team === 0 ? 'Cyan program' : 'Amber program', color: TRAFFIC.colors[r.team], foe: false,
    x: r.x, z: r.z, alt: terrainHeight(r.x, r.z), agl: 0,
    gs, track: Math.atan2(HX[r.heading], -HZ[r.heading]), vs: 0,
    squawk: stalled ? '7600' : squawkOf(callsign), status: stalled ? 'stalled (EMP)' : 'riding',
    range: Math.hypot(wrapDelta(from.x, r.x), wrapDelta(from.z, r.z)),
  };
}

/** A record for a craft flown by a person (the player's own, or another player's). */
export function craftRecord(o: {
  id: string; callsign: string; type: string; self: boolean; side: Side; team: Team; color?: string;
  x: number; y: number; z: number; vx: number; vy: number; vz: number; heading: number; hurt?: boolean; emp?: boolean;
}, from: { x: number; z: number }): AdsbRecord {
  const gs = Math.hypot(o.vx, o.vz);
  const agl = o.y - terrainHeight(o.x, o.z);
  return {
    id: o.id, callsign: o.callsign, type: o.type, category: o.self ? 'self' : 'player', side: o.side, sideName: sideName(o.side),
    color: o.color ?? sideLight(o.side), foe: !o.self && hostile(o.team, o.side),
    x: o.x, z: o.z, alt: o.y, agl,
    gs, track: gs > 1 ? Math.atan2(o.vx, -o.vz) : o.heading, vs: o.vy,
    squawk: o.emp ? '7600' : o.hurt ? '7700' : squawkOf(o.callsign),
    status: agl < 4 && gs < 2 ? 'on the ground' : agl < 8 ? 'driving' : 'flying',
    range: Math.hypot(wrapDelta(from.x, o.x), wrapDelta(from.z, o.z)),
  };
}

/** One point of a track: where it was, and when (s). */
export interface TrackPoint {
  x: number;
  z: number;
  y: number;
  t: number;
}

/** Points kept per track (one a second: a minute). */
export const TRACK_POINTS = 60;

/**
 * Track history: every vehicle's position once a second for the last minute, dropped when it
 * goes. The records are taken at the same moment and kept as the latest broadcast.
 */
export class AdsbTracker {
  readonly tracks = new Map<string, TrackPoint[]>();
  /** The latest records, by id. */
  readonly latest = new Map<string, AdsbRecord>();
  private last = -Infinity;
  /** Seconds between samples. */
  interval = 1;

  due(time: number): boolean {
    return time - this.last >= this.interval;
  }

  sample(records: AdsbRecord[], time: number): void {
    this.last = time;
    const seen = new Set<string>();
    for (const r of records) {
      seen.add(r.id);
      this.latest.set(r.id, r);
      let t = this.tracks.get(r.id);
      if (!t) this.tracks.set(r.id, (t = []));
      t.push({ x: r.x, z: r.z, y: r.alt, t: time });
      if (t.length > TRACK_POINTS) t.splice(0, t.length - TRACK_POINTS);
    }
    for (const id of [...this.tracks.keys()]) if (!seen.has(id)) { this.tracks.delete(id); this.latest.delete(id); }
  }

  clear(): void {
    this.tracks.clear();
    this.latest.clear();
    this.last = -Infinity;
  }
}
