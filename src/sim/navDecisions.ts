/**
 * What the Navigator offers its brain (src/sim/navBrain.ts): for each vehicle and mode, the
 * questions worth asking and options it has already checked, each carrying the action that
 * carries it out. Every option here is one the built-in computer can fly safely by itself: routes
 * come from the road graph with closed and blocked roads left out, paces stay under the player's
 * own limit, cruise heights are flown with the usual climb over obstacles, speeds stay well clear
 * of the stall, and runways are long enough. So the brain only chooses among good things.
 *
 * Pure and DOM-free; nothing here mutates the Navigator (it applies the actions itself).
 */
import { landingSites } from '../world/landingSites.ts';
import type { LandingSite } from './layout.ts';
import { wrapCoord } from './layout.ts';
import { bearing, chooseApproach, distance, landingDistanceNeeded, obstacleAhead, siteUsable, wrap360, type Destination } from './nav.ts';
import type { BrainDecision, BrainFact, BrainOption, BrainQuestion, BrainVehicle } from './navBrain.ts';
import type { DriveStatus, GroundDriver } from './groundPilot.ts';
import { alternativeRoutes, ROAD_SPEED, routeSegments, type Route, type RoutePoint } from './roads.ts';
import type { Telemetry } from './telemetry.ts';
import { terrainHeight } from './terrain.ts';

/** The world beyond the craft, supplied by the host (territory and diplomacy live there). */
export interface AdvisorWorld {
  /** The name of a side hostile to the player that holds the district at (x, z), else null. */
  hostileAt(x: number, z: number): string | null;
  /** Anything else worth telling the brain (the player's side, wars, being wanted). */
  extras(): Record<string, unknown>;
}

/** What the Navigator shows the decision builders. */
export interface NavView {
  kind: 'airplane' | 'rotorcraft' | 'ground';
  mode: string;
  phase: string;
  t: Telemetry;
  dest: Destination | null;
  /** The player's settings: ground cruise limit (m/s); air cruise height (m above ground) and speed. */
  userSpeed: number;
  userAltitude: number;
  /** What is being flown now (the brain's last pick or the player's setting). */
  speed: number;
  altitude: number;
  stallSpeed: number;
  approachSpeed: number;
  driver: GroundDriver;
  drive: DriveStatus | null;
  fractured?: { has(group: number): boolean };
  world: AdvisorWorld | null;
  seq: number;
  context: string;
}

export type NavAction =
  | { kind: 'route'; route: Route }
  | { kind: 'keep-route' }
  | { kind: 'pace'; speed: number }
  | { kind: 'altitude'; altitude: number }
  | { kind: 'speed'; speed: number }
  | { kind: 'site'; id: string };

export interface BuiltDecision {
  decision: BrainDecision;
  /** Question id → option id → what choosing it does. */
  actions: Record<string, Record<string, NavAction>>;
}

const r0 = Math.round;
const r1 = (x: number) => Math.round(x * 10) / 10;
const KT = 1.943844;

/** Ground pace menu (m/s); the player's own limit is always offered too. */
const PACES = [8, 12, 16, 22, 30, 40, 50];
const AIR_HEIGHTS = [150, 300, 600, 1200, 2500];
const ROTOR_HEIGHTS = [30, 60, 120, 250];
const ROTOR_SPEEDS = [8, 15, 25];

function weather(t: Telemetry): Record<string, BrainFact> {
  const w = t.weather;
  const out: Record<string, BrainFact> = {};
  if (w.precipitationKind !== 'none') out.precipitation = `${w.precipitationKind} ${r1(w.precipitation)}`;
  if (w.inCloud) out.in_cloud = true;
  if (w.iceMm > 0.2) out.icing_mm = r1(w.iceMm);
  const ws = Math.hypot(t.wind[0], t.wind[2]);
  if (ws > 1) {
    out.wind_ms = r1(ws);
    out.wind_from_deg = r0(wrap360(Math.atan2(-t.wind[0], t.wind[2]) * (180 / Math.PI)));
  }
  return out;
}

