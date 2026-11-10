import * as THREE from 'three';
import { CRAFT_GROUPS } from '../sim/collisionGroups.ts';
import { style1982 } from './style1982.ts';
import { PartVoxels } from './voxels.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../tuning.ts';
import { AeroSurface } from '../modules/AeroSurface.ts';
import { Buoyancy } from '../modules/Buoyancy.ts';
import { Engine } from '../modules/Engine.ts';
import { FlightController } from '../modules/FlightController.ts';
import type { ForceModule } from '../modules/ForceModule.ts';
import { FuelTank } from '../modules/FuelTank.ts';
import { createModule, stepOrder } from '../modules/registry.ts';
import { Rotor } from '../modules/Rotor.ts';
import { Wheel } from '../modules/Wheel.ts';
import { ElectricalSystem } from './ElectricalSystem.ts';
import { computeMassProperties, partQuaternion, type MassProperties } from './massProperties.ts';
import type { CraftDef, PartDef } from './types.ts';

const v3 = (t: [number, number, number] | undefined, out = new THREE.Vector3()) =>
  t ? out.set(t[0], t[1], t[2]) : out.set(0, 0, 0);

/**
 * Physics side of a craft: ONE Rapier rigid body whose mass/CoM/inertia come from the parts
 * (plus the fuel they carry), one collider per part, and the force modules. Parts can break
 * off: they leave the body and become free-falling debris. No rendering in here.
 */
export class Craft {
  readonly def: CraftDef;
  readonly body: RAPIER.RigidBody;
  modules: ForceModule[] = [];
  massProps: MassProperties;
  /** Debug CoM shift (craft-local, m). */
  readonly comOffset = new THREE.Vector3();
  /** Parts still attached. */
  parts: PartDef[];
  /** Each part as 0.25 m voxels: impacts bite them away (see PartVoxels). */
  readonly voxels = new Map<string, PartVoxels>();
  /** Ids of parts that broke off. */
  readonly detached = new Set<string>();
  /** Structural strength per part id (N). Infinity = unbreakable. */
  readonly strength = new Map<string, number>();

  /** The craft's DC bus (batteries, generators, motors, avionics), or null if it has none. */
  electrical: ElectricalSystem | null = null;

  private readonly colliders = new Map<string, RAPIER.Collider>();
  /** Reverse map: Rapier collider handle -> part id (for contact events). */
  private readonly partByCollider = new Map<number, string>();
  private massAtLastUpdate = 0;

  constructor(
    private readonly world: RAPIER.World,
    def: CraftDef,
    position: THREE.Vector3,
    rotation: THREE.Quaternion,
  ) {
    // Every craft wears the 1982 palette, whoever designed it (AGENTS.md §4-5).
    def = style1982(def);
    this.def = def;
    this.parts = [...def.parts];
    for (const p of this.parts) this.voxels.set(p.id, new PartVoxels(p.shape));

    for (const part of def.parts) {
      const partPos = v3(part.position);
      const partRot = partQuaternion(part);
      for (const m of part.modules ?? []) {
        const pos = v3(m.offset).applyQuaternion(partRot).add(partPos);
        this.modules.push(createModule(part, m, pos, partRot.clone()));
      }
    }
    this.modules.sort((a, b) => stepOrder(a) - stepOrder(b));

    this.massProps = this.computeMass();
    const mp = this.massProps;
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation(rotation)
      .setAdditionalMassProperties(mp.mass, mp.com, mp.principal, mp.principalFrame)
      .setAngularDamping(TUNING.angularDamping)
      .setLinearDamping(TUNING.linearDamping)
      .setCanSleep(false)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(bodyDesc);
    // Contact force events above ~3 g of the craft's weight feed the impact damage model.
    const eventThreshold = TUNING.impactForceThreshold * mp.mass * TUNING.gravity;
    for (const part of def.parts) {
      if (part.collider === false) continue;
      const desc = colliderFor(part)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(eventThreshold)
        .setCollisionGroups(CRAFT_GROUPS) // never collides with its own light walls
        .setSolverGroups(CRAFT_GROUPS);
      const col = world.createCollider(desc, this.body);
      this.colliders.set(part.id, col);
      this.partByCollider.set(col.handle, part.id);
    }
    this.massAtLastUpdate = mp.mass;
    this.computeStrengths();
    this.linkModules();
  }

