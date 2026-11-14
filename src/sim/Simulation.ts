import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Craft } from '../craft/Craft.ts';
import type { CraftDef, PartDef } from '../craft/types.ts';
import { validateCraft } from '../craft/validate.ts';
import type { DebugForce, ForceKind, StepContext } from '../modules/ForceModule.ts';
import { HAZARDS, TUNING } from '../tuning.ts';
import { Atmosphere, calmWeather, densityAltitude, type CloudSample, type Precipitation, type WeatherSettings } from './atmosphere.ts';
import { DamageModel, type ContactForceHandler, type ContactForceInfo } from './damage.ts';
import { neutralControls, sanitizeControls, type ControlInputs } from './controls.ts';
import { Ocean } from './ocean.ts';
import { CITY, COAST, isSea, LAYOUT, PLANET } from './layout.ts';
import { terrainHeight } from './terrain.ts';
import { BIT, BIT_LOOK } from '../people/bit.ts';
import { RoadDamage, type RoadClosure } from './roadDamage.ts';
import { Errands } from './errands.ts';
import { programLight, Programs, PROGRAMS, PROGRAM_KINDS } from './programs.ts';
import { BitPopulation, BitWalker, ON_FOOT, type BitThreat, type WalkInput } from './bits.ts';
import { TrailSystem } from './trails.ts';
import { TrailEmitter } from '../modules/TrailEmitter.ts';
import { HX, HZ, TrafficSystem, type Rider, type RoadObstacle } from './traffic.ts';
import { LockSystem, relativePosition, type LockTarget } from './lock.ts';
import { anglesOf, applyTurret, driveTurret, leadAim, slewTurret } from '../craft/turret.ts';
import { FireSystem } from './fire.ts';
import { LightningSystem, type LightningStrike, type StrikeTarget } from './lightning.ts';
import { Town } from '../world/Town.ts';
import { ChipEmitter } from './chips.ts';
import { craftBounds, WEAPON_DAMAGE, WEAPONS, WeaponSystem, type Mount, type StrategicKind, type WeaponHost, type WeaponImpact, type WeaponKind } from './weapons.ts';
import { AiAirTraffic, type AiFlyer, type AirTarget, type Foe } from './aiTraffic.ts';
import { hostile, sideLight, sideLivery, sideName, TEAMS, type Side, type Team } from './teams.ts';
import { CREDITS, mercPrice } from './mercenaries.ts';
import { CHARGE, STRATEGIC, strategicPrice, type StrategicBlast } from './strategic.ts';
import { GroundTurretSystem, lineOfSight, runwayDistance, TURRET_HEAD_Y, type GroundTurret } from './groundTurrets.ts';
import { HACK, HackBeam, type HackCandidate } from './hacking.ts';
import { circuitOf } from '../craft/style1982.ts';
import { WeaponMount } from '../modules/WeaponMount.ts';
import { BOOM_DAMAGE, BOOM_DEREZ, BOOM_SHATTER, boomBite, boomOverpressure, boomReach, type BoomEvent } from './sonicBoom.ts';
import { StaticWorld } from '../world/staticWorld.ts';
import { vehicleKind } from './vehicleTests.ts';
import { nearestRoadPoint, siteSpawnPoint, type SpawnPoint, type SpawnSite } from '../world/spawnSites.ts';
import { orbitElements, type OrbitTelemetry, type Telemetry } from './telemetry.ts';
import { StrikeSystem, type Strike, type StrikeKind } from './strikes.ts';
import { wrapDelta } from './contacts.ts';
import { AdsbTracker, craftRecord, flyerCallsign, flyerRecord, riderRecord, type AdsbRecord } from './adsb.ts';

function roundOrbit(o: OrbitTelemetry): OrbitTelemetry {
  const r = (x: number | null, d = 0) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
  return { apoapsis: r(o.apoapsis), periapsis: r(o.periapsis)!, speed: r(o.speed, 2)!, period: r(o.period, 1) };
}

function assertValidCraft(def: CraftDef): void {
  const errors = validateCraft(def);
  if (errors.length) throw new Error(`Invalid craft:\n${errors.join('\n')}`);
}

let rapierReady: Promise<void> | null = null;
/** Rapier's WASM must be initialised once before anything else. */
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

const RAD = 180 / Math.PI;
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _sol = new THREE.Vector3();
const _solRel = new THREE.Vector3();
const _solV = new THREE.Vector3();
const _solAim = new THREE.Vector3();
const _solQ = new THREE.Quaternion();
const _wind = new THREE.Vector3();

/** A part that broke off and is now its own rigid body. */
export interface Debris {
  part: PartDef;
  body: RAPIER.RigidBody;
}

/**
 * The headless simulation: Rapier world, ground, weather, one craft, force modules, fixed-step
 * integration, structural failure. Has no knowledge of rendering or input devices, so it runs
 * in the browser and in Node (see scripts/headless.ts): the basis for AI pilots and
 * faster-than-real-time races.
 */
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

export class Simulation {
  readonly dt = 1 / TUNING.physicsHz;
  readonly world: RAPIER.World;
  readonly atmosphere: Atmosphere;
  readonly ocean = new Ocean();
  craft: Craft;
  time = 0;
  steps = 0;
  /** Wall-clock ms of the last physics step (for the stats panel). */
  lastStepMs = 0;
  /** Set when the NaN/explosion guard had to reset the craft. */
  explosionResets = 0;
  /** Bumped whenever the craft's structure changes (new craft, part broke off, rebuilt). */
  version = 0;
  /** Parts that broke off since the last reset, with the load that broke them. */
  readonly failures: Array<{ partId: string; load: number; strength: number; time: number; cause?: 'load' | 'impact' | 'lightning' | 'fire' | 'weapon' }> = [];
  debris: Debris[] = [];
  /** Contact events of every world step (one persistent queue; drained each step). */
  readonly events = new RAPIER.EventQueue(true);
  /** Per-part impact hit points. */
  damage: DamageModel;
  /** Breakable block buildings and their rubble (src/world). */
  readonly town: Town;
  /**
   * Ground craters left by bombs, shells, missiles, crashes and explosions (persistent until a
   * world reset; the renderer draws them as terraced scars in the ground, newest last).
   */
  readonly craters: Array<{ x: number; y: number; z: number; radius: number; time: number; color: string }> = [];
  /** Roads broken by craters: slab fields, barriers and closed segments (src/sim/roadDamage.ts). */
  readonly roadDamage = new RoadDamage();
  /** The rubble of each broken road (one fixed body per closure, so a mended road loses its slabs). */
  private readonly roadRubble = new Map<RoadClosure, RAPIER.RigidBody>();
  /** A broken road mended (by Amber tenders): its slabs go and the stretch opens again. */
  mendRoad(c: RoadClosure): void {
    if (!this.roadDamage.repair(c)) return;
    const body = this.roadRubble.get(c);
    if (body) { this.world.removeRigidBody(body); this.roadRubble.delete(c); }
  }

  /** Scar the ground at (x, z) if the blast at height y is close enough to it. */
  crater(x: number, y: number, z: number, blast: number, color: string): void {
    const gy = isSea(x) ? null : terrainHeight(x, z);
    if (gy === null || y - gy > blast * 0.6) return; // over the sea, or an airburst
    const radius = blast * (0.5 + 0.3 * (1 - Math.max(0, y - gy) / (blast * 0.6)));
    this.craters.push({ x, y: gy, z, radius, time: this.time, color });
    // A crater big enough breaks the road it is on: slabs across it, and the stretch closes.
    const closure = this.roadDamage.add(x, gy, z, radius);
    if (closure) {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      this.roadRubble.set(closure, body);
      for (const s of closure.slabs) {
        this.world.createCollider(RAPIER.ColliderDesc.cuboid(s.sx / 2, s.sy / 2, s.sz / 2).setTranslation(s.x, s.y, s.z).setFriction(0.9).setRestitution(0.05), body);
      }
    }
    if (this.craters.length > 256) this.craters.splice(0, this.craters.length - 256);
  }

  /** Sonic booms (newest last): where supersonic craft hit the ground and buildings with their shock. */
  readonly booms: BoomEvent[] = [];
  /** Blocks knocked out of structures by sonic booms so far (tests, stats). */
  boomDamage = 0;
  private boomAt = -Infinity;
  private boomLengthFor: { def: CraftDef; length: number } | null = null;