/** Distance, time and character of a route's points (time at the router's road speeds, capped by `pace`). */
export function routeFacts(points: readonly RoutePoint[], pace: number, world: AdvisorWorld | null): Record<string, BrainFact> & { time: number; length: number } {
  let length = 0, time = 0, highway = 0, outlands = 0, hostile = 0, turns = 0;
  let lastH: number | null = null;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1], b = points[k];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    if (d < 0.5) continue;
    length += d;
    // The first leg starts where the vehicle is, already on a road; later access legs are slow.
    const v = b.kind === 'access' ? (k === 1 ? ROAD_SPEED.street : 8) : ROAD_SPEED[b.kind];
    time += d / Math.min(v, Math.max(3, pace));
    if (b.kind === 'highway') highway += d;
    if (b.kind === 'outlands') outlands += d;
    if (world?.hostileAt(wrapCoord((a.x + b.x) / 2), wrapCoord((a.z + b.z) / 2))) hostile += d;
    const h = Math.atan2(b.x - a.x, -(b.z - a.z)) * (180 / Math.PI);
    if (lastH !== null && Math.abs(((h - lastH + 540) % 360) - 180) > 45) turns++;
    lastH = h;
  }
  const f: Record<string, BrainFact> & { time: number; length: number } = {
    time, length,
    length_m: r0(length),
    drive_min: r1(time / 60),
    highway_pct: length ? r0((100 * (highway + outlands)) / length) : 0,
    turns,
  };
  if (outlands > 0) f.outlands_pct = r0((100 * outlands) / length);
  if (world) f.hostile_territory_m = r0(hostile);
  return f;
}

/** Closest option to a value (for "current"). */
function closest(opts: BrainOption[], key: string, v: number): string {
  let best = opts[0]?.id ?? '', bd = Infinity;
  for (const o of opts) {
    const d = Math.abs(Number(o.facts[key]) - v);
    if (d < bd) { bd = d; best = o.id; }
  }
  return best;
}

/** A spread of up to `n` values from `menu` strictly between lo and hi (exclusive), plus the anchors. */
function menu(values: number[], anchors: number[], lo: number, hi: number, minGap: number): number[] {
  const all = [...anchors.filter((v) => v >= lo && v <= hi), ...values.filter((v) => v >= lo && v <= hi)].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of all) {
    const near = out.findIndex((u) => Math.abs(u - v) < minGap);
    if (near < 0) out.push(v);
    else if (anchors.includes(v)) out[near] = v; // the player's own value wins a tie
  }
  return out;
}

function decision(v: NavView, vehicle: BrainVehicle, trigger: string, situation: Record<string, unknown>, questions: BrainQuestion[], every: number | null): BrainDecision {
  return { seq: v.seq, vehicle, trigger, context: v.context, situation: { ...situation, ...(v.world?.extras() ?? {}) }, questions, instructions: '', every };
}

/**
 * A ground vehicle driving to a destination: its pace, and (when asked for: on engage, after a
 * reroute, at a light wall, when stuck) which route. The route being driven is always option R1,
 * and the alternatives are the fastest ways that keep off its middle stretch.
 */
