import * as THREE from 'three/webgpu';
import { atan, float, positionLocal, sin, smoothstep, uniform } from 'three/tsl';
import type { BoomEvent } from '../sim/sonicBoom.ts';
import type { TslNode } from './neon.ts';

const RINGS = 12;
const RING_LIFE = 1.6;

/**
 * Sonic booms, visual only: around a supersonic craft its Mach cone (half-angle asin(1/M)),
 * faint lines of light trailing from the nose; through the transonic range a white vapour cone
 * wraps the craft; and where a boom hits the ground a pale shock ring races outward.
 */
export class BoomView {
  private readonly cone: THREE.Mesh;
  private readonly vapour: THREE.Mesh;
  private readonly coneFade = uniform(0);
  private readonly vapourFade = uniform(0);
  private readonly rings: Array<{ mesh: THREE.Mesh; fade: { value: number }; t0: number; r: number }> = [];
  private seen = -Infinity;
  private next = 0;
  private readonly _q = new THREE.Quaternion();
  private readonly _d = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    // Unit cone along +Y with its apex at the origin, opening toward -Y (behind the nose).
    // ConeGeometry's apex is at +0.5 Y: shift it to the origin so the base lies at -1 Y.
    const coneGeo = new THREE.ConeGeometry(1, 1, 32, 1, true).translate(0, -0.5, 0);
    const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide } as const;
    const coneMat = new THREE.MeshBasicNodeMaterial(add);
    // Bright near the apex, fading down the cone; thin streaks around it.
    const along: TslNode = positionLocal.y.negate(); // 0 at the apex .. 1 at the base (before scaling)
    // Thin lines of light running back from the nose (1982: light marks the shock, it doesn't
    // fill it), over a faint sheen, both fading toward the base.
    const ang: TslNode = atan(positionLocal.z, positionLocal.x);
    const rays: TslNode = smoothstep(0.9, 1, sin(ang.mul(18)));
    const fadeOut: TslNode = float(1).sub(smoothstep(0.05, 1, along));
    coneMat.colorNode = float(0.04).add(rays.mul(0.35)).mul(fadeOut).mul(this.coneFade) as TslNode;
    this.cone = new THREE.Mesh(coneGeo, coneMat);
    const vapMat = new THREE.MeshBasicNodeMaterial({ ...add, blending: THREE.NormalBlending });
    vapMat.colorNode = float(0.92) as TslNode;
    vapMat.opacityNode = float(0.35).mul(smoothstep(0, 0.6, along)).mul(float(1).sub(smoothstep(0.6, 1, along))).mul(this.vapourFade) as TslNode;
    this.vapour = new THREE.Mesh(coneGeo, vapMat);
    for (const m of [this.cone, this.vapour]) {
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
    }
    const ringGeo = new THREE.RingGeometry(0.94, 1, 96).rotateX(-Math.PI / 2);
    for (let i = 0; i < RINGS; i++) {
      const fade = uniform(0);
      const mat = new THREE.MeshBasicNodeMaterial(add);
      mat.colorNode = (float(0.75) as TslNode).mul(fade).mul(float(1)) as TslNode;
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.rings.push({ mesh, fade, t0: -Infinity, r: 0 });
    }
  }

  /** `pos`/`vel`: the craft (render pose); `mach`: its Mach number; `length`: its size (m). */
  update(time: number, pos: THREE.Vector3, vel: THREE.Vector3, mach: number, length: number, booms: readonly BoomEvent[], ground: (x: number, z: number) => number): void {
    const speed = vel.length();
    const dir = speed > 1 ? this._d.copy(vel).divideScalar(speed) : this._d.set(0, 0, -1);
    this._q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir); // +Y (apex side) leads, the base trails
    // Mach cone.
    const supersonic = mach > 1.02;
    this.cone.visible = supersonic;
    if (supersonic) {
      const half = Math.asin(1 / mach);
      const len = 30 + length * 3;
      this.cone.position.copy(pos).addScaledVector(dir, length * 0.5);
      this.cone.quaternion.copy(this._q);
      this.cone.scale.set(Math.tan(half) * len, len, Math.tan(half) * len);
      this.coneFade.value = Math.min(1, (mach - 1.02) * 5);
    }
    // Vapour cone: transonic, densest right at Mach 1.
    const vap = Math.max(0, 1 - Math.abs(mach - 1.02) / 0.13);
    this.vapour.visible = vap > 0.02;
    if (this.vapour.visible) {
      const r = length * 0.45;
      this.vapour.position.copy(pos).addScaledVector(dir, length * 0.15);
      this.vapour.quaternion.copy(this._q);
      this.vapour.scale.set(r, length * 0.8, r);
      this.vapourFade.value = vap;
    }
    // Shock rings on the ground.
    for (const b of booms) {
      if (b.time <= this.seen) continue;
      this.seen = b.time;
      if (b.groundDp < 250) continue;
      const ring = this.rings[this.next];
      this.next = (this.next + 1) % RINGS;
      ring.t0 = time;
      ring.r = Math.min(600, 40 + (b.y - ground(b.x, b.z)) * 1.2);
      ring.mesh.position.set(b.x, ground(b.x, b.z) + 0.2, b.z);
      ring.fade.value = Math.min(1, b.groundDp / 1500);
    }
    for (const ring of this.rings) {
      const age = time - ring.t0;
      ring.mesh.visible = age >= 0 && age < RING_LIFE;
      if (!ring.mesh.visible) continue;
      const k = age / RING_LIFE;
      ring.mesh.scale.setScalar(ring.r * (0.2 + 0.8 * Math.sqrt(k)));
      ring.fade.value *= 0.985;
    }
  }
}
