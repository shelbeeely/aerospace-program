import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Craft } from '../craft/Craft.ts';
import type { TrailDef } from '../craft/types.ts';
import { TrailEmitter } from '../modules/TrailEmitter.ts';
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
 * - **Contrails** (aircraft): visual only, from the wingtips above CONTRAIL_SPEED, fading with age.
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
const CONTRAIL_SEGMENT = 4;
const WALL_THICKNESS = 0.18;
/** A segment becomes solid once the cycle is this far past its end (so it never hits its own wall). */
const SOLID_DELAY = 4;
export const RIBBON_LENGTH = 90;
export const DEREZ_TIME = 0.9;
export const CONTRAIL_LIFE = 5;
const CONTRAIL_SPEED = 35;

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

  /** Fresh trails for a craft (its trail modules, or wingtip contrails for an airplane). */
  start(craft: Craft, airplane: boolean): void {
    const emitters: Array<{ def: TrailDef; at: THREE.Vector3 }> = [];
    for (const m of craft.modules) if (m instanceof TrailEmitter) emitters.push({ def: m.def, at: m.localPosition.clone() });
    if (!emitters.length && airplane) {
      // Wingtip energy paths: the outermost collider parts on each side.
      let left: THREE.Vector3 | null = null, right: THREE.Vector3 | null = null;
      for (const p of craft.parts) {
        if (p.collider === false || !(p.modules ?? []).some((m) => m.type === 'aero')) continue;
        const half = p.shape.type === 'box' ? p.shape.size[0] / 2 : p.shape.type === 'sphere' ? p.shape.radius : p.shape.axis === 'x' ? p.shape.length / 2 : p.shape.radius;
        const lx = p.position[0] - half, rx = p.position[0] + half;
        if (!left || lx < left.x) left = new THREE.Vector3(lx, p.position[1], p.position[2]);
        if (!right || rx > right.x) right = new THREE.Vector3(rx, p.position[1], p.position[2]);
      }
      if (left && right && right.x - left.x > 2) {
        for (const at of [left, right]) emitters.push({ def: { type: 'trail', kind: 'contrail', height: 0.35, color: '#e8f6ff' }, at });
      }
    }
    for (const e of emitters) this.trails.push({ id: this.nextId++, kind: e.def.kind, color: e.def.color, height: e.def.height, points: [], active: true, derezAt: null, emitter: e.at });
    this.version++;
  }

  /** The vehicle is gone or respawned: everything it laid derezzes. */
  derez(time: number): void {
    for (const t of this.trails) {
      if (t.derezAt !== null) continue;
      t.active = false;
      t.derezAt = time;
      for (const p of t.points) this.dropCollider(p);
    }
    this.version++;
  }

  /** Rider control: jetwall → light ribbon → off → jetwall. */
  cycleMode(craft: Craft, airplane: boolean, time: number): TrailMode {
    this.mode = this.mode === 'wall' ? 'ribbon' : this.mode === 'ribbon' ? 'off' : 'wall';
    if (this.mode === 'off') {
      // Deactivated: the rider's wall derezzes behind them.
      for (const t of this.trails) if (t.kind === 'wall' && t.derezAt === null) {
        t.active = false;
        t.derezAt = time;
        for (const p of t.points) this.dropCollider(p);
      }
    } else if (!this.trails.some((t) => t.kind === 'wall' && t.active)) {
      // Back on: wall emitters start new trails (contrails keep going).
      const before = this.trails.length;
      this.start(craft, airplane);
      for (let i = this.trails.length - 1; i >= before; i--) if (this.trails[i].kind !== 'wall') this.trails.splice(i, 1);
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
      if (t.kind === 'contrail') {
        while (t.points.length && time - t.points[0].time > CONTRAIL_LIFE) t.points.shift();
        if (!t.active && !t.points.length) { this.trails.splice(i, 1); changed = true; continue; }
      }
      if (!t.active) {
        if (t.kind === 'wall' && this.mode === 'ribbon') this.fadeRibbon(t, t.points.at(-1)?.arc ?? 0);
        continue;
      }
      _p.copy(t.emitter).applyQuaternion(rotation).add(position);
      const emitting = t.kind === 'contrail' ? airspeed > CONTRAIL_SPEED && !onGround : this.mode !== 'off';
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
