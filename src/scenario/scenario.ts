import { seededRand } from '../people/genome.ts';
import type { PolicyMode } from '../brain/policy.ts';
import { buildDistrict, edgeCapacity, type District, type Layout, type PlaceId, type RoadEdge } from './district.ts';
import { describeRoute, route, routeTime } from './router.ts';
import { drivePolicy, respondPolicy, type DriveAction, type DriveObs } from './policies.ts';
import { clock, explain, type LogEntry } from './log.ts';
import { newSquad, SQUAD, SQUAD_ACTIONS, squadPolicy, squadShape, type DangerZone, type Squad, type SquadObs } from './escort.ts';
import { DRONE, FLIGHT_ACTIONS, flightPolicy, LAND_ACTIONS, landingPolicy, windAt, type Drone, type FlightObs, type LandObs } from './drone.ts';

/**
 * The Scenario Lab: one district run as a whole, its traffic carrying the district's work.
 * Commuters, freight (depot to clinic), ambulances (calls to the clinic), an evacuation (east
 * homes to the shelter) and a military convoy share two crossings; close one and the
 * consequences show in deliveries, response times, shelter places and clinic stock, and last
 * after the closure.
 *
 * - **Policies decide, the engine carries out.** At each decision a road vehicle's policy (a
 *   small network, or the scripted driver) picks follow, yield, merge or reroute. The engine
 *   drives (the Intelligent Driver Model), judges lane changes safe or not, gives the right of
 *   way at junctions one at a time (emergency vehicles first when the player says so), keeps
 *   everyone off closed roads and routes by travel time.
 * - **Detail where it matters.** Near an incident (a closed crossing, a queue) vehicles run in
 *   full: car-following, lane changes, a decision every second. Elsewhere they advance edge by
 *   edge at the speed the road and the vehicle ahead allow, deciding only at each junction. It
 *   is the same vehicle either way: the same cargo, destination and place in the work.
 * - **Everything is recorded.** Each vehicle's log says what it was told, what it saw and what
 *   it decided; `explain` turns that into "North Bridge closed → rerouted via Market Road".
 *
 * Deterministic for a seed. DOM- and scene-free.
 */
export type VehicleKind = 'car' | 'truck' | 'ambulance' | 'evac' | 'convoy';
export type JobKind = 'commute' | 'deliver' | 'respond' | 'return' | 'evacuate' | 'reinforce' | 'idle';

export const KIND: Record<VehicleKind, { len: number; accel: number; brake: number; headway: number; temper: readonly [number, number]; label: string }> = {
  car: { len: 4.5, accel: 2.0, brake: 3.0, headway: 1.2, temper: [0.85, 1.1], label: 'Commuter' },
  truck: { len: 9, accel: 1.0, brake: 2.5, headway: 1.6, temper: [0.8, 0.95], label: 'Freight truck' },
  ambulance: { len: 6, accel: 2.6, brake: 3.5, headway: 1.0, temper: [1.15, 1.25], label: 'Ambulance' },
  evac: { len: 4.5, accel: 1.8, brake: 3.0, headway: 1.3, temper: [0.85, 1.0], label: 'Evacuee' },
  convoy: { len: 10, accel: 0.9, brake: 2.2, headway: 1.8, temper: [0.8, 0.85], label: 'Convoy truck' },
};

export interface Vehicle {
  id: number;
  kind: VehicleKind;
  job: JobKind;
  /** On a call (emergency: right of way, emergency lanes, the respond policy). */
  emergency: boolean;
  urgency: number;
  /** Its route (edges), where it is on it, and where it is on the edge (m). -1: parked at `node`. */
  route: number[];
  ri: number;
  edge: number;
  node: number;
  s: number;
  lane: number;
  speed: number;
  temper: number;
  /** Simulated in full (near an incident) or by edges. */
  detail: boolean;
  /** Closed edges it knows of. */
  known: Set<number>;
  log: LogEntry[];
  /** Standing since when (null: moving), and the junction it last logged a wait at. */
  stoodAt: number | null;
  waitLogged: number;
  yieldUntil: number;
  nextDecide: number;
  decidedOn: number;
  /** The trip: where to, when it set off, its free-flow time, its first estimate (s). */
  dest: number;
  departedAt: number;
  freeTime: number;
  planTime: number;
  dwellUntil: number;
  /** Supplies carried (trucks), the call it serves (ambulances). */
  payload: number;
  call: number;
  /** Commuters: home and work. */
  home: number;
  work: number;
  /** Asked to set off from its node (waiting for the junction). */
  departing: boolean;
  noRouteAt: number;
  /** When it entered its current edge (s). */
  enteredAt: number;
  /** Held up by fighting until then (s). */
  holdUntil: number;
}

export interface ScenarioSettings {
  seed: number;
  driver: PolicyMode;
  layout: Layout;
  /** Scenario times (s): the east bank evacuates, North Bridge closes (null: never), the convoy sets off. */
  evacuateAt: number;
  closeAt: number | null;
  convoyAt: number;
  duration: number;
  /** Level of detail: by incidents (auto), everyone in full, or everyone by edges. */
  lod: 'auto' | 'detail' | 'agg';
  /** Player orders. */
  priorities: { ambulancesFirst: boolean; contraflow: boolean; trucksHold: boolean };
  commuters: number;
  evacuees: number;
  /** Wind for the drone (m/s); the drone launches by itself at this time (null: only when sent). */
  wind: number;
  droneAt: number | null;
  /** Escort a vehicle by itself (the checks; the player orders it on the page): the first freight truck after the closure, or the convoy's lead. */
  escortAuto: 'none' | 'truck' | 'convoy';
  /** The clinic's pad is busy now and then (an ambulance on it). */
  padEvents: boolean;
}

export const DEFAULT_SCENARIO: ScenarioSettings = {
  seed: 1, driver: 'scripted', layout: 'base', evacuateAt: 60, closeAt: 90, convoyAt: 120, duration: 1200, lod: 'auto',
  priorities: { ambulancesFirst: false, contraflow: false, trucksHold: false }, commuters: 80, evacuees: 90,
  wind: 6, droneAt: null, escortAuto: 'none', padEvents: true,
};

export const SCENARIO = {
  dt: 0.25,
  /** Within this of an incident vehicles run in full (m); a queue this long at a junction is one. */
  detailRadius: 250,
  incidentQueue: 5,
  /** Vehicles within this of a closure see it (m); everyone hears of it this long after (s). */
  seeRadius: 250,
  radioDelay: 40,
  /** Detailed vehicles decide this often (s). */
  decideEvery: 1,
  /** A junction is held this long per vehicle let through (s), longer for heavy ones. */
  junction: 0.8,
  junctionHeavy: 1.4,
  /** Clinic: starting stock, use per second and per patient, a delivery's load; shelter places. */
  stock: 15,
  stockUse: 0.06,
  patientUse: 2,
  delivery: 9,
  shelter: 60,
  /** Freight every (s), calls about every (s), ambulances at the station. */
  deliverEvery: 120,
  callEvery: 70,
  ambulances: 3,
} as const;

interface Call { id: number; node: number; at: number; servedBy: number; arrivedAt: number | null }

