import * as THREE from 'three/webgpu';
import type { EvolutionLab } from '../sim/evolutionLab.ts';
import { neonTint } from './neon.ts';

const MAX_RUNNERS = 64;

/**
 * The Evolution Lab's pressures, drawn (the people themselves are a BitsView): each kerb runner
 * as a low light-cycle body with a short light wall trailing it, each blast as a red ring that
 * opens and fades, and in war a red beacon over each standing enemy tower. Light that says what
 * is happening (§5); nothing else lit.
 */
export class EvolutionLabView {
  private readonly bodies: THREE.InstancedMesh;
  private readonly walls: THREE.InstancedMesh;
  private readonly ring: THREE.Mesh;
  /** War: a red beacon over each enemy tower (dark while it is down). */
  private readonly beacons: THREE.InstancedMesh;
  private readonly ringMat: THREE.MeshBasicNodeMaterial;
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3(1, 1, 1);
  private readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly scene: THREE.Scene, private readonly lab: EvolutionLab) {
    const light = neonTint('#dff6ff');
    this.bodies = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.9, 3).translate(0, 0.45, 0), new THREE.MeshBasicNodeMaterial({ color: light.clone().multiplyScalar(1.6) }), MAX_RUNNERS);
    // The wall trails behind the body (local +Z is behind).
    this.walls = new THREE.InstancedMesh(new THREE.PlaneGeometry(10, 1.3).rotateY(Math.PI / 2).translate(0, 0.65, 6.5), new THREE.MeshBasicNodeMaterial({ color: neonTint('#00d4ff').multiplyScalar(0.9), transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }), MAX_RUNNERS);
    for (const m of [this.bodies, this.walls]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count = 0; m.frustumCulled = false; scene.add(m); }
    this.ringMat = new THREE.MeshBasicNodeMaterial({ color: neonTint('#ff2a12').multiplyScalar(1.8), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2), this.ringMat);
    this.ring.visible = false;
    scene.add(this.ring);
    this.beacons = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.8, 0.8, 140, 6, 1, true).translate(0, 70, 0), new THREE.MeshBasicNodeMaterial({ color: neonTint('#ff2a12').multiplyScalar(0.9), transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }), 8);
    this.beacons.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beacons.count = 0;
    this.beacons.frustumCulled = false;
    scene.add(this.beacons);
  }

  set visible(v: boolean) {
    this.bodies.visible = this.walls.visible = this.beacons.visible = v;
    if (!v) this.ring.visible = false;
  }

  update(): void {
    let n = 0;
    for (const t of this.lab.threats) {
      if (n >= MAX_RUNNERS) break;
      const yaw = Math.atan2(-t.vx, -t.vz); // body faces its way of travel (-Z forward)
      this._q.setFromAxisAngle(this._up, yaw);
      this._p.set(t.x, t.y - 1.35, t.z);
      this._m.compose(this._p, this._q, this._s);
      this.bodies.setMatrixAt(n, this._m);
      this.walls.setMatrixAt(n, this._m);
      n++;
    }
    this.bodies.count = this.walls.count = n;
    this.bodies.instanceMatrix.needsUpdate = this.walls.instanceMatrix.needsUpdate = true;
    let nb = 0;
    if (this.lab.settings.war > 0) for (const t of this.lab.towers) {
      if (this.lab.time < t.downUntil || nb >= 8) continue;
      this._q.identity();
      this._p.set(t.baseX, 0, t.baseZ);
      this.beacons.setMatrixAt(nb++, this._m.compose(this._p, this._q, this._s));
    }
    this.beacons.count = nb;
    this.beacons.instanceMatrix.needsUpdate = true;
    const b = this.lab.lastBlast;
    const age = b ? this.lab.time - b.time : Infinity;
    this.ring.visible = age < 1.2;
    if (b && this.ring.visible) {
      const r = 2 + age * 30;
      this.ring.position.set(b.x, b.y - 1.2, b.z);
      this.ring.scale.setScalar(r);
      this.ringMat.opacity = 0.8 * (1 - age / 1.2);
    }
  }

  dispose(): void {
    for (const m of [this.bodies, this.walls, this.beacons]) { m.removeFromParent(); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.ring.removeFromParent();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
    void this.scene;
  }
}