  /** Part id owning a collider handle, or undefined if it isn't (any longer) one of ours. */
  partIdForCollider(handle: number): string | undefined {
    return this.partByCollider.get(handle);
  }

  /**
   * Soft CCD: when fast, predict contacts about a step and a half ahead so thin obstacles are
   * met before the body tunnels into them (hard CCD is always on as the backstop).
   */
  updateSoftCcd(dt: number): void {
    const v = this.body.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    // Quantised to 0.5 m so the WASM setter isn't called on every step.
    const prediction = speed > TUNING.softCcdMinSpeed ? Math.min(50, Math.ceil(speed * dt * 3) / 2) : 0;
    if (prediction !== this.softCcd) {
      this.body.setSoftCcdPrediction(prediction);
      this.softCcd = prediction;
    }
  }
  private softCcd = 0;

  // ---------------------------------------------------------------- module views
  get aeroSurfaces(): AeroSurface[] {
    return this.modules.filter((m): m is AeroSurface => m instanceof AeroSurface);
  }
  get engines(): Engine[] {
    return this.modules.filter((m): m is Engine => m instanceof Engine);
  }
  get wheels(): Wheel[] {
    return this.modules.filter((m): m is Wheel => m instanceof Wheel);
  }
  get fuelTanks(): FuelTank[] {
    return this.modules.filter((m): m is FuelTank => m instanceof FuelTank);
  }
  get rotors(): Rotor[] {
    return this.modules.filter((m): m is Rotor => m instanceof Rotor);
  }
  get gasCells(): Buoyancy[] {
    return this.modules.filter((m): m is Buoyancy => m instanceof Buoyancy);
  }
  get flightController(): FlightController | undefined {
    return this.modules.find((m): m is FlightController => m instanceof FlightController);
  }

  // ---------------------------------------------------------------- mass, fuel, water, ice
  /** Water clinging to the airframe in rain (kg). */
  water = 0;

  /** Total external surface area of the attached parts (m²): where rain film collects. */
  get wettedArea(): number {
    let a = 0;
    for (const p of this.parts) {
      const s = p.shape;
      if (s.type === 'box') a += 2 * (s.size[0] * s.size[1] + s.size[1] * s.size[2] + s.size[0] * s.size[2]);
      else if (s.type === 'sphere') a += 4 * Math.PI * s.radius * s.radius;
      else a += 2 * Math.PI * s.radius * (s.radius + s.length);
    }
    return a;
  }

  /** Thickest ice on any surface or rotor blade (m). */
  get maxIce(): number {
    let m = 0;
    for (const s of this.aeroSurfaces) m = Math.max(m, s.ice);
    for (const r of this.rotors) m = Math.max(m, r.ice);
    return m;
  }

  private get iceMass(): number {
    return this.aeroSurfaces.reduce((a, s) => a + s.iceMass, 0) + this.rotors.reduce((a, r) => a + r.iceMass, 0);
  }

  /**
   * Rain wets every surface: a film ~0.05-0.2 mm thick (heavier rain, thicker film) builds up
   * over ~20 s and dries over minutes (faster with airflow). Snow sticks less. Ice mass comes
   * from the surfaces. Mass properties update once the change is worth it.
   */
  updateWeatherMass(precipRate: number, kind: 'none' | 'rain' | 'snow', airspeed: number, dt: number): void {
    const film = kind === 'none' ? 0 : (0.05e-3 + 0.15e-3 * Math.min(1, precipRate / 50)) * (kind === 'snow' ? 0.5 : 1);
    const target = film * this.wettedArea * 1000;
    const tau = target > this.water ? 20 : 240 / (1 + airspeed / 20);
    this.water += (target - this.water) * (1 - Math.exp(-dt / tau));
    if (Math.abs(this.massAtLastUpdate - (this.massPartsOnly() + this.fuel + this.water + this.iceMass)) > 0.3) this.applyMass();
  }

