import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { ControlInputs } from '../sim/controls.ts';
import type { AirState, Atmosphere, CloudSample, Precipitation } from '../sim/atmosphere.ts';

/** Category used for debug vector colours. */
export type ForceKind = 'lift' | 'drag' | 'thrust' | 'wheel' | 'buoyancy';

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
  atmosphere: Atmosphere;
  /** Body origin position and rotation (craft-local frame -> world). */
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  /** Centre of mass (world) and its velocity. */
  com: THREE.Vector3;
  linvel: THREE.Vector3;
  angvel: THREE.Vector3;
  /** Air density at an altitude (m), including temperature, pressure and humidity. */
  airDensity(altitude: number): number;
  /** Full air state (temperature, pressure, density, speed of sound, viscosity) at an altitude. */
  air(altitude: number): AirState;
  /** Rain/snow falling through a world point (shared object: copy what you need). */
  precipitation(worldPoint: THREE.Vector3): Precipitation;
  /** Cloud at a world point (shared object). */
  cloud(worldPoint: THREE.Vector3): CloudSample;
  /** Runway/ground wetness 0..1 (standing water builds up in rain and drains after). */
  groundWetness: number;
  /** Terrain height under a point (flat ground for now; terrain later). */
  groundHeight(x: number, z: number): number;
  /** Velocity of a world point rigidly attached to the body (includes angular contribution). */
  pointVelocity(worldPoint: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /** Velocity of that point relative to the moving air (what aerodynamics feels). */
  airVelocity(worldPoint: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /** Craft-local point -> world. */
  toWorldPoint(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /** Craft-local direction -> world. */
  toWorldDir(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /**
   * Apply a world force at a world point. Non-finite forces are dropped. The force is also
   * recorded for the F3 debug overlay.
   */
  applyForce(kind: ForceKind, force: THREE.Vector3, point: THREE.Vector3): void;
  /** Apply a pure world torque (N·m), e.g. propeller/rotor reaction torque. */
  applyTorque(torque: THREE.Vector3): void;
  /** Take up to `kg` of fuel from the craft's tanks; returns the kg actually delivered. */
  drawFuel(kg: number): number;
  /** True if the craft carries any fuel tanks (engines without tanks run forever). */
  hasFuelSystem: boolean;
  /**
   * Report the structural load (N) a module puts on its part this step. If it exceeds the
   * part's strength for long enough, the part breaks off.
   */
  structuralLoad(partId: string, newtons: number): void;
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
  /**
   * Optional: called once after all modules of a craft exist (and again after parts break
   * off), so a module can find the others it works with (e.g. a flight controller its rotors).
   */
  link?(modules: readonly ForceModule[]): void;
  /** Called on spawn/reset. Clear any internal state (spool, suspension history...). */
  reset(): void;
  /** Compute and apply forces for one fixed physics step. */
  step(ctx: StepContext): void;
}
