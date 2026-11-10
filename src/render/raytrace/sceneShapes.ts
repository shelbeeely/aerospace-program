import { Color, Quaternion, Vector3 } from 'three';
import type { ShapeDef } from '../../craft/types.ts';
import type { Simulation } from '../../sim/Simulation.ts';
import { COAST, LAYOUT } from '../../sim/layout.ts';
import { craftShapes } from './packShapes.ts';
import type { RayShape } from './shapes.ts';

function tint(hex: string): Vector3 {
  const c = new Color(hex); return new Vector3(c.r, c.g, c.b);
}
function box(position: Vector3, size: Vector3, color: string, emission = 2): RayShape {
  return { kind: 'box', position, size, color: tint(color), rotation: new Quaternion(), emission };
}

/** Debris bodies already contain the part's local rotation; apply only the primitive's axis. */
export function debrisShape(shape: ShapeDef, position: Vector3, rotation: Quaternion, color: string): RayShape {
  const size = shape.type === 'box' ? new Vector3(...shape.size).multiplyScalar(0.5)
    : shape.type === 'sphere' ? new Vector3(shape.radius, shape.radius, shape.radius)
    : new Vector3(shape.radius, shape.length / 2, shape.radius);
  const q = rotation.clone();
  if (shape.type !== 'box' && shape.type !== 'sphere') {
    if (shape.axis === 'x') q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2));
    if (shape.axis === 'z') q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2));
  }
  return { kind: shape.type === 'cone' || shape.type === 'capsule' ? 'cylinder' : shape.type, position, rotation: q, size, color: tint(color), emission: 3.2 };
}

/** Analytic approximation of the neon hangar shell, floor and turntable. */
export function hangarShapes(sim: Simulation, position: Vector3, rotation: Quaternion): RayShape[] {
  return [
    ...craftShapes(sim.craft, position, rotation),
    { kind: 'plane', position: new Vector3(), rotation: new Quaternion(), size: new Vector3(), color: tint('#00eaff'), emission: 1.4 },
    { kind: 'cylinder', position: new Vector3(0, 0.05, 0), rotation: new Quaternion(), size: new Vector3(7, 0.05, 7), color: tint('#00eaff'), emission: 3.2 },
    box(new Vector3(-23, 7.5, 0), new Vector3(0.1, 7.5, 21), '#ff2bd6'),
    box(new Vector3(23, 7.5, 0), new Vector3(0.1, 7.5, 21), '#ff2bd6'),
    box(new Vector3(0, 7.5, 21), new Vector3(23, 7.5, 0.1), '#9d4dff'),
    box(new Vector3(0, 15, 0), new Vector3(23, 0.1, 21), '#00eaff'),
    box(new Vector3(-20, 7.5, -21), new Vector3(3, 7.5, 0.1), '#ff2bd6'),
    box(new Vector3(20, 7.5, -21), new Vector3(3, 7.5, 0.1), '#ff2bd6'),
    box(new Vector3(0, 13.25, -21), new Vector3(17, 1.75, 0.1), '#ff2bd6'),
  ];
}

/** Current craft/debris plus bounded nearby town blocks. RT uses analytic scenery approximations. */
export function flightShapes(sim: Simulation, position: Vector3, rotation: Quaternion, camera: Vector3): RayShape[] {
  const half = LAYOUT.groundSize / 2;
  const motion = sim.atmosphere.events.groundDisplacement();
  const out: RayShape[] = [
    ...craftShapes(sim.craft, position, rotation),
    { kind: 'plane', position: new Vector3((COAST.x - half) / 2, 0, 0).add(motion), rotation: new Quaternion(), size: new Vector3((COAST.x + half) / 2, 0, half), color: tint('#00eaff'), emission: 1.8 },
    box(new Vector3(0, 0.02, LAYOUT.runway.centerZ).add(motion), new Vector3(LAYOUT.runway.width / 2, 0.01, LAYOUT.runway.length / 2), '#ff2bd6', 3),
    // Mean ocean surface only; the raster view carries the full Gerstner-wave detail.
    { kind: 'plane', position: new Vector3(COAST.x + COAST.width / 2, sim.ocean.height(Math.max(COAST.x, camera.x), camera.z, sim.time), 0), rotation: new Quaternion(), size: new Vector3(COAST.width / 2, 0, half), color: tint('#0088ff'), emission: 2.5 },
  ];
  for (const d of sim.debris.slice(-64)) {
    out.push(debrisShape(d.part.shape, new Vector3().copy(d.body.translation()), new Quaternion().copy(d.body.rotation()), d.part.color));
  }
  const blocks: RayShape[] = [];
  for (const b of sim.town.buildings) {
    // Avoid tracing distant blocks in ordinary runway flight.
    if (new Vector3(...b.def.origin).distanceToSquared(camera) > 1800 ** 2) continue;
    const size = new Vector3().setScalar(b.blockSize / 2);
    for (const block of b.list) if (block.alive) {
      blocks.push(box(new Vector3().copy(b.worldCentre(block, { x: 0, y: 0, z: 0 })), size, b.def.color));
    }
  }
  blocks.sort((a, b) => a.position.distanceToSquared(camera) - b.position.distanceToSquared(camera));
  out.push(...blocks.slice(0, 96));
  return out;
}
