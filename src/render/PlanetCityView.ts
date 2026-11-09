import * as THREE from 'three/webgpu';
import { CITY } from '../sim/layout.ts';
import { chunkAt, GRID, imageOffset, planetChunk } from '../world/planetCity.ts';
import type { StaticWorld } from '../world/staticWorld.ts';
import type { StructureGroup } from '../world/structures.ts';
import type { KitTowersView } from './KitTowersView.ts';
import { facadeMaterial, StructuresView, type StructurePiece } from './StructuresView.ts';

/** Full detail (façades, neon edges, kit models) within this distance of the camera (m). */
const NEAR = 1900;
/** One lit box per building out to this distance; city lights on the ground beyond (m). */
const FAR = 7000;
const MAX_BOXES = 40000;

/**
 * The planet city beyond the hand-built centre, in three distance LODs:
 * - LOD 0 (≤ NEAR): every registered chunk (see StaticWorld.registerChunks) as a full
 *   StructuresView sharing the physics' group ids, so fractured towers hide; kit towers as
 *   their real models (KitTowersView.setOuter);
 * - LOD 1 (≤ FAR): one façade box per building, all chunks in one InstancedMesh;
 * - LOD 2 (beyond): city lights in the ground shader (cityGround.ts).
 */
export class PlanetCityView {
  readonly root = new THREE.Group();
  private readonly near = new Map<string, StructuresView>();
  private readonly boxes: THREE.InstancedMesh;
  private boxesKey = '';
  private nearKey = '';
  private seenVersion = -1;
  private seenContent = -1;
  private readonly pending: Array<[number, number]> = [];
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _c = new THREE.Color();

  constructor(scene: THREE.Scene, private readonly world: StaticWorld, private readonly kit: KitTowersView) {
    this.root.name = 'planet-city';
    this.boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), facadeMaterial('#00eaff', true), MAX_BOXES);
    this.boxes.count = 0;
    this.boxes.frustumCulled = false;
    this.root.add(this.boxes);
    scene.add(this.root);
  }

  update(camera: THREE.Vector3): void {
    this.updateNear(camera);
    this.updateBoxes(camera);
    // Fractures and resets.
    if (this.world.version !== this.seenVersion) {
      this.seenVersion = this.world.version;
      for (const v of this.near.values()) {
        if (!this.world.fractured.size) v.showAll();
        else for (const g of this.world.fractured.keys()) v.hide(g);
      }
    }
  }

  private chunkDistance(x0: number, z0: number, cam: THREE.Vector3): number {
    const S = GRID.chunkSize;
    const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + S));
    const dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + S));
    return Math.hypot(dx, dz);
  }

  /** LOD 0: views for registered chunks near the camera (built one per frame). */
  private updateNear(cam: THREE.Vector3): void {
    const want = new Map<string, { pieceStart: number; pieceEnd: number; groupStart: number; groupEnd: number }>();
    for (const [k, c] of this.world.outerChunks) {
      const x0 = GRID.x0 + c.ci * GRID.chunkSize + c.ox;
      const z0 = GRID.z0 + c.cj * GRID.chunkSize + c.oz;
      if (this.chunkDistance(x0, z0, cam) <= NEAR) want.set(k, c);
    }
    let changed = false;
    for (const [k, v] of this.near) {
      if (want.has(k)) continue;
      v.dispose();
      this.near.delete(k);
      changed = true;
    }
    for (const [k, c] of want) {
      if (this.near.has(k)) continue;
      const L = this.world.structures.list;
      const pieces: StructurePiece[] = [];
      for (let i = c.pieceStart; i < c.pieceEnd; i++) pieces.push(L[i]);
      const view = new StructuresView(pieces, { name: `chunk ${k}` });
      for (const g of this.world.fractured.keys()) view.hide(g);
      this.root.add(view.root);
      this.near.set(k, view);
      changed = true;
      break; // one per frame
    }
    const key = [...this.near.keys()].sort().join('|');
    if (changed || key !== this.nearKey || this.world.contentVersion !== this.seenContent) {
      this.nearKey = key;
      this.seenContent = this.world.contentVersion;
      // Kit towers of the near chunks as their real models.
      const kits: StructureGroup[] = [];
      for (const k of this.near.keys()) {
        const c = this.world.outerChunks.get(k)!;
        for (let g = c.groupStart; g < c.groupEnd; g++) if (this.world.structures.groups[g].kit) kits.push(this.world.structures.groups[g]);
      }
      this.kit.setOuter(kits);
      this.boxesKey = ''; // the box LOD skips chunks drawn in full
    }
  }

  /** LOD 1: one box per building in every chunk out to FAR (generating a few chunks per frame). */
  private updateBoxes(cam: THREE.Vector3): void {
    const [ci, cj] = chunkAt(cam.x, cam.z);
    const key = `${ci},${cj}|${this.nearKey}`;
    if (key === this.boxesKey && !this.pending.length) return;
    if (key !== this.boxesKey) {
      this.boxesKey = key;
      this.pending.length = 0;
      const r = Math.ceil(FAR / GRID.chunkSize) + 1;
      for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) this.pending.push([ci + di, cj + dj]);
    }
    // Generate up to 6 missing chunks this frame; rebuild once they are all ready.
    let generated = 0;
    while (this.pending.length && generated < 6) {
      const [a, b] = this.pending.pop()!;
      planetChunk(a, b);
      generated++;
    }
    if (this.pending.length) return;
    const nearChunks = new Set([...this.near.keys()].map((k) => k.split('@')[0]));
    const r = Math.ceil(FAR / GRID.chunkSize) + 1;
    let n = 0;
    for (let di = -r; di <= r && n < MAX_BOXES; di++) for (let dj = -r; dj <= r && n < MAX_BOXES; dj++) {
      const c = planetChunk(ci + di, cj + dj);
      const ox = imageOffset(c.x + GRID.chunkSize / 2, cam.x);
      const oz = imageOffset(c.z + GRID.chunkSize / 2, cam.z);
      if (this.chunkDistance(c.x + ox, c.z + oz, cam) > FAR) continue;
      if (nearChunks.has(c.key)) continue;
      for (const g of c.structures.groups) {
        if (n >= MAX_BOXES) break;
        const w = g.size[0] * g.blockSize, h = g.size[1] * g.blockSize, d = g.size[2] * g.blockSize;
        this._p.set(g.x0 + ox + w / 2, h / 2, g.z0 + oz + d / 2);
        // Kit towers and stepped towers taper: draw the box a little slimmer than the grid.
        this._s.set(w * 0.8, h, d * 0.8);
        this._m.compose(this._p, this._q, this._s);
        this.boxes.setMatrixAt(n, this._m);
        this.boxes.setColorAt(n, this._c.set(g.kit ? '#9fe9ff' : g.color).lerp(new THREE.Color('#ffffff'), 0.35));
        n++;
      }
    }
    this.boxes.count = n;
    this.boxes.instanceMatrix.needsUpdate = true;
    if (this.boxes.instanceColor) this.boxes.instanceColor.needsUpdate = true;
    void CITY;
  }
}
