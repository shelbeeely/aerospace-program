import * as THREE from 'three/webgpu';
import { districtPlan, type DistrictPlan } from '../../arch/DistrictGenerator.ts';
import { GRID, mod } from '../../arch/grid.ts';
import type { Component, StructureSpec } from '../../arch/types.ts';
import { PLANET } from '../../sim/layout.ts';
import { airportPlan } from '../../world/Airport.ts';
import type { StaticWorld } from '../../world/staticWorld.ts';
import { drawAtLod, emitComponent, GeometryWriter, type Lod } from './ArchitectureMeshBuilder.ts';
import { archLightMaterial, archMaterial } from './ArchitecturalMaterialLibrary.ts';
import { ARCH_LIGHTING } from './BuildingLightingController.ts';

/**
 * Streams the digital architecture around the camera: one merged mesh per district per LOD
 * (plus one additive mesh for its beams), built a few per frame nearest first, placed at the
 * planet image nearest the camera, culled against the frustum with the planet's curvature
 * taken into account. Structures keep a lighting slot while any LOD of their district is
 * loaded; fractured structures are hidden through it (no rebuild).
 */
export interface StreamRanges {
  lod0: number;
  lod1: number;
  lod2: number;
}

export const DESKTOP_RANGES: StreamRanges = { lod0: 1400, lod1: 3400, lod2: 8000 };
export const MOBILE_RANGES: StreamRanges = { lod0: 800, lod1: 2200, lod2: 5200 };

const C = PLANET.circumference;

interface Loaded {
  key: string;
  ci: number;
  cj: number;
  ox: number;
  oz: number;
  lod: Lod;
  group: THREE.Group;
  ids: string[];
  tris: number;
  center: THREE.Vector3;
  radius: number;
  plan: DistrictPlan;
}

export interface WorldStats {
  districts: number;
  byLod: [number, number, number];
  triangles: number;
  structures: number;
  pending: number;
  drawCalls: number;
}

/** Build one district's meshes at a LOD. */
export function buildDistrict(plan: DistrictPlan, lod: Lod, slotFor: (s: StructureSpec) => number, mats?: ArchMats): { group: THREE.Group; tris: number } {
  const opaque = new GeometryWriter(), light = new GeometryWriter();
  plan.structures.forEach((s) => {
    const sid = slotFor(s);
    for (const w of [opaque, light]) {
      w.sid = sid;
      w.hgtBase = 0;
      w.hgtScale = 1 / Math.max(20, s.height);
    }
    const place = { ox: s.x - plan.x, oz: s.z - plan.z, rot: s.rotation };
    for (const c of s.components) {
      if (!drawAtLod(c, lod)) continue;
      emitComponent(c.surface === 'translucent' ? light : opaque, c, place, lod);
    }
  });
  for (const w of [opaque, light]) { w.sid = 0; w.hgtBase = 0; w.hgtScale = 1 / 60; }
  for (const c of plan.infra.components) if (drawAtLod(c, lod)) emitComponent(c.surface === 'translucent' ? light : opaque, c, { ox: 0, oz: 0, rot: 0 }, lod);
  return finish(opaque, light, mats);
}

/** Materials for `finish` (default: the shared ones the main view bends round the planet). */
export interface ArchMats {
  opaque: THREE.Material;
  light: THREE.Material;
}

export function finish(opaque: GeometryWriter, light: GeometryWriter, mats?: ArchMats): { group: THREE.Group; tris: number } {
  const group = new THREE.Group();
  const go = opaque.build(), gl = light.build();
  if (go) {
    const m = new THREE.Mesh(go, mats?.opaque ?? archMaterial());
    m.frustumCulled = false;
    group.add(m);
  }
  if (gl) {
    const m = new THREE.Mesh(gl, mats?.light ?? archLightMaterial());
    m.frustumCulled = false;
    m.renderOrder = 2;
    group.add(m);
  }
  return { group, tris: (opaque.vertexCount + light.vertexCount) / 3 };
}

