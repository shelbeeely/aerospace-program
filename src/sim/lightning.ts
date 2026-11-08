import * as THREE from 'three';
import { HAZARDS } from '../tuning.ts';

export const thunderDelay = (distance: number): number => Math.max(0, distance) / HAZARDS.soundSpeed;

/** Safe, seeded PRNG shared by lightning scheduling and leader geometry. */
export function hazardRandom(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export interface StrikeTarget { id: string; position: THREE.Vector3; craftPart?: string }
export interface LightningStrike {
  id: number;
  time: number;
  target: StrikeTarget;
  points: THREE.Vector3[];
  energyJ: number;
}
/** Rolling-sphere approximation: tall conductors intercept the descending leader first.
 * Horizontal separation reduces effective height by the sphere's sagitta. */
export function strikeTarget(x: number, z: number, targets: readonly StrikeTarget[], radius: number = HAZARDS.strikeRadius): StrikeTarget {
  let target: StrikeTarget = { id: 'ground', position: new THREE.Vector3(x, 0, z) };
  let best = 0;
  for (const t of targets) {
    const d2 = (t.position.x - x) ** 2 + (t.position.z - z) ** 2;
    if (d2 > radius * radius) continue;
    const effective = t.position.y - (radius - Math.sqrt(radius * radius - d2));
    if (effective > best) { best = effective; target = t; }
  }
  return { ...target, position: target.position.clone() };
}
/** A stepped, jagged descending leader ending exactly on the conductor. */
export function steppedLeader(target: THREE.Vector3, cloudHeight: number, random: () => number): THREE.Vector3[] {
  const start = new THREE.Vector3(target.x + (random() - 0.5) * 100, Math.max(target.y + 100, cloudHeight), target.z + (random() - 0.5) * 100);
  const points = [start];
  for (let i = 1; i < 24; i++) {
    const t = i / 24;
    const p = start.clone().lerp(target, t);
    const jitter = 25 * Math.sin(Math.PI * t);
    p.x += (random() - 0.5) * jitter; p.z += (random() - 0.5) * jitter;
    points.push(p);
  }
  points.push(target.clone());
  return points;
}
/** A bounded, deterministic strike history. Calm air never consumes the hazard clock. */
export class LightningSystem {
  readonly strikes: LightningStrike[] = [];
  private random: () => number;
  private untilStrike = 0;
  private serial = 0;
  constructor(seed: number) { this.random = hazardRandom(seed); this.reset(seed); }
  reset(seed: number): void {
    this.random = hazardRandom(seed); this.untilStrike = this.interval(); this.strikes.length = 0;
  }
  private interval(): number { return HAZARDS.strikeIntervalMin + this.random() * HAZARDS.strikeIntervalRange; }
  trigger(time: number, x: number, z: number, targets: readonly StrikeTarget[], cloudHeight = 800): LightningStrike {
    const target = strikeTarget(x, z, targets);
    const strike = { id: ++this.serial, time, target, points: steppedLeader(target.position, cloudHeight, this.random), energyJ: HAZARDS.strikeEnergyMinJ + this.random() * HAZARDS.strikeEnergyRangeJ };
    this.strikes.push(strike);
    if (this.strikes.length > 32) this.strikes.shift();
    return strike;
  }
  step(dt: number, time: number, intensity: number, center: THREE.Vector3, targets: readonly StrikeTarget[], cloudHeight = 800): LightningStrike | null {
    if (!(intensity > 0)) return null;
    this.untilStrike -= dt * Math.min(1, intensity);
    if (this.untilStrike > 0) return null;
    this.untilStrike += this.interval();
    return this.trigger(time, center.x + (this.random() - 0.5) * 700, center.z + (this.random() - 0.5) * 700, targets, cloudHeight);
  }
}
