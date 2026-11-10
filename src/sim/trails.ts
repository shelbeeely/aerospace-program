import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Craft } from '../craft/Craft.ts';
import type { TrailDef } from '../craft/types.ts';
import { TrailEmitter } from '../modules/TrailEmitter.ts';
import type { ChipEmitter } from './chips.ts';
import { terrainHeight } from './terrain.ts';

/**
 * Rule 4, movement produces visible information. Light cycles lay down light walls; aircraft
 * leave thin energy paths.
 *
 * - **Jetwall** (mode 'wall'): solid light, a static collider per segment you crash into. It
 *   stays until its cycle derezzes.
 * - **Light ribbon** (mode 'ribbon'): the faded form. It dissipates RIBBON_LENGTH behind the
 *   cycle, so high-speed open-terrain travel doesn't permanently block the way, and it is
 *   solid only while it is lit.
 * - **Off**: the rider deactivates the trail; re-enabling starts a new one.
 * - **Derez**: when the vehicle is destroyed or respawns, every trail it laid derezzes with it
 *   (colliders go at once, the light flickers out over DEREZ_TIME).
 * - **Every vehicle has one.** Craft without trail modules get light ribbons automatically: from
 *   their outermost points on each side (aircraft: wingtips, rotor arms, a blimp's flanks; kind
 *   'contrail', light only, no collider) or a jetwall from the rear (ground vehicles). Airborne
 *   ribbons show above RIBBON_MIN_SPEED and dissipate a speed-scaled distance behind.
 */
export type TrailMode = 'wall' | 'ribbon' | 'off';

export interface TrailPoint {
  x: number;
  z: number;
  /** Bottom and top of the light at this point (walls stand on the ground). */
  y0: number;
  y1: number;
  time: number;
  /** Distance laid so far along the trail (m). */
  arc: number;
  /** Collider of the segment ending at this point (walls only). */
  collider?: RAPIER.Collider;
}

export interface Trail {
  id: number;
  kind: TrailDef['kind'];
  color: string;
  height: number;
  points: TrailPoint[];
  /** Still attached to its emitter (not derezzing, not switched off). */
  active: boolean;
  derezAt: number | null;
  emitter: THREE.Vector3;
}

const WALL_SEGMENT = 1.5;
const CONTRAIL_SEGMENT = 3;
const WALL_THICKNESS = 0.18;
/** A segment becomes solid once the cycle is this far past its end (so it never hits its own wall). */
const SOLID_DELAY = 4;
export const RIBBON_LENGTH = 90;
export const DEREZ_TIME = 0.9;
export const CONTRAIL_LIFE = 5;
/** Airborne light ribbons appear above this speed (m/s). */
const RIBBON_MIN_SPEED = 6;
/** How far behind an airborne ribbon reaches: RIBBON_LENGTH, or this many seconds of travel. */
export const AIR_RIBBON_SECONDS = 2.5;

const _p = new THREE.Vector3();

export class TrailSystem {
  readonly trails: Trail[] = [];
  mode: TrailMode = 'wall';
  /** Bumped when trails start, end or are removed (renderers rebuild). */
  version = 0;
  private nextId = 1;
  private readonly body: RAPIER.RigidBody;
  private readonly colliderOwner = new Map<number, Trail>();

  constructor(private readonly world: RAPIER.World) {
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  }

  /** Is this collider part of a light wall? */
  isWall(handle: number): boolean {
    return this.colliderOwner.has(handle);
  }