export function groundDecision(v: NavView, trigger: string, withRoutes: boolean): BuiltDecision | null {
  const drv = v.driver;
  if (v.mode !== 'goto' || !v.dest || !drv.route || !drv.goal) return null;
  const t = v.t;
  const x = t.position[0], z = t.position[2];
  const actions: BuiltDecision['actions'] = { pace: {} };
  const questions: BrainQuestion[] = [];
  // Pace: the menu under the player's limit, and the limit itself.
  const cap = Math.max(3, v.userSpeed);
  const paces = menu(PACES, [cap], 3, cap, 3);
  const paceOpts: BrainOption[] = paces.map((p) => {
    const id = `p${r0(p)}`;
    actions.pace[id] = { kind: 'pace', speed: p };
    return { id, label: `${r0(p)} m/s (${r0(p * 3.6)} km/h)${p === cap ? ', your limit' : ''}`, facts: { speed_ms: r0(p) } };
  });
  questions.push({ id: 'pace', ask: 'Cruise speed (the driver still slows for corners, traffic, light walls and the stop)', options: paceOpts, current: closest(paceOpts, 'speed_ms', v.speed) });
  const here = drv.route.points.slice(Math.max(0, drv.index));
  if (withRoutes) {
    const avoid = drv.avoid();
    const keep = [routeSegments(here)];
    const alts = alternativeRoutes(x, z, drv.goal[0], drv.goal[1], 2, avoid, keep);
    if (alts.length) {
      actions.route = { R1: { kind: 'keep-route' } };
      const cur = routeFacts([{ x, z, kind: 'access' }, ...here.slice(1)], v.speed, v.world);
      const opts: BrainOption[] = [{ id: 'R1', label: 'the route being driven', facts: strip(cur) }];
      alts.forEach((r, k) => {
        const id = `R${k + 2}`;
        const f = routeFacts(r.points, v.speed, v.world);
        f.vs_current_min = r1((f.time - cur.time) / 60);
        actions.route[id] = { kind: 'route', route: r };
        opts.push({ id, label: `alternative ${String.fromCharCode(65 + k + 1)}`, facts: strip(f) });
      });
      questions.unshift({ id: 'route', ask: 'Which road route to drive (all open; closed and blocked roads are already left out)', options: opts, current: 'R1' });
    }
  }
  const st = v.drive;
  const roadNow = here[1]?.kind ?? 'street';
  const situation: Record<string, unknown> = {
    destination: v.dest.name,
    remaining_road_m: r0(st?.remaining ?? drv.length),
    straight_line_m: r0(distance(x, z, v.dest.x, v.dest.z)),
    speed_ms: r1(t.groundSpeed),
    player_speed_limit_ms: r0(cap),
    road_now: roadNow === 'access' ? 'off-road leg' : roadNow,
    ...weather(t),
  };
  if (Number.isFinite(drv.wallAhead)) situation.light_wall_across_road_ahead_m = r0(drv.wallAhead);
  if (st?.stuck) situation.stuck = true;
  if (t.weather.groundWetness > 0.3) situation.road_wet = r1(t.weather.groundWetness);
  if (t.weather.aquaplaning > 0.05) situation.aquaplaning = r1(t.weather.aquaplaning);
  if (t.fuel !== null) situation.fuel_pct = r0(t.fuel * 100);
  const hostile = v.world?.hostileAt(x, z);
  if (hostile) situation.district_held_by_hostile = hostile;
  return { decision: decision(v, 'ground vehicle', trigger, situation, questions, 8), actions };
}

/** Facts without the bookkeeping numbers. */
function strip(f: Record<string, BrainFact> & { time?: number; length?: number }): Record<string, BrainFact> {
  const { time: _t, length: _l, ...rest } = f;
  void _t; void _l;
  return rest;
}

/** Airplane or rotorcraft flying to a destination (Go to): cruise height and speed. */
export function airDecision(v: NavView, trigger: string): BuiltDecision | null {
  if (v.mode !== 'goto' || !v.dest || v.phase === 'takeoff') return null;
  const t = v.t;
  const air = v.kind === 'airplane';
  const x = t.position[0], z = t.position[2];
  const dist = distance(x, z, v.dest.x, v.dest.z);
  const brg = bearing(x, z, v.dest.x, v.dest.z);
  const terrain = terrainHeight(x, z);
  const top = obstacleAhead(x, z, brg, Math.min(dist, air ? 6000 : 2000), air ? 60 : 25);
  const margin = air ? 70 : 25;
  const actions: BuiltDecision['actions'] = { altitude: {}, speed: {} };
  const heights = menu(air ? AIR_HEIGHTS : ROTOR_HEIGHTS, [v.userAltitude], air ? 60 : 5, 6000, air ? 80 : 15);
  const altOpts: BrainOption[] = heights.map((h) => {
    const id = `a${r0(h)}`;
    actions.altitude[id] = { kind: 'altitude', altitude: h };
    const clears = h + terrain >= top + margin;
    return { id, label: `${r0(h)} m above ground${h === v.userAltitude ? ' (player setting)' : ''}`, facts: { height_m: r0(h), clears_obstacles_on_track: clears } };
  });
  const vs = v.stallSpeed;
  const speeds = air
    ? menu([1.5 * vs, 2 * vs, 2.7 * vs, 3.5 * vs].map(r0), [r0(v.userSpeed)], Math.max(25, 1.4 * vs), 250, 6)
    : menu(ROTOR_SPEEDS, [r0(v.userSpeed)], 3, 30, 3);
  const spdOpts: BrainOption[] = speeds.map((s) => {
    const id = `s${r0(s)}`;
    actions.speed[id] = { kind: 'speed', speed: s };
    const facts: Record<string, BrainFact> = air ? { speed_kt: r0(s * KT), x_stall: r1(s / vs) } : { speed_ms: r0(s) };
    return { id, label: air ? `${r0(s * KT)} kt` : `${r0(s)} m/s`, facts };
  });
  const questions: BrainQuestion[] = [
    { id: 'altitude', ask: 'Cruise height above the ground (the Navigator still climbs over anything in the way)', options: altOpts, current: closest(altOpts, 'height_m', v.altitude) },
    { id: 'speed', ask: air ? 'Cruise airspeed' : 'Cruise ground speed', options: spdOpts, current: closest(spdOpts, air ? 'speed_kt' : 'speed_ms', air ? v.speed * KT : v.speed) },
  ];
  const situation: Record<string, unknown> = {
    destination: v.dest.name,
    distance_km: r1(dist / 1000),
    bearing_deg: r0(brg),
    heading_deg: r0(t.heading),
    height_above_ground_m: r0(t.altitude),
    tallest_obstacle_on_track_m: r0(top),
    ground_elevation_m: r0(terrain),
    ...(air ? { airspeed_kt: r0(t.airspeed * KT), stall_kt: r0(vs * KT), mach: Math.round(t.mach * 100) / 100 } : { ground_speed_ms: r1(t.groundSpeed) }),
    ...weather(t),
  };
  if (t.fuel !== null) situation.fuel_pct = r0(t.fuel * 100);
  if (t.brokenParts.length) situation.damaged_parts = t.brokenParts.length;
  const below = v.world?.hostileAt(x, z);
  if (below) situation.over_hostile_district = below;
  const there = v.world?.hostileAt(v.dest.x, v.dest.z);
  if (there) situation.destination_held_by_hostile = there;
  return { decision: decision(v, air ? 'airplane' : 'rotorcraft', trigger, situation, questions, 12), actions };
}

