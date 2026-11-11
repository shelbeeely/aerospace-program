import * as THREE from 'three';
import { GRID } from '../arch/grid.ts';
import { hashFloat } from '../arch/rng.ts';
import { chunkAt } from '../world/planetCity.ts';
import { obstacleTop } from '../world/structures.ts';
import type { AiAirTraffic, AiFlyer, Foe } from './aiTraffic.ts';
import type { GroundTurret, GroundTurretSystem } from './groundTurrets.ts';
import { TURRET_HEAD_Y } from './groundTurrets.ts';
import { PLANET } from './layout.ts';
import type { LockTarget } from './lock.ts';
import { hostile, sideLight, type Team } from './teams.ts';
import { terrainHeight } from './terrain.ts';
import type { Territory } from './territory.ts';
import { predictDrop, WeaponSystem, type Projectile, type WeaponImpact } from './weapons.ts';

/**
 * Called-in strikes, paid with credits and aimed from the strike globe. Each starts from the
 * nearest district the player's team holds (at least 3 km from the target, else from the
 * player), so a strike deep in enemy land has further to go, and each plays out for real: the
 * target becomes a focus point where turrets stream in, and the turrets on the way and at the
 * target can shoot it down.
 *
 * - Missile barrage: six cruise missiles at 1.5 km, 260 m/s; each dives on a different enemy
 *   turret within 1.5 km of the target (else on the point).
 * - EMP strike: one cruise missile that bursts an EMP over the target.
 * - Nuke bomber: an AI bomber of the team flies there at 1.8 km, drops the nuke bomb at the
 *   release point the fall predicts, and turns for home.
 */

export type StrikeKind = 'barrage' | 'emp' | 'bomber';

export const STRIKES: Record<StrikeKind, { label: string; price: number; speed: number }> = {
  barrage: { label: 'Missile barrage', price: 400, speed: 260 },
  emp: { label: 'EMP strike', price: 900, speed: 260 },
  bomber: { label: 'Nuke bomber', price: 2500, speed: 230 },
};

const CRUISE_AGL = 1500;
const BOMBER_AGL = 1800;
const MISSILES = 6;
/** Enemy turrets within this of the target are the barrage's aim points. */
const TARGET_RADIUS = 1500;
/** A turret round passing this close to a cruise missile destroys it. */
const KILL_RADIUS = 2.5;
/** Rounds a cruise missile takes before it goes down. */
const MISSILE_HP = 1;
/** The chance a round passing within KILL_RADIUS actually strikes home. */
const HIT_CHANCE = 0.25;
/** EMP strike: it bursts this high over the target. */
const EMP_BURST = 250;
/** A target stays live this long after its strike (s). */
const LINGER = 30;

const C = PLANET.circumference;
const wrap = (d: number) => d - Math.round(d / C) * C;

/** One cruise missile of a strike. */
export interface CruiseMissile {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** The turret it dives on, or null for the point. */
  aim: GroundTurret | null;
  /** When it launches (staggered). */
  at: number;
  /** Where it falls in beside the target (spreads a barrage on an empty point). */
  off: { x: number; z: number };
  dead: boolean;
  /** An EMP strike: where it bursts (the middle of the enemy turrets there), once chosen. */
  over?: { x: number; z: number } | null;
  /** Turret rounds it can take before it goes down. */
  hp: number;
  /** The last round that struck it (one round counts once). */
  hitBy: number;
  /** Drawn by the weapons view as an ordinary missile. */
  view: Projectile;
  handle: LockTarget;
  foe: Foe;
}

export interface Strike {
  id: number;
  kind: StrikeKind;
  /** The target. */
  x: number;
  z: number;
  /** Where it set out from. */
  fromX: number;
  fromZ: number;
  launchedAt: number;
  /** Estimated arrival (s, sim time). */
  eta: number;
  missiles: CruiseMissile[];
  bomber: AiFlyer | null;
  /** Over: arrived (or every part of it shot down, or the bomber gone). */
  done: boolean;
  /** When it ended (s): its target stays live a while after, to see what it did. */
  doneAt: number;
  /** What happened, for the notice and the globe. */
  outcome: string | null;
}

/** What the strike system needs from the simulation. */
export interface StrikeHost {
  team: () => Team;
  time: () => number;
  credits: () => number;
  spend: (n: number) => void;
  notice: (text: string) => void;
  playerPos: () => THREE.Vector3;
  territory: Territory;
  air: AiAirTraffic;
  turrets: GroundTurretSystem;
  /** A round of the player's (its kills pay, its captures are the player's). */
  impact: (h: WeaponImpact) => void;
  emp: (x: number, y: number, z: number) => void;
}

