import * as THREE from 'three';
import { groundAcceleration, groundDisplacement } from './earthquake.ts';
import { hurricaneRain, hurricaneWind, surgeHeight, type Hurricane } from './hurricane.ts';
import { tornadoWind, type Tornado } from './tornado.ts';

export type EventKind = 'tornado' | 'hurricane' | 'earthquake';
export interface EventOptions {
  x?: number;
  z?: number;
  duration?: number;
  /** Multiplier 0..2, applied to wind, ground motion, rain and surge. */
  strength?: number;
}
export interface WorldEvent {
  readonly id: number;
  readonly kind: EventKind;
  readonly start: number;
  readonly duration: number;
  readonly strength: number;
  readonly seed: number;
  readonly tornado: Tornado;
  readonly hurricane: Hurricane;
}

/** Explicit schedules by default: normal flights remain safe until a disaster is triggered. */
export class WorldEvents {
  time = 0;
  private seed: number;
  private state: number;
  private nextId = 0;
  private events: WorldEvent[] = [];
  private readonly scratch = new THREE.Vector3();

  constructor(seed = 1) {
    this.seed = seed;
    this.state = seed;
  }

  reset(seed = this.seed): void {
    this.seed = seed;
    this.state = seed;
    this.nextId = 0;
    this.time = 0;
    this.events.length = 0;
  }

  private random(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Schedule using absolute weather time. Trigger order + seed reproduce the same trace. */
  schedule(kind: EventKind, start: number, options: EventOptions = {}): WorldEvent {
    if (!['tornado', 'hurricane', 'earthquake'].includes(kind)) throw new Error(`Unknown event: ${kind}`);
    if (!Number.isFinite(start) || start < this.time) throw new Error('Event start must be finite and not in the past');
    for (const value of [options.x, options.z, options.duration, options.strength]) {
      if (value !== undefined && !Number.isFinite(value)) throw new Error('Event options must be finite');
    }
    const duration = options.duration ?? (kind === 'earthquake' ? 20 : kind === 'tornado' ? 120 : 240);
    if (duration <= 0) throw new Error('Event duration must be positive');
    const angle = this.random() * Math.PI * 2;
    const x = options.x ?? -900 + this.random() * 300;
    const z = options.z ?? -500 + this.random() * 500;
    const event: WorldEvent = {
      id: this.nextId++, kind, start, duration,
      strength: Math.max(0, Math.min(2, options.strength ?? 1)),
      seed: (this.random() * 4294967296) >>> 0,
      tornado: { x, z, velocityX: Math.cos(angle) * 4, velocityZ: Math.sin(angle) * 4, coreRadius: 75, peakSpeed: 55, height: 900 },
      hurricane: { x, z, maxRadius: 1200, peakSpeed: 48, hollandB: 1.5 },
    };
    // Bound retained events even under repeated UI triggers.
    this.events = this.events.filter(e => e.start + e.duration > this.time);
    if (this.events.length >= 32) throw new Error('At most 32 world events may be scheduled');
    this.events.push(event);
    return event;
  }

  trigger(kind: EventKind, options: EventOptions = {}): WorldEvent {
    return this.schedule(kind, this.time, options);
  }

  advance(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0) throw new Error('Event dt must be finite and nonnegative');
    this.time += dt;
    this.events = this.events.filter(e => e.start + e.duration > this.time);
  }

  get active(): readonly WorldEvent[] {
    return this.events.filter(e => e.start <= this.time && this.time < e.start + e.duration);
  }

  /** Smooth two-second onset/decay, so a trigger never teleports the air mass. */
  intensity(event: WorldEvent): number {
    const age = this.time - event.start;
    if (age < 0 || age >= event.duration) return 0;
    const edge = Math.min(2, event.duration / 4);
    const x = Math.min(1, age / edge, (event.duration - age) / edge);
    return event.strength * x * x * (3 - 2 * x);
  }

  addWind(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    for (const e of this.events) {
      const intensity = this.intensity(e);
      if (!intensity || e.kind === 'earthquake') continue;
      this.scratch.set(0, 0, 0);
      if (e.kind === 'tornado') tornadoWind(p, this.time - e.start, e.tornado, this.scratch);
      else hurricaneWind(p, e.hurricane, this.scratch);
      out.addScaledVector(this.scratch, intensity);
    }
    return out;
  }

  rainAt(x: number, z: number): number {
    let rain = 0;
    for (const e of this.events) if (e.kind === 'hurricane') {
      rain += this.intensity(e) * hurricaneRain(x, z, this.time - e.start, e.hurricane);
    }
    return rain;
  }

  surgeHeight(x: number, z = 0, time = this.time): number {
    let height = 0;
    for (const e of this.events) if (e.kind === 'hurricane' && time >= e.start && time < e.start + e.duration) {
      height += surgeHeight(x, (time - e.start) * 360 / e.duration, 3 * e.strength) * Math.exp(-Math.abs(z - e.hurricane.z) / 8000);
    }
    return height;
  }

  groundDisplacement(out = new THREE.Vector3()): THREE.Vector3 {
    out.set(0, 0, 0);
    for (const e of this.events) if (e.kind === 'earthquake') {
      groundDisplacement(this.time - e.start, e.duration, e.seed, 0.12 * e.strength, this.scratch);
      out.add(this.scratch);
    }
    return out;
  }

  groundAcceleration(out = new THREE.Vector3()): THREE.Vector3 {
    out.set(0, 0, 0);
    for (const e of this.events) if (e.kind === 'earthquake') {
      groundAcceleration(this.time - e.start, e.duration, e.seed, 0.12 * e.strength, this.scratch);
      out.add(this.scratch);
    }
    return out;
  }

  clear(): void { this.events.length = 0; }
}
