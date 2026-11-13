import * as THREE from 'three/webgpu';

/**
 * The hacking beam: a thin tether of light from the craft's nose to the target it is held on,
 * pulsing in the team's colour and brightening as the hack builds. Only while the beam holds.
 */
export class HackBeamView {
  readonly root: THREE.Mesh;
  private readonly mat: THREE.MeshBasicNodeMaterial;
  private readonly _a = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene) {
    this.mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    // A unit cylinder along +Y from 0 to 1, stretched between the two ends each frame.
    const geo = new THREE.CylinderGeometry(0.12, 0.12, 1, 6, 1, true).translate(0, 0.5, 0);
    this.root = new THREE.Mesh(geo, this.mat);
    this.root.frustumCulled = false;
    this.root.visible = false;
    this.root.name = 'hack beam';
    scene.add(this.root);
  }

  /** `from` and `to` in world space (null: no beam); `progress` 0..1; `time` for the pulse. */
  update(from: THREE.Vector3 | null, to: THREE.Vector3 | null, color: string, progress: number, time: number): void {
    if (!from || !to) { this.root.visible = false; return; }
    const d = this._d.subVectors(to, from);
    const len = d.length();
    if (len < 1) { this.root.visible = false; return; }
    this.root.visible = true;
    this.root.position.copy(from);
    this.root.quaternion.setFromUnitVectors(this._up, d.divideScalar(len));
    // Thicker as it builds (still thin), pulsing.
    const pulse = 0.55 + 0.45 * Math.sin(time * 14);
    const w = 0.6 + progress * 1.4;
    this.root.scale.set(w, len, w);
    this.mat.color.set(color);
    this.mat.opacity = (0.35 + 0.5 * progress) * pulse;
    void this._a;
  }
}
