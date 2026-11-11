import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { districtPlan } from '../arch/DistrictGenerator.ts';
import { GRID } from '../arch/grid.ts';
import { hash32, hashFloat, strSeed } from '../arch/rng.ts';
import { redTeam } from '../craft/style1982.ts';
import { TOWER_TURRET } from '../craft/towerTurret.ts';
import { anglesOf, applyTurret, leadAim, slewTurret, turretOf, type TurretLimits, type TurretPose } from '../craft/turret.ts';
import { obstacleTop } from '../world/structures.ts';
import { chunkAt, imageOffset } from '../world/planetCity.ts';
import { landingSites } from '../world/landingSites.ts';
import { PLANET } from './layout.ts';
import type { LockTarget } from './lock.ts';
import { terrainHeight } from './terrain.ts';
import { WeaponSystem, type WeaponHost, type WeaponImpact } from './weapons.ts';

/**
 * Tower turrets: hostile emplacements on the flat roofs of tall towers. Where they stand is a
 * pure function of the world seed and the district (the same towers always carry them); the
 * ones near the player are live: a kinematic collider to shoot at, a traversing, elevating head,
 * guns and homing missiles of their own. A turret tracks the player's craft whenever it can see
 * it (within 2.5 km, nothing in the way), but opens fire only on an armed craft. Shot down (or
 * when its tower fractures) it stays down until the world is reset.
 */

/** 0 = off, 1 = sparse (about one in most districts), 2 = dense (up to three per district). */
export type TurretDensity = 0 | 1 | 2;

export interface TurretSite {
  /** Stable id: the structure it stands on. */
  id: string;
  structureId: string;
  /** Canonical roof centre (m) it stands on. */
  x: number;
  y: number;
  z: number;
}

export type TurretState = 'idle' | 'tracking' | 'firing';

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
  /** Line of sight to the player, re-checked a few times a second. */
  sees: boolean;
  seenAt: number;
  weapons: WeaponSystem;
  host: WeaponHost;
  body: RAPIER.RigidBody;
  color: string;
}

/** What the turrets aim at: the player's craft. */
export interface TurretTarget {
  vel: THREE.Vector3;
  alive: boolean;
  armed: boolean;
  lock?: LockTarget;
}

const DEG = Math.PI / 180;
/** Faster than a tank's, and they elevate nearly straight up (aircraft pass overhead). */
export const TOWER_LIMITS: TurretLimits = { yawRate: 90 * DEG, pitchRate: 60 * DEG, pitchMin: -10 * DEG, pitchMax: 85 * DEG };
const RANGE = 2500, GUN_RANGE = 1800, GUN_SPEED = 620;
const MISSILE_MIN = 600, MISSILE_EVERY = 10;
const HP = 10;
/** Turrets are live for sites within this distance of the player (m), dropped past the second. */
const LIVE = 5000, DROP = 5600;
const SEED = 0x7e77e7;

