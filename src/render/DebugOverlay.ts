import * as THREE from 'three/webgpu';
import type { Craft } from '../craft/Craft.ts';
import type { DebugForce, ForceKind } from '../modules/ForceModule.ts';

const COLORS: Record<ForceKind, THREE.Color> = {
  lift: new THREE.Color('#33ff55'),
  drag: new THREE.Color('#ff3333'),
  thrust: new THREE.Color('#ffdd00'),
  wheel: new THREE.Color('#aaaaaa'),
  buoyancy: new THREE.Color('#33e0ff'),
};
const MAX_LINES = 256;

/**
 * F3 overlay: force vectors as line segments and CoM / CoL / CoT markers.
 * Forces arrive in world space from the simulation; markers are in craft space.
 */
export class DebugOverlay {
  readonly group = new THREE.Group();
  /** metres of arrow per newton */
  scale = 1 / 800;
  private readonly lines: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly com: THREE.Mesh;
  private readonly col: THREE.Mesh;
  private readonly cot: THREE.Mesh;

  constructor(scene: THREE.Scene, craftRoot: THREE.Object3D) {
    this.positions = new Float32Array(MAX_LINES * 6);
    this.colors = new Float32Array(MAX_LINES * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicNodeMaterial({ vertexColors: true, depthTest: false, transparent: true }),
    );
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 10;
    this.group.add(this.lines);
    scene.add(this.group);

    const marker = (color: string, r: number) => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(r, 16, 12),
        new THREE.MeshBasicNodeMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
      );
      m.renderOrder = 11;
      craftRoot.add(m);
      return m;
    };
    this.com = marker('#ffd400', 0.22);
    this.col = marker('#2f7dff', 0.18);
    this.cot = marker('#b04dff', 0.16);
    this.setVisible(false);
  }

  /** Re-parent the CoM/CoL/CoT markers to a new craft view (after a craft swap). */
  attach(craftRoot: THREE.Object3D): void {
    for (const m of [this.com, this.col, this.cot]) craftRoot.add(m);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
    this.com.visible = this.col.visible = this.cot.visible = v;
  }

  /**
   * @param renderOffset world translation between the physics pose and the interpolated
   *   render pose, so arrows stay attached to the drawn craft.
   */
  update(forces: readonly DebugForce[], craft: Craft, renderOffset: THREE.Vector3): void {
    if (!this.group.visible) return;
    craft.centerOfMass(this.com.position);
    craft.centerOfLift(this.col.position);
    craft.centerOfThrust(this.cot.position);

    let n = 0;
    for (const f of forces) {
      if (n >= MAX_LINES) break;
      const i = n * 6;
      const px = f.point.x + renderOffset.x;
      const py = f.point.y + renderOffset.y;
      const pz = f.point.z + renderOffset.z;
      this.positions[i] = px;
      this.positions[i + 1] = py;
      this.positions[i + 2] = pz;
      this.positions[i + 3] = px + f.force.x * this.scale;
      this.positions[i + 4] = py + f.force.y * this.scale;
      this.positions[i + 5] = pz + f.force.z * this.scale;
      const c = COLORS[f.kind];
      for (let k = 0; k < 6; k += 3) {
        this.colors[i + k] = c.r;
        this.colors[i + k + 1] = c.g;
        this.colors[i + k + 2] = c.b;
      }
      n++;
    }
    const geo = this.lines.geometry;
    geo.setDrawRange(0, n * 2);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }
}
