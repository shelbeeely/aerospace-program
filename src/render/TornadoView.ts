import * as THREE from 'three/webgpu';
import {
  abs, atan, cos, float, max, mix, normalView, positionLocal, positionViewDirection, pow, sin, smoothstep, uniform, vec3,
} from 'three/tsl';
import type { Tornado } from '../sim/events/tornado.ts';
import type { TslNode } from './neon.ts';

const DEBRIS = 1400;

/** Seeded 0..1 (visual only, but stable per tornado). */
function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A tornado as a solid mass: a dark, opaque funnel of desaturated metallic blue that narrows to
 * the ground, sways along its height and carries spiral striations rotating with the vortex
 * (its silhouette catches a faint pale-cyan edge light), under a lowering wall cloud. Around its
 * base a debris cloud: a ground skirt of churned dust and ~1400 voxel fragments (dark blocks
 * with lit edges, some carrying circuit light) orbiting at the Rankine-vortex speed, rising in a
 * spiral and falling back out. Visual only; the wind is the simulation's (sim/events/tornado.ts).
 */
export class TornadoView {
  readonly group = new THREE.Group();
  private readonly time = uniform(0);
  private readonly fade = uniform(0);
  private readonly debris: THREE.InstancedMesh;
  private readonly cap: THREE.Mesh;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly p = { r: new Float32Array(DEBRIS), a: new Float32Array(DEBRIS), h: new Float32Array(DEBRIS), rate: new Float32Array(DEBRIS), size: new Float32Array(DEBRIS), spin: new Float32Array(DEBRIS) };
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();
  private readonly _v = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(private readonly tornado: Tornado, seed: number, strength: number) {
    const H = tornado.height;
    const core = tornado.coreRadius * (0.8 + 0.25 * strength);
    this.group.name = 'tornado';

    // ---- funnel: a lathe narrowing to the ground, flaring into the cloud base.
    const profile: THREE.Vector2[] = [];
    for (let i = 0; i <= 64; i++) {
      const f = i / 64;
      const r = core * (0.34 + 0.1 * Math.sin(f * 9) * (1 - f) + 1.75 * Math.pow(f, 2.2));
      profile.push(new THREE.Vector2(r, f * H));
    }
    const funnelGeo = new THREE.LatheGeometry(profile, 56);
    this.geos.push(funnelGeo);
    const funnel = new THREE.Mesh(funnelGeo, this.funnelMaterial(H, false));
    const sheath = new THREE.Mesh(funnelGeo, this.funnelMaterial(H, true));
    sheath.scale.set(1.22, 1, 1.22);
    funnel.renderOrder = 2;
    sheath.renderOrder = 3;

    // ---- wall cloud: a dark lowering slab the funnel hangs from.
    const capGeo = new THREE.CylinderGeometry(core * 5.5, core * 2.6, 110, 56, 2, false).translate(0, H + 30, 0);
    this.geos.push(capGeo);
    const capMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const capY: TslNode = positionLocal.y.sub(H - 25).div(110);
    capMat.colorNode = mix(vec3(0.03, 0.06, 0.11), vec3(0.09, 0.14, 0.22), capY) as TslNode;
    capMat.opacityNode = float(0.92).mul(this.fade) as TslNode;
    this.mats.push(capMat);
    this.cap = new THREE.Mesh(capGeo, capMat);

    // ---- dust skirt: churned ground debris, dense at the bottom, thinning upward.
    const skirtGeo = new THREE.CylinderGeometry(core * 1.7, core * 1.0, 110, 56, 6, true).translate(0, 55, 0);
    this.geos.push(skirtGeo);
    const skirtMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const sa: TslNode = atan(positionLocal.z, positionLocal.x);
    const sy: TslNode = positionLocal.y.div(110);
    const churn: TslNode = sin(sa.mul(9).add(positionLocal.y.mul(0.12)).sub(this.time.mul(2.6))).mul(0.5).add(0.5);
    skirtMat.colorNode = mix(vec3(0.05, 0.08, 0.13), vec3(0.16, 0.24, 0.32), churn) as TslNode;
    skirtMat.opacityNode = float(1).sub(smoothstep(0.05, 1, sy)).mul(float(0.35).add(churn.mul(0.35))).mul(this.fade) as TslNode;
    this.mats.push(skirtMat);
    const skirt = new THREE.Mesh(skirtGeo, skirtMat);
    skirt.renderOrder = 4;

    // ---- debris: voxel fragments with lit edges (most dark, some in circuit cyan, a few amber).
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.geos.push(box);
    const dMat = new THREE.MeshBasicNodeMaterial();
    const q: TslNode = abs(positionLocal).mul(2);
    const ea: TslNode = smoothstep(0.8, 0.98, q.x), eb: TslNode = smoothstep(0.8, 0.98, q.y), ec: TslNode = smoothstep(0.8, 0.98, q.z);
    const edge: TslNode = max(max(ea.mul(eb), eb.mul(ec)), ea.mul(ec));
    dMat.colorNode = float(0.12).add(edge.mul(1.8)) as TslNode; // × instance colour
    this.mats.push(dMat);
    this.debris = new THREE.InstancedMesh(box, dMat, DEBRIS);
    const c = new THREE.Color();
    for (let i = 0; i < DEBRIS; i++) {
      const u = hash(seed * 7919 + i);
      const v = hash(seed * 104729 + i * 3 + 1);
      const w = hash(seed * 15485863 + i * 7 + 2);
      // Most debris hugs the base; a tail is flung wide and high.
      this.p.r[i] = core * (0.25 + 1.6 * Math.pow(u, 1.6));
      this.p.a[i] = v * Math.PI * 2;
      this.p.h[i] = w;
      this.p.rate[i] = 0.04 + 0.1 * hash(i * 31 + seed);
      const big = hash(i * 17 + seed * 3) > 0.96;
      this.p.size[i] = big ? 4 + 5 * hash(i * 5 + seed) : 0.6 + 2.2 * hash(i * 11 + seed);
      this.p.spin[i] = (hash(i * 13 + seed) - 0.5) * 8;
      const k = hash(i * 23 + seed * 5);
      c.set(k > 0.97 ? '#ffb000' : k > 0.8 ? '#00d4ff' : '#4a6a8a');
      this.debris.setColorAt(i, c);
      this.debris.setMatrixAt(i, this.zero);
    }
    this.debris.frustumCulled = false;

    this.group.add(funnel, sheath, this.cap, skirt, this.debris);
    this.group.traverse((o) => { o.frustumCulled = false; });
  }

