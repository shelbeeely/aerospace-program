import * as THREE from 'three/webgpu';
import { abs, float, max, min, positionLocal, smoothstep } from 'three/tsl';
import type { ChipEmitter } from '../sim/chips.ts';
import type { TslNode } from './neon.ts';

const MAX = 6000;

/**
 * Flying voxel chips (visual only): every burst from the simulation's ChipEmitter becomes small
 * cubes with glowing edges that fly with the impactor, scatter outward, tumble, bounce on the
 * street and fade out. One InstancedMesh, CPU-integrated (no physics bodies).
 */
export class ChipsView {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly spin = new Float32Array(MAX * 3);
  private readonly rot = new Float32Array(MAX * 3);
  private readonly size = new Float32Array(MAX);
  private readonly life = new Float32Array(MAX);
  private readonly age = new Float32Array(MAX);
  private next = 0;
  private live = 0;
  private seenSeq = 0;
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _c = new THREE.Color();
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(scene: THREE.Scene, private readonly emitter: ChipEmitter) {
    const mat = new THREE.MeshBasicNodeMaterial();
    // Glowing cube edges: brightest where two faces meet, dark-ish faces in between.
    const p: TslNode = abs(positionLocal).mul(2); // 0 at centre, 1 at the faces
    const a: TslNode = smoothstep(0.78, 0.98, p.x);
    const b: TslNode = smoothstep(0.78, 0.98, p.y);
    const c: TslNode = smoothstep(0.78, 0.98, p.z);
    const edge: TslNode = max(max(min(a, b), min(b, c)), min(a, c));
    mat.colorNode = float(0.18).add(edge.mul(3.2)) as TslNode; // × the instance colour
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, MAX);
    // InstancedMesh colours multiply the material colour; the node above scales brightness.
    for (let i = 0; i < MAX; i++) {
      this.mesh.setMatrixAt(i, this.zero);
      this.mesh.setColorAt(i, this._c.set('#00eaff'));
    }
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Flush on reset. */
  clear(): void {
    this.life.fill(0);
    this.age.fill(0);
    for (let i = 0; i < MAX; i++) this.mesh.setMatrixAt(i, this.zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.live = 0;
  }

  update(dt: number): void {
    // New bursts.
    if (this.emitter.seq < this.seenSeq) {
      this.seenSeq = 0; // the emitter was reset
      this.clear();
    }
    for (const b of this.emitter.bursts) {
      if (b.seq <= this.seenSeq) continue;
      this.seenSeq = b.seq;
      this._c.set(b.color).multiplyScalar(1.4);
      for (let k = 0; k < b.count; k++) {
        const i = this.next;
        this.next = (this.next + 1) % MAX;
        const dx = Math.random() * 2 - 1, dy = Math.random() * 2 - 1, dz = Math.random() * 2 - 1;
        const len = Math.hypot(dx, dy, dz) || 1;
        this.pos[i * 3] = b.x + (dx / len) * b.radius * Math.random();
        this.pos[i * 3 + 1] = b.y + (dy / len) * b.radius * Math.random();
        this.pos[i * 3 + 2] = b.z + (dz / len) * b.radius * Math.random();
        const sp = b.speed * (0.4 + Math.random() * 0.8);
        this.vel[i * 3] = b.vx + (dx / len) * sp;
        this.vel[i * 3 + 1] = b.vy + Math.abs(dy / len) * sp * 0.7 + 1;
        this.vel[i * 3 + 2] = b.vz + (dz / len) * sp;
        this.spin[i * 3] = (Math.random() - 0.5) * 14;
        this.spin[i * 3 + 1] = (Math.random() - 0.5) * 14;
        this.spin[i * 3 + 2] = (Math.random() - 0.5) * 14;
        this.size[i] = b.size * (0.6 + Math.random() * 0.7);
        this.life[i] = 5 + Math.random() * 5;
        this.age[i] = 0;
        this.mesh.setColorAt(i, this._c);
      }
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }

    // Integrate: gravity, drag, ground bounce, fade by shrinking.
    let live = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.life[i] = 0;
        this.mesh.setMatrixAt(i, this.zero);
        continue;
      }
      live++;
      const o = i * 3;
      const s = this.size[i];
      this.vel[o + 1] -= 9.81 * dt;
      const drag = Math.exp(-0.15 * dt);
      this.vel[o] *= drag;
      this.vel[o + 2] *= drag;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.pos[o + 1] < s / 2) {
        this.pos[o + 1] = s / 2;
        if (this.vel[o + 1] < 0) this.vel[o + 1] *= -0.3;
        this.vel[o] *= 0.6;
        this.vel[o + 2] *= 0.6;
        this.spin[o] *= 0.7;
        this.spin[o + 1] *= 0.7;
        this.spin[o + 2] *= 0.7;
      }
      this.rot[o] += this.spin[o] * dt;
      this.rot[o + 1] += this.spin[o + 1] * dt;
      this.rot[o + 2] += this.spin[o + 2] * dt;
      const fade = Math.min(1, (this.life[i] - this.age[i]) / 1.2);
      this._q.setFromEuler(this._e.set(this.rot[o], this.rot[o + 1], this.rot[o + 2]));
      this._m.compose(this._p.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]), this._q, this._s.setScalar(s * fade));
      this.mesh.setMatrixAt(i, this._m);
    }
    if (live || this.live) this.mesh.instanceMatrix.needsUpdate = true;
    this.live = live;
  }
}