export interface ScenarioMetrics {
  deliveries: Array<{ dispatched: number; arrived: number | null; lateness: number | null }>;
  responses: Array<{ called: number; arrived: number | null; time: number | null }>;
  evacuation: { evacuees: number; sheltered: number; unsheltered: number; lastArrival: number | null };
  convoy: { arrivedAt: number | null; trucks: number; arrived: number };
  /** Mean extra time per finished trip over free flow (s), the longest queue at a junction, collisions. */
  meanDelay: number;
  maxQueue: number;
  collisions: number;
  closedEntries: number;
  decisions: Record<DriveAction, number>;
  shortage: number;
  stockEnd: number;
  untreated: number;
  /** When the clinic's stock recovered above 10 after first running short (null: never short, or never recovered). */
  recoveredAt: number | null;
  /** Vehicles held up by fighting (and how many of those were escorted). */
  heldUp: number;
  escort: { target: number | null; heldUp: number; done: boolean; tripTime: number | null; decisions: Record<string, number> };
  drone: { state: string; flightTime: number | null; delivered: number; decisions: Record<string, number> };
}

/** A road vehicle as the view draws it. */
export interface VehicleView { id: number; kind: VehicleKind; x: number; z: number; dx: number; dz: number; emergency: boolean; detail: boolean; stopped: boolean }

export class Scenario {
  readonly settings: ScenarioSettings;
  readonly district: District;
  readonly vehicles: Vehicle[] = [];
  time = 0;
  /** Closures: edges, since when, and incident points for the level of detail. */
  readonly closures = new Map<number, number>();
  readonly stock = { level: SCENARIO.stock as number, shortage: 0, untreated: 0, everShort: false, recoveredAt: null as number | null };
  shelterUsed = 0;
  private readonly rand: () => number;
  private readonly load: Float64Array;
  private readonly nodeBusy: Float64Array;
  private readonly calls: Call[] = [];
  private nextCallAt = 30;
  private nextDeliverAt = 20;
  private evacStarted = false;
  private convoyStarted = false;
  private readonly metricsData: ScenarioMetrics;
  private readonly lanes: Vehicle[][][];
  private readonly bestCache = new Map<string, { at: number; r: { edges: number[]; time: number } | null }>();
  private readonly incidents: Array<{ x: number; z: number }> = [];
  private readonly delays: number[] = [];
  /** Decisions as (observation, action) pairs, when recording (training). */
  recording: Array<{ policy: 'drive' | 'respond'; obs: DriveObs; action: DriveAction }> | null = null;
  /** The other policies' decisions as (encoded inputs, action index), when recording. */
  brainLog: Array<{ policy: 'squad' | 'flight' | 'landing'; x: number[]; y: number }> | null = null;
  /** The escort squad, the supply drone, and where there is fighting. */
  squad!: Squad;
  drone!: Drone;
  readonly zones: DangerZone[] = [];
  private escortArmed = false;

  constructor(settings: Partial<ScenarioSettings> = {}) {
    this.settings = { ...DEFAULT_SCENARIO, ...settings, priorities: { ...DEFAULT_SCENARIO.priorities, ...settings.priorities } };
    this.district = buildDistrict(this.settings.layout);
    this.rand = seededRand(this.settings.seed * 2654435761);
    this.load = new Float64Array(this.district.edges.length);
    this.nodeBusy = new Float64Array(this.district.nodes.length);
    this.lanes = this.district.edges.map((e) => Array.from({ length: e.lanes }, () => [] as Vehicle[]));
    this.metricsData = {
      deliveries: [], responses: [], evacuation: { evacuees: 0, sheltered: 0, unsheltered: 0, lastArrival: null }, convoy: { arrivedAt: null, trucks: 0, arrived: 0 },
      meanDelay: 0, maxQueue: 0, collisions: 0, closedEntries: 0, decisions: { follow: 0, yield: 0, merge: 0, reroute: 0 }, shortage: 0, stockEnd: 0, untreated: 0, recoveredAt: null,
      heldUp: 0, escort: { target: null, heldUp: 0, done: false, tripTime: null, decisions: {} }, drone: { state: 'idle', flightTime: null, delivered: 0, decisions: {} },
    };
    const sb = this.district.nodes[this.district.places.westEntry];
    this.squad = newSquad(sb.x + 30, sb.z - 20);
    const dp = this.district.nodes[this.district.places.depot];
    this.drone = { x: dp.x, z: dp.z, heading: 0, battery: DRONE.battery, state: 'idle', path: [], to: 'clinic', heldSince: null, landedAt: 0, launchedAt: 0, log: [], decisions: { straight: 0, crabLeft: 0, crabRight: 0, slow: 0, land: 0, hold: 0, divert: 0 } };
    this.populate();
    this.applyPriorities();
  }

  // ------------------------------------------------------------------ setup

  private add(kind: VehicleKind, node: number, job: JobKind): Vehicle {
    const k = KIND[kind];
    const v: Vehicle = {
      id: this.vehicles.length, kind, job, emergency: false, urgency: 0.3, route: [], ri: 0, edge: -1, node, s: 0, lane: 0, speed: 0,
      temper: k.temper[0] + this.rand() * (k.temper[1] - k.temper[0]), detail: false, known: new Set(), log: [], stoodAt: null, waitLogged: -1,
      yieldUntil: 0, nextDecide: 0, decidedOn: -1, dest: node, departedAt: 0, freeTime: 0, planTime: 0, dwellUntil: Infinity, payload: 0, call: -1,
      home: node, work: node, departing: false, noRouteAt: -Infinity, enteredAt: 0, holdUntil: 0,
    };
    this.vehicles.push(v);
    return v;
  }

  private populate(): void {
    const d = this.district, s = this.settings;
    const homes = [...d.homesWest, ...d.homesEast];
    for (let i = 0; i < s.commuters; i++) {
      const home = homes[Math.floor(this.rand() * homes.length)];
      const other = this.rand() < 0.5 ? (d.nodes[home].bank === 'west' ? d.homesEast : d.homesWest) : homes;
      const v = this.add('car', home, 'commute');
      v.home = home;
      v.work = other[Math.floor(this.rand() * other.length)];
      v.dwellUntil = this.rand() * 300; // sets off sometime in the first five minutes
    }
    for (let i = 0; i < 3; i++) this.add('truck', d.places.depot, 'idle');
    for (let i = 0; i < SCENARIO.ambulances; i++) this.add('ambulance', d.places.station, 'idle');
  }

  /** The player's traffic orders, applied to the roads. */
  applyPriorities(): void {
    const d = this.district;
    const [sbE, sbW] = d.crossings['South Bridge'];
    const base = this.settings.layout === 'emergencyLane' ? 2 : 1;
    if (this.settings.priorities.contraflow) {
      // South Bridge runs both lanes westbound (out of the evacuation); eastbound only for emergencies.
      d.edges[sbW].lanes = 2;
      d.edges[sbE].emergencyOnly = true;
    } else {
      d.edges[sbW].lanes = base;
      d.edges[sbE].emergencyOnly = false;
    }
    while (this.lanes[sbW].length < d.edges[sbW].lanes) this.lanes[sbW].push([]);
  }

  setPriority(key: keyof ScenarioSettings['priorities'], on: boolean): void {
    this.settings.priorities[key] = on;
    this.applyPriorities();
  }

  // ------------------------------------------------------------------ closures

