import * as THREE from 'three';
import type { PartDef, ShapeDef } from './types.ts';
import { DEG } from '../tuning.ts';

export interface MassProperties {
  mass: number;
  /** Centre of mass, craft-local. */
  com: THREE.Vector3;
  /** Full inertia tensor about the CoM, craft-local axes (row-major 3x3). */
  inertia: number[];
  /** Principal moments and the rotation of the principal frame (what Rapier wants). */
  principal: THREE.Vector3;
  principalFrame: THREE.Quaternion;
}

export function partQuaternion(part: PartDef, out = new THREE.Quaternion()): THREE.Quaternion {
  const r = part.rotationDeg ?? [0, 0, 0];
  return out.setFromEuler(new THREE.Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ'));
}

/** Diagonal inertia of a solid shape about its own centre, in shape axes. */
function shapeInertia(shape: ShapeDef, m: number): [number, number, number] {
  switch (shape.type) {
    case 'box': {
      const [x, y, z] = shape.size;
      return [(m * (y * y + z * z)) / 12, (m * (x * x + z * z)) / 12, (m * (x * x + y * y)) / 12];
    }
    case 'sphere': {
      const i = 0.4 * m * shape.radius * shape.radius;
      return [i, i, i];
    }
    case 'cylinder':
    case 'cone':
    case 'capsule': {
      const r = shape.radius;
      const h = shape.length;
      // Cone (about its centroid): axial 3/10 m r², radial 3/20 m r² + 3/80 m h².
      // Capsule: close to a cylinder of the same overall length.
      const axial = shape.type === 'cone' ? 0.3 * m * r * r : 0.5 * m * r * r;
      const radial = shape.type === 'cone' ? m * (0.15 * r * r + 0.0375 * h * h) : (m * (3 * r * r + h * h)) / 12;
      const axis = shape.axis ?? 'y';
      return axis === 'x' ? [axial, radial, radial] : axis === 'y' ? [radial, axial, radial] : [radial, radial, axial];
    }
  }
}

/**
 * Sums parts into one rigid body: total mass, CoM, inertia tensor (rotated part tensors +
 * parallel axis theorem), then diagonalises it for Rapier.
 */
export function computeMassProperties(parts: PartDef[], comOffset?: THREE.Vector3): MassProperties {
  let mass = 0;
  const com = new THREE.Vector3();
  for (const p of parts) {
    mass += p.mass;
    com.x += p.position[0] * p.mass;
    com.y += p.position[1] * p.mass;
    com.z += p.position[2] * p.mass;
  }
  if (mass <= 0) throw new Error('Craft has no mass');
  com.divideScalar(mass);

  const I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const R = new THREE.Matrix3();
  const q = new THREE.Quaternion();
  const m4 = new THREE.Matrix4();
  for (const p of parts) {
    const d = shapeInertia(p.shape, p.mass);
    m4.makeRotationFromQuaternion(partQuaternion(p, q));
    R.setFromMatrix4(m4);
    const r = R.elements; // column-major
    const Rm = (i: number, j: number) => r[j * 3 + i];
    // R * diag(d) * R^T
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += Rm(i, k) * d[k] * Rm(j, k);
        I[i * 3 + j] += s;
      }
    // Parallel axis: m * (|r|^2 E - r r^T)
    const rx = p.position[0] - com.x;
    const ry = p.position[1] - com.y;
    const rz = p.position[2] - com.z;
    const rv = [rx, ry, rz];
    const r2 = rx * rx + ry * ry + rz * rz;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) I[i * 3 + j] += p.mass * ((i === j ? r2 : 0) - rv[i] * rv[j]);
  }

  if (comOffset) com.add(comOffset);
  const { values, vectors } = jacobiEigen(I);
  // Build a right-handed rotation from eigenvectors (columns).
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(vectors[0], vectors[3], vectors[6]),
    new THREE.Vector3(vectors[1], vectors[4], vectors[7]),
    new THREE.Vector3(vectors[2], vectors[5], vectors[8]),
  );
  if (basis.determinant() < 0) {
    basis.elements[8] *= -1;
    basis.elements[9] *= -1;
    basis.elements[10] *= -1;
  }
  const principalFrame = new THREE.Quaternion().setFromRotationMatrix(basis);
  const minI = 1e-3 * mass;
  return {
    mass,
    com,
    inertia: I,
    principal: new THREE.Vector3(
      Math.max(minI, values[0]),
      Math.max(minI, values[1]),
      Math.max(minI, values[2]),
    ),
    principalFrame,
  };
}

/** Cyclic Jacobi eigen decomposition for a symmetric 3x3 (row-major). Eigenvectors are columns. */
function jacobiEigen(m: number[]): { values: number[]; vectors: number[] } {
  const a = m.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-12) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-15) continue;
      const app = a[p * 3 + p];
      const aqq = a[q * 3 + q];
      const theta = (aqq - app) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p];
        const akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k];
        const aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p];
        const vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0], a[4], a[8]], vectors: v };
}
