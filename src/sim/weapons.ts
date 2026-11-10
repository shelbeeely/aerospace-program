import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { CraftDef, PartDef } from '../craft/types.ts';
import { TUNING } from '../tuning.ts';

/**
 * Weapons, on Rapier alone. Projectiles are integrated here each physics step and swept with a
 * ray cast (`castRayAndGetNormal`) from where they were to where they are, so a 600 m/s round
 * can't tunnel through a wall; the craft that fired is excluded from the cast. What a hit does
 * (crater the structure, derez a rider, shove a loose body, the derez flash and voxels) is the
 * simulation's job, through {@link WeaponSystem.onImpact}.
 *
 * Why no Ammo.js: everything weapons need (ray sweeps, shape queries, impulses on dynamic bodies,
 * fracturing structures into rigid blocks) is already in Rapier. Ammo.js would add a second,
 * unsynchronised physics world for no feature Rapier lacks.
 */

export type WeaponKind = 'gun' | 'cannon' | 'bomb' | 'missile';

export interface WeaponSpec {
  label: string;
  /** Muzzle speed relative to the craft (m/s); bombs fall from rest relative to it. */
  speed: number;
  /** Rounds per second while the trigger is held. */
  rate: number;
  /** Rounds per mount. */
  ammo: number;
  /** Projectile mass (kg): recoil and the shove on what it hits. */
  mass: number;
  /** Blast radius at the hit (m): craters structures, derezzes riders. */
  blast: number;
  /** Seconds before an unexploded round is dropped. */
  life: number;
  /** Missiles: thrust acceleration (m/s²) up to `maxSpeed`. */
  thrust?: number;
  maxSpeed?: number;
  /** Fraction of gravity felt (missiles fly almost straight while burning). */
  gravity: number;
  /** Trigger group: primary (guns, cannon) or secondary (bombs, missiles). */
  group: 'primary' | 'secondary';
}

export const WEAPONS: Record<WeaponKind, WeaponSpec> = {
  gun: { label: 'Gun', speed: 620, rate: 12, ammo: 600, mass: 0.05, blast: 1.6, life: 3, gravity: 1, group: 'primary' },
  cannon: { label: 'Cannon', speed: 330, rate: 0.6, ammo: 40, mass: 12, blast: 7, life: 10, gravity: 1, group: 'primary' },
  bomb: { label: 'Bombs', speed: 0, rate: 1.5, ammo: 8, mass: 250, blast: 18, life: 90, gravity: 1, group: 'secondary' },
  missile: { label: 'Missiles', speed: 30, rate: 1.2, ammo: 6, mass: 60, blast: 10, life: 14, thrust: 120, maxSpeed: 280, gravity: 0.15, group: 'secondary' },
};

/** Loadouts a vehicle can carry: which weapons, chosen in the hangar or cycled with I. */
export const LOADOUTS = {
  none: { label: 'Unarmed', kinds: [] },
  guns: { label: 'Guns', kinds: ['gun'] },
  cannon: { label: 'Cannon', kinds: ['cannon'] },
  bombs: { label: 'Guns + bombs', kinds: ['gun', 'bomb'] },
  missiles: { label: 'Guns + missiles', kinds: ['gun', 'missile'] },
  tank: { label: 'Cannon + coax gun', kinds: ['cannon', 'gun'] },
  full: { label: 'Full', kinds: ['gun', 'cannon', 'bomb', 'missile'] },
} as const satisfies Record<string, { label: string; kinds: readonly WeaponKind[] }>;
export type Loadout = keyof typeof LOADOUTS;
export const LOADOUT_ORDER = Object.keys(LOADOUTS) as Loadout[];

export interface Mount {
  kind: WeaponKind;
  /** Craft-frame muzzle position and direction (forward = -Z). */
  offset: THREE.Vector3;
  dir: THREE.Vector3;
  ammo: number;
}

export interface Projectile {
  id: number;
  kind: WeaponKind;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Missiles: the direction they burn along. */
  heading: THREE.Vector3;
  age: number;
  color: string;
}