  /** Close a crossing (both directions). Those near see it; everyone hears on the radio a little later. */
  close(name: string): void {
    const pair = this.district.crossings[name];
    if (!pair) return;
    for (const id of pair) {
      this.district.edges[id].closed = true;
      this.closures.set(id, this.time);
    }
    const e = this.district.edges[pair[0]];
    const a = this.district.nodes[e.from], b = this.district.nodes[e.to];
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    // The fight that broke it goes on round its east end for a while.
    this.zones.push({ x: b.x, z: b.z, r: 170, until: this.time + 360, name: `${name} east head` });
    for (const v of this.vehicles) {
      if (v.edge < 0) continue;
      const p = this.posOf(v);
      if (Math.hypot(p.x - mx, p.z - mz) < SCENARIO.seeRadius) this.learn(v, pair, `saw ${name} closed`);
    }
  }

  reopen(name: string): void {
    const pair = this.district.crossings[name];
    if (!pair) return;
    for (const id of pair) {
      this.district.edges[id].closed = false;
      this.closures.delete(id);
      for (const v of this.vehicles) v.known.delete(id);
    }
  }

  private learn(v: Vehicle, ids: readonly number[], how: string): void {
    let fresh = false;
    for (const id of ids) if (!v.known.has(id)) { v.known.add(id); fresh = true; }
    if (!fresh) return;
    const onRoute = ids.some((id) => v.route.indexOf(id, v.ri) >= 0);
    if (onRoute) {
      this.note(v, 'closure', `${how} (${clock(this.time)})`);
      v.nextDecide = this.time; // think again now
      v.decidedOn = -1;
    }
  }

  // ------------------------------------------------------------------ jobs

  private note(v: Vehicle, kind: LogEntry['kind'], text: string): void {
    v.log.push({ t: this.time, kind, text });
    if (v.log.length > 40) v.log.shift();
  }

  /** Set a vehicle off to `dest` on `job` (it waits at its node for the junction). */
  private trip(v: Vehicle, dest: number, job: JobKind): void {
    const was = v.job;
    v.job = job;
    v.emergency = job === 'respond';
    v.urgency = job === 'respond' ? 1 : job === 'reinforce' ? 0.8 : job === 'evacuate' ? 0.7 : job === 'deliver' ? 0.5 : job === 'return' ? 0.3 : 0.2;
    if (was !== job && (v.kind === 'ambulance' || was !== 'idle')) this.note(v, 'policy', `${job === 'respond' ? 'respond' : 'drive'} policy (${job})`);
    v.dest = dest;
    const free = route(this.district, v.node, dest, { known: new Set(), emergency: v.emergency, load: new Float64Array(this.district.edges.length) });
    const now = route(this.district, v.node, dest, { known: v.known, emergency: v.emergency, load: this.load });
    v.freeTime = free?.time ?? 0;
    v.planTime = now?.time ?? 0;
    if (!now) {
      v.route = [];
      if (this.time - v.noRouteAt > 30) this.note(v, 'route', `no way to ${this.district.nodes[dest].name}: waiting`);
      v.noRouteAt = this.time;
      v.departing = false;
      v.dwellUntil = this.time + 10;
      return;
    }
    v.route = now.edges;
    v.ri = 0;
    v.departing = true;
    v.departedAt = this.time;
    this.note(v, 'route', `${this.district.nodes[dest].name} ${describeRoute(this.district, now.edges)} (est ${(now.time / 60).toFixed(1)} min)`);
  }

  // ------------------------------------------------------------------ escort and drone

  /** The player's order: escort this vehicle (null: stand the squad down). Holds until it arrives or the order changes. */
  escort(id: number | null): void {
    const sq = this.squad;
    sq.target = id;
    this.metricsData.escort = { target: id, heldUp: 0, done: false, tripTime: null, decisions: {} };
    if (id !== null) {
      const v = this.vehicles[id];
      sq.log.push({ t: this.time, text: `ordered to escort ${KIND[v.kind].label} #${id}` });
      this.note(v, 'job', 'escort squad assigned');
    }
  }

  /** Is this vehicle escorted from where it counts (the squad ahead of it, or on its flank, within reach)? */
  private escortedBy(v: Vehicle, slots: readonly string[]): boolean {
    const sq = this.squad;
    if (sq.target !== v.id || !slots.includes(sq.slot)) return false;
    const c = squadShape(sq), p = this.posOf(v);
    return c.units > 0 && Math.hypot(c.x - p.x, c.z - p.z) < SQUAD.reach;
  }

  private threatAt(x: number, z: number): number {
    let t = 0;
    for (const zn of this.zones) if (this.time < zn.until) t = Math.max(t, 1 - Math.hypot(zn.x - x, zn.z - z) / zn.r);
    return Math.max(0, t);
  }

  private stepSquad(dt: number): void {
    const sq = this.squad, d = this.district;
    const target = sq.target !== null ? this.vehicles[sq.target] : null;
    if (target && target.edge < 0 && !target.departing) {
      // It arrived: the order is done.
      sq.log.push({ t: this.time, text: `escort done: ${KIND[target.kind].label} #${target.id} arrived` });
      this.metricsData.escort.done = true;
      this.metricsData.escort.tripTime = this.time - target.departedAt;
      sq.target = null;
    }
    const c = squadShape(sq);
    if (target && target.edge >= 0 && this.time >= sq.nextDecide) {
      sq.nextDecide = this.time + SQUAD.decideEvery;
      const p = this.posOf(target);
      // Fighting on the way: any of its next two junctions in a zone.
      let threatAhead = 0;
      for (let i = target.ri; i < Math.min(target.route.length, target.ri + 3); i++) {
        const n = d.nodes[d.edges[target.route[i]].to];
        threatAhead = Math.max(threatAhead, this.threatAt(n.x, n.z) > 0 ? 1 : 0);
      }
      const lane = this.lanes[target.edge][target.lane] ?? [];
      const obs: SquadObs = {
        dist: Math.hypot(c.x - p.x, c.z - p.z), targetSpeed: target.speed, spread: c.spread, threatAhead, threatNear: this.threatAt(c.x, c.z),
        units: c.units, urgency: target.urgency, queueAhead: lane.filter((o) => o.s > target.s && o.speed < 1).length,
      };
      const dec = squadPolicy.decide(obs, this.settings.driver);
      if (this.brainLog) this.brainLog.push({ policy: 'squad', x: squadPolicy.encode(obs), y: SQUAD_ACTIONS.indexOf(dec.action) });
      const dec0 = this.metricsData.escort.decisions;
      dec0[dec.action] = (dec0[dec.action] ?? 0) + 1;
      sq.decisions[dec.action]++;
      if (dec.action !== sq.slot) sq.log.push({ t: this.time, text: `${dec.action}${dec.action === 'ahead' ? ' (clear the way)' : dec.action === 'regroup' ? ` (spread ${c.spread.toFixed(0)} m)` : ''}` });
      sq.slot = dec.action;
    }
    // Where it holds, and the units moving there (each at its own pace).
    if (target && target.edge >= 0) {
      const p = this.posOf(target);
      const off = sq.slot === 'ahead' ? SQUAD.ahead : sq.slot === 'behind' ? -SQUAD.behind : sq.slot === 'fallback' ? -SQUAD.fallback : 0;
      sq.aim = sq.slot === 'regroup' ? { x: c.x, z: c.z } : sq.slot === 'flank' ? { x: p.x - p.dz * SQUAD.flank, z: p.z + p.dx * SQUAD.flank } : { x: p.x + p.dx * off, z: p.z + p.dz * off };
    }
    sq.units.forEach((u, i) => {
      if (u.down) return;
      const gx = sq.aim.x + (i % 2 ? 3 : -3), gz = sq.aim.z + (i < 2 ? 3 : -3);
      const dx = gx - u.x, dz = gz - u.z, dd = Math.hypot(dx, dz);
      const step = Math.min(dd, SQUAD.speed * u.lag * dt * (sq.slot === 'regroup' ? 0.6 : 1));
      if (dd > 1e-6) { u.x += (dx / dd) * step; u.z += (dz / dd) * step; }
      // In the fighting, a unit can be hurt (seeded); the squad fights on with fewer.
      if (this.threatAt(u.x, u.z) > 0.5 && this.rand() < 0.0004) { u.down = true; sq.log.push({ t: this.time, text: `a unit is down (${squadShape(sq).units} left)` }); }
    });
  }

