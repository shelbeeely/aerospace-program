import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '../tuning.ts';
import { AeroSurface } from '../modules/AeroSurface.ts';
import { Engine } from '../modules/Engine.ts';
import type { ForceModule } from '../modules/ForceModule.ts';
import { createModule } from '../modules/registry.ts';
import { Wheel } from '../modules/Wheel.ts';
import { computeMassProperties, partQuaternion, type MassProperties } from './massProperties.ts';
import type { CraftDef, PartDef } from './types.ts';

const v3 = (t: [number, number, number] | undefined, out = new THREE.Vector3()) =>
  t ? out.set(t[0], t[1], t[2]) : out.set(0, 0, 0);

/**
 * Physics side of a craft: ONE Rapier rigid body whose mass/CoM/inertia come from the parts,
 * one collider per part, and the force modules. No rendering in here.
 */
export class Craft {
  readonly def: CraftDef;
  readonly body: RAPIER.RigidBody;
  readonly modules: ForceModule[] = [];
  massProps: MassProperties;
  /** Debug CoM shift (craft-local, m). */
  readonly comOffset = new THREE.Vector3();

  constructor(world: RAPIER.World, def: CraftDef, position: THREE.Vector3, rotation: THREE.Quaternion) {
    this.def = def;
    this.massProps = computeMassProperties(def.parts);
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

    for (const part of def.parts) {
      if (part.collider !== false) world.createCollider(colliderFor(part), this.body);
      const partPos = v3(part.position);
      const partRot = partQuaternion(part);
      for (const m of part.modules ?? []) {
        const pos = v3(m.offset).applyQuaternion(partRot).add(partPos);
        this.modules.push(createModule(part, m, pos, partRot.clone()));
      }
    }
  }

  get aeroSurfaces(): AeroSurface[] {
    return this.modules.filter((m): m is AeroSurface => m instanceof AeroSurface);
  }
  get engines(): Engine[] {
    return this.modules.filter((m): m is Engine => m instanceof Engine);
  }
  get wheels(): Wheel[] {
    return this.modules.filter((m): m is Wheel => m instanceof Wheel);
  }

  /** Shift the centre of mass (debug slider). Inertia is kept; only the CoM moves. */
  setComOffset(offset: THREE.Vector3): void {
    this.comOffset.copy(offset);
    this.massProps = computeMassProperties(this.def.parts, this.comOffset);
    const mp = this.massProps;
    this.body.setAdditionalMassProperties(mp.mass, mp.com, mp.principal, mp.principalFrame, true);
  }

  /** Craft-local centre of mass. */
  centerOfMass(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.massProps.com);
  }

  /**
   * Craft-local centre of lift for pitch (static neutral point estimate): lift-slope-weighted
   * average of the surfaces, weighted by how horizontal each surface is. If the CoM is behind
   * this point the craft is pitch-unstable.
   */
  centerOfLift(out = new THREE.Vector3()): THREE.Vector3 {
    out.set(0, 0, 0);
    let w = 0;
    const n = new THREE.Vector3();
    for (const s of this.aeroSurfaces) {
      const horiz = Math.abs(s.localNormal(n).y);
      const wi = s.liftSlope * s.area * horiz;
      out.addScaledVector(s.localPosition, wi);
      w += wi;
    }
    return w > 0 ? out.divideScalar(w) : out.copy(this.massProps.com);
  }

  /** Craft-local thrust-weighted centre of thrust. */
  centerOfThrust(out = new THREE.Vector3()): THREE.Vector3 {
    out.set(0, 0, 0);
    let w = 0;
    for (const e of this.engines) {
      out.addScaledVector(e.localPosition, e.def.maxThrust);
      w += e.def.maxThrust;
    }
    return w > 0 ? out.divideScalar(w) : out.copy(this.massProps.com);
  }

  /** Height of the craft origin above the ground when resting on its wheels (or belly). */
  restingHeight(): number {
    let lowest = Infinity;
    for (const w of this.wheels) {
      lowest = Math.min(lowest, w.localPosition.y - w.def.restLength - w.def.radius);
    }
    if (!Number.isFinite(lowest)) {
      for (const p of this.def.parts) lowest = Math.min(lowest, p.position[1] - halfHeight(p));
    }
    return -lowest + 0.05;
  }

  /** Teleport and zero all motion and module state. */
  reset(position: THREE.Vector3, rotation: THREE.Quaternion): void {
    this.body.setTranslation(position, true);
    this.body.setRotation(rotation, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    for (const m of this.modules) m.reset();
  }
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
