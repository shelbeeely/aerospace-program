import * as THREE from 'three/webgpu';
import type { WorldEvent, WorldEvents } from '../sim/events/WorldEvents.ts';
import { NEON, neonLineMaterial } from './neon.ts';
import { TornadoView } from './TornadoView.ts';

/** Only visuals: wind and ground motion come from the deterministic headless event models. */
export class DisasterView {
  private readonly groups = new Map<WorldEvent, THREE.Group>();
  private readonly tornadoes = new Map<WorldEvent, TornadoView>();

  constructor(private readonly scene: THREE.Scene) {}

  private create(event: WorldEvent): THREE.Group {
    const group = new THREE.Group();
    if (event.kind === 'tornado') {
      const view = new TornadoView(event.tornado, event.seed, event.strength);
      this.tornadoes.set(event, view);
      group.add(view.group);
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
    const live = new Set(active);
    for (const [event, group] of this.groups) if (!live.has(event)) {
      group.traverse(o => { if (o instanceof THREE.Line) o.geometry.dispose(); });
      this.tornadoes.get(event)?.dispose();
      this.tornadoes.delete(event);
      this.scene.remove(group);
      this.groups.delete(event);
    }
    for (const event of active) {
      let group = this.groups.get(event);
      if (!group) { group = this.create(event); this.groups.set(event, group); }
      const age = events.time - event.start;
      group.visible = events.intensity(event) > 0.001;
      const origin = event.kind === 'tornado' ? event.tornado : event.hurricane;
      group.position.set(origin.x, 0, origin.z);
      if (event.kind === 'tornado') {
        this.tornadoes.get(event)?.update(age, events.intensity(event));
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
    for (const t of this.tornadoes.values()) t.dispose();
    this.tornadoes.clear();
    this.groups.clear();
  }
}
