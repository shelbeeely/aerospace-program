import type { ControlInputs } from './controls.ts';
import { wrapCoord } from './layout.ts';
import { findRoute, segmentAt, type Route } from './roads.ts';
import type { WallSegment } from './lightWalls.ts';
import type { Telemetry } from './telemetry.ts';
import { obstacleTop } from '../world/structures.ts';

/**
 * The flight computer's driver for ground vehicles: follows a route on the road network
 * (sim/roads.ts) through the same controls a human uses (yaw steers, throttle drives, brake
 * stops), so any wheeled design can be sent anywhere a road goes.
 *
 * - Path: the route's centreline offset to the right-hand lane.
 * - Steering: pure pursuit on a look-ahead point that stretches with speed.
 * - Speed: the cruise speed, capped by the next corner (a 90° turn is taken at ~8 m/s) and by
 *   the braking distance to the destination; throttle from the speed error, brakes on overspeed.
 * - Recovery: re-routes when it leaves the road by more than 30 m; reports being stuck.
 */
export interface DriveStatus {
  /** Metres left along the route. */
  remaining: number;
  /** Speed the driver is aiming for (m/s). */
  target: number;
  arrived: boolean;
  stuck: boolean;
  /** Lateral distance from the path (m). */
  offPath: number;
}

const LANE = 6;
const ACCEL = 3.5; // planned deceleration (m/s²)

export class GroundDriver {
  route: Route | null = null;
  /** The lane path (unbounded coordinates, continuous from the start). */
  path: Array<[number, number]> = [];
  private cum: number[] = [];
  private idx = 0;
  private stuckTime = 0;
  private lastReroute = -Infinity;
  /** Steering sign: +1 if positive yaw turns toward increasing heading (clockwise from above). */
  steerSign = 1;
  goal: [number, number] | null = null;
  /** The destination stands off the road (in a building): the route ends at the nearest road point. */
  endsAtRoad = false;
  /** Light walls near (x, z) within radius (set by the host: own trails, traffic, remote players). */
  walls: ((x: number, z: number, radius: number) => WallSegment[]) | null = null;
  /** Road segments found blocked by light walls (avoided when re-routing), key → time seen. */
  private readonly blocked = new Map<string, number>();
  private blockedFor = 0;
  /** Distance to a light wall across the path ahead (m), or Infinity. */
  wallAhead = Infinity;

