import * as THREE from 'three/webgpu';
import {
  abs, color, float, floor, fract, hash, instanceIndex, mix, normalWorld, positionWorld, smoothstep, step, uniform,
} from 'three/tsl';
import { neonLineMaterial, type TslNode } from './neon.ts';

/** One solid piece to draw (city tower tier, airport building...). */
export interface StructurePiece {
  shape: 'box' | 'oct' | 'cyl' | 'cone';
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  color: string;
  windows: boolean;
  taper?: number;
  /** Group it hides with when its building fractures (-1: never). */
  group: number;
}

const TAPERS = [0.35, 0.55, 0.62, 1] as const;
const nearestTaper = (t = 1) => TAPERS.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));

/** Unit geometries (1 m bounding box, centred) per shape key. */
function unitGeometry(key: string): THREE.BufferGeometry {
  if (key === 'box') return new THREE.BoxGeometry(1, 1, 1);
  if (key === 'oct') return new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  if (key === 'cyl') return new THREE.CylinderGeometry(0.5, 0.5, 1, 28);
  const taper = Number(key.slice(4));
  return new THREE.CylinderGeometry(0.5 * taper, 0.5, 1, 28);
}
const shapeKey = (p: StructurePiece) => (p.shape === 'cone' ? `cone${nearestTaper(p.taper)}` : p.shape);

/**
 * Steel-blue façade: metallic, darker near the street, with sparse lit windows in the accent
 * colour and thin glowing orange bands every few floors (the 1980s computer-world look).
 */