  /** Parts plus fuel, water film and ice (as point masses) -> mass properties. */
  private computeMass(): MassProperties {
    const fuelMasses: PartDef[] = this.fuelTanks
      .filter((t) => t.fuel > 0.01)
      .map((t) => ({
        id: `fuel:${t.partId}`,
        kind: 'fuel',
        mass: t.fuel,
        position: [t.localPosition.x, t.localPosition.y, t.localPosition.z],
        shape: { type: 'sphere', radius: 0.2 },
        color: '#000',
      }));
    const extra: PartDef[] = [];
    const point = (id: string, mass: number, pos: THREE.Vector3): PartDef => ({
      id,
      kind: id,
      mass,
      position: [pos.x, pos.y, pos.z],
      shape: { type: 'sphere', radius: 0.2 },
      color: '#000',
    });
    if (this.water > 0.01) {
      // Spread over the airframe: put it at the parts' area-weighted centre.
      const c = new THREE.Vector3();
      let w = 0;
      for (const p of this.parts) {
        const m = Math.max(0.01, p.mass);
        c.x += p.position[0] * m;
        c.y += p.position[1] * m;
        c.z += p.position[2] * m;
        w += m;
      }
      extra.push(point('water', this.water, c.divideScalar(w)));
    }
    for (const s of this.aeroSurfaces) if (s.iceMass > 0.01) extra.push(point(`ice:${s.partId}`, s.iceMass, s.localPosition));
    for (const r of this.rotors) if (r.iceMass > 0.001) extra.push(point(`ice:${r.partId}`, r.iceMass, r.localPosition));
    const parts = this.parts.map((p) => ({ ...p, mass: this.effectiveMass(p) }));
    return computeMassProperties([...parts, ...fuelMasses, ...extra], this.comOffset);
  }

  private applyMass(): void {
    this.massProps = this.computeMass();
    const mp = this.massProps;
    this.body.setAdditionalMassProperties(mp.mass, mp.com, mp.principal, mp.principalFrame, true);
    this.massAtLastUpdate = mp.mass;
    const eventThreshold = TUNING.impactForceThreshold * mp.mass * TUNING.gravity;
    for (const col of this.colliders.values()) col.setContactForceEventThreshold(eventThreshold);
    this.linkModules();
  }

  get fuel(): number {
    return this.fuelTanks.reduce((s, t) => s + t.fuel, 0);
  }
  get fuelCapacity(): number {
    return this.fuelTanks.reduce((s, t) => s + t.capacity, 0);
  }

  /** Take fuel from the tanks, fullest first. Returns kg delivered. */
  drawFuel(kg: number): number {
    let need = kg;
    const tanks = this.fuelTanks.filter((t) => t.fuel > 0).sort((a, b) => b.fuel - a.fuel);
    for (const t of tanks) {
      const take = Math.min(t.fuel, need);
      t.fuel -= take;
      need -= take;
      if (need <= 0) break;
    }
    return kg - need;
  }

  /** Recompute mass properties once enough fuel has burned to matter. */
  updateFuelMass(): void {
    if (this.fuelTanks.length && Math.abs(this.massAtLastUpdate - (this.massPartsOnly() + this.fuel)) > 0.5) this.applyMass();
  }

  private massPartsOnly(): number {
    return this.parts.reduce((s, p) => s + this.effectiveMass(p), 0);
  }

  /** Part mass after reinforcement (+15% per level) and voxel loss. */
  effectiveMass(p: PartDef): number {
    return p.mass * (1 + 0.15 * reinforceLevel(p)) * Math.max(0.1, this.voxels.get(p.id)?.integrity ?? 1);
  }

  /** Voxels were bitten off a part: update its modules and, if it matters, the mass. */
  voxelsChanged(partId: string): void {
    const v = this.voxels.get(partId);
    if (!v) return;
    for (const m of this.modules) if (m.partId === partId) (m as { integrity?: number }).integrity = v.integrity;
    if (Math.abs(this.massAtLastUpdate - (this.massPartsOnly() + this.fuel + this.water)) > 0.5) this.applyMass();
  }