export interface WeaponImpact {
  kind: WeaponKind;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** Projectile velocity at the hit. */
  vel: THREE.Vector3;
  mass: number;
  blast: number;
  color: string;
  /** What it struck, if a collider (null: the ground plane fallback or a timed-out round). */
  collider: RAPIER.Collider | null;
  time: number;
}

/** What the weapon system needs to know about the craft that carries it. */
export interface WeaponHost {
  world: RAPIER.World;
  body: RAPIER.RigidBody;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  linvel: THREE.Vector3;
  color: string;
  /** Ground height under a point (m): the floor for rounds that miss every collider. */
  groundAt(x: number, z: number): number;
}

type Extent = { min: THREE.Vector3; max: THREE.Vector3 };

function partExtent(p: PartDef): Extent {
  const c = new THREE.Vector3(...p.position);
  const s = p.shape;
  const h =
    s.type === 'box' ? new THREE.Vector3(s.size[0] / 2, s.size[1] / 2, s.size[2] / 2)
      : s.type === 'sphere' ? new THREE.Vector3(s.radius, s.radius, s.radius)
        : s.axis === 'x' ? new THREE.Vector3(s.length / 2, s.radius, s.radius)
          : s.axis === 'z' ? new THREE.Vector3(s.radius, s.radius, s.length / 2)
            : new THREE.Vector3(s.radius, s.length / 2, s.radius);
  if (p.rotationDeg && p.rotationDeg.some((d) => Math.abs(d) > 1)) {
    const r = Math.max(h.x, h.y, h.z); // rotated part: its bounding sphere
    h.setScalar(r);
  }
  return { min: c.clone().sub(h), max: c.clone().add(h) };
}

/** The craft's bounding box in its own frame (forward = -Z), from its collidable parts. */
export function craftBounds(def: CraftDef): Extent {
  const parts = def.parts.filter((p) => p.collider !== false || p.kind === 'cannon');
  const all = (parts.length ? parts : def.parts).map(partExtent);
  return {
    min: all.reduce((a, e) => a.min(e.min), all[0].min.clone()),
    max: all.reduce((a, e) => a.max(e.max), all[0].max.clone()),
  };
}

/**
 * Where a loadout's weapons sit on a craft, from its geometry: a cannon at the tip of a
 * 'cannon' part (else the nose), guns either side of the nose (coaxial on a turret), bombs under
 * the belly, missiles under the wings.
 */
export function mountsFor(def: CraftDef, loadout: Loadout): Mount[] {
  if (!def.parts.length) return [];
  const { min, max } = craftBounds(def);
  const midY = (min.y + max.y) / 2;
  const midZ = (min.z + max.z) / 2;
  const halfW = (max.x - min.x) / 2;
  const fwd = new THREE.Vector3(0, 0, -1);
  const barrel = def.parts.find((p) => /cannon|barrel/.test(p.kind));
  const turret = def.parts.find((p) => p.kind === 'turret');
  const out: Mount[] = [];
  for (const kind of LOADOUTS[loadout].kinds as readonly WeaponKind[]) {
    const ammo = WEAPONS[kind].ammo;
    if (kind === 'cannon') {
      const tip = barrel ? partExtent(barrel) : null;
      const at = tip
        ? new THREE.Vector3(barrel!.position[0], barrel!.position[1], tip.min.z - 0.2)
        : new THREE.Vector3(0, midY, min.z - 0.5);
      out.push({ kind, offset: at, dir: fwd.clone(), ammo });
    } else if (kind === 'gun') {
      if (turret) {
        const t = partExtent(turret);
        out.push({ kind, offset: new THREE.Vector3(t.max.x * 0.6, (t.min.y + t.max.y) / 2, t.min.z - 0.2), dir: fwd.clone(), ammo });
      } else {
        const x = Math.min(1.2, Math.max(0.25, halfW * 0.25));
        for (const s of [-1, 1]) out.push({ kind, offset: new THREE.Vector3(s * x, midY, min.z - 0.3), dir: fwd.clone(), ammo: Math.round(ammo / 2) });
      }
    } else if (kind === 'bomb') {
      out.push({ kind, offset: new THREE.Vector3(0, min.y - 0.6, midZ), dir: new THREE.Vector3(0, -1, 0), ammo });
    } else {
      const x = Math.max(0.8, halfW * 0.55);
      for (const s of [-1, 1]) out.push({ kind, offset: new THREE.Vector3(s * x, min.y - 0.3, midZ), dir: fwd.clone(), ammo: Math.round(ammo / 2) });
    }
  }
  return out;
}

