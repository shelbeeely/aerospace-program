import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { districtPlan } from '../arch/DistrictGenerator.ts';
import { GRID } from '../arch/grid.ts';
import { hash32, hashFloat, strSeed } from '../arch/rng.ts';

import { RAIL_TURRET, TOWER_TURRET } from '../craft/towerTurret.ts';
import { anglesOf, applyTurret, leadAim, slewTurret, turretOf, type TurretLimits, type TurretPose } from '../craft/turret.ts';
import { obstacleTop } from '../world/structures.ts';
import { chunkAt, imageOffset } from '../world/planetCity.ts';
import { landingSites } from '../world/landingSites.ts';
import { PLANET } from './layout.ts';
import type { LockTarget } from './lock.ts';
import type { Foe } from './aiTraffic.ts';
import { hostile, sideLight, sideLivery, type Side, type Team } from './teams.ts';
import { Territory } from './territory.ts';
import type { CraftDef } from '../craft/types.ts';
import { terrainHeight } from './terrain.ts';
import { WeaponSystem, type WeaponHost, type WeaponImpact } from './weapons.ts';

/**
 * Tower turrets: emplacements on the flat roofs of tall towers, held by whichever team holds
 * the district (sim/territory.ts) and worn in its colours. Where they stand is a pure function
 * of the world seed and the district (the same towers always carry them); the ones near the
 * player are live: a kinematic collider to shoot at, a traversing, elevating head, guns and
 * homing missiles of their own. A turret tracks the nearest enemy it can see within 2.5 km (an
 * aircraft of a side its team fights, another player, the player's craft) and fires on it, but
 * never on an unarmed player. Shot down (or when its tower fractures) it stays down; when the
 * last turret of a district falls to a team, the district changes hands and its turrets rise
 * again in the new colours 20 s later. A world reset restores everything.
 */

/** 0 = off, 1 = sparse (about one in most districts), 2 = dense (up to three per district). */
export type TurretDensity = 0 | 1 | 2;

export interface TurretSite {
  /** Stable id: the structure it stands on. */
  id: string;
  structureId: string;
  /** The district (canonical chunk indices). */
  ci: number;
  cj: number;
  /** A gun-and-missile turret, or a railgun turret. */
  kind: TurretKind;
  /** Canonical roof centre (m) it stands on. */
  x: number;
  y: number;
  z: number;
}

export type TurretState = 'idle' | 'tracking' | 'charging' | 'firing';
export type TurretKind = 'gun' | 'rail';

export interface GroundTurret {
  id: number;
  site: TurretSite;
  /** Base position (the roof under it), in the planet image nearest the player. */
  pos: THREE.Vector3;
  pose: TurretPose;
  hp: number;
  maxHp: number;
  hitAt: number;
  state: TurretState;
  derezAt: number | null;
  aimError: { h: number; p: number };
  missileAt: number;
  /** Railgun: when the current charge began (s), or null when not charging. */
  chargeAt: number | null;
  /** Line of sight to the player, re-checked a few times a second. */
  sees: boolean;
  seenAt: number;
  weapons: WeaponSystem;
  host: WeaponHost;
  body: RAPIER.RigidBody;
  color: string;
  /** The team that holds it (its district's owner when it was raised). */
  side: Team;
  /** What it is shooting at (re-chosen a few times a second). */
  target: Foe | null;
  /** It, as a lock target and as a foe to others. */
  handle: LockTarget;
  foe: Foe;
  /** An EMP has knocked it out until then (s): dark, it holds fire. */
  disabledUntil: number;
}


const DEG = Math.PI / 180;
/** Faster than a tank's, and they elevate nearly straight up (aircraft pass overhead). */
export const TOWER_LIMITS: TurretLimits = { yawRate: 90 * DEG, pitchRate: 60 * DEG, pitchMin: -10 * DEG, pitchMax: 85 * DEG };
const RANGE = 2500, GUN_RANGE = 1800, GUN_SPEED = 620;
const MISSILE_MIN = 600, MISSILE_EVERY = 10;
const HP = 10;
/** Railgun turrets: reach, the charge before each shot (s), and hit points (sturdier). */
export const RAIL_RANGE = 3500, RAIL_CHARGE = 0.8;
const RAIL_HP = 14;
/** Turrets are live for sites within this distance of the player (m), dropped past the second. */
const LIVE = 5000, DROP = 5600;
const SEED = 0x7e77e7;