/** The turret, in red-team colours, and its rig. */
export const TURRET_DEF = redTeam(TOWER_TURRET);
const RIG = turretOf(TURRET_DEF)!;
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
    for (const s of candidates.slice(0, want)) out.push({ id: s.id, structureId: s.id, x: s.roof!.x, y: s.roof!.y, z: s.roof!.z });
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

  /** Destroy a turret: its rounds in flight go with it, and its site stays empty. */
  derez(t: GroundTurret, time: number): void {
    if (t.derezAt !== null) return;
    t.derezAt = time;
    this.derezzed++;
    this.destroyed.add(t.site.id);
    t.weapons.projectiles.length = 0;
    t.weapons.trigger.primary = t.weapons.trigger.secondary = false;
    this.drop(t);
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

  private spawn(site: TurretSite, player: THREE.Vector3): void {
    const x = site.x + imageOffset(site.x, player.x), z = site.z + imageOffset(site.z, player.z);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, site.y, z));
    // One box round the pedestal and head (good enough to shoot at or fly into).
    const col = this.world.createCollider(RAPIER.ColliderDesc.cuboid(1.5, 1.8, 1.6).setTranslation(0, 1.8, -0.2), body);
    const pos = new THREE.Vector3(x, site.y, z);
    const weapons = new WeaponSystem();
    weapons.arm(TURRET_DEF);
    weapons.turnScale = 25 / 45; // its missiles turn like the hostile aircraft's: a hard turn can shake one
    const pose: TurretPose = { yaw: hashFloat(SEED, strSeed(site.id), 1) * Math.PI * 2 - Math.PI, pitch: 0 };
    const self = this;
    const t: GroundTurret = {
      id: this.nextId++, site, pos, pose, hp: HP, maxHp: HP, hitAt: -Infinity, state: 'idle', derezAt: null,
      aimError: { h: 0, p: 0 }, missileAt: -Infinity, sees: false, seenAt: -Infinity, weapons, body, color: '#ff2a12',
      host: {
        world: this.world, body, position: pos, rotation: new THREE.Quaternion(), linvel: new THREE.Vector3(), color: '#ff2a12',
        groundAt: (gx, gz) => self.groundAt(gx, gz),
        mountPose: (_m, offset, dir) => applyTurret(RIG, pose, true, offset, dir),
      },
    };
    weapons.onImpact = (h) => this.onImpact?.(h, t);
    this.byHandle.set(col.handle, t);
    this.turrets.push(t);
  }

  /** Keep the turrets near the player live (re-checked once a second, or on a new district). */
  private stream(time: number, player: THREE.Vector3): void {
    const [ci, cj] = chunkAt(player.x, player.z);
    const key = `${ci},${cj},${this.density}`;
    if (key === this.streamKey && time - this.streamAt < 1) return;
    this.streamKey = key;
    this.streamAt = time;
    const sites = new Set<string>();
    const reach = Math.ceil(DROP / GRID.chunkSize) + 1;
    for (let di = -reach; di <= reach; di++) for (let dj = -reach; dj <= reach; dj++) {
      for (const s of turretSites(ci + di, cj + dj, this.density)) {
        sites.add(s.id);
        if (Math.hypot(wrapDelta(player.x, s.x), wrapDelta(player.z, s.z)) > LIVE) continue;
        if (this.destroyed.has(s.id) || this.turrets.some((t) => t.site.id === s.id)) continue;
        this.spawn(s, player);
      }
    }
    // Drop the derezzed (after a moment), the far, the ones the density no longer wants, and
    // any left on the other side of the planet's seam (they re-stream where the player is).
    const C = PLANET.circumference;
    for (let i = this.turrets.length - 1; i >= 0; i--) {
      const t = this.turrets[i];
      const gone = t.derezAt !== null
        ? time - t.derezAt > 2
        : !sites.has(t.site.id) || Math.hypot(wrapDelta(player.x, t.pos.x), wrapDelta(player.z, t.pos.z)) > DROP
          || Math.abs(t.pos.x - player.x) > C / 2 || Math.abs(t.pos.z - player.z) > C / 2;
      if (!gone) continue;
      if (t.derezAt === null) this.drop(t);
      this.turrets.splice(i, 1);
    }
  }

  step(dt: number, time: number, player: THREE.Vector3, target: TurretTarget): void {
    this.stream(time, player);
    for (const t of this.turrets) {
      if (t.derezAt !== null) continue;
      if (this.fractured(t.site.structureId)) {
        this.onTowerFell?.(t);
        this.derez(t, time);
        continue;
      }
      this.aim(t, dt, time, player, target);
    }
  }

  /** One turret's fire control. */
  private aim(t: GroundTurret, dt: number, time: number, player: THREE.Vector3, target: TurretTarget): void {
    const w = t.weapons;
    w.trigger.primary = w.trigger.secondary = false;
    w.lock = null;
    const head = this._a.set(t.pos.x, t.pos.y + TURRET_HEAD_Y, t.pos.z);
    const rel = this._rel.set(wrapDelta(head.x, player.x), player.y - head.y, wrapDelta(head.z, player.z));
    const range = rel.length();
    if (target.alive && range < RANGE) {
      if (time - t.seenAt > 0.25) {
        t.seenAt = time;
        t.sees = lineOfSight(head, this._b.copy(head).add(rel));
      }
    } else t.sees = false;
    if (!t.sees) {
      // Nothing to shoot at: a slow sweep, the barrels settling level.
      t.state = 'idle';
      slewTurret(t.pose, t.pose.yaw + 0.3, 0.05, dt, { ...TOWER_LIMITS, yawRate: 6 * DEG });
      return;
    }
    // The aim wanders (a slow random walk pulled back to zero): about half a degree.
    const pull = Math.min(1, dt / 2), kick = 0.008 * Math.sqrt(dt);
    t.aimError.h += -t.aimError.h * pull + (this.random() * 2 - 1) * kick;
    t.aimError.p += -t.aimError.p * pull + (this.random() * 2 - 1) * kick;
    const aim = anglesOf(leadAim(rel, target.vel, GUN_SPEED, 9.81, this._aim));
    slewTurret(t.pose, aim.yaw + t.aimError.h, aim.pitch + t.aimError.p, dt, TOWER_LIMITS);
    let dy = aim.yaw - t.pose.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const off = Math.hypot(dy, aim.pitch - t.pose.pitch);
    t.state = 'tracking';
    if (!target.armed) return; // it watches an unarmed craft, but holds its fire
    if (off < Math.max(0.006, 4 / range) && range < GUN_RANGE) {
      w.trigger.primary = true;
      t.state = 'firing';
    }
    if (off < 0.05 && range > MISSILE_MIN && time - t.missileAt > MISSILE_EVERY) {
      w.trigger.secondary = true;
      w.lock = target.lock ?? null;
      t.missileAt = time;
      t.state = 'firing';
    }
  }
}