  /** Send the drone from the depot to the clinic with a small delivery. False if it is not at the depot. */
  sendDrone(): boolean {
    const dr = this.drone, d = this.district;
    if (dr.state !== 'idle') return false;
    const clinic = d.nodes[d.places.clinic];
    dr.path = [{ x: (dr.x + clinic.x) / 2, z: (dr.z + clinic.z) / 2 - 120 }, { x: clinic.x, z: clinic.z }];
    dr.to = 'clinic';
    dr.state = 'flying';
    dr.launchedAt = this.time;
    dr.log.push({ t: this.time, text: `launched for the clinic with ${DRONE.payload} units` });
    return true;
  }

  /** Is the clinic's pad free? (An ambulance stands on it now and then.) */
  padBusy(): boolean {
    if (!this.settings.padEvents) return false;
    const t = this.time;
    return (t > 170 && t < 215) || (t > 520 && t < 565);
  }

  private stepDrone(dt: number): void {
    const dr = this.drone, d = this.district;
    if (dr.state === 'idle' || dr.state === 'delivered' || dr.state === 'diverted' || dr.state === 'lost') return;
    const w = windAt(this.time, this.settings.wind, this.settings.seed);
    const pad = dr.path[dr.path.length - 1];
    if (dr.state === 'landing') {
      if (this.time - dr.landedAt >= DRONE.landTime) {
        if (dr.to === 'clinic') {
          this.stock.level += DRONE.payload;
          this.metricsData.drone.delivered += DRONE.payload;
          dr.state = 'delivered';
          dr.log.push({ t: this.time, text: `delivered ${DRONE.payload} units to the clinic` });
        } else {
          dr.state = 'diverted';
          dr.log.push({ t: this.time, text: 'landed at the shelter (diverted): delivery not made' });
        }
        this.metricsData.drone.flightTime = this.time - dr.launchedAt;
      }
      return;
    }
    dr.battery -= dt * (dr.state === 'holding' ? DRONE.holdCost : 1);
    if (dr.battery <= 0) { dr.state = 'lost'; dr.log.push({ t: this.time, text: 'battery flat: down' }); return; }
    const near = Math.hypot(pad.x - dr.x, pad.z - dr.z);
    if (dr.path.length === 1 && near < DRONE.approach) {
      // At the pad: the landing policy.
      const shelter = d.nodes[d.places.shelter];
      const obs: LandObs = { padBusy: dr.to === 'clinic' && this.padBusy() ? 1 : 0, battery: dr.battery / DRONE.battery, dist: near, wind: Math.hypot(w.x, w.z), altDist: Math.hypot(shelter.x - dr.x, shelter.z - dr.z), held: dr.heldSince === null ? 0 : this.time - dr.heldSince };
      const dec = landingPolicy.decide(obs, this.settings.driver);
      if (this.brainLog) this.brainLog.push({ policy: 'landing', x: landingPolicy.encode(obs), y: LAND_ACTIONS.indexOf(dec.action) });
      dr.decisions[dec.action]++;
      if (dec.action === 'land' && !obs.padBusy) {
        dr.state = 'landing';
        dr.landedAt = this.time;
        dr.x = pad.x; dr.z = pad.z;
        return;
      }
      if (dec.action === 'divert') {
        dr.path = [{ x: shelter.x, z: shelter.z }];
        dr.to = 'shelter';
        dr.state = 'flying';
        dr.heldSince = null;
        dr.log.push({ t: this.time, text: `pad busy, battery ${(obs.battery * 100).toFixed(0)}%: diverting to the shelter` });
        return;
      }
      // Hold (or a landing refused because the pad is taken): circle.
      if (dr.heldSince === null) { dr.heldSince = this.time; dr.log.push({ t: this.time, text: 'pad busy: holding' }); }
      dr.state = 'holding';
      dr.heading += dt * 0.6;
      dr.x = pad.x + Math.cos(dr.heading) * 18;
      dr.z = pad.z + Math.sin(dr.heading) * 18;
      return;
    }
    dr.state = 'flying';
    const wp = dr.path[0];
    const tx = wp.x - dr.x, tz = wp.z - dr.z, dist = Math.hypot(tx, tz);
    if (dr.path.length > 1 && dist < 20) { dr.path.shift(); return; }
    const want = Math.atan2(tz, tx);
    // Wind across the track (+ pushes it to the left of the line, with +x east and +z south) and along it.
    const ux = tx / Math.max(1e-6, dist), uz = tz / Math.max(1e-6, dist);
    const cross = -(w.x * -uz + w.z * ux), head = w.x * ux + w.z * uz;
    // The drift: where the wind would take it over the ground if it headed straight down the line.
    const gx = Math.cos(want) * DRONE.airspeed + w.x, gz = Math.sin(want) * DRONE.airspeed + w.z;
    let err = Math.atan2(gz, gx) - want;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const obs: FlightObs = { bearingErr: err, dist, last: dr.path.length === 1 ? 1 : 0, cross, head, speed: DRONE.airspeed + head, battery: dr.battery / DRONE.battery };
    const dec = flightPolicy.decide(obs, this.settings.driver);
    if (this.brainLog) this.brainLog.push({ policy: 'flight', x: flightPolicy.encode(obs), y: FLIGHT_ACTIONS.indexOf(dec.action) });
    dr.decisions[dec.action]++;
    const crab = dec.action === 'crabLeft' ? -DRONE.crab : dec.action === 'crabRight' ? DRONE.crab : 0;
    // Crabbing right means heading to the right of the line (clockwise seen from above: +angle).
    dr.heading = want + crab;
    const air = dec.action === 'slow' ? DRONE.slow : DRONE.airspeed;
    dr.x += (Math.cos(dr.heading) * air + w.x) * dt;
    dr.z += (Math.sin(dr.heading) * air + w.z) * dt;
  }