/** A turret in a team's colours (red gun turret: the default, used by the checks), and the rigs. */
const defs = new Map<string, CraftDef>();
export const turretDef = (side: Side, kind: TurretKind = 'gun'): CraftDef => {
  const k = `${side}:${kind}`;
  let d = defs.get(k);
  if (!d) defs.set(k, (d = sideLivery(kind === 'rail' ? RAIL_TURRET : TOWER_TURRET, side)));
  return d;
};
export const TURRET_DEF = turretDef(1);
const RIGS = { gun: turretOf(TURRET_DEF)!, rail: turretOf(turretDef(1, 'rail'))! };
/** Where the head's centre is above the base (m): the aim origin, and what the lock points at. */
export const TURRET_HEAD_Y = 3;

/** Shortest signed distance from a to b along one wrapped axis (m). */
function wrapDelta(a: number, b: number): number {
  const C = PLANET.circumference;
  const d = b - a;
  return d - C * Math.round(d / C);
}

const siteCache = new Map<string, TurretSite[]>();

/**
 * The turret sites of district (ci, cj): towers with a flat roof 35-320 m up and at least 5 m
 * across, away from rooftop helipads, picked by a hash of their id. Sparse: one in about 60% of
 * districts; dense: up to three.
 */
export function turretSites(ci: number, cj: number, density: TurretDensity): TurretSite[] {
  if (density === 0) return [];
  const n = GRID.chunks;
  ci = ((ci % n) + n) % n;
  cj = ((cj % n) + n) % n;
  const key = `${ci},${cj},${density}`;
  const hit = siteCache.get(key);
  if (hit) return hit;
  const pads = landingSites().filter((s) => s.kind === 'helipad' && s.y > 0);
  const out: TurretSite[] = [];
  const want = density === 2 ? 3 : hashFloat(SEED, ci, cj) < 0.6 ? 1 : 0;
  if (want > 0) {
    const plan = districtPlan(ci, cj);
    const candidates = plan.structures
      .filter((s) => s.roof && s.roof.y >= 35 && s.roof.y <= 320 && s.roof.r >= 2.5)
      .filter((s) => !pads.some((p) => Math.hypot(wrapDelta(p.x, s.roof!.x), wrapDelta(p.z, s.roof!.z)) < 40))
      .sort((a, b) => hash32(SEED, strSeed(a.id)) - hash32(SEED, strSeed(b.id)));
    for (const s of candidates.slice(0, want)) {
      // About one in four is a railgun turret; one in two on the tallest towers.
      const rail = hashFloat(SEED, strSeed(s.id), 7) < (s.roof!.y >= 120 ? 0.5 : 0.25);
      out.push({ id: s.id, structureId: s.id, ci, cj, kind: rail ? 'rail' : 'gun', x: s.roof!.x, y: s.roof!.y, z: s.roof!.z });
    }
  }
  siteCache.set(key, out);
  if (siteCache.size > 400) siteCache.delete(siteCache.keys().next().value!);
  return out;
}

/** Deterministic PRNG (mulberry32) for the turrets' aim wander. */
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

/**
 * Can a point see another? Sampled every 30 m along the line against the terrain and the
 * structures' height map (far colliders aren't streamed, so no ray cast); the first and last
 * few metres are skipped (the turret's own roof, the target's own street).
 */
export function lineOfSight(a: THREE.Vector3, b: THREE.Vector3): boolean {
  const dx = wrapDelta(a.x, b.x), dz = wrapDelta(a.z, b.z), dy = b.y - a.y;
  const len = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(len / 30));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (t * len < 25 || (1 - t) * len < 15) continue;
    const x = a.x + dx * t, z = a.z + dz * t, y = a.y + dy * t;
    if (y < Math.max(terrainHeight(x, z), obstacleTop(x, z)) - 1) return false;
  }
  return true;
}

