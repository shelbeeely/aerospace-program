import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Craft } from '../craft/Craft.ts';
import type { CraftDef, PartDef } from '../craft/types.ts';
import { validateCraft } from '../craft/validate.ts';
import type { DebugForce, ForceKind, StepContext } from '../modules/ForceModule.ts';
import { TUNING } from '../tuning.ts';
import { Atmosphere, calmWeather, densityAltitude, type CloudSample, type Precipitation, type WeatherSettings } from './atmosphere.ts';
import { DamageModel, type ContactForceHandler, type ContactForceInfo } from './damage.ts';
import { neutralControls, sanitizeControls, type ControlInputs } from './controls.ts';
import { LAYOUT } from './layout.ts';
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
export class Simulation {
  readonly dt = 1 / TUNING.physicsHz;
  readonly world: RAPIER.World;
  readonly atmosphere: Atmosphere;
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
  readonly failures: Array<{ partId: string; load: number; strength: number; time: number; cause?: 'load' | 'impact' }> = [];
  debris: Debris[] = [];
  /** Contact events of every world step (one persistent queue; drained each step). */
  readonly events = new RAPIER.EventQueue(true);
  /** Per-part impact hit points. */
  damage: DamageModel;
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

    const half = LAYOUT.groundSize / 2;
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -5, 0));
    this.groundCollider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half, 5, half).setFriction(0.8).setRestitution(0.1),
      ground,
    );

    const { position, rotation } = this.spawnPose(null);
    this.craft = new Craft(this.world, craftDef, position, rotation);
    this.damage = new DamageModel(this.craft);
    this.onContactForce((e) => {
      // Fresh debris spawns overlapping the airframe; separating them isn't an impact.
      if (this.isFreshDebris(e.collider1) || this.isFreshDebris(e.collider2)) return;
      this.damage.onContact(e);
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
      groundHeight: () => 0,
      pointVelocity(p, out) {
        _tmp.copy(p).sub(self.com);
        return out.crossVectors(self.angvel, _tmp).add(self.linvel);
      },
      airVelocity(p, out) {
        this.pointVelocity(p, out);
        return out.sub(self.atmosphere.windAt(p, 0, _wind));
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

  private spawnPose(craft: Craft | null) {
    const h = craft ? craft.restingHeight() : 3;
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
    this.resetToRunway();
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
      this.world.contactPair(this.groundCollider, this.craft.body.collider(i), (m) => {
        // Ignore speculative (predicted, not yet touching) contacts from soft CCD.
        for (let j = 0; j < m.numContacts() && !touching; j++) if (m.contactDist(j) < 0.02) touching = true;
      });
    }
    return touching;
  }

  resetToRunway(): void {
    // Broken craft are rebuilt from their definition; debris is cleared away.
    for (const d of this.debris) this.world.removeRigidBody(d.body);
    this.debris = [];
    this.debrisSpawn.clear();
    if (this.craft.detached.size) this.rebuildCraft(this.craft.def);
    this.failures.length = 0;
    this.filteredLoads.clear();
    this.damage.reset(this.craft);
    const { position, rotation } = this.spawnPose(this.craft);
    this.craft.reset(position, rotation);
    this.atmosphere.restart();
    this.settleGroundWater();
    this.controls = neutralControls();
    this.prevVelocity.set(0, 0, 0);
    this.gForceFiltered = 1;
    this.readBodyState();
    this.prevPosition.copy(this.position);
    this.prevRotation.copy(this.rotation);
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
    this.controls = sanitizeControls(controls);
    (this.ctx as { controls: ControlInputs }).controls = this.controls;

    this.prevPosition.copy(this.position);
    this.prevRotation.copy(this.rotation);
    this.prevVelocity.copy(this.linvel);

    while (this.debugForces.length) this.forcePool.push(this.debugForces.pop()!);

    this.atmosphere.advance(this.dt);
    const body = this.craft.body;
    body.resetForces(false);
    body.resetTorques(false);
    this.readBodyState();
    this.loadsThisStep.clear();
    this.craft.stepElectrical(this.dt, this.atmosphere.air(this.com.y).temperature - 273.15);
    for (const m of this.craft.modules) m.step(this.ctx);
    this.craft.updateSoftCcd(this.dt);

    this.world.step(this.events);
    this.readBodyState();
    const resets = this.explosionResets;
    this.guardAgainstExplosion();
    // After an explosion reset the step's contacts belong to a craft that's gone: drop them.
    this.dispatchContactForces(resets === this.explosionResets);
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
      const strength = this.craft.strength.get(partId) ?? Infinity;
      if (f > strength) broken.push([partId, f, strength]);
    }
    for (const [partId, load, strength] of broken) this.breakPart(partId, load, strength, 'load');
  }

  /** Detach parts whose impact HP ran out (same failure path as structural overload). */
  private applyImpactDamage(): void {
    for (const f of this.damage.flush(this.time)) this.breakPart(f.partId, f.load, f.strength, 'impact');
  }

  /** Break a part off: debris body, failure record, structure version bump. */
  private breakPart(partId: string, load: number, strength: number, cause: 'load' | 'impact'): void {
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
    return this.atmosphere.windAt(this.com, 0, out);
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
      altitude: r(this.position.y - craft.restingHeight() + 0.05),
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
