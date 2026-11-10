import * as THREE from 'three/webgpu';
import { ACTIVITY_STATES, type ActivityState } from '../../arch/palette.ts';

/**
 * Architectural illumination state, per structure: every drawn structure owns a slot in a
 * 1024 × 64 RGBA8 texture that the architecture shader reads (R = state, G = pulse phase,
 * B = intensity), so lighting is part of the building and changes without rebuilding geometry:
 * - active: lit at full strength with a slow pulse travelling up the structure;
 * - idle: steady and dim;
 * - damaged: flickering, shifted toward red;
 * - inactive: almost dark;
 * - hidden: not drawn at all (fractured structures: the falling blocks take over).
 * Slot 0 is shared by infrastructure and terrain (always active).
 */
export type LightState = ActivityState | 'hidden';
const CODE: Record<LightState, number> = { active: 0, idle: 1, damaged: 2, inactive: 3, hidden: 4 };
const W = 1024, H = 64;

export class BuildingLightingController {
  readonly texture: THREE.DataTexture;
  private readonly data = new Uint8Array(W * H * 4);
  private readonly free: number[] = [];
  private next = 1;
  private readonly slots = new Map<string, { slot: number; state: ActivityState; refs: number }>();
  private readonly hiddenIds = new Set<string>();
  private dirty = true;
  /** Debug: force every structure into one state (null = each its own). */
  private override: ActivityState | null = null;

  constructor() {
    this.texture = new THREE.DataTexture(this.data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.write(0, 'active', 0);
    this.texture.needsUpdate = true;
  }

  /** Slot for a structure id (reference-counted: several LOD meshes may share it). */
  acquire(id: string, state: ActivityState, seed: number): number {
    const s = this.slots.get(id);
    if (s) { s.refs++; return s.slot; }
    const slot = this.free.pop() ?? this.next++;
    if (slot >= W * H) return 0;
    this.slots.set(id, { slot, state, refs: 1 });
    this.write(slot, this.hiddenIds.has(id) ? 'hidden' : this.override ?? state, seed);
    return slot;
  }

  release(id: string): void {
    const s = this.slots.get(id);
    if (!s || --s.refs > 0) return;
    this.slots.delete(id);
    this.free.push(s.slot);
  }

  /** Change a structure's activity state. */
  setState(id: string, state: ActivityState): void {
    const s = this.slots.get(id);
    if (!s) return;
    s.state = state;
    if (!this.hiddenIds.has(id)) this.write(s.slot, this.override ?? state);
  }

  stateOf(id: string): LightState | null {
    if (this.hiddenIds.has(id)) return 'hidden';
    return this.slots.get(id)?.state ?? null;
  }

  /** Hide exactly these ids (fractured structures); everything else shows. */
  setHidden(ids: Iterable<string>): void {
    const next = new Set(ids);
    for (const id of this.hiddenIds) if (!next.has(id)) {
      const s = this.slots.get(id);
      if (s) this.write(s.slot, this.override ?? s.state);
    }
    for (const id of next) {
      const s = this.slots.get(id);
      if (s) this.write(s.slot, 'hidden');
    }
    this.hiddenIds.clear();
    for (const id of next) this.hiddenIds.add(id);
  }

  setOverride(state: ActivityState | null): void {
    this.override = state;
    for (const [id, s] of this.slots) if (!this.hiddenIds.has(id)) this.write(s.slot, state ?? s.state);
  }

  get count(): number {
    return this.slots.size;
  }

  private write(slot: number, state: LightState, seed?: number): void {
    const o = slot * 4;
    this.data[o] = CODE[state];
    if (seed !== undefined) this.data[o + 1] = seed & 255;
    this.data[o + 2] = 255;
    this.data[o + 3] = 255;
    this.dirty = true;
  }

  /** Upload changes (once a frame). */
  flush(): void {
    if (!this.dirty) return;
    this.texture.needsUpdate = true;
    this.dirty = false;
  }
}

export const ARCH_LIGHTING = new BuildingLightingController();
export { ACTIVITY_STATES };
