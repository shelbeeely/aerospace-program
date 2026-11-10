import * as THREE from 'three/webgpu';
import { atan, float, floor, fract, length, max, mix, sin, smoothstep, uv, vec3 } from 'three/tsl';
import type { TslNode } from './neon.ts';

const MAX = 256;
/** Seconds for a crater's exposed circuitry to cool from hot to its resting glow. */
const COOL = 25;

/**
 * Ground craters (reads `sim.craters`): where a bomb, shell, missile or crash struck, the Grid
 * is scarred. In the 1982 language rather than a muddy hole: a dark recessed pit drawn as
 * stepped concentric terraces, radial fractures through the grid, and a broken rim of exposed
 * circuitry that glows hot in the blast's circuit colour and cools to a faint ember. One
 * InstancedMesh decal laid flat on the ground; persistent until the world resets.
 */
export class CraterView {
  readonly mesh: THREE.InstancedMesh;
  private shown = 0;
  private readonly heat: number[] = [];
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _c = new THREE.Color();
  private readonly _g = new THREE.Color();
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(scene: THREE.Scene) {
    // Unit disc in XY (laid flat by the instance rotation); radius 1.
    const geo = new THREE.CircleGeometry(1, 48, 0, Math.PI * 2);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    // Crater-local coordinates from the disc's UVs (positionLocal already carries the instance
    // scale here): q in -1..1 across the crater, r = 0 at the centre, 1 at the rim.
    const q: TslNode = uv().mul(2).sub(1);
    const r: TslNode = length(q);
    const a: TslNode = atan(q.y, q.x);
    // Terraces: four stepped rings, darkest at the bottom of the pit.
    const step: TslNode = floor(r.mul(4)).div(4);
    const terraceEdge: TslNode = smoothstep(0.9, 1, fract(r.mul(4))).mul(smoothstep(0.15, 0.3, r));
    // Radial fractures: thin cracks at irregular angles, fading toward the centre.
    const crack: TslNode = smoothstep(0.96, 1, sin(a.mul(7).add(sin(a.mul(3)).mul(1.7))).abs()).mul(smoothstep(0.2, 0.8, r));
    // Broken rim: exposed circuitry in an irregular band just inside the edge.
    const rim: TslNode = smoothstep(0.78, 0.9, r).mul(float(1).sub(smoothstep(0.93, 1, r))).mul(smoothstep(-0.3, 0.6, sin(a.mul(11)).add(sin(a.mul(5).add(1.3)).mul(0.6))));
    const pit: TslNode = mix(vec3(0.004, 0.006, 0.01), vec3(0.02, 0.03, 0.045), step);
    // Instance colour = the glow (circuit colour × heat); the pit itself stays near-black.
    const glow: TslNode = max(rim, max(crack.mul(0.6), terraceEdge.mul(0.25)));
    mat.colorNode = pit.add(glow.mul(1.6)) as TslNode; // × instance colour (pit tinted only faintly)
    mat.opacityNode = float(0.92).mul(float(1).sub(smoothstep(0.94, 1, r))).max(glow) as TslNode;
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    for (let i = 0; i < MAX; i++) {
      this.mesh.setMatrixAt(i, this.zero);
      this.mesh.setColorAt(i, this._c.set(0, 0, 0));
    }
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  update(time: number, craters: ReadonlyArray<{ x: number; y: number; z: number; radius: number; time: number; color: string }>): void {
    const n = Math.min(MAX, craters.length);
    let colorsDirty = false;
    for (let i = 0; i < n; i++) {
      const c = craters[craters.length - n + i];
      if (i >= this.shown || this.heat[i] !== c.time) {
        this._m.compose(this._p.set(c.x, c.y + 0.06, c.z), this._q, this._s.set(c.radius, c.radius, 1));
        this.mesh.setMatrixAt(i, this._m);
      }
      // Hot at first, cooling to a faint ember of the circuit colour.
      const age = time - c.time;
      const heat = 0.18 + 0.82 * Math.exp(-age / (COOL / 3));
      if (age < COOL * 2 || this.heat[i] !== c.time) {
        this._g.set(c.color);
        // Very hot: whiter; cool: the circuit colour.
        this._c.copy(this._g).lerp(new THREE.Color('#fff2d0'), Math.max(0, heat - 0.6)).multiplyScalar(heat);
        this.mesh.setColorAt(i, this._c);
        colorsDirty = true;
      }
      this.heat[i] = c.time;
    }
    for (let i = n; i < this.shown; i++) this.mesh.setMatrixAt(i, this.zero);
    if (n !== this.shown || colorsDirty) {
      this.mesh.count = Math.max(1, n);
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
    if (n === 0 && this.shown === 0) this.mesh.count = 0;
    this.shown = n;
  }
}
