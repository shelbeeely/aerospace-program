import * as THREE from 'three';
import { PLANET } from './layout.ts';

/** Shortest signed distance from a to b along one wrapped axis (m). */
function wrapDelta(a: number, b: number): number {
  const C = PLANET.circumference;
  const d = b - a;
  return d - C * Math.round(d / C);
}

/**
 * Target lock. A lock target is a live handle to a vehicle (an AI aircraft, a light-cycle rider,
 * another player, or the player's own craft as hostiles see it): where it is and how fast it is
 * going now, and whether it still exists. The lock system picks the vehicle nearest the aim
 * line, tracks it, and locks it once it has stayed on the line long enough; locked missiles
 * home on it, a turret aims at it, and the flight computer can chase it.
 */

export type LockKind = 'aircraft' | 'hostile' | 'rider' | 'player' | 'self';

export interface LockTarget {
  id: string;
  kind: LockKind;
  name: string;
  /** Bounding radius (m): the proximity fuse and the turret's aim allow for it. */
  radius: number;
  alive(): boolean;
  position(out: THREE.Vector3): THREE.Vector3;
  velocity(out: THREE.Vector3): THREE.Vector3;
}

const DEG = Math.PI / 180;
export const LOCK = {
  /** A vehicle within this range (m) and this angle of the aim line can be tracked. */
  range: 3000,
  cone: 20 * DEG,
  /** Once tracked, it is kept until it leaves this range and angle (no flicker at the edge). */
  keepRange: 3500,
  keepCone: 30 * DEG,
  /** Seconds on the line before the track becomes a lock. */
  lockTime: 1.2,
} as const;

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Where `target` is from `origin` (the short way round the planet), into `out`. */
export function relativePosition(origin: THREE.Vector3, target: LockTarget, out: THREE.Vector3): THREE.Vector3 {
  target.position(_p);
  return out.set(wrapDelta(origin.x, _p.x), _p.y - origin.y, wrapDelta(origin.z, _p.z));
}

export class LockSystem {
  /** The vehicle on the aim line (acquiring or locked), or null. */
  tracked: LockTarget | null = null;
  /** Seconds it has been tracked. */
  held = 0;

  get locked(): boolean {
    return !!this.tracked && this.held >= LOCK.lockTime;
  }

  /** The locked target, or null while there is none (or it is still being acquired). */
  get target(): LockTarget | null {
    return this.locked ? this.tracked : null;
  }

  clear(): void {
    this.tracked = null;
    this.held = 0;
  }

  /** Angle off the aim line and range of a target, or null if it isn't there. */
  private measure(origin: THREE.Vector3, aim: THREE.Vector3, t: LockTarget): { angle: number; range: number } | null {
    if (!t.alive()) return null;
    relativePosition(origin, t, _d);
    const range = _d.length();
    if (range < 1) return { angle: 0, range };
    return { angle: Math.acos(Math.max(-1, Math.min(1, _d.dot(aim) / range))), range };
  }

  /** Update from the aim line (`aim`: unit vector) and the vehicles around. */
  step(dt: number, origin: THREE.Vector3, aim: THREE.Vector3, targets: Iterable<LockTarget>): void {
    if (this.tracked) {
      const m = this.measure(origin, aim, this.tracked);
      if (m && m.angle < LOCK.keepCone && m.range < LOCK.keepRange) {
        this.held += dt;
        // Acquiring (not yet locked): a target nearer the line takes over.
        if (this.locked) return;
      } else this.clear();
    }
    let best: LockTarget | null = null, bestAngle = Infinity;
    for (const t of targets) {
      const m = this.measure(origin, aim, t);
      if (!m || m.angle > LOCK.cone || m.range > LOCK.range) continue;
      if (m.angle < bestAngle) { best = t; bestAngle = m.angle; }
    }
    if (best && best !== this.tracked && (!this.tracked || bestAngle < (this.measure(origin, aim, this.tracked)?.angle ?? Infinity) - 2 * DEG)) {
      this.tracked = best;
      this.held = 0;
    }
  }
}