  /** Shift the centre of mass (debug slider). Inertia is kept; only the CoM moves. */
  setComOffset(offset: THREE.Vector3): void {
    this.comOffset.copy(offset);
    this.applyMass();
  }

  // ---------------------------------------------------------------- structure
  private computeStrengths(): void {
    const weight = this.massProps.mass * TUNING.gravity;
    const n = new THREE.Vector3();
    let totalArea = 0;
    for (const s of this.aeroSurfaces) totalArea += s.area;
    const wheels = this.wheels.length || 1;
    for (const part of this.parts) {
      const k = (1 + 0.6 * reinforceLevel(part)) * Math.max(1, this.def.armor ?? 1);
      if (part.strength !== undefined) {
        this.strength.set(part.id, part.strength > 0 ? part.strength * k : Infinity);
        continue;
      }
      const mods = this.modules.filter((m) => m.partId === part.id);
      let s = Infinity;
      const surfaces = mods.filter((m): m is AeroSurface => m instanceof AeroSurface);
      if (surfaces.length && totalArea > 0) {
        // Each surface carries its area share of the weight at the limit load factor. Tails and
        // fins get a floor so they don't snap at the first sideslip.
        const area = surfaces.reduce((a, m) => a + m.area, 0);
        const horizontal = surfaces.some((m) => Math.abs(m.localNormal(n).y) > 0.5);
        const share = Math.max(area / totalArea, horizontal ? 0 : 0.15);
        s = Math.min(s, TUNING.limitLoadFactor * weight * Math.max(share, 0.12));
      }
      if (mods.some((m) => m instanceof Wheel)) s = Math.min(s, (TUNING.gearLimitG * weight) / wheels);
      const rotors = mods.filter((m): m is Rotor => m instanceof Rotor);
      if (rotors.length) s = Math.min(s, 3 * rotors.reduce((a, r) => a + Math.abs(r.staticThrust()), 0) + weight);
      // Never let a bad estimate make a part fall off at rest.
      this.strength.set(part.id, Number.isFinite(s) ? Math.max(s, 0.5 * weight) * k : Infinity);
    }
  }

  /**
   * Break a part off: its collider, modules, mass and fuel leave the craft, and it becomes a
   * free-falling debris body carrying the velocity it had. Returns the debris body.
   */
  detachPart(partId: string): RAPIER.RigidBody | null {
    const part = this.parts.find((p) => p.id === partId);
    if (!part) return null;
    const bodyPos = this.body.translation();
    const bodyRot = this.body.rotation();
    const q = new THREE.Quaternion(bodyRot.x, bodyRot.y, bodyRot.z, bodyRot.w);
    const worldPos = v3(part.position).applyQuaternion(q).add(new THREE.Vector3(bodyPos.x, bodyPos.y, bodyPos.z));
    const worldRot = q.clone().multiply(partQuaternion(part));
    // Velocity of that point on the craft.
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const com = this.body.worldCom();
    const r = worldPos.clone().sub(new THREE.Vector3(com.x, com.y, com.z));
    const w = new THREE.Vector3(av.x, av.y, av.z);
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z).add(w.clone().cross(r));

    const col = this.colliders.get(partId);
    if (col) {
      this.partByCollider.delete(col.handle);
      this.world.removeCollider(col, true);
    }
    this.colliders.delete(partId);
    this.parts = this.parts.filter((p) => p.id !== partId);
    this.voxels.delete(partId);
    this.modules = this.modules.filter((m) => m.partId !== partId);
    this.detached.add(partId);
    if (this.parts.length) this.applyMass();

