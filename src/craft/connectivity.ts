import * as THREE from 'three';
import { partQuaternion } from './massProperties.ts';
import type { CraftDef, PartDef, ShapeDef } from './types.ts';

/** Gap (m) still counted as touching: generous for rounding in hand- or model-written JSON. */
const TOUCH = 0.06;
/** How far outside its part a module's point may sit (m): a hinge line, a nozzle, a hub. */
const MODULE_SLACK = 0.4;

function halfExtents(s: ShapeDef): THREE.Vector3 {
  if (s.type === 'box') return new THREE.Vector3(s.size[0] / 2, s.size[1] / 2, s.size[2] / 2);
  if (s.type === 'sphere') return new THREE.Vector3(s.radius, s.radius, s.radius);
  const r = s.radius, h = s.length / 2;
  return s.axis === 'x' ? new THREE.Vector3(h, r, r) : s.axis === 'z' ? new THREE.Vector3(r, r, h) : new THREE.Vector3(r, h, r);
}

/** A part's oriented box: centre, axes (craft frame) and half extents. */
interface Obb { c: THREE.Vector3; axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3]; h: THREE.Vector3 }

function obb(p: PartDef): Obb {
  const q = partQuaternion(p);
  return {
    c: new THREE.Vector3(...p.position),
    axes: [new THREE.Vector3(1, 0, 0).applyQuaternion(q), new THREE.Vector3(0, 1, 0).applyQuaternion(q), new THREE.Vector3(0, 0, 1).applyQuaternion(q)],
    h: halfExtents(p.shape),
  };
}

/** Do two oriented boxes overlap or touch (within `pad`)? Separating-axis test, 15 axes. */
export function boxesTouch(a: Obb, b: Obb, pad = TOUCH): boolean {
  const d = b.c.clone().sub(a.c);
  const tests: THREE.Vector3[] = [...a.axes, ...b.axes];
  for (const u of a.axes) for (const v of b.axes) {
    const x = u.clone().cross(v);
    if (x.lengthSq() > 1e-8) tests.push(x.normalize());
  }
  const he = (o: Obb, n: THREE.Vector3) => Math.abs(o.axes[0].dot(n)) * o.h.x + Math.abs(o.axes[1].dot(n)) * o.h.y + Math.abs(o.axes[2].dot(n)) * o.h.z;
  for (const n of tests) if (Math.abs(d.dot(n)) > he(a, n) + he(b, n) + pad) return false;
  return true;
}

/**
 * Structural connectivity: every part must touch the structure (their boxes overlap or meet,
 * rotation included), so the whole craft is one connected piece with nothing floating, and
 * every module must sit on or within its own part. Returns plain-English problems (empty = ok).
 */
export function connectivityErrors(def: CraftDef): string[] {
  const parts = def.parts;
  const errors: string[] = [];
  if (!parts.length) return errors;
  const boxes = parts.map(obb);
  // Flood fill from the heaviest part (the airframe's backbone).
  const root = parts.reduce((best, p, i) => (p.mass > parts[best].mass ? i : best), 0);
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const i = queue.pop()!;
    for (let j = 0; j < parts.length; j++) {
      if (seen.has(j) || !boxesTouch(boxes[i], boxes[j])) continue;
      seen.add(j);
      queue.push(j);
    }
  }
  const loose = parts.filter((_, i) => !seen.has(i));
  for (const p of loose.slice(0, 12)) {
    // Say how far it is from the nearest connected part, so the fix is obvious.
    const b = boxes[parts.indexOf(p)];
    let near = '', gap = Infinity;
    for (const i of seen) {
      const d = b.c.distanceTo(boxes[i].c) - b.h.length() - boxes[i].h.length();
      if (d < gap) { gap = d; near = parts[i].id; }
    }
    errors.push(`part "${p.id}" is floating: it does not touch the rest of the craft (nearest connected part "${near}"). Move or resize it so its shape overlaps or meets a connected part.`);
  }
  if (loose.length > 12) errors.push(`...and ${loose.length - 12} more floating parts`);
  // Modules sit on their part.
  for (const p of parts) {
    const h = halfExtents(p.shape);
    for (const m of p.modules ?? []) {
      const o = (m as { offset?: [number, number, number] }).offset;
      if (!o) continue;
      const out = Math.max(Math.abs(o[0]) - h.x, Math.abs(o[1]) - h.y, Math.abs(o[2]) - h.z);
      if (out > MODULE_SLACK) {
        errors.push(`part "${p.id}": its ${m.type} module's offset [${o.map((v) => +v.toFixed(2)).join(', ')}] lies ${out.toFixed(2)} m outside the part's shape. Modules attach to their own part: move the offset inside it, or give the module its own part that touches the craft.`);
      }
    }
  }
  return errors;
}
