import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { ControlInputs } from '../sim/controls.ts';

/** Category used for debug vector colours. */
export type ForceKind = 'lift' | 'drag' | 'thrust' | 'wheel';

export interface DebugForce {
  kind: ForceKind;
  /** World-space application point. */
  point: THREE.Vector3;
  /** World-space force (N). */
  force: THREE.Vector3;
}

/**
 * Everything a force module may read during a physics step. Vectors are world space unless
 * noted. Do not keep references to these between steps; they are reused.
 */
export interface StepContext {
  dt: number;
  world: RAPIER.World;
  body: RAPIER.RigidBody;
  controls: Readonly<ControlInputs>;
  /** Body origin position and rotation (craft-local frame -> world). */
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  /** Centre of mass (world) and its velocity. */
  com: THREE.Vector3;
  linvel: THREE.Vector3;
  angvel: THREE.Vector3;
  /** Air density at an altitude (m). */
  airDensity(altitude: number): number;
  /** Velocity of a world point rigidly attached to the body (includes angular contribution). */
  pointVelocity(worldPoint: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /** Craft-local point -> world. */
  toWorldPoint(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /** Craft-local direction -> world. */
  toWorldDir(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /**
   * Apply a world force at a world point. Non-finite forces are dropped. The force is also
   * recorded for the F3 debug overlay.
   */
  applyForce(kind: ForceKind, force: THREE.Vector3, point: THREE.Vector3): void;
}

/**
 * A composable component attached to a part that produces forces. To add a new one:
 * implement this interface, add its def type to `craft/types.ts`, and register a factory in
 * `modules/registry.ts`.
 */
export interface ForceModule {
  readonly type: string;
  /** Id of the part this module is attached to. */
  readonly partId: string;
  /** Module origin in craft-local coordinates. */
  readonly localPosition: THREE.Vector3;
  /** Module orientation in craft-local coordinates. */
  readonly localRotation: THREE.Quaternion;
  /** Called on spawn/reset. Clear any internal state (spool, suspension history...). */
  reset(): void;
  /** Compute and apply forces for one fixed physics step. */
  step(ctx: StepContext): void;
}
