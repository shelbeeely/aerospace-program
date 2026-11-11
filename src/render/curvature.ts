import * as THREE from 'three/webgpu';
import { acos, clamp, cos, float, length, max, mix, modelWorldMatrix, modelWorldMatrixInverse, positionLocal, positionWorld, sin, uniform, vec3, vec4 } from 'three/tsl';
import { PLANET } from '../sim/layout.ts';
import type { TslNode } from './neon.ts';

/**
 * Planet curvature for the renderer. Physics runs flat (see PLANET); here every vertex is
 * wrapped onto a sphere of radius R whose top touches the ground right under the camera:
 * horizontal distance d becomes the arc angle d/R, height becomes radius. Near the camera
 * nothing moves (so the world matches the physics around the craft); far away the ground
 * falls away below a real horizon, and from orbit the Grid is a ball.
 *
 * `flatWorld` undoes the bend exactly in a fragment shader, for materials whose patterns come
 * from world position (ground grid, roads, windows), so the patterns don't swim.
 */
export const curveOrigin = uniform(new THREE.Vector3());
/** 1 = bent (flight), 0 = flat (hangar, captures that want it flat). */
export const curveOn = uniform(1);
const R = float(PLANET.radius);

function bend(world: TslNode): TslNode {
  const d: TslNode = world.xz.sub(curveOrigin.xz);
  const theta: TslNode = length(d).div(R);
  const radial: TslNode = world.y.add(R);
  // sin(θ)/θ, safe at θ → 0
  const s: TslNode = sin(theta).div(max(theta, float(1e-5)));
  const xz: TslNode = curveOrigin.xz.add(d.mul(radial.div(R)).mul(s));
  const y: TslNode = radial.mul(cos(theta)).sub(R);
  return mix(world, vec3(xz.x, y, xz.y), curveOn);
}

/**
 * The bend on the CPU: where a flat-world point is drawn (for overlays that must sit on what is
 * rendered, like the ADS-B tags).
 */
export function bendPoint(p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  if (!curveOn.value) return out.copy(p);
  const o = curveOrigin.value as THREE.Vector3;
  const R0 = PLANET.radius;
  const dx = p.x - o.x, dz = p.z - o.z;
  const d = Math.hypot(dx, dz);
  const theta = d / R0;
  const radial = p.y + R0;
  const s = theta > 1e-5 ? Math.sin(theta) / theta : 1;
  return out.set(o.x + dx * (radial / R0) * s, radial * Math.cos(theta) - R0, o.z + dz * (radial / R0) * s);
}

/** Local-space position after the bend (compose with an existing positionNode). */
export function curvedPosition(base: TslNode = positionLocal): TslNode {
  const world: TslNode = modelWorldMatrix.mul(vec4(base, 1)).xyz;
  return modelWorldMatrixInverse.mul(vec4(bend(world), 1)).xyz;
}

/** The flat (physics) world position of the current fragment: the bend's exact inverse. */
export const flatWorld: TslNode = (() => {
  const centre: TslNode = vec3(curveOrigin.x, R.negate(), curveOrigin.z);
  const v: TslNode = positionWorld.sub(centre);
  const radial: TslNode = length(v);
  const theta: TslNode = acos(clamp(v.y.div(radial), -1, 1));
  const h: TslNode = v.xz;
  const xz: TslNode = curveOrigin.xz.add(h.div(max(length(h), float(1e-5))).mul(theta.mul(R)));
  return mix(positionWorld, vec3(xz.x, radial.sub(R), xz.y), curveOn);
})();

const bent = new WeakSet<THREE.Material>();
const warned = new Set<string>();

/**
 * Give every node material under `root` the bend (once per material). Objects flagged
 * `userData.noCurve` (the sky dome) and non-node materials are left alone. Cheap enough to
 * call every second or so to catch objects added later.
 */
export function applyCurvature(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o.userData.noCurve) return;
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      if (bent.has(mat)) continue;
      if (!(mat as THREE.NodeMaterial).isNodeMaterial) {
        // A classic material can't take the bend: it would float off the curved world (the
        // neon-edges-above-buildings bug). Use the *NodeMaterial equivalent instead.
        if (!warned.has(mat.type)) { warned.add(mat.type); console.warn(`curvature: ${mat.type} on "${o.name || o.type}" is not a node material and will not bend with the planet`); }
        continue;
      }
      const nm = mat as THREE.NodeMaterial;
      nm.positionNode = curvedPosition((nm.positionNode as TslNode | null) ?? positionLocal);
      nm.needsUpdate = true;
      bent.add(mat);
    }
  });
}
