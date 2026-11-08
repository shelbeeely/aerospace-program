import * as THREE from 'three';
import type { Craft } from '../craft/Craft.ts';
import { partQuaternion } from '../craft/massProperties.ts';
import type { ShapeDef } from '../craft/types.ts';
import { COAST } from './layout.ts';

/** Shared CPU/TSL Gerstner waves. Directions are unit XZ vectors; amplitudes are metres. */
export const OCEAN_WAVES = [
  { amplitude: 0.45, wavelength: 48, dx: 0.8, dz: 0.6, phase: 0.2 },
  { amplitude: 0.22, wavelength: 21, dx: -0.6, dz: 0.8, phase: 1.4 },
  { amplitude: 0.10, wavelength: 9, dx: 1, dz: 0, phase: 2.7 },
] as const;
export const OCEAN_STEEPNESS = 0.25;
export const OCEAN_MAX_AMPLITUDE = OCEAN_WAVES.reduce((sum, w) => sum + w.amplitude, 0);
export type Surge = (x: number, z: number, time: number) => number;

/** Material-coordinate Gerstner surface (horizontal displacement as well as crests). */
export function oceanPoint(u: number, v: number, time: number, out = new THREE.Vector3()): THREE.Vector3 {
  out.set(u, COAST.seaLevel, v);
  for (const w of OCEAN_WAVES) {
    const k = 2 * Math.PI / w.wavelength;
    const phase = k * (w.dx * u + w.dz * v) - Math.sqrt(9.81 * k) * time + w.phase;
    const horizontal = OCEAN_STEEPNESS * w.amplitude * Math.cos(phase);
    out.x += w.dx * horizontal;
    out.z += w.dz * horizontal;
    out.y += w.amplitude * Math.sin(phase);
  }
  return out;
}

const sample = new THREE.Vector3();
/** Height at a world XZ coordinate: invert Gerstner's horizontal displacement. */
export function oceanHeight(x: number, z: number, time: number, surge?: Surge): number {
  let u = x;
  let v = z;
  for (let i = 0; i < 5; i++) {
    oceanPoint(u, v, time, sample);
    u += x - sample.x;
    v += z - sample.z;
  }
  return oceanPoint(u, v, time, sample).y + (surge?.(x, z, time) ?? 0);
}

function dimensions(shape: ShapeDef, out: THREE.Vector3): number {
  if (shape.type === 'box') { out.set(...shape.size); return shape.size[0] * shape.size[1] * shape.size[2]; }
  if (shape.type === 'sphere') { out.setScalar(2 * shape.radius); return 4 / 3 * Math.PI * shape.radius ** 3; }
  out.setScalar(2 * shape.radius);
  out[shape.axis ?? 'y'] = shape.length;
  return Math.PI * shape.radius ** 2 * shape.length;
}

export interface WaterImpact { partId: string; force: number }
const size = new THREE.Vector3();
const partRotation = new THREE.Quaternion();
const worldRotation = new THREE.Quaternion();
const point = new THREE.Vector3();
const centre = new THREE.Vector3();
const velocity = new THREE.Vector3();
const force = new THREE.Vector3();
const offset = new THREE.Vector3();

/** Water contact for every airframe part; gas buoyancy modules remain independent. */
export class Ocean {
  surge?: Surge;
  /** Disable waves for deterministic hydrostatic tests. */
  waves = true;
  height(x: number, z: number, time: number): number {
    return this.waves ? oceanHeight(x, z, time, this.surge) : COAST.seaLevel + (this.surge?.(x, z, time) ?? 0);
  }

  /** Eight volume samples per part give buoyancy, drag and restoring roll/pitch torques. */
  apply(craft: Craft, time: number, dt: number, impact: (hit: WaterImpact) => void = () => {}): void {
    const body = craft.body;
    const position = body.translation();
    const rotation = body.rotation();
    worldRotation.set(rotation.x, rotation.y, rotation.z, rotation.w);
    const lv = body.linvel();
    const av = body.angvel();
    const com = body.worldCom();
    for (const part of craft.parts) {
      if (part.collider === false) continue;
      const volume = dimensions(part.shape, size);
      centre.set(...part.position).applyQuaternion(worldRotation).add(position);
      // No water work on land (the broad phase also avoids spending waves on runway tests).
      if (centre.x + size.length() * 0.5 <= COAST.x) continue;
      partRotation.copy(partQuaternion(part)).premultiply(worldRotation);
      // Each sample represents one eighth of the displaced volume and half the part height.
      const vertical = Math.max(0.05, size.y * Math.abs(new THREE.Vector3(0, 1, 0).applyQuaternion(partRotation).y)
        + size.x * Math.abs(new THREE.Vector3(1, 0, 0).applyQuaternion(partRotation).y)
        + size.z * Math.abs(new THREE.Vector3(0, 0, 1).applyQuaternion(partRotation).y));
      let slam = 0;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        point.set(sx * size.x / 4, sy * size.y / 4, sz * size.z / 4).applyQuaternion(partRotation).add(centre);
        if (point.x <= COAST.x) continue;
        const fraction = THREE.MathUtils.clamp((this.height(point.x, point.z, time) - point.y) / (vertical * 0.5) + 0.5, 0, 1);
        if (fraction === 0) continue;
        const displacedMass = 1025 * volume / 8 * fraction;
        offset.set(point.x - com.x, point.y - com.y, point.z - com.z);
        velocity.set(av.x, av.y, av.z).cross(offset).add(lv);
        // Limit drag impulse to keep explicit integration stable even for tiny/light parts.
        const drag = Math.min(0.5 * 1025 * Math.pow(volume / 8, 2 / 3) * fraction * velocity.length() + 0.8 * displacedMass,
          Math.max(0.01, part.mass) / (16 * dt));
        force.copy(velocity).multiplyScalar(-drag);
        slam += Math.max(0, -velocity.y - 3) * drag;
        force.y += displacedMass * 9.81;
        body.addForceAtPoint(force, point, true);
      }
      if (slam > 0) impact({ partId: part.id, force: slam });
    }
  }
}
