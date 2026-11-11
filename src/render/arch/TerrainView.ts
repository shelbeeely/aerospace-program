import * as THREE from 'three/webgpu';
import { chunkHasTerrain, landformsInRect, type Landform } from '../../arch/DigitalTerrainGenerator.ts';
import { GRID, mod } from '../../arch/grid.ts';
import type { LightRole, Pattern, Surface } from '../../arch/palette.ts';
import type { Component, EdgeMode } from '../../arch/types.ts';
import type { TerrainArchetype } from '../../arch/WorldRegionManager.ts';
import { PLANET } from '../../sim/layout.ts';
import { emitComponent, GeometryWriter, type Lod } from './ArchitectureMeshBuilder.ts';
import { finish, type StreamRanges } from './DigitalWorldView.ts';

/**
 * The Outlands' landforms near the camera as real geometry, streamed per chunk at three LODs
 * (the same convex solids the physics collides with; rubble only up close). Each terrain
 * archetype has its own material treatment in the 1982 palette: fluted dark canyon walls with
 * orange rims, pale gridded swells in the Sea of Simulation, grey-blue formations with amber
 * edges in the wastelands, navy cavern slabs with cyan seams, cyan-rimmed plain platforms.
 */
const C = PLANET.circumference;

interface Look { surface: Surface; pattern: Pattern; edges: EdgeMode; light: LightRole; glow: number }
const LOOK: Record<TerrainArchetype, [Look, Look, Look]> = {
  canyons: [
    { surface: 'hullDark', pattern: 'flutes', edges: 'top', light: 'process', glow: 1 },
    { surface: 'hull', pattern: 'panels', edges: 'all', light: 'warning', glow: 0.6 },
    { surface: 'metal', pattern: 'none', edges: 'none', light: 'process', glow: 0 },
  ],
  'grid-plains': [
    { surface: 'hull', pattern: 'panels', edges: 'top', light: 'structure', glow: 0.9 },
    { surface: 'hullDark', pattern: 'panels', edges: 'top', light: 'structure', glow: 0.9 },
    { surface: 'metal', pattern: 'none', edges: 'top', light: 'energy', glow: 1.4 },
  ],
  sea: [
    { surface: 'pale', pattern: 'grid', edges: 'base', light: 'structure', glow: 0.5 },
    { surface: 'pale', pattern: 'grid', edges: 'none', light: 'structure', glow: 0 },
    { surface: 'pale', pattern: 'none', edges: 'none', light: 'structure', glow: 0 },
  ],
  wasteland: [
    { surface: 'metal', pattern: 'panels', edges: 'all', light: 'entrance', glow: 0.7 },
    { surface: 'metal', pattern: 'none', edges: 'all', light: 'warning', glow: 0.5 },
    { surface: 'metal', pattern: 'none', edges: 'none', light: 'entrance', glow: 0 },
  ],
  'mech-caverns': [
    { surface: 'hullDark', pattern: 'panels', edges: 'base', light: 'structure', glow: 0.9 },
    { surface: 'hull', pattern: 'panels', edges: 'silhouette', light: 'data', glow: 0.5 },
    { surface: 'metal', pattern: 'panels', edges: 'top', light: 'process', glow: 0.8 },
  ],
};

