import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { CraftDef } from '../craft/types.ts';
import { style1982, circuitOf } from '../craft/style1982.ts';
import { FREELANCER, hostile as sidesHostile, sideLivery, type Side, type Team } from './teams.ts';
import { obstacleTop } from '../world/structures.ts';
import { terrainHeight } from './terrain.ts';
import { craftBounds, WeaponSystem, type WeaponHost, type WeaponImpact } from './weapons.ts';
import { PLANET, type LandingSite } from './layout.ts';
import { landingSites } from '../world/landingSites.ts';
import type { LockTarget } from './lock.ts';
import type { HackedFlyer } from './hacking.ts';

/**
 * AI air traffic: other programs flying around the player, so the world feels inhabited. Each
 * flyer is one of the built-in aircraft or, in single player, one of the player's own designs.
 * Civil aircraft fly real flights between the airfields and helipads near the player: an
 * aeroplane waits on the stand, taxis to the hold, lines up when the runway is free, rolls,
 * climbs out on the runway heading, cruises at a level set by its direction of flight, joins
 * the pattern (downwind, base, the extended centreline), comes down the 3° slope, flares,
 * rolls out, clears the runway and turns round for the next flight. It goes around when it is
 * not lined up or the runway is taken (by another aircraft, or by the player), and keeps its
 * height apart from other traffic. A rotorcraft lifts straight off its pad, flies across and
 * lets down onto another. Airships (and everything, where there is nowhere to land) wander:
 * to a point, round it a while, on to another. Everything climbs over what stands in its way. The flight model is
 * kinematic (a coordinated-turn point mass, banking into turns), so dozens cost almost nothing;
 * each carries a kinematic Rapier collider, so the player can collide with it and weapons can
 * hit it (it derezzes). Deterministic for a seed.
 *
 * Combat aircraft fight a war. Each belongs to a side (sim/teams.ts): one of the three teams,
 * or the freelancers, who fight everyone. They carry guns and missiles and several hit points,
 * and pick the nearest enemy within reach: an aircraft of a side they fight, the player's craft
 * (only while it is armed), another player, or a tower turret. Then they hunt it: lead pursuit
 * on the guns' line, a burst when the nose is on, a homing missile from further out, breaking
 * off before they would ram, a hard break turn when they are hit. Friendly aircraft (the
 * player's team) and hired mercenaries escort the player when there is nothing to fight and
 * go first for whatever is attacking it; a mercenary leaves when its contract runs out.
 */

/** Something an aircraft can fight: the player, another aircraft, a turret, another player. */
export interface Foe {
  side: Side;
  lock: LockTarget;
  kind: 'player' | 'flyer' | 'turret' | 'remote' | 'missile';
  /** May be fired on now (the player only while it is armed). */
  engage: boolean;
  /** A target on the ground (attacked in a diving pass). */
  ground: boolean;
  flyer?: AiFlyer;
}

/** The player's craft, and the other things to fight that the traffic doesn't own. */
export interface AirTarget {
  vel: THREE.Vector3;
  /** Not derezzed. */
  alive: boolean;
  /** Carries weapons (no one fires on an unarmed craft). */
  armed: boolean;
  /** The craft as a lock target: missiles fired at it home on it. */
  lock?: LockTarget;
  /** The player's team. */
  team?: Team;
  /** The player, turrets and other players, each with its side. */
  foes?: Foe[];
}

/** Why a combat aircraft is here: the player's team, an enemy team, a freelancer, a hired gun. */
export type FlyerRole = 'civil' | 'friend' | 'enemy' | 'free' | 'merc' | 'strike' | 'hacked';

/** An attack order: go to a point and fight what's there, until `until` or it's been quiet a while. */
export interface AirOrder {
  x: number;
  z: number;
  until: number;
  /** When it last saw nothing to fight there (s), or null while fighting. */
  quietSince: number | null;
}

/** A bomber's run: fly to the target and drop on it when `release` says so. */
export interface StrikeRun {
  x: number;
  z: number;
  dropped: boolean;
  /** Called each step on the run; drops the bomb and returns true when it's time. */
  release: (f: AiFlyer) => boolean;
}

export type CombatState = 'patrol' | 'attack' | 'extend' | 'evade';

/** Combat aircraft notice a target inside this range (m) and give up beyond the second. */
const DETECT = 4000, LOSE = 6500;
/** A mercenary contract (s), and how many can be hired at once. */
export const MERC_CONTRACT = 300, MAX_MERCS = 3;
const GUN_RANGE = 750, GUN_SPEED = 620;
/** Hit points of a hostile aircraft (a peaceful flyer has 1: any hit derezzes it). */
const HOSTILE_HP = 6;

export type FlyerKind = 'airplane' | 'rotorcraft' | 'lighter-than-air';

/** Where a civil flight is: wandering (no flight plan; also every combat aircraft), or a leg of one. */
export type FlightPhase = 'wander' | 'park' | 'taxi' | 'lineup' | 'takeoff' | 'climb' | 'cruise' | 'approach' | 'final' | 'rollout' | 'vacate' | 'lift' | 'descend';
/** Phases with the wheels (or skids) on the ground. */
export const GROUND_PHASES: ReadonlySet<FlightPhase> = new Set(['park', 'taxi', 'lineup', 'takeoff', 'rollout', 'vacate']);

export interface AiFlyer {
  id: number;
  def: CraftDef;
  name: string;
  kind: FlyerKind;
  color: string;
  pos: THREE.Vector3;
  /** Heading (rad, 0 = -Z, clockwise from above) and bank (rad, + right). */
  heading: number;
  bank: number;
  pitch: number;
  speed: number;
  cruise: number;
  altitude: number;
  /** The altitude it prefers between destinations (circling may need more). */
  cruiseAltitude: number;
  state: 'transit' | 'loiter';
  /** Civil flights: the leg it is on, where it is going (or standing) and where it left from. */
  phase: FlightPhase;
  site: LandingSite | null;
  from: LandingSite | null;
  /** The runway direction in use (+1: toward +x or +z), and whether it has turned in for the approach. */
  dir: 1 | -1;
  inbound: boolean;
  /** A timer or a mark for the leg (s, or m): leave the stand, climb to, clear the runway at. */
  until: number;
  /** Height of its datum when it stands on the ground (m), approach speed (m/s), take-off acceleration (m/s²). */
  gear: number;
  vApp: number;
  thrust: number;
  /** Landings made and approaches abandoned (stats, tests). */
  landings: number;
  goArounds: number;
  /** Approaches abandoned at this field in a row: after two it goes somewhere else. */
  missed: number;
  /** The highest thing in the circle it could turn through (m), and when that was last looked up (s). */
  safe: number;
  safeAt: number;
  dest: { x: number; z: number };
  loiterUntil: number;
  /** +1 circles clockwise, -1 anticlockwise. */
  loiterDir: number;
  radius: number;
  length: number;
  body: RAPIER.RigidBody;
  derezAt: number | null;
  /** A combat aircraft (armed, on a side); false for the peaceful traffic. */
  hostile: boolean;
  /** Its side (null: peaceful traffic, never a target) and why it is here. */
  side: Side | null;
  role: FlyerRole;
  /** Mercenaries: when the contract ends (s); then it leaves. */
  mercUntil: number;
  leaving: boolean;
  /** What it is fighting now, and when it last chose. */
  target: Foe | null;
  targetAt: number;
  /** It, as a lock target and as a foe to others. */
  handle: LockTarget;
  foe: Foe | null;
  /** An EMP has knocked its engines and lights out until then (s): it glides and holds fire. */
  disabledUntil: number;
  /** An attack order (friendlies and mercenaries), or null. */
  order: AirOrder | null;
  /** A bomber on a strike run, or null. */
  run: StrikeRun | null;
  /** Taken over by the player's hacking beam: what it was, and until when (see sim/hacking.ts). */
  hacked: HackedFlyer | null;
  hp: number;
  maxHp: number;
  /** Time it was last hit (its lights flicker; a hostile breaks away). */
  hitAt: number;
  combat: CombatState;
  combatUntil: number;
  /** Heading it holds while extending away from a pass (rad). */
  breakHeading: number;
  /** Its aim wanders (rad: heading, pitch), so its fire is a threat, not a certainty. */
  aimError: { h: number; p: number };
  missileAt: number;
  /** Velocity (m/s) and attitude, for its weapons. */
  vel: THREE.Vector3;
  rot: THREE.Quaternion;
  /** A hostile's own guns and missiles (null: unarmed). */
  weapons: WeaponSystem | null;
  host: WeaponHost | null;
}

/** What kind of flyer a design is, from its definition alone. */
export function flyerKind(def: CraftDef): FlyerKind | 'ground' {
  const mods = def.parts.flatMap((p) => p.modules ?? []);
  if (mods.some((m) => m.type === 'wheel' && (m.drive ?? 0) > 0)) return 'ground';
  const mass = def.parts.reduce((s, p) => s + p.mass, 0);
  const gas = mods.reduce((s, m) => s + (m.type === 'buoyancy' ? m.volume * 1.06 : 0), 0);
  if (gas > 0.7 * mass) return 'lighter-than-air';
  if (mods.some((m) => m.type === 'rotor')) return 'rotorcraft';
  return 'airplane';
}

