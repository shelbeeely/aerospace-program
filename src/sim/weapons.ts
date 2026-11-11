import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { relativePosition, type LockTarget } from './lock.ts';
import type { CraftDef, PartDef, WeaponModuleDef } from '../craft/types.ts';
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

/** Every weapon: those a craft can fit, and the strategic ones (bought with credits, never fitted). */
export type WeaponKind = WeaponModuleDef['kind'] | StrategicKind;
export type StrategicKind = 'nuke' | 'emp';

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
  /**
   * Homing (missiles fired with a lock): the most it turns (rad/s), the seeker's half-angle
   * (rad: a target outside it is lost and the missile flies on straight), and the proximity
   * fuse (m beyond the target's radius).
   */
  turn?: number;
  seeker?: number;
  fuse?: number;
  /** Railgun: how many things one shot punches through before it stops. */
  pierce?: number;
  /** Strategic weapons: seconds after launch before the warhead is live (an earlier impact is a dud). */
  armTime?: number;
  /** A retarding chute: opens `at` s after release and holds the fall near `fall` m/s. */
  chute?: { at: number; fall: number };
  /** Airburst: once armed, it goes off this high above the ground (m). */
  airburst?: number;
  /** Trigger group: primary (guns, cannon) or secondary (bombs, missiles). */
  group: 'primary' | 'secondary';
  /** Bounces off structures before it detonates (identity discs, pulse bolts). */
  ricochet?: number;
  /** Laser: an instant beam out to this range (m) instead of a projectile. */
  beam?: number;
}

export const WEAPONS: Record<WeaponKind, WeaponSpec> = {
  gun: { label: 'Gun', speed: 620, rate: 12, ammo: 600, mass: 0.05, blast: 1.6, life: 3, gravity: 1, group: 'primary' },
  cannon: { label: 'Cannon', speed: 330, rate: 0.6, ammo: 40, mass: 12, blast: 7, life: 10, gravity: 1, group: 'primary' },
  bomb: { label: 'Bombs', speed: 0, rate: 1.5, ammo: 8, mass: 250, blast: 18, life: 90, gravity: 1, group: 'secondary' },
  missile: { label: 'Missiles', speed: 30, rate: 1.2, ammo: 6, mass: 60, blast: 10, life: 14, thrust: 120, maxSpeed: 280, gravity: 0.15, group: 'secondary', turn: 45 * Math.PI / 180, seeker: 60 * Math.PI / 180, fuse: 6 },
  // TRON: a beam of light (instant, out to 1.5 km), the identity disc (ricochets off structures
  // up to three times, cutting through what it strikes), and the tank's pulse bolt (bounces once).
  laser: { label: 'Laser', speed: 0, rate: 5, ammo: 240, mass: 0.02, blast: 1.2, life: 0, gravity: 0, group: 'primary', beam: 1500 },
  disc: { label: 'Disc', speed: 140, rate: 1.5, ammo: 12, mass: 4, blast: 2.5, life: 7, gravity: 0, group: 'primary', ricochet: 3 },
  pulse: { label: 'Pulse', speed: 210, rate: 2, ammo: 60, mass: 6, blast: 4, life: 6, gravity: 0, group: 'primary', ricochet: 1 },
  // The railgun: an instant slug out to 4 km that punches through three things before it stops.
  rail: { label: 'Railgun', speed: 0, rate: 0.4, ammo: 20, mass: 8, blast: 2.5, life: 0, gravity: 0, group: 'primary', beam: 4000, pierce: 3 },
  // Strategic weapons, launched one at a time (bought with credits): heavy, slow, homing.
  // The nuke is a bomb: dropped from the belly, a retarding chute, an airburst 300 m up once armed.
  nuke: { label: 'Nuke', speed: 0, rate: 0.2, ammo: 1, mass: 400, blast: 400, life: 120, gravity: 1, group: 'secondary', armTime: 4, chute: { at: 1.5, fall: 45 }, airburst: 300 },
  emp: { label: 'EMP', speed: 40, rate: 0.2, ammo: 1, mass: 200, blast: 800, life: 30, thrust: 80, maxSpeed: 260, gravity: 0.1, group: 'secondary', turn: 25 * Math.PI / 180, seeker: 70 * Math.PI / 180, fuse: 30, armTime: 1.5 },
};

/** Hit points a round takes off an AI aircraft (a peaceful flyer has 1, a hostile several). */
export const WEAPON_DAMAGE: Record<WeaponKind, number> = { gun: 1, laser: 1, disc: 3, pulse: 3, cannon: 8, missile: 8, bomb: 20, rail: 6, nuke: 999, emp: 0 };