    const debris = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(worldPos.x, worldPos.y, worldPos.z)
        .setRotation(worldRot)
        .setLinvel(vel.x, vel.y, vel.z)
        .setAngvel(w)
        .setLinearDamping(0.05)
        .setAngularDamping(0.3)
        // Fast debris (a wing shed at 300 m/s) must not tunnel through walls or the ground.
        .setCcdEnabled(vel.length() > TUNING.debrisCcdSpeed),
    );
    const desc = colliderFor({ ...part, position: [0, 0, 0], rotationDeg: [0, 0, 0] }).setDensity(0).setMass(part.mass);
    this.world.createCollider(desc, debris);
    return debris;
  }

  private linkModules(): void {
    for (const m of this.modules) {
      if (m instanceof FlightController) m.link(this.modules, this.massProps.com, this.massProps.mass);
      else m.link?.(this.modules);
    }
    // The bus is stateless apart from what its modules hold (SoC, failures), so relinking after
    // mass updates or lost parts keeps the charge.
    if (this.electrical) {
      // Keep an empty bus after the last electrical part breaks off: losing the battery must
      // not turn the remaining flight computer into a legacy, self-powered controller.
      this.electrical.link(this.modules);
    } else if (ElectricalSystem.needed(this.modules)) this.electrical = new ElectricalSystem(this.modules);
    else for (const m of this.modules) if (m instanceof FlightController) m.powered = true;
  }

  /** Solve the electrical bus for this step. Call before the force modules step. */
  stepElectrical(dt: number, ambientC?: number): void {
    this.electrical?.step(dt, ambientC);
  }

  /**
   * An electrical surge of `energyJ` coupled into the craft's wiring (lightning strike, short):
   * may burn out avionics and heats/damages the batteries. No effect without an electrical bus.
   */
  onElectricalSpike(energyJ: number): void {
    this.electrical?.spike(energyJ);
  }

  // ---------------------------------------------------------------- geometry helpers
  /** Craft-local centre of mass. */
  centerOfMass(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.massProps.com);
  }

  /**
   * Craft-local centre of lift for pitch (static neutral point estimate): lift-slope-weighted
   * average of the surfaces, weighted by how horizontal each surface is and reduced for the
   * downwash each one sits in. If the CoM is behind
   * this point the craft is pitch-unstable.
   */
  centerOfLift(out = new THREE.Vector3()): THREE.Vector3 {
    out.set(0, 0, 0);
    let w = 0;
    const n = new THREE.Vector3();
    for (const s of this.aeroSurfaces) {
      const horiz = Math.abs(s.localNormal(n).y);
      // Downwash from surfaces ahead reduces this surface's effective lift slope by (1 - dε/dα).
      const wi = s.liftSlope * s.area * horiz * Math.max(0, 1 - s.downwashGradient);
      out.addScaledVector(s.localPosition, wi);
      w += wi;
    }
    return w > 0 ? out.divideScalar(w) : out.copy(this.massProps.com);
  }

  /** Craft-local thrust-weighted centre of thrust (engines and lift rotors). */
  centerOfThrust(out = new THREE.Vector3()): THREE.Vector3 {
    out.set(0, 0, 0);
    let w = 0;
    for (const e of this.engines) {
      out.addScaledVector(e.localPosition, e.def.maxThrust);
      w += e.def.maxThrust;
    }
    for (const r of this.rotors) {
      out.addScaledVector(r.localPosition, 1);
      w += 1;
    }
    return w > 0 ? out.divideScalar(w) : out.copy(this.massProps.com);
  }

  /** Rough bounding radius around the CoM (m), for camera framing. */
  boundingRadius(): number {
    let r = 1;
    const c = this.massProps.com;
    for (const p of this.parts) {
      const s = p.shape;
      const ext = s.type === 'box' ? Math.hypot(...s.size) / 2 : s.type === 'sphere' ? s.radius : Math.hypot(s.radius, s.length / 2);
      r = Math.max(r, Math.hypot(p.position[0] - c.x, p.position[1] - c.y, p.position[2] - c.z) + ext);
    }
    return r;
  }

  /** Height of the craft origin above the ground when resting on its wheels (or belly/skids). */
  restingHeight(): number {
    let lowest = Infinity;
    for (const w of this.wheels) {
      lowest = Math.min(lowest, w.localPosition.y - w.def.restLength - w.def.radius);
    }
    // Colliders (skids, belly) can be lower than the wheels.
    for (const p of this.parts) if (p.collider !== false) lowest = Math.min(lowest, p.position[1] - halfHeight(p));
    if (!Number.isFinite(lowest)) for (const p of this.parts) lowest = Math.min(lowest, p.position[1] - halfHeight(p));
    return -lowest + 0.05;
  }

  /**
   * Nose-up pitch (deg) at which the airframe first touches the ground when the craft rotates
   * about its main wheels (null: no wheels behind the CoM, e.g. skids or a tail-dragger).
   * Every collider part's box corners behind the main wheels are checked.
   */
  tailStrikeAngle(): number | null {
    if (this._tailStrike !== undefined) return this._tailStrike;
    const com = this.massProps.com;
    let zMain = -Infinity;
    let yContact = 0;
    for (const w of this.wheels) {
      if (w.localPosition.z <= com.z) continue; // main wheels sit behind the CoM
      if (w.localPosition.z > zMain) {
        zMain = w.localPosition.z;
        yContact = w.localPosition.y - w.def.restLength * 0.75 - w.def.radius; // ~static compression
      }
    }
    if (!Number.isFinite(zMain)) return (this._tailStrike = null);
    let best = Infinity;
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    for (const p of this.parts) {
      if (p.collider === false) continue;
      const s = p.shape;
      const e = s.type === 'box' ? [s.size[0] / 2, s.size[1] / 2, s.size[2] / 2]
        : s.type === 'sphere' ? [s.radius, s.radius, s.radius]
        : s.axis === 'x' ? [s.length / 2, s.radius, s.radius] : s.axis === 'y' ? [s.radius, s.length / 2, s.radius] : [s.radius, s.radius, s.length / 2];
      partQuaternion(p, q);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        v.set(sx * e[0], sy * e[1], sz * e[2]).applyQuaternion(q).add(new THREE.Vector3(...p.position));
        const back = v.z - zMain;
        if (back < 0.3) continue;
        best = Math.min(best, (Math.atan2(v.y - yContact, back) * 180) / Math.PI);
      }
    }
    return (this._tailStrike = Number.isFinite(best) ? best : null);
  }
  private _tailStrike: number | null | undefined;

  /** Teleport and zero all motion and module state. */
  reset(position: THREE.Vector3, rotation: THREE.Quaternion): void {
    this.body.setTranslation(position, true);
    this.body.setRotation(rotation, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    for (const m of this.modules) m.reset();
    this.electrical?.reset();
    this.water = 0;
    for (const p of this.parts) this.voxels.set(p.id, new PartVoxels(p.shape));
    for (const m of this.modules) (m as { integrity?: number }).integrity = 1;
    this.applyMass();
  }
}