/**
 * Landing: which runway (airplanes, while joining) or helipad (rotorcraft, in transit). Only
 * sites the computer can use are offered: runways long enough for the approach speed, pads
 * standing (not on a fractured tower).
 */
export function landingDecision(v: NavView, trigger: string): BuiltDecision | null {
  const t = v.t;
  const x = t.position[0], z = t.position[2];
  const air = v.kind === 'airplane';
  if (v.mode !== 'land' || !v.dest || v.phase !== (air ? 'join' : 'transit')) return null;
  const need = landingDistanceNeeded(v.approachSpeed);
  const usable = (s: LandingSite) => (air ? s.kind === 'runway' && s.length >= need : s.kind === 'helipad' && siteUsable(s, v.fractured));
  const sites = landingSites().filter(usable).map((s) => ({ s, d: distance(x, z, s.x, s.z) })).sort((a, b) => a.d - b.d);
  const pick = sites.slice(0, air ? 4 : 5);
  const cur = sites.find((e) => e.s.id === v.dest!.id);
  if (cur && !pick.includes(cur)) pick.push(cur);
  if (pick.length < 2) return null;
  const actions: BuiltDecision['actions'] = { site: {} };
  const opts: BrainOption[] = pick.map(({ s, d }) => {
    actions.site[s.id] = { kind: 'site', id: s.id };
    const f: Record<string, BrainFact> = { distance_km: r1(d / 1000) };
    if (air) {
      const ap = chooseApproach(s, x, z, t.wind);
      f.length_m = s.length;
      f.spare_length_m = r0(s.length - need);
      f.landing_heading_deg = r0(ap.heading);
      f.headwind_ms = r1(-(t.wind[0] * ap.dir[0] + t.wind[2] * ap.dir[1]));
      f.crosswind_ms = r1(Math.abs(t.wind[0] * ap.right[0] + t.wind[2] * ap.right[1]));
    } else {
      f.rooftop_m = s.y > 0 ? r0(s.y) : 0;
    }
    const h = v.world?.hostileAt(s.x, s.z);
    if (h) f.held_by_hostile = h;
    return { id: s.id, label: s.name, facts: f };
  });
  const questions: BrainQuestion[] = [{ id: 'site', ask: air ? `Which runway to land on (all at least ${r0(need)} m, enough for this aircraft)` : 'Which helipad to land on', options: opts, current: v.dest.id }];
  const situation: Record<string, unknown> = {
    phase: v.phase,
    height_above_ground_m: r0(t.altitude),
    ...(air ? { airspeed_kt: r0(t.airspeed * KT), approach_speed_kt: r0(v.approachSpeed * KT) } : { ground_speed_ms: r1(t.groundSpeed) }),
    ...weather(t),
  };
  if (t.fuel !== null) situation.fuel_pct = r0(t.fuel * 100);
  if (t.brokenParts.length) situation.damaged_parts = t.brokenParts.length;
  return { decision: decision(v, air ? 'airplane' : 'rotorcraft', trigger, situation, questions, null), actions };
}
