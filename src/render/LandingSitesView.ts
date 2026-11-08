import * as THREE from 'three/webgpu';
import { color, fract, hash, instanceIndex, step, time } from 'three/tsl';
import type { LandingSite } from '../sim/layout.ts';
import { landingSites } from '../world/landingSites.ts';
import type { StaticWorld } from '../world/staticWorld.ts';
import { neonLineMaterial, type TslNode } from './neon.ts';

/**
 * Landing sites beyond Grid International (whose lights AirportView draws): edge and threshold
 * lights on the other airstrips, and helipads (glowing ring, "H", blinking perimeter lights),
 * street-level and on rooftops. A rooftop pad disappears while its tower is fractured.
 */
export class LandingSitesView {
  readonly root = new THREE.Group();
  private readonly roofPads = new Map<number, THREE.Object3D[]>();
  private seen = -1;

  constructor(scene: THREE.Scene, private readonly world: StaticWorld) {
    this.root.name = 'landing-sites';
    const edge: THREE.Vector3[] = [];
    const green: THREE.Vector3[] = [];
    const red: THREE.Vector3[] = [];
    const padLights: Array<{ p: THREE.Vector3; group?: number }> = [];
    for (const s of landingSites()) {
      if (s.kind === 'runway') {
        if (s.id === 'grid') continue;
        const half = s.length / 2;
        const at = (along: number, across: number, y = 0.4) =>
          s.axis === 'z' ? new THREE.Vector3(s.x + across, y, s.z + along) : new THREE.Vector3(s.x + along, y, s.z + across);
        for (let a = -half; a <= half + 0.1; a += 60) for (const side of [-1, 1]) edge.push(at(a, side * (s.width / 2 + 1.5)));
        for (let c = -s.width / 2; c <= s.width / 2 + 0.1; c += 3) {
          green.push(at(-half - 2, c), at(half + 2, c));
          red.push(at(-half - 6, c), at(half + 6, c));
        }
      } else {
        const pad = this.pad(s);
        this.root.add(pad);
        if (s.group !== undefined) this.track(s.group, pad);
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          padLights.push({ p: new THREE.Vector3(s.x + Math.cos(a) * (s.width + 1), s.y + 0.4, s.z + Math.sin(a) * (s.width + 1)), group: s.group });
        }
      }
    }
    this.root.add(this.lights(edge, '#ffffff', 4), this.lights(green, '#3dff6a', 5), this.lights(red, '#ff1a2a', 5));
    // Pad perimeter lights blink, each on its own phase.
    const padMat = new THREE.MeshBasicNodeMaterial();
    const blink: TslNode = step(0.4, fract(time.mul(0.7).add(hash(instanceIndex))));
    padMat.colorNode = color('#ffd23f').mul(blink.mul(6).add(0.8));
    const padMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.5, 0), padMat, Math.max(1, padLights.length));
    padLights.forEach((l, i) => padMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(l.p.x, l.p.y, l.p.z)));
    padMesh.computeBoundingSphere();
    this.root.add(padMesh);
    this.padLights = padLights;
    this.padMesh = padMesh;
    scene.add(this.root);
  }

  private readonly padLights: Array<{ p: THREE.Vector3; group?: number }>;
  private readonly padMesh: THREE.InstancedMesh;

  private track(group: number, o: THREE.Object3D): void {
    const list = this.roofPads.get(group) ?? [];
    list.push(o);
    this.roofPads.set(group, list);
  }

  private lights(points: THREE.Vector3[], hex: string, k: number): THREE.InstancedMesh {
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = color(hex).mul(k);
    const mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.45, 0), mat, Math.max(1, points.length));
    points.forEach((p, i) => mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)));
    mesh.computeBoundingSphere();
    return mesh;
  }

  /** A helipad: double ring and an "H", as neon lines just above the pad surface. */
  private pad(s: LandingSite): THREE.LineSegments {
    const pts: number[] = [];
    const r = s.width;
    for (const rr of [r, r * 0.82]) {
      for (let k = 0; k < 48; k++) {
        const a0 = (k / 48) * Math.PI * 2;
        const a1 = ((k + 1) / 48) * Math.PI * 2;
        pts.push(Math.cos(a0) * rr, 0, Math.sin(a0) * rr, Math.cos(a1) * rr, 0, Math.sin(a1) * rr);
      }
    }
    const h = r * 0.45;
    const w = r * 0.3;
    pts.push(-w, 0, -h, -w, 0, h, w, 0, -h, w, 0, h, -w, 0, 0, w, 0, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(g, neonLineMaterial(s.y > 0 ? '#ff8a1f' : '#3dffb0', 3.5));
    lines.position.set(s.x, s.y + 0.08, s.z);
    return lines;
  }

  /** Hide rooftop pads on fractured towers; show them again after a reset. */
  update(): void {
    if (this.world.version === this.seen) return;
    this.seen = this.world.version;
    for (const [group, objs] of this.roofPads) for (const o of objs) o.visible = !this.world.fractured.has(group);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.padLights.forEach((l, i) => {
      const gone = l.group !== undefined && this.world.fractured.has(l.group);
      this.padMesh.setMatrixAt(i, gone ? zero : new THREE.Matrix4().makeTranslation(l.p.x, l.p.y, l.p.z));
    });
    this.padMesh.instanceMatrix.needsUpdate = true;
  }
}
