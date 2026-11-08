import { Quaternion, Vector3 } from 'three';

export type RayShapeKind = 'box' | 'sphere' | 'cylinder' | 'plane';
/** Cylinder axis is local Y; box size is half-extents; sphere uses size.x. */
export interface RayShape {
  kind: RayShapeKind;
  position: Vector3;
  rotation: Quaternion;
  size: Vector3;
  color: Vector3;
  emission?: number;
  roughness?: number;
}
export interface RayHit { distance: number; point: Vector3; normal: Vector3 }
const EPS = 1e-5;

/** Reference analytic intersections, also used to validate GPU packing and ray math. */
export function intersectShape(origin: Vector3, direction: Vector3, shape: RayShape): RayHit | null {
  if (direction.lengthSq() < EPS * EPS) return null;
  const inverse = shape.rotation.clone().normalize().invert();
  const o = origin.clone().sub(shape.position).applyQuaternion(inverse);
  const d = direction.clone().normalize().applyQuaternion(inverse);
  let t = Infinity;
  let normal = new Vector3();
  const accept = (candidate: number, n: Vector3) => {
    if (candidate > EPS && candidate < t) { t = candidate; normal = n; }
  };
  if (shape.kind === 'sphere') {
    const b = o.dot(d), c = o.lengthSq() - shape.size.x ** 2;
    const discriminant = b * b - c;
    if (discriminant >= 0) for (const root of [-b - Math.sqrt(discriminant), -b + Math.sqrt(discriminant)])
      accept(root, o.clone().addScaledVector(d, root).normalize());
  } else if (shape.kind === 'plane') {
    if (Math.abs(d.y) > EPS) accept(-o.y / d.y, new Vector3(0, d.y < 0 ? 1 : -1, 0));
  } else if (shape.kind === 'box') {
    let near = -Infinity, far = Infinity;
    let nearNormal = new Vector3(), farNormal = new Vector3();
    for (const axis of ['x', 'y', 'z'] as const) {
      if (Math.abs(d[axis]) < EPS) {
        if (Math.abs(o[axis]) > shape.size[axis]) return null;
        continue;
      }
      let a = (-shape.size[axis] - o[axis]) / d[axis];
      let b = (shape.size[axis] - o[axis]) / d[axis];
      const na = new Vector3(), nb = new Vector3();
      na[axis] = -1; nb[axis] = 1;
      if (a > b) { [a, b] = [b, a]; na[axis] = 1; nb[axis] = -1; }
      if (a > near) { near = a; nearNormal = na; }
      if (b < far) { far = b; farNormal = nb; }
      if (near > far) return null;
    }
    accept(near, nearNormal); accept(far, farNormal);
  } else {
    const radius = shape.size.x, half = shape.size.y;
    const a = d.x * d.x + d.z * d.z;
    const b = o.x * d.x + o.z * d.z;
    const c = o.x * o.x + o.z * o.z - radius * radius;
    const disc = b * b - a * c;
    if (a > EPS * EPS && disc >= 0) {
      for (const root of [(-b - Math.sqrt(disc)) / a, (-b + Math.sqrt(disc)) / a]) {
        const p = o.clone().addScaledVector(d, root);
        if (Math.abs(p.y) <= half + EPS) accept(root, new Vector3(p.x, 0, p.z).normalize());
      }
    }
    if (Math.abs(d.y) > EPS) for (const sign of [-1, 1]) {
      const root = (sign * half - o.y) / d.y;
      const p = o.clone().addScaledVector(d, root);
      if (p.x * p.x + p.z * p.z <= radius * radius + EPS) accept(root, new Vector3(0, sign, 0));
    }
  }
  if (!Number.isFinite(t)) return null;
  return { distance: t, point: origin.clone().addScaledVector(direction.clone().normalize(), t), normal: normal.applyQuaternion(shape.rotation).normalize() };
}
