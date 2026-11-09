import * as THREE from 'three/webgpu';
import { CONTRAIL_LIFE, DEREZ_TIME, RIBBON_LENGTH, type TrailSystem } from '../sim/trails.ts';

const MAX_SEGMENTS = 24000;

/**
 * Draws the TrailSystem: jetwalls as translucent panels of light with a blazing top edge,
 * light ribbons dimming toward their tail, contrails as thin threads that fade with age, and
 * derezzing trails flickering out. One additive mesh and one line set, rebuilt each frame.
 */
export class TrailView {
  private readonly geo = new THREE.BufferGeometry();
  private readonly lineGeo = new THREE.BufferGeometry();
  private readonly pos = new Float32Array(MAX_SEGMENTS * 6 * 3);
  private readonly col = new Float32Array(MAX_SEGMENTS * 6 * 3);
  private readonly lpos = new Float32Array(MAX_SEGMENTS * 2 * 3);
  private readonly lcol = new Float32Array(MAX_SEGMENTS * 2 * 3);
  private readonly _c = new THREE.Color();

  constructor(scene: THREE.Scene, private readonly trails: TrailSystem) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.lpos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeo.setAttribute('color', new THREE.BufferAttribute(this.lcol, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.MeshBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const lineMat = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(this.geo, mat);
    const lines = new THREE.LineSegments(this.lineGeo, lineMat);
    for (const o of [mesh, lines]) { o.frustumCulled = false; o.renderOrder = 2; scene.add(o); }
    this.geo.setDrawRange(0, 0);
    this.lineGeo.setDrawRange(0, 0);
  }

  update(time: number): void {
    let v = 0; // vertices written (mesh)
    let l = 0; // line vertices
    const P = this.pos, Cc = this.col, LP = this.lpos, LC = this.lcol;
    for (const t of this.trails.trails) {
      const pts = t.points;
      if (pts.length < 2) continue;
      const base = this._c.set(t.color);
      let fadeAll = 1;
      if (t.derezAt !== null) {
        const age = (time - t.derezAt) / DEREZ_TIME;
        // Derez: flicker and fall away.
        fadeAll = Math.max(0, 1 - age) * (Math.sin(time * 70) > -0.2 ? 1 : 0.15);
      }
      const headArc = pts[pts.length - 1].arc;
      for (let i = 1; i < pts.length && v < MAX_SEGMENTS * 6; i++) {
        const a = pts[i - 1], b = pts[i];
        let k = fadeAll;
        if (t.kind === 'contrail') {
          // Airborne ribbon: brightest at the vehicle, dissolving toward its tail.
          const span = Math.max(1, headArc - pts[0].arc);
          k *= Math.max(0, (b.arc - pts[0].arc) / span) * Math.max(0, 1 - Math.max(0, time - pts[pts.length - 1].time - 1) / CONTRAIL_LIFE);
        } else if (this.trails.mode === 'ribbon' && t.derezAt === null) k *= Math.max(0, 1 - (headArc - b.arc) / RIBBON_LENGTH);
        if (k <= 0.01) continue;
        const wall = t.kind === 'wall';
        const lo = wall ? 0.35 * k : 0.12 * k; // translucent panel, brighter near the top
        const hi = wall ? 1.2 * k : 0.32 * k;
        // Two triangles: a0 b0 a1 / a1 b0 b1 (0 = bottom, 1 = top).
        const quad: Array<[number, number, number, number]> = [
          [a.x, a.y0, a.z, lo], [b.x, b.y0, b.z, lo], [a.x, a.y1, a.z, hi],
          [a.x, a.y1, a.z, hi], [b.x, b.y0, b.z, lo], [b.x, b.y1, b.z, hi],
        ];
        for (const [x, y, z, s] of quad) {
          P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z;
          Cc[v * 3] = base.r * s; Cc[v * 3 + 1] = base.g * s; Cc[v * 3 + 2] = base.b * s;
          v++;
        }
        if (wall && l < MAX_SEGMENTS * 2) {
          // The blazing top edge of a jetwall.
          const s = 3.2 * k;
          for (const p of [a, b]) {
            LP[l * 3] = p.x; LP[l * 3 + 1] = p.y1; LP[l * 3 + 2] = p.z;
            LC[l * 3] = Math.min(4, base.r * s + 0.6 * k); LC[l * 3 + 1] = Math.min(4, base.g * s + 0.6 * k); LC[l * 3 + 2] = Math.min(4, base.b * s + 0.6 * k);
            l++;
          }
        }
      }
    }
    const pa = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const ca = this.geo.getAttribute('color') as THREE.BufferAttribute;
    const la = this.lineGeo.getAttribute('position') as THREE.BufferAttribute;
    const lca = this.lineGeo.getAttribute('color') as THREE.BufferAttribute;
    pa.needsUpdate = ca.needsUpdate = la.needsUpdate = lca.needsUpdate = true;
    this.geo.setDrawRange(0, v);
    this.lineGeo.setDrawRange(0, l);
  }
}