export class GroundTurretSystem {
  readonly turrets: GroundTurret[] = [];
  density: TurretDensity = 0;
  /** Sites shot down (or whose tower fell): they stay down until clear(). */
  readonly destroyed = new Set<string>();
  /** Turrets derezzed so far (tests, stats). */
  derezzed = 0;
  /** A turret's round struck something (the simulation applies the damage). */
  onImpact: ((hit: WeaponImpact, shooter: GroundTurret) => void) | null = null;
  /** Ground height for rounds that miss every collider. */
  groundAt: (x: number, z: number) => number = terrainHeight;
  /** Has the structure under a site fractured? (the simulation answers) */
  fractured: (structureId: string) => boolean = () => false;
  /** A turret whose tower fell (the simulation shows the derez). */
  onTowerFell: ((t: GroundTurret) => void) | null = null;
  /** Who holds each district. */
  readonly territory = new Territory();
  /** A district changed hands: its last turret fell to `team`. */
  onCapture: ((ci: number, cj: number, team: Team, from: Team) => void) | null = null;
  /** Districts whose turrets are being raised again after a capture: until when. */
  private readonly rebuilding = new Map<string, number>();
  private readonly random: () => number;
  private readonly byHandle = new Map<number, GroundTurret>();
  private nextId = 1;
  private streamAt = -Infinity;
  private streamKey = '';
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();
  private readonly _rel = new THREE.Vector3();
  private readonly _aim = new THREE.Vector3();

  constructor(private readonly world: RAPIER.World, seed = 1982) {
    this.random = rng((seed ^ SEED) >>> 0);
  }

  /** The turret whose collider this is, if any. */
  byCollider(handle: number): GroundTurret | undefined {
    return this.byHandle.get(handle);
  }

  live(): GroundTurret[] {
    return this.turrets.filter((t) => t.derezAt === null);
  }

  /** World reset: every turret comes back (they re-stream around the player). */
  clear(): void {
    for (const t of this.turrets) this.drop(t);
    this.turrets.length = 0;
    this.destroyed.clear();
    this.rebuilding.clear();
    this.territory.reset();
    this.streamKey = '';
    this.streamAt = -Infinity;
  }

  /** A round hits a turret for `amount` hit points; true when that finishes it. */
  damage(t: GroundTurret, amount: number, time: number): boolean {
    if (t.derezAt !== null) return false;
    t.hp -= amount;
    t.hitAt = time;
    return t.hp <= 0;
  }

  /**
   * Destroy a turret: its rounds in flight go with it, and its site stays empty. `by`: the side
   * whose fire did it. When that was the district's last turret and `by` is another team, the
   * district is theirs: its turrets are raised again in their colours 20 s later.
   */
  derez(t: GroundTurret, time: number, by: Side | null = null): void {
    if (t.derezAt !== null) return;
    t.derezAt = time;
    this.derezzed++;
    this.destroyed.add(t.site.id);
    t.weapons.projectiles.length = 0;
    t.weapons.trigger.primary = t.weapons.trigger.secondary = false;
    this.drop(t);
    const { ci, cj } = t.site;
    if (by === null || by > 2 || by === t.side) return;
    const sites = turretSites(ci, cj, this.density);
    if (!sites.every((s) => this.destroyed.has(s.id))) return;
    if (!this.territory.capture(ci, cj, by as Team)) return;
    for (const s of sites) this.destroyed.delete(s.id);
    this.rebuilding.set(`${ci},${cj}`, time + 20);
    this.streamKey = '';
    this.onCapture?.(ci, cj, by as Team, t.side);
  }

  private drop(t: GroundTurret): void {
    if (this.world.getRigidBody(t.body.handle) !== t.body) return;
    for (let i = 0; i < t.body.numColliders(); i++) this.byHandle.delete(t.body.collider(i).handle);
    this.world.removeRigidBody(t.body);
  }

  /** Every turret's weapon system (rounds in flight, for the renderer). */
  weaponSystems(): WeaponSystem[] {
    return this.turrets.filter((t) => t.derezAt === null).map((t) => t.weapons);
  }