/** Loadouts a vehicle can carry: which weapons, chosen in the hangar or cycled with I. */
export const LOADOUTS = {
  none: { label: 'Unarmed', kinds: [] },
  guns: { label: 'Guns', kinds: ['gun'] },
  cannon: { label: 'Cannon', kinds: ['cannon'] },
  bombs: { label: 'Guns + bombs', kinds: ['gun', 'bomb'] },
  missiles: { label: 'Guns + missiles', kinds: ['gun', 'missile'] },
  tank: { label: 'Cannon + coax gun', kinds: ['cannon', 'gun'] },
  light: { label: 'Laser + discs', kinds: ['laser', 'disc'] },
  rail: { label: 'Railgun + missiles', kinds: ['rail', 'missile'] },
  pulse: { label: 'Pulse bolts + missiles', kinds: ['pulse', 'missile'] },
  full: { label: 'Full', kinds: ['gun', 'cannon', 'bomb', 'missile', 'laser', 'disc'] },
  /** The weapons fitted as parts of the craft (weapon modules), where they are. */
  fitted: { label: 'Fitted weapons', kinds: [] },
} as const satisfies Record<string, { label: string; kinds: readonly WeaponKind[] }>;
export type Loadout = keyof typeof LOADOUTS;
export const LOADOUT_ORDER = Object.keys(LOADOUTS) as Loadout[];

export interface Mount {
  kind: WeaponKind;
  /** Fitted weapons: the part it's on (its module shows the ammo left on the craft). */
  partId?: string;
  /** Weapon-system time it last fired. */
  lastFired?: number;
  /** Craft-frame muzzle position and direction (forward = -Z). */
  offset: THREE.Vector3;
  dir: THREE.Vector3;
  ammo: number;
}

export interface Projectile {
  id: number;
  kind: WeaponKind;
  /** Ricochets left (discs, pulse bolts). */
  bounces: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Missiles: the direction they burn along. */
  heading: THREE.Vector3;
  age: number;
  color: string;
  /** A missile fired with a lock: what it homes on (null: unguided, or the seeker lost it). */
  target: LockTarget | null;
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
  /** A strategic warhead that went off before it was armed (a small blast only). */
  dud?: boolean;
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
  /**
   * Where a mount points now, if it moves (a turret's weapons traverse and elevate): moves its
   * craft-frame muzzle offset and direction in place.
   */
  mountPose?(mount: Mount, offset: THREE.Vector3, dir: THREE.Vector3): void;
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
/** Where a fitted weapon's rounds leave it, from its base (matches the models in CraftView). */
const MUZZLE: Record<WeaponKind, THREE.Vector3> = {
  gun: new THREE.Vector3(0, 0, -1.15),
  cannon: new THREE.Vector3(0, 0, -2.56),
  laser: new THREE.Vector3(0, 0, -0.47),
  disc: new THREE.Vector3(0, 0.03, -0.45),
  pulse: new THREE.Vector3(0, 0, -0.85),
  missile: new THREE.Vector3(0, -0.12, -1.1),
  bomb: new THREE.Vector3(0, -0.35, 0),
  rail: new THREE.Vector3(0, 0, -1.9),
  nuke: new THREE.Vector3(0, -1.6, 0),
  emp: new THREE.Vector3(0, -0.5, -1),
};

/** Weapons fitted as weapon modules on the craft's parts: one mount each, where it is. */
export function fittedMounts(def: CraftDef): Mount[] {
  const out: Mount[] = [];
  for (const p of def.parts) {
    const r = p.rotationDeg ?? [0, 0, 0];
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180, 'XYZ'));
    for (const m of p.modules ?? []) {
      if (m.type !== 'weapon') continue;
      // The module sits at the weapon's base; rounds leave from the muzzle (the bay's doors).
      const local = new THREE.Vector3(...(m.offset ?? [0, 0, 0])).add(MUZZLE[m.kind]);
      const offset = local.applyQuaternion(q).add(new THREE.Vector3(...p.position));
      const dir = (m.kind === 'bomb' ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, -1)).applyQuaternion(q);
      out.push({ kind: m.kind, offset, dir, ammo: m.ammo ?? WEAPONS[m.kind].ammo, partId: p.id });
    }
  }
  return out;
}

