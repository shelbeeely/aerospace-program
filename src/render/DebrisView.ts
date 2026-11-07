import * as THREE from 'three';
import type { Debris } from '../sim/Simulation.ts';
import { geometryFor } from './CraftView.ts';

/** Draws parts that broke off, following their own rigid bodies. */
export class DebrisView {
  private readonly items = new Map<Debris, THREE.Mesh>();

  constructor(private readonly scene: THREE.Scene) {}

  /** Add meshes for new debris, drop meshes for debris that's gone, update poses. */
  update(debris: readonly Debris[]): void {
    const live = new Set(debris);
    for (const [d, mesh] of this.items) {
      if (!live.has(d)) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.items.delete(d);
      }
    }
    for (const d of debris) {
      let mesh = this.items.get(d);
      if (!mesh) {
        mesh = new THREE.Mesh(
          geometryFor(d.part.shape),
          new THREE.MeshStandardMaterial({ color: d.part.color, roughness: 0.7, flatShading: true }),
        );
        mesh.castShadow = true;
        this.scene.add(mesh);
        this.items.set(d, mesh);
      }
      const t = d.body.translation();
      const r = d.body.rotation();
      mesh.position.set(t.x, t.y, t.z);
      mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }
}