export class DigitalWorldView {
  readonly root = new THREE.Group();
  private readonly loaded = new Map<string, Loaded>();
  private queue: Array<{ key: string; ci: number; cj: number; ox: number; oz: number; lod: Lod; d: number }> = [];
  private lastCell = '';
  private seenVersion = -1;
  private readonly frustum = new THREE.Frustum();
  private readonly _m = new THREE.Matrix4();
  private readonly _s = new THREE.Sphere();
  private airport: THREE.Group | null = null;
  /** Builds per frame (each up to a few ms). */
  budget = 2;
  enabled = true;

  constructor(scene: THREE.Scene, private readonly world: StaticWorld | null, public ranges: StreamRanges = DESKTOP_RANGES) {
    this.root.name = 'digital-world';
    scene.add(this.root);
    if (world) this.buildAirport();
  }

  /** Airport buildings (terminal, hangars, tower, airliners) in the same language. */
  private buildAirport(): void {
    const w = new GeometryWriter(), l = new GeometryWriter();
    const plan = airportPlan();
    const groups = new Map<string, number>();
    for (const p of plan.pieces) {
      if (!p.solid) continue;
      const id = `airport:${p.group}`;
      let sid = groups.get(id);
      if (sid === undefined) groups.set(id, (sid = ARCH_LIGHTING.acquire(id, 'active', groups.size * 37)));
      w.sid = sid;
      w.hgtBase = 0;
      w.hgtScale = 1 / 60;
      const big = Math.max(p.sx, p.sz) > 40;
      const comp: Component = p.shape === 'box'
        ? { prim: { kind: 'box', w: p.sx, h: p.sy, d: p.sz }, x: p.x, y: p.y - p.sy / 2, z: p.z, tier: 1, surface: big ? 'pale' : 'hull', edges: big ? 'top' : 'silhouette', light: big ? 'warning' : 'structure', glow: 0.8, role: 'airport', pattern: big ? 'flutes' : 'panels' }
        : { prim: { kind: 'prism', sides: 8, r0: p.sx / 2, r1: p.sx / 2, h: p.sy }, x: p.x, y: p.y - p.sy / 2, z: p.z, tier: 1, surface: 'hull', edges: 'top', light: 'structure', glow: 0.8, role: 'airport', pattern: 'panels' };
      emitComponent(w, comp, { ox: 0, oz: 0, rot: 0 }, 0);
    }
    this.airport = finish(w, l).group;
    this.airport.name = 'airport';
    this.root.add(this.airport);
  }

  update(camera: THREE.PerspectiveCamera): void {
    ARCH_LIGHTING.flush();
    if (!this.enabled) { this.root.visible = false; return; }
    this.root.visible = true;
    const cam = camera.position;
    const cs = GRID.chunkSize;
    const ci = Math.floor(mod(cam.x - GRID.x0, C) / cs), cj = Math.floor(mod(cam.z - GRID.z0, C) / cs);
    const cell = `${ci},${cj},${Math.round(cam.x / 200)},${Math.round(cam.z / 200)}`;
    if (cell !== this.lastCell) {
      this.lastCell = cell;
      this.plan(cam, ci, cj);
    }
    let built = 0;
    while (this.queue.length && built < this.budget) {
      const job = this.queue.shift()!;
      const cur = this.loaded.get(job.key);
      if (cur && cur.lod === job.lod) continue;
      this.load(job.key, job.ci, job.cj, job.ox, job.oz, job.lod);
      built++;
    }
    // Fractured structures hide; a reset shows them again.
    if (this.world && this.world.version !== this.seenVersion) {
      this.seenVersion = this.world.version;
      const ids: string[] = [];
      for (const g of this.world.fractured.keys()) {
        const grp = this.world.structures.groups[g];
        if (grp.arch) ids.push(grp.arch);
        else if (grp.name.startsWith('airport:')) ids.push(grp.name);
      }
      ARCH_LIGHTING.setHidden(ids);
    }
    this.cull(camera);
  }

