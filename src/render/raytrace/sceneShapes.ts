import { Color, Quaternion, Vector3 } from 'three';
import type { ShapeDef } from '../../craft/types.ts';
import type { Simulation } from '../../sim/Simulation.ts';
import { COAST, LAYOUT } from '../../sim/layout.ts';
import { craftShapes } from './packShapes.ts';
import { HANGAR } from '../hangarLayout.ts';
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

/**
 * Analytic approximation of the hangar (HangarView): the dark floor, the stepped platform with
 * its lit rim, the pilastered walls, the beams with their red edge lines, the halo rings' plane
 * and the door portal. Dark navy surfaces with dim edges; light only where the raster hangar has it.
 */
export function hangarShapes(sim: Simulation, position: Vector3, rotation: Quaternion): RayShape[] {
  const { W, H, D, DOOR_W, DOOR_H, BAY } = HANGAR;
  const out: RayShape[] = [
    ...craftShapes(sim.craft, position, rotation),
    { kind: 'plane', position: new Vector3(), rotation: new Quaternion(), size: new Vector3(W / 2, 0, D / 2), color: tint('#2a4466'), emission: 0.5 },
    { kind: 'cylinder', position: new Vector3(0, 0.06, 0), rotation: new Quaternion(), size: new Vector3(9.6, 0.06, 9.6), color: tint('#10284f'), emission: 0.8 },
    { kind: 'cylinder', position: new Vector3(0, 0.18, 0), rotation: new Quaternion(), size: new Vector3(7.6, 0.06, 7.6), color: tint('#10284f'), emission: 0.8 },
    { kind: 'cylinder', position: new Vector3(0, 0.29, 0), rotation: new Quaternion(), size: new Vector3(6.6, 0.05, 6.6), color: tint('#00d4ff'), emission: 2.4 },
    // Walls (dark), back recess, roof.
    box(new Vector3(-W / 2, H / 2, 0), new Vector3(0.1, H / 2, D / 2), '#22485a', 0.6),
    box(new Vector3(W / 2, H / 2, 0), new Vector3(0.1, H / 2, D / 2), '#22485a', 0.6),
    box(new Vector3(0, H / 2, D / 2), new Vector3(W / 2, H / 2, 0.1), '#22485a', 0.6),
    box(new Vector3(0, H, 0), new Vector3(W / 2, 0.1, D / 2), '#9fc4e0', 0.5),
    box(new Vector3(-(W + DOOR_W) / 4, H / 2, -D / 2), new Vector3((W - DOOR_W) / 4, H / 2, 0.1), '#10284f', 0.8),
    box(new Vector3((W + DOOR_W) / 4, H / 2, -D / 2), new Vector3((W - DOOR_W) / 4, H / 2, 0.1), '#10284f', 0.8),
    box(new Vector3(0, (H + DOOR_H) / 2, -D / 2), new Vector3(DOOR_W / 2, (H - DOOR_H) / 2, 0.1), '#10284f', 0.8),
    box(new Vector3(0, DOOR_H - 0.06, -D / 2 + 1.4), new Vector3(DOOR_W / 2 - 1, 0.06, 0.05), '#ffb000', 3),
  ];
  // Pilasters and roof beams (red edge lines) every bay.
  for (let z = -D / 2 + 2; z <= D / 2 - 2; z += BAY) {
    for (const sx of [-1, 1]) out.push(box(new Vector3(sx * (W / 2 - 0.9), H / 2, z), new Vector3(0.9, H / 2, 0.8), '#10284f', 0.9));
    out.push(box(new Vector3(0, H - 1, z), new Vector3(W / 2 - 0.5, 1, 0.5), '#ff3b1f', 0.9));
  }
  return out;
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
