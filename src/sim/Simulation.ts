import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Craft } from '../craft/Craft.ts';
import type { CraftDef, PartDef } from '../craft/types.ts';
import { validateCraft } from '../craft/validate.ts';
import type { DebugForce, ForceKind, StepContext } from '../modules/ForceModule.ts';
import { TUNING } from '../tuning.ts';
import { airDensity, Atmosphere, calmWeather, type WeatherSettings } from './atmosphere.ts';
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
  readonly failures: Array<{ partId: string; load: number; strength: number; time: number }> = [];
  debris: Debris[] = [];

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
      airDensity,
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
        if (m.numContacts() > 0) touching = true;
      });
    }
    return touching;
  }

  resetToRunway(): void {
    // Broken craft are rebuilt from their definition; debris is cleared away.
    for (const d of this.debris) this.world.removeRigidBody(d.body);
    this.debris = [];
    if (this.craft.detached.size) this.rebuildCraft(this.craft.def);
    this.failures.length = 0;
    this.filteredLoads.clear();
    const { position, rotation } = this.spawnPose(this.craft);
    this.craft.reset(position, rotation);
    this.atmosphere.restart();
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
    for (const m of this.craft.modules) m.step(this.ctx);

    this.world.step();
    this.readBodyState();
    this.guardAgainstExplosion();
    this.checkStructure();
    this.craft.updateFuelMass();

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
    for (const [partId, load, strength] of broken) {
      if (this.craft.parts.length <= 1) break; // never detach the last piece
      const part = this.craft.parts.find((p) => p.id === partId);
      const body = this.craft.detachPart(partId);
      if (part && body) {
        this.debris.push({ part, body });
        this.failures.push({ partId, load: Math.round(load), strength: Math.round(strength), time: this.time });
        this.filteredLoads.delete(partId);
        this.version++;
      }
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
      controls: { ...this.controls },
    };
  }

  get bodyCount(): number {
    return this.world.bodies.len();
  }
}
