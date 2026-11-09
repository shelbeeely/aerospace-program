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
import { COAST, isSea, LAYOUT, PLANET } from './layout.ts';
import { terrainHeight } from './terrain.ts';
import { TrailSystem } from './trails.ts';
import { FireSystem } from './fire.ts';
import { LightningSystem, type LightningStrike, type StrikeTarget } from './lightning.ts';
import { Town } from '../world/Town.ts';
import { ChipEmitter } from './chips.ts';
import { StaticWorld } from '../world/staticWorld.ts';
import { nearestStreetPoint, siteSpawnPoint, type SpawnPoint, type SpawnSite } from '../world/spawnSites.ts';
import type { Telemetry } from './telemetry.ts';

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
  readonly failures: Array<{ partId: string; load: number; strength: number; time: number; cause?: 'load' | 'impact' | 'lightning' | 'fire' }> = [];
  debris: Debris[] = [];
  /** Contact events of every world step (one persistent queue; drained each step). */
  readonly events = new RAPIER.EventQueue(true);
  /** Per-part impact hit points. */
  damage: DamageModel;
  /** Breakable block buildings and their rubble (src/world). */
  readonly town: Town;
  /** Visual voxel chips knocked off buildings and aircraft (the renderer flies them). */
  readonly chips = new ChipEmitter();
  /** Explosions (renderer: fireball and shockwave; audio: boom). Newest last. */
  readonly explosions: Array<{ x: number; y: number; z: number; time: number; radius: number }> = [];
  /** The craft blew up (controls dead until a new plane is spawned). */
  exploded = false;
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
    this.town = new Town(this.world);
    this.town.chips = this.chips;
    this.staticWorld = new StaticWorld(this.world, this.town);

    const { position, rotation } = this.spawnPose(null);
    this.craft = new Craft(this.world, craftDef, position, rotation);
    this.damage = new DamageModel(this.craft);
    this.onContactForce((e) => {
      // Fresh debris spawns overlapping the airframe; separating them isn't an impact.
      if (this.isFreshDebris(e.collider1) || this.isFreshDebris(e.collider2)) return;
      if (this.town.isFreshDebris(e.collider1, this.time) || this.town.isFreshDebris(e.collider2, this.time)) return;
      this.damage.onContact(e);
    });
    this.onContactForce((e) => this.town.onContact(e));
    this.onContactForce((e) => this.staticWorld.onContact(e));
    this.onContactForce((e) => this.voxelHit(e));

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

  private spawnPose(craft: Craft | null, site: SpawnSite | null = this.spawnSite) {
    const h = craft ? craft.restingHeight() : 3;
    let p: SpawnPoint | null = null;
    if (craft && site) {
      if (site.kind !== 'street') p = siteSpawnPoint(site);
      else if (craft.wheels.some((w) => (w.def.drive ?? 0) > 0)) p = nearestStreetPoint(this.position.x, this.position.z);
    }
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
    this.rebuildCraft(def);
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
    this.staticWorld.reset();
    this.town.reset();
    this.chips.reset();
    this.explosions.length = 0;
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
    this.exploded = false;
    this.stepImpact = 0;
    this.contactWindow = 0;
    this.failures.length = 0;
    this.filteredLoads.clear();
    this.damage.reset(this.craft);
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
    this.controls = this.exploded ? { ...neutralControls(), brake: 1 } : this.tailStrikeGuard(sanitizeControls(controls));
    (this.ctx as { controls: ControlInputs }).controls = this.controls;

    this.prevPosition.copy(this.position);
    this.prevRotation.copy(this.rotation);
    this.prevVelocity.copy(this.linvel);

    while (this.debugForces.length) this.forcePool.push(this.debugForces.pop()!);

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

    this.world.step(this.events);
    this.readBodyState();
    this.wrapAround();
    this.trails.step(this.time, this.craft, this.rotation, this.position, this.linvel.length(), this.craft.wheels.some((w) => w.grounded));
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
      const axialProjection = shape.type === 'cylinder' ? up[shape.axis ?? 'y'] : 0;
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

  private hazardDamage(partId: string, energyJ: number, cause: 'lightning' | 'fire'): void {
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
   */
  private planetForces(): void {
    const R = PLANET.radius;
    const lift = (y: number, vx: number, vz: number) => {
      const r = R + Math.max(0, y);
      return PLANET.gravity - PLANET.gravity * (R / r) ** 2 + (vx * vx + vz * vz) / r;
    };
    const b = this.craft.body;
    b.addForce({ x: 0, y: b.mass() * lift(this.position.y, this.linvel.x, this.linvel.z), z: 0 }, true);
    for (const d of this.debris) {
      const t = d.body.translation();
      const v = d.body.linvel();
      d.body.applyImpulse({ x: 0, y: d.body.mass() * lift(t.y, v.x, v.z) * this.dt, z: 0 }, true);
    }
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
  private explodeSpeed(): number {
    const parts = this.craft.parts;
    const avg = parts.length ? parts.reduce((a, p) => a + Math.min(3, Math.max(0, p.reinforce ?? 0)), 0) / parts.length : 0;
    return TUNING.explodeSpeed * (1 + 0.3 * avg);
  }

  /**
   * Voxel damage: a craft collider struck hard bites 0.25 m voxels out of its part at the actual
   * contact point; the bitten voxels fly off as chips. Integrity (voxels left) scales the part's
   * mass, lift, thrust; below `TUNING.voxelBreakIntegrity` the part breaks off.
   */
  private voxelHit(e: ContactForceInfo): void {
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
      const tol = craft.massProps.mass * (gear ? TUNING.gearSinkLimit : TUNING.impactSafeSpeed) * (1 + 0.5 * level);
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
    this.trails.derez(this.time); // a derezzed vehicle's trails go with it
    const c = this.position.clone();
    const radius = 10 + Math.min(20, this.craft.fuel * 0.15);
    this.explosions.push({ x: c.x, y: c.y, z: c.z, time: this.time, radius });
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
      this.chips.emit({ x: t.x, y: t.y, z: t.z, radius: 1.5, vx: dir.x * kick * 0.6, vy: 6, vz: dir.z * kick * 0.6, speed: 14, count: 40, size: 0.25, color: d.part.color });
    }
    this.chips.emit({ x: c.x, y: c.y, z: c.z, radius: 2, vx: 0, vy: 8, vz: 0, speed: 22, count: 220, size: 0.35, color: '#ff8a1f' });
    // Blast: crater whatever stands within the radius.
    this.staticWorld.blastAt(c.x, c.y, c.z, radius, this.time);
    for (const b of this.town.buildings) this.town.blast(b, c.x, c.y, c.z, radius * 0.6, this.time);
    this.version++;
  }

  private breakPart(partId: string, load: number, strength: number, cause: 'load' | 'impact' | 'lightning' | 'fire'): void {
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
      this.resetToRunway();
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