/** A sensible cruise speed (m/s) and altitude band (m) for a design. */
function performance(def: CraftDef, kind: FlyerKind): { cruise: number; alt: [number, number]; vApp: number; thrust: number } {
  const p = cruisePerformance(def, kind);
  // Approach (and lift-off) speed and the take-off roll's acceleration: enough runway for all.
  return { ...p, vApp: Math.max(24, Math.min(72, 0.38 * p.cruise)), thrust: p.cruise > 100 ? 5.5 : 3 };
}

function cruisePerformance(def: CraftDef, kind: FlyerKind): { cruise: number; alt: [number, number] } {
  if (kind === 'lighter-than-air') return { cruise: 11, alt: [140, 320] };
  if (kind === 'rotorcraft') return { cruise: 34, alt: [70, 220] };
  const engines = def.parts.flatMap((p) => p.modules ?? []).filter((m) => m.type === 'engine');
  const fast = engines.some((e) => e.type === 'engine' && (e.kind === 'rocket' || e.kind === 'ramjet' || e.kind === 'scramjet' || e.kind === 'turbojet'));
  const jet = engines.some((e) => e.type === 'engine' && (e.kind === 'turbofan' || (e.kind === undefined && e.propMaxSpeed === undefined)));
  if (fast) return { cruise: 230, alt: [600, 1600] };
  if (jet) return { cruise: 150, alt: [400, 1100] };
  return { cruise: 58, alt: [220, 600] };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const G = 9.81;
const wrap = (d: number) => {
  const C = PLANET.circumference;
  return d - C * Math.round(d / C);
};

export class AiAirTraffic {
  private static readonly perf = performance;
  readonly flyers: AiFlyer[] = [];
  /** How many flyers to keep around the player (0 = off). */
  count = 0;
  /** Designs to fly (the built-in aircraft, plus the player's own in single player). */
  pool: CraftDef[] = [];
  /** Combat aircraft to keep around the player: on its team, on the other two teams (split
   *  between them), and freelancers. Mercenaries come only when hired. */
  friendlies = 0;
  enemies = 0;
  freelancers = 0;
  /** The player's team (friendlies and mercenaries fly for it). */
  playerTeam: Team = 0;
  /** Civil aircraft fly flights between fields and pads (off: they all wander, as airships do). */
  flights = true;
  /** Flyers derezzed so far (tests, stats). */
  derezzed = 0;
  /** Hostiles the player has shot down. */
  kills = 0;
  /** A hostile's round struck something (the simulation applies the damage). */
  onHostileImpact: ((hit: WeaponImpact, shooter: AiFlyer) => void) | null = null;
  /** Ground height for rounds that miss every collider. */
  groundAt: (x: number, z: number) => number = terrainHeight;
  private readonly random: () => number;
  /** The hostiles' own stream, so adding them never changes what the peaceful traffic does. */
  private readonly combatRandom: () => number;
  private nextId = 1;
  private readonly body: Map<number, AiFlyer> = new Map();
  private readonly _e = new THREE.Euler();

  constructor(private readonly world: RAPIER.World, seed = 1982) {
    this.random = rng(seed);
    this.combatRandom = rng((seed ^ 0x9e3779b9) >>> 0);
  }

  /** The flyer whose collider this is, if any. */
  byCollider(handle: number): AiFlyer | undefined {
    return this.body.get(handle);
  }

  clear(): void {
    for (const f of this.flyers) this.drop(f);
    this.flyers.length = 0;
  }

  /** Destroy a flyer (a weapon hit, a collision): it stops flying and its body goes. */
  derez(f: AiFlyer, time: number): void {
    if (f.derezAt !== null || !this.flyers.includes(f)) return;
    f.derezAt = time;
    this.derezzed++;
    // Its rounds in flight go with it, as a derezzed vehicle's trails do.
    if (f.weapons) f.weapons.projectiles.length = 0;
    this.drop(f);
  }

  /**
   * A round hits a flyer for `amount` hit points. True when that finishes it (the caller derezzes
   * it); a hostile that survives breaks away from the fire.
   */
  damage(f: AiFlyer, amount: number, time: number): boolean {
    if (f.derezAt !== null) return false;
    f.hp -= amount;
    f.hitAt = time;
    if (f.hp <= 0) return true;
    if (f.hostile && f.combat !== 'patrol') {
      f.combat = 'evade';
      f.combatUntil = time + 3;
      f.loiterDir = this.combatRandom() < 0.5 ? 1 : -1;
    }
    return false;
  }

  /** An EMP: engines and lights out until `until`, it glides and holds fire. */
  disable(f: AiFlyer, until: number): void {
    f.disabledUntil = Math.max(f.disabledUntil, until);
    f.target = null;
    if (f.weapons) f.weapons.trigger.primary = f.weapons.trigger.secondary = false;
  }

  /** Live aircraft that fight the player's side (enemy teams and freelancers). */
  hostileFlyers(): AiFlyer[] {
    return this.flyers.filter((f) => f.side !== null && f.derezAt === null && sidesHostile(f.side, this.playerTeam));
  }

  /** Live combat aircraft of every side. */
  combatFlyers(): AiFlyer[] {
    return this.flyers.filter((f) => f.side !== null && f.derezAt === null);
  }

  /** Live mercenaries (and the time left on each contract). */
  mercs(): AiFlyer[] {
    return this.flyers.filter((f) => f.role === 'merc' && f.derezAt === null && !f.leaving);
  }

  /**
   * The player changes team: the team aircraft about go (they re-form for the new sides) and the
   * mercenaries follow the player to the new team.
   */
  setPlayerTeam(team: Team): void {
    if (team === this.playerTeam) return;
    this.playerTeam = team;
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i];
      if (f.role === 'merc') {
        f.side = team;
        f.foe!.side = team;
        f.target = null;
      } else if (f.role === 'friend' || f.role === 'enemy') {
        this.drop(f);
        this.flyers.splice(i, 1);
      }
    }
  }

  /** Other live places besides the player (orders, strikes): aircraft near them aren't dropped. */
  focus: Array<{ x: number; z: number }> = [];

  /**
   * Send aircraft to attack round a point: the friendlies, the mercenaries, or both. They fight
   * what they find within 3 km of it and circle it while it's quiet; the order ends after
   * `seconds`, or 20 s with nothing left there. Returns how many went.
   */
  order(x: number, z: number, time: number, who: 'all' | 'friends' | 'mercs' = 'all', seconds = 180): number {
    let n = 0;
    for (const f of this.flyers) {
      if (f.derezAt !== null || f.leaving) continue;
      const ok = (f.role === 'merc' && who !== 'friends') || (f.role === 'friend' && who !== 'mercs');
      if (!ok) continue;
      f.order = { x, z, until: time + seconds, quietSince: null };
      f.target = null;
      n++;
    }
    return n;
  }

  /** Call every order off: they come back to escort the player. */
  recall(): number {
    let n = 0;
    for (const f of this.flyers) if (f.order) { f.order = null; f.target = null; n++; }
    return n;
  }

  /** Active order points (one per distinct point). */
  orders(): Array<{ x: number; z: number; flyers: number; until: number }> {
    const out: Array<{ x: number; z: number; flyers: number; until: number }> = [];
    for (const f of this.flyers) {
      if (!f.order || f.derezAt !== null) continue;
      const o = out.find((p) => p.x === f.order!.x && p.z === f.order!.z);
      if (o) { o.flyers++; o.until = Math.max(o.until, f.order.until); } else out.push({ x: f.order.x, z: f.order.z, flyers: 1, until: f.order.until });
    }
    return out;
  }

  /** The design a strike's bomber flies: the biggest aeroplane in the pool. */
  bomberDef(): CraftDef | null {
    const planes = this.pool.filter((d) => flyerKind(d) === 'airplane');
    if (!planes.length) return null;
    const size = (d: CraftDef) => { const b = craftBounds(d); return b.max.clone().sub(b.min).length(); };
    return planes.reduce((a, b) => (size(b) > size(a) ? b : a));
  }

  /**
   * A bomber for a strike: an aircraft of the player's team spawned at `from` (high up) that
   * flies straight for the target, drops when `run.release` says so, then turns for home.
   */
  spawnBomber(def: CraftDef, from: THREE.Vector3, time: number, run: StrikeRun): AiFlyer | null {
    const f = this.spawn(from, time, 'strike', def);
    if (!f) return null;
    f.pos.copy(from);
    f.altitude = f.cruiseAltitude = from.y;
    f.heading = Math.atan2(wrap(run.x - from.x), -wrap(run.z - from.z));
    f.rot.setFromEuler(this._e.set(0, -f.heading, 0, 'YXZ'));
    f.vel.set(Math.sin(f.heading) * f.speed, 0, -Math.cos(f.heading) * f.speed);
    f.body.setNextKinematicTranslation({ x: from.x, y: from.y, z: from.z });
    f.body.setTranslation({ x: from.x, y: from.y, z: from.z }, true);
    f.run = run;
    // A heavy bomber: fast at height, and armoured (three times a fighter's hit points).
    f.cruise = f.speed = Math.max(f.cruise, 220);
    f.vel.set(Math.sin(f.heading) * f.speed, 0, -Math.cos(f.heading) * f.speed);
    f.hp = f.maxHp = HOSTILE_HP * 3;
    return f;
  }

  /** Hire a mercenary: it flies in from about 2 km out. False if three are already hired. */
  hireMerc(def: CraftDef, player: THREE.Vector3, time: number): AiFlyer | null {
    if (this.mercs().length >= MAX_MERCS || flyerKind(def) === 'ground') return null;
    return this.spawn(player, time, 'merc', def);
  }

  /** Every hostile's weapon system (rounds in flight, for the renderer). */
  weaponSystems(): WeaponSystem[] {
    const out: WeaponSystem[] = [];
    for (const f of this.flyers) if (f.weapons && f.derezAt === null) out.push(f.weapons);
    return out;
  }

  /** Hostile missiles in flight still homing on `target` (the MISSILE warning). */
  incoming(target: LockTarget): number {
    let n = 0;
    for (const f of this.flyers) if (f.weapons) for (const p of f.weapons.projectiles) if (p.target === target) n++;
    return n;
  }

  /** Fly the hostiles' rounds and fire what their triggers hold (after the physics step). */
  stepWeapons(dt: number, time: number): void {
    for (const f of this.flyers) if (f.weapons && f.host && f.derezAt === null) f.weapons.step(f.host, dt, time);
  }

  private drop(f: AiFlyer): void {
    // Already gone (dropped far away, then hit by something that still held it): nothing to do.
    if (this.world.getRigidBody(f.body.handle) !== f.body) return;
    for (let i = 0; i < f.body.numColliders(); i++) this.body.delete(f.body.collider(i).handle);
    this.world.removeRigidBody(f.body);
  }

  /** A destination 1.5-6 km from the player, in a random direction. */
  private pickDest(player: THREE.Vector3, random = this.random): { x: number; z: number } {
    const a = random() * Math.PI * 2, d = 1500 + random() * 4500;
    return { x: player.x + Math.sin(a) * d, z: player.z - Math.cos(a) * d };
  }

  /** The other team with fewer aircraft here (enemies are split between the two). */
  private enemyTeam(): Team {
    const others = ([0, 1, 2] as Team[]).filter((t) => t !== this.playerTeam);
    const n = (t: Team) => this.flyers.filter((f) => f.role === 'enemy' && f.derezAt === null && f.side === t).length;
    return n(others[0]) <= n(others[1]) ? others[0] : others[1];
  }

  private spawn(player: THREE.Vector3, time: number, role: FlyerRole = 'civil', chosen?: CraftDef): AiFlyer | null {
    const hostile = role !== 'civil';
    const random = hostile ? this.combatRandom : this.random;
    let flyable = this.pool.filter((d) => flyerKind(d) !== 'ground');
    if (chosen) flyable = [chosen];
    else if (hostile) {
      // Fighters are the fast aeroplanes (jets), else any aeroplane, else rotorcraft; never a blimp.
      const planes = flyable.filter((d) => flyerKind(d) === 'airplane');
      const jets = planes.filter((d) => performance(d, 'airplane').cruise >= 100);
      flyable = jets.length ? jets : planes.length ? planes : flyable.filter((d) => flyerKind(d) === 'rotorcraft');
    }
    if (!flyable.length) return null;
    const raw = flyable[Math.floor(random() * flyable.length)];
    const side: Side | null = role === 'civil' ? null : role === 'friend' || role === 'merc' || role === 'strike' ? this.playerTeam : role === 'free' ? FREELANCER : this.enemyTeam();
    const def = side === null ? style1982(raw) : sideLivery(raw, side, role === 'merc');
    const kind = flyerKind(def) as FlyerKind;
    const perf = performance(def, kind);
    const b = craftBounds(def);
    const length = Math.max(b.max.z - b.min.z, b.max.x - b.min.x);
    const radius = Math.max(1.5, b.max.clone().sub(b.min).length() / 2);
    // Appear 2.5-5 km out (out of easy sight), already cruising; friendlies 1.2-2 km, near enough to join.
    const near = role === 'friend' || role === 'merc';
    const a = random() * Math.PI * 2, d = near ? 1200 + random() * 800 : (hostile ? 3200 : 2500) + random() * (hostile ? 1800 : 2500);
    const x = player.x + Math.sin(a) * d, z = player.z - Math.cos(a) * d;
    const altitude0 = perf.alt[0] + random() * (perf.alt[1] - perf.alt[0]);
    // Never appear inside or just above a structure.
    const altitude = Math.max(altitude0, terrainHeight(x, z) + 60, obstacleTop(x, z) + 80);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, altitude, z));
    // One box collider around the airframe (good enough to fly into or shoot).
    const half = b.max.clone().sub(b.min).multiplyScalar(0.5);
    const centre = b.max.clone().add(b.min).multiplyScalar(0.5);
    const col = this.world.createCollider(RAPIER.ColliderDesc.cuboid(Math.max(0.3, half.x), Math.max(0.3, half.y), Math.max(0.3, half.z)).setTranslation(centre.x, centre.y, centre.z).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(1000), body);
    const f: AiFlyer = {
      id: this.nextId++, def, name: def.name, kind, color: circuitOf(def),
      pos: new THREE.Vector3(x, altitude, z), heading: random() * Math.PI * 2, bank: 0, pitch: 0,
      speed: perf.cruise, cruise: perf.cruise * (0.85 + random() * 0.3), altitude, cruiseAltitude: altitude,
      phase: 'wander', site: null, from: null, dir: 1, inbound: false, until: 0, gear: Math.max(0.3, -b.min.y), vApp: perf.vApp, thrust: perf.thrust, landings: 0, goArounds: 0, missed: 0, safe: 0, safeAt: -Infinity,
      state: 'transit', dest: this.pickDest(player, random), loiterUntil: 0, loiterDir: random() < 0.5 ? 1 : -1,
      radius, length, body, derezAt: null,
      hostile, hp: hostile ? HOSTILE_HP : 1, maxHp: hostile ? HOSTILE_HP : 1, hitAt: -Infinity,
      combat: 'patrol', combatUntil: 0, breakHeading: 0, aimError: { h: 0, p: 0 }, missileAt: time + 4,
      vel: new THREE.Vector3(), rot: new THREE.Quaternion(), weapons: null, host: null,
      side, role, mercUntil: role === 'merc' ? time + MERC_CONTRACT : Infinity, leaving: false, target: null, targetAt: -Infinity,
      handle: null as unknown as LockTarget, foe: null, disabledUntil: -Infinity, order: null, run: null, hacked: null,
    };
    const air = this;
    f.handle = {
      id: `air:${f.id}`, kind: hostile ? 'hostile' : 'aircraft', name: f.name, radius,
      alive: () => f.derezAt === null && air.flyers.includes(f),
      position: (o) => o.copy(f.pos),
      velocity: (o) => o.copy(f.vel),
    };
    if (side !== null) f.foe = { side, lock: f.handle, kind: 'flyer', engage: true, ground: false, flyer: f };
    f.rot.setFromEuler(this._e.set(0, -f.heading, 0, 'YXZ'));
    f.vel.set(Math.sin(f.heading) * f.speed, 0, -Math.cos(f.heading) * f.speed);
    if (hostile) {
      // Guns either side of the nose and missiles under the wings, where its geometry puts them.
      const w = new WeaponSystem();
      w.arm(def, kind === 'airplane' ? 'missiles' : 'guns');
      w.turnScale = 25 / 45; // their missiles turn slower than the player's: a hard turn can shake one
      w.onImpact = (h) => this.onHostileImpact?.(h, f);
      f.weapons = w;
      const self = this;
      f.host = { world: this.world, body, position: f.pos, rotation: f.rot, linvel: f.vel, color: f.color, groundAt: (gx, gz) => self.groundAt(gx, gz) };
    }
    this.body.set(col.handle, f);
    this.flyers.push(f);
    if (role === 'civil' && this.flights) {
      // On a stand somewhere near (out of the player's way), or already on its way in.
      const home = random() < 0.45 ? this.pickSite(f, player, null) : null;
      if (home && Math.hypot(wrap(home.x - player.x), wrap(home.z - player.z)) > 500 && this.flyers.filter((o) => o.site === home || o.from === home).length < 3) this.stand(f, home, time, 4 + random() * 45);
      else if (this.assign(f, player, null)) {
        f.phase = 'cruise';
        f.altitude = f.cruiseAltitude = Math.max(f.cruiseAltitude, altitude);
        f.heading = Math.atan2(wrap(f.site!.x - f.pos.x), -wrap(f.site!.z - f.pos.z));
        f.rot.setFromEuler(this._e.set(0, -f.heading, 0, 'YXZ'));
      }
    }
    return f;
  }

  step(dt: number, time: number, player: THREE.Vector3, target?: AirTarget): void {
    // Drop the derezzed (after a moment) and the far away; keep the count topped up.
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i];
      // Distance to the nearest live place (the player, an order, a strike). Aircraft on an order
      // or a run stay whatever the distance; one with rounds still flying stays till they land.
      let dist = Math.hypot(wrap(f.pos.x - player.x), wrap(f.pos.z - player.z));
      for (const p of this.focus) dist = Math.min(dist, Math.hypot(wrap(f.pos.x - p.x), wrap(f.pos.z - p.z)));
      const busy = !!f.order || (!!f.run && !f.leaving) || (f.weapons?.projectiles.length ?? 0) > 0;
      const far = !busy && (dist > 12000 || (f.leaving && dist > 5000));
      if ((f.derezAt !== null && time - f.derezAt > 2) || far) {
        if (f.derezAt === null) this.drop(f);
        this.flyers.splice(i, 1);
      }
    }
    const wantedOf: Record<Exclude<FlyerRole, 'merc' | 'strike' | 'hacked'>, number> = { civil: this.count, friend: this.friendlies, enemy: this.enemies, free: this.freelancers };
    for (const role of ['civil', 'friend', 'enemy', 'free'] as const) {
      const wanted = wantedOf[role];
      let alive = this.flyers.filter((f) => f.derezAt === null && f.role === role).length;
      while (alive < wanted && this.pool.length) { this.spawn(player, time, role); alive++; if (alive > 64) break; }
      while (alive > wanted) {
        const f = this.flyers.find((x) => x.derezAt === null && x.role === role)!;
        this.drop(f);
        this.flyers.splice(this.flyers.indexOf(f), 1);
        alive--;
      }
    }
    for (const f of this.flyers) {
      if (f.derezAt !== null) continue;
      this.follow(f, player);
      this.fly(f, dt, time, player, target);
    }
  }

  /**
   * The planet wraps, and the player's craft is carried across the seam: a flyer comes with it
   * (and its rounds in flight), so the two stay in the same stretch of sky.
   */
  private follow(f: AiFlyer, player: THREE.Vector3): void {
    const C = PLANET.circumference;
    const sx = -C * Math.round((f.pos.x - player.x) / C), sz = -C * Math.round((f.pos.z - player.z) / C);
    if (!sx && !sz) return;
    f.pos.x += sx;
    f.pos.z += sz;
    f.dest.x += sx;
    f.dest.z += sz;
    f.body.setTranslation({ x: f.pos.x, y: f.pos.y, z: f.pos.z }, true);
    if (f.weapons) for (const p of f.weapons.projectiles) {
      p.pos.x += sx;
      p.pos.z += sz;
    }
  }

  private readonly _tp = new THREE.Vector3();
  private readonly _tp2 = new THREE.Vector3();
  private readonly _tv = new THREE.Vector3();

  /** Horizontal distance (m) between two points, the short way round. */
  private static gap(a: THREE.Vector3, b: THREE.Vector3): number {
    return Math.hypot(wrap(a.x - b.x), wrap(a.z - b.z));
  }

  /** Is this foe still worth fighting? */
  private valid(foe: Foe, from: THREE.Vector3, reach: number): boolean {
    if (!foe.lock.alive() || !foe.engage) return false;
    return AiAirTraffic.gap(foe.lock.position(this._tp), from) < reach;
  }

  /**
   * Choose what to fight, about once a second. Friendlies and mercenaries go first for anything
   * attacking the player, then anything near the player; everyone else for the nearest enemy
   * in the air, then on the ground (turrets). Null: nothing within reach.
   */
  private choose(f: AiFlyer, time: number, player: THREE.Vector3, target: AirTarget | undefined): Foe | null {
    if (f.side === null || f.leaving || f.run) return null;
    const ordered = f.order;
    const guard = !ordered && (f.role === 'friend' || f.role === 'merc' || f.role === 'hacked');
    const here = ordered ? this._tp2.set(ordered.x, 0, ordered.z) : guard ? player : f.pos;
    if (f.target && time - f.targetAt < 1 && this.valid(f.target, here, ordered ? 3500 : LOSE)) return f.target;
    f.targetAt = time;
    const foes: Foe[] = [];
    for (const o of this.flyers) if (o !== f && o.foe && o.derezAt === null && !o.leaving && sidesHostile(f.side, o.side!)) foes.push(o.foe);
    for (const o of target?.foes ?? []) if (o.engage && sidesHostile(f.side, o.side) && o.lock.alive()) foes.push(o);
    const from = here;
    let best: Foe | null = null, score = Infinity;
    for (const o of foes) {
      if (o.kind === 'missile') continue; // aircraft don't chase missiles
      const d = AiAirTraffic.gap(o.lock.position(this._tp), from);
      const reach = ordered ? 3000 : f.target === o ? LOSE : DETECT;
      if (d > reach) continue;
      // Ground targets only when nothing is in the air; a guard puts the player's attackers first.
      let k = d + (o.ground ? 20000 : 0);
      if (guard && o.flyer?.target?.kind === 'player') k -= 10000;
      if (k < score) { best = o; score = k; }
    }
    f.target = best;
    return best;
  }

  /**
   * A combat aircraft's pilot: what it wants this step while it fights `foe` (null: nothing to
   * fight, it patrols like any other flyer). Sets its triggers.
   */
  private fight(f: AiFlyer, dt: number, time: number, foe: Foe | null): { want: number; vs: number; speed: number; steep?: boolean } | null {
    const w = f.weapons;
    if (!w) return null;
    w.trigger.primary = w.trigger.secondary = false;
    w.lock = null;
    const tp = foe ? foe.lock.position(this._tp) : this._tp;
    const tv = foe ? foe.lock.velocity(this._tv) : this._tv.set(0, 0, 0);
    const dx = wrap(tp.x - f.pos.x), dz = wrap(tp.z - f.pos.z), dy = tp.y - f.pos.y;
    const range = Math.hypot(dx, dy, dz);
    if (!foe) {
      if (f.combat !== 'patrol') {
        // Nothing to fight: back to the patrol.
        f.combat = 'patrol';
        f.state = 'transit';
        f.altitude = f.cruiseAltitude;
        f.dest = this.pickDest(f.pos, this.combatRandom);
      }
      return null;
    }
    const random = this.combatRandom;
    if (f.combat === 'patrol') f.combat = 'attack';
    if ((f.combat === 'extend' || f.combat === 'evade') && time > f.combatUntil) f.combat = 'attack';
    // The aim wanders (a slow random walk pulled back to zero): about half a degree.
    const pull = Math.min(1, dt / 2), kick = 0.008 * Math.sqrt(dt);
    f.aimError.h += -f.aimError.h * pull + (random() * 2 - 1) * kick;
    f.aimError.p += -f.aimError.p * pull + (random() * 2 - 1) * kick;
    // How fast the two are closing (m/s).
    const closure = -((tv.x - f.vel.x) * dx + (tv.y - f.vel.y) * dy + (tv.z - f.vel.z) * dz) / Math.max(1, range);
    if (f.combat === 'attack' && range < Math.max(250, closure * 1.6)) {
      // Too close to keep the guns on: break off to one side and up, then come round again.
      f.combat = 'extend';
      f.combatUntil = time + 6 + random() * 4;
      f.loiterDir = random() < 0.5 ? 1 : -1;
      f.breakHeading = f.heading + f.loiterDir * 0.7;
    }
    const fast = Math.min(f.cruise * 1.25, Math.max(f.cruise * 0.75, tv.length() + 30));
    if (f.combat === 'extend') return { want: f.breakHeading, vs: Math.max(0.12 * f.speed, (tp.y + 150 - f.pos.y) * 0.5), speed: f.cruise * 1.25 };
    if (f.combat === 'evade') return { want: f.heading + f.loiterDir * 1.4, vs: 0.15 * f.speed, speed: f.cruise * 1.25 };
    // Attack: fly the nose onto where the target will be when the rounds arrive (they close on
    // it at the gun's speed plus the closing speed, and drop on the way).
    const tof = range / Math.max(300, GUN_SPEED + closure);
    const ax = dx + tv.x * tof, az = dz + tv.z * tof, ay = dy + tv.y * tof + 0.5 * G * tof * tof;
    const want = Math.atan2(ax, -az) + f.aimError.h;
    const pitchWant = Math.atan2(ay, Math.hypot(ax, az)) + f.aimError.p;
    let dh = want - f.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    // On the line: the nose within a few metres of the aim point at that range.
    const tol = Math.max(0.004, 4 / range);
    const on = Math.abs(dh) < tol && Math.abs(pitchWant - f.pitch) < tol;
    if (on && range < GUN_RANGE) w.trigger.primary = true;
    // Missiles: from 400-1500 m at aircraft; at a ground target from up to 2.4 km (outside its
    // guns), with a looser line (the missile homes).
    const mTol = foe.ground ? 0.06 : 0.02, mMax = foe.ground ? 2400 : 1500;
    if (Math.abs(dh) < mTol && Math.abs(pitchWant - f.pitch) < mTol && range > 400 && range < mMax && time - f.missileAt > (foe.ground ? 4 : 6)) {
      w.trigger.secondary = true;
      w.lock = foe.lock;
      f.missileAt = time;
    }
    // A ground target is attacked in a steeper dive (up to 43°), pulled out of above the floor.
    const dive = foe.ground ? 0.75 : 0.4;
    return { want, vs: f.speed * Math.tan(Math.max(-dive, Math.min(0.4, pitchWant))), speed: fast, steep: foe.ground };
  }

  private fly(f: AiFlyer, dt: number, time: number, player: THREE.Vector3, target?: AirTarget): void {
    if (time < f.disabledUntil && GROUND_PHASES.has(f.phase)) {
      // EMP on the ground: it stops where it is.
      f.speed = Math.max(0, f.speed - 6 * dt);
      f.pos.x += Math.sin(f.heading) * f.speed * dt;
      f.pos.z -= Math.cos(f.heading) * f.speed * dt;
      this.pose(f, 0);
      return;
    }
    if (time < f.disabledUntil) {
      // EMP: no engines, no guns; it glides on, losing speed and height (never into the ground).
      if (f.weapons) f.weapons.trigger.primary = f.weapons.trigger.secondary = false;
      f.target = null;
      const glide = Math.max(f.cruise * 0.6, f.speed - 4 * dt);
      this.combatFly(f, dt, { want: f.heading, vs: -Math.max(6, glide * 0.12), speed: glide });
      return;
    }
    if (f.role === 'merc' && time > f.mercUntil && !f.leaving) {
      // The contract is up: it peels away and leaves.
      f.leaving = true;
      f.target = null;
      f.breakHeading = Math.atan2(wrap(f.pos.x - player.x), -wrap(f.pos.z - player.z));
    }
    if (f.leaving) {
      if (f.weapons) f.weapons.trigger.primary = f.weapons.trigger.secondary = false;
      this.combatFly(f, dt, { want: f.breakHeading, vs: 0.08 * f.speed, speed: f.cruise * 1.2 });
      return;
    }
    if (f.run && !f.run.dropped) {
      // A bomber on its run: straight for the target at its height, dropping when it's time.
      if (f.weapons) f.weapons.trigger.primary = f.weapons.trigger.secondary = false;
      const r = f.run;
      if (r.release(f)) {
        r.dropped = true;
        f.leaving = true;
        f.target = null;
        f.breakHeading = f.heading + Math.PI * 0.75;
      }
      this.combatFly(f, dt, { want: Math.atan2(wrap(r.x - f.pos.x), -wrap(r.z - f.pos.z)), vs: (f.cruiseAltitude - f.pos.y) * 0.3, speed: f.cruise });
      return;
    }
    const chosen = f.hostile ? this.choose(f, time, player, target) : null;
    // An order ends when its time is up, or after 20 s with nothing left to fight there.
    const o = f.order;
    if (o) {
      if (chosen) o.quietSince = null;
      else o.quietSince ??= time;
      if (time > o.until || (o.quietSince !== null && time - o.quietSince > 20)) { f.order = null; f.target = null; }
    }
    const fight = f.hostile ? this.fight(f, dt, time, chosen) : null;
    if (fight) {
      this.combatFly(f, dt, fight);
      return;
    }
    if (f.order) {
      // On station: circle the order's point, well above what's there.
      const at = this._tp2.set(f.order.x, Math.max(terrainHeight(f.order.x, f.order.z), obstacleTop(f.order.x, f.order.z)) + 440, f.order.z);
      this.combatFly(f, dt, this.escort(f, time, at));
      return;
    }
    if (f.role === 'friend' || f.role === 'merc' || f.role === 'hacked') {
      this.combatFly(f, dt, this.escort(f, time, player, target?.vel));
      return;
    }
    if (f.role === 'civil' && f.phase !== 'wander') {
      this.civil(f, dt, time, player);
      return;
    }
    const random = f.hostile ? this.combatRandom : this.random;
    const dx = wrap(f.dest.x - f.pos.x), dz = wrap(f.dest.z - f.pos.z);
    const dist = Math.hypot(dx, dz);
    // Loiter radius: a gentle 25° banked circle at cruise (hovering craft circle tighter).
    const loiterR = f.kind === 'airplane' ? Math.max(300, (f.cruise * f.cruise) / (G * Math.tan(0.44))) : f.kind === 'rotorcraft' ? 180 : 250;
    let want: number;
    if (f.state === 'transit') {
      want = Math.atan2(dx, -dz);
      if (dist < loiterR * 1.1) {
        f.state = 'loiter';
        f.loiterUntil = time + 30 + random() * 60;
        // Circle above everything on the circle (a straight look-ahead misses a curving path).
        f.altitude = Math.max(f.altitude, this.circleFloor(f.dest.x, f.dest.z, loiterR * 1.3) + 80 + f.radius);
      }
    } else {
      // Fly tangent to the circle, corrected toward its radius.
      const toCentre = Math.atan2(dx, -dz);
      const err = (dist - loiterR) / loiterR;
      want = toCentre - f.loiterDir * (Math.PI / 2 - Math.max(-0.6, Math.min(0.6, err * 1.2)));
      if (time > f.loiterUntil) {
        f.state = 'transit';
        f.altitude = f.cruiseAltitude;
        f.dest = this.pickDest(player, random);
        f.loiterDir = random() < 0.5 ? 1 : -1;
      }
    }
    // Coordinated turn toward the wanted heading (bank-limited), speed toward cruise.
    let dh = want - f.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const maxBank = f.kind === 'lighter-than-air' ? 0.12 : f.kind === 'rotorcraft' ? 0.35 : 0.52;
    const maxRate = (G * Math.tan(maxBank)) / Math.max(5, f.speed);
    const rate = Math.max(-maxRate, Math.min(maxRate, dh * 0.8));
    f.heading += rate * dt;
    const bankWant = Math.atan((rate * f.speed) / G);
    f.bank += (bankWant - f.bank) * Math.min(1, dt * 1.5);
    f.speed += (f.cruise - f.speed) * Math.min(1, dt * 0.2);
    // Altitude: hold the cruise level, climbing over terrain and structures on the path ahead
    // (scanned 0-15 s out, so even a jet sees a tower in time to clear it).
    const floor = this.floorAhead(f) + 60 + f.radius;
    const level = Math.max(f.altitude, floor);
    const vs = Math.max(-8, Math.min(Math.max(12, 0.3 * f.speed), (level - f.pos.y) * 0.4));
    f.pitch += (Math.atan2(vs, f.speed) - f.pitch) * Math.min(1, dt * 2);
    f.pos.x += Math.sin(f.heading) * f.speed * dt;
    f.pos.z -= Math.cos(f.heading) * f.speed * dt;
    f.pos.y += vs * dt;
    this.pose(f, vs);
  }

  // --- Civil flights: from one field or pad to another, the way aircraft do it.

  /** Wind over the ground at (x, z) (m/s), if the host has weather: runways are used into it. */
  wind: ((x: number, z: number) => { x: number; z: number }) | null = null;
  /** Rooftop pads that are gone (their structure is fractured), by group. */
  fractured: { has(group: number): boolean } | null = null;
  private readonly runwayDirs = new Map<string, 1 | -1>();

  /** Which way a runway is in use: into the wind; kept while anyone is using it. */
  private runwayDir(s: LandingSite): 1 | -1 {
    const used = this.flyers.some((f) => f.site === s && f.derezAt === null && f.phase !== 'cruise' && f.phase !== 'wander');
    let dir = this.runwayDirs.get(s.id);
    if (dir === undefined || !used) {
      const w = this.wind?.(s.x, s.z);
      const along = w ? (s.axis === 'x' ? w.x : w.z) : 0;
      dir = Math.abs(along) > 1 ? (along > 0 ? -1 : 1) : dir ?? 1;
      this.runwayDirs.set(s.id, dir);
    }
    return dir;
  }

  /**
   * A runway seen from a flyer: `a` metres along from the landing threshold (negative: still
   * on the approach), `c` metres across to the right, and the runway's heading and axes.
   */
  private frame(f: AiFlyer, s: LandingSite, dir: number): { a: number; c: number; hdg: number; ux: number; uz: number; rx: number; rz: number } {
    const ux = s.axis === 'x' ? dir : 0, uz = s.axis === 'z' ? dir : 0;
    const hdg = Math.atan2(ux, -uz);
    const rx = Math.cos(hdg), rz = Math.sin(hdg);
    const dx = wrap(f.pos.x - s.x), dz = wrap(f.pos.z - s.z);
    return { a: dx * ux + dz * uz + s.length / 2, c: dx * rx + dz * rz, hdg, ux, uz, rx, rz };
  }

  /** Bearing and distance from the flyer to the point (a, c) of a runway frame. */
  private static aim(fr: { a: number; c: number; ux: number; uz: number; rx: number; rz: number }, a: number, c: number): { want: number; dist: number } {
    const da = a - fr.a, dc = c - fr.c;
    const wx = fr.ux * da + fr.rx * dc, wz = fr.uz * da + fr.rz * dc;
    return { want: Math.atan2(wx, -wz), dist: Math.hypot(wx, wz) };
  }

  private readonly sectorTops = new Map<string, number>();

  /**
   * A field's minimum sector altitude: clear of everything within a few kilometres of the
   * runway, outside the approach and departure funnels (which the zoning keeps low). The
   * pattern is flown no lower; inside a funnel an aircraft may come down to the slope.
   */
  private sectorAltitude(s: LandingSite, f: AiFlyer): number {
    let top = this.sectorTops.get(s.id);
    if (top === undefined) {
      top = 0;
      const half = s.length / 2;
      for (let a = -half - 6500; a <= half + 6500; a += 60) for (let c = -3600; c <= 3600; c += 60) {
        const past = Math.abs(a) - half;
        if (Math.abs(c) < 110 + 0.15 * Math.max(0, past) && past < 3900) continue;
        const x = s.x + (s.axis === 'x' ? a : c), z = s.z + (s.axis === 'x' ? c : a);
        top = Math.max(top, terrainHeight(x, z), obstacleTop(x, z));
      }
      this.sectorTops.set(s.id, top);
    }
    return top + 50 + f.radius;
  }

  /** The taxi track beside a runway: this far across (Grid International's is its taxiway). */
  private static track(s: LandingSite, dir: number): number {
    return dir * (s.id === 'grid' ? 130 : s.width / 2 + 30);
  }

  /** Is the runway taken: someone lining up, rolling, or just down; or the player's craft on it? */
  private runwayBusy(s: LandingSite, me: AiFlyer, player: THREE.Vector3): boolean {
    for (const o of this.flyers) {
      if (o === me || o.site !== s || o.derezAt !== null) continue;
      if (o.phase === 'lineup' || o.phase === 'takeoff' || o.phase === 'rollout') return true;
      if (o.phase === 'vacate' && Math.abs(this.frame(o, s, o.dir).c) < s.width / 2 + 10) return true;
    }
    const dx = wrap(player.x - s.x), dz = wrap(player.z - s.z);
    const along = s.axis === 'x' ? dx : dz, across = s.axis === 'x' ? dz : dx;
    return Math.abs(across) < s.width / 2 + 8 && Math.abs(along) < s.length / 2 + 30 && player.y < s.y + 15;
  }

  /** Somewhere to go: a field (aeroplanes) or a pad (rotorcraft) near the player, not the one it is at. */
  private pickSite(f: AiFlyer, player: THREE.Vector3, from: LandingSite | null): LandingSite | null {
    const heli = f.kind === 'rotorcraft';
    const options = landingSites().filter((s) => {
      if (s === from || (heli ? false : s.kind !== 'runway')) return false;
      if (s.group !== undefined && this.fractured?.has(s.group)) return false;
      if (Math.hypot(wrap(s.x - player.x), wrap(s.z - player.z)) > 10000) return false;
      if (from && Math.hypot(wrap(s.x - from.x), wrap(s.z - from.z)) < (heli ? 400 : 1500)) return false;
      // A pad takes one aircraft; a field's stand a few.
      const there = this.flyers.filter((o) => o !== f && o.site === s && o.derezAt === null && (heli ? o.kind === 'rotorcraft' : true)).length;
      return there < (heli ? 1 : 4);
    });
    return options.length ? options[Math.floor(this.random() * options.length)] : null;
  }

  /** Where a rotorcraft sets down at a site: the pad, or a spot beside a runway's middle (away from the taxi track). */
  private static padOf(s: LandingSite): { x: number; z: number; y: number } {
    if (s.kind === 'helipad') return { x: s.x, z: s.z, y: s.y };
    const off = -(s.id === 'grid' ? 60 : s.width / 2 + 40);
    return s.axis === 'x' ? { x: s.x, z: s.z + off, y: s.y } : { x: s.x - off, z: s.z, y: s.y };
  }

  /** Give a civil flyer its next flight (or leave it wandering where there is nowhere to go). */
  private assign(f: AiFlyer, player: THREE.Vector3, from: LandingSite | null): boolean {
    if (f.kind === 'lighter-than-air') return false;
    const s = this.pickSite(f, player, from);
    if (!s) return false;
    f.site = s;
    f.inbound = false;
    // Cruise level: by direction of flight (eastbound on the odd hundreds, westbound on the
    // even), lower on a short hop.
    const dist = Math.hypot(wrap(s.x - f.pos.x), wrap(s.z - f.pos.z));
    const band = AiAirTraffic.perf(f.def, f.kind).alt;
    const level = band[0] + this.random() * (band[1] - band[0]);
    const east = wrap(s.x - f.pos.x) > 0;
    f.cruiseAltitude = Math.min(Math.round(level / 200) * 200 + (east ? 100 : 0), s.y + 150 + 0.06 * dist);
    return true;
  }

  /** Stand a civil flyer on a field's taxi track (or a pad), ready to leave after `wait` seconds. */
  private stand(f: AiFlyer, s: LandingSite, time: number, wait: number): void {
    f.from = s;
    f.site = s;
    f.phase = 'park';
    f.until = time + wait;
    f.speed = 0;
    f.bank = f.pitch = 0;
    if (f.kind === 'rotorcraft') {
      const p = AiAirTraffic.padOf(s);
      f.pos.set(f.pos.x + wrap(p.x - f.pos.x), p.y + f.gear, f.pos.z + wrap(p.z - f.pos.z));
    } else {
      f.dir = this.runwayDir(s);
      const queue = this.flyers.filter((o) => o !== f && o.site === s && o.derezAt === null && (o.phase === 'park' || o.phase === 'taxi')).length;
      const fr = this.frame(f, s, f.dir);
      const a = 20 + 50 * queue, c = AiAirTraffic.track(s, f.dir);
      f.pos.x += fr.ux * (a - fr.a) + fr.rx * (c - fr.c);
      f.pos.z += fr.uz * (a - fr.a) + fr.rz * (c - fr.c);
      f.pos.y = s.y + f.gear;
      f.heading = fr.hdg;
    }
    f.altitude = f.pos.y;
    f.body.setTranslation({ x: f.pos.x, y: f.pos.y, z: f.pos.z }, true);
    this.pose(f, 0);
  }

  /** Roll on the ground toward a point at up to `speed`; true once there. */
  private taxi(f: AiFlyer, dt: number, want: number, dist: number, speed: number, ground: number): boolean {
    let dh = want - f.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    f.heading += Math.max(-0.9, Math.min(0.9, dh * 3)) * dt;
    const target = dist < 2 ? 0 : Math.abs(dh) > 0.5 ? 3 : Math.min(speed, 2 + dist * 0.4);
    f.speed += Math.max(-4 * dt, Math.min(2 * dt, target - f.speed));
    f.pos.x += Math.sin(f.heading) * f.speed * dt;
    f.pos.z -= Math.cos(f.heading) * f.speed * dt;
    f.pos.y = ground;
    f.bank = f.pitch = 0;
    this.pose(f, 0);
    return dist < 2;
  }

  /**
   * Fly a civil aircraft: a coordinated turn toward `want`, speed eased toward `speed`, and
   * either a level to hold (clear of whatever is ahead, unless `clear` says the path is
   * known to be) or a vertical speed.
   */
  private cruise(f: AiFlyer, dt: number, time: number, c: { want: number; speed: number; level?: number; vs?: number; clear?: boolean; bank?: number; avoid?: THREE.Vector3 }): void {
    let dh = c.want - f.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const maxBank = c.bank ?? (f.kind === 'rotorcraft' ? 0.4 : 0.52);
    const maxRate = (G * Math.tan(maxBank)) / Math.max(5, f.speed);
    const rate = Math.max(-maxRate, Math.min(maxRate, dh * 1.2));
    f.heading += rate * dt;
    f.bank += (Math.atan((rate * f.speed) / G) - f.bank) * Math.min(1, dt * 1.5);
    f.speed += Math.max(-3.5 * dt, Math.min(2.5 * dt, c.speed - f.speed));
    let vs = c.vs ?? 0;
    if (c.level !== undefined) {
      let level = c.level;
      // Traffic at the same height close by: the higher one climbs a little, the lower descends.
      if (c.avoid) level += this.separation(f, c.avoid);
      if (!c.clear) {
        // Clear of what is ahead, and of everything it could turn into (looked up twice a second).
        if (time - f.safeAt > 0.5) {
          f.safeAt = time;
          f.safe = this.circleFloor(f.pos.x, f.pos.z, Math.max(300, Math.min(900, f.speed * 7)));
        }
        level = Math.max(level, Math.max(this.floorAhead(f), f.safe) + 45 + f.radius);
      }
      vs = Math.max(-Math.max(8, 0.1 * f.speed), Math.min(Math.max(10, 0.25 * f.speed), (level - f.pos.y) * 0.4));
    }
    // An aeroplane points along its path; a rotorcraft climbs and descends nearly level.
    const nose = f.kind === 'rotorcraft' ? Math.max(-0.15, Math.min(0.15, Math.atan2(vs, 40))) : Math.atan2(vs, Math.max(20, f.speed));
    f.pitch += (nose - f.pitch) * Math.min(1, dt * 2);
    f.pos.x += Math.sin(f.heading) * f.speed * dt;
    f.pos.z -= Math.cos(f.heading) * f.speed * dt;
    f.pos.y += vs * dt;
    f.altitude = f.pos.y;
    this.pose(f, vs);
  }

  /** Vertical separation (m, + climb) from other civil traffic and the player's craft nearby. */
  private separation(f: AiFlyer, player: THREE.Vector3): number {
    let shift = 0;
    const check = (p: THREE.Vector3, higher: boolean) => {
      if (Math.abs(p.y - f.pos.y) > 90 || Math.hypot(wrap(p.x - f.pos.x), wrap(p.z - f.pos.z)) > 700) return;
      shift += higher ? 90 : -90;
    };
    check(player, f.pos.y >= player.y);
    for (const o of this.flyers) {
      if (o === f || o.derezAt !== null || o.role !== 'civil' || o.speed < 1) continue;
      check(o.pos, f.pos.y > o.pos.y || (f.pos.y === o.pos.y && f.id > o.id));
    }
    return Math.max(-90, Math.min(90, shift));
  }

  /** One step of a civil flight. */
  private civil(f: AiFlyer, dt: number, time: number, player: THREE.Vector3): void {
    const s = f.site!;
    if (f.kind === 'rotorcraft') return this.civilRotor(f, dt, time, player, s);
    const fr = this.frame(f, s, f.dir);
    const ground = s.y + f.gear;
    const track = AiAirTraffic.track(s, f.dir);
    switch (f.phase) {
      case 'park': {
        // On the stand, facing down the runway. Then a new flight, and out when the runway is free.
        this.taxi(f, dt, fr.hdg, 0, 0, ground);
        if (time < f.until) return;
        if (f.from === s && !this.assign(f, player, s)) { f.until = time + 30; return; }
        // (f.site is now where it is going; it leaves from f.from.)
        return void (f.phase = 'taxi');
      }
      default: break;
    }
    // On the ground at the field it is leaving: frames are of that field.
    if (f.phase === 'taxi' || f.phase === 'lineup' || f.phase === 'takeoff') {
      const home = f.from!;
      const hf = this.frame(f, home, f.dir);
      const g = home.y + f.gear;
      const t = AiAirTraffic.track(home, f.dir);
      if (f.phase === 'taxi') {
        // Up the track to the hold short of the threshold, behind whoever is ahead.
        const ahead = this.flyers.some((o) => o !== f && o.derezAt === null && (o.from === home || o.site === home) && (o.phase === 'taxi' || o.phase === 'park' || o.phase === 'lineup') && o.speed < 30
          && (() => { const of = this.frame(o, home, f.dir); return Math.abs(of.c - t) < 15 && of.a < hf.a - 1 && of.a > hf.a - 45; })());
        const p = AiAirTraffic.aim(hf, 20, t);
        const there = this.taxi(f, dt, p.dist < 2 ? hf.hdg : p.want, ahead ? 0 : p.dist, 14, g) && !ahead;
        if (there && !this.runwayBusy(home, f, player) && !this.flyers.some((o) => o.site === home && o.derezAt === null && o.inbound && (o.phase === 'approach' || o.phase === 'final') && this.frame(o, home, o.dir).a > -3500)) f.phase = 'lineup';
        return;
      }
      if (f.phase === 'lineup') {
        const p = AiAirTraffic.aim(hf, 70, 0);
        if (this.taxi(f, dt, p.want, p.dist, 9, g) || (Math.abs(hf.c) < 3 && hf.a > 40)) f.phase = 'takeoff';
        return;
      }
      // The take-off roll: down the centreline, then up at flying speed.
      let dh = hf.hdg - Math.max(-0.3, Math.min(0.3, hf.c / 40)) - f.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      f.heading += Math.max(-0.6, Math.min(0.6, dh * 2)) * dt;
      f.speed += f.thrust * dt;
      f.pos.x += Math.sin(f.heading) * f.speed * dt;
      f.pos.z -= Math.cos(f.heading) * f.speed * dt;
      f.pos.y = g;
      f.bank = 0;
      f.pitch = f.speed > f.vApp * 0.85 ? Math.min(0.14, f.pitch + 0.2 * dt) : 0;
      this.pose(f, 0);
      if (f.speed >= f.vApp * 1.05) { f.phase = 'climb'; f.dir = this.runwayDir(s); f.breakHeading = hf.hdg; f.until = this.sectorAltitude(home, f); }
      return;
    }
    switch (f.phase) {
      case 'climb': {
        // Straight out on the runway heading to a safe height, then on course.
        this.cruise(f, dt, time, { want: f.breakHeading, speed: Math.max(f.vApp * 1.3, f.cruise * 0.8), level: Math.max(f.cruiseAltitude, f.until + 10), clear: true });
        if (f.pos.y > f.until) { f.phase = 'cruise'; f.inbound = false; }
        return;
      }
      case 'cruise': {
        const dist = Math.hypot(wrap(s.x - f.pos.x), wrap(s.z - f.pos.z));
        this.cruise(f, dt, time, { want: Math.atan2(wrap(s.x - f.pos.x), -wrap(s.z - f.pos.z)), speed: f.cruise, level: f.cruiseAltitude, avoid: player });
        if (dist < Math.max(7000, (f.pos.y - s.y) / 0.07)) {
          f.phase = 'approach';
          f.dir = this.runwayDir(s);
          f.inbound = false;
          f.loiterDir = this.frame(f, s, f.dir).c >= 0 ? 1 : -1;
        }
        return;
      }
      case 'approach':
      case 'final': {
        // The pattern: out past the gate on the downwind side if need be, round onto the
        // extended centreline, then down the 3° slope to the numbers.
        const msa = this.sectorAltitude(s, f);
        const vPat = Math.min(f.cruise, f.vApp * 1.35);
        const R = (vPat * vPat) / (G * Math.tan(0.6));
        const gate = Math.max(2200, 3 * R + 600, Math.min(5500, (msa - s.y) / 0.09 + 1200));
        const glide = (a: number) => s.y + f.gear + 0.0524 * Math.max(0, 150 - a);
        if (!f.inbound) {
          // Room behind whoever is ahead on the approach?
          const spaced = !this.flyers.some((o) => o !== f && o.site === s && o.derezAt === null && o.inbound && (o.phase === 'approach' || o.phase === 'final') && this.frame(o, s, o.dir).a < fr.a + 3000 + gate * 0.3);
          if (fr.a < -gate && (spaced || fr.a < -gate - 7000)) f.inbound = true;
          else {
            const p = AiAirTraffic.aim(fr, fr.a - 1.5 * R, f.loiterDir * 2.2 * R);
            this.cruise(f, dt, time, { want: p.want, speed: vPat, level: Math.max(glide(-gate) + 80, msa), bank: 0.6, avoid: player });
            return;
          }
        }
        // Pure pursuit of the centreline.
        const look = Math.max(300, 1.2 * R);
        const p = AiAirTraffic.aim(fr, fr.a + (Math.abs(fr.c) < look ? Math.sqrt(look * look - fr.c * fr.c) : 0.2 * look), 0);
        const funnel = fr.a > -3800 && Math.abs(fr.c) < 120 + 0.15 * -fr.a;
        const speed = f.vApp + (vPat - f.vApp) * Math.max(0, Math.min(1, (-fr.a - 600) / (gate - 600)));
        const slope = glide(fr.a - Math.abs(fr.c));
        if (fr.a > -1500 && Math.abs(fr.c) < 40) f.phase = 'final';
        // The decision: not lined up, not on the slope, or the runway is taken, and it goes around.
        if (f.phase === 'final' && fr.a > -700 && fr.a < -100 && (Math.abs(fr.c) > 18 || Math.abs(f.pos.y - slope) > 30 || this.runwayBusy(s, f, player)) || (fr.a > -700 && f.phase !== 'final')) {
          f.phase = 'climb';
          f.breakHeading = fr.hdg;
          f.until = msa;
          f.goArounds++;
          // Twice round and still no runway: it diverts.
          if (++f.missed >= 2 && this.assign(f, player, s)) f.missed = 0;
          return;
        }
        const low = f.pos.y - ground;
        if (fr.a > -150 && low < 14) {
          // The flare, and down.
          const vs = -Math.max(0.8, low * 0.35);
          this.cruise(f, dt, time, { want: fr.hdg - Math.max(-0.2, Math.min(0.2, fr.c / 60)), speed: f.vApp * 0.92, vs, bank: 0.2 });
          if (f.pos.y <= ground + 0.05) { f.pos.y = ground; f.phase = 'rollout'; f.landings++; f.missed = 0; }
          return;
        }
        this.cruise(f, dt, time, { want: p.want, speed, vs: funnel ? Math.max(-0.2 * f.speed, Math.min(4, -f.speed * 0.0524 + (slope - f.pos.y) * 0.5)) : undefined, level: funnel ? undefined : Math.max(slope, msa), bank: 0.6, avoid: funnel ? undefined : player });
        return;
      }
      case 'rollout': {
        // Down: braking on the centreline to taxi speed, then off to the side.
        let dh = fr.hdg - Math.max(-0.3, Math.min(0.3, fr.c / 40)) - f.heading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        f.heading += Math.max(-0.6, Math.min(0.6, dh * 2)) * dt;
        const left = s.length - 60 - fr.a;
        f.speed = Math.max(11, f.speed - Math.max(4, (f.speed * f.speed) / (2 * Math.max(20, left))) * dt);
        f.pos.x += Math.sin(f.heading) * f.speed * dt;
        f.pos.z -= Math.cos(f.heading) * f.speed * dt;
        f.pos.y = ground;
        f.bank = 0;
        f.pitch += (0 - f.pitch) * Math.min(1, dt * 1.5);
        this.pose(f, 0);
        if (f.speed <= 12) { f.phase = 'vacate'; f.until = Math.min(s.length - 20, fr.a + 60); }
        return;
      }
      case 'vacate': {
        const p = AiAirTraffic.aim(fr, f.until, track);
        if (this.taxi(f, dt, p.want, p.dist, 11, ground)) {
          // Clear of the runway: a turnaround on the stand, then the next flight from here.
          f.from = s;
          f.phase = 'park';
          f.until = time + 25 + this.random() * 60;
        }
        return;
      }
      default: return;
    }
  }

  /** A rotorcraft's flight: straight up off the pad, across, a slowing approach, and straight down. */
  private civilRotor(f: AiFlyer, dt: number, time: number, player: THREE.Vector3, s: LandingSite): void {
    const pad = AiAirTraffic.padOf(f.phase === 'park' || f.phase === 'lift' ? f.from! : s);
    const dx = wrap(pad.x - f.pos.x), dz = wrap(pad.z - f.pos.z), dist = Math.hypot(dx, dz);
    const top = pad.y + f.gear;
    const hover = (vs: number) => {
      // Over the pad: slide onto its centre, nose steady.
      const k = Math.min(1, dt * 0.8);
      f.pos.x += dx * k;
      f.pos.z += dz * k;
      f.pos.y += vs * dt;
      f.speed += (0 - f.speed) * Math.min(1, dt * 2);
      f.bank += (0 - f.bank) * Math.min(1, dt * 2);
      f.pitch += (0 - f.pitch) * Math.min(1, dt * 2);
      f.altitude = f.pos.y;
      this.pose(f, vs);
    };
    switch (f.phase) {
      case 'park':
        f.pos.y = top;
        f.speed = 0;
        this.pose(f, 0);
        if (time > f.until) {
          if (!this.assign(f, player, f.from)) f.until = time + 30;
          else { f.phase = 'lift'; f.heading = Math.atan2(wrap(f.site!.x - f.pos.x), -wrap(f.site!.z - f.pos.z)); }
        }
        return;
      case 'lift':
        hover(Math.min(6, 1 + (f.pos.y - top) * 0.5));
        if (f.pos.y > top + 35) f.phase = 'cruise';
        return;
      case 'cruise': {
        // Slowing in from a few hundred metres, to a hover above the pad (and above what stands round it).
        const speed = dist < 320 ? Math.max(3, Math.min(f.cruise, dist * 0.14)) : f.cruise;
        this.cruise(f, dt, time, { want: Math.atan2(dx, -dz), speed, level: dist < 320 ? Math.max(top + 40, Math.min(f.pos.y, f.cruiseAltitude)) : f.cruiseAltitude, avoid: player });
        if (dist < 12 && f.speed < 8) f.phase = 'descend';
        return;
      }
      case 'descend': {
        const h = f.pos.y - top;
        hover(-Math.max(1.2, Math.min(8, h * 0.25)));
        if (f.pos.y <= top) {
          f.pos.y = top;
          f.from = s;
          f.phase = 'park';
          f.landings++;
          f.until = time + 20 + this.random() * 50;
        }
        return;
      }
      default: return void (f.phase = 'cruise');
    }
  }

  /**
   * Escort: with nothing to fight, a friendly flies a station off the player's quarter (or,
   * while the player is slow or on the ground, a wide circle round it), a little above it.
   */
  private escort(f: AiFlyer, time: number, player: THREE.Vector3, pv?: THREE.Vector3): { want: number; vs: number; speed: number } {
    const sp = pv ? Math.hypot(pv.x, pv.z) : 0;
    const side = f.id % 2 ? 1 : -1;
    let sx: number, sz: number;
    if (sp > 25 && pv) {
      const hx = pv.x / sp, hz = pv.z / sp; // along the player's track
      sx = player.x - hx * 350 - hz * 300 * side;
      sz = player.z - hz * 350 + hx * 300 * side;
    } else {
      const a = time * (f.cruise / 1200) * side + f.id;
      sx = player.x + Math.sin(a) * 1200;
      sz = player.z - Math.cos(a) * 1200;
    }
    const dx = wrap(sx - f.pos.x), dz = wrap(sz - f.pos.z);
    const dist = Math.hypot(dx, dz);
    const speed = Math.max(f.cruise * 0.75, Math.min(f.cruise * 1.25, sp + dist * 0.05));
    const y = player.y + 60 + (f.id % 3) * 25;
    return { want: Math.atan2(dx, -dz), vs: (y - f.pos.y) * 0.3, speed };
  }

  /**
   * A hostile in a fight: the same coordinated-turn point mass flown hard (65° of bank, a quick
   * nose), steered at a heading and a vertical speed, and never through the ground or a tower.
   */
  private combatFly(f: AiFlyer, dt: number, c: { want: number; vs: number; speed: number; steep?: boolean }): void {
    let dh = c.want - f.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const maxBank = f.kind === 'airplane' ? 1.15 : 0.6;
    const maxRate = (G * Math.tan(maxBank)) / Math.max(5, f.speed);
    const rate = Math.max(-maxRate, Math.min(maxRate, dh * 6));
    f.heading += rate * dt;
    const bankWant = Math.atan((rate * f.speed) / G);
    f.bank += (bankWant - f.bank) * Math.min(1, dt * 3);
    f.speed += (c.speed - f.speed) * Math.min(1, dt * 0.35);
    const limit = 0.42 * f.speed;
    let vs = Math.max(-(c.steep ? 0.95 : 0.42) * f.speed, Math.min(limit, c.vs));
    // The floor: terrain and structures ahead, with room to pull out of a dive.
    const floor = this.floorAhead(f, 6) + 25 + f.radius;
    const low = floor - (f.pos.y + Math.min(0, vs) * 2);
    if (low > 0) vs = Math.max(vs, Math.min(limit, low * 0.8));
    f.pitch += (Math.atan2(vs, f.speed) - f.pitch) * Math.min(1, dt * 8);
    f.pos.x += Math.sin(f.heading) * f.speed * dt;
    f.pos.z -= Math.cos(f.heading) * f.speed * dt;
    f.pos.y += vs * dt;
    f.altitude = f.pos.y;
    this.pose(f, vs);
  }

  /** Pose: heading about -Y (clockwise from above), pitch about X, bank about Z (-: right wing down). */
  private pose(f: AiFlyer, vs: number): void {
    f.rot.setFromEuler(this._e.set(f.pitch, -f.heading, -f.bank, 'YXZ'));
    f.vel.set(Math.sin(f.heading) * f.speed, vs, -Math.cos(f.heading) * f.speed);
    f.body.setNextKinematicTranslation({ x: f.pos.x, y: f.pos.y, z: f.pos.z });
    f.body.setNextKinematicRotation(f.rot);
  }

  /** Highest terrain or structure top on the flight path over the next 15 s (and 150 m either side, for turns). */
  private floorAhead(f: AiFlyer, horizon = 15): number {
    let top = -Infinity;
    const sx = Math.cos(f.heading), sz = Math.sin(f.heading); // to the right
    for (const t of [0, 1, 2, 3.5, 5, 7, 10, 15]) {
      if (t > horizon) break;
      const d = t * f.speed;
      const x = f.pos.x + Math.sin(f.heading) * d, z = f.pos.z - Math.cos(f.heading) * d;
      for (const side of t < 2 ? [0] : [-150, 0, 150]) top = Math.max(top, terrainHeight(x + sx * side, z + sz * side), obstacleTop(x + sx * side, z + sz * side));
    }
    return top;
  }

  /** Highest terrain or structure top on (and inside) a circle. */
  private circleFloor(cx: number, cz: number, r: number): number {
    let top = Math.max(terrainHeight(cx, cz), obstacleTop(cx, cz));
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      for (const rr of [r * 0.5, r]) {
        const x = cx + Math.sin(a) * rr, z = cz - Math.cos(a) * rr;
        top = Math.max(top, terrainHeight(x, z), obstacleTop(x, z));
      }
    }
    return top;
  }

  /** The flyer's world rotation (for rendering). */
  rotation(f: AiFlyer, out = new THREE.Quaternion()): THREE.Quaternion {
    return out.setFromEuler(this._e.set(f.pitch, -f.heading, -f.bank, 'YXZ'));
  }
}
