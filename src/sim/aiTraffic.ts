import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { CraftDef } from '../craft/types.ts';
import { style1982, redTeam, circuitOf } from '../craft/style1982.ts';
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
 * Hostile flyers are the enemy: red-team aircraft with guns and missiles of their own and
 * several hit points. They patrol like the rest until the player's craft carries weapons within
 * their reach; then they hunt it: lead pursuit on the guns' line, a burst when the nose is on,
 * a missile from further out, breaking off before they would ram, and a hard break turn when
 * they are hit. An unarmed player is left alone.
 */

/** What a hostile flyer hunts: the player's craft. */
export interface AirTarget {
  vel: THREE.Vector3;
  /** Not derezzed. */
  alive: boolean;
  /** Carries weapons (hostiles ignore an unarmed craft). */
  armed: boolean;
  /** The craft as a lock target: hostiles' missiles home on it. */
  lock?: LockTarget;
}

export type CombatState = 'patrol' | 'attack' | 'extend' | 'evade';

/** Hostiles notice an armed target inside this range (m) and give up beyond the second. */
const DETECT = 4000, LOSE = 6500;
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
  /** Red team: hunts the armed player. */
  hostile: boolean;
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
  /** How many hostile aircraft to keep around the player, besides the peaceful ones (0 = none). */
  hostiles = 0;
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

  /** Live hostile aircraft. */
  hostileFlyers(): AiFlyer[] {
    return this.flyers.filter((f) => f.hostile && f.derezAt === null);
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

  private spawn(player: THREE.Vector3, time: number, hostile = false): void {
    const random = hostile ? this.combatRandom : this.random;
    let flyable = this.pool.filter((d) => flyerKind(d) !== 'ground');
    if (hostile) {
      // Fighters are the fast aeroplanes (jets), else any aeroplane, else rotorcraft; never a blimp.
      const planes = flyable.filter((d) => flyerKind(d) === 'airplane');
      const jets = planes.filter((d) => performance(d, 'airplane').cruise >= 100);
      flyable = jets.length ? jets : planes.length ? planes : flyable.filter((d) => flyerKind(d) === 'rotorcraft');
    }
    if (!flyable.length) return;
    const raw = flyable[Math.floor(random() * flyable.length)];
    const def = hostile ? redTeam(raw) : style1982(raw);
    const kind = flyerKind(def) as FlyerKind;
    const perf = performance(def, kind);
    const b = craftBounds(def);
    const length = Math.max(b.max.z - b.min.z, b.max.x - b.min.x);
    const radius = Math.max(1.5, b.max.clone().sub(b.min).length() / 2);
    // Appear 2.5-5 km out (out of easy sight), already cruising.
    const a = random() * Math.PI * 2, d = (hostile ? 3200 : 2500) + random() * (hostile ? 1800 : 2500);
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
    };
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
  }

  step(dt: number, time: number, player: THREE.Vector3, target?: AirTarget): void {
    // Drop the derezzed (after a moment) and the far away; keep the count topped up.
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i];
      const far = Math.hypot(wrap(f.pos.x - player.x), wrap(f.pos.z - player.z)) > 12000;
      if ((f.derezAt !== null && time - f.derezAt > 2) || far) {
        if (f.derezAt === null) this.drop(f);
        this.flyers.splice(i, 1);
      }
    }
    for (const hostile of [false, true]) {
      const wanted = hostile ? this.hostiles : this.count;
      let alive = this.flyers.filter((f) => f.derezAt === null && f.hostile === hostile).length;
      while (alive < wanted && this.pool.length) { this.spawn(player, time, hostile); alive++; if (alive > 64) break; }
      while (alive > wanted) {
        const f = this.flyers.find((x) => x.derezAt === null && x.hostile === hostile)!;
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

  /**
   * A hostile's pilot: what it wants this step while it hunts (null: nothing to hunt, it
   * patrols like any other flyer). Sets its triggers.
   */
  private fight(f: AiFlyer, dt: number, time: number, player: THREE.Vector3, target: AirTarget | undefined): { want: number; vs: number; speed: number } | null {
    const w = f.weapons;
    if (!w) return null;
    w.trigger.primary = w.trigger.secondary = false;
    const dx = wrap(player.x - f.pos.x), dz = wrap(player.z - f.pos.z), dy = player.y - f.pos.y;
    const range = Math.hypot(dx, dy, dz);
    const hunting = !!target && target.alive && target.armed && range < (f.combat === 'patrol' ? DETECT : LOSE);
    w.lock = null;
    if (!hunting || !target) {
      if (f.combat !== 'patrol') {
        // Nothing to fight: back to the patrol.
        f.combat = 'patrol';
        f.state = 'transit';
        f.altitude = f.cruiseAltitude;
        f.dest = this.pickDest(player, this.combatRandom);
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
    const tv = target.vel;
    const closure = -((tv.x - f.vel.x) * dx + (tv.y - f.vel.y) * dy + (tv.z - f.vel.z) * dz) / Math.max(1, range);
    if (f.combat === 'attack' && range < Math.max(250, closure * 1.6)) {
      // Too close to keep the guns on: break off to one side and up, then come round again.
      f.combat = 'extend';
      f.combatUntil = time + 6 + random() * 4;
      f.loiterDir = random() < 0.5 ? 1 : -1;
      f.breakHeading = f.heading + f.loiterDir * 0.7;
    }
    const fast = Math.min(f.cruise * 1.25, Math.max(f.cruise * 0.75, tv.length() + 30));
    if (f.combat === 'extend') return { want: f.breakHeading, vs: Math.max(0.12 * f.speed, (player.y + 150 - f.pos.y) * 0.5), speed: f.cruise * 1.25 };
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
    if (Math.abs(dh) < 0.02 && Math.abs(pitchWant - f.pitch) < 0.02 && range > 400 && range < 1500 && time - f.missileAt > 6) {
      w.trigger.secondary = true;
      w.lock = target.lock ?? null;
      f.missileAt = time;
    }
    return { want, vs: f.speed * Math.tan(Math.max(-0.4, Math.min(0.4, pitchWant))), speed: fast };
  }

  private fly(f: AiFlyer, dt: number, time: number, player: THREE.Vector3, target?: AirTarget): void {
    const fight = f.hostile ? this.fight(f, dt, time, player, target) : null;
    if (fight) {
      this.combatFly(f, dt, fight);
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
   * A hostile in a fight: the same coordinated-turn point mass flown hard (65° of bank, a quick
   * nose), steered at a heading and a vertical speed, and never through the ground or a tower.
   */
  private combatFly(f: AiFlyer, dt: number, c: { want: number; vs: number; speed: number }): void {
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
    let vs = Math.max(-limit, Math.min(limit, c.vs));
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
