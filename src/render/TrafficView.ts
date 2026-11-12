import * as THREE from 'three/webgpu';
import { DEREZ_TIME } from '../sim/trails.ts';
import { HX, HZ, TRAFFIC, type TrafficSystem } from '../sim/traffic.ts';

const MAX_RUNS = TRAFFIC.maxRiders * 6;

/** One light-cycle silhouette: a dark hull traced by light (side strips, wheel rims, canopy). */
function cycleGeometry(): THREE.BufferGeometry {
  const parts: Array<[THREE.BufferGeometry, number]> = [];
  const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, glow: number) => {
    g.translate(x, y, z);
    parts.push([g.index ? g.toNonIndexed() : g, glow]);
  };
  add(new THREE.BoxGeometry(0.6, 0.5, 2.5), 0, 0.78, 0, 0.06); // hull
  add(new THREE.BoxGeometry(0.64, 0.07, 2.56), 0, 0.62, 0, 3); // light strips down both flanks
  add(new THREE.BoxGeometry(0.64, 0.05, 1.6), 0, 1.04, 0.3, 1.6); // upper trace
  add(new THREE.BoxGeometry(0.48, 0.2, 1.1), 0, 1.12, -0.3, 1.2); // canopy
  for (const z of [-1.12, 1.12]) {
    const rim = new THREE.TorusGeometry(0.46, 0.065, 6, 20);
    rim.rotateY(Math.PI / 2);
    add(rim, 0, 0.48, z, 3.4);
    const hub = new THREE.CylinderGeometry(0.4, 0.4, 0.3, 16);
    hub.rotateZ(Math.PI / 2);
    add(hub, 0, 0.48, z, 0.05);
  }
  let n = 0;
  for (const [g] of parts) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const [g, glow] of parts) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++, o++) {
      pos[o * 3] = p.getX(i); pos[o * 3 + 1] = p.getY(i); pos[o * 3 + 2] = p.getZ(i);
      col[o * 3] = col[o * 3 + 1] = col[o * 3 + 2] = glow;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Draws the AI light-cycle traffic: instanced cycle silhouettes in their program colour (cyan
 * or amber) and their short jetwalls in TrailView's look (translucent additive panels with a
 * blazing top edge, dimming toward the tail). Derezzing riders flicker out with their walls.
 */
export class TrafficView {
  private readonly cycles: THREE.InstancedMesh;
  private readonly geo = new THREE.BufferGeometry();
  private readonly lineGeo = new THREE.BufferGeometry();
  private readonly pos = new Float32Array(MAX_RUNS * 6 * 3);
  private readonly col = new Float32Array(MAX_RUNS * 6 * 3);
  private readonly lpos = new Float32Array(MAX_RUNS * 2 * 3);
  private readonly lcol = new Float32Array(MAX_RUNS * 2 * 3);
  private readonly team = TRAFFIC.colors.map((c) => new THREE.Color(c));
  private readonly hackColors = new Map<string, THREE.Color>();
  private readonly _c = new THREE.Color();
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene, private readonly traffic: TrafficSystem) {
    const mat = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
    this.cycles = new THREE.InstancedMesh(cycleGeometry(), mat, TRAFFIC.maxRiders);
    this.cycles.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC.maxRiders * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.cycles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cycles.count = 0;
    this.cycles.frustumCulled = false;
    this.cycles.name = 'traffic';
    scene.add(this.cycles);

    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.lpos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeo.setAttribute('color', new THREE.BufferAttribute(this.lcol, 3).setUsage(THREE.DynamicDrawUsage));
    const wallMat = new THREE.MeshBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const lineMat = new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(this.geo, wallMat);
    const lines = new THREE.LineSegments(this.lineGeo, lineMat);
    for (const o of [mesh, lines]) { o.frustumCulled = false; o.renderOrder = 2; scene.add(o); }
    this.geo.setDrawRange(0, 0);
    this.lineGeo.setDrawRange(0, 0);
  }

  update(time: number): void {
    let n = 0, v = 0, l = 0;
    const P = this.pos, Cc = this.col, LP = this.lpos, LC = this.lcol;
    const H = TRAFFIC.trailHeight, L = TRAFFIC.trailLength;
    for (const r of this.traffic.riders) {
      if (n >= TRAFFIC.maxRiders) break;
      // A hacked rider rides in the player's team colour.
      const base = r.hackColor ? (this.hackColors.get(r.hackColor) ?? this.hackColors.set(r.hackColor, new THREE.Color(r.hackColor)).get(r.hackColor)!) : this.team[r.team];
      let fade = 1;
      if (r.derezAt !== null) {
        // Derez: flicker and fall away, cycle and wall together.
        const age = (time - r.derezAt) / DEREZ_TIME;
        fade = Math.max(0, 1 - age) * (Math.sin(time * 70 + r.id) > -0.2 ? 1 : 0.15);
      }
      // The cycle.
      const yaw = Math.atan2(-HX[r.heading], -HZ[r.heading]);
      this._q.setFromAxisAngle(this.up, yaw);
      this._p.set(r.x, 0, r.z);
      this._s.set(1, r.derezAt === null ? 1 : Math.max(0.05, fade), 1);
      this._m.compose(this._p, this._q, this._s);
      this.cycles.setMatrixAt(n, this._m);
      this._c.copy(base).multiplyScalar(fade);
      this.cycles.setColorAt(n, this._c);
      n++;
      if (fade <= 0.01) continue;
      // Its jetwall: brightest at the cycle, dimming to the tail.
      const pts = [...r.trail, this.traffic.tail(r)];
      let arc = 0;
      for (let k = pts.length - 1; k >= 1 && v < MAX_RUNS * 6; k--) {
        const a = pts[k - 1], b = pts[k];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 0.05) continue;
        const kb = fade * Math.max(0, 1 - arc / L);
        arc += len;
        const ka = fade * Math.max(0, 1 - arc / L);
        const quad: Array<[number, number, number, number]> = [
          [a.x, 0, a.z, 0.35 * ka], [b.x, 0, b.z, 0.35 * kb], [a.x, H, a.z, 1.2 * ka],
          [a.x, H, a.z, 1.2 * ka], [b.x, 0, b.z, 0.35 * kb], [b.x, H, b.z, 1.2 * kb],
        ];
        for (const [x, y, z, s] of quad) {
          P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z;
          Cc[v * 3] = base.r * s; Cc[v * 3 + 1] = base.g * s; Cc[v * 3 + 2] = base.b * s;
          v++;
        }
        for (const [p, k2] of [[a, ka], [b, kb]] as const) {
          const s = 3.2 * k2;
          LP[l * 3] = p.x; LP[l * 3 + 1] = H; LP[l * 3 + 2] = p.z;
          LC[l * 3] = Math.min(4, base.r * s + 0.6 * k2); LC[l * 3 + 1] = Math.min(4, base.g * s + 0.6 * k2); LC[l * 3 + 2] = Math.min(4, base.b * s + 0.6 * k2);
          l++;
        }
      }
    }
    this.cycles.count = n;
    this.cycles.instanceMatrix.needsUpdate = true;
    if (this.cycles.instanceColor) this.cycles.instanceColor.needsUpdate = true;
    for (const a of [this.geo.getAttribute('position'), this.geo.getAttribute('color'), this.lineGeo.getAttribute('position'), this.lineGeo.getAttribute('color')]) (a as THREE.BufferAttribute).needsUpdate = true;
    this.geo.setDrawRange(0, v);
    this.lineGeo.setDrawRange(0, l);
  }
}