/** A landform as components (in chunk-local metres). Slabs are emitted directly by corners. */
export function landformComponents(f: Landform, ox: number, oz: number): Component[] {
  const look = LOOK[f.arch][f.tier - 1];
  const base = { x: f.cx - ox, y: f.y0, z: f.cz - oz, tier: f.tier, surface: look.surface, edges: look.edges, light: look.light, glow: look.glow, role: f.shape, pattern: look.pattern } as const;
  // Sphere orbs in the sky: plain pale with a faint structural rim (book p. 54).
  if (f.overhead && f.shape === 'sphere') return [{ ...base, prim: { kind: 'sphere', r: f.r0 }, edges: 'none' }];
  // Roof slabs light their underside rim (the cavern's ceiling line).
  switch (f.shape) {
    case 'frustum': return [{ ...base, prim: { kind: 'frustum', w: f.w, d: f.d, wt: f.wt, dt: f.dt, h: f.h }, ry: f.ry, edges: f.overhead ? 'base' : look.edges }];
    case 'pyramid': return [{ ...base, prim: { kind: 'prism', sides: 4, r0: f.half * Math.SQRT2, r1: 0, h: f.h, phase: Math.PI / 4 }, ry: f.ry }];
    case 'octa': return [
      { ...base, prim: { kind: 'prism', sides: 4, r0: 0.01, r1: f.half * Math.SQRT2, h: f.h, phase: Math.PI / 4 }, ry: f.ry, edges: 'none' },
      { ...base, y: f.y0 + f.h, prim: { kind: 'prism', sides: 4, r0: f.half * Math.SQRT2, r1: 0, h: f.h, phase: Math.PI / 4 }, ry: f.ry },
    ];
    case 'dome': return [{ ...base, prim: { kind: 'dome', rx: f.w / 2, rz: f.d / 2, h: f.h }, ry: f.ry }];
    case 'prism': return [{ ...base, prim: { kind: 'prism', sides: f.sides, r0: f.r0, r1: f.r1, h: f.h, phase: 0 }, ry: f.ry, edges: f.tier === 3 ? 'top' : look.edges }];
    case 'sphere': return [{ ...base, prim: { kind: 'sphere', r: f.r0 } }];
    case 'slab': return [];
  }
}

/**
 * Tilted slab: the physics hull tilts a box about its centre; emitComponent tilts about the
 * box's base centre, so shift the component by the difference (in the slab's ry frame).
 */
export function emitSlab(w: GeometryWriter, f: Landform, ox: number, oz: number): void {
  const look = LOOK[f.arch][f.tier - 1];
  const off = (f.h / 2) * Math.sin(f.rx);
  const c: Component = {
    prim: { kind: 'box', w: f.w, h: f.h, d: f.d }, rx: f.rx, ry: f.ry,
    x: f.cx - ox - off * Math.sin(f.ry), y: f.y0 + f.h / 2 - (f.h / 2) * Math.cos(f.rx), z: f.cz - oz - off * Math.cos(f.ry),
    tier: f.tier, surface: look.surface, edges: look.edges, light: look.light, glow: look.glow, role: 'slab', pattern: look.pattern,
  };
  emitComponent(w, c, { ox: 0, oz: 0, rot: 0 }, 0);
}

interface Loaded { group: THREE.Group; lod: Lod; tris: number; center: THREE.Vector3; radius: number }

export class TerrainView {
  readonly root = new THREE.Group();
  private readonly loaded = new Map<string, Loaded>();
  private queue: Array<{ key: string; ci: number; cj: number; ox: number; oz: number; lod: Lod; d: number }> = [];
  private lastCell = '';
  private readonly frustum = new THREE.Frustum();
  private readonly _m = new THREE.Matrix4();
  private readonly _s = new THREE.Sphere();
  budget = 2;
  enabled = true;

  constructor(scene: THREE.Scene, public ranges: StreamRanges) {
    this.root.name = 'outlands-terrain';
    scene.add(this.root);
  }