const _ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _g = new THREE.Vector3();

export class WeaponSystem {
  loadout: Loadout = 'none';
  mounts: Mount[] = [];
  readonly projectiles: Projectile[] = [];
  /** Recent hits, newest last (the renderer reads them for sparks). */
  readonly impacts: WeaponImpact[] = [];
  /** Trigger state, set by the player input or a script each step. */
  trigger = { primary: false, secondary: false };
  /** Rounds fired since the last reset (tests, HUD). */
  fired = 0;
  hits = 0;
  /** Called for every hit, after the projectile is gone. */
  onImpact: ((hit: WeaponImpact) => void) | null = null;
  private nextId = 1;
  private readonly cooldown = new Map<Mount, number>();
  /** Alternates between paired mounts (left/right guns and missiles). */
  private flip = new Map<WeaponKind, number>();
  private def: CraftDef | null = null;

  /** Arm a craft: its loadout (or the default it declares) mounted where its geometry allows. */
  arm(def: CraftDef, loadout?: Loadout): void {
    this.def = def;
    const want = loadout ?? (def.loadout && def.loadout in LOADOUTS ? (def.loadout as Loadout) : 'none');
    this.loadout = want;
    this.mounts = mountsFor(def, want);
    this.cooldown.clear();
    this.flip.clear();
  }

  /** Next loadout in the list (the I key). */
  cycle(): Loadout {
    if (!this.def) return this.loadout;
    const i = LOADOUT_ORDER.indexOf(this.loadout);
    this.arm(this.def, LOADOUT_ORDER[(i + 1) % LOADOUT_ORDER.length]);
    return this.loadout;
  }

  reset(): void {
    this.projectiles.length = 0;
    this.impacts.length = 0;
    this.fired = 0;
    this.hits = 0;
    if (this.def) this.arm(this.def, this.loadout);
  }

  /** Rounds left per weapon kind (HUD). */
  ammo(): Partial<Record<WeaponKind, number>> {
    const out: Partial<Record<WeaponKind, number>> = {};
    for (const m of this.mounts) out[m.kind] = (out[m.kind] ?? 0) + m.ammo;
    return out;
  }

  /** Fire one round from every ready mount of `group` now, ignoring the trigger (scripts, tests). */
  fireOnce(host: WeaponHost, group: 'primary' | 'secondary', time: number): number {
    let n = 0;
    for (const kind of new Set(this.mounts.filter((m) => WEAPONS[m.kind].group === group).map((m) => m.kind))) {
      if (this.shoot(host, kind, time)) n++;
    }
    return n;
  }

  step(host: WeaponHost, dt: number, time: number): void {
    // Fire whatever the trigger holds, each kind at its own rate (paired mounts alternate).
    for (const kind of new Set(this.mounts.map((m) => m.kind))) {
      const spec = WEAPONS[kind];
      if (!this.trigger[spec.group]) continue;
      const ready = this.mounts.filter((m) => m.kind === kind);
      const last = Math.max(...ready.map((m) => this.cooldown.get(m) ?? -Infinity));
      if (time - last >= 1 / spec.rate) this.shoot(host, kind, time);
    }
    this.integrate(host, dt, time);
  }

