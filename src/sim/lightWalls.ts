import type { Simulation } from './Simulation.ts';
import type { TrailPoint } from './trails.ts';

/**
 * Light walls near a point, as 2-D segments [ax, az, bx, bz]: what an autonomous ground vehicle
 * must not drive into. Covers the player's own jetwalls and lit ribbons (except the fresh end
 * still attached to the vehicle), traffic riders' jetwalls, and any extra source (remote
 * players' walls, added by the multiplayer client).
 */
export type WallSegment = [number, number, number, number];

export function wallSegmentsNear(sim: Simulation, x: number, z: number, radius: number, extra?: Iterable<{ points: TrailPoint[] }>): WallSegment[] {
  const out: WallSegment[] = [];
  const r2 = (radius + 50) ** 2;
  const near = (p: { x: number; z: number }) => (p.x - x) ** 2 + (p.z - z) ** 2 < r2;
  for (const t of sim.trails.trails) {
    if (t.kind !== 'wall' || t.derezAt !== null) continue;
    const pts = t.points;
    // Our own wall's last 12 m trail right behind us: not an obstacle.
    const end = t.active ? pts.length - 1 : pts.length;
    const cut = t.active && pts.length ? pts[pts.length - 1].arc - 12 : Infinity;
    for (let i = 1; i < end; i++) {
      if (pts[i].arc > cut) break;
      if (!pts[i].collider) continue; // only solid light (faded ribbon segments are hollow)
      if (near(pts[i])) out.push([pts[i - 1].x, pts[i - 1].z, pts[i].x, pts[i].z]);
    }
  }
  for (const r of sim.traffic.riders) {
    if (r.derezAt !== null) continue;
    const c = [...r.trail, { x: r.x, z: r.z }];
    for (let i = 1; i < c.length; i++) if (near(c[i]) || near(c[i - 1])) out.push([c[i - 1].x, c[i - 1].z, c[i].x, c[i].z]);
  }
  if (extra) for (const t of extra) {
    const pts = t.points;
    for (let i = 1; i < pts.length; i++) if (near(pts[i])) out.push([pts[i - 1].x, pts[i - 1].z, pts[i].x, pts[i].z]);
  }
  return out;
}
