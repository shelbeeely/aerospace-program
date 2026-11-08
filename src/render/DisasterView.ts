import * as THREE from 'three/webgpu';
import type { WorldEvent, WorldEvents } from '../sim/events/WorldEvents.ts';
import { NEON, neonLineMaterial } from './neon.ts';

/** Only visuals: wind and ground motion come from the deterministic headless event models. */
export class DisasterView {
  private readonly groups = new Map<number, THREE.Group>();

  constructor(private readonly scene: THREE.Scene) {}

  private create(event: WorldEvent): THREE.Group {
    const group = new THREE.Group();
    if (event.kind === 'tornado') {
      for (let i = 0; i < 20; i++) {
        const y = (i / 19) * event.tornado.height;
        const radius = event.tornado.coreRadius * (0.22 + (i / 19) ** 0.8);
        const points: THREE.Vector3[] = [];
        // Broken rings make their rotation legible rather than spinning a symmetric torus.
        for (let j = 0; j <= 52; j++) {
          const a = (j / 64) * Math.PI * 2;
          points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
        }
        const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), neonLineMaterial(i % 3 ? NEON.magenta : NEON.cyan, 3));
        ring.position.y = y;
        ring.rotation.y = i * 0.6;
        group.add(ring);
      }
    } else if (event.kind === 'hurricane') {
      for (let band = 0; band < 3; band++) {
        const points: THREE.Vector3[] = [];
        for (let i = 0; i <= 240; i++) {
          const f = i / 240;
          const radius = event.hurricane.maxRadius * (0.3 + f * 2.4);
          const a = f * Math.PI * 3 + band * Math.PI * 2 / 3;
          points.push(new THREE.Vector3(Math.cos(a) * radius, 120 + f * 120, Math.sin(a) * radius));
        }
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), neonLineMaterial(band % 2 ? NEON.cyan : NEON.purple, 2.8)));
      }
    } else {
      for (let i = 0; i < 5; i++) {
        const points: THREE.Vector3[] = [];
        for (let j = 0; j <= 96; j++) {
          const a = j / 96 * Math.PI * 2;
          points.push(new THREE.Vector3(Math.cos(a) * 160, 0, Math.sin(a) * 160));
        }
        const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), neonLineMaterial(NEON.orange, 3));
        ring.position.y = 0.25;
        group.add(ring);
      }
    }
    group.traverse(o => { o.frustumCulled = false; });
    this.scene.add(group);
    return group;
  }

  update(events: WorldEvents): void {
    const active = events.active;
    const live = new Set(active.map(e => e.id));
    for (const [id, group] of this.groups) if (!live.has(id)) {
      group.traverse(o => { if (o instanceof THREE.Line) o.geometry.dispose(); });
      this.scene.remove(group);
      this.groups.delete(id);
    }
    for (const event of active) {
      let group = this.groups.get(event.id);
      if (!group) { group = this.create(event); this.groups.set(event.id, group); }
      const age = events.time - event.start;
      group.visible = events.intensity(event) > 0.001;
      const origin = event.kind === 'tornado' ? event.tornado : event.hurricane;
      group.position.set(origin.x, 0, origin.z);
      if (event.kind === 'tornado') {
        group.position.x += age * event.tornado.velocityX;
        group.position.z += age * event.tornado.velocityZ;
        for (let i = 0; i < group.children.length; i++) group.children[i].rotation.y = age * (1.2 + i * 0.025) + i * 0.6;
      } else if (event.kind === 'hurricane') group.rotation.y = age * 0.025;
      else for (let i = 0; i < group.children.length; i++) {
        const scale = 0.1 + ((age * 0.35 + i / group.children.length) % 1) * 5;
        group.children[i].scale.set(scale, 1, scale);
      }
    }
  }

  dispose(): void {
    for (const group of this.groups.values()) {
      group.traverse(o => { if (o instanceof THREE.Line) o.geometry.dispose(); });
      this.scene.remove(group);
    }
    this.groups.clear();
  }
}
