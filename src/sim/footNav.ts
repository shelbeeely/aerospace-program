import { CITY } from './layout.ts';
import { wrap180 } from './nav.ts';
import { findRoute } from './roads.ts';
import type { WalkInput } from './bits.ts';

/**
 * The Navigator on foot: walks the player's Bit to a destination along the road network, on the
 * kerb (never down the middle of the carriageway), or back to its parked vehicle and aboard.
 * DOM- and scene-free; the walker steps itself from the WalkInput this returns.
 *
 * - Go to: a route from `findRoute`, each leg moved over to the right-hand kerb.
 * - Vehicle: straight to the vehicle when it is close, by road when it is far, then boards.
 * - Any walking input from the player takes over (the caller disengages).
 */
export type FootNavMode = 'goto' | 'vehicle';

export interface FootNavState {
  engaged: boolean;
  mode: FootNavMode;
  /** walking | arrived */
  phase: string;
  destination: string | null;
  status: string;
  notice: string;
  guidance: { distance: number; eta: number; siteName: string; targetSpeed: number; glideslopeDev: null; localizerDev: null } | null;
}

/** Where the Bit is (feet and heading as BitWalker keeps them). */
export interface Walker {
  x: number;
  z: number;
  yaw: number;
}

export const FOOT_NAV = {
  /** Walking pace the Navigator asks for (m/s at full forward). */
  pace: 7,
  /** From the street's centreline to where a Bit walks (m): on the kerb. */
  kerb: CITY.street / 2 - 1.5,
  /** A waypoint counts as reached within this (m). */
  reach: 3,
  /** Closer than this to the vehicle, walk straight to it (m). */
  direct: 160,
  /** Turn input per radian of heading error, before it saturates. */
  turnGain: 2.2,
} as const;

interface Pt {
  x: number;
  z: number;
}

const OFF: FootNavState = { engaged: false, mode: 'goto', phase: 'off', destination: null, status: 'Off', notice: '', guidance: null };

export class FootNavigator {
  state: FootNavState = { ...OFF };
  private path: Pt[] = [];
  private next = 0;
  private target: Pt & { name: string } = { x: 0, z: 0, name: '' };

  /**
   * Engage. `to` is the destination (or the vehicle, for mode 'vehicle'). Returns null, or why
   * it cannot (no way there on foot).
   */
  engage(w: Walker, mode: FootNavMode, to: { x: number; z: number; name: string; id?: string | null }): string | null {
    this.target = { x: to.x, z: to.z, name: to.name };
    const far = Math.hypot(to.x - w.x, to.z - w.z) > FOOT_NAV.direct;
    let path: Pt[] = [];
    if (far) {
      const route = findRoute(w.x, w.z, to.x, to.z);
      if (!route) {
        this.state = { ...OFF, mode, notice: `No way to ${to.name} on foot` };
        return this.state.notice;
      }
      path = kerbside(route.points);
    }
    path.push({ x: to.x, z: to.z });
    this.path = path;
    this.next = 0;
    this.state = { engaged: true, mode, phase: 'walking', destination: to.id ?? null, status: `Walking to ${to.name}`, notice: '', guidance: null };
    return null;
  }

  disengage(status = 'Off'): void {
    this.state = { ...OFF, mode: this.state.mode, status };
    this.path = [];
  }

  /** Remaining distance along the path (m). */
  remaining(w: Walker): number {
    let d = 0, px = w.x, pz = w.z;
    for (let i = this.next; i < this.path.length; i++) {
      d += Math.hypot(this.path[i].x - px, this.path[i].z - pz);
      px = this.path[i].x; pz = this.path[i].z;
    }
    return d;
  }

  /**
   * One step: what to walk. `arriveWithin` is how close the final point must be (the vehicle's
   * boarding reach, or the waypoint radius). Returns 'arrived' once there (the state says so and
   * the Navigator is off), else the walk input.
   */
  sample(w: Walker, arriveWithin: number = FOOT_NAV.reach): WalkInput | 'arrived' {
    if (!this.state.engaged) return { forward: 0, turn: 0, strafe: 0 };
    // Skip waypoints already reached (and any the Bit has walked past towards the next).
    while (this.next < this.path.length - 1) {
      const p = this.path[this.next], q = this.path[this.next + 1];
      const passed = (q.x - p.x) * (w.x - p.x) + (q.z - p.z) * (w.z - p.z) > 0 && Math.hypot(w.x - q.x, w.z - q.z) < Math.hypot(p.x - q.x, p.z - q.z);
      if (Math.hypot(p.x - w.x, p.z - w.z) < FOOT_NAV.reach || passed) this.next++;
      else break;
    }
    const last = this.path[this.path.length - 1];
    if (this.next >= this.path.length - 1 && Math.hypot(last.x - w.x, last.z - w.z) < arriveWithin) {
      const name = this.target.name;
      this.state = { ...OFF, mode: this.state.mode, phase: 'arrived', status: `Arrived: ${name}` };
      this.path = [];
      return 'arrived';
    }
    const p = this.path[this.next];
    // BitWalker's forward is (-sin yaw, -cos yaw) and turn > 0 lowers yaw.
    const want = Math.atan2(-(p.x - w.x), -(p.z - w.z));
    const err = wrap180(((want - w.yaw) * 180) / Math.PI) * (Math.PI / 180);
    const turn = Math.max(-1, Math.min(1, -err * FOOT_NAV.turnGain));
    const forward = Math.abs(err) > 1.2 ? 0.15 : Math.max(0.3, Math.cos(err));
    const dist = this.remaining(w);
    this.state.guidance = { distance: dist, eta: dist / FOOT_NAV.pace, siteName: this.target.name, targetSpeed: FOOT_NAV.pace, glideslopeDev: null, localizerDev: null };
    this.state.status = `Walking to ${this.target.name} · ${dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`}`;
    return { forward, turn, strafe: 0 };
  }
}

/** A road route moved over to the right-hand kerb: each point offset from its incoming leg. */
export function kerbside(points: Array<{ x: number; z: number }>): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)], b = points[i], c = points[Math.min(points.length - 1, i + 1)];
    // Direction of the leg in and the leg out; the kerb is to the right of each.
    const nIn = rightOf(a, b), nOut = rightOf(b, c);
    let nx = nIn.x + nOut.x, nz = nIn.z + nOut.z;
    const len = Math.hypot(nx, nz);
    if (len < 1e-6) { nx = nOut.x; nz = nOut.z; } else { nx /= len; nz /= len; }
    // At a corner the kerb is further from the centreline point (the mitre), up to √2.
    const cos = nIn.x * nOut.x + nIn.z * nOut.z;
    const scale = (nIn.x || nIn.z) && (nOut.x || nOut.z) ? Math.min(Math.SQRT2, 1 / Math.max(0.7, Math.sqrt((1 + cos) / 2))) : 1;
    out.push({ x: b.x + nx * FOOT_NAV.kerb * scale, z: b.z + nz * FOOT_NAV.kerb * scale });
  }
  return out;
}

/** Unit vector to the right of travel from a to b (x right of -z forward), or zero. */
function rightOf(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-6) return { x: 0, z: 0 };
  // Facing -z, right is +x: right = (-dz, dx) / l.
  return { x: -dz / l, z: dx / l };
}