function facadeMaterial(accent: string, windows: boolean): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({
    metalness: 0.55,
    roughness: 0.38,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const p = positionWorld;
  const steel: TslNode = mix(color('#0c1236'), color('#22357a'), smoothstep(0, 220, p.y));
  m.colorNode = steel;
  if (!windows) {
    m.emissiveNode = color('#0a1440').mul(0.25);
    return m;
  }
  const n = normalWorld;
  const wall: TslNode = step(abs(n.y), float(0.5));
  // Horizontal façade coordinate: x on ±Z faces, z on ±X faces (good enough for round towers too).
  const u: TslNode = p.x.mul(abs(n.z)).add(p.z.mul(abs(n.x)));
  const cu: TslNode = u.div(3.4);
  const cv: TslNode = p.y.div(3.6);
  const gx: TslNode = fract(cu);
  const gy: TslNode = fract(cv);
  const pane: TslNode = step(0.2, gx).mul(step(gx, 0.8)).mul(step(0.3, gy)).mul(step(gy, 0.75));
  const seed: TslNode = floor(cu).add(50000).toUint().mul(73856093)
    .bitXor(floor(cv).add(1000).toUint().mul(19349663))
    .bitXor(instanceIndex.mul(83492791));
  const lit: TslNode = step(0.86, hash(seed));
  const warm: TslNode = step(0.5, hash(seed.add(7)));
  const windowColor: TslNode = mix(uniform(new THREE.Color(accent)), color('#ffb347'), warm);
  // Orange band every ~42 m, 0.7 m tall.
  const band: TslNode = step(fract(p.y.div(42)), float(0.7 / 42)).mul(step(4, p.y));
  m.emissiveNode = windowColor.mul(pane.mul(lit).mul(1.6)).add(color('#ff8a1f').mul(band.mul(2.4))).mul(wall)
    .add(color('#0a1440').mul(0.25));
  return m;
}

/**
 * Draws a set of solid pieces as instanced steel-blue meshes (one InstancedMesh per shape and
 * colour) plus merged neon edge lines per colour (vertical ribs on round shapes). Pieces of a
 * group can be hidden (a building that fractured into blocks) and shown again on reset.
 */
export class StructuresView {
  readonly root = new THREE.Group();
  private readonly instances = new Map<number, Array<{ mesh: THREE.InstancedMesh; index: number; matrix: THREE.Matrix4 }>>();
  private readonly lineRanges = new Map<number, Array<{ attr: THREE.BufferAttribute; start: number; count: number; saved: Float32Array }>>();
  private readonly hidden = new Set<number>();
  private static readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(pieces: readonly StructurePiece[], opts: { lineIntensity?: number; name?: string } = {}) {
    this.root.name = opts.name ?? 'structures';
    // --- Instanced fills
    const buckets = new Map<string, StructurePiece[]>();
    for (const p of pieces) {
      const key = `${shapeKey(p)}|${p.color}|${p.windows ? 1 : 0}`;
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push(p);
    }
    const materials = new Map<string, THREE.Material>();
    const geos = new Map<string, THREE.BufferGeometry>();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (const [key, list] of buckets) {
      const [shape, col, win] = key.split('|');
      let geo = geos.get(shape);
      if (!geo) geos.set(shape, (geo = unitGeometry(shape)));
      const matKey = `${col}|${win}`;
      let mat = materials.get(matKey);
      if (!mat) materials.set(matKey, (mat = facadeMaterial(col, win === '1')));
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((p, i) => {
        m.compose(pos.set(p.x, p.y, p.z), q, scl.set(p.sx, p.sy, p.sz));
        mesh.setMatrixAt(i, m);
        if (p.group >= 0) {
          let g = this.instances.get(p.group);
          if (!g) this.instances.set(p.group, (g = []));
          g.push({ mesh, index: i, matrix: m.clone() });
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.root.add(mesh);
    }

    // --- Merged neon edges, one LineSegments per colour, with per-group vertex ranges
    const edgeUnits = new Map<string, Float32Array>();
    for (const shape of geos.keys()) {
      const e = new THREE.EdgesGeometry(geos.get(shape)!, 10);
      edgeUnits.set(shape, (e.getAttribute('position') as THREE.BufferAttribute).array as Float32Array);
      e.dispose();
    }
    const byColor = new Map<string, StructurePiece[]>();
    for (const p of pieces) {
      let list = byColor.get(p.color);
      if (!list) byColor.set(p.color, (list = []));
      list.push(p);
    }
    const v = new THREE.Vector3();
    for (const [col, list] of byColor) {
      let total = 0;
      for (const p of list) total += edgeUnits.get(shapeKey(p))!.length;
      const arr = new Float32Array(total);
      const attr = new THREE.BufferAttribute(arr, 3);
      let o = 0;
      const ranges: Array<{ group: number; start: number; count: number }> = [];
      for (const p of list) {
        const unit = edgeUnits.get(shapeKey(p))!;
        m.compose(pos.set(p.x, p.y, p.z), q, scl.set(p.sx, p.sy, p.sz));
        for (let i = 0; i < unit.length; i += 3) {
          v.set(unit[i], unit[i + 1], unit[i + 2]).applyMatrix4(m);
          arr[o + i] = v.x;
          arr[o + i + 1] = v.y;
          arr[o + i + 2] = v.z;
        }
        if (p.group >= 0) ranges.push({ group: p.group, start: o, count: unit.length });
        o += unit.length;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', attr);
      geo.computeBoundingSphere();
      const lines = new THREE.LineSegments(geo, neonLineMaterial(col, opts.lineIntensity ?? 2.6));
      this.root.add(lines);
      for (const r of ranges) {
        let g = this.lineRanges.get(r.group);
        if (!g) this.lineRanges.set(r.group, (g = []));
        g.push({ attr, start: r.start, count: r.count, saved: arr.slice(r.start, r.start + r.count) });
      }
    }
    for (const g of geos.values()) void g;
  }

  /** Hide a group (its building fractured into breakable blocks drawn elsewhere). */
  hide(group: number): void {
    if (this.hidden.has(group)) return;
    this.hidden.add(group);
    const touched = new Set<THREE.InstancedMesh>();
    for (const it of this.instances.get(group) ?? []) {
      it.mesh.setMatrixAt(it.index, StructuresView.zero);
      touched.add(it.mesh);
    }
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
    for (const r of this.lineRanges.get(group) ?? []) {
      (r.attr.array as Float32Array).fill(0, r.start, r.start + r.count);
      r.attr.needsUpdate = true;
    }
  }

  /** Show every hidden group again (world reset). */
  showAll(): void {
    if (!this.hidden.size) return;
    const touched = new Set<THREE.InstancedMesh>();
    for (const group of this.hidden) {
      for (const it of this.instances.get(group) ?? []) {
        it.mesh.setMatrixAt(it.index, it.matrix);
        touched.add(it.mesh);
      }
      for (const r of this.lineRanges.get(group) ?? []) {
        (r.attr.array as Float32Array).set(r.saved, r.start);
        r.attr.needsUpdate = true;
      }
    }
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
    this.hidden.clear();
  }
}
