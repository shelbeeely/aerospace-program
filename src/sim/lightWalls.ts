import type { Simulation } from './Simulation.ts';
import type { TrailPoint } from './trails.ts';

/**
 * Light walls near a point, as 2-D segments [ax, az, bx, bz]: what an autonomous ground vehicle
 * must not drive into: traffic riders' jetwalls and any extra source (remote players' walls,
 * added by the multiplayer client). The player's own walls are left out: a vehicle passes
 * through its own light (collision groups), so its driver needn't avoid them (and treating its
 * own fresh wall as an obstacle stopped it dead wherever its route doubled back).
 */
export type WallSegment = [number, number, number, number];

export function wallSegmentsNear(sim: Simulation, x: number, z: number, radius: number, extra?: Iterable<{ points: TrailPoint[] }>): WallSegment[] {
  const out: WallSegment[] = [];
  const r2 = (radius + 50) ** 2;
  const near = (p: { x: number; z: number }) => (p.x - x) ** 2 + (p.z - z) ** 2 < r2;
  for (const r of sim.traffic.riders) {
    if (r.derezAt !== null) continue;
    const c = [...r.trail, { x: r.x, z: r.z }];
    for (let i = 1; i < c.length; i++) if (near(c[i]) || near(c[i - 1])) out.push([c[i - 1].x, c[i - 1].z, c[i].x, c[i].z]);
  }
  if (extra) for (const t of extra) {
    const pts = t.points;
    for (let i = 1; i < pts.length; i++) if (near(pts[i])) out.push([pts[i - 1].x, pts[i - 1].z, pts[i].x, pts[i].z]);
  }
  // The rims of broken road are walls across it too.
  for (const b of sim.roadDamage.barriers) if (near({ x: b[0], z: b[1] }) || near({ x: b[2], z: b[3] })) out.push([b[0], b[1], b[2], b[3]]);
  return out;
}