  /** Turret missiles in flight still homing on `target`. */
  incoming(target: LockTarget): number {
    let n = 0;
    for (const t of this.turrets) for (const p of t.weapons.projectiles) if (p.target === target) n++;
    return n;
  }

  /** Fly the turrets' rounds and fire what their triggers hold (after the physics step). */
  stepWeapons(dt: number, time: number): void {
    for (const t of this.turrets) if (t.derezAt === null) t.weapons.step(t.host, dt, time);
  }

  private spawn(site: TurretSite, player: THREE.Vector3, time: number): void {
    const side = this.territory.ownerOf(site.ci, site.cj);
    if (side === null) return;
    const until = this.rebuilding.get(`${site.ci},${site.cj}`);
    if (until !== undefined && time < until) return;
    const x = site.x + imageOffset(site.x, player.x), z = site.z + imageOffset(site.z, player.z);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, site.y, z));
    // One box round the pedestal and head (good enough to shoot at or fly into).
    const col = this.world.createCollider(RAPIER.ColliderDesc.cuboid(1.5, 1.8, 1.6).setTranslation(0, 1.8, -0.2), body);
    const pos = new THREE.Vector3(x, site.y, z);
    const weapons = new WeaponSystem();
    const color = sideLight(side);
    weapons.arm(turretDef(side, site.kind));
    const rig = RIGS[site.kind];
    const hp = site.kind === 'rail' ? RAIL_HP : HP;
    weapons.turnScale = 25 / 45; // its missiles turn like the hostile aircraft's: a hard turn can shake one
    const pose: TurretPose = { yaw: hashFloat(SEED, strSeed(site.id), 1) * Math.PI * 2 - Math.PI, pitch: 0 };
    const self = this;
    const t: GroundTurret = {
      id: this.nextId++, site, pos, pose, hp, maxHp: hp, hitAt: -Infinity, state: 'idle', derezAt: null,
      aimError: { h: 0, p: 0 }, missileAt: -Infinity, chargeAt: null, sees: false, seenAt: -Infinity, weapons, body, color, side, target: null,
      handle: null as unknown as LockTarget, foe: null as unknown as Foe, disabledUntil: -Infinity,
      host: {
        world: this.world, body, position: pos, rotation: new THREE.Quaternion(), linvel: new THREE.Vector3(), color,
        groundAt: (gx, gz) => self.groundAt(gx, gz),
        mountPose: (_m, offset, dir) => applyTurret(rig, pose, true, offset, dir),
      },
    };
    weapons.onImpact = (h) => this.onImpact?.(h, t);
    const sys = this;
    t.handle = {
      id: `turret:${site.id}`, kind: 'turret', name: site.kind === 'rail' ? 'Railgun turret' : 'Tower turret', radius: 2.5,
      alive: () => t.derezAt === null && sys.turrets.includes(t),
      position: (o) => o.set(t.pos.x, t.pos.y + TURRET_HEAD_Y, t.pos.z),
      velocity: (o) => o.set(0, 0, 0),
    };
    t.foe = { side, lock: t.handle, kind: 'turret', engage: true, ground: true };
    this.byHandle.set(col.handle, t);
    this.turrets.push(t);
  }

  /** Keep the turrets near the player live (re-checked once a second, or on a new district). */
  /**
   * Other places that must be live besides the player (strike targets, order points, strikes in
   * flight): turrets stream in round each of them too, so an attack far away plays out for real.
   */
  focus: Array<{ x: number; z: number }> = [];

  /** Distance (m) from a point to the nearest place that is live (the player or a focus point). */
  private nearestLive(x: number, z: number, player: THREE.Vector3): number {
    let d = Math.hypot(wrapDelta(player.x, x), wrapDelta(player.z, z));
    for (const f of this.focus) d = Math.min(d, Math.hypot(wrapDelta(f.x, x), wrapDelta(f.z, z)));
    return d;
  }

  private stream(time: number, player: THREE.Vector3): void {
    const centres = [player, ...this.focus].map((p) => chunkAt(p.x, p.z));
    const key = `${centres.map(([a, b]) => `${a},${b}`).join(';')}|${this.density}`;
    if (key === this.streamKey && time - this.streamAt < 1) return;
    this.streamKey = key;
    this.streamAt = time;
    const sites = new Set<string>();
    const seen = new Set<string>();
    const reach = Math.ceil(DROP / GRID.chunkSize) + 1;
    for (const [ci, cj] of centres) for (let di = -reach; di <= reach; di++) for (let dj = -reach; dj <= reach; dj++) {
      const ck = `${ci + di},${cj + dj}`;
      if (seen.has(ck)) continue;
      seen.add(ck);
      for (const s of turretSites(ci + di, cj + dj, this.density)) {
        sites.add(s.id);
        if (this.nearestLive(s.x, s.z, player) > LIVE) continue;
        if (this.destroyed.has(s.id) || this.turrets.some((t) => t.site.id === s.id)) continue;
        this.spawn(s, player, time);
      }
    }
    // Drop the derezzed (after a moment), the far, the ones the density no longer wants, and
    // any left on the other side of the planet's seam (they re-stream where the player is).
    const C = PLANET.circumference;
    for (let i = this.turrets.length - 1; i >= 0; i--) {
      const t = this.turrets[i];
      const gone = t.derezAt !== null
        ? time - t.derezAt > 2
        : !sites.has(t.site.id) || this.nearestLive(t.pos.x, t.pos.z, player) > DROP
          || Math.abs(t.pos.x - player.x) > C / 2 || Math.abs(t.pos.z - player.z) > C / 2;
      if (!gone) continue;
      if (t.derezAt === null) this.drop(t);
      this.turrets.splice(i, 1);
    }
  }

  step(dt: number, time: number, player: THREE.Vector3, foes: Foe[]): void {
    // A district being raised again re-streams when its time comes.
    for (const [k, until] of this.rebuilding) if (time >= until) { this.rebuilding.delete(k); this.streamKey = ''; }
    this.stream(time, player);
    for (const t of this.turrets) {
      if (t.derezAt !== null) continue;
      if (this.fractured(t.site.structureId)) {
        this.onTowerFell?.(t);
        this.derez(t, time);
        continue;
      }
      this.aim(t, dt, time, foes);
    }
  }

  private readonly _tv = new THREE.Vector3();

  /**
   * Choose a target a few times a second: the nearest enemy (a side its team fights, not a
   * turret) within range that it can see. An unarmed player can be watched, not fired on.
   */
  private choose(t: GroundTurret, head: THREE.Vector3, foes: Foe[]): void {
    const near: Array<{ f: Foe; d: number }> = [];
    for (const f of foes) {
      if (f.kind === 'turret' || !hostile(t.side, f.side) || !f.lock.alive()) continue;
      f.lock.position(this._b);
      const d = Math.hypot(wrapDelta(head.x, this._b.x), this._b.y - head.y, wrapDelta(head.z, this._b.z));
      if (d < (t.site.kind === 'rail' ? RAIL_RANGE : RANGE)) near.push({ f, d });
    }
    near.sort((a, b) => a.d - b.d);
    t.target = null;
    for (const { f } of near.slice(0, 3)) {
      f.lock.position(this._b);
      this._b.set(head.x + wrapDelta(head.x, this._b.x), this._b.y, head.z + wrapDelta(head.z, this._b.z));
      if (lineOfSight(head, this._b)) { t.target = f; break; }
    }
  }

  /** An EMP: dark and silent until `until`. */
  disable(t: GroundTurret, until: number): void {
    t.disabledUntil = Math.max(t.disabledUntil, until);
    t.target = null;
    t.weapons.trigger.primary = t.weapons.trigger.secondary = false;
  }

  /** One turret's fire control. */
  private aim(t: GroundTurret, dt: number, time: number, foes: Foe[]): void {
    const w = t.weapons;
    w.trigger.primary = w.trigger.secondary = false;
    w.lock = null;
    if (time < t.disabledUntil) {
      t.state = 'idle';
      t.target = null;
      t.sees = false;
      t.chargeAt = null;
      return;
    }
    const head = this._a.set(t.pos.x, t.pos.y + TURRET_HEAD_Y, t.pos.z);
    if (time - t.seenAt > 0.25) {
      t.seenAt = time;
      this.choose(t, head, foes);
    }
    const target = t.target && t.target.lock.alive() ? t.target : null;
    t.sees = !!target;
    if (!target) {
      // Nothing to shoot at: a slow sweep, the barrels settling level.
      t.state = 'idle';
      t.chargeAt = null;
      slewTurret(t.pose, t.pose.yaw + 0.3, 0.05, dt, { ...TOWER_LIMITS, yawRate: 6 * DEG });
      return;
    }
    // The aim wanders (a slow random walk pulled back to zero): about half a degree.
    // Against the player as before; against AI aircraft looser (or they'd sweep the sky clean).
    const pull = Math.min(1, dt / 2), kick = (target.kind === 'player' ? 0.008 : target.kind === 'missile' ? 0.05 : 0.024) * Math.sqrt(dt);
    t.aimError.h += -t.aimError.h * pull + (this.random() * 2 - 1) * kick;
    t.aimError.p += -t.aimError.p * pull + (this.random() * 2 - 1) * kick;
    const tp = target.lock.position(this._b);
    const rel = this._rel.set(wrapDelta(head.x, tp.x), tp.y - head.y, wrapDelta(head.z, tp.z));
    const range = rel.length();
    if (t.site.kind === 'rail') return this.rail(t, dt, time, target, rel, range);
    const aim = anglesOf(leadAim(rel, target.lock.velocity(this._tv), GUN_SPEED, 9.81, this._aim));
    slewTurret(t.pose, aim.yaw + t.aimError.h, aim.pitch + t.aimError.p, dt, TOWER_LIMITS);
    let dy = aim.yaw - t.pose.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const off = Math.hypot(dy, aim.pitch - t.pose.pitch);
    t.state = 'tracking';
    if (!target.engage) return; // it watches an unarmed craft, but holds its fire
    if (off < Math.max(0.006, 4 / range) && range < (target.kind === 'player' ? GUN_RANGE : 1200)) {
      w.trigger.primary = true;
      t.state = 'firing';
    }
    if (target.kind !== 'missile' && off < 0.05 && range > MISSILE_MIN && time - t.missileAt > MISSILE_EVERY) {
      w.trigger.secondary = true;
      w.lock = target.lock;
      t.missileAt = time;
      t.state = 'firing';
    }
  }

  /**
   * A railgun turret's fire control: the slug is instant, so it aims straight at the target
   * (no lead); once the barrel is on, it charges for RAIL_CHARGE seconds (its lights come up)
   * and fires if it is still on, one shot every 2.5 s (the weapon's own rate).
   */
  private rail(t: GroundTurret, dt: number, time: number, target: Foe, rel: THREE.Vector3, range: number): void {
    const w = t.weapons;
    const aim = anglesOf(rel);
    slewTurret(t.pose, aim.yaw + t.aimError.h * 0.5, aim.pitch + t.aimError.p * 0.5, dt, { ...TOWER_LIMITS, yawRate: 45 * DEG, pitchRate: 35 * DEG });
    let dy = aim.yaw - t.pose.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const off = Math.hypot(dy, aim.pitch - t.pose.pitch);
    t.state = 'tracking';
    // Against AI aircraft it holds fire beyond 2 km (they could never close otherwise).
    if (!target.engage || range > (target.kind === 'player' || target.kind === 'remote' ? RAIL_RANGE : 2000)) { t.chargeAt = null; return; }
    const tol = Math.max(0.003, 5 / range);
    const ready = time - (w.mounts[0]?.lastFired ?? -Infinity) >= 1 / 0.4;
    if (t.chargeAt === null) {
      if (off < tol * 2 && ready) t.chargeAt = time;
      return;
    }
    t.state = 'charging';
    if (time - t.chargeAt < RAIL_CHARGE) return;
    t.chargeAt = null;
    if (off < tol) {
      w.trigger.primary = true;
      t.state = 'firing';
    }
  }

  /** Railgun turrets charging at this target now (the HUD's RAIL warning). */
  charging(target: LockTarget): number {
    let n = 0;
    for (const t of this.turrets) if (t.derezAt === null && t.state === 'charging' && t.target?.lock === target) n++;
    return n;
  }
}