  /** A new job for a vehicle already on the road: a route on from the end of its edge. */
  private retask(v: Vehicle, dest: number, job: JobKind): void {
    const d = this.district, e = d.edges[v.edge];
    v.job = job;
    v.emergency = job === 'respond';
    v.urgency = job === 'respond' ? 1 : 0.3;
    this.note(v, 'policy', `${v.emergency ? 'respond' : 'drive'} policy (${job}, re-tasked on the road)`);
    v.dest = dest;
    const now = route(d, e.to, dest, { known: v.known, emergency: v.emergency, load: this.load });
    const free = route(d, e.to, dest, { known: new Set(), emergency: v.emergency, load: new Float64Array(d.edges.length) });
    const rest = (e.length - v.s) / e.limit;
    v.departedAt = this.time;
    v.freeTime = (free?.time ?? 0) + rest;
    v.planTime = (now?.time ?? 0) + rest;
    v.route = [v.edge, ...(now?.edges ?? [])];
    v.ri = 0;
    v.decidedOn = -1;
    this.note(v, 'route', `${d.nodes[dest].name} ${describeRoute(d, v.route)} (est ${(v.planTime / 60).toFixed(1)} min)`);
  }

  /** The policy a vehicle's job calls for. */
  policyOf(v: Vehicle) {
    return v.emergency ? respondPolicy : drivePolicy;
  }

  /** Arrived at the end of its route: what its job does next. */
  private arrive(v: Vehicle): void {
    const d = this.district;
    const took = this.time - v.departedAt;
    if (v.freeTime > 0) this.delays.push(Math.max(0, took - v.freeTime));
    this.note(v, 'arrive', `arrived at ${d.nodes[v.node].name} after ${(took / 60).toFixed(1)} min`);
    v.route = [];
    switch (v.job) {
      case 'commute': {
        const toWork = v.node === v.work;
        v.dwellUntil = this.time + 120 + this.rand() * 180;
        v.dest = toWork ? v.home : v.work;
        break;
      }
      case 'deliver': {
        this.stock.level += v.payload;
        v.payload = 0;
        const rec = this.metricsData.deliveries.find((r) => r.dispatched === v.departedAt && r.arrived === null);
        if (rec) { rec.arrived = this.time; rec.lateness = Math.max(0, took - v.freeTime); }
        v.dwellUntil = this.time + 20;
        v.dest = d.places.depot;
        v.job = 'return';
        break;
      }
      case 'respond': {
        const c = this.calls[v.call];
        if (v.node === c.node) { v.dwellUntil = this.time + 15; v.dest = d.places.clinic; }
        else {
          c.arrivedAt = this.time;
          const rec = this.metricsData.responses[c.id];
          rec.arrived = this.time;
          rec.time = this.time - c.at;
          if (this.stock.level <= 0) this.stock.untreated++;
          this.stock.level -= SCENARIO.patientUse;
          v.call = -1;
          v.dwellUntil = this.time + 10;
          v.dest = d.places.station;
          v.job = 'return';
          v.emergency = false;
          this.note(v, 'policy', 'drive policy (call over)');
        }
        break;
      }
      case 'return':
        v.job = 'idle';
        v.dwellUntil = Infinity;
        break;
      case 'evacuate': {
        const ev = this.metricsData.evacuation;
        if (this.shelterUsed < SCENARIO.shelter) { this.shelterUsed++; ev.sheltered++; } else ev.unsheltered++;
        ev.lastArrival = this.time;
        v.job = 'idle';
        v.dwellUntil = Infinity;
        break;
      }
      case 'reinforce': {
        const cv = this.metricsData.convoy;
        cv.arrived++;
        if (cv.arrived === cv.trucks) cv.arrivedAt = this.time - this.settings.convoyAt;
        v.job = 'idle';
        v.dwellUntil = Infinity;
        break;
      }
      default:
        v.dwellUntil = Infinity;
    }
  }

  /** Scheduled work: calls, freight, the evacuation, the convoy, the closure and its news. */
  private events(): void {
    const s = this.settings, d = this.district, t = this.time;
    if (s.closeAt !== null && t >= s.closeAt && !this.closures.size && !this.closedOnce) {
      this.closedOnce = true;
      this.close('North Bridge');
    }
    // The news reaches everyone.
    for (const [id, since] of this.closures) if (t >= since + SCENARIO.radioDelay && t - SCENARIO.dt < since + SCENARIO.radioDelay) {
      for (const v of this.vehicles) this.learn(v, [id, d.edges[id].twin], `heard ${d.edges[id].name} closed on the radio`);
    }
    if (t >= this.nextCallAt) {
      const homes = [...d.homesWest, ...d.homesEast];
      const node = homes[Math.floor(this.rand() * homes.length)];
      const c: Call = { id: this.calls.length, node, at: t, servedBy: -1, arrivedAt: null };
      this.calls.push(c);
      this.metricsData.responses.push({ called: t, arrived: null, time: null });
      this.nextCallAt = t + SCENARIO.callEvery * (0.7 + 0.6 * this.rand());
    }
    for (const c of this.calls) {
      if (c.servedBy >= 0) continue;
      // The nearest ambulance free to go: idle at the station, or on its way back.
      const cn = d.nodes[c.node];
      let amb: Vehicle | null = null, bestD = Infinity;
      for (const v of this.vehicles) {
        if (v.kind !== 'ambulance' || !(v.job === 'idle' || v.job === 'return')) continue;
        const p = this.posOf(v), dd = Math.hypot(p.x - cn.x, p.z - cn.z);
        if (dd < bestD) { bestD = dd; amb = v; }
      }
      if (!amb) break;
      c.servedBy = amb.id;
      amb.call = c.id;
      amb.dwellUntil = Infinity;
      if (amb.edge >= 0) this.retask(amb, c.node, 'respond');
      else this.trip(amb, c.node, 'respond');
    }
    const evacOn = this.evacStarted && this.vehicles.some((v) => v.job === 'evacuate');
    if (t >= this.nextDeliverAt && !(s.priorities.trucksHold && evacOn)) {
      const truck = this.vehicles.find((v) => v.kind === 'truck' && v.job === 'idle' && v.edge < 0 && v.node === d.places.depot);
      if (truck) {
        truck.payload = SCENARIO.delivery;
        this.trip(truck, d.places.clinic, 'deliver');
        this.metricsData.deliveries.push({ dispatched: truck.departedAt, arrived: null, lateness: null });
        if (s.escortAuto === 'truck' && !this.escortArmed && this.closures.size) { this.escortArmed = true; this.escort(truck.id); }
      }
      this.nextDeliverAt = t + SCENARIO.deliverEvery;
    }
    if (!this.evacStarted && t >= s.evacuateAt) {
      this.evacStarted = true;
      for (let i = 0; i < s.evacuees; i++) {
        const home = d.homesEast[Math.floor(this.rand() * d.homesEast.length)];
        const v = this.add('evac', home, 'idle');
        v.dwellUntil = t + this.rand() * 45;
        v.dest = d.places.shelter;
        v.job = 'evacuate';
      }
      this.metricsData.evacuation.evacuees = s.evacuees;
    }
    if (!this.convoyStarted && t >= s.convoyAt) {
      this.convoyStarted = true;
      for (let i = 0; i < 4; i++) {
        const v = this.add('convoy', d.places.westEntry, 'idle');
        v.dwellUntil = t + i * 6;
        v.dest = d.places.eastExit;
        v.job = 'reinforce';
        if (i === 0 && s.escortAuto === 'convoy') this.escort(v.id);
      }
      this.metricsData.convoy.trucks = 4;
    }
    if (s.droneAt !== null && t >= s.droneAt && this.drone.state === 'idle' && !this.droneSent) { this.droneSent = true; this.sendDrone(); }
    // Vehicles whose dwell is over set off.
    for (const v of this.vehicles) {
      if (v.edge >= 0 || v.departing || t < v.dwellUntil) continue;
      if (v.job === 'idle') continue;
      if (v.job === 'commute' && v.dest === v.node) v.dest = v.node === v.home ? v.work : v.home;
      this.trip(v, v.dest, v.job);
    }
  }
  private closedOnce = false;
  private droneSent = false;