  private shoot(host: WeaponHost, kind: WeaponKind, time: number): boolean {
    const mounts = this.mounts.filter((m) => m.kind === kind && m.ammo > 0);
    if (!mounts.length) return false;
    const k = (this.flip.get(kind) ?? 0) % mounts.length;
    this.flip.set(kind, k + 1);
    const m = mounts[k];
    const spec = WEAPONS[kind];
    m.ammo--;
    for (const mm of this.mounts) if (mm.kind === kind) this.cooldown.set(mm, time);
    const dir = _a.copy(m.dir).applyQuaternion(host.rotation).normalize();
    const pos = m.offset.clone().applyQuaternion(host.rotation).add(host.position);
    const vel = host.linvel.clone();
    if (kind !== 'bomb') vel.addScaledVector(dir, spec.speed);
    const heading = kind === 'bomb' ? vel.clone().normalize() : dir.clone();
    this.projectiles.push({ id: this.nextId++, kind, pos, vel, heading, age: 0, color: host.color });
    this.fired++;
    // Recoil (bombs just drop).
    if (kind !== 'bomb') {
      const j = spec.mass * spec.speed;
      host.body.applyImpulse({ x: -dir.x * j, y: -dir.y * j, z: -dir.z * j }, true);
    }
    return true;
  }

  private integrate(host: WeaponHost, dt: number, time: number): void {
    const list = this.projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      const spec = WEAPONS[p.kind];
      p.age += dt;
      // Ballistics: gravity (missiles barely feel it while burning), thrust, light drag on bombs.
      _g.set(0, -TUNING.gravity * spec.gravity, 0);
      if (p.kind === 'missile' && spec.thrust && spec.maxSpeed) {
        const along = p.vel.dot(p.heading);
        if (along < spec.maxSpeed) _g.addScaledVector(p.heading, spec.thrust);
      }
      if (p.kind === 'bomb') _g.addScaledVector(p.vel, -0.00005 * p.vel.length());
      _a.copy(p.pos);
      p.vel.addScaledVector(_g, dt);
      _b.copy(p.pos).addScaledVector(p.vel, dt);
      // Bombs fall nose first.
      if (p.kind === 'bomb' && p.vel.lengthSq() > 1) p.heading.copy(p.vel).normalize();
      // Sweep the segment just flown.
      const seg = _b.clone().sub(_a);
      const len = seg.length();
      let hit: WeaponImpact | null = null;
      if (len > 1e-6) {
        _ray.origin = { x: _a.x, y: _a.y, z: _a.z };
        _ray.dir = { x: seg.x / len, y: seg.y / len, z: seg.z / len };
        const h = host.world.castRayAndGetNormal(_ray, len, true, undefined, undefined, undefined, host.body);
        if (h) {
          const pt = _a.clone().addScaledVector(seg, h.timeOfImpact / len);
          hit = this.impact(p, pt, new THREE.Vector3(h.normal.x, h.normal.y, h.normal.z), h.collider, time);
        }
      }
      if (!hit) {
        const floor = host.groundAt(_b.x, _b.z);
        if (_b.y <= floor) hit = this.impact(p, new THREE.Vector3(_b.x, floor, _b.z), new THREE.Vector3(0, 1, 0), null, time);
        else if (p.age > spec.life) {
          // Timed out: guns just vanish, everything else detonates where it is.
          if (p.kind !== 'gun') hit = this.impact(p, _b.clone(), new THREE.Vector3(0, 1, 0), null, time);
          else {
            list.splice(i, 1);
            continue;
          }
        }
      }
      if (hit) {
        list.splice(i, 1);
        this.hits++;
        this.impacts.push(hit);
        if (this.impacts.length > 64) this.impacts.splice(0, this.impacts.length - 64);
        this.onImpact?.(hit);
      } else p.pos.copy(_b);
    }
  }

  private impact(p: Projectile, point: THREE.Vector3, normal: THREE.Vector3, collider: RAPIER.Collider | null, time: number): WeaponImpact {
    const spec = WEAPONS[p.kind];
    return { kind: p.kind, point, normal, vel: p.vel.clone(), mass: spec.mass, blast: spec.blast, color: p.color, collider, time };
  }
}