  /** Fresh trails for a craft: its trail modules, or automatic light ribbons (every vehicle has one). */
  start(craft: Craft, airplane: boolean): void {
    const emitters: Array<{ def: TrailDef; at: THREE.Vector3 }> = [];
    for (const m of craft.modules) if (m instanceof TrailEmitter) emitters.push({ def: m.def, at: m.localPosition.clone() });
    const ground = craft.wheels.some((w) => (w.def.drive ?? 0) > 0);
    if (!emitters.length && ground) {
      // A ground vehicle without its own trail: a jetwall from the rear of the craft.
      let rear = -Infinity;
      for (const p of craft.parts) rear = Math.max(rear, p.position[2]);
      emitters.push({ def: { type: 'trail', kind: 'wall', height: 1.6, color: '#00eaff' }, at: new THREE.Vector3(0, 0.3, rear) });
    } else if (!emitters.length) {
      // Aircraft: ribbons from the outermost points on each side (wingtips, rotor arms, flanks).
      let left: THREE.Vector3 | null = null, right: THREE.Vector3 | null = null;
      const lifting = craft.parts.some((p) => (p.modules ?? []).some((m) => m.type === 'aero'));
      for (const p of craft.parts) {
        if (p.collider === false) continue;
        if (airplane && lifting && !(p.modules ?? []).some((m) => m.type === 'aero')) continue;
        const half = p.shape.type === 'box' ? p.shape.size[0] / 2 : p.shape.type === 'sphere' ? p.shape.radius : p.shape.axis === 'x' ? p.shape.length / 2 : p.shape.radius;
        const lx = p.position[0] - half, rx = p.position[0] + half;
        if (!left || lx < left.x) left = new THREE.Vector3(lx, p.position[1], p.position[2]);
        if (!right || rx > right.x) right = new THREE.Vector3(rx, p.position[1], p.position[2]);
      }
      if (left && right && right.x - left.x > 0.4) {
        const span = right.x - left.x;
        const height = Math.min(0.9, Math.max(0.25, span * 0.06));
        for (const at of [left, right]) emitters.push({ def: { type: 'trail', kind: 'contrail', height, color: '#38c8ff' }, at });
      }
    }
    for (const e of emitters) this.trails.push({ id: this.nextId++, kind: e.def.kind, color: e.def.color, height: e.def.height, points: [], active: true, derezAt: null, emitter: e.at });
    this.version++;
  }

  /** Where derezzing light walls shatter into voxels (set by the simulation; optional). */
  chips: ChipEmitter | null = null;

  /** The vehicle is gone or respawned: everything it laid derezzes. */
  derez(time: number): void {
    for (const t of this.trails) {
      if (t.derezAt !== null) continue;
      t.active = false;
      t.derezAt = time;
      for (const p of t.points) this.dropCollider(p);
      this.shatter(t);
    }
    this.version++;
  }

  /** A derezzing light wall shatters into voxels of its colour along its length, which stay on the Grid. */
  private shatter(t: Trail): void {
    if (!this.chips || t.kind !== 'wall' || t.points.length < 2) return;
    const step = Math.max(1, Math.floor(t.points.length / 160)); // at most ~160 bursts per wall
    for (let i = 0; i < t.points.length; i += step) {
      const p = t.points[i];
      this.chips.emit({ x: p.x, y: (p.y0 + p.y1) / 2, z: p.z, radius: (p.y1 - p.y0) / 2, vx: 0, vy: 1, vz: 0, speed: 2.5, count: 6, size: 0.22, color: t.color, persist: true });
    }
  }

  /** Rider control: jetwall → light ribbon → off → jetwall. */
  cycleMode(craft: Craft, airplane: boolean, time: number): TrailMode {
    const hasWall = this.trails.some((t) => t.kind === 'wall');
    // Aircraft ribbons are light only: their choice is ribbon or off.
    this.mode = this.mode === 'wall' ? 'ribbon' : this.mode === 'ribbon' ? 'off' : hasWall || !this.trails.length ? 'wall' : 'ribbon';
    if (this.mode === 'off') {
      // Deactivated: the trail derezzes behind the vehicle.
      for (const t of this.trails) if (t.derezAt === null) {
        t.active = false;
        t.derezAt = time;
        for (const p of t.points) this.dropCollider(p);
      }
    } else if (!this.trails.some((t) => t.active)) {
      // Back on: the emitters start new trails.
      this.start(craft, airplane);
    }
    this.version++;
    return this.mode;
  }

