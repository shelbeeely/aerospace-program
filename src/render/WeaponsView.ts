import * as THREE from 'three/webgpu';
import { abs, float, max, positionLocal, smoothstep } from 'three/tsl';
import type { WeaponSystem } from '../sim/weapons.ts';
import type { TslNode } from './neon.ts';

const MAX = 512;

/**
 * Rounds in flight (reads `sim.weapons.projectiles`), in the shooter's circuit colour and the
 * 1982 palette: gun tracers are thin streaks of light stretched along their velocity; cannon
 * shells are short amber-cored bolts; bombs and missiles are dark solids with lit edges, and a
 * missile trails a white-hot plume. Two InstancedMeshes (additive light, solid bodies).
 */
export class WeaponsView {
  private readonly light: THREE.InstancedMesh;
  private readonly solid: THREE.InstancedMesh;
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly _c = new THREE.Color();
  private readonly fwd = new THREE.Vector3(0, 0, 1);
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private shownLight = 0;
  private shownSolid = 0;

  constructor(scene: THREE.Scene, private readonly weapons: WeaponSystem) {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const glow = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    // Brightest along the axis, tapering to the tail (local z from -0.5 head... +0.5 tail).
    const tail: TslNode = smoothstep(0.5, -0.5, positionLocal.z);
    glow.colorNode = float(0.25).add(tail.mul(2.4)) as TslNode;
    this.light = new THREE.InstancedMesh(box, glow, MAX);
    const body = new THREE.MeshBasicNodeMaterial();
    // Dark body, lit edges (large unlit surfaces, selective light).
    const p: TslNode = abs(positionLocal).mul(2);
    const e: TslNode = max(smoothstep(0.82, 0.98, p.x).mul(smoothstep(0.82, 0.98, p.y)), smoothstep(0.9, 1, p.z));
    body.colorNode = float(0.06).add(e.mul(2.2)) as TslNode;
    this.solid = new THREE.InstancedMesh(box, body, MAX);
    for (const m of [this.light, this.solid]) {
      for (let i = 0; i < MAX; i++) {
        m.setMatrixAt(i, this.zero);
        m.setColorAt(i, this._c.set('#00eaff'));
      }
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }
  }

  /** `alpha`: interpolation toward the next physics step is not needed at these speeds. */
  update(): void {
    let nl = 0, ns = 0;
    const put = (mesh: THREE.InstancedMesh, i: number, pos: THREE.Vector3, dir: THREE.Vector3, w: number, h: number, len: number, back: number, color: string, gain: number) => {
      this._q.setFromUnitVectors(this.fwd, this._d.copy(dir).negate());
      this._p.copy(pos).addScaledVector(dir, -back);
      this._m.compose(this._p, this._q, this._s.set(w, h, len));
      mesh.setMatrixAt(i, this._m);
      mesh.setColorAt(i, this._c.set(color).multiplyScalar(gain));
    };
    const dir = new THREE.Vector3();
    for (const pr of this.weapons.projectiles) {
      if (nl >= MAX - 1 || ns >= MAX - 1) break;
      const speed = pr.vel.length();
      dir.copy(pr.kind === 'missile' ? pr.heading : pr.vel).normalize();
      if (!Number.isFinite(dir.x)) dir.set(0, -1, 0);
      if (pr.kind === 'gun') {
        // Tracer: a streak ~1/60 s of travel long.
        const len = Math.min(14, Math.max(2, speed / 60));
        put(this.light, nl++, pr.pos, dir, 0.09, 0.09, len, len / 2, pr.color, 1.6);
      } else if (pr.kind === 'cannon') {
        put(this.light, nl++, pr.pos, dir, 0.32, 0.32, 3.2, 1.6, '#ffb000', 1.4);
        put(this.light, nl++, pr.pos, dir, 0.14, 0.14, 2.0, 0.8, pr.color, 2);
      } else if (pr.kind === 'bomb') {
        put(this.solid, ns++, pr.pos, dir, 0.42, 0.42, 1.6, 0, pr.color, 1);
      } else {
        put(this.solid, ns++, pr.pos, dir, 0.26, 0.26, 2.3, 0, pr.color, 1);
        // Plume: white-hot behind the nozzle, flickering.
        const flick = 0.85 + 0.3 * Math.sin(pr.age * 90 + pr.id);
        put(this.light, nl++, pr.pos, dir, 0.34, 0.34, 4.5 * flick, 3.4, '#fff4d8', 1.2);
      }
    }
    for (let i = nl; i < this.shownLight; i++) this.light.setMatrixAt(i, this.zero);
    for (let i = ns; i < this.shownSolid; i++) this.solid.setMatrixAt(i, this.zero);
    for (const [m, n, was] of [[this.light, nl, this.shownLight], [this.solid, ns, this.shownSolid]] as const) {
      if (!n && !was) continue;
      m.count = Math.max(n, 1);
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.shownLight = nl;
    this.shownSolid = ns;
  }
}