  // ------------------------------------------------------------------ the drive

  /** Where a vehicle is (lane offset to the right of its way). */
  posOf(v: Vehicle): { x: number; z: number; dx: number; dz: number } {
    const d = this.district;
    if (v.edge < 0) { const n = d.nodes[v.node]; return { x: n.x, z: n.z, dx: 1, dz: 0 }; }
    const e = d.edges[v.edge], a = d.nodes[e.from], b = d.nodes[e.to];
    const dx = (b.x - a.x) / e.length, dz = (b.z - a.z) / e.length;
    const k = Math.min(1, v.s / e.length), off = 2.5 + v.lane * 3.5;
    // Right of travel, with +x east and +z south: (-dz, dx).
    return { x: a.x + (b.x - a.x) * k - dz * off, z: a.z + (b.z - a.z) * k + dx * off, dx, dz };
  }

  private rebuildLanes(): void {
    for (const l of this.lanes) for (const q of l) q.length = 0;
    this.load.fill(0);
    for (const v of this.vehicles) {
      if (v.edge < 0) continue;
      const q = this.lanes[v.edge];
      while (q.length <= v.lane) q.push([]);
      q[v.lane].push(v);
      this.load[v.edge] += 1;
    }
    for (let i = 0; i < this.load.length; i++) this.load[i] /= edgeCapacity(this.district.edges[i]);
    for (const l of this.lanes) for (const q of l) q.sort((a, b) => b.s - a.s);
  }

  /** The vehicle ahead in `lane` of `edge` from position `s` (null if none). */
  private ahead(edge: number, lane: number, s: number, self?: Vehicle): Vehicle | null {
    const q = this.lanes[edge][lane] ?? [];
    let best: Vehicle | null = null;
    for (const o of q) if (o !== self && o.s > s && (!best || o.s < best.s)) best = o;
    return best;
  }

  private behind(edge: number, lane: number, s: number, self?: Vehicle): Vehicle | null {
    const q = this.lanes[edge][lane] ?? [];
    let best: Vehicle | null = null;
    for (const o of q) if (o !== self && o.s <= s && (!best || o.s > best.s)) best = o;
    return best;
  }

  /** May `v` use lane `lane` of edge `e`? (An emergency lane is for emergencies.) */
  private laneAllowed(v: Vehicle, e: RoadEdge, lane: number): boolean {
    return lane < e.lanes && !(e.emergencyLane && lane === 1 && !v.emergency);
  }

  /** The room at the start of `edge`'s `lane` (m) before the last vehicle's rear. */
  private entryRoom(edge: number, lane: number): number {
    const q = this.lanes[edge][lane] ?? [];
    let tail = Infinity;
    for (const o of q) tail = Math.min(tail, o.s - KIND[o.kind].len);
    return tail;
  }

  /** The lane `v` would enter `edge` in, or -1 if there is no room. */
  private entryLane(v: Vehicle, edge: number): number {
    const e = this.district.edges[edge];
    let best = -1, room = 2;
    for (let l = 0; l < e.lanes; l++) {
      if (!this.laneAllowed(v, e, l)) continue;
      const r = this.entryRoom(edge, l);
      if (r > room) { room = r; best = l; }
    }
    // An emergency vehicle prefers its own lane when it has one.
    if (v.emergency && e.emergencyLane && this.entryRoom(edge, 1) > 2) best = 1;
    return best;
  }

  /** Can `v` pass the junction ahead into the next edge of its route? */
  private canEnter(v: Vehicle, next: number): boolean {
    const e = this.district.edges[next];
    if (e.closed || (e.emergencyOnly && !v.emergency)) return false;
    return this.entryLane(v, next) >= 0;
  }

  private observe(v: Vehicle): DriveObs {
    const d = this.district, e = d.edges[v.edge];
    const lead = this.ahead(v.edge, v.lane, v.s, v);
    const gap = lead ? lead.s - KIND[lead.kind].len - v.s : 120;
    const other = 1 - v.lane;
    const laneFree = e.lanes > 1 && this.laneAllowed(v, e, other) ? 1 : 0;
    const ol = laneFree ? this.ahead(v.edge, other, v.s, v) : null;
    const next = v.route[v.ri + 1];
    const nextQueue = next !== undefined ? (this.lanes[next] ?? []).reduce((n, q) => n + q.filter((o) => o.speed < 1).length, 0) : 0;
    const nextClosed = next !== undefined && (v.known.has(next) || (d.edges[next].emergencyOnly && !v.emergency)) ? 1 : 0;
    let emergencyBehind = 0;
    if (!v.emergency) for (const q of this.lanes[v.edge]) for (const o of q) if ((o.emergency || this.escortedBy(o, ['ahead'])) && o.s < v.s && v.s - o.s < 60) emergencyBehind = 1;
    // The route's delay against the best one it knows (from the end of this edge).
    const cur = routeTime(d, v.route, v.ri + 1, 0, this.load);
    const best = this.best(e.to, v.dest, v);
    const delay = best ? Math.max(0, cur - best.time) : 0;
    return {
      speed: v.speed, limit: e.limit, gap, closing: lead ? v.speed - lead.speed : 0, nextQueue, nextClosed,
      laneGap: ol ? ol.s - KIND[ol.kind].len - v.s : laneFree ? 120 : 0, laneFree, emergencyBehind, urgency: v.urgency,
      delay, waited: v.stoodAt === null ? 0 : this.time - v.stoodAt, toNode: e.length - v.s, heavy: v.kind === 'truck' || v.kind === 'convoy' ? 1 : 0,
    };
  }

  /** The best route from a node (cached for a couple of seconds per what the driver knows). */
  private best(from: number, to: number, v: Vehicle): { edges: number[]; time: number } | null {
    const key = `${from},${to},${v.emergency ? 1 : 0},${[...v.known].sort((a, b) => a - b).join('.')}`;
    const hit = this.bestCache.get(key);
    if (hit && this.time - hit.at < 2) return hit.r;
    const r = route(this.district, from, to, { known: v.known, emergency: v.emergency, load: this.load });
    this.bestCache.set(key, { at: this.time, r });
    return r;
  }