/** Reinforcement level 0..3 of a part. */
export function reinforceLevel(p: PartDef): number {
  return Math.min(3, Math.max(0, Math.round(p.reinforce ?? 0)));
}

function halfHeight(p: PartDef): number {
  const s = p.shape;
  if (s.type === 'box') return s.size[1] / 2;
  if (s.type === 'sphere') return s.radius;
  return (s.axis ?? 'y') === 'y' ? s.length / 2 : s.radius;
}

function colliderFor(part: PartDef): RAPIER.ColliderDesc {
  const s = part.shape;
  let desc: RAPIER.ColliderDesc;
  const rot = partQuaternion(part);
  if (s.type === 'box') desc = RAPIER.ColliderDesc.cuboid(s.size[0] / 2, s.size[1] / 2, s.size[2] / 2);
  else if (s.type === 'sphere') desc = RAPIER.ColliderDesc.ball(s.radius);
  else {
    desc = RAPIER.ColliderDesc.cylinder(s.length / 2, s.radius);
    // Rapier cylinders are along Y; rotate for other axes.
    const axis = s.axis ?? 'y';
    if (axis !== 'y') {
      const extra = new THREE.Quaternion().setFromAxisAngle(
        axis === 'x' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0),
        Math.PI / 2,
      );
      rot.multiply(extra);
    }
  }
  return desc
    .setTranslation(part.position[0], part.position[1], part.position[2])
    .setRotation(rot)
    .setDensity(0) // mass comes from setAdditionalMassProperties
    .setFriction(TUNING.airframeFriction)
    .setRestitution(TUNING.airframeRestitution);
}
