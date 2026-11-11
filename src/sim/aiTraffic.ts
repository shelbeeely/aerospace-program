import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { CraftDef } from '../craft/types.ts';
import { style1982, circuitOf } from '../craft/style1982.ts';
import { FREELANCER, hostile as sidesHostile, sideLivery, type Side, type Team } from './teams.ts';
import { obstacleTop } from '../world/structures.ts';
import { terrainHeight } from './terrain.ts';
import { craftBounds, WeaponSystem, type WeaponHost, type WeaponImpact } from './weapons.ts';
import { PLANET } from './layout.ts';
import type { LockTarget } from './lock.ts';

/**
 * AI air traffic: other programs flying around the player, so the world feels inhabited. Each
 * flyer is one of the built-in aircraft or, in single player, one of the player's own designs.
 * It flies to a random destination within a few kilometres of the player, circles there for a
 * while, then picks another; it climbs over whatever stands in its way. The flight model is
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
  kind: 'player' | 'flyer' | 'turret' | 'remote';
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
export type FlyerRole = 'civil' | 'friend' | 'enemy' | 'free' | 'merc';

export type CombatState = 'patrol' | 'attack' | 'extend' | 'evade';

/** Combat aircraft notice a target inside this range (m) and give up beyond the second. */
const DETECT = 4000, LOSE = 6500;
/** A mercenary contract (s), and how many can be hired at once. */
export const MERC_CONTRACT = 300, MAX_MERCS = 3;
const GUN_RANGE = 750, GUN_SPEED = 620;
/** Hit points of a hostile aircraft (a peaceful flyer has 1: any hit derezzes it). */
const HOSTILE_HP = 6;

export type FlyerKind = 'airplane' | 'rotorcraft' | 'lighter-than-air';

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
function performance(def: CraftDef, kind: FlyerKind): { cruise: number; alt: [number, number] } {
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
    const side: Side | null = role === 'civil' ? null : role === 'friend' || role === 'merc' ? this.playerTeam : role === 'free' ? FREELANCER : this.enemyTeam();
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
      state: 'transit', dest: this.pickDest(player, random), loiterUntil: 0, loiterDir: random() < 0.5 ? 1 : -1,
      radius, length, body, derezAt: null,
      hostile, hp: hostile ? HOSTILE_HP : 1, maxHp: hostile ? HOSTILE_HP : 1, hitAt: -Infinity,
      combat: 'patrol', combatUntil: 0, breakHeading: 0, aimError: { h: 0, p: 0 }, missileAt: time + 4,
      vel: new THREE.Vector3(), rot: new THREE.Quaternion(), weapons: null, host: null,
      side, role, mercUntil: role === 'merc' ? time + MERC_CONTRACT : Infinity, leaving: false, target: null, targetAt: -Infinity,
      handle: null as unknown as LockTarget, foe: null,
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
    return f;
  }

  step(dt: number, time: number, player: THREE.Vector3, target?: AirTarget): void {
    // Drop the derezzed (after a moment) and the far away; keep the count topped up.
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i];
      const dist = Math.hypot(wrap(f.pos.x - player.x), wrap(f.pos.z - player.z));
      const far = dist > 12000 || (f.leaving && dist > 5000);
      if ((f.derezAt !== null && time - f.derezAt > 2) || far) {
        if (f.derezAt === null) this.drop(f);
        this.flyers.splice(i, 1);
      }
    }
    const wantedOf: Record<Exclude<FlyerRole, 'merc'>, number> = { civil: this.count, friend: this.friendlies, enemy: this.enemies, free: this.freelancers };
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
    if (f.side === null || f.leaving) return null;
    const guard = f.role === 'friend' || f.role === 'merc';
    if (f.target && time - f.targetAt < 1 && this.valid(f.target, guard ? player : f.pos, LOSE)) return f.target;
    f.targetAt = time;
    const foes: Foe[] = [];
    for (const o of this.flyers) if (o !== f && o.foe && o.derezAt === null && !o.leaving && sidesHostile(f.side, o.side!)) foes.push(o.foe);
    for (const o of target?.foes ?? []) if (o.engage && sidesHostile(f.side, o.side) && o.lock.alive()) foes.push(o);
    const from = guard ? player : f.pos;
    let best: Foe | null = null, score = Infinity;
    for (const o of foes) {
      const d = AiAirTraffic.gap(o.lock.position(this._tp), from);
      const reach = f.target === o ? LOSE : DETECT;
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
    const fight = f.hostile ? this.fight(f, dt, time, this.choose(f, time, player, target)) : null;
    if (fight) {
      this.combatFly(f, dt, fight);
      return;
    }
    if (f.role === 'friend' || f.role === 'merc') {
      this.combatFly(f, dt, this.escort(f, time, player, target?.vel));
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