  step(time: number, craft: Craft, rotation: THREE.Quaternion, position: THREE.Vector3, airspeed: number, onGround: boolean): void {
    let changed = false;
    for (let i = this.trails.length - 1; i >= 0; i--) {
      const t = this.trails[i];
      if (t.derezAt !== null) {
        if (time - t.derezAt > DEREZ_TIME) { this.trails.splice(i, 1); changed = true; }
        continue;
      }
      if (t.kind === 'contrail' && t.points.length) {
        // An airborne light ribbon dissipates a speed-scaled distance behind its head.
        const reach = Math.max(RIBBON_LENGTH, airspeed * AIR_RIBBON_SECONDS);
        const head = t.points.at(-1)!.arc;
        while (t.points.length > 1 && head - t.points[1].arc > reach) t.points.shift();
        // Left behind (stopped, or switched off): the ribbon fades out in time instead.
        while (t.points.length && time - t.points.at(-1)!.time > CONTRAIL_LIFE && time - t.points[0].time > CONTRAIL_LIFE) t.points.shift();
        if (!t.active && !t.points.length) { this.trails.splice(i, 1); changed = true; continue; }
      }
      if (!t.active) {
        if (t.kind === 'wall' && this.mode === 'ribbon') this.fadeRibbon(t, t.points.at(-1)?.arc ?? 0);
        continue;
      }
      _p.copy(t.emitter).applyQuaternion(rotation).add(position);
      const emitting = this.mode !== 'off' && (t.kind === 'wall' || airspeed > RIBBON_MIN_SPEED);
      if (!emitting) {
        if (t.kind === 'contrail' && t.points.length) t.points.at(-1)!.time = Math.min(t.points.at(-1)!.time, time); // gap
        continue;
      }
      const last = t.points.at(-1);
      const seg = t.kind === 'wall' ? WALL_SEGMENT : CONTRAIL_SEGMENT;
      const d = last ? Math.hypot(_p.x - last.x, _p.z - last.z, t.kind === 'contrail' ? _p.y - (last.y0 + last.y1) / 2 : 0) : Infinity;
      if (d >= seg) {
        const ground = t.kind === 'wall' ? terrainHeight(_p.x, _p.z) : 0;
        const y0 = t.kind === 'wall' ? ground : _p.y - t.height / 2;
        const y1 = t.kind === 'wall' ? ground + t.height : _p.y + t.height / 2;
        // A long gap (teleport, wrap) starts a fresh run instead of a wall across the world.
        if (last && d > 60) {
          t.active = false;
          this.trails.push({ ...t, id: this.nextId++, points: [], active: true, derezAt: null, emitter: t.emitter.clone() });
          changed = true;
          continue;
        }
        t.points.push({ x: _p.x, z: _p.z, y0, y1, time, arc: (last?.arc ?? 0) + (Number.isFinite(d) ? d : 0) });
        changed = true;
      }
      if (t.kind === 'wall') {
        const head = t.points.at(-1)!;
        const headArc = head.arc + Math.hypot(_p.x - head.x, _p.z - head.z);
        // Solidify segments the cycle has cleared.
        for (let k = t.points.length - 1; k >= 1; k--) {
          const p = t.points[k];
          if (p.collider) break;
          if (headArc - p.arc < SOLID_DELAY) continue;
          if (this.mode === 'ribbon' && headArc - p.arc > RIBBON_LENGTH) continue;
          this.solidify(t, t.points[k - 1], p);
        }
        if (this.mode === 'ribbon') this.fadeRibbon(t, headArc);
      }
    }
    if (changed) this.version++;
    void craft;
    void onGround;
  }

  /** Light ribbons: drop everything more than RIBBON_LENGTH behind the head. */
  private fadeRibbon(t: Trail, headArc: number): void {
    while (t.points.length > 1 && headArc - t.points[1].arc > RIBBON_LENGTH) {
      this.dropCollider(t.points[1]);
      t.points.shift();
    }
  }

  private solidify(t: Trail, a: TrailPoint, b: TrailPoint): void {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.05) return;
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    const y0 = Math.min(a.y0, b.y0), y1 = Math.max(a.y1, b.y1);
    const desc = RAPIER.ColliderDesc.cuboid(WALL_THICKNESS / 2, (y1 - y0) / 2, len / 2)
      .setTranslation((a.x + b.x) / 2, (y0 + y1) / 2, (a.z + b.z) / 2)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setFriction(0.4).setRestitution(0.1);
    b.collider = this.world.createCollider(desc, this.body);
    this.colliderOwner.set(b.collider.handle, t);
  }

  private dropCollider(p: TrailPoint): void {
    if (!p.collider) return;
    this.colliderOwner.delete(p.collider.handle);
    this.world.removeCollider(p.collider, false);
    p.collider = undefined;
  }

  /** Remove everything at once (world reset). */
  clear(): void {
    for (const t of this.trails) for (const p of t.points) this.dropCollider(p);
    this.trails.length = 0;
    this.version++;
  }

  get colliderCount(): number {
    return this.colliderOwner.size;
  }
}
