import * as THREE from 'three';
import type { CraftDef } from './types.ts';

/**
 * Turrets. A craft with a part of kind `turret` turns it: the turret part, the barrels on it
 * (parts of kind cannon or barrel) and anything whose id starts with `turret.` swing about the
 * turret's vertical axis, and the barrels and the weapons fitted to the turret also tilt about
 * a horizontal axis at the turret's front face (the trunnion). The swing is visual and
 * ballistic: rounds leave along the barrel, the colliders stay put.
 */

const DEG = Math.PI / 180;
export const TURRET = {
  /** Traverse rate (rad/s), unlimited travel. */
  yawRate: 40 * DEG,
  /** Elevation rate (rad/s) and limits (rad). */
  pitchRate: 20 * DEG,
  pitchMin: -8 * DEG,
  pitchMax: 30 * DEG,
} as const;

export interface TurretRig {
  /** The turret part. */
  turretId: string;
  /** Parts that traverse with it (the turret itself included). */
  riders: Set<string>;
  /** Parts that also elevate: the barrels, and the turret's own fitted weapons. */
  barrels: Set<string>;
  /** Craft-frame traverse axis point and elevation axis point. */
  pivot: THREE.Vector3;
  trunnion: THREE.Vector3;
}

export interface TurretPose {
  /** Traverse (rad, + clockwise from above: to the right). */
  yaw: number;
  /** Elevation (rad, + up). */
  pitch: number;
}

/** The craft's turret, or null when it has none. */
export function turretOf(def: CraftDef): TurretRig | null {
  const turret = def.parts.find((p) => p.kind === 'turret');
  if (!turret) return null;
  const barrels = new Set(def.parts.filter((p) => /cannon|barrel/i.test(p.kind)).map((p) => p.id));
  const riders = new Set([turret.id, ...barrels, ...def.parts.filter((p) => p.id.startsWith('turret.')).map((p) => p.id)]);
  const s = turret.shape;
  const halfZ = s.type === 'box' ? s.size[2] / 2 : s.type === 'sphere' ? s.radius : s.axis === 'z' ? s.length / 2 : s.radius;
  const barrel = def.parts.find((p) => barrels.has(p.id));
  const pivot = new THREE.Vector3(...turret.position);
  const trunnion = new THREE.Vector3(turret.position[0], barrel ? barrel.position[1] : turret.position[1], turret.position[2] - halfZ);
  return { turretId: turret.id, riders, barrels, pivot, trunnion };
}

const _qy = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);

/** The traverse and elevation rotations of a pose (craft frame). */
export function turretQuaternions(pose: TurretPose, yaw = new THREE.Quaternion(), pitch = new THREE.Quaternion()): [THREE.Quaternion, THREE.Quaternion] {
  return [yaw.setFromAxisAngle(Y, -pose.yaw), pitch.setFromAxisAngle(X, pose.pitch)];
}

/**
 * Move a craft-frame point and direction that sit on the turret (`elevates`: on a barrel or a
 * turret weapon) to where the pose puts them. In place.
 */
export function applyTurret(rig: TurretRig, pose: TurretPose, elevates: boolean, point: THREE.Vector3, dir?: THREE.Vector3): void {
  turretQuaternions(pose, _qy, _qp);
  if (elevates) {
    point.sub(rig.trunnion).applyQuaternion(_qp).add(rig.trunnion);
    dir?.applyQuaternion(_qp);
  }
  point.sub(rig.pivot).applyQuaternion(_qy).add(rig.pivot);
  dir?.applyQuaternion(_qy);
}

/** A turret's rates (rad/s) and elevation limits (rad). */
export interface TurretLimits {
  yawRate: number;
  pitchRate: number;
  pitchMin: number;
  pitchMax: number;
}

/** Turn a pose toward wanted angles at the turret's rates (and within its elevation limits). */
export function slewTurret(pose: TurretPose, yaw: number, pitch: number, dt: number, lim: TurretLimits = TURRET): void {
  let dy = yaw - pose.yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  pose.yaw += Math.max(-lim.yawRate * dt, Math.min(lim.yawRate * dt, dy));
  pose.yaw = Math.atan2(Math.sin(pose.yaw), Math.cos(pose.yaw));
  const p = Math.max(lim.pitchMin, Math.min(lim.pitchMax, pitch));
  pose.pitch += Math.max(-lim.pitchRate * dt, Math.min(lim.pitchRate * dt, p - pose.pitch));
}

/**
 * Where to point a gun at a moving target: `rel` is the target from the muzzle, `relVel` its
 * velocity relative to the shooter (rounds inherit the shooter's), `speed` the muzzle speed and
 * `g` the drop (m/s²). Writes the aim direction (not normalised) into `out`, allowing for the
 * time of flight and the drop.
 */
export function leadAim(rel: THREE.Vector3, relVel: THREE.Vector3, speed: number, g: number, out: THREE.Vector3): THREE.Vector3 {
  let tof = rel.length() / speed;
  for (let k = 0; k < 3; k++) {
    out.copy(rel).addScaledVector(relVel, tof);
    out.y += 0.5 * g * tof * tof;
    tof = out.length() / speed;
  }
  return out;
}

/** Traverse and elevation (rad) that point along a direction given in the turret's base frame. */
export function anglesOf(dir: THREE.Vector3): { yaw: number; pitch: number } {
  return { yaw: Math.atan2(dir.x, -dir.z), pitch: Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) };
}

/** Drive a pose from stick-style inputs (-1..1). */
export function driveTurret(pose: TurretPose, yawInput: number, pitchInput: number, dt: number): void {
  pose.yaw = Math.atan2(Math.sin(pose.yaw + yawInput * TURRET.yawRate * dt), Math.cos(pose.yaw + yawInput * TURRET.yawRate * dt));
  pose.pitch = Math.max(TURRET.pitchMin, Math.min(TURRET.pitchMax, pose.pitch + pitchInput * TURRET.pitchRate * dt));
}