  private funnelMaterial(H: number, outer: boolean): THREE.MeshBasicNodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: !outer, side: outer ? THREE.DoubleSide : THREE.FrontSide });
    const p: TslNode = positionLocal;
    const h: TslNode = p.y.div(H);
    const t: TslNode = this.time;
    // Sway: the column snakes, more with height (the ground contact is pinned).
    const lean: TslNode = pow(h, 1.3);
    const swayX: TslNode = sin(p.y.mul(0.0045).add(t.mul(0.35))).mul(48).mul(lean);
    const swayZ: TslNode = cos(p.y.mul(0.0038).add(t.mul(0.29))).mul(36).mul(lean);
    const ang: TslNode = atan(p.z, p.x);
    // Lumps rotating round the column (rotation speed: outer layer faster).
    const spin = outer ? 4.2 : 2.6;
    const bulge: TslNode = float(1).add(sin(ang.mul(3).add(p.y.mul(0.025)).sub(t.mul(spin))).mul(0.07)).add(sin(ang.mul(7).sub(p.y.mul(0.06)).sub(t.mul(spin * 1.7))).mul(0.03));
    m.positionNode = vec3(p.x.mul(bulge).add(swayX), p.y, p.z.mul(bulge).add(swayZ)) as TslNode;
    // Spiral striations climbing the funnel, turning with the vortex.
    const band: TslNode = sin(ang.mul(outer ? 5 : 8).add(p.y.mul(outer ? 0.025 : 0.045)).sub(t.mul(spin * 1.3))).mul(0.5).add(0.5);
    const streak: TslNode = smoothstep(0.7, 1, band);
    const dark = outer ? vec3(0.07, 0.11, 0.17) : vec3(0.02, 0.04, 0.075);
    const light = outer ? vec3(0.16, 0.24, 0.32) : vec3(0.09, 0.14, 0.22);
    const rim: TslNode = pow(float(1).sub(abs(normalView.dot(positionViewDirection))), 3);
    const body: TslNode = mix(dark, light, streak.mul(0.6).add(h.mul(0.35)));
    m.colorNode = body.add(vec3(0.45, 0.85, 1).mul(rim.mul(outer ? 0.06 : 0.16))) as TslNode;
    const ends: TslNode = smoothstep(0, 0.03, h).mul(float(1).sub(smoothstep(0.82, 1, h)));
    m.opacityNode = (outer ? float(0.18).add(streak.mul(0.25)) : float(0.96)).mul(ends).mul(this.fade) as TslNode;
    this.mats.push(m);
    return m;
  }

  /** age (s since it formed), intensity 0..1 (fade in/out), wind speed scale. */
  update(age: number, intensity: number): void {
    this.time.value = age;
    this.fade.value = Math.min(1, intensity);
    this.cap.rotation.y = age * 0.05;
    const core = this.tornado.coreRadius;
    const peak = this.tornado.peakSpeed * 0.6; // visually slower than the gusts, still violent
    const shown = Math.round(DEBRIS * Math.min(1, intensity));
    const ctop = 90 + 200 * intensity;
    for (let i = 0; i < DEBRIS; i++) {
      if (i >= shown) { this.debris.setMatrixAt(i, this.zero); continue; }
      // Height cycles: lifted from the ground, carried up the spiral, flung out at the top.
      const cyc = (this.p.h[i] + age * this.p.rate[i]) % 1;
      const y = ctop * Math.sin(cyc * Math.PI * 0.5) * (0.4 + 0.6 * (this.p.r[i] / (core * 1.85)));
      const r = this.p.r[i] * (0.7 + 0.6 * cyc);
      // Rankine angular speed: solid-body inside the core, falling off as 1/r² outside.
      const w = r < core ? peak / core : (peak * core) / (r * r);
      const a = this.p.a[i] + age * w;
      // Follow the funnel's sway near the base (it is pinned at the ground).
      const lean = Math.pow(y / this.tornado.height, 1.3);
      const sx = Math.sin(y * 0.0045 + age * 0.35) * 48 * lean, sz = Math.cos(y * 0.0038 + age * 0.29) * 36 * lean;
      const s = this.p.size[i];
      const sp = this.p.spin[i] * age;
      this._q.setFromEuler(this._e.set(sp, sp * 0.7 + i, sp * 1.3));
      this._m.compose(this._v.set(Math.cos(a) * r + sx, y + s / 2, Math.sin(a) * r + sz), this._q, this._s.setScalar(s));
      this.debris.setMatrixAt(i, this._m);
    }
    this.debris.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