  private decide(v: Vehicle): void {
    const pol = this.policyOf(v);
    const obs = this.observe(v);
    const dec = pol.decide(obs, this.settings.driver);
    if (this.recording) this.recording.push({ policy: pol.id as 'drive' | 'respond', obs, action: dec.action });
    this.metricsData.decisions[dec.action]++;
    const d = this.district, e = d.edges[v.edge];
    switch (dec.action) {
      case 'reroute': {
        const best = this.best(e.to, v.dest, v);
        if (!best) { if (this.time - v.noRouteAt > 30) { this.note(v, 'route', 'no way through: waiting'); v.noRouteAt = this.time; } break; }
        const rest = v.route.slice(v.ri + 1);
        if (rest.join() === best.edges.join()) break;
        v.route = [...v.route.slice(0, v.ri + 1), ...best.edges];
        const eta = this.time - v.departedAt + (e.length - v.s) / Math.max(1, e.limit) + best.time;
        const extra = (eta - v.planTime) / 60;
        this.note(v, 'reroute', `rerouted ${describeRoute(d, best.edges)} (${extra >= 0 ? '+' : ''}${extra.toFixed(1)} min)`);
        break;
      }
      case 'yield': {
        if (v.lane === 1 && this.laneAllowed(v, e, 0) && this.laneSafe(v, 0)) v.lane = 0;
        if (this.time >= v.yieldUntil) this.note(v, 'yield', obs.emergencyBehind ? 'yielded to an ambulance' : 'eased off and moved over');
        v.yieldUntil = this.time + 4;
        break;
      }
      case 'merge': {
        const other = 1 - v.lane;
        if (e.lanes > 1 && this.laneAllowed(v, e, other) && this.laneSafe(v, other)) v.lane = other;
        break;
      }
      default:
        break;
    }
  }

  /** The engine's check: is there room to move into `lane` here? */
  private laneSafe(v: Vehicle, lane: number): boolean {
    const a = this.ahead(v.edge, lane, v.s, v), b = this.behind(v.edge, lane, v.s, v);
    const front = a ? a.s - KIND[a.kind].len - v.s : Infinity;
    const back = b ? v.s - KIND[v.kind].len - b.s : Infinity;
    return front > 6 + v.speed * 0.8 && back > 5 + (b ? b.speed * 1.0 : 0);
  }

  /** One step of the Scenario Lab. */
  step(): void {
    const dt = SCENARIO.dt, d = this.district, s = this.settings;
    this.time += dt;
    this.events();
    this.rebuildLanes();
    // Level of detail: incidents are closed crossings and long queues (and anything the view focuses on).
    this.incidents.length = 0;
    for (const id of this.closures.keys()) {
      const e = d.edges[id], a = d.nodes[e.from], b = d.nodes[e.to];
      this.incidents.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
    }
    let maxQueue = 0;
    for (const e of d.edges) {
      let q = 0;
      for (const lane of this.lanes[e.id]) for (const o of lane) if (o.speed < 1 && e.length - o.s < 80) q++;
      maxQueue = Math.max(maxQueue, q);
      if (q >= SCENARIO.incidentQueue) { const n = d.nodes[e.to]; this.incidents.push({ x: n.x, z: n.z }); }
    }
    this.metricsData.maxQueue = Math.max(this.metricsData.maxQueue, maxQueue);
    for (const v of this.vehicles) {
      if (v.edge < 0) continue;
      if (s.lod === 'detail') v.detail = true;
      else if (s.lod === 'agg') v.detail = false;
      else { const p = this.posOf(v); v.detail = this.incidents.some((i) => Math.hypot(i.x - p.x, i.z - p.z) < SCENARIO.detailRadius); }
      // Closures in sight.
      for (const id of this.closures.keys()) {
        if (v.known.has(id)) continue;
        const e = d.edges[id], a = d.nodes[e.from], b = d.nodes[e.to], p = this.posOf(v);
        if (Math.hypot((a.x + b.x) / 2 - p.x, (a.z + b.z) / 2 - p.z) < SCENARIO.seeRadius) this.learn(v, [id, e.twin], `saw ${e.name} closed`);
      }
    }
    // Decisions.
    for (const v of this.vehicles) {
      if (v.edge < 0 || v.ri >= v.route.length - 1) continue;
      const e = d.edges[v.edge];
      if (v.detail ? this.time >= v.nextDecide : v.decidedOn !== v.edge && e.length - v.s < 40) {
        this.decide(v);
        v.nextDecide = this.time + SCENARIO.decideEvery;
        v.decidedOn = v.edge;
      }
    }
    // Nobody may be on a closed road who entered it after it closed.
    for (const v of this.vehicles) if (v.edge >= 0 && d.edges[v.edge].closed && (this.closures.get(v.edge) ?? Infinity) < v.enteredAt) this.metricsData.closedEntries++;
    // Moving: each lane front to back.
    for (const e of d.edges) for (const q of this.lanes[e.id]) {
      for (let i = 0; i < q.length; i++) {
        const v = q[i], k = KIND[v.kind];
        const lead = i > 0 ? q[i - 1] : null;
        const yieldK = this.time < v.yieldUntil ? 0.5 : 1;
        const v0 = Math.max(0.5, e.limit * v.temper * yieldK);
        const next = v.route[v.ri + 1];
        const atEnd = v.ri >= v.route.length - 1;
        // What it must stop for: the vehicle ahead, or the junction if it cannot go on.
        let gap = lead ? lead.s - KIND[lead.kind].len - v.s : Infinity, lv = lead ? lead.speed : 0;
        if (this.time < v.holdUntil) { gap = 0; lv = 0; }
        if (!atEnd && next !== undefined && !this.canEnter(v, next)) {
          const g = e.length - v.s - 0.5;
          if (g < gap) { gap = g; lv = 0; }
        } else if (!atEnd && next !== undefined && !lead) {
          // Look through the junction at the tail of the next edge.
          const room = Math.min(...Array.from({ length: d.edges[next].lanes }, (_, l) => this.entryRoom(next, l)));
          gap = e.length - v.s + room;
        }
        gap = Math.max(0, gap);
        if (v.detail) {
          const sStar = 2 + v.speed * k.headway + (v.speed * (v.speed - lv)) / (2 * Math.sqrt(k.accel * k.brake));
          const a = k.accel * (1 - (v.speed / v0) ** 4 - (Number.isFinite(gap) ? (Math.max(0, sStar) / Math.max(0.1, gap)) ** 2 : 0));
          v.speed = Math.max(0, v.speed + Math.max(-9, a) * dt);
        } else {
          // By edges: the speed the road allows, gathered at the vehicle's pace and never more
          // than it could still stop from in the gap (so whoever follows in full can keep up).
          const safe = Number.isFinite(gap) ? Math.sqrt(2 * k.brake * Math.max(0, gap - 2)) : v0;
          v.speed = Math.max(0, Math.min(v0, v.speed + k.accel * dt, safe));
        }
        let ns = v.s + v.speed * dt;
        // The engine never lets two overlap: a vehicle that would have is a collision.
        if (lead) {
          const limit = lead.s - KIND[lead.kind].len - 0.3;
          if (ns > limit) { if (v.speed - lead.speed > 2) this.metricsData.collisions++; ns = Math.max(v.s, limit); v.speed = Math.min(v.speed, lead.speed); }
        }
        // Waiting to go on, it holds at the stop line.
        if (!atEnd && ns > e.length) { ns = e.length; v.speed = Math.min(v.speed, 1); }
        v.s = ns;
        if (v.speed < 0.5) { if (v.stoodAt === null) v.stoodAt = this.time; }
        else v.stoodAt = null;
      }
    }
    // Junctions: vehicles at the end of an edge (and those setting off from a node) ask to go on.
    const asks: Array<{ v: Vehicle; node: number; next: number; since: number }> = [];
    for (const v of this.vehicles) {
      if (v.edge >= 0) {
        const e = d.edges[v.edge];
        if (v.s < e.length - 0.6) continue;
        if (v.ri >= v.route.length - 1) {
          v.node = e.to;
          v.edge = -1;
          v.speed = 0;
          v.stoodAt = null;
          this.arrive(v);
          continue;
        }
        const next = v.route[v.ri + 1];
        if (d.edges[next].closed && !v.known.has(next)) this.learn(v, [next, d.edges[next].twin], `reached ${d.edges[next].name}: closed`);
        asks.push({ v, node: e.to, next, since: v.stoodAt ?? this.time });
        // A long wait goes in the log once per junction, with what it is waiting behind.
        if (v.stoodAt !== null && this.time - v.stoodAt > 8 && v.waitLogged !== e.to) this.logWait(v, e);
      } else if (v.departing && v.route.length) {
        asks.push({ v, node: v.node, next: v.route[0], since: v.departedAt });
      }
    }
    // Right of way: emergency vehicles first when the player orders it, or when they come in on an
    // emergency lane (the lane carries its own signal priority).
    const first = (v: Vehicle) => (v.emergency && (s.priorities.ambulancesFirst || (v.edge >= 0 && d.edges[v.edge].emergencyLane))) || this.escortedBy(v, ['ahead']);
    asks.sort((a, b) => {
      const pa = first(a.v) ? 0 : 1, pb = first(b.v) ? 0 : 1;
      return pa - pb || a.since - b.since || a.v.id - b.v.id;
    });
    for (const ask of asks) {
      if (this.nodeBusy[ask.node] > this.time) continue;
      const v = ask.v, e = d.edges[ask.next];
      if (e.closed || (e.emergencyOnly && !v.emergency)) continue;
      const lane = this.entryLane(v, ask.next);
      if (lane < 0) continue;
      // What it carries past the junction, never past the rear of whoever entered before it.
      const carry = v.edge >= 0 ? Math.max(0, Math.min(v.s - d.edges[v.edge].length, this.entryRoom(ask.next, lane) - 2)) : 0;
      if (v.edge >= 0) v.ri++;
      else { v.ri = 0; v.departing = false; v.speed = Math.min(v.speed, 3); }
      v.edge = ask.next;
      v.enteredAt = this.time;
      v.s = carry;
      v.lane = lane;
      // Driving into fighting: held up unless escorted from ahead or the flank (judged where it now is).
      const end = d.nodes[e.to];
      const zone = this.zones.find((zn) => this.time < zn.until && Math.hypot(zn.x - end.x, zn.z - end.z) < zn.r);
      if (zone && !v.emergency && this.rand() < 0.5) {
        if (this.escortedBy(v, ['ahead', 'flank'])) this.note(v, 'wait', `escort covered it through the fighting at ${zone.name}`);
        else {
          v.holdUntil = this.time + 12 + this.rand() * 10;
          this.metricsData.heldUp++;
          if (this.squad.target === v.id) this.metricsData.escort.heldUp++;
          this.note(v, 'wait', `held up by fighting at ${zone.name}`);
        }
      }
      v.decidedOn = -1;
      this.nodeBusy[ask.node] = this.time + (v.kind === 'truck' || v.kind === 'convoy' ? SCENARIO.junctionHeavy : SCENARIO.junction);
      // The new lane's list is rebuilt next step; keep this step's view honest.
      this.lanes[ask.next][lane].push(v);
    }
    this.stepSquad(dt);
    this.stepDrone(dt);
    // The clinic's stock.
    this.stock.level -= SCENARIO.stockUse * dt;
    if (this.stock.level <= 0) { this.stock.shortage += dt; this.stock.everShort = true; this.stock.level = Math.max(this.stock.level, -5); }
    else if (this.stock.everShort && this.stock.recoveredAt === null && this.stock.level > 10) this.stock.recoveredAt = this.time;
  }