  /** Decide the wanted LOD of every district near the camera and queue changes, nearest first. */
  private plan(cam: THREE.Vector3, ci: number, cj: number): void {
    const cs = GRID.chunkSize;
    const R = Math.ceil(this.ranges.lod2 / cs) + 1;
    const want = new Map<string, { ci: number; cj: number; ox: number; oz: number; lod: Lod; d: number }>();
    for (let di = -R; di <= R; di++) for (let dj = -R; dj <= R; dj++) {
      const a = mod(ci + di, GRID.chunks), b = mod(cj + dj, GRID.chunks);
      const x0 = GRID.x0 + a * cs, z0 = GRID.z0 + b * cs;
      const ox = Math.round((cam.x - (x0 + cs / 2)) / C) * C, oz = Math.round((cam.z - (z0 + cs / 2)) / C) * C;
      const dx = Math.max(x0 + ox - cam.x, 0, cam.x - (x0 + ox + cs)), dz = Math.max(z0 + oz - cam.z, 0, cam.z - (z0 + oz + cs));
      const d = Math.hypot(dx, dz);
      // From altitude the horizon recedes: keep the far LOD a little further.
      const lod: Lod | -1 = d < this.ranges.lod0 ? 0 : d < this.ranges.lod1 ? 1 : d < this.ranges.lod2 + Math.min(4000, cam.y * 0.8) ? 2 : -1;
      if (lod === -1) continue;
      want.set(`${a},${b}@${ox},${oz}`, { ci: a, cj: b, ox, oz, lod, d });
    }
    for (const [k, l] of this.loaded) if (!want.has(k)) this.unload(k, l);
    this.queue = [];
    for (const [key, w] of want) {
      const cur = this.loaded.get(key);
      if (cur && cur.lod === w.lod) continue;
      this.queue.push({ key, ...w });
    }
    this.queue.sort((p, q) => p.d - q.d);
  }

  private load(key: string, ci: number, cj: number, ox: number, oz: number, lod: Lod): void {
    const plan = districtPlan(ci, cj);
    const old = this.loaded.get(key);
    const ids: string[] = [];
    const { group, tris } = buildDistrict(plan, lod, (s) => {
      ids.push(s.id);
      return ARCH_LIGHTING.acquire(s.id, s.activity, s.seed);
    });
    group.position.set(plan.x + ox, 0, plan.z + oz);
    group.name = `district ${key} lod${lod}`;
    this.root.add(group);
    if (old) this.unload(key, old);
    const cs = GRID.chunkSize;
    let top = 60;
    for (const s of plan.structures) top = Math.max(top, s.height);
    this.loaded.set(key, {
      key, ci, cj, ox, oz, lod, group, ids, tris, plan,
      center: new THREE.Vector3(plan.x + ox + cs / 2, top / 2, plan.z + oz + cs / 2),
      radius: Math.hypot(cs / 2, cs / 2, top / 2) + 50,
    });
  }

  private unload(key: string, l: Loaded): void {
    l.group.removeFromParent();
    l.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
    for (const id of l.ids) ARCH_LIGHTING.release(id);
    if (this.loaded.get(key) === l) this.loaded.delete(key);
  }

  /** Frustum culling with the curvature drop applied to each district's bounding sphere. */
  private cull(camera: THREE.PerspectiveCamera): void {
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._m);
    const R = PLANET.radius;
    for (const l of this.loaded.values()) {
      const d = Math.hypot(l.center.x - camera.position.x, l.center.z - camera.position.z);
      const drop = (d * d) / (2 * R);
      this._s.center.set(l.center.x, l.center.y - drop, l.center.z);
      this._s.radius = l.radius + drop * 0.3;
      l.group.visible = this.frustum.intersectsSphere(this._s);
    }
  }

  /** Every loaded structure (debug inspection), with its district. */
  *structures(): Generator<{ s: StructureSpec; plan: DistrictPlan; ox: number; oz: number; lod: Lod }> {
    for (const l of this.loaded.values()) for (const s of l.plan.structures) yield { s, plan: l.plan, ox: l.ox, oz: l.oz, lod: l.lod };
  }

  stats(): WorldStats {
    const byLod: [number, number, number] = [0, 0, 0];
    let tris = 0, structures = 0, draws = 0;
    for (const l of this.loaded.values()) {
      byLod[l.lod]++;
      tris += l.tris;
      structures += l.plan.structures.length;
      if (l.group.visible) draws += l.group.children.length;
    }
    return { districts: this.loaded.size, byLod, triangles: Math.round(tris), structures, pending: this.queue.length, drawCalls: draws };
  }

  /** Drop everything (new world seed). */
  clear(): void {
    for (const [k, l] of [...this.loaded]) this.unload(k, l);
    this.queue = [];
    this.lastCell = '';
  }
}