let nextId = 1;

export class StrikeSystem {
  readonly strikes: Strike[] = [];
  /** The cruise missiles as projectiles (the renderer reads it like any weapon system). */
  readonly view = new WeaponSystem();
  /** Missiles shot down so far (tests, stats). */
  intercepted = 0;

  constructor(private readonly host: StrikeHost) {}

  /** Live strikes (for the globe). */
  live(): Strike[] {
    return this.strikes.filter((s) => !s.done);
  }

  /**
   * The nearest district the team holds to (x, z), at least 3 km from it, as its centre on the
   * ground; else the player's position.
   */
  origin(x: number, z: number): THREE.Vector3 {
    const team = this.host.team();
    const [ci, cj] = chunkAt(x, z);
    const n = GRID.chunks, size = GRID.chunkSize;
    let best = null as { x: number; z: number; d: number } | null;
    const maxR = Math.ceil(n / 2);
    for (let r = 1; r <= maxR; r++) {
      for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        if (this.host.territory.ownerOf(ci + di, cj + dj) !== team) continue;
        const cx = GRID.x0 + (((ci + di) % n + n) % n + 0.5) * size;
        const cz = GRID.z0 + (((cj + dj) % n + n) % n + 0.5) * size;
        const d = Math.hypot(wrap(cx - x), wrap(cz - z));
        if (d < 3000) continue;
        if (!best || d < best.d) best = { x: cx, z: cz, d };
      }
      // A ring further out can't be nearer than r - 1 chunks.
      if (best && best.d < (r - 1) * size) break;
    }
    if (!best) {
      const p = this.host.playerPos();
      return new THREE.Vector3(p.x, Math.max(terrainHeight(p.x, p.z), obstacleTop(p.x, p.z)), p.z);
    }
    return new THREE.Vector3(best.x, Math.max(terrainHeight(best.x, best.z), obstacleTop(best.x, best.z)), best.z);
  }

  /** Seconds a strike of this kind would take to reach (x, z). */
  etaTo(kind: StrikeKind, x: number, z: number): number {
    const o = this.origin(x, z);
    return Math.hypot(wrap(x - o.x), wrap(z - o.z)) / STRIKES[kind].speed + (kind === 'bomber' ? 40 : 8);
  }

  /** Call in a strike on (x, z). Returns why not, or the strike. */
  call(kind: StrikeKind, x: number, z: number): Strike | string {
    const S = STRIKES[kind];
    if (this.host.credits() < S.price) return `Not enough credits (${S.price} needed, ${this.host.credits()} held)`;
    const time = this.host.time();
    // Everything in the image of the planet nearest the craft (where turrets stream in), the
    // origin beside the target.
    const pp = this.host.playerPos();
    x = pp.x + wrap(x - pp.x);
    z = pp.z + wrap(z - pp.z);
    const o = this.origin(x, z);
    o.x = x + wrap(o.x - x);
    o.z = z + wrap(o.z - z);
    const dist = Math.hypot(wrap(x - o.x), wrap(z - o.z));
    const s: Strike = {
      id: nextId++, kind, x, z, fromX: o.x, fromZ: o.z, launchedAt: time, eta: time + this.etaTo(kind, x, z),
      missiles: [], bomber: null, done: false, doneAt: Infinity, outcome: null,
    };
    if (kind === 'bomber') {
      const def = this.host.air.bomberDef();
      if (!def) return 'No aircraft to fly a bomber';
      const from = new THREE.Vector3(o.x, Math.max(o.y, obstacleTop(o.x, o.z)) + BOMBER_AGL, o.z);
      const air = this.host.air;
      const f = air.spawnBomber(def, from, time, {
        x, z, dropped: false,
        release: (b) => this.release(s, b),
      });
      if (!f) return 'No aircraft to fly a bomber';
      s.bomber = f;
    } else {
      const n = kind === 'barrage' ? MISSILES : 1;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const spread = n > 1 ? 120 : 0;
        s.missiles.push(this.missile(s, o, time + i * 0.4, { x: Math.sin(a) * spread, z: Math.cos(a) * spread }));
      }
    }
    this.host.spend(S.price);
    this.strikes.push(s);
    this.host.notice(`${S.label} called in (−${S.price} credits): ${(dist / 1000).toFixed(1)} km, about ${Math.round(s.eta - time)} s`);
    return s;
  }

  private missile(s: Strike, o: THREE.Vector3, at: number, off: { x: number; z: number }): CruiseMissile {
    const pos = new THREE.Vector3(o.x + off.x * 0.3, o.y + 40, o.z + off.z * 0.3);
    const vel = new THREE.Vector3(0, 60, 0);
    const color = sideLight(this.host.team());
    const view: Projectile = {
      id: -(nextId++), kind: s.kind === 'emp' ? 'emp' : 'missile', bounces: 0, pos: pos.clone(), vel: vel.clone(),
      heading: new THREE.Vector3(0, 1, 0), age: 0, color, target: null,
    };
    const m: CruiseMissile = { pos, vel, aim: null, at, off, dead: false, hp: MISSILE_HP, hitBy: -1, view, handle: null as unknown as LockTarget, foe: null as unknown as Foe };
    m.handle = {
      id: `strike:${s.id}:${view.id}`, kind: 'hostile', name: 'Cruise missile', radius: 2,
      alive: () => !m.dead && !s.done && this.host.time() >= m.at,
      position: (v) => v.copy(m.pos),
      velocity: (v) => v.copy(m.vel),
    };
    m.foe = { side: this.host.team(), lock: m.handle, kind: 'missile', engage: true, ground: false };
    return m;
  }

  /** Foes the turrets may shoot at: the cruise missiles in the air. */
  foes(): Foe[] {
    const out: Foe[] = [];
    const time = this.host.time();
    for (const s of this.strikes) if (!s.done) for (const m of s.missiles) if (!m.dead && time >= m.at) { m.foe.side = this.host.team(); out.push(m.foe); }
    return out;
  }

  /**
   * Places that must be live (turrets streamed in, aircraft kept): each strike's target, and
   * where it is now (so the turrets on its way can engage it).
   */
  focus(): Array<{ x: number; z: number }> {
    const out: Array<{ x: number; z: number }> = [];
    const time = this.host.time();
    for (const s of this.strikes) {
      if (s.done) {
        if (time - s.doneAt < LINGER) out.push({ x: s.x, z: s.z });
        continue;
      }
      out.push({ x: s.x, z: s.z });
      const at = this.position(s);
      if (at) out.push({ x: at.x, z: at.z });
    }
    return out;
  }

  /** Where a strike is now (the lead missile, or the bomber), or null. */
  position(s: Strike): THREE.Vector3 | null {
    if (s.bomber) return s.bomber.derezAt === null ? s.bomber.pos : null;
    const live = s.missiles.filter((m) => !m.dead);
    if (!live.length) return null;
    let best = live[0], d = Infinity;
    for (const m of live) {
      const dm = Math.hypot(wrap(m.pos.x - s.x), wrap(m.pos.z - s.z));
      if (dm < d) { d = dm; best = m; }
    }
    return best.pos;
  }

  step(dt: number): void {
    const time = this.host.time();
    this.view.projectiles.length = 0;
    for (const s of this.strikes) {
      if (s.done) continue;
      if (s.bomber) this.stepBomber(s, time);
      else {
        for (const m of s.missiles) if (!m.dead && time >= m.at) this.fly(s, m, dt, time);
        if (s.missiles.every((m) => m.dead)) this.finish(s, s.outcome ?? 'arrived');
      }
    }
    // Keep only the recent past.
    if (this.strikes.length > 24) {
      const keep = this.strikes.filter((s, i) => !s.done || i >= this.strikes.length - 8);
      this.strikes.length = 0;
      this.strikes.push(...keep);
    }
  }

  private finish(s: Strike, outcome: string): void {
    s.done = true;
    s.doneAt = this.host.time();
    s.outcome = outcome;
  }

  private stepBomber(s: Strike, time: number): void {
    const b = s.bomber!;
    if (b.derezAt !== null) {
      this.finish(s, s.bomber!.run?.dropped ? 'bomb away, bomber lost' : 'bomber shot down');
      if (!b.run?.dropped) this.host.notice(`${STRIKES.bomber.label}: the bomber was shot down`);
      return;
    }
    // Done once its bomb has gone off (or never will: the bomber left with it).
    if (b.run?.dropped && !(b.weapons?.projectiles.some((p) => p.kind === 'nuke'))) this.finish(s, 'delivered');
    else if (!this.host.air.flyers.includes(b)) this.finish(s, 'bomber gone');
    void time;
  }

  /** The bomber's release: drop when the predicted burst is on the target (or it's passing). */
  private release(s: Strike, b: AiFlyer): boolean {
    const dx = wrap(s.x - b.pos.x), dz = wrap(s.z - b.pos.z);
    const d = Math.hypot(dx, dz);
    // The fall carries the bomb about speed × fall time forward: no need to look before then.
    if (d > b.speed * 60 + 2000) return false;
    const time = this.host.time();
    if (time - this._lastPredict < 0.25 && d > 400) return false;
    this._lastPredict = time;
    const p = predictDrop('nuke', b.pos, b.vel, (x, z) => Math.max(terrainHeight(x, z), obstacleTop(x, z)));
    const ax = wrap(s.x - p.point.x), az = wrap(s.z - p.point.z);
    // Along-track miss: positive while the burst still falls short of the target.
    const along = (ax * b.vel.x + az * b.vel.z) / Math.max(1, Math.hypot(b.vel.x, b.vel.z));
    if (along > 60) return false;
    if (!b.weapons || !b.host) return true;
    b.weapons.launch(b.host, 'nuke');
    this.host.notice(`${STRIKES.bomber.label}: bomb away`);
    return true;
  }
  private _lastPredict = -Infinity;

  private readonly _w = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly _t = new THREE.Vector3();

  /** One cruise missile: climb, cruise at height, dive on its aim; shot down by turret rounds. */
  private fly(s: Strike, m: CruiseMissile, dt: number, time: number): void {
    const speed = STRIKES[s.kind].speed;
    // Its aim: the point (with its spread), or the turret it took (re-chosen while far).
    const dx0 = wrap(s.x - m.pos.x), dz0 = wrap(s.z - m.pos.z);
    const far = Math.hypot(dx0, dz0);
    if (s.kind === 'barrage' && (!m.aim || m.aim.derezAt !== null) && far < 5000) m.aim = this.pick(s, m);
    const aim = this._t;
    if (m.aim) aim.set(m.aim.pos.x, m.aim.pos.y + TURRET_HEAD_Y * 0.6, m.aim.pos.z);
    else if (s.kind === 'emp') {
      // The EMP bursts over the middle of the enemy turrets there (else over the point), high
      // enough to clear the towers.
      if (far < 5000 && !m.over) m.over = this.centre(s);
      const cx = m.over?.x ?? s.x, cz = m.over?.z ?? s.z;
      aim.set(cx, Math.max(terrainHeight(cx, cz) + EMP_BURST, obstacleTop(cx, cz) + 80), cz);
    } else {
      const ax = s.x + m.off.x, az = s.z + m.off.z;
      aim.set(ax, Math.max(terrainHeight(ax, az), obstacleTop(ax, az)), az);
    }
    const ax = wrap(aim.x - m.pos.x), az = wrap(aim.z - m.pos.z);
    const h = Math.hypot(ax, az);
    const ground = Math.max(terrainHeight(m.pos.x, m.pos.z), obstacleTop(m.pos.x, m.pos.z));
    const cruiseY = ground + CRUISE_AGL;
    const want = this._w;
    if (h < Math.max(300, (m.pos.y - aim.y) * 1.1)) {
      // The dive: at the aim point, weaving so a turret's stream can't simply sit on it.
      want.set(ax, aim.y - m.pos.y, az).normalize();
      const w = Math.sin((time - m.at) * 3.1 + m.view.id) * 0.18;
      want.x += -want.z * w;
      want.z += want.x * w;
      want.y += Math.cos((time - m.at) * 2.3 + m.view.id) * 0.12 * Math.min(1, h / 200);
      want.normalize();
    } else {
      // Climb out, then hold the cruise height on the way.
      const vs = THREE.MathUtils.clamp((cruiseY - m.pos.y) / 400, -0.5, 0.7);
      want.set(ax / h, vs, az / h).normalize();
    }
    const dir = this._d.copy(m.vel).normalize();
    dir.lerp(want, Math.min(1, dt * 1.6)).normalize();
    const v = Math.min(speed, m.vel.length() + 80 * dt);
    m.vel.copy(dir).multiplyScalar(v);
    m.pos.addScaledVector(m.vel, dt);
    // Shot down: a turret round passing within KILL_RADIUS this step.
    if (this.intercept(m, dt) && --m.hp <= 0) {
      m.dead = true;
      this.intercepted++;
      this.host.impact({ kind: 'missile', point: m.pos.clone(), normal: new THREE.Vector3(0, 1, 0), vel: m.vel.clone(), mass: 60, blast: 6, color: m.view.color, collider: null, time, dud: false });
      if (s.missiles.every((x) => x.dead) && s.outcome !== 'arrived') this.host.notice(`${STRIKES[s.kind].label}: shot down`);
      s.outcome ??= 'intercepted';
      return;
    }
    // Arrival.
    const miss = Math.hypot(wrap(aim.x - m.pos.x), aim.y - m.pos.y, wrap(aim.z - m.pos.z));
    const gNow = Math.max(terrainHeight(m.pos.x, m.pos.z), obstacleTop(m.pos.x, m.pos.z));
    const arrived = s.kind === 'emp' ? h < 400 && (miss < 40 || m.pos.y < aim.y) : miss < 8 || m.pos.y <= gNow + 1;
    if (arrived) {
      m.dead = true;
      if (s.kind === 'emp') {
        this.host.emp(m.pos.x, m.pos.y, m.pos.z);
        this.host.notice(`${STRIKES.emp.label}: EMP burst over the target`);
      } else {
        this.host.impact({ kind: 'bomb', point: m.pos.clone(), normal: new THREE.Vector3(0, 1, 0), vel: m.vel.clone(), mass: 300, blast: 16, color: m.view.color, collider: null, time });
      }
      s.outcome = 'arrived';
      return;
    }
    // The view: an ordinary missile for the weapons renderer.
    const p = m.view;
    p.pos.copy(m.pos);
    p.vel.copy(m.vel);
    p.heading.copy(dir);
    p.age = time - m.at;
    this.view.projectiles.push(p);
  }

  /** The middle of the enemy turrets near the target (null: none there). */
  private centre(s: Strike): { x: number; z: number } | null {
    const team = this.host.team();
    const near = this.host.turrets.turrets.filter((t) => t.derezAt === null && hostile(team, t.side) && Math.hypot(wrap(t.pos.x - s.x), wrap(t.pos.z - s.z)) < TARGET_RADIUS);
    if (!near.length) return null;
    let x = 0, z = 0;
    for (const t of near) { x += wrap(t.pos.x - s.x); z += wrap(t.pos.z - s.z); }
    return { x: s.x + x / near.length, z: s.z + z / near.length };
  }

  /** The barrage: an enemy turret near the target that no other missile of it has taken. */
  private pick(s: Strike, m: CruiseMissile): GroundTurret | null {
    const team = this.host.team();
    // Spread the barrage: the turret fewest missiles have taken, then the nearest the target.
    const taken = new Map<GroundTurret, number>();
    for (const x of s.missiles) if (x !== m && !x.dead && x.aim) taken.set(x.aim, (taken.get(x.aim) ?? 0) + 1);
    const cands = this.host.turrets.turrets.filter((t) => t.derezAt === null && hostile(team, t.side) && Math.hypot(wrap(t.pos.x - s.x), wrap(t.pos.z - s.z)) < TARGET_RADIUS);
    if (!cands.length) return null;
    cands.sort((a, b) => (taken.get(a) ?? 0) - (taken.get(b) ?? 0) || Math.hypot(wrap(a.pos.x - s.x), wrap(a.pos.z - s.z)) - Math.hypot(wrap(b.pos.x - s.x), wrap(b.pos.z - s.z)));
    return cands[0];
  }

  /** Did an enemy turret's round pass within KILL_RADIUS of the missile in the last step? */
  private intercept(m: CruiseMissile, dt: number): boolean {
    const team = this.host.team();
    for (const t of this.host.turrets.turrets) {
      if (t.derezAt !== null || !hostile(team, t.side)) continue;
      for (const p of t.weapons.projectiles) {
        // The round's path this step against the missile's (relative motion), closest approach.
        const rx = wrap(p.pos.x - m.pos.x), ry = p.pos.y - m.pos.y, rz = wrap(p.pos.z - m.pos.z);
        const vx = (p.vel.x - m.vel.x) * dt, vy = (p.vel.y - m.vel.y) * dt, vz = (p.vel.z - m.vel.z) * dt;
        const vv = vx * vx + vy * vy + vz * vz;
        const reach = Math.sqrt(vv) + KILL_RADIUS + 1;
        if (rx * rx + ry * ry + rz * rz > reach * reach) continue;
        // Over the step just taken: from (r - v) to r.
        const k = vv > 1e-9 ? THREE.MathUtils.clamp(((rx * vx + ry * vy + rz * vz)) / vv, 0, 1) : 0;
        const cx = rx - vx * k, cy = ry - vy * k, cz = rz - vz * k;
        if (cx * cx + cy * cy + cz * cz < KILL_RADIUS * KILL_RADIUS && p.id !== m.hitBy) {
          m.hitBy = p.id;
          // Most rounds that pass close glance off its armour or miss its vitals.
          if (hashFloat(0x5717, p.id, m.view.id) > HIT_CHANCE) continue;
          p.age = 1e9; // spent on it
          return true;
        }
      }
    }
    return false;
  }
}
