import { Color, Quaternion, Vector3 } from 'three';
import type { Craft } from '../../craft/Craft.ts';
import { partQuaternion } from '../../craft/massProperties.ts';
import type { RayShape } from './shapes.ts';

export const MAX_RAY_SHAPES = 256;
export const SHAPE_TEXELS = 4;
export const SHAPE_FLOATS = SHAPE_TEXELS * 4;
export const SHAPE_KIND = { box: 1, sphere: 2, cylinder: 3, plane: 4 } as const;
/** Four RGBA texels per shape: kind/position, quaternion, size/emission, color/roughness. */
export function packShapes(shapes: readonly RayShape[], camera: Vector3, max = MAX_RAY_SHAPES): { data: Float32Array; shapes: RayShape[]; count: number } {
  const capacity = Math.max(0, Math.min(MAX_RAY_SHAPES, Math.floor(max)));
  const selected = [...shapes].sort((a, b) => {
    // Infinite ground planes remain available even with a full scene.
    const da = a.kind === 'plane' ? -1 : a.position.distanceToSquared(camera);
    const db = b.kind === 'plane' ? -1 : b.position.distanceToSquared(camera);
    return da - db;
  }).slice(0, capacity);
  const data = new Float32Array(MAX_RAY_SHAPES * SHAPE_FLOATS);
  selected.forEach((s, i) => {
    const q = s.rotation.clone().normalize();
    data.set([SHAPE_KIND[s.kind], s.position.x, s.position.y, s.position.z,
      q.x, q.y, q.z, q.w, s.size.x, s.size.y, s.size.z, s.emission ?? 3.2,
      s.color.x, s.color.y, s.color.z, s.roughness ?? 0.2], i * SHAPE_FLOATS);
  });
  return { data, shapes: selected, count: selected.length };
}

/** World-space analytic primitives matching the craft's rendered part transforms. */
export function craftShapes(craft: Craft, position: Vector3, rotation: Quaternion): RayShape[] {
  return craft.def.parts.filter(p => !craft.detached.has(p.id)).map(p => {
    const rotationLocal = partQuaternion(p);
    const s = p.shape;
    const size = s.type === 'box' ? new Vector3(...s.size).multiplyScalar(0.5)
      : s.type === 'sphere' ? new Vector3(s.radius, s.radius, s.radius)
      : new Vector3(s.radius, s.length / 2, s.radius);
    // Cones and capsules are traced as cylinders (close enough for this mode).
    if (s.type !== 'box' && s.type !== 'sphere') {
      if (s.axis === 'x') rotationLocal.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2));
      if (s.axis === 'z') rotationLocal.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2));
    }
    const color = new Color(p.color);
    return { kind: s.type === 'cone' || s.type === 'capsule' ? 'cylinder' : s.type, position: new Vector3(...p.position).applyQuaternion(rotation).add(position),
      rotation: rotation.clone().multiply(rotationLocal), size, color: new Vector3(color.r, color.g, color.b) };
  });
}
