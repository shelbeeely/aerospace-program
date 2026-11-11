import * as THREE from 'three';
import type { WeaponKind, WeaponSystem } from '../sim/weapons.ts';
import { WEAPONS } from '../sim/weapons.ts';

/**
 * Networked damage, the shooter's side: the player's own rounds are tested against the other
 * players as they are drawn on this screen. A hit is reported (the victim's game applies it;
 * see Simulation.applyRemoteHit). Pure (no DOM, no scene), so it can be tested headless.
 */

/** Another player to test against: where it is drawn here and how big it is. */
export interface NetTarget {
  id: string;
  pos: THREE.Vector3;
  radius: number;
}

export interface NetHit {
  target: string;
  kind: WeaponKind;
  point: THREE.Vector3;
}

const _d = new THREE.Vector3();
const _m = new THREE.Vector3();

/** Where along segment a→b (0..1) it first comes within r of c, or null. */
export function segmentHitsSphere(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, r: number): number | null {
  _d.subVectors(b, a);
  const len2 = _d.lengthSq();
  _m.subVectors(a, c);
  if (len2 < 1e-9) return _m.lengthSq() <= r * r ? 0 : null;
  const bq = _m.dot(_d), cq = _m.lengthSq() - r * r;
  if (cq <= 0) return 0; // starts inside
  const disc = bq * bq - len2 * cq;
  if (disc < 0) return null;
  const t = (-bq - Math.sqrt(disc)) / len2;
  return t >= 0 && t <= 1 ? t : null;
}

/**
 * Tracks the player's rounds between frames and reports which crossed another player: rounds
 * in flight (the segment flown since the last scan), beams and railgun slugs (their whole
 * line), and blasts that went off within their radius of one. A round that hits is removed
 * here, as it would be on a collider.
 */
export class ShotScanner {
  private readonly last = new Map<number, THREE.Vector3>();
  private beamsSeen = new Set<object>();
  private impactsSeen = new Set<object>();

  scan(weapons: WeaponSystem, targets: NetTarget[]): NetHit[] {
    const out: NetHit[] = [];
    if (!targets.length) {
      this.remember(weapons);
      return out;
    }
    const live = new Set<number>();
    for (let i = weapons.projectiles.length - 1; i >= 0; i--) {
      const p = weapons.projectiles[i];
      live.add(p.id);
      const from = this.last.get(p.id);
      if (from) {
        let best: { t: number; target: NetTarget } | null = null;
        for (const tg of targets) {
          const t = segmentHitsSphere(from, p.pos, tg.pos, tg.radius);
          if (t !== null && (!best || t < best.t)) best = { t, target: tg };
        }
        if (best) {
          out.push({ target: best.target.id, kind: p.kind, point: from.clone().lerp(p.pos, best.t) });
          weapons.projectiles.splice(i, 1);
          this.last.delete(p.id);
          continue;
        }
      }
      (this.last.get(p.id) ?? this.last.set(p.id, new THREE.Vector3()).get(p.id)!).copy(p.pos);
    }
    for (const id of [...this.last.keys()]) if (!live.has(id)) this.last.delete(id);
    // Beams and railgun slugs: the whole line (a railgun goes through, a beam stops at the first).
    for (const b of weapons.beams) {
      if (this.beamsSeen.has(b)) continue;
      this.beamsSeen.add(b);
      const kind = b.kind ?? 'laser';
      const hits = targets
        .map((tg) => ({ tg, t: segmentHitsSphere(b.a, b.b, tg.pos, tg.radius) }))
        .filter((h) => h.t !== null)
        .sort((x, y) => x.t! - y.t!);
      for (const h of hits.slice(0, WEAPONS[kind].pierce ?? 1)) out.push({ target: h.tg.id, kind, point: b.a.clone().lerp(b.b, h.t!) });
    }
    // Blasts that went off near another player (missiles, cannon shells, bombs).
    for (const h of weapons.impacts) {
      if (this.impactsSeen.has(h)) continue;
      this.impactsSeen.add(h);
      if (h.blast < 3 || h.kind === 'nuke' || h.kind === 'emp') continue;
      for (const tg of targets) if (h.point.distanceTo(tg.pos) < h.blast + tg.radius) out.push({ target: tg.id, kind: h.kind, point: h.point.clone() });
    }
    if (this.beamsSeen.size > 256) this.beamsSeen = new Set(weapons.beams);
    if (this.impactsSeen.size > 256) this.impactsSeen = new Set(weapons.impacts);
    return out;
  }

  /** Nothing to test against: just keep up with the rounds (so a target appearing doesn't get a long sweep). */
  private remember(weapons: WeaponSystem): void {
    this.last.clear();
    for (const p of weapons.projectiles) this.last.set(p.id, p.pos.clone());
    for (const b of weapons.beams) this.beamsSeen.add(b);
    for (const h of weapons.impacts) this.impactsSeen.add(h);
  }
}