  /** Plan a route from (x, z) to (gx, gz). False if no road connects them. */
  plan(x: number, z: number, gx: number, gz: number): boolean {
    this.goal = [gx, gz];
    const now = this.clock;
    for (const [k, t] of this.blocked) if (now - t > 120) this.blocked.delete(k);
    const r = findRoute(x, z, gx, gz, 400000, this.blocked.size ? (ax, i, j) => this.blocked.has(`${ax ? 1 : 0},${i},${j}`) : undefined);
    if (!r) { this.route = null; this.path = []; return false; }
    // The legs between the road and the start/destination are driven only if nothing stands on
    // them (a destination inside a building ends at the nearest road point instead).
    const pts = r.points.map((p) => [p.x, p.z] as [number, number]);
    const clear = (a: [number, number], b: [number, number]) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let d = 8; d < L; d += 5) if (obstacleTop(wrapCoord(a[0] + ((b[0] - a[0]) * d) / L), wrapCoord(a[1] + ((b[1] - a[1]) * d) / L)) > 0.5) return false;
      return true;
    };
    this.endsAtRoad = pts.length > 2 && !clear(pts[pts.length - 2], pts[pts.length - 1]);
    if (this.endsAtRoad) pts.pop();
    this.route = r;
    this.path = laneOffset(pts, LANE);
    this.cum = [0];
    for (let i = 1; i < this.path.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(this.path[i][0] - this.path[i - 1][0], this.path[i][1] - this.path[i - 1][1]));
    this.idx = 0;
    this.stuckTime = 0;
    return true;
  }

  get length(): number {
    return this.cum[this.cum.length - 1] ?? 0;
  }

  private clock = 0;

  drive(dt: number, t: Telemetry, cruise: number): { controls: ControlInputs; status: DriveStatus } {
    this.clock = t.time;
    const stop: ControlInputs = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };
    if (this.path.length < 2) return { controls: stop, status: { remaining: 0, target: 0, arrived: true, stuck: false, offPath: 0 } };
    // Position in the path's frame (the path is continuous from where it was planned).
    const p0 = this.path[0];
    const x = p0[0] + wrapCoord(t.position[0] - p0[0]), z = p0[1] + wrapCoord(t.position[2] - p0[1]);
    // Advance to the nearest segment (searching a little ahead only: never jump back).
    let best = this.idx, bd = Infinity, bs = 0;
    for (let i = this.idx; i < Math.min(this.path.length - 1, this.idx + 8); i++) {
      const [d, s] = segDist(x, z, this.path[i], this.path[i + 1]);
      if (d < bd) { bd = d; best = i; bs = s; }
    }
    this.idx = best;
    const along = this.cum[best] + bs * (this.cum[best + 1] - this.cum[best]);
    const remaining = this.length - along;
    if (bd > 30 && t.time - this.lastReroute > 3 && this.goal) {
      this.lastReroute = t.time;
      this.plan(t.position[0], t.position[2], this.goal[0], this.goal[1]);
      return this.drive(dt, t, cruise);
    }
    const v = t.groundSpeed;
    if (remaining < 6) return { controls: stop, status: { remaining, target: 0, arrived: v < 1, stuck: false, offPath: bd } };
    // Look-ahead point.
    const look = Math.min(45, 7 + v * 0.9);
    const [lx, lz] = this.pointAt(Math.min(this.length, along + look));
    const want = Math.atan2(lx - x, -(lz - z)) * (180 / Math.PI);
    let err = want - t.heading;
    err = ((err + 540) % 360) - 180;
    const yaw = Math.max(-1, Math.min(1, (err / 28) * this.steerSign));
    // Speed: cruise, the next corner, the stop at the end.
    let target = cruise;
    let dist = 0;
    for (let i = best + 1; i < this.path.length - 1 && dist < 140; i++) {
      dist = this.cum[i] - along;
      const a = turnAngle(this.path[i - 1], this.path[i], this.path[i + 1]);
      if (a < 20) continue;
      const vc = Math.max(6, 22 - a * 0.16);
      target = Math.min(target, Math.sqrt(vc * vc + 2 * ACCEL * Math.max(0, dist - 4)));
    }
    target = Math.min(target, Math.sqrt(2 * ACCEL * Math.max(0, remaining - 5)));
    // Big heading error: slow down to turn.
    if (Math.abs(err) > 45) target = Math.min(target, 5);
    // Light walls across the path ahead: stop short of them; if one blocks the road, re-route.
    const hit = this.walls ? this.scanWalls(x, z, along, Math.min(remaining, 25 + (v * v) / (2 * ACCEL) + 15), t) : null;
    this.wallAhead = hit ? hit.d : Infinity;
    if (hit) {
      target = Math.min(target, Math.sqrt(2 * ACCEL * Math.max(0, hit.d - 9)));
      this.blockedFor = hit.d < 20 && v < 1 ? this.blockedFor + dt : 0;
      if (this.blockedFor > 1.5 && this.goal && t.time - this.lastReroute > 2) {
        this.lastReroute = t.time;
        this.blockedFor = 0;
        const [ax, i, j] = segmentAt(hit.x, hit.z);
        this.blocked.set(`${ax ? 1 : 0},${i},${j}`, t.time);
        const gx = this.goal[0], gz = this.goal[1];
        if (this.plan(t.position[0], t.position[2], gx, gz)) return this.drive(dt, t, cruise);
      }
    } else this.blockedFor = 0;
    const ev = target - v;
    let throttle = Math.max(0, Math.min(1, 0.25 + ev * 0.18));
    let brake = 0;
    if (ev < -1.5) { throttle = 0; brake = Math.min(1, -ev / 6); }
    // Stuck: pushing but not moving.
    this.stuckTime = throttle > 0.5 && v < 0.6 ? this.stuckTime + dt : 0;
    return {
      controls: { pitch: 0, roll: 0, yaw, throttle, brake },
      status: { remaining, target, arrived: false, stuck: this.stuckTime > 6, offPath: bd },
    };
  }

  /** First light wall crossing the lane path within `reach` m ahead (with a 2.2 m body margin). */
  private scanWalls(x: number, z: number, along: number, reach: number, t: Telemetry): { d: number; x: number; z: number } | null {
    // Walls in the path's frame (the path is unbounded; walls come in world coordinates).
    const segs = this.walls!(t.position[0], t.position[2], reach + 10);
    if (!segs.length) return null;
    const ox = x - t.position[0], oz = z - t.position[2];
    const step = 2;
    for (let s = 3; s <= reach; s += step) {
      const [px, pz] = this.pointAt(along + s);
      for (const [ax, az, bx, bz] of segs) {
        const [d] = segDist(px, pz, [ax + ox, az + oz], [bx + ox, bz + oz]);
        if (d < 2.2) return { d: s, x: px - ox, z: pz - oz };
      }
    }
    return null;
  }

  private pointAt(s: number): [number, number] {
    let i = this.idx;
    while (i < this.cum.length - 2 && this.cum[i + 1] < s) i++;
    const seg = this.cum[i + 1] - this.cum[i] || 1;
    const k = Math.max(0, Math.min(1, (s - this.cum[i]) / seg));
    return [this.path[i][0] + (this.path[i + 1][0] - this.path[i][0]) * k, this.path[i][1] + (this.path[i + 1][1] - this.path[i][1]) * k];
  }
}

/** Distance from (x, z) to segment a-b and the parameter of the closest point. */
function segDist(x: number, z: number, a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L2 = dx * dx + dz * dz || 1;
  const s = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2));
  return [Math.hypot(a[0] + dx * s - x, a[1] + dz * s - z), s];
}

/** Change of direction at b (deg). */
function turnAngle(a: [number, number], b: [number, number], c: [number, number]): number {
  const h1 = Math.atan2(b[0] - a[0], b[1] - a[1]), h2 = Math.atan2(c[0] - b[0], c[1] - b[1]);
  let d = Math.abs(h2 - h1) * (180 / Math.PI);
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * Offset a polyline to the right of its direction of travel (drive on the right) by `d` metres;
 * corners use the bisector so lanes meet. Ends keep their point (access legs).
 */
function laneOffset(pts: Array<[number, number]>, d: number): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const out: Array<[number, number]> = [pts[0]];
  const right = (a: [number, number], b: [number, number]): [number, number] => {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    // Heading vector (dx, dz); right of it with x right, z toward the viewer (compass): (-dz, dx).
    return [-dz / L, dx / L];
  };
  for (let i = 1; i < pts.length - 1; i++) {
    const r1 = right(pts[i - 1], pts[i]), r2 = right(pts[i], pts[i + 1]);
    let bx = r1[0] + r2[0], bz = r1[1] + r2[1];
    const L = Math.hypot(bx, bz);
    if (L < 1e-3) { bx = r1[0]; bz = r1[1]; } else { bx /= L; bz /= L; }
    const cos = Math.max(0.5, bx * r1[0] + bz * r1[1]);
    out.push([pts[i][0] + (bx * d) / cos, pts[i][1] + (bz * d) / cos]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