  /**
   * A supersonic craft's shock sweeps the world around it (call ~4×/s per craft): structures
   * where the overpressure tops BOOM_DAMAGE lose blocks on the face toward it (weaker booms only
   * shatter surface shards), loose bodies are shoved away, riders under a strong boom derez.
   * Returns the boom, or null below Mach 1.
   */
  boomFrom(src: { x: number; y: number; z: number; vx: number; vy: number; vz: number; length: number }): BoomEvent | null {
    const speed = Math.hypot(src.vx, src.vy, src.vz);
    const mach = speed / this.atmosphere.air(src.y).speedOfSound;
    if (mach <= 1.02) return null;
    const L = src.length;
    const ground = isSea(src.x) ? 0 : terrainHeight(src.x, src.z);
    const groundDp = boomOverpressure(mach, src.y - ground, L);
    const reach = boomReach(mach, L, BOOM_SHATTER);
    let blocks = 0, hits = 0, shards = 0;
    if (src.y - ground < reach) {
      for (const g of this.staticWorld.structures.groups) {
        const x1 = g.x0 + g.size[0] * g.blockSize, z1 = g.z0 + g.size[2] * g.blockSize, y1 = g.size[1] * g.blockSize;
        // The point of the structure nearest the craft: where the shock hits it first.
        const px = Math.min(x1, Math.max(g.x0, src.x)), py = Math.min(y1, Math.max(0, src.y)), pz = Math.min(z1, Math.max(g.z0, src.z));
        const d = Math.hypot(px - src.x, py - src.y, pz - src.z);
        if (d > reach) continue;
        const dp = boomOverpressure(mach, d, L);
        if (dp >= BOOM_DAMAGE && hits < 3) {
          blocks += this.staticWorld.blastAt(px, py, pz, boomBite(dp), this.time);
          hits++;
        } else if (dp >= BOOM_SHATTER && shards < 6) {
          // Surface panels shatter: pale shards fall, the structure stands.
          shards++;
          this.chips.emit({ x: px, y: py, z: pz, radius: 3, vx: (px - src.x) / d * 6, vy: 2, vz: (pz - src.z) / d * 6, speed: 4, count: 30, size: 0.18, color: '#bfefff', persist: true });
        }
      }
      for (const r of this.traffic.riders) {
        if (r.derezAt !== null) continue;
        if (boomOverpressure(mach, Math.hypot(r.x - src.x, 0.8 - src.y, r.z - src.z), L) >= BOOM_DEREZ) this.traffic.derez(r, this.time);
      }
      this.world.forEachRigidBody((b) => {
        if (!b.isDynamic() || b === this.craft.body) return;
        const t = b.translation();
        const dx = t.x - src.x, dy = t.y - src.y, dz = t.z - src.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > reach || d < 1) return;
        const dv = Math.min(20, boomOverpressure(mach, d, L) / 300);
        if (dv < 0.5) return;
        b.applyImpulse({ x: (dx / d) * dv * b.mass(), y: (Math.abs(dy) / d) * dv * b.mass() * 0.5, z: (dz / d) * dv * b.mass() }, true);
      });
    }
    this.boomDamage += blocks;
    const e: BoomEvent = { x: src.x, y: src.y, z: src.z, time: this.time, mach, groundDp, blocks };
    this.booms.push(e);
    if (this.booms.length > 64) this.booms.splice(0, this.booms.length - 64);
    return e;
  }

  /** An AI aircraft derezzes: a flash and voxels in its circuit colour, a splash if it was low. */
  derezFlyer(f: AiFlyer, byPlayer = false): void {
    if (f.derezAt !== null) return;
    this.airTraffic.derez(f, this.time);
    if (byPlayer && f.side !== null && hostile(this.team, f.side)) {
      this.airTraffic.kills++;
      this.earn(CREDITS.aircraft, `${f.name} shot down`);
    }
    const p = f.pos;
    this.explosions.push({ x: p.x, y: p.y, z: p.z, time: this.time, radius: 6 + f.radius, color: f.color, speed: f.speed });
    if (this.explosions.length > 32) this.explosions.splice(0, this.explosions.length - 32);
    const vx = Math.sin(f.heading) * f.speed * 0.4, vz = -Math.cos(f.heading) * f.speed * 0.4;
    this.chips.emit({ x: p.x, y: p.y, z: p.z, radius: f.radius, vx, vy: 3, vz, speed: 12, count: 700, size: 0.28, color: f.color, persist: true });
    this.version++;
  }

  /**
   * A tower turret derezzes: a flash and voxels on the roof in its colour. `by`: the side whose
   * fire did it (the player's kill pays); the district may change hands.
   */
  derezTurret(t: GroundTurret, byPlayer = false, by: Side | null = byPlayer ? this.team : null): void {
    if (t.derezAt !== null) return;
    this.turretBlast(t);
    if (byPlayer) {
      this.airTraffic.kills++;
      this.earn(CREDITS.turret, 'turret destroyed');
    }
    this.capturedByPlayer = byPlayer;
    this.groundTurrets.derez(t, this.time, by);
    this.capturedByPlayer = false;
  }
  private capturedByPlayer = false;

  private turretBlast(t: GroundTurret): void {
    const x = t.pos.x, y = t.pos.y + TURRET_HEAD_Y * 0.6, z = t.pos.z;
    this.explosions.push({ x, y, z, time: this.time, radius: 9, color: t.color, speed: 0 });
    if (this.explosions.length > 32) this.explosions.splice(0, this.explosions.length - 32);
    this.chips.emit({ x, y, z, radius: 2, vx: 0, vy: 5, vz: 0, speed: 10, count: 600, size: 0.26, color: t.color, persist: true });
    this.version++;
  }

  private archGroups: { version: number; size: number; byArch: Map<string, number[]> } = { version: -1, size: -1, byArch: new Map() };

  /** Has a structure (by its architecture id) fractured? (A turret on it falls with it.) */
  private structureFractured(archId: string): boolean {
    const sw = this.staticWorld;
    if (!sw.fractured.size) return false;
    const groups = sw.structures.groups;
    if (this.archGroups.size !== groups.length) {
      const byArch = new Map<string, number[]>();
      for (const g of groups) if (g.arch) byArch.set(g.arch, [...(byArch.get(g.arch) ?? []), g.id]);
      this.archGroups = { version: sw.contentVersion, size: groups.length, byArch };
    }
    return (this.archGroups.byArch.get(archId) ?? []).some((id) => sw.fractured.has(id));
  }

  /** The player's craft: a boom check four times a second while it flies faster than sound. */
  private playerBoom(): void {
    if (this.exploded || this.time - this.boomAt < 0.25) return;
    this.boomAt = this.time;
    if (this.boomLengthFor?.def !== this.craft.def) {
      const b = craftBounds(this.craft.def);
      this.boomLengthFor = { def: this.craft.def, length: Math.max(b.max.z - b.min.z, b.max.x - b.min.x) };
    }
    const v = this.linvel;
    this.boomFrom({ x: this.position.x, y: this.position.y, z: this.position.z, vx: v.x, vy: v.y, vz: v.z, length: this.boomLengthFor.length });
  }

  /** Guns, cannon, bombs and missiles (Rapier ray-swept projectiles); see sim/weapons.ts. */
  readonly weapons = new WeaponSystem();
  /** What the hostile aircraft hunt: this craft. */
  private readonly airTarget: AirTarget = { vel: new THREE.Vector3(), alive: true, armed: false, foes: [] };
  /** The player's team (its craft wears the team's livery). */
  team: Team = 0;
  /** The craft as it was designed (before the team's livery). */
  private sourceDef!: CraftDef;
  /** The craft as designed (no team livery): what the hangar edits and saves. */
  get designDef(): CraftDef {
    return this.sourceDef;
  }
  /** The player as a foe to the other sides; and other players (from the network). */
  private readonly playerFoe: Foe = { side: 0, lock: null as unknown as LockTarget, kind: 'player', engage: false, ground: false };
  extraFoes: Foe[] = [];
  /** Credits earned (kills, captures) and spent (mercenaries). */
  credits = 0;
  /** Things worth a word to the player (credits earned, districts captured), newest last. */
  readonly notices: Array<{ text: string; time: number }> = [];
  private notice(text: string): void {
    this.notices.push({ text, time: this.time });
    if (this.notices.length > 16) this.notices.splice(0, this.notices.length - 16);
  }
  private earn(amount: number, why: string): void {
    this.credits += amount;
    this.notice(`+${amount} credits · ${why}`);
  }

  /** Join a team: the craft is rebuilt in its livery, and the team aircraft re-form. */
  setTeam(team: Team): void {
    if (team === this.team) return;
    this.team = team;
    this.airTraffic.setPlayerTeam(team);
    this.lock.clear();
    this.loadCraft(this.sourceDef);
  }

  /** The strategic weapon carried (bought with credits, one at a time), or null. */
  strategic: StrategicKind | null = null;
  /** Strategic detonations, newest last (the renderer, the audio and the network read them). */
  readonly blasts: StrategicBlast[] = [];
  /** An EMP has cut the craft's engines until then (s). */
  empUntil = -Infinity;

  /** Buy a nuke or an EMP. Returns why not, or null on success. */
  buyStrategic(kind: StrategicKind): string | null {
    const price = strategicPrice(kind);
    if (this.strategic) return `Already carrying ${STRATEGIC[this.strategic].label === 'Nuke' ? 'a nuke' : 'an EMP'}: launch it first`;
    if (this.credits < price) return `Not enough credits (${price} needed, ${this.credits} held)`;
    this.credits -= price;
    this.strategic = kind;
    this.notice(`${STRATEGIC[kind].label} loaded (−${price} credits): \` launches it`);
    return null;
  }

  /** Errands on foot: courier deliveries and escorts between the buildings' rooms. */
  readonly errands = new Errands();
  /** The working programs of the streets, one kind per side (src/sim/programs.ts). */
  readonly programs = new Programs();
  /** Places that just blew up, for the scavengers (the craters, newest last). */
  private readonly programSites: Array<{ x: number; z: number; time: number }> = [];

  /**
   * YES beside a broker: every hired mercenary's contract runs on for another couple of minutes,
   * for a fee. Returns the word for the player.
   */
  private renewContracts(broker: { answer: 'yes' | 'no' | null }): string {
    const B = PROGRAMS.broker;
    const mercs = this.airTraffic.mercs();
    if (!mercs.length) { broker.answer = 'no'; return "Broker: no contracts to renew (hire a mercenary in the ' panel first)"; }
    if (this.credits < B.price) { broker.answer = 'no'; return `Broker: renewing costs ${B.price} credits`; }
    this.credits -= B.price;
    for (const f of mercs) f.mercUntil += B.renew;
    broker.answer = 'yes';
    const text = `Broker: ${mercs.length} contract${mercs.length > 1 ? 's' : ''} renewed for ${B.renew / 60} minutes (−${B.price} credits)`;
    this.notice(text);
    return text;
  }

  /**
   * The player on foot says YES or NO: the Bits in earshot answer, and it may take up (YES beside
   * a Bit that is asking) or drop (NO) an errand. Returns a word for the player, if any.
   */
  speak(answer: 'yes' | 'no'): string | null {
    const w = this.walker;
    if (!w.active || w.downAt !== null || !w.say(answer, this.time)) return null;
    const word = this.errands.say(answer, w, this.bits, this.time);
    this.bits.hear(w.x, w.z, this.time);
    const broker = this.programs.hear(w.x, w.z, answer, this.team, this.time);
    if (broker && answer === 'yes' && !word) return this.renewContracts(broker);
    return word;
  }

  /** Strategic charges set down by hand (on foot), oldest first. */
  readonly charges: Array<{ kind: StrategicKind; x: number; y: number; z: number; setAt: number; fuse: number }> = [];

  /**
   * On foot: set the strategic weapon carried down on the ground just ahead, its fuse running;
   * or, standing over one already set, pick it up again. Returns why not, or null.
   */
  placeStrategic(): string | null {
    const w = this.walker;
    if (!w.active || w.downAt !== null) return 'Set charges down on foot';
    const i = this.charges.findIndex((c) => Math.hypot(c.x - w.x, c.z - w.z) < CHARGE.reach);
    if (i >= 0) {
      const c = this.charges[i];
      if (c.setAt + c.fuse - this.time < CHARGE.lockout) return 'Too late to pick it up: run';
      if (this.strategic) return 'Already carrying one';
      this.charges.splice(i, 1);
      this.strategic = c.kind;
      this.notice(`${STRATEGIC[c.kind].label} picked up: disarmed`);
      return null;
    }
    if (!this.strategic) return 'No strategic weapon: buy one with credits (\')';
    const kind = this.strategic;
    const x = w.x - Math.sin(w.yaw) * 1.5, z = w.z - Math.cos(w.yaw) * 1.5;
    this.charges.push({ kind, x, y: w.y, z, setAt: this.time, fuse: CHARGE.fuse[kind] });
    this.strategic = null;
    this.bits.scare(x, z, 40, this.time);
    this.notice(`${STRATEGIC[kind].label} set: ${CHARGE.fuse[kind]} s · \` beside it picks it up again`);
    return null;
  }

  /** Charges whose fuse has run out go off. */
  private fuseCharges(): void {
    for (let i = this.charges.length - 1; i >= 0; i--) {
      const c = this.charges[i];
      if (this.time < c.setAt + c.fuse) continue;
      this.charges.splice(i, 1);
      if (c.kind === 'nuke') this.detonateNuke(c.x, c.y + 1, c.z, this.team, true);
      else this.detonateEmp(c.x, c.y + 1, c.z, true);
    }
  }

  /** Launch the strategic weapon carried. Returns why not, or null on success. */
  launchStrategic(): string | null {
    if (!this.strategic) return 'No strategic weapon: buy one with credits (\')';
    if (this.exploded) return 'Wrecked';
    this.weapons.launch(this.weaponHost, this.strategic);
    this.notice(`${STRATEGIC[this.strategic].label} away${this.lock.target ? `: homing on ${this.lock.target.name}` : ''}`);
    this.strategic = null;
    return null;
  }

  /**
   * A nuclear detonation at (x, y, z). `by`: the side whose weapon it was; `local`: the player's
   * own (kills pay), not another player's arriving over the network.
   */
  detonateNuke(x: number, y: number, z: number, by: Side, local: boolean): void {
    const { fireball: F, shock: S } = STRATEGIC.nuke;
    // (Measured round the planet: things far from the craft may sit in another image of it.)
    const near = (p: THREE.Vector3) => Math.hypot(wrapDelta(x, p.x), p.y - y, wrapDelta(z, p.z));
    for (const f of [...this.airTraffic.flyers]) {
      if (f.derezAt !== null || near(f.pos) > S) continue;
      f.hp = 0;
      this.derezFlyer(f, local);
    }
    for (const t of [...this.groundTurrets.turrets]) {
      if (t.derezAt !== null || near(t.pos) > S) continue;
      this.derezTurret(t, local && hostile(this.team, t.side), by);
    }
    this.traffic.derezWithin(x, z, S, this.time);
    this.trails.cutAt(x, z, F);
    this.staticWorld.flattenAt(x, y, z, F, this.time);
    for (const b of this.town.buildings) this.town.blast(b, x, y, z, F, this.time);
    this.crater(x, Math.min(y, (isSea(x) ? 0 : terrainHeight(x, z)) + 10), z, 120, '#dff6ff');
    // Loose bodies (rubble, debris) are thrown outward.
    this.world.forEachRigidBody((b) => {
      if (!b.isDynamic() || b === this.craft.body) return;
      const t = b.translation();
      const dx = t.x - x, dy = t.y - y, dz = t.z - z;
      const d = Math.hypot(dx, dy, dz);
      if (d > S || d < 1e-3) return;
      const j = b.mass() * 60 * (1 - d / S);
      b.applyImpulse({ x: (dx / d) * j, y: Math.abs(dy / d) * j + j * 0.5, z: (dz / d) * j }, true);
    });
    this.chips.emit({ x, y, z, radius: 20, vx: 0, vy: 30, vz: 0, speed: 60, count: 2400, size: 0.6, color: '#dff6ff', persist: true });
    // The craft: inside the fireball it derezzes; in the shock ring its parts take a beating.
    if (!this.exploded) {
      const d = near(this.position);
      if (d < F) {
        this.lastHitAt = this.time;
        this.derezCause = 'shot';
        this.explode();
      } else if (d < S) {
        const k = 1.6 * (1 - (d - F) / (S - F));
        this.lastHitAt = this.time;
        this.hitsTaken++;
        if (k > 1) {
          this.derezCause = 'shot';
          this.explode();
        } else for (const p of [...this.craft.parts]) this.hazardDamage(p.id, (this.damage.maxHp.get(p.id) ?? 0) * k, 'weapon');
      }
    }
    // People: inside the fireball they derez, the player on foot too.
    this.bits.strike(x, y, z, F, this.time);
    this.programs.strike(x, y, z, F, this.time);
    if (this.walker.active && this.walker.downAt === null && Math.hypot(wrapDelta(x, this.walker.x), this.walker.y - y, wrapDelta(z, this.walker.z)) < F) this.walker.downAt = this.time;
    this.blasts.push({ kind: 'nuke', x, y, z, time: this.time, remote: !local });
    if (this.blasts.length > 16) this.blasts.splice(0, this.blasts.length - 16);
    this.version++;
  }

  /** An EMP at (x, y, z): disables, destroys nothing. */
  detonateEmp(x: number, y: number, z: number, local: boolean): void {
    const E = STRATEGIC.emp;
    const R = E.radius;
    // (Measured round the planet: things far from the craft may sit in another image of it.)
    const near = (p: THREE.Vector3) => Math.hypot(wrapDelta(x, p.x), p.y - y, wrapDelta(z, p.z));
    for (const f of this.airTraffic.flyers) if (f.derezAt === null && near(f.pos) < R) this.airTraffic.disable(f, this.time + E.aircraft);
    for (const t of this.groundTurrets.turrets) if (t.derezAt === null && near(t.pos) < R) this.groundTurrets.disable(t, this.time + E.turrets);
    for (const r of this.traffic.riders) if (r.derezAt === null && Math.hypot(wrapDelta(x, r.x), wrapDelta(z, r.z)) < R) r.stalledUntil = this.time + E.riders;
    // Homing missiles in it lose their lock.
    for (const w of this.allWeapons()) for (const p of w.projectiles) if (p.target && near(p.pos) < R) p.target = null;
    if (!this.exploded && near(this.position) < R) this.empUntil = this.time + E.craft;
    this.blasts.push({ kind: 'emp', x, y, z, time: this.time, remote: !local });
    if (this.blasts.length > 16) this.blasts.splice(0, this.blasts.length - 16);
    this.version++;
  }

  /** Who hit the craft last over the network, and when (a kill within 12 s is theirs). */
  lastRemoteHit: { id: string; time: number } | null = null;
  private readonly remoteHitBuckets = new Map<string, { tokens: number; at: number }>();

  /**
   * Another player's round struck this craft (the shooter's game saw it hit and reported it).
   * Applied only if the shooter is on another team, the point is near enough to where this
   * craft is (40 m plus 0.3 s of its own movement: the shooter saw it a moment ago), and the
   * shooter isn't sending more than 20 a second. Then the nearest part takes the weapon's
   * share of its hit points, and a warhead going off against it derezzes it, as for a hostile's
   * round. Returns what happened.
   */
  applyRemoteHit(from: { id: string; team: Side }, kind: WeaponKind, point: THREE.Vector3): 'applied' | 'team' | 'far' | 'rate' | 'dead' {
    if (!hostile(from.team, this.team)) return 'team';
    const reach = 40 + this.linvel.length() * 0.3;
    if (point.distanceTo(this.position) > reach) return 'far';
    const now = this.time;
    const b = this.remoteHitBuckets.get(from.id) ?? { tokens: 20, at: now };
    b.tokens = Math.min(20, b.tokens + (now - b.at) * 20);
    b.at = now;
    this.remoteHitBuckets.set(from.id, b);
    if (b.tokens < 1) return 'rate';
    b.tokens -= 1;
    if (this.exploded) return 'dead';
    this.lastRemoteHit = { id: from.id, time: now };
    this.lastHitAt = now;
    this.hitsTaken++;
    const spec = WEAPONS[kind];
    if (spec.blast >= 7 && point.distanceTo(this.position) < spec.blast + 4) {
      this.derezCause = 'shot';
      this.explode();
      return 'applied';
    }
    // The part nearest the point takes it.
    let best: string | null = null, bestD = Infinity;
    const q = this.rotation;
    for (const p of this.craft.parts) {
      const w = _tmp2.set(...p.position).applyQuaternion(q).add(this.position);
      const d = w.distanceTo(point);
      if (d < bestD) { best = p.id; bestD = d; }
    }
    if (best) this.weaponDamage(best, kind);
    return 'applied';
  }

  /** The player shot another player down (their game said so): the kill counts and pays. */
  creditRemoteKill(name: string): void {
    this.airTraffic.kills++;
    this.earn(CREDITS.player, `${name} shot down`);
  }

  /** The craft's engines are out (an EMP). */
  get empActive(): boolean {
    return this.time < this.empUntil;
  }

  /**
   * Hire a mercenary in this design: it costs credits and flies in from about 2 km out.
   * Returns why not, or null on success.
   */
  hireMercenary(def: CraftDef): string | null {
    const price = mercPrice(def);
    if (price <= 0) return `${def.name} can't be hired (it doesn't fly)`;
    if (this.credits < price) return `Not enough credits (${price} needed, ${this.credits} held)`;
    const f = this.airTraffic.hireMerc(def, this.position, this.time);
    if (!f) return 'Three mercenaries already hired';
    this.credits -= price;
    this.notice(`${f.name} hired for 5 minutes (−${price} credits)`);
    return null;
  }
  /** Target lock: the vehicle on the aim line (the nose, or the turret's barrel). */
  readonly lock = new LockSystem();
  /** Other lock targets the simulation doesn't own (other players, from the network). */
  extraLockTargets: LockTarget[] = [];
  /** Turret traverse and elevation inputs this step (-1..1). */
  readonly turretInput = { yaw: 0, pitch: 0 };
  private turretManualAt = -Infinity;
  private turretRecentre = false;
  private lockTick = 0;
  private readonly lockHandles = new WeakMap<object, LockTarget>();
  private liveRiders = new Set<Rider>();
  /** This craft as a lock target (what the hostiles' missiles home on). */
  readonly selfTarget: LockTarget = (() => {
    const self = this;
    return {
      id: 'self', kind: 'self', name: 'You', radius: 4,
      alive: () => !self.exploded,
      position: (out: THREE.Vector3) => out.copy(self.position),
      velocity: (out: THREE.Vector3) => out.copy(self.linvel),
    } satisfies LockTarget;
  })();
  private dozeAt = -Infinity;
  /** Blocks of structure cleared by bulldozing so far (tests, stats). */
  bulldozed = 0;
  /** Visual voxel chips knocked off buildings and aircraft (the renderer flies them). */
  readonly chips = new ChipEmitter();
  /** Explosions (renderer: fireball and shockwave; audio: boom). Newest last. */
  /** Derezzes (vehicle destructions): where, how big, the vehicle's circuit colour and its speed at the moment. */
  readonly explosions: Array<{ x: number; y: number; z: number; time: number; radius: number; color?: string; speed?: number }> = [];
  /** The craft blew up (controls dead until a new plane is spawned). */
  exploded = false;
  /** Why the craft derezzed last ('boundary': it crossed the edge of the Grid). */
  derezCause: 'crash' | 'boundary' | 'shot' | null = null;
  /** When a hostile round last struck the craft (HUD warning; a crash soon after counts as shot down). */
  lastHitAt = -Infinity;
  /** Hostile rounds that have struck the craft since it spawned. */
  hitsTaken = 0;
  /** Sum of craft contact impulses this step (N·s): decides explosions. */
  private stepImpact = 0;
  /** Craft velocity over the last ~0.15 s (ring buffer) and steps left since the last hard contact. */
  private readonly velHistory = Array.from({ length: 18 }, () => new THREE.Vector3());
  private velHead = 0;
  private contactWindow = 0;
  /** Solid neon city and airport structures (static colliders). */
  readonly staticWorld: StaticWorld;
  readonly fire = new FireSystem();
  readonly lightning: LightningSystem;
  private readonly smokeWind = (point: THREE.Vector3, _time: number, out: THREE.Vector3): void => {
    this.fire.addSmokeWind(point, this.position, this.rotation, out);
  };
  private readonly contactForceHandlers: ContactForceHandler[] = [];
  private readonly contactInfo: ContactForceInfo = {
    collider1: 0,
    collider2: 0,
    totalForceMagnitude: 0,
    maxForceMagnitude: 0,
    dt: 0,
    time: 0,
  };

  /** Record per-module forces each step (F3 overlay). Off by default to avoid the overhead. */
  recordForces = false;
  readonly debugForces: DebugForce[] = [];
  private forcePool: DebugForce[] = [];

  /** Body state before/after the last step, for render interpolation. */
  readonly prevPosition = new THREE.Vector3();
  readonly prevRotation = new THREE.Quaternion();
  readonly position = new THREE.Vector3();
  readonly rotation = new THREE.Quaternion();

  controls: ControlInputs = neutralControls();
  private readonly groundCollider: RAPIER.Collider;
  private readonly groundColliders: RAPIER.Collider[] = [];
  /** Times the craft crossed a wrap edge, and the last shift applied (renderers follow it). */
  wrapCount = 0;
  /** Light walls, light ribbons and contrails (Rule 4). */
  readonly trails: TrailSystem;
  /** AI light-cycle traffic on the street grid (kinematic; colliders near the player). */
  readonly traffic: TrafficSystem;
  /** AI aircraft flying around the player (built-ins and, in single player, the player's designs). */
  readonly airTraffic: AiAirTraffic;
  private readonly roadObstacle: RoadObstacle = { x: 0, y: 0, z: 0, vx: 0, vz: 0, radius: 2 };
  /** The people of the Grid: Bits walking the kerbs around their blocks. */
  readonly bits = new BitPopulation();
  /** The player as a Bit on foot (active once it steps out of its vehicle). */
  readonly walker = new BitWalker();
  /** Where the player on foot wants to go; set by the host each step. */
  walkInput: WalkInput = { forward: 0, turn: 0, strafe: 0 };
  private readonly bitThreat: BitThreat = { x: 0, y: 0, z: 0, vx: 0, vz: 0 };
  private lastScare = -Infinity;
  private fracturesSeen = -1;
  private bitTick = 3;
  private readonly ruins = new Set<string>();
  private breaksSeen = -Infinity;
  private blastsSeen = -Infinity;

  /** The player, wherever it is: on foot, or its vehicle. */
  get playerPoint(): { x: number; y: number; z: number } {
    return this.walker.active ? this.walker : this.position;
  }

  /**
   * Step out of the vehicle and go on foot. Returns why not, or null when out. The vehicle has
   * to be down and nearly stopped; it stays parked, brakes on, where it was left.
   */
  exitVehicle(): string | null {
    if (this.walker.active) return 'Already on foot';
    if (this.exploded) return 'Nothing to step out of';
    const ground = isSea(this.position.x) ? null : terrainHeight(this.position.x, this.position.z);
    if (ground === null) return 'Not over water';
    if (this.linvel.length() > ON_FOOT.exitSpeed) return 'Stop first';
    if (this.position.y - ground - this.craft.restingHeight() > 2) return 'Land first';
    // Out of the left side, clear of the hull, facing the way the vehicle faces.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rotation);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    const b = craftBounds(this.craft.def);
    const side = (b.max.x - b.min.x) / 2 + 1.6;
    const x = this.position.x - Math.cos(yaw) * side, z = this.position.z + Math.sin(yaw) * side;
    this.walker.exit(x, terrainHeight(x, z), z, yaw);
    return null;
  }

  /** Get back in. Returns why not, or null when aboard. */
  boardVehicle(): string | null {
    if (!this.walker.active) return 'Already aboard';
    if (!this.exploded) {
      const b = craftBounds(this.craft.def);
      const reach = ON_FOOT.reach + Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;
      if (Math.hypot(this.walker.x - this.position.x, this.walker.z - this.position.z) > reach) return 'Too far from your vehicle';
    }
    this.walker.board();
    return null;
  }
  /** Hostile turrets on tower roofs around the player (density 0 = off). */
  readonly groundTurrets: GroundTurretSystem;
  /** Called-in strikes (the strike globe): missile barrages, EMP strikes, nuke bombers. */
  readonly strikeSystem: StrikeSystem;
  readonly wrapShift = new THREE.Vector3();
  private readonly groundBody: RAPIER.RigidBody;
  private readonly groundMotion = new THREE.Vector3();
  private readonly groundOrigin = new THREE.Vector3();
  private groundMoving = false;
  private readonly linvel = new THREE.Vector3();
  private readonly angvel = new THREE.Vector3();
  private readonly com = new THREE.Vector3();
  private readonly prevVelocity = new THREE.Vector3();
  private gForceFiltered = 1;
  private readonly ctx: StepContext;
  private readonly loadsThisStep = new Map<string, number>();
  private readonly precip: Precipitation = { rate: 0, kind: 'none', waterContent: 0, velocity: new THREE.Vector3() };
  private readonly cloudSample: CloudSample = { inCloud: false, liquidWater: 0 };
  /** Standing water on the ground 0..1 (builds up in rain, drains when it stops). */
  groundWetness = 0;
  private readonly filteredLoads = new Map<string, number>();

  constructor(craftDef: CraftDef, weather: WeatherSettings = calmWeather()) {
    assertValidCraft(craftDef);

    this.world = new RAPIER.World({ x: 0, y: -TUNING.gravity, z: 0 });
    // Rapier clamps every body to 400 m/s × lengthUnit. Raise the unit so fast craft (ramjets,
    // scramjets, re-entry) aren't capped near Mach 1.2, and scale the two normalised contact
    // tolerances down by the same factor so contacts keep their millimetre accuracy.
    const ip = this.world.integrationParameters;
    ip.lengthUnit = TUNING.physicsLengthUnit;
    ip.normalizedAllowedLinearError /= TUNING.physicsLengthUnit;
    ip.normalizedPredictionDistance /= TUNING.physicsLengthUnit;
    this.world.timestep = this.dt;
    this.atmosphere = new Atmosphere(weather);
    this.ocean.surge = (x, z) => this.atmosphere.events.surgeHeight(x, z);
    this.lightning = new LightningSystem(weather.seed);
    // Shared atmosphere extension supplied by the world-events unit. Until that unit is
    // merged, the simulation's air-velocity paths below provide the same smoke contribution.
    const atmosphere = this.atmosphere as Atmosphere & { windContributors?: Array<(point: THREE.Vector3, time: number, out: THREE.Vector3) => void> };
    atmosphere.windContributors?.push(this.smokeWind);

    // The planet's land: everything but the ocean band, on one (quake-movable) body. A strip
    // past each wrap edge overlaps so nothing falls through at the seam.
    const half = LAYOUT.groundSize / 2 + 600;
    const seaEnd = COAST.x + COAST.width;
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -5, 0));
    this.groundBody = ground;
    this.groundOrigin.copy(ground.translation());
    this.groundCollider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid((COAST.x + half) / 2, 5, half).setTranslation((COAST.x - half) / 2, 0, 0).setFriction(0.8).setRestitution(0.1),
      ground,
    );
    this.groundColliders.push(this.groundCollider, this.world.createCollider(
      RAPIER.ColliderDesc.cuboid((half - seaEnd) / 2, 5, half).setTranslation((seaEnd + half) / 2, 0, 0).setFriction(0.8).setRestitution(0.1),
      ground,
    ));
    // Deep seabed under the ocean band.
    const seabed = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(COAST.x + COAST.width / 2, -COAST.depth - 5, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(COAST.width / 2, 5, half), seabed);
    this.trails = new TrailSystem(this.world);
    this.trails.chips = this.chips;
    this.traffic = new TrafficSystem(this.world, CITY.seed, this.chips);
    this.traffic.barriers = this.roadDamage.barriers;
    this.airTraffic = new AiAirTraffic(this.world, CITY.seed);
    this.groundTurrets = new GroundTurretSystem(this.world, CITY.seed);
    this.strikeSystem = new StrikeSystem({
      team: () => this.team,
      time: () => this.time,
      credits: () => this.credits,
      spend: (n) => { this.credits -= n; },
      notice: (t) => this.notice(t),
      playerPos: () => this.position,
      territory: this.groundTurrets.territory,
      air: this.airTraffic,
      turrets: this.groundTurrets,
      impact: (h) => this.weaponImpact(h),
      emp: (x, y, z) => this.detonateEmp(x, y, z, true),
    });
    this.town = new Town(this.world);
    this.town.chips = this.chips;
    this.staticWorld = new StaticWorld(this.world, this.town);

    const { position, rotation } = this.spawnPose(null);
    this.sourceDef = craftDef;
    craftDef = sideLivery(craftDef, this.team);
    this.craft = new Craft(this.world, craftDef, position, rotation);
    this.damage = new DamageModel(this.craft);
    this.weapons.arm(craftDef);
    this.weapons.onImpact = (h) => this.weaponImpact(h);
    this.airTraffic.onHostileImpact = (h, f) => this.weaponImpact(h, f);
    this.airTraffic.groundAt = (x, z) => (isSea(x) ? -COAST.depth : terrainHeight(x, z));
    // Runways are used into the wind (10 m up, the gusts averaged out by how seldom it is asked).
    const windProbe = new THREE.Vector3(), windOut = new THREE.Vector3();
    this.airTraffic.wind = (x, z) => this.atmosphere.windAt(windProbe.set(x, 10, z), 0, windOut);
    this.airTraffic.fractured = this.staticWorld.fractured;
    this.groundTurrets.onImpact = (h, t) => this.weaponImpact(h, t);
    this.groundTurrets.groundAt = this.airTraffic.groundAt;
    this.groundTurrets.fractured = (id) => this.structureFractured(id);
    // A tower brought down under fire takes its turret with it (the player's kill if they did it).
    this.groundTurrets.onTowerFell = (t) => {
      this.turretBlast(t);
      if (this.time - t.hitAt < 5) {
        this.airTraffic.kills++;
        this.earn(CREDITS.turret, 'turret brought down');
      }
    };
    this.groundTurrets.onCapture = (_ci, _cj, team, from) => {
      const name = `${TEAMS[from].name} district`;
      if (team === this.team && this.capturedByPlayer) this.earn(CREDITS.capture, `${name} captured`);
      else this.notice(`${name} captured by ${sideName(team)}`);
    };
    this.onContactForce((e) => {
      // Fresh debris spawns overlapping the airframe; separating them isn't an impact.
      if (this.isFreshDebris(e.collider1) || this.isFreshDebris(e.collider2)) return;
      if (this.town.isFreshDebris(e.collider1, this.time) || this.town.isFreshDebris(e.collider2, this.time)) return;
      if (this.dozing(e)) return;
      this.damage.onContact(e);
    });
    this.onContactForce((e) => this.town.onContact(e));
    this.onContactForce((e) => this.staticWorld.onContact(e));
    this.onContactForce((e) => this.voxelHit(e));
    this.onContactForce((e) => this.traffic.onContact(e));
    // Flying into an AI aircraft derezzes it (the player's craft takes the impact as usual).
    this.onContactForce((e) => {
      const f = this.airTraffic.byCollider(e.collider1) ?? this.airTraffic.byCollider(e.collider2);
      if (f) this.derezFlyer(f, true);
    });

    const self = this;
    this.ctx = {
      dt: this.dt,
      world: this.world,
      body: this.craft.body,
      controls: this.controls,
      atmosphere: this.atmosphere,
      position: this.position,
      rotation: this.rotation,
      com: this.com,
      linvel: this.linvel,
      angvel: this.angvel,
      airDensity: (alt) => this.atmosphere.density(alt),
      air: (alt) => this.atmosphere.air(alt),
      precipitation: (p) => this.atmosphere.precipitationAt(p, 0, this.precip),
      cloud: (p) => this.atmosphere.cloudAt(p, 0, this.cloudSample),
      groundWetness: 0,
      hasFuelSystem: false,
      groundHeight: (x, z) => isSea(x - self.groundMotion.x) ? -COAST.depth : terrainHeight(x, z) + self.groundMotion.y,
      pointVelocity(p, out) {
        _tmp.copy(p).sub(self.com);
        return out.crossVectors(self.angvel, _tmp).add(self.linvel);
      },
      airVelocity(p, out) {
        this.pointVelocity(p, out);
        self.atmosphere.windAt(p, 0, _wind);
        if (!('windContributors' in self.atmosphere)) self.smokeWind(p, self.time, _wind);
        return out.sub(_wind);
      },
      toWorldPoint(local, out) {
        return out.copy(local).applyQuaternion(self.rotation).add(self.position);
      },
      toWorldDir(local, out) {
        return out.copy(local).applyQuaternion(self.rotation);
      },
      applyForce(kind: ForceKind, force, point) {
        if (!Number.isFinite(force.x + force.y + force.z + point.x + point.y + point.z)) return;
        self.craft.body.addForceAtPoint(force, point, true);
        if (self.recordForces) self.recordForce(kind, force, point);
      },
      applyTorque(torque) {
        if (!Number.isFinite(torque.x + torque.y + torque.z)) return;
        self.craft.body.addTorque(torque, true);
      },
      drawFuel(kg) {
        return self.craft.drawFuel(kg);
      },
      structuralLoad(partId, newtons) {
        if (!Number.isFinite(newtons)) return;
        self.loadsThisStep.set(partId, (self.loadsThisStep.get(partId) ?? 0) + Math.abs(newtons));
      },
    };
    this.bindCraft();
    this.resetToRunway();
  }

  /**
   * Subscribe to contact-force events (craft colliders above ~3 g of weight, plus any collider
   * another system flags with CONTACT_FORCE_EVENTS). Handlers run synchronously after each
   * world step. Returns an unsubscribe function.
   */
  onContactForce(handler: ContactForceHandler): () => void {
    this.contactForceHandlers.push(handler);
    return () => {
      const i = this.contactForceHandlers.indexOf(handler);
      if (i >= 0) this.contactForceHandlers.splice(i, 1);
    };
  }

  /** Debris collider handle -> sim time it broke off. */
  private readonly debrisSpawn = new Map<number, number>();
  private isFreshDebris(handle: number): boolean {
    const t = this.debrisSpawn.get(handle);
    return t !== undefined && this.time - t < 1;
  }

  private dispatchContactForces(deliver = true): void {
    const info = this.contactInfo;
    info.dt = this.dt;
    info.time = this.time;
    this.events.drainContactForceEvents((e) => {
      if (!deliver || !this.contactForceHandlers.length) return;
      info.collider1 = e.collider1();
      info.collider2 = e.collider2();
      info.totalForceMagnitude = e.totalForceMagnitude();
      info.maxForceMagnitude = e.maxForceMagnitude();
      for (const h of this.contactForceHandlers) h(info);
    });
  }

  private bindCraft(): void {
    (this.ctx as { body: RAPIER.RigidBody }).body = this.craft.body;
    (this.ctx as { hasFuelSystem: boolean }).hasFuelSystem = this.craft.fuelTanks.length > 0;
  }

  /**
   * Where respawn(), resetToRunway() and the explosion guard put the craft: a runway, a helipad,
   * or the nearest street (ground vehicles only). null = Grid International's runway.
   */
  spawnSite: SpawnSite | null = null;

  /**
   * The site a respawn would really use: the chosen one, or null (Grid International) when it
   * does not apply: a street for a craft that isn't a ground vehicle, a rooftop pad whose tower
   * is fractured.
   */
  effectiveSpawnSite(site: SpawnSite | null = this.spawnSite): SpawnSite | null {
    if (!site) return null;
    if (site.kind === 'street') return vehicleKind(this) === 'ground' ? site : null;
    if (site.group !== undefined && this.staticWorld.fractured.has(site.group)) return null;
    return site;
  }

  private spawnPose(craft: Craft | null, site: SpawnSite | null = this.spawnSite) {
    const h = craft ? craft.restingHeight() : 3;
    let p: SpawnPoint | null = null;
    const use = craft ? this.effectiveSpawnSite(site) : null;
    // Ground vehicles always start on the road network, never on an airstrip: on the road
    // nearest the chosen site (or where they were, for "Nearest street"; or Grid International).
    const ground = !!craft && craft.wheels.some((w) => (w.def.drive ?? 0) > 0) && !craft.rotors.length;
    if (ground) {
      const at = site?.kind === 'street' ? this.position : site ? site : { x: 0, z: LAYOUT.spawnZ };
      p = nearestRoadPoint(at.x, at.z);
    } else if (use && use.kind !== 'street') p = siteSpawnPoint(use);
    if (craft && p) {
      // The centre of mass (not the arbitrary origin) over the spot, facing along the strip/street.
      const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);
      const com = new THREE.Vector3(craft.massProps.com.x, 0, craft.massProps.com.z).applyQuaternion(rotation);
      return { position: new THREE.Vector3(p.x - com.x, p.y + h, p.z - com.z), rotation };
    }
    return {
      // Place the centre of mass (not the arbitrary origin) on the runway centreline at the spawn.
      position: craft
        ? new THREE.Vector3(-craft.massProps.com.x, h, LAYOUT.spawnZ - craft.massProps.com.z)
        : new THREE.Vector3(0, h, LAYOUT.spawnZ),
      rotation: new THREE.Quaternion(),
    };
  }

  /** Swap in a different craft (e.g. one just generated). The old body is removed. */
  loadCraft(def: CraftDef): void {
    assertValidCraft(def);
    this.sourceDef = def;
    def = sideLivery(def, this.team);
    this.rebuildCraft(def);
    this.weapons.arm(def);
    this.explosionResets = 0;
    this.respawn(); // a different craft; the world stays as it is
  }

  private rebuildCraft(def: CraftDef): void {
    const comOffset = this.craft.comOffset.clone();
    this.world.removeRigidBody(this.craft.body);
    const { position, rotation } = this.spawnPose(null);
    this.craft = new Craft(this.world, def, position, rotation);
    if (comOffset.lengthSq() > 0) this.craft.setComOffset(comOffset);
    this.bindCraft();
    this.version++;
  }

  /** True if any airframe collider (not a wheel) is touching the ground: a crash or belly slide. */
  airframeTouchingGround(): boolean {
    let touching = false;
    const n = this.craft.body.numColliders();
    for (let i = 0; i < n && !touching; i++) {
      for (const gc of this.groundColliders) this.world.contactPair(gc, this.craft.body.collider(i), (m) => {
        // Ignore speculative (predicted, not yet touching) contacts from soft CCD.
        for (let j = 0; j < m.numContacts() && !touching; j++) if (m.contactDist(j) < 0.02) touching = true;
      });
    }
    return touching;
  }

  /** Reset the WHOLE world: every structure rebuilt, weather and events restarted, a fresh craft on the runway. */
  resetToRunway(): void {
    this.trails.clear();
    this.traffic.clear();
    this.charges.length = 0;
    this.errands.reset();
    this.bits.reset();
    this.walker.board();
    this.lastScare = -Infinity;
    this.ruins.clear();
    this.fracturesSeen = -1;
    this.breaksSeen = -Infinity;
    this.blastsSeen = -Infinity;
    this.airTraffic.clear();
    this.groundTurrets.clear();
    this.adsb.clear();
    this.staticWorld.reset();
    this.town.reset();
    this.chips.reset();
    this.explosions.length = 0;
    this.craters.length = 0;
    this.roadDamage.reset();
    for (const body of this.roadRubble.values()) this.world.removeRigidBody(body);
    this.roadRubble.clear();
    this.programs.reset();
    this.booms.length = 0;
    this.boomDamage = 0;
    this.lightning.reset(this.atmosphere.settings.seed);
    this.atmosphere.restart();
    this.groundMotion.set(0, 0, 0);
    this.groundBody.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    this.groundBody.setTranslation(this.groundOrigin, true);
    this.groundMoving = false;
    this.settleGroundWater();
    this.respawnCraft();
    this.staticWorld.stream(this.position.x, this.position.z, true);
  }

  /**
   * A fresh craft on the runway, keeping the world as it is: wrecked buildings stay wrecked,
   * rubble stays where it fell and the weather carries on. Only the craft's own debris is cleared.
   */
  respawn(): void {
    if (this.groundMoving) {
      // Mid-earthquake: settle the runway back to its origin so the craft spawns on it.
      this.groundMotion.set(0, 0, 0);
      this.groundBody.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      this.groundBody.setTranslation(this.groundOrigin, true);
      this.groundMoving = false;
    }
    this.respawnCraft();
    this.staticWorld.stream(this.position.x, this.position.z, true);
  }

  private respawnCraft(): void {
    // Broken craft are rebuilt from their definition; debris is cleared away.
    for (const d of this.debris) this.world.removeRigidBody(d.body);
    this.debris = [];
    this.debrisSpawn.clear();
    if (this.craft.detached.size || this.exploded) this.rebuildCraft(this.craft.def);
    this.walker.board(); // a new vehicle starts with its driver in it
    this.exploded = false;
    this.derezCause = null;
    this.lastHitAt = -Infinity;
    this.hitsTaken = 0;
    this.empUntil = -Infinity;
    this.lastRemoteHit = null;
    this.lock.clear();
    this.turretRecentre = false;
    this.stepImpact = 0;
    this.contactWindow = 0;
    this.failures.length = 0;
    this.filteredLoads.clear();
    this.damage.reset(this.craft);
    this.weapons.reset();
    const { position, rotation } = this.spawnPose(this.craft);
    this.craft.reset(position, rotation);
    this.fire.reset(this.craft.parts, this.tankFuel());
    this.controls = neutralControls();
    // The old vehicle's trails derez; the new one starts its own.
    this.trails.derez(this.time);
    this.trails.start(this.craft, this.isAirplane());
    this.prevVelocity.set(0, 0, 0);
    this.gForceFiltered = 1;
    this.readBodyState();
    this.prevPosition.copy(this.position);
    this.prevRotation.copy(this.rotation);
    for (const v of this.velHistory) v.copy(this.linvel);
  }

  private readBodyState(): void {
    const b = this.craft.body;
    const t = b.translation();
    const r = b.rotation();
    const lv = b.linvel();
    const av = b.angvel();
    const c = b.worldCom();
    this.position.set(t.x, t.y, t.z);
    this.rotation.set(r.x, r.y, r.z, r.w);
    this.linvel.set(lv.x, lv.y, lv.z);
    this.angvel.set(av.x, av.y, av.z);
    this.com.set(c.x, c.y, c.z);
  }

  private recordForce(kind: ForceKind, force: THREE.Vector3, point: THREE.Vector3): void {
    const f = this.forcePool.pop() ?? { kind, force: new THREE.Vector3(), point: new THREE.Vector3() };
    f.kind = kind;
    f.force.copy(force);
    f.point.copy(point);
    this.debugForces.push(f);
  }

  /** Advance one fixed physics step with the given controls. */
  step(controls: ControlInputs): void {
    const t0 = performance.now();
    // A wreck flies no more: engines out, surfaces slack (brakes stay on so it settles).
    // On foot the vehicle is parked: nobody at the controls, brakes on.
    this.controls = this.exploded || this.walker.active ? { ...neutralControls(), brake: 1 } : this.tailStrikeGuard(sanitizeControls(controls));
    // An EMP: the engines are out until it passes (the surfaces still answer the stick).
    if (this.time < this.empUntil) this.controls = { ...this.controls, throttle: 0 };
    (this.ctx as { controls: ControlInputs }).controls = this.controls;

    this.prevPosition.copy(this.position);
    this.prevRotation.copy(this.rotation);
    this.prevVelocity.copy(this.linvel);

    while (this.debugForces.length) this.forcePool.push(this.debugForces.pop()!);

    this.atmosphere.events.focus.x = this.position.x;
    this.atmosphere.events.focus.z = this.position.z;
    this.atmosphere.advance(this.dt);
    this.updateGroundMotion();
    const body = this.craft.body;
    body.resetForces(false);
    body.resetTorques(false);
    this.readBodyState();
    this.loadsThisStep.clear();
    this.craft.stepElectrical(this.dt, this.atmosphere.air(this.com.y).temperature - 273.15);
    this.stepImpact = 0;
    this.staticWorld.stream(this.position.x, this.position.z);
    for (const m of this.craft.modules) m.step(this.ctx);
    this.ocean.apply(this.craft, this.time, this.dt, ({ partId, force }) => {
      for (let i = 0; i < body.numColliders(); i++) {
        const collider = body.collider(i);
        if (this.craft.partIdForCollider(collider.handle) !== partId) continue;
        this.damage.onContact({ collider1: collider.handle, collider2: -2, totalForceMagnitude: force,
          maxForceMagnitude: force, dt: this.dt, time: this.time });
        break;
      }
    });
    this.craft.updateSoftCcd(this.dt);
    this.planetForces();
    // Riders brake for the player's vehicle when it is down on their road.
    const ob = this.roadObstacle;
    ob.x = this.position.x; ob.z = this.position.z; ob.vx = this.linvel.x; ob.vz = this.linvel.z;
    ob.y = this.position.y - terrainHeight(this.position.x, this.position.z);
    this.traffic.obstacles = this.exploded ? [] : [ob];
    this.traffic.step(this.dt, this.time, this.position, this.trails);
    // The people: they watch for the player's vehicle and flinch from anything that goes off.
    this.walker.step(this.dt, this.walkInput, this.world, (x, z) => (isSea(x) ? -COAST.depth : terrainHeight(x, z)), this.craft.body);
    const th = this.bitThreat;
    th.x = this.position.x; th.y = this.position.y; th.z = this.position.z; th.vx = this.linvel.x; th.vz = this.linvel.z;
    const latest = this.explosions[this.explosions.length - 1];
    if (latest && latest.time > this.lastScare) {
      for (const e of this.explosions) if (e.time > this.lastScare) this.bits.scare(e.x, e.z, 40 + e.radius * 3, this.time);
      this.lastScare = latest.time;
    }
    // Wrecked buildings empty out; rubble and blasts derez whoever they reach, the player on foot included.
    if (this.staticWorld.version !== this.fracturesSeen) {
      this.fracturesSeen = this.staticWorld.version;
      for (const id of this.staticWorld.fractured.keys()) {
        const g = this.staticWorld.structures.groups[id];
        const arch = g.room?.id ?? g.arch;
        if (arch && !this.ruins.has(arch)) { this.ruins.add(arch); this.bits.collapse(arch, this.time); }
      }
      if (this.staticWorld.fractured.size === 0) this.ruins.clear();
    }
    const w = this.walker;
    const strike = (x: number, y: number, z: number, r: number) => {
      this.bits.strike(x, y, z, r, this.time);
      this.programs.strike(x, y, z, r, this.time);
      if (w.active && w.downAt === null && (w.x - x) ** 2 + (w.y + BIT.hover - y) ** 2 + (w.z - z) ** 2 < r * r) {
        w.downAt = this.time;
        this.chips.emit({ x: w.x, y: w.y + BIT.hover, z: w.z, radius: 0.6, vx: 0, vy: 2, vz: 0, speed: 6, count: 26, size: 0.14, color: BIT_LOOK.idle1.color });
      }
    };
    const breaks = this.town.breaks;
    for (let i = breaks.length - 1; i >= 0 && breaks[i].time > this.breaksSeen; i--) strike(breaks[i].x, breaks[i].y, breaks[i].z, 2.6);
    if (breaks.length) this.breaksSeen = Math.max(this.breaksSeen, breaks[breaks.length - 1].time);
    for (const e of this.explosions) if (e.time > this.blastsSeen) strike(e.x, e.y, e.z, e.radius * 0.6);
    if (latest) this.blastsSeen = Math.max(this.blastsSeen, latest.time);
    // Down on foot: a moment later the player is back in their vehicle.
    if (w.active && w.downAt !== null && this.time - w.downAt > TUNING.respawnDelay) w.board();
    this.fuseCharges();
    const done = this.errands.step(this.time, this.walker, this.bits);
    if (done && 'reward' in done) this.earn(done.reward, done.text);
    else if (done) this.notice(done.failed);
    // The people think at a quarter of the physics rate: plenty for walkers, and cheap.
    if (++this.bitTick % 4 === 0) this.bits.step(this.dt * 4, this.time, this.playerPoint, this.exploded ? [] : [th]);
    // A Bit run over derezzes into chips of its own light.
    for (const d of this.bits.derezEvents) {
      this.chips.emit({ x: d.x, y: d.y, z: d.z, radius: 0.6, vx: th.vx * 0.5, vy: 2, vz: th.vz * 0.5, speed: 6, count: 26, size: 0.14, color: BIT_LOOK.idle1.color });
    }
    this.bits.derezEvents.length = 0;
    // The programs walk at the same rate; tenders mend roads, sentinels guard theirs.
    if (this.bitTick % 4 === 0) {
      const sites = this.programSites;
      sites.length = 0;
      for (let i = this.craters.length - 1; i >= 0 && sites.length < 12; i--) {
        const c = this.craters[i];
        if (this.time - c.time > PROGRAMS.scavenger.fresh) break;
        sites.push({ x: c.x, z: c.z, time: c.time });
      }
      const territory = this.groundTurrets.territory;
      const { shotPlayer } = this.programs.step(this.dt * 4, this.time, this.playerPoint, {
        owner: (x, z) => territory.ownerAt(x, z),
        closed: this.roadDamage.closed,
        closures: this.roadDamage.closures,
        repair: (c) => this.mendRoad(c),
        sites,
        walker: w,
        team: this.team,
        threats: this.exploded ? [] : [th],
      });
      if (shotPlayer && w.active && w.downAt === null) {
        w.downAt = this.time;
        this.chips.emit({ x: w.x, y: w.y + BIT.hover, z: w.z, radius: 0.6, vx: 0, vy: 2, vz: 0, speed: 6, count: 26, size: 0.14, color: BIT_LOOK.idle1.color });
        this.notice('A Red Sentinel patrol derezzed you');
      }
      for (const d of this.programs.derezEvents) {
        this.chips.emit({ x: d.x, y: d.y, z: d.z, radius: 0.9, vx: th.vx * 0.5, vy: 2, vz: th.vz * 0.5, speed: 6, count: 30, size: 0.16, color: programLight(d.side) });
        if (d.byPlayer && !Programs.friendly(d, this.team)) this.earn(PROGRAMS.sentinel.reward, `${PROGRAM_KINDS[d.kind].name} derezzed`);
      }
      this.programs.derezEvents.length = 0;
    }
    // Hostile aircraft hunt the craft only while it lives and carries weapons.
    this.airTarget.vel.copy(this.linvel);
    this.airTarget.alive = !this.exploded;
    this.airTarget.lock = this.selfTarget;
    this.airTarget.armed = this.weapons.mounts.length > 0;
    // Who can fight whom: the player (fired on only while armed), the turrets, other players;
    // the aircraft add themselves.
    const pf = this.playerFoe;
    pf.side = this.team;
    pf.lock = this.selfTarget;
    // Spawn grace: nothing engages a craft for its first seconds, or while it sits on (or rolls
    // along) an airfield's runway, so taking off is never a death sentence.
    const onAirfield = pf.ground && runwayDistance(this.position.x, this.position.z) < 150;
    pf.engage = this.airTarget.alive && this.airTarget.armed && this.time >= this.spawnGraceUntil && !onAirfield;
    pf.ground = this.position.y - terrainHeight(this.position.x, this.position.z) < 8;
    this.airTarget.team = this.team;
    const foes = this.airTarget.foes!;
    foes.length = 0;
    foes.push(pf);
    for (const t of this.groundTurrets.turrets) if (t.derezAt === null) foes.push(t.foe);
    foes.push(...this.extraFoes);
    // Orders and strikes far away keep their part of the world live.
    const focus = this.focusPoints();
    this.airTraffic.focus = focus;
    this.groundTurrets.focus = focus;
    this.airTraffic.step(this.dt, this.time, this.position, this.airTarget);
    const turretFoes = [pf, ...this.extraFoes, ...this.strikeSystem.foes()];
    for (const f of this.airTraffic.flyers) if (f.foe && f.derezAt === null && !f.leaving) turretFoes.push(f.foe);
    // The player sees its unarmed self watched: the turrets get the player even when it isn't armed.
    this.groundTurrets.step(this.dt, this.time, this.position, turretFoes);

    this.world.step(this.events);
    this.readBodyState();
    this.wrapAround();
    this.trails.step(this.time, this.craft, this.rotation, this.position, this.linvel.length(), this.craft.wheels.some((w) => w.grounded));
    if (this.exploded) this.weapons.trigger.primary = this.weapons.trigger.secondary = false;
    this.stepTurret(this.dt);
    if (++this.lockTick % 4 === 0) this.stepLock(this.dt * 4);
    this.stepHack(this.dt);
    this.weapons.lock = this.lock.target;
    this.weapons.step(this.weaponHost, this.dt, this.time);
    this.airTraffic.stepWeapons(this.dt, this.time);
    this.groundTurrets.stepWeapons(this.dt, this.time);
    this.strikeSystem.step(this.dt);
    if (this.adsb.due(this.time)) this.adsb.sample(this.adsbRecords(), this.time);
    this.syncWeaponMounts();
    this.bulldoze();
    this.playerBoom();
    const resets = this.explosionResets;
    this.guardAgainstExplosion();
    // After an explosion reset the step's contacts belong to a craft that's gone: drop them.
    this.dispatchContactForces(resets === this.explosionResets);
    if (this.groundMoving) {
      const accel = this.atmosphere.events.groundAcceleration(_tmp);
      this.staticWorld.shake(accel, this.position.x, this.position.z, this.time);
      this.town.shake(accel);
    }
    // Explode when a hard contact stops (or flings) the craft by more than explodeSpeed within
    // ~0.15 s: velocity change is robust where single-step contact impulses spike.
    if (this.stepImpact > 0) this.contactWindow = this.velHistory.length;
    else if (this.contactWindow > 0) this.contactWindow--;
    const oldest = this.velHistory[this.velHead];
    const dv = Math.hypot(this.linvel.x - oldest.x, this.linvel.y - oldest.y, this.linvel.z - oldest.z);
    oldest.copy(this.linvel);
    this.velHead = (this.velHead + 1) % this.velHistory.length;
    if (!this.exploded && this.contactWindow > 0 && dv > this.explodeSpeed()) this.explode();
    // The edge of the Grid: past the system boundary (above every orbit) a craft derezzes.
    if (!this.exploded && this.position.y > TUNING.systemBoundary) {
      this.derezCause = 'boundary';
      this.explode();
    }
    this.staticWorld.update(this.time);
    this.town.update(this.time);
    this.stepHazards();
    this.checkStructure();
    this.applyImpactDamage();
    this.craft.updateFuelMass();
    this.updateWeather();

    // Load factor: (acceleration + gravity) projected on craft up, in g.
    _tmp.copy(this.linvel).sub(this.prevVelocity).divideScalar(this.dt);
    _tmp.y += TUNING.gravity;
    _tmp2.set(0, 1, 0).applyQuaternion(this.rotation);
    const g = _tmp.dot(_tmp2) / TUNING.gravity;
    if (Number.isFinite(g)) this.gForceFiltered += (g - this.gForceFiltered) * (1 - Math.exp(-this.dt / 0.15));

    this.time += this.dt;
    this.steps++;
    this.lastStepMs = performance.now() - t0;
  }

  /** Drive the runway with analytic ground motion; fixed outside quakes preserves normal cards. */
  private updateGroundMotion(): void {
    const moving = this.atmosphere.events.active.some(e => e.kind === 'earthquake');
    if (moving) {
      if (!this.groundMoving) this.groundBody.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.atmosphere.events.groundDisplacement(this.groundMotion);
      this.groundBody.setNextKinematicTranslation({
        x: this.groundOrigin.x + this.groundMotion.x,
        y: this.groundOrigin.y + this.groundMotion.y,
        z: this.groundOrigin.z + this.groundMotion.z,
      });
    } else if (this.groundMoving) {
      this.groundMotion.set(0, 0, 0);
      this.groundBody.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      this.groundBody.setTranslation(this.groundOrigin, true);
    }
    this.groundMoving = moving;
  }

  private tankFuel(): Map<string, number> {
    const fuel = new Map<string, number>();
    for (const t of this.craft.fuelTanks) fuel.set(t.partId, (fuel.get(t.partId) ?? 0) + t.fuel);
    return fuel;
  }

  /** Actual, still-standing conductors, including individual craft parts. */
  lightningTargets(): StrikeTarget[] {
    const targets: StrikeTarget[] = this.craft.parts.map((p) => {
      const position = new THREE.Vector3(...p.position).applyQuaternion(this.rotation).add(this.position);
      const shape = p.shape;
      const localRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(p.rotationDeg ?? [0, 0, 0]).map((d) => d * Math.PI / 180) as [number, number, number]));
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.rotation.clone().multiply(localRotation).invert());
      const axialProjection = shape.type === 'cylinder' || shape.type === 'capsule' || shape.type === 'cone' ? up[shape.axis ?? 'y'] : 0;
      const height = shape.type === 'sphere' ? shape.radius : shape.type === 'box'
        ? (Math.abs(up.x) * shape.size[0] + Math.abs(up.y) * shape.size[1] + Math.abs(up.z) * shape.size[2]) / 2
        : Math.abs(axialProjection) * shape.length / 2 + Math.sqrt(Math.max(0, 1 - axialProjection ** 2)) * shape.radius;
      position.y += height;
      return { id: p.id, craftPart: p.id, position };
    });
    for (const building of this.town.buildings) {
      let top: THREE.Vector3 | null = null;
      for (const block of building.list) if (block.alive && block.collider) {
        const p = block.collider.translation();
        if (!top || p.y > top.y) top = new THREE.Vector3(p.x, p.y, p.z);
      }
      if (top) top.y += building.blockSize / 2;
      if (top) targets.push({ id: `building:${building.def.id}`, position: top });
    }
    for (const c of this.staticWorld.conductors) targets.push({ id: c.id, position: new THREE.Vector3(c.x, c.y, c.z) });
    return targets;
  }

  /** Debug/manual strike at a world position; the same interception rules as natural strikes. */
  triggerLightning(x = this.position.x, z = this.position.z): LightningStrike {
    const strike = this.lightning.trigger(this.time, x, z, this.lightningTargets(), this.atmosphere.settings.cloudBase);
    this.applyLightning(strike);
    return strike;
  }

  private hazardDamage(partId: string, energyJ: number, cause: 'lightning' | 'fire' | 'weapon'): void {
    const hp = this.damage.hp.get(partId);
    if (hp === undefined || !Number.isFinite(hp)) return;
    const left = Math.max(0, hp - energyJ);
    this.damage.hp.set(partId, left);
    if (left === 0) this.breakPart(partId, energyJ, this.craft.strength.get(partId) ?? Infinity, cause);
  }

  private applyLightning(strike: LightningStrike): void {
    const entry = strike.target.craftPart;
    if (!entry) return;
    const parts = [...this.craft.parts];
    const start = parts.find((p) => p.id === entry);
    if (!start) return;
    // Current seeks the lowest exit. Include every part close to that entry-to-exit path.
    const world = (p: PartDef) => new THREE.Vector3(...p.position).applyQuaternion(this.rotation).add(this.position);
    const exit = parts.reduce((a, b) => world(a).y < world(b).y ? a : b);
    const a = world(start), b = world(exit), ab = b.clone().sub(a);
    const l2 = ab.lengthSq();
    const path = parts.filter((p) => {
      const point = world(p);
      const t = l2 > 0 ? Math.max(0, Math.min(1, point.clone().sub(a).dot(ab) / l2)) : 0;
      return p.id === entry || p.id === exit.id || point.distanceTo(a.clone().addScaledVector(ab, t)) < 1;
    });
    this.craft.onElectricalSpike(strike.energyJ * HAZARDS.electricalCoupling);
    for (const p of path) {
      if (p.modules?.some((m) => m.type === 'fuel')) this.fire.ignite(p.id);
      this.hazardDamage(p.id, strike.energyJ / Math.max(1, path.length), 'lightning');
    }
  }

  private stepHazards(): void {
    const intensity = Math.max(this.atmosphere.settings.storm ?? 0,
      Math.min(1, this.atmosphere.events.rainAt(this.position.x, this.position.z) / 50));
    const strike = this.lightning.step(this.dt, this.time, intensity, this.position,
      () => this.lightningTargets(), this.atmosphere.settings.cloudBase,
      (this.atmosphere.settings.precipitation ?? 0) * this.linvel.length() * 0.00001);
    if (strike) this.applyLightning(strike);
    if (!this.fire.active) return;
    this.fire.step(this.dt, new Set(this.craft.parts.map((p) => p.id)), this.tankFuel());
    for (const fire of this.fire.parts.values()) {
      if (fire.consumed > 0) {
        let left = fire.consumed;
        for (const tank of this.craft.fuelTanks) if (tank.partId === fire.id) {
          const burn = Math.min(tank.fuel, left); tank.fuel -= burn; left -= burn;
        }
      }
      if (fire.burning) this.hazardDamage(fire.id, this.dt * Math.max(0, fire.temperature - 200) * HAZARDS.heatDamagePerDegree, 'fire');
    }
  }

  private readonly groundProbe = new THREE.Vector3();
  /** Standing water on the runway (mm). */
  private waterDepth = 0;

  /**
   * Weather bookkeeping each step: water film / ice mass on the airframe, and standing water on
   * the ground (half the rain runs off, the rest drains over ~10 min; 3 mm counts as flooded).
   */
  private updateWeather(): void {
    const p = this.atmosphere.precipitationAt(this.com, 0, this.precip);
    _tmp.copy(this.linvel);
    const wind = this.atmosphere.windAt(this.com, 0, _tmp2);
    const airspeed = _tmp.sub(wind).length();
    this.craft.updateWeatherMass(p.rate, p.kind, airspeed, this.dt);
    this.groundProbe.set(this.com.x, 0.5, this.com.z);
    const g = this.atmosphere.precipitationAt(this.groundProbe, 0, this.precip);
    const inflow = g.kind === 'rain' ? (0.5 * g.rate) / 3600 : 0;
    this.waterDepth = Math.max(0, this.waterDepth + (inflow - this.waterDepth / 600) * this.dt);
    this.groundWetness = Math.min(1, this.waterDepth / 3);
    (this.ctx as { groundWetness: number }).groundWetness = this.groundWetness;
  }

  /** Runway water at equilibrium with the current rain (used on reset / weather change). */
  settleGroundWater(): void {
    this.groundProbe.set(this.com.x, 0.5, this.com.z);
    const g = this.atmosphere.precipitationAt(this.groundProbe, 0, this.precip);
    this.waterDepth = g.kind === 'rain' ? ((0.5 * g.rate) / 3600) * 600 : 0;
    this.groundWetness = Math.min(1, this.waterDepth / 3);
    (this.ctx as { groundWetness: number }).groundWetness = this.groundWetness;
  }

  /** Filter each part's load; anything over its strength breaks off and becomes debris. */
  private checkStructure(): void {
    const k = 1 - Math.exp(-this.dt / TUNING.loadFilterTime);
    const broken: Array<[string, number, number]> = [];
    for (const [partId, load] of this.loadsThisStep) {
      const f = (this.filteredLoads.get(partId) ?? 0) + (load - (this.filteredLoads.get(partId) ?? 0)) * k;
      this.filteredLoads.set(partId, f);
      const strength = (this.craft.strength.get(partId) ?? Infinity) * this.fire.strengthFactor(partId);
      if (f > strength) broken.push([partId, f, strength]);
    }
    for (const [partId, load, strength] of broken) this.breakPart(partId, load, strength, 'load');
  }

  /** Detach parts whose impact HP ran out (same failure path as structural overload). */
  private applyImpactDamage(): void {
    for (const f of this.damage.flush(this.time)) this.breakPart(f.partId, f.load, f.strength, 'impact');
  }

  /** Break a part off: debris body, failure record, structure version bump. */
  /**
   * The planet in a flat frame: the world's gravity is the surface value, so add back what
   * altitude takes away ((R / (R + h))²) plus the centripetal lift v_h² / (R + h) of flying
   * around a sphere. At ~280 m/s near the ground (less higher up) the craft is in orbit.
   * Climbing also costs horizontal speed (−v_r·v_h / r, conservation of angular momentum), so
   * energy and angular momentum are conserved and eccentric orbits are Keplerian too.
   */
  private planetForces(): void {
    const R = PLANET.radius;
    const accel = (y: number, vx: number, vy: number, vz: number, out: { x: number; y: number; z: number }) => {
      const r = R + Math.max(0, y);
      out.y = PLANET.gravity - PLANET.gravity * (R / r) ** 2 + (vx * vx + vz * vz) / r;
      const k = y > 0 ? -vy / r : 0;
      out.x = k * vx;
      out.z = k * vz;
      return out;
    };
    const a = { x: 0, y: 0, z: 0 };
    const b = this.craft.body;
    const m = b.mass();
    accel(this.position.y, this.linvel.x, this.linvel.y, this.linvel.z, a);
    b.addForce({ x: m * a.x, y: m * a.y, z: m * a.z }, true);
    for (const d of this.debris) {
      const t = d.body.translation();
      const v = d.body.linvel();
      const dm = d.body.mass() * this.dt;
      accel(t.y, v.x, v.y, v.z, a);
      d.body.applyImpulse({ x: dm * a.x, y: dm * a.y, z: dm * a.z }, true);
    }
  }

  /** The weapon system's view of the craft (live getters: the craft is rebuilt on respawn). */
  private readonly weaponHost: WeaponHost = (() => {
    const self = this;
    return {
      get world() { return self.world; },
      get body() { return self.craft.body; },
      get position() { return self.position; },
      get rotation() { return self.rotation; },
      get linvel() { return self.linvel; },
      get color() { return self.circuitColor(); },
      groundAt: (x: number, z: number) => (isSea(x) ? -COAST.depth : terrainHeight(x, z)),
      mountPose: (m: Mount, offset: THREE.Vector3, dir: THREE.Vector3) => {
        const rig = self.craft.turretRig;
        if (rig && self.onTurret(m)) applyTurret(rig, self.craft.turret, true, offset, dir);
      },
    };
  })();

  /** Does this mount sit on the turret (its weapons traverse and elevate with it)? */
  private onTurret(m: Mount): boolean {
    const rig = this.craft.turretRig;
    if (!rig) return false;
    if (m.partId) return rig.riders.has(m.partId);
    // A loadout's mounts: everything but the missile rails and the bomb bay is on the turret.
    return m.kind !== 'missile' && m.kind !== 'bomb';
  }

  /** Every vehicle the lock can pick: AI aircraft, light-cycle riders and other players. */
  lockTargets(): LockTarget[] {
    const out: LockTarget[] = [];
    const air = this.airTraffic;
    // Never the player's own side: friendly aircraft, mercenaries and turrets aren't locked.
    for (const f of air.flyers) {
      if (f.derezAt !== null || (f.side !== null && !hostile(this.team, f.side))) continue;
      out.push(f.handle);
    }
    this.liveRiders = new Set(this.traffic.riders);
    for (const r of this.traffic.riders) {
      if (r.derezAt !== null) continue;
      let h = this.lockHandles.get(r);
      if (!h) {
        h = {
          id: `rider:${r.id}`, kind: 'rider', name: 'Light cycle', radius: 1.5,
          alive: () => r.derezAt === null && this.liveRiders.has(r),
          position: (o) => o.set(r.x, terrainHeight(r.x, r.z) + 1, r.z),
          velocity: (o) => o.set(HX[r.heading] * r.speed, 0, HZ[r.heading] * r.speed),
        };
        this.lockHandles.set(r, h);
      }
      out.push(h);
    }
    for (const t of this.groundTurrets.turrets) if (t.derezAt === null && hostile(this.team, t.side)) out.push(t.handle);
    out.push(...this.extraLockTargets);
    return out;
  }

  /** The aim line (unit, world frame): along the turret's barrel on a turreted craft, else the nose. */
  aimDirection(out = new THREE.Vector3()): THREE.Vector3 {
    out.set(0, 0, -1);
    const rig = this.craft.turretRig;
    if (rig) applyTurret(rig, this.craft.turret, true, _tmp.set(0, 0, 0), out);
    return out.applyQuaternion(this.rotation).normalize();
  }

  /** The lock runs while the craft carries weapons. */
  private stepLock(dt: number): void {
    // Unarmed, there is nothing to lock for, unless hacking charges are held (the beam needs one).
    if (this.exploded || (this.weapons.mounts.length === 0 && this.hackCharges <= 0)) {
      this.lock.clear();
      return;
    }
    this.lock.step(dt, this.position, this.aimDirection(_aim), this.lockTargets());
  }

  /** The turret is laying itself on the lock (no hand on the aim for a moment). */
  get turretAuto(): boolean {
    return !!this.craft.turretRig && !!this.lock.target && !this.turretRecentre && this.time - this.turretManualAt >= 1.5;
  }

  /** Point the turret back along the nose. */
  recentreTurret(): void {
    this.turretRecentre = true;
  }

  /**
   * The turret: the aim inputs traverse and elevate it; left alone for a moment with a lock
   * held, it lays the gun on the target itself (lead and shell drop included).
   */
  private stepTurret(dt: number): void {
    const rig = this.craft.turretRig;
    if (!rig || this.exploded) return;
    const pose = this.craft.turret;
    const { yaw, pitch } = this.turretInput;
    if (Math.abs(yaw) > 0.05 || Math.abs(pitch) > 0.05) {
      driveTurret(pose, yaw, pitch, dt);
      this.turretManualAt = this.time;
      this.turretRecentre = false;
      return;
    }
    if (this.turretRecentre) {
      slewTurret(pose, 0, 0, dt);
      if (Math.abs(pose.yaw) < 1e-3 && Math.abs(pose.pitch) < 1e-3) this.turretRecentre = false;
      return;
    }
    const target = this.lock.target;
    if (!target || this.time - this.turretManualAt < 1.5) return;
    const sol = this.firingSolution(target);
    if (sol) slewTurret(pose, sol.yaw, sol.pitch, dt);
  }

  /** Turret angles that put the turret's main gun on a target (null: no turret gun). */
  firingSolution(target: LockTarget): { yaw: number; pitch: number } | null {
    const rig = this.craft.turretRig;
    const m = this.weapons.mounts.filter((x) => this.onTurret(x)).sort((a, b) => WEAPONS[b.kind].mass - WEAPONS[a.kind].mass)[0];
    if (!rig || !m) return null;
    const spec = WEAPONS[m.kind];
    const origin = _sol.copy(rig.trunnion).applyQuaternion(this.rotation).add(this.position);
    const rel = relativePosition(origin, target, _solRel);
    target.velocity(_solV).sub(this.linvel);
    const speed = spec.beam ? 1e6 : Math.max(50, spec.speed);
    const g = TUNING.gravity * spec.gravity;
    const aim = leadAim(rel, _solV, speed, g, _solAim);
    aim.applyQuaternion(_solQ.copy(this.rotation).invert());
    return anglesOf(aim);
  }

  /** Hostile missiles in flight homing on this craft. */
  incomingMissiles(): number {
    return this.airTraffic.incoming(this.selfTarget) + this.groundTurrets.incoming(this.selfTarget);
  }

  /** Fitted weapons: mirror each mount's rounds and last shot onto its module (the craft view shows them). */
  private syncWeaponMounts(): void {
    const mods = this.craft.modules.filter((m): m is WeaponMount => m instanceof WeaponMount);
    if (!mods.length) return;
    const fitted = this.weapons.loadout === 'fitted';
    const used = new Set<WeaponMount>();
    for (const mount of this.weapons.mounts) {
      if (!mount.partId) continue;
      const mod = mods.find((m) => !used.has(m) && m.partId === mount.partId && m.def.kind === mount.kind);
      if (!mod) continue;
      used.add(mod);
      mod.ammo = mount.ammo;
      mod.sinceFired = this.time - (mount.lastFired ?? -Infinity);
    }
    // Not using the fitted weapons (another loadout chosen): show them full and quiet.
    if (!fitted) for (const m of mods) if (!used.has(m)) m.sinceFired = Infinity;
  }

  /** Fire one round of a trigger group now (scripts, tests, the LLM pilot). */
  fireWeapon(group: 'primary' | 'secondary' = 'primary'): number {
    return this.exploded ? 0 : this.weapons.fireOnce(this.weaponHost, group, this.time);
  }

  /**
   * A round hits: it derezzes the rider it struck (and, with a blast, any nearby), shoves loose
   * bodies (debris, rubble, other craft pieces), craters structures (fracturing them into Rapier
   * blocks), and flashes and shatters into voxels in the shooter's circuit colour.
   */
  private weaponImpact(h: WeaponImpact, shooter?: AiFlyer | GroundTurret): void {
    // A strike's bomber drops for the player: its bomb counts as the player's own.
    if (shooter && 'role' in shooter && shooter.role === 'strike') shooter = undefined;
    // Strategic warheads: armed, they play out their own way; a dud is just a missile's blast.
    if ((h.kind === 'nuke' || h.kind === 'emp') && !h.dud) {
      const by: Side = shooter ? shooter.side! : this.team;
      if (h.kind === 'nuke') this.detonateNuke(h.point.x, h.point.y, h.point.z, by, !shooter);
      else this.detonateEmp(h.point.x, h.point.y, h.point.z, !shooter);
      return;
    }
    if (h.dud) h = { ...h, kind: 'missile' };
    const p = h.point;
    const col = h.collider;
    if (col) this.traffic.derezCollider(col.handle, this.time); // a rider, or a rider's jetwall
    // AI aircraft: hit directly, or caught in a blast. Each has hit points (a peaceful flyer one,
    // a hostile several); hostiles don't shoot each other down.
    const flyer = col ? this.airTraffic.byCollider(col.handle) : undefined;
    // Whose round: a side (the shooter's, or the player's team); a round never hurts its own side.
    const by: Side = shooter ? shooter.side! : this.team;
    const strike = (f: AiFlyer) => {
      if (f === shooter) return;
      if (f.side !== null && !hostile(by, f.side)) return;
      if (this.airTraffic.damage(f, WEAPON_DAMAGE[h.kind], this.time)) this.derezFlyer(f, !shooter);
    };
    if (flyer) strike(flyer);
    if (h.blast >= 3) for (const f of this.airTraffic.flyers) if (f !== flyer && f.derezAt === null && Math.hypot(wrapDelta(p.x, f.pos.x), f.pos.y - p.y, wrapDelta(p.z, f.pos.z)) < h.blast + f.radius) strike(f);
    // Tower turrets: the player's rounds and blasts wear them down (hostiles never hit them).
    const turret = col ? this.groundTurrets.byCollider(col.handle) : undefined;
    const hitTurret = (t: GroundTurret) => {
      if (t === shooter || !hostile(by, t.side)) return;
      if (this.groundTurrets.damage(t, WEAPON_DAMAGE[h.kind], this.time)) this.derezTurret(t, !shooter, by);
    };
    if (turret) hitTurret(turret);
    if (h.blast >= 3) for (const t of this.groundTurrets.turrets) {
      if (t === turret || t.derezAt !== null) continue;
      if (Math.hypot(wrapDelta(p.x, t.pos.x), t.pos.y + TURRET_HEAD_Y * 0.6 - p.y, wrapDelta(p.z, t.pos.z)) < h.blast + 2.5) hitTurret(t);
    }
    // A hostile's round on the player's craft: the struck part loses hit points (and breaks off
    // at zero); a warhead that goes off against it, or beside it, derezzes it outright.
    if (shooter && !this.exploded && hostile(by, this.team)) {
      const partId = col ? this.craft.partIdForCollider(col.handle) : undefined;
      const near = h.blast >= 7 && p.distanceTo(this.position) < h.blast;
      if (partId !== undefined || near) {
        this.lastHitAt = this.time;
        this.hitsTaken++;
      }
      if (near || (partId !== undefined && h.blast >= 7)) {
        this.derezCause = 'shot';
        this.explode();
      } else if (partId !== undefined) this.weaponDamage(partId, h.kind);
    }
    if (h.blast >= 3) this.traffic.derezWithin(p.x, p.z, h.blast * 0.8, this.time);
    // Light walls break: a round that strikes one cuts a gap; a blast clears its radius.
    const wallHit = !!col && this.trails.isWall(col.handle);
    if (wallHit || h.blast >= 3) this.trails.cutAt(p.x, p.z, wallHit ? Math.max(2, h.blast * 0.8) : h.blast * 0.8);
    // (AI aircraft and turrets are kinematic: a round doesn't shove them.)
    const body = flyer || turret ? undefined : col?.parent();
    if (body && body.isDynamic()) {
      const k = h.mass * (h.kind === 'gun' ? 1.5 : 4);
      body.applyImpulseAtPoint({ x: h.vel.x * k, y: h.vel.y * k + h.blast * h.mass, z: h.vel.z * k }, { x: p.x, y: p.y, z: p.z }, true);
    }
    // Blast impulse on every loose body nearby (rubble, debris): outward, falling off with distance.
    if (h.blast >= 3) {
      this.world.forEachRigidBody((b) => {
        if (!b.isDynamic() || b === this.craft.body) return;
        const t = b.translation();
        const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > h.blast * h.blast * 4 || d2 < 1e-6) return;
        const d = Math.sqrt(d2);
        const j = (b.mass() * h.blast * 1.5) / (1 + d);
        b.applyImpulse({ x: (dx / d) * j, y: (Math.abs(dy) / d) * j + j * 0.3, z: (dz / d) * j }, true);
      });
    }
    // A round that strikes a turret spends itself on it; only a warhead also bites the roof under it.
    if (!turret || h.blast >= 3) this.staticWorld.blastAt(p.x, p.y, p.z, h.blast, this.time);
    if (h.blast >= 3) this.crater(p.x, p.y, p.z, h.blast, h.color);
    if (h.blast >= 3) for (const b of this.town.buildings) this.town.blast(b, p.x, p.y, p.z, h.blast * 0.6, this.time);
    if (h.kind === 'gun') {
      this.chips.emit({ x: p.x, y: p.y, z: p.z, radius: 0.3, vx: h.normal.x * 4, vy: h.normal.y * 4 + 1, vz: h.normal.z * 4, speed: 5, count: 5, size: 0.12, color: h.color });
      return;
    }
    const speed = h.vel.length();
    this.explosions.push({ x: p.x, y: p.y, z: p.z, time: this.time, radius: h.blast, color: h.color, speed });
    if (this.explosions.length > 32) this.explosions.splice(0, this.explosions.length - 32);
    this.chips.emit({ x: p.x, y: p.y, z: p.z, radius: h.blast * 0.15, vx: 0, vy: 4, vz: 0, speed: 6 + h.blast, count: Math.round(40 + h.blast * 12), size: 0.22, color: h.color, persist: true });
    // An energy splash erupts where the round meets the grid (not off a wall face high up).
    const gy = isSea(p.x) ? 0 : terrainHeight(p.x, p.z);
    if (p.y - gy < 4) this.chips.emit({ x: p.x, y: gy, z: p.z, radius: 0.5, vx: h.vel.x * 0.1, vy: 0, vz: h.vel.z * 0.1, speed: 8 + h.blast * 1.2, count: Math.round(60 + h.blast * 10), size: 0.14, color: h.color, splash: true });
  }

  /** A hostile round strikes a part: it loses a share of its full hit points, by the weapon. */
  private weaponDamage(partId: string, kind: WeaponKind): void {
    const max = this.damage.maxHp.get(partId);
    if (max === undefined || !Number.isFinite(max)) return;
    // The heaviest part is the craft itself: when it gives out, the craft derezzes.
    const core = [...this.craft.parts].sort((a, b) => b.mass - a.mass)[0];
    const left = (this.damage.hp.get(partId) ?? 0) - max * TUNING.weaponHitShare[kind];
    if (left <= 0 && (core?.id === partId || this.craft.parts.length <= 1)) {
      this.derezCause = 'shot';
      this.explode();
    } else this.hazardDamage(partId, max * TUNING.weaponHitShare[kind], 'weapon');
  }

  /** Every weapon system with rounds in flight: the craft's own and the hostiles' (the renderer). */
  allWeapons(): WeaponSystem[] {
    return [this.weapons, ...this.airTraffic.weaponSystems(), ...this.groundTurrets.weaponSystems(), this.strikeSystem.view];
  }

  /** ADS-B: every vehicle's broadcast and its last minute of track (sampled once a second). */
  readonly adsb = new AdsbTracker();
  /** Other players' broadcasts (set by the network each frame; sampled with the rest). */
  extraAdsb: AdsbRecord[] = [];

  /** Every vehicle's ADS-B record now: the AI aircraft, the light cycles, the craft, other players. */
  adsbRecords(): AdsbRecord[] {
    const out: AdsbRecord[] = [];
    const from = this.position;
    for (const f of this.airTraffic.flyers) { const r = flyerRecord(f, this.team, this.time, from); if (r) out.push(r); }
    for (const r of this.traffic.riders) { const x = riderRecord(r, this.time, from); if (x) out.push(x); }
    if (!this.exploded) {
      const fwd = _fwd.set(0, 0, -1).applyQuaternion(this.rotation);
      out.push(craftRecord({
        id: 'self', callsign: 'YOU', type: this.craft.def.name, self: true, side: this.team, team: this.team,
        x: this.position.x, y: this.position.y, z: this.position.z, vx: this.linvel.x, vy: this.linvel.y, vz: this.linvel.z,
        heading: Math.atan2(fwd.x, -fwd.z), emp: this.time < this.empUntil, hurt: this.hitsTaken > 0 && this.time - this.lastHitAt < 10,
      }, from));
    }
    out.push(...this.extraAdsb);
    return out;
  }

  // ------------------------------------------------------------------ the hacking beam
  /** Until then (s) nothing engages the craft: a fresh spawn gets to take off. */
  spawnGraceUntil = 20;
  static readonly SPAWN_GRACE = 20;

  /** Hacking charges held (bought in the armory; see sim/hacking.ts). */
  hackCharges = 0;
  /** The hack trigger is held this step. */
  hackHeld = false;
  readonly hackBeam = new HackBeam();
  /** Hacks done so far (tests, stats). */
  hacks = 0;

  /** Buy a pack of hacking charges. Returns why not, or null. */
  buyHack(): string | null {
    if (this.hackCharges + HACK.pack > HACK.max) return `You hold ${this.hackCharges}: at most ${HACK.max}`;
    if (this.credits < HACK.price) return `Not enough credits (${HACK.price} needed, ${this.credits} held)`;
    this.credits -= HACK.price;
    this.hackCharges += HACK.pack;
    this.notice(`${HACK.pack} hacking charges (−${HACK.price} credits): lock a target and hold ;`);
    return null;
  }

  /** What the beam would work on: the locked vehicle, if it is an aircraft, turret or light cycle. */
  private hackCandidate(): HackCandidate | null {
    const t = this.lock.locked ? this.lock.target : null;
    if (!t || !t.alive()) return null;
    const at = t.position(new THREE.Vector3());
    at.set(this.position.x + wrapDelta(this.position.x, at.x), at.y, this.position.z + wrapDelta(this.position.z, at.z));
    const range = at.distanceTo(this.position);
    const clear = lineOfSight(this.position, at);
    if (t.id.startsWith('air:')) {
      const f = this.airTraffic.flyers.find((x) => `air:${x.id}` === t.id);
      if (!f) return null;
      return { id: t.id, kind: 'air', hackable: f.side !== null && hostile(this.team, f.side) && !f.hacked && f.role !== 'strike', range, clear, disabled: this.time < f.disabledUntil };
    }
    if (t.id.startsWith('turret:')) {
      const g = this.groundTurrets.turrets.find((x) => `turret:${x.site.id}` === t.id);
      if (!g) return null;
      return { id: t.id, kind: 'turret', hackable: hostile(this.team, g.side) && !g.hacked, range, clear, disabled: this.time < g.disabledUntil };
    }
    if (t.id.startsWith('rider:')) {
      const r = this.traffic.riders.find((x) => `rider:${x.id}` === t.id);
      if (!r) return null;
      return { id: t.id, kind: 'rider', hackable: !r.hackColor, range, clear, disabled: (r.stalledUntil ?? -Infinity) > this.time };
    }
    return null;
  }

  private stepHack(dt: number): void {
    const done = this.hackBeam.step(dt, this.hackHeld && !this.exploded, this.hackCharges, this.hackHeld ? this.hackCandidate() : null);
    if (done) {
      this.hackCharges--;
      this.hack(done);
    }
    // Hacks run out: back to their old side.
    for (const f of this.airTraffic.flyers) if (f.hacked && this.time >= f.hacked.until) this.unhackFlyer(f, true);
    for (const t of this.groundTurrets.turrets) if (t.hacked && this.time >= t.hacked.until) this.unhackTurret(t, true);
    for (const r of this.traffic.riders) if (r.hackColor && this.time >= (r.hackedUntil ?? 0)) { r.hackColor = undefined; r.hackedUntil = undefined; this.notice(`LC-${r.id}: the hack ran out`); }
  }

  /** Take a vehicle over (by its lock id) for HACK.duration seconds. */
  hack(id: string): boolean {
    const until = this.time + HACK.duration;
    const team = this.team;
    if (id.startsWith('air:')) {
      const f = this.airTraffic.flyers.find((x) => `air:${x.id}` === id);
      if (!f || f.side === null) return false;
      const before = flyerCallsign(f);
      f.hacked = { until, was: f.side, wasRole: f.role, wasDef: f.def, wasColor: f.color };
      f.side = team;
      f.role = 'hacked';
      f.def = sideLivery(f.def, team);
      f.color = circuitOf(f.def);
      if (f.foe) f.foe.side = team;
      f.target = null;
      f.order = null;
      f.leaving = false;
      this.notice(`Hacked ${before}: it flies for you for ${HACK.duration} s`);
    } else if (id.startsWith('turret:')) {
      const t = this.groundTurrets.turrets.find((x) => `turret:${x.site.id}` === id);
      if (!t) return false;
      t.hacked = { until, was: t.side, wasColor: t.color };
      t.side = team;
      t.color = sideLight(team);
      t.foe.side = team;
      t.target = null;
      this.notice(`Hacked a turret: it fires for ${TEAMS[team].name} for ${HACK.duration} s`);
    } else if (id.startsWith('rider:')) {
      const r = this.traffic.riders.find((x) => `rider:${x.id}` === id);
      if (!r) return false;
      r.hackedUntil = until;
      r.hackColor = sideLight(team);
      this.notice(`Hacked LC-${r.id}: its wall can't touch you for ${HACK.duration} s`);
    } else return false;
    this.hacks++;
    this.lock.clear();
    this.version++;
    return true;
  }

  private unhackFlyer(f: AiFlyer, notice: boolean): void {
    const h = f.hacked!;
    f.hacked = null;
    f.side = h.was;
    f.role = h.wasRole;
    f.def = h.wasDef;
    f.color = h.wasColor;
    if (f.foe) f.foe.side = h.was;
    f.target = null;
    if (notice && f.derezAt === null) this.notice(`${flyerCallsign(f)}: the hack ran out, it's back with ${sideName(h.was)}`);
  }

  private unhackTurret(t: GroundTurret, notice: boolean): void {
    const h = t.hacked!;
    t.hacked = null;
    t.side = h.was;
    t.color = h.wasColor;
    t.foe.side = h.was;
    t.target = null;
    if (notice && t.derezAt === null) this.notice(`A hacked turret is back with ${TEAMS[h.was].name}`);
  }

  /** Strikes in flight (the strike globe). */
  get strikes(): Strike[] {
    return this.strikeSystem.live();
  }

  /** Call in a strike on (x, z), paid with credits. Returns why not, or null. */
  callStrike(kind: StrikeKind, x: number, z: number): string | null {
    const r = this.strikeSystem.call(kind, x, z);
    return typeof r === 'string' ? r : null;
  }

  /** Send the team's aircraft (friendlies, mercenaries, or both) to attack round (x, z). */
  orderAircraft(x: number, z: number, who: 'all' | 'friends' | 'mercs' = 'all'): number {
    const n = this.airTraffic.order(x, z, this.time, who);
    this.notice(n ? `${n} aircraft sent to attack (${(Math.hypot(x - this.position.x, z - this.position.z) / 1000).toFixed(1)} km)` : 'No aircraft to send');
    return n;
  }

  /** Call the ordered aircraft back to escort the craft. */
  recallAircraft(): number {
    const n = this.airTraffic.recall();
    if (n) this.notice(`${n} aircraft recalled`);
    return n;
  }

  /** Places other than the craft that are live: order points, strike targets, strikes in flight. */
  focusPoints(): Array<{ x: number; z: number }> {
    return [...this.airTraffic.orders().map((o) => ({ x: o.x, z: o.z })), ...this.strikeSystem.focus()];
  }

  /** A bulldozer shoving through structure or rubble: no damage to it (the rubble still feels it). */
  private dozing(e: ContactForceInfo): boolean {
    if (!this.craft.def.bulldozer) return false;
    const mine = this.craft.partIdForCollider(e.collider1) ? e.collider2 : this.craft.partIdForCollider(e.collider2) ? e.collider1 : null;
    if (mine === null) return false;
    return !!(this.town.blockForCollider(mine) || this.town.chunkForCollider(mine) || this.staticWorld.isStructure(mine));
  }

  /**
   * Bulldozer (the tank): driving into a structure crushes it. Every ~0.1 s at speed, the blocks
   * in a column just ahead of the hull (in the direction of travel) are knocked out; a whole
   * structure first fractures into its Rapier blocks, which the hull then shoves aside.
   */
  private bulldoze(): void {
    if (!this.craft.def.bulldozer || this.exploded || this.time - this.dozeAt < 0.1) return;
    const v = this.linvel;
    const speed = Math.hypot(v.x, v.z);
    if (speed < 1) return;
    this.dozeAt = this.time;
    const fwd = _tmp.set(0, 0, -1).applyQuaternion(this.rotation);
    const sign = fwd.x * v.x + fwd.z * v.z >= 0 ? 1 : -1;
    const b = craftBounds(this.craft.def);
    const reach = (sign > 0 ? -b.min.z : b.max.z) + 1.4;
    const half = Math.max(1.5, (b.max.x - b.min.x) / 2);
    const fx = this.position.x + fwd.x * sign * reach, fz = this.position.z + fwd.z * sign * reach;
    const ground = terrainHeight(fx, fz);
    for (let y = ground + 0.8; y < ground + Math.max(3.5, b.max.y + 1.5); y += 2.2) {
      this.bulldozed += this.staticWorld.blastAt(fx, y, fz, half + 0.6, this.time);
    }
  }

  /** The vehicle's circuit colour: its trail's light, else the colour of its heaviest part. */
  circuitColor(): string {
    for (const m of this.craft.modules) if (m instanceof TrailEmitter) return m.def.color;
    const heaviest = [...this.craft.parts].sort((a, b) => b.mass - a.mass)[0];
    return heaviest?.color ?? '#00eaff';
  }

  /** Fixed-wing (contrails from the wingtips): lifting surfaces, no rotors, no driven wheels. */
  isAirplane(): boolean {
    return this.craft.aeroSurfaces.length > 0 && this.craft.rotors.length === 0 && !this.craft.wheels.some((w) => (w.def.drive ?? 0) > 0);
  }

  /** Crossing a wrap edge: shift the craft and its debris by one circumference. */
  private wrapAround(): void {
    const half = PLANET.circumference / 2;
    const sx = this.position.x > half ? -PLANET.circumference : this.position.x < -half ? PLANET.circumference : 0;
    const sz = this.position.z > half ? -PLANET.circumference : this.position.z < -half ? PLANET.circumference : 0;
    if (!sx && !sz) return;
    const shift = (b: RAPIER.RigidBody) => {
      const t = b.translation();
      b.setTranslation({ x: t.x + sx, y: t.y, z: t.z + sz }, true);
    };
    shift(this.craft.body);
    for (const d of this.debris) shift(d.body);
    this.prevPosition.x += sx;
    this.prevPosition.z += sz;
    this.wrapShift.set(sx, 0, sz);
    this.wrapCount++;
    this.readBodyState();
    this.staticWorld.stream(this.position.x, this.position.z, true);
  }

  /**
   * Tail-strike protection (as on fly-by-wire airliners): while the main wheels are on the
   * ground, nose-up elevator fades out as the pitch (plus 0.3 s of pitch rate) nears the
   * craft's tail-strike angle less a 2° margin, and turns nose-down past it.
   */
  private lastWheelContact = -Infinity;
  private tailStrikeGuard(c: ControlInputs): ControlInputs {
    if (c.pitch <= 0 || !TUNING.tailStrikeProtection) return c;
    const strike = this.craft.tailStrikeAngle();
    if (strike === null) return c;
    // Also just after lift-off: an over-rotated craft that settles back drags its tail.
    if (this.craft.wheels.some((w) => w.grounded)) this.lastWheelContact = this.time;
    else if (this.time - this.lastWheelContact > 10 || this.position.y - this.craft.restingHeight() > 3) return c;
    const fwd = _fwd.set(0, 0, -1).applyQuaternion(this.rotation);
    const pitch = (Math.asin(Math.max(-1, Math.min(1, fwd.y))) * 180) / Math.PI;
    const right = _right.set(1, 0, 0).applyQuaternion(this.rotation);
    const pitchRate = (this.angvel.dot(right) * 180) / Math.PI; // + = nose up
    const limit = strike - 2;
    const predicted = pitch + Math.max(0, pitchRate) * 0.3;
    const room = (limit - predicted) / 3; // fade over the last 3°
    if (room >= 1) return c;
    return { ...c, pitch: room > 0 ? c.pitch * room : Math.max(-0.4, room * 0.4) };
  }

  /** Speed lost in a crash that blows the craft up (m/s): ~30, more if reinforced. */
  /** Speed change (m/s) in a hard contact that blows the craft up: higher for reinforced craft. */
  explodeSpeed(): number {
    const parts = this.craft.parts;
    const avg = parts.length ? parts.reduce((a, p) => a + Math.min(3, Math.max(0, p.reinforce ?? 0)), 0) / parts.length : 0;
    return TUNING.explodeSpeed * (1 + 0.3 * avg) * Math.sqrt(Math.max(1, this.craft.def.armor ?? 1));
  }

  /**
   * Voxel damage: a craft collider struck hard bites 0.25 m voxels out of its part at the actual
   * contact point; the bitten voxels fly off as chips. Integrity (voxels left) scales the part's
   * mass, lift, thrust; below `TUNING.voxelBreakIntegrity` the part breaks off.
   */
  private voxelHit(e: ContactForceInfo): void {
    if (this.dozing(e)) return;
    if (this.isFreshDebris(e.collider1) || this.isFreshDebris(e.collider2)) return;
    if (this.town.isFreshDebris(e.collider1, this.time) || this.town.isFreshDebris(e.collider2, this.time)) return;
    const craft = this.craft;
    const impulse = e.totalForceMagnitude * e.dt;
    for (const [mine, other] of [[e.collider1, e.collider2], [e.collider2, e.collider1]] as const) {
      const partId = craft.partIdForCollider(mine);
      if (!partId) continue;
      const part = craft.parts.find((p) => p.id === partId);
      const vox = craft.voxels.get(partId);
      if (!part || !vox) continue;
      this.stepImpact += impulse;
      const level = Math.min(3, Math.max(0, Math.round(part.reinforce ?? 0)));
      const gear = !!part.modules?.some((m) => m.type === 'wheel') || /^(gear|skid)/.test(part.kind);
      const tol = craft.massProps.mass * (gear ? TUNING.gearSinkLimit : TUNING.impactSafeSpeed) * (1 + 0.5 * level) * Math.max(1, craft.def.armor ?? 1);
      if (impulse <= tol) continue;
      // Where on the part: the first solver contact point, in the part's frame.
      const c1 = this.world.getCollider(mine);
      const c2 = this.world.getCollider(other);
      const wp = { ok: false, x: 0, y: 0, z: 0 };
      if (c1 && c2) this.world.contactPair(c1, c2, (m) => {
        if (wp.ok || m.numSolverContacts() === 0) return;
        const p = m.solverContactPoint(0);
        if (p) { wp.ok = true; wp.x = p.x; wp.y = p.y; wp.z = p.z; }
      });
      const pq = new THREE.Quaternion().setFromEuler(new THREE.Euler(...((part.rotationDeg ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180) as [number, number, number])));
      const worldQ = this.rotation.clone().multiply(pq);
      const partPos = new THREE.Vector3(...part.position).applyQuaternion(this.rotation).add(this.position);
      const hitW = wp.ok ? new THREE.Vector3(wp.x, wp.y, wp.z) : partPos.clone();
      const local = hitW.clone().sub(partPos).applyQuaternion(worldQ.clone().invert());
      const at = vox.nearestAlive(local.x, local.y, local.z);
      if (!at) continue;
      const radius = Math.min(4, Math.max(vox.cell * 0.6, (vox.cell * (1 + 1.8 * Math.log2(impulse / tol))) / (1 + 0.5 * level)));
      const removed = vox.bite(at[0], at[1], at[2], radius);
      if (!removed.length) continue;
      // Chips: up to ~40 bursts' worth, flying with the craft and outward from the hit.
      const lv = this.linvel;
      const every = Math.max(1, Math.ceil(removed.length / 40));
      for (let i = 0; i < removed.length; i += every) {
        const w = new THREE.Vector3(...removed[i]).applyQuaternion(worldQ).add(partPos);
        this.chips.emit({ x: w.x, y: w.y, z: w.z, radius: vox.cell, vx: lv.x * 0.7, vy: lv.y * 0.7 + 1, vz: lv.z * 0.7, speed: 3 + Math.min(12, impulse / tol), count: Math.min(every, 6), size: vox.cell, color: part.color });
      }
      craft.voxelsChanged(partId);
      if (vox.integrity < TUNING.voxelBreakIntegrity) this.breakPart(partId, impulse / e.dt, craft.strength.get(partId) ?? Infinity, 'impact');
    }
  }

  /**
   * The craft blows up: every part but the heaviest is thrown off outward, its voxels burst
   * into chips, and the blast craters the nearest structures.
   */
  explode(): void {
    if (this.exploded) return;
    this.exploded = true;
    // Going down within a few seconds of taking fire is being shot down.
    this.derezCause ??= this.time - this.lastHitAt < 12 ? 'shot' : 'crash';
    this.trails.derez(this.time); // a derezzed vehicle's trails go with it
    const c = this.position.clone();
    const radius = 10 + Math.min(20, this.craft.fuel * 0.15);
    // Speed going in (the step before the crash), and the vehicle's circuit colour.
    const speed = this.prevVelocity.length();
    const circuit = this.circuitColor();
    this.explosions.push({ x: c.x, y: c.y, z: c.z, time: this.time, radius, color: circuit, speed });
    if (this.explosions.length > 32) this.explosions.splice(0, this.explosions.length - 32);
    const parts = [...this.craft.parts].sort((a, b) => b.mass - a.mass);
    const before = this.debris.length;
    for (const p of parts.slice(1)) this.breakPart(p.id, Infinity, this.craft.strength.get(p.id) ?? Infinity, 'impact');
    if (parts[0]) this.fire.ignite(parts[0].id); // the wreck burns
    // Throw the pieces outward and burst their voxels.
    for (const d of this.debris.slice(before)) {
      const t = d.body.translation();
      const dir = new THREE.Vector3(t.x - c.x, t.y - c.y + 0.5, t.z - c.z).normalize();
      const v = d.body.linvel();
      const kick = 12 + Math.random() * 18;
      d.body.setLinvel({ x: v.x * 0.5 + dir.x * kick, y: v.y * 0.5 + Math.abs(dir.y) * kick + 6, z: v.z * 0.5 + dir.z * kick }, true);
      d.body.setAngvel({ x: (Math.random() - 0.5) * 12, y: (Math.random() - 0.5) * 12, z: (Math.random() - 0.5) * 12 }, true);
      this.chips.emit({ x: t.x, y: t.y, z: t.z, radius: 1.5, vx: dir.x * kick * 0.6, vy: 6, vz: dir.z * kick * 0.6, speed: 14, count: 120, size: 0.25, color: d.part.color, persist: true });
    }
    // Derez: the vehicle shatters into thousands of cubical voxels in its circuit colour, which
    // scatter on the Grid like broken glass and stay there.
    const lv = this.prevVelocity;
    this.chips.emit({ x: c.x, y: c.y, z: c.z, radius: 2, vx: lv.x * 0.35, vy: 5, vz: lv.z * 0.35, speed: 16, count: 1400, size: 0.3, color: circuit, persist: true });
    // A fast vehicle's derez carries so much energy it erupts from the grid at the impact site
    // like a liquid splash, droplets arcing out under gravity, then dissipates.
    if (speed > 20) {
      const gy = isSea(c.x) ? 0 : terrainHeight(c.x, c.z);
      this.chips.emit({ x: c.x, y: Math.min(c.y, gy), z: c.z, radius: 1.2, vx: lv.x, vy: 0, vz: lv.z, speed: Math.min(28, 8 + speed * 0.3), count: Math.min(900, 300 + Math.round(speed * 6)), size: 0.18, color: circuit, splash: true });
    }
    // Blast: crater whatever stands within the radius, and the ground under it.
    this.staticWorld.blastAt(c.x, c.y, c.z, radius, this.time);
    this.crater(c.x, c.y, c.z, radius, circuit);
    this.trails.cutAt(c.x, c.z, radius * 0.5);
    this.traffic.derezWithin(c.x, c.z, radius * 0.6, this.time); // riders (and their walls) caught in it
    for (const b of this.town.buildings) this.town.blast(b, c.x, c.y, c.z, radius * 0.6, this.time);
    this.version++;
  }

  private breakPart(partId: string, load: number, strength: number, cause: 'load' | 'impact' | 'lightning' | 'fire' | 'weapon'): void {
    if (this.craft.parts.length <= 1) return; // never detach the last piece
    const part = this.craft.parts.find((p) => p.id === partId);
    const body = this.craft.detachPart(partId);
    if (part && body) {
      this.debris.push({ part, body });
      for (let i = 0; i < body.numColliders(); i++) this.debrisSpawn.set(body.collider(i).handle, this.time);
      this.failures.push({
        partId,
        load: Math.round(load),
        strength: Number.isFinite(strength) ? Math.round(strength) : 0,
        time: this.time,
        cause,
      });
      this.filteredLoads.delete(partId);
      this.damage.remove(partId);
      this.fire.parts.delete(partId);
      this.version++;
    }
  }

  /** If anything went non-finite or absurd, put the craft back on the runway. */
  private guardAgainstExplosion(): void {
    const ok =
      Number.isFinite(this.position.x + this.position.y + this.position.z) &&
      Number.isFinite(this.rotation.x + this.rotation.y + this.rotation.z + this.rotation.w) &&
      Number.isFinite(this.linvel.x + this.linvel.y + this.linvel.z) &&
      this.linvel.length() < TUNING.maxSaneSpeed &&
      this.angvel.length() < TUNING.maxSaneAngularSpeed;
    if (!ok) {
      this.explosionResets++;
      // Back to the one known-good pose (not a spawn site worked out from a bad state).
      const site = this.spawnSite;
      this.spawnSite = null;
      this.resetToRunway();
      this.spawnSite = site;
    }
  }

  /** Wind at the craft right now (m/s, world). */
  windAtCraft(out = new THREE.Vector3()): THREE.Vector3 {
    this.atmosphere.windAt(this.com, 0, out);
    if (!('windContributors' in this.atmosphere)) this.smokeWind(this.com, this.time, out);
    return out;
  }

  telemetry(): Telemetry {
    const q = this.rotation;
    const ground = this.linvel;
    const wind = this.windAtCraft(new THREE.Vector3());
    const v = ground.clone().sub(wind); // air-relative
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const speed = v.length();

    const pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1)) * RAD;
    // Bank: angle of the right wing below the horizon, measured around the nose.
    const roll = Math.atan2(-right.y, up.y) * RAD;
    let heading = Math.atan2(fwd.x, -fwd.z) * RAD;
    if (heading < 0) heading += 360;
    const aoa = speed > 1 ? Math.atan2(-v.dot(up), v.dot(fwd)) * RAD : 0;
    const beta = speed > 1 ? Math.asin(THREE.MathUtils.clamp(v.dot(right) / speed, -1, 1)) * RAD : 0;

    const craft = this.craft;
    const engines = craft.engines;
    const rotors = craft.rotors;
    const spool = engines.length
      ? engines.reduce((s, e) => s + e.spool, 0) / engines.length
      : rotors.length
        ? rotors.reduce((s, r) => s + r.omega / r.maxOmega, 0) / rotors.length
        : 0;
    let stallW = 0;
    let stallSum = 0;
    const n = new THREE.Vector3();
    for (const s of craft.aeroSurfaces) {
      const w = s.area * Math.abs(s.localNormal(n).y);
      stallW += w;
      stallSum += s.stall * w;
    }
    const wheels = craft.wheels;
    const onGround = wheels.length ? wheels.some((w) => w.grounded) : this.airframeTouchingGround() && ground.length() < 3;

    const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
    const cap = craft.fuelCapacity;
    const air = this.atmosphere.air(this.com.y);
    const precip = this.atmosphere.precipitationAt(this.com, 0);
    const cloud = this.atmosphere.cloudAt(this.com, 0);
    return {
      time: r(this.time, 3),
      position: [r(this.position.x), r(this.position.y), r(this.position.z)],
      velocity: [r(ground.x), r(ground.y), r(ground.z)],
      airspeed: r(speed),
      groundSpeed: r(Math.hypot(ground.x, ground.z)),
      wind: [r(wind.x), r(wind.y), r(wind.z)],
      altitude: r(this.position.y - terrainHeight(this.position.x, this.position.z) - craft.restingHeight() + 0.05),
      verticalSpeed: r(ground.y),
      heading: r(heading, 1),
      pitch: r(pitch, 1),
      roll: r(roll, 1),
      angleOfAttack: r(aoa, 1),
      sideslip: r(beta, 1),
      gForce: r(this.gForceFiltered),
      throttle: r(this.controls.throttle),
      engineSpool: r(spool),
      fuel: cap > 0 ? r(craft.fuel / cap) : null,
      onGround,
      stall: r(stallW > 0 ? stallSum / stallW : 0),
      brokenParts: [...craft.detached],
      partHp: this.damage.fractions(),
      controls: { ...this.controls },
      mach: r(speed / air.speedOfSound, 3),
      oat: r(air.temperature - 273.15, 1),
      densityAltitude: Math.round(densityAltitude(air.density)),
      vortexRing: r(rotors.reduce((a, x) => Math.max(a, x.vortexRing), 0)),
      electrical: craft.electrical?.telemetry() ?? null,
      orbit: roundOrbit(orbitElements(this.position.y, ground.y, Math.hypot(ground.x, ground.z))),
      weather: {
        precipitation: r(precip.rate, 1),
        precipitationKind: precip.kind,
        inCloud: cloud.inCloud,
        iceMm: r(craft.maxIce * 1000, 1),
        waterKg: r(craft.water, 2),
        groundWetness: r(this.groundWetness, 2),
        aquaplaning: r(wheels.reduce((a, w) => Math.max(a, w.aquaplaning), 0)),
      },
    };
  }

  get bodyCount(): number {
    return this.world.bodies.len();
  }
}
