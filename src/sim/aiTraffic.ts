import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { CraftDef } from '../craft/types.ts';
import { style1982, circuitOf } from '../craft/style1982.ts';
import { obstacleTop } from '../world/structures.ts';
import { terrainHeight } from './terrain.ts';
import { craftBounds } from './weapons.ts';
import { PLANET } from './layout.ts';

/**
 * AI air traffic: other programs flying around the player, so the world feels inhabited. Each
 * flyer is one of the built-in aircraft or, in single player, one of the player's own designs.
 * It flies to a random destination within a few kilometres of the player, circles there for a
 * while, then picks another; it climbs over whatever stands in its way. The flight model is
 * kinematic (a coordinated-turn point mass, banking into turns), so dozens cost almost nothing;
 * each carries a kinematic Rapier collider, so the player can collide with it and weapons can
 * hit it (it derezzes). Deterministic for a seed.
 */

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
  /** Flyers derezzed so far (tests, stats). */
  derezzed = 0;
  private readonly random: () => number;
  private nextId = 1;
  private readonly body: Map<number, AiFlyer> = new Map();
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();

  constructor(private readonly world: RAPIER.World, seed = 1982) {
    this.random = rng(seed);
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
    if (f.derezAt !== null) return;
    f.derezAt = time;
    this.derezzed++;
    this.drop(f);
  }

  private drop(f: AiFlyer): void {
    for (let i = 0; i < f.body.numColliders(); i++) this.body.delete(f.body.collider(i).handle);
    if (this.world.getRigidBody(f.body.handle)) this.world.removeRigidBody(f.body);
  }

  /** A destination 1.5-6 km from the player, in a random direction. */
  private pickDest(player: THREE.Vector3): { x: number; z: number } {
    const a = this.random() * Math.PI * 2, d = 1500 + this.random() * 4500;
    return { x: player.x + Math.sin(a) * d, z: player.z - Math.cos(a) * d };
  }

  private spawn(player: THREE.Vector3, time: number): void {
    const flyable = this.pool.filter((d) => flyerKind(d) !== 'ground');
    if (!flyable.length) return;
    const raw = flyable[Math.floor(this.random() * flyable.length)];
    const def = style1982(raw);
    const kind = flyerKind(def) as FlyerKind;
    const perf = performance(def, kind);
    const b = craftBounds(def);
    const length = Math.max(b.max.z - b.min.z, b.max.x - b.min.x);
    const radius = Math.max(1.5, b.max.clone().sub(b.min).length() / 2);
    // Appear 2.5-5 km out (out of easy sight), already cruising.
    const a = this.random() * Math.PI * 2, d = 2500 + this.random() * 2500;
    const x = player.x + Math.sin(a) * d, z = player.z - Math.cos(a) * d;
    const altitude0 = perf.alt[0] + this.random() * (perf.alt[1] - perf.alt[0]);
    // Never appear inside or just above a structure.
    const altitude = Math.max(altitude0, terrainHeight(x, z) + 60, obstacleTop(x, z) + 80);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, altitude, z));
    // One box collider around the airframe (good enough to fly into or shoot).
    const half = b.max.clone().sub(b.min).multiplyScalar(0.5);
    const centre = b.max.clone().add(b.min).multiplyScalar(0.5);
    const col = this.world.createCollider(RAPIER.ColliderDesc.cuboid(Math.max(0.3, half.x), Math.max(0.3, half.y), Math.max(0.3, half.z)).setTranslation(centre.x, centre.y, centre.z).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(1000), body);
    const f: AiFlyer = {
      id: this.nextId++, def, name: def.name, kind, color: circuitOf(def),
      pos: new THREE.Vector3(x, altitude, z), heading: this.random() * Math.PI * 2, bank: 0, pitch: 0,
      speed: perf.cruise, cruise: perf.cruise * (0.85 + this.random() * 0.3), altitude, cruiseAltitude: altitude,
      state: 'transit', dest: this.pickDest(player), loiterUntil: 0, loiterDir: this.random() < 0.5 ? 1 : -1,
      radius, length, body, derezAt: null,
    };
    void time;
    this.body.set(col.handle, f);
    this.flyers.push(f);
  }

  step(dt: number, time: number, player: THREE.Vector3): void {
    // Drop the derezzed (after a moment) and the far away; keep the count topped up.
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i];
      const far = Math.hypot(wrap(f.pos.x - player.x), wrap(f.pos.z - player.z)) > 12000;
      if ((f.derezAt !== null && time - f.derezAt > 2) || far) {
        if (f.derezAt === null) this.drop(f);
        this.flyers.splice(i, 1);
      }
    }
    let alive = this.flyers.filter((f) => f.derezAt === null).length;
    while (alive < this.count && this.pool.length) { this.spawn(player, time); alive++; if (alive > 64) break; }
    while (alive > this.count) {
      const f = this.flyers.find((x) => x.derezAt === null)!;
      this.drop(f);
      this.flyers.splice(this.flyers.indexOf(f), 1);
      alive--;
    }
    for (const f of this.flyers) if (f.derezAt === null) this.fly(f, dt, time, player);
  }

  private fly(f: AiFlyer, dt: number, time: number, player: THREE.Vector3): void {
    const dx = wrap(f.dest.x - f.pos.x), dz = wrap(f.dest.z - f.pos.z);
    const dist = Math.hypot(dx, dz);
    // Loiter radius: a gentle 25° banked circle at cruise (hovering craft circle tighter).
    const loiterR = f.kind === 'airplane' ? Math.max(300, (f.cruise * f.cruise) / (G * Math.tan(0.44))) : f.kind === 'rotorcraft' ? 180 : 250;
    let want: number;
    if (f.state === 'transit') {
      want = Math.atan2(dx, -dz);
      if (dist < loiterR * 1.1) {
        f.state = 'loiter';
        f.loiterUntil = time + 30 + this.random() * 60;
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
        f.dest = this.pickDest(player);
        f.loiterDir = this.random() < 0.5 ? 1 : -1;
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
    const target = Math.max(f.altitude, floor);
    const vs = Math.max(-8, Math.min(Math.max(12, 0.3 * f.speed), (target - f.pos.y) * 0.4));
    f.pitch += (Math.atan2(vs, f.speed) - f.pitch) * Math.min(1, dt * 2);
    f.pos.x += Math.sin(f.heading) * f.speed * dt;
    f.pos.z -= Math.cos(f.heading) * f.speed * dt;
    f.pos.y += vs * dt;
    // Pose: heading about -Y (clockwise from above), pitch about X, bank about Z (-: right wing down).
    this._q.setFromEuler(this._e.set(f.pitch, -f.heading, -f.bank, 'YXZ'));
    f.body.setNextKinematicTranslation({ x: f.pos.x, y: f.pos.y, z: f.pos.z });
    f.body.setNextKinematicRotation(this._q);
  }

  /** Highest terrain or structure top on the flight path over the next 15 s (and 150 m either side, for turns). */
  private floorAhead(f: AiFlyer): number {
    let top = -Infinity;
    const sx = Math.cos(f.heading), sz = Math.sin(f.heading); // to the right
    for (const t of [0, 1, 2, 3.5, 5, 7, 10, 15]) {
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