  private logWait(v: Vehicle, e: RoadEdge): void {
    v.waitLogged = e.to;
    const ahead = (this.lanes[e.id][v.lane] ?? []).filter((o) => o.s > v.s);
    const kinds = new Map<VehicleKind, number>();
    for (const o of ahead) kinds.set(o.kind, (kinds.get(o.kind) ?? 0) + 1);
    let cause = 'traffic', top = 0;
    for (const [k, n] of kinds) if (n > top) { top = n; cause = k === 'evac' ? 'evacuation traffic' : k === 'truck' ? 'freight' : k === 'convoy' ? 'the convoy' : k === 'ambulance' ? 'an ambulance' : 'traffic'; }
    const next = v.route[v.ri + 1];
    const why = next !== undefined && this.district.edges[next].closed ? `${this.district.edges[next].name} closed` : `behind ${cause}`;
    this.note(v, 'wait', `waiting ${why} (queue ${ahead.length}) at ${this.district.nodes[e.to].name}`);
  }

  /** Run `seconds` (or to the end of the scenario). */
  run(seconds = this.settings.duration - this.time): void {
    const end = Math.min(this.settings.duration, this.time + seconds);
    while (this.time < end - 1e-9) this.step();
  }

  get finished(): boolean {
    return this.time >= this.settings.duration - 1e-9;
  }

  /** The vehicles on the roads, as the view draws them. */
  views(): VehicleView[] {
    const out: VehicleView[] = [];
    for (const v of this.vehicles) {
      if (v.edge < 0) continue;
      const p = this.posOf(v);
      out.push({ id: v.id, kind: v.kind, x: p.x, z: p.z, dx: p.dx, dz: p.dz, emergency: v.emergency, detail: v.detail, stopped: v.speed < 0.5 });
    }
    return out;
  }

  /** Why is this vehicle where it is? From its recorded events only. */
  explain(id: number): string {
    const v = this.vehicles[id];
    return v ? explain(v.log) : '';
  }

  metrics(): ScenarioMetrics {
    const m = this.metricsData;
    m.meanDelay = this.delays.length ? this.delays.reduce((a, b) => a + b, 0) / this.delays.length : 0;
    m.shortage = this.stock.shortage;
    m.stockEnd = this.stock.level;
    m.untreated = this.stock.untreated;
    m.recoveredAt = this.stock.recoveredAt;
    m.drone.state = this.drone.state;
    m.drone.decisions = { ...this.drone.decisions };
    return m;
  }

  /** Places by name, for the view. */
  place(id: PlaceId): { x: number; z: number } {
    const n = this.district.nodes[this.district.places[id]];
    return { x: n.x, z: n.z };
  }
}

/** Summary numbers of a run, for tables and checks. */
export function summary(m: ScenarioMetrics): { delivery: number; response: number; evacuated: number; convoy: number; delay: number; queue: number; collisions: number; shortage: number } {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  return {
    delivery: mean(m.deliveries.filter((d) => d.lateness !== null).map((d) => d.lateness!)),
    response: mean(m.responses.filter((r) => r.time !== null).map((r) => r.time!)),
    evacuated: m.evacuation.lastArrival ?? NaN,
    convoy: m.convoy.arrivedAt ?? NaN,
    delay: m.meanDelay,
    queue: m.maxQueue,
    collisions: m.collisions,
    shortage: m.shortage,
  };
}
