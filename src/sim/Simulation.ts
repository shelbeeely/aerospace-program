import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Craft } from '../craft/Craft.ts';
import type { CraftDef } from '../craft/types.ts';
import { validateCraft } from '../craft/validate.ts';
import type { DebugForce, ForceKind, StepContext } from '../modules/ForceModule.ts';
import { TUNING } from '../tuning.ts';
import { airDensity } from './atmosphere.ts';
import { neutralControls, sanitizeControls, type ControlInputs } from './controls.ts';
import { LAYOUT } from './layout.ts';
import type { Telemetry } from './telemetry.ts';

let rapierReady: Promise<void> | null = null;
/** Rapier's WASM must be initialised once before anything else. */
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

const RAD = 180 / Math.PI;
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();

/**
 * The headless simulation: Rapier world, ground, one craft, force modules, fixed-step
 * integration. Has no knowledge of rendering or input devices, so it runs in the browser and
 * in Node (see scripts/headless.ts) — the basis for AI pilots and faster-than-real-time races.
 */
export class Simulation {
  readonly dt = 1 / TUNING.physicsHz;
  readonly world: RAPIER.World;
  craft: Craft;
  time = 0;
  steps = 0;
  /** Wall-clock ms of the last physics step (for the stats panel). */
  lastStepMs = 0;
  /** Set when the NaN/explosion guard had to reset the craft. */
  explosionResets = 0;

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
  private readonly linvel = new THREE.Vector3();
  private readonly angvel = new THREE.Vector3();
  private readonly com = new THREE.Vector3();
  private readonly prevVelocity = new THREE.Vector3();
  private gForceFiltered = 1;
  private readonly ctx: StepContext;

  constructor(craftDef: CraftDef) {
    const errors = validateCraft(craftDef);
    if (errors.length) throw new Error(`Invalid craft:\n${errors.join('\n')}`);

    this.world = new RAPIER.World({ x: 0, y: -TUNING.gravity, z: 0 });
    this.world.timestep = this.dt;

    const half = LAYOUT.groundSize / 2;
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -5, 0));
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half, 5, half).setFriction(0.8).setRestitution(0.1),
      ground,
    );

    const { position, rotation } = this.spawnPose(null);
    this.craft = new Craft(this.world, craftDef, position, rotation);
    this.resetToRunway();

    const self = this;
    this.ctx = {
      dt: this.dt,
      world: this.world,
      body: this.craft.body,
      controls: this.controls,
      position: this.position,
      rotation: this.rotation,
      com: this.com,
      linvel: this.linvel,
      angvel: this.angvel,
      airDensity,
      pointVelocity(p, out) {
        _tmp.copy(p).sub(self.com);
        return out.crossVectors(self.angvel, _tmp).add(self.linvel);
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
    };
  }

  private spawnPose(craft: Craft | null) {
    const h = craft ? craft.restingHeight() : 3;
    return {
      position: new THREE.Vector3(0, h, LAYOUT.spawnZ),
      rotation: new THREE.Quaternion(),
    };
  }

  resetToRunway(): void {
    const { position, rotation } = this.spawnPose(this.craft);
    this.craft.reset(position, rotation);
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

    const body = this.craft.body;
    body.resetForces(false);
    body.resetTorques(false);
    this.readBodyState();
    for (const m of this.craft.modules) m.step(this.ctx);

    this.world.step();
    this.readBodyState();
    this.guardAgainstExplosion();

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

  telemetry(): Telemetry {
    const q = this.rotation;
    const v = this.linvel;
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

    const engines = this.craft.engines;
    const spool = engines.length ? engines.reduce((s, e) => s + e.spool, 0) / engines.length : 0;
    // Main wings = surfaces with roll control or the largest horizontal ones; use area-weighted stall.
    let stallW = 0;
    let stallSum = 0;
    const n = new THREE.Vector3();
    for (const s of this.craft.aeroSurfaces) {
      const w = s.area * Math.abs(s.localNormal(n).y);
      stallW += w;
      stallSum += s.stall * w;
    }

    const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
    return {
      time: r(this.time, 3),
      position: [r(this.position.x), r(this.position.y), r(this.position.z)],
      velocity: [r(v.x), r(v.y), r(v.z)],
      airspeed: r(speed),
      altitude: r(this.position.y - this.craft.restingHeight() + 0.05),
      verticalSpeed: r(v.y),
      heading: r(heading, 1),
      pitch: r(pitch, 1),
      roll: r(roll, 1),
      angleOfAttack: r(aoa, 1),
      sideslip: r(beta, 1),
      gForce: r(this.gForceFiltered),
      throttle: r(this.controls.throttle),
      engineSpool: r(spool),
      onGround: this.craft.wheels.some((w) => w.grounded),
      stall: r(stallW > 0 ? stallSum / stallW : 0),
      controls: { ...this.controls },
    };
  }

  get bodyCount(): number {
    return this.world.bodies.len();
  }
}