  update(camera: THREE.PerspectiveCamera): void {
    if (!this.enabled) { this.root.visible = false; return; }
    this.root.visible = true;
    const cam = camera.position;
    const cs = GRID.chunkSize;
    const ci = Math.floor(mod(cam.x - GRID.x0, C) / cs), cj = Math.floor(mod(cam.z - GRID.z0, C) / cs);
    const cell = `${ci},${cj},${Math.round(cam.x / 250)},${Math.round(cam.z / 250)}`;
    if (cell !== this.lastCell) {
      this.lastCell = cell;
      const R = Math.ceil(this.ranges.lod2 / cs) + 1;
      const want = new Map<string, { ci: number; cj: number; ox: number; oz: number; lod: Lod; d: number }>();
      for (let di = -R; di <= R; di++) for (let dj = -R; dj <= R; dj++) {
        const a = mod(ci + di, GRID.chunks), b = mod(cj + dj, GRID.chunks);
        if (!chunkHasTerrain(a, b)) continue;
        const x0 = GRID.x0 + a * cs, z0 = GRID.z0 + b * cs;
        const ox = Math.round((cam.x - (x0 + cs / 2)) / C) * C, oz = Math.round((cam.z - (z0 + cs / 2)) / C) * C;
        const d = Math.hypot(Math.max(x0 + ox - cam.x, 0, cam.x - (x0 + ox + cs)), Math.max(z0 + oz - cam.z, 0, cam.z - (z0 + oz + cs)));
        const lod: Lod | -1 = d < this.ranges.lod0 ? 0 : d < this.ranges.lod1 ? 1 : d < this.ranges.lod2 + Math.min(4000, cam.y * 0.8) ? 2 : -1;
        if (lod === -1) continue;
        want.set(`${a},${b}@${ox},${oz}`, { ci: a, cj: b, ox, oz, lod, d });
      }
      for (const [k, l] of this.loaded) if (!want.has(k)) this.unload(k, l);
      this.queue = [];
      for (const [key, w] of want) if (this.loaded.get(key)?.lod !== w.lod) this.queue.push({ key, ...w });
      this.queue.sort((p, q) => p.d - q.d);
    }
    let built = 0;
    while (this.queue.length && built < this.budget) {
      const j = this.queue.shift()!;
      if (this.loaded.get(j.key)?.lod === j.lod) continue;
      this.load(j.key, j.ci, j.cj, j.ox, j.oz, j.lod);
      built++;
    }
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._m);
    for (const l of this.loaded.values()) {
      const d = Math.hypot(l.center.x - cam.x, l.center.z - cam.z);
      const drop = (d * d) / (2 * PLANET.radius);
      this._s.center.set(l.center.x, l.center.y - drop, l.center.z);
      this._s.radius = l.radius + drop * 0.3;
      l.group.visible = this.frustum.intersectsSphere(this._s);
    }
  }

  private load(key: string, ci: number, cj: number, ox: number, oz: number, lod: Lod): void {
    const cs = GRID.chunkSize;
    const x0 = GRID.x0 + ci * cs, z0 = GRID.z0 + cj * cs;
    const forms = landformsInRect(x0, z0, x0 + cs, z0 + cs, lod === 0);
    const w = new GeometryWriter(), l = new GeometryWriter();
    w.sid = 0; w.hgtBase = 0; w.hgtScale = 1 / 280;
    let top = 50;
    for (const f of forms) {
      if (lod === 2 && f.tier === 3) continue;
      top = Math.max(top, f.y0 + f.h);
      if (f.shape === 'slab') { emitSlab(w, f, x0, z0); continue; }
      for (const c of landformComponents(f, x0, z0)) emitComponent(w, c, { ox: 0, oz: 0, rot: 0 }, lod);
    }
    const old = this.loaded.get(key);
    const { group, tris } = finish(w, l);
    group.position.set(x0 + ox, 0, z0 + oz);
    group.name = `terrain ${key} lod${lod}`;
    this.root.add(group);
    if (old) this.unload(key, old);
    this.loaded.set(key, { group, lod, tris, center: new THREE.Vector3(x0 + ox + cs / 2, top / 2, z0 + oz + cs / 2), radius: Math.hypot(cs / 2, cs / 2, top / 2) + 50 });
  }

  private unload(key: string, l: Loaded): void {
    l.group.removeFromParent();
    l.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
    if (this.loaded.get(key) === l) this.loaded.delete(key);
  }

  stats(): { chunks: number; triangles: number; pending: number } {
    let tris = 0;
    for (const l of this.loaded.values()) tris += l.tris;
    return { chunks: this.loaded.size, triangles: Math.round(tris), pending: this.queue.length };
  }

  clear(): void {
    for (const [k, l] of [...this.loaded]) this.unload(k, l);
    this.queue = [];
    this.lastCell = '';
  }
}