export function mountsFor(def: CraftDef, loadout: Loadout): Mount[] {
  if (loadout === 'fitted') return fittedMounts(def);
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
    } else if (kind !== 'missile') {
      // Laser, disc and pulse emitters: on the turret's face, else paired at the nose.
      if (turret) {
        const t = partExtent(turret);
        out.push({ kind, offset: new THREE.Vector3(kind === 'disc' ? 0 : -t.max.x * 0.6, t.max.y + 0.1, t.min.z - 0.2), dir: fwd.clone(), ammo });
      } else {
        const x = Math.min(1.0, Math.max(0.3, halfW * 0.3));
        for (const s of [-1, 1]) out.push({ kind, offset: new THREE.Vector3(s * x, midY, min.z - 0.4), dir: fwd.clone(), ammo: Math.round(ammo / 2) });
      }
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
const _c = new THREE.Vector3();
const _h = new THREE.Vector3();
const _tv = new THREE.Vector3();
const _hq = new THREE.Quaternion();
const _hi = new THREE.Quaternion();
/**
 * A dropped bomb's acceleration (into `out`, which already holds gravity): with its chute open,
 * quadratic drag that holds the fall near the chute's speed (and bleeds off the forward drift).
 */
function dropAccel(vel: THREE.Vector3, age: number, spec: WeaponSpec, out: THREE.Vector3): void {
  if (!spec.chute || age < spec.chute.at) return;
  const k = TUNING.gravity / (spec.chute.fall * spec.chute.fall);
  out.addScaledVector(vel, -k * vel.length());
}

/**
 * Where a strategic bomb dropped now would go off: its fall integrated ahead (gravity, the chute)
 * until it is armed and at its airburst height, or reaches the ground first (a dud). `groundAt`:
 * ground height (m). Returns the point, whether it would be armed, and the seconds it takes.
 */
export function predictDrop(kind: StrategicKind, pos: THREE.Vector3, vel: THREE.Vector3, groundAt: (x: number, z: number) => number): { point: THREE.Vector3; armed: boolean; time: number } {
  const spec = WEAPONS[kind];
  const p = pos.clone(), v = vel.clone(), a = new THREE.Vector3();
  const dt = 0.05;
  for (let t = 0; t < spec.life; t += dt) {
    const ground = groundAt(p.x, p.z);
    const armed = !spec.armTime || t >= spec.armTime;
    if (armed && spec.airburst && p.y - ground <= spec.airburst) return { point: p, armed: true, time: t };
    if (p.y <= ground) return { point: p.setY(ground), armed, time: t };
    a.set(0, -TUNING.gravity * spec.gravity, 0);
    dropAccel(v, t, spec, a);
    v.addScaledVector(a, dt);
    p.addScaledVector(v, dt);
  }
  return { point: p, armed: true, time: spec.life };
}

/** Projectile ids are unique across every weapon system (the renderer keys trails by them). */
let nextProjectileId = 1;

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
  /** The locked target: a missile fired now homes on it (null: missiles fly straight). */
  lock: LockTarget | null = null;
  /** Scales the missiles' turn rate (hostiles' missiles turn slower, so a hard turn can shake them). */
  turnScale = 1;
  private readonly cooldown = new Map<Mount, number>();
  /** Alternates between paired mounts (left/right guns and missiles). */
  private flip = new Map<WeaponKind, number>();
  private def: CraftDef | null = null;

  /** Arm a craft: its loadout (or the default it declares) mounted where its geometry allows. */
  arm(def: CraftDef, loadout?: Loadout): void {
    this.def = def;
    // A craft with weapons fitted as parts uses them; otherwise its declared loadout (or none).
    const fitted = def.parts.some((p) => p.modules?.some((m) => m.type === 'weapon'));
    const want = loadout ?? (fitted ? 'fitted' : def.loadout && def.loadout in LOADOUTS ? (def.loadout as Loadout) : 'none');
    this.loadout = want;
    this.mounts = mountsFor(def, want);
    this.cooldown.clear();
    this.flip.clear();
  }

  /** Next loadout in the list (the I key). */
  cycle(): Loadout {
    if (!this.def) return this.loadout;
    // 'fitted' only for craft that have weapons fitted.
    const fitted = this.def.parts.some((p) => p.modules?.some((m) => m.type === 'weapon'));
    const order = LOADOUT_ORDER.filter((l) => l !== 'fitted' || fitted);
    const i = order.indexOf(this.loadout);
    this.arm(this.def, order[(i + 1) % order.length]);
    return this.loadout;
  }

  /** Recent laser beams (start, end, time, colour), for the renderer. */
  readonly beams: Array<{ a: THREE.Vector3; b: THREE.Vector3; time: number; color: string; kind?: WeaponKind }> = [];

  /**
   * Launch a strategic weapon (nuke, EMP) from under the craft's nose, outside the trigger groups
   * and the mounts: it homes on the lock like a missile.
   */
  launch(host: WeaponHost, kind: StrategicKind): Projectile {
    const spec = WEAPONS[kind];
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(host.rotation).normalize();
    const pos = MUZZLE[kind].clone().applyQuaternion(host.rotation).add(host.position);
    const vel = host.linvel.clone().addScaledVector(dir, spec.speed);
    // A dropped bomb (the nuke) falls where it falls; a missile (the EMP) homes on the lock.
    const target = !spec.chute && this.lock?.alive() ? this.lock : null;
    const p: Projectile = { id: nextProjectileId++, kind, pos, vel, heading: dir.clone(), age: 0, color: host.color, bounces: 0, target };
    this.projectiles.push(p);
    this.fired++;
    return p;
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
      // Fitted weapons fire a salvo: every mount of the kind once.
      const shots = this.loadout === 'fitted' ? this.mounts.filter((m) => m.kind === kind).length : 1;
      for (let i = 0; i < shots; i++) if (this.shoot(host, kind, time)) n++;
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
      // Fitted multiples each add their own rate of fire, rippling in turn.
      const n = this.loadout === 'fitted' ? Math.max(1, ready.filter((m) => m.ammo > 0).length) : 1;
      if (time - last >= 1 / (spec.rate * n)) this.shoot(host, kind, time);
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
    m.lastFired = time;
    for (const mm of this.mounts) if (mm.kind === kind) this.cooldown.set(mm, time);
    const local = m.offset.clone();
    const dir = _a.copy(m.dir);
    host.mountPose?.(m, local, dir);
    dir.applyQuaternion(host.rotation).normalize();
    const pos = local.applyQuaternion(host.rotation).add(host.position);
    this.fired++;
    if (spec.beam) {
      // A beam of light (or a railgun slug): instant, straight, out to its range. A railgun
      // punches through what it hits, up to `pierce` things, each one hit in turn.
      const struck = new Set<number>();
      let from = 0, end = pos.clone().addScaledVector(dir, spec.beam);
      for (let n = 0; n < (spec.pierce ?? 1); n++) {
        _ray.origin = { x: pos.x + dir.x * from, y: pos.y + dir.y * from, z: pos.z + dir.z * from };
        _ray.dir = { x: dir.x, y: dir.y, z: dir.z };
        const h = host.world.castRayAndGetNormal(_ray, spec.beam - from, true, undefined, undefined, undefined, host.body, (c) => !struck.has(c.handle));
        if (!h) { end = pos.clone().addScaledVector(dir, spec.beam); break; }
        struck.add(h.collider.handle);
        from += h.timeOfImpact;
        end = pos.clone().addScaledVector(dir, from);
        const hit: WeaponImpact = { kind, point: end.clone(), normal: new THREE.Vector3(h.normal.x, h.normal.y, h.normal.z), vel: dir.clone().multiplyScalar(spec.pierce ? 2500 : 800), mass: spec.mass, blast: spec.blast, color: host.color, collider: h.collider, time };
        this.hits++;
        this.impacts.push(hit);
        if (this.impacts.length > 64) this.impacts.splice(0, this.impacts.length - 64);
        this.onImpact?.(hit);
        from += 0.05;
      }
      this.beams.push({ a: pos, b: end, time, color: host.color, kind });
      if (this.beams.length > 32) this.beams.splice(0, this.beams.length - 32);
      // A railgun's recoil (a beam of light has none).
      if (spec.pierce) host.body.applyImpulse({ x: -dir.x * 4000, y: -dir.y * 4000, z: -dir.z * 4000 }, true);
      return true;
    }
    const vel = host.linvel.clone();
    if (kind !== 'bomb') vel.addScaledVector(dir, spec.speed);
    // Bombs leave the bay level with the craft and pitch nose-down as they fall (front-heavy).
    const heading = kind === 'bomb' ? new THREE.Vector3(0, 0, -1).applyQuaternion(host.rotation) : dir.clone();
    const target = kind === 'missile' && this.lock?.alive() ? this.lock : null;
    this.projectiles.push({ id: nextProjectileId++, kind, pos, vel, heading, age: 0, color: host.color, bounces: spec.ricochet ?? 0, target });
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
      if (p.target && this.home(p, spec, dt)) {
        // Proximity fuse: it goes off beside its target.
        const hit = this.impact(p, p.pos.clone(), new THREE.Vector3(0, 1, 0), null, time);
        list.splice(i, 1);
        this.hits++;
        this.impacts.push(hit);
        if (this.impacts.length > 64) this.impacts.splice(0, this.impacts.length - 64);
        this.onImpact?.(hit);
        continue;
      }
      // Ballistics: gravity (missiles barely feel it while burning), thrust, light drag on bombs.
      _g.set(0, -TUNING.gravity * spec.gravity, 0);
      if (spec.thrust && spec.maxSpeed) {
        const along = p.vel.dot(p.heading);
        if (along < spec.maxSpeed) _g.addScaledVector(p.heading, spec.thrust);
      }
      if (p.kind === 'bomb') _g.addScaledVector(p.vel, -0.00005 * p.vel.length());
      if (spec.chute) dropAccel(p.vel, p.age, spec, _g);
      // Airburst: armed and low enough, it goes off where it is.
      if (spec.airburst && spec.armTime && p.age >= spec.armTime && p.pos.y - host.groundAt(p.pos.x, p.pos.z) <= spec.airburst) {
        const hit = this.impact(p, p.pos.clone(), new THREE.Vector3(0, 1, 0), null, time);
        list.splice(i, 1);
        this.hits++;
        this.impacts.push(hit);
        if (this.impacts.length > 64) this.impacts.splice(0, this.impacts.length - 64);
        this.onImpact?.(hit);
        continue;
      }
      _a.copy(p.pos);
      p.vel.addScaledVector(_g, dt);
      _b.copy(p.pos).addScaledVector(p.vel, dt);
      // Bombs are nose-heavy: they weathercock nose-first into the airflow over about a second.
      if ((p.kind === 'bomb' || spec.chute) && p.vel.lengthSq() > 1) p.heading.lerp(_c.copy(p.vel).normalize(), Math.min(1, dt * 2.5)).normalize();
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
          const n = new THREE.Vector3(h.normal.x, h.normal.y, h.normal.z);
          if (p.bounces > 0) {
            // Ricochet: bite what it struck (a small blast), reflect, fly on.
            p.bounces--;
            const bite = this.impact(p, pt.clone(), n.clone(), h.collider, time);
            bite.blast = Math.min(bite.blast, 2.5);
            this.hits++;
            this.impacts.push(bite);
            this.onImpact?.(bite);
            p.vel.addScaledVector(n, -2 * p.vel.dot(n));
            p.heading.copy(p.vel).normalize();
            p.pos.copy(pt).addScaledVector(n, 0.3);
            continue;
          }
          hit = this.impact(p, pt, n, h.collider, time);
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

  /**
   * Steer a homing missile onto its target's lead point (where it will be when the missile gets
   * there), at most `turn` rad/s; its velocity turns with it. A target outside the seeker cone,
   * or gone, is lost: the missile flies on straight. True when it is within fuse range.
   */
  private home(p: Projectile, spec: WeaponSpec, dt: number): boolean {
    const t = p.target!;
    if (!t.alive()) {
      p.target = null;
      return false;
    }
    const rel = relativePosition(p.pos, t, _h);
    const range = rel.length();
    if (range < (spec.fuse ?? 6) + t.radius) return true;
    t.velocity(_tv);
    const closing = -_c.copy(_tv).sub(p.vel).dot(rel) / Math.max(1, range);
    const tgo = Math.min(6, range / Math.max(60, closing));
    const aim = _c.copy(rel).addScaledVector(_tv, tgo).normalize();
    const angle = Math.acos(Math.max(-1, Math.min(1, aim.dot(p.heading))));
    if (angle > (spec.seeker ?? Math.PI)) {
      p.target = null;
      return false;
    }
    const step = Math.min(1, ((spec.turn ?? 0) * this.turnScale * dt) / Math.max(1e-6, angle));
    _hq.setFromUnitVectors(p.heading, aim);
    _hq.slerp(_hi, 1 - step);
    p.heading.applyQuaternion(_hq).normalize();
    p.vel.applyQuaternion(_hq);
    return false;
  }

  private impact(p: Projectile, point: THREE.Vector3, normal: THREE.Vector3, collider: RAPIER.Collider | null, time: number): WeaponImpact {
    const spec = WEAPONS[p.kind];
    // A strategic warhead that strikes before it is armed is a dud: a missile-sized blast.
    if (spec.armTime && p.age < spec.armTime) return { kind: p.kind, point, normal, vel: p.vel.clone(), mass: spec.mass, blast: 6, color: p.color, collider, time, dud: true };
    return { kind: p.kind, point, normal, vel: p.vel.clone(), mass: spec.mass, blast: spec.blast, color: p.color, collider, time };
  }
}
