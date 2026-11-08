import * as THREE from 'three/webgpu';
import type { Craft } from '../craft/Craft.ts';
import type { FireSystem } from '../sim/fire.ts';
import { glow } from './neon.ts';

/** Wire flames and expanding violet smoke rings, driven by real per-part combustion. */
export class FireView {
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false });
  private readonly lines = new THREE.LineSegments(this.geometry, this.material);
  constructor(scene: THREE.Scene) { this.lines.frustumCulled = false; scene.add(this.lines); }
  update(time: number, fire: FireSystem, craft: Craft): void {
    const positions: number[] = [], colors: number[] = [];
    const orange = glow('#ff6600', 4), pink = glow('#ff35bc', 2.2), smoke = glow('#8f53dc', 0.8);
    const t = craft.body.translation(), r = craft.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const segment = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Color) => {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    let n = 0;
    for (const p of fire.parts.values()) {
      if (!p.burning || n++ > 80) continue;
      const origin = p.position.clone().applyQuaternion(q).add(new THREE.Vector3(t.x, t.y, t.z));
      const scale = Math.min(3, 0.4 + p.fuel * 0.15);
      for (let i = 0; i < 5; i++) {
        const angle = i * Math.PI * 0.4;
        const base = origin.clone().add(new THREE.Vector3(Math.cos(angle) * scale * 0.3, 0, Math.sin(angle) * scale * 0.3));
        const tip = origin.clone().add(new THREE.Vector3(Math.sin(time * 10 + i) * 0.18, scale * (1 + 0.3 * Math.sin(time * 15 + i)), Math.cos(time * 8 + i) * 0.18));
        segment(base, tip, i % 2 ? pink : orange);
      }
      for (let ring = 0; ring < 5; ring++) {
        const h = ((time * 1.5 + ring) % 5) * 2;
        const rad = scale * (0.4 + h * 0.12);
        for (let i = 0; i < 12; i++) {
          const a = i / 12 * Math.PI * 2, b = (i + 1) / 12 * Math.PI * 2;
          segment(origin.clone().add(new THREE.Vector3(Math.cos(a) * rad, h + scale, Math.sin(a) * rad)),
            origin.clone().add(new THREE.Vector3(Math.cos(b) * rad, h + scale, Math.sin(b) * rad)), smoke);
        }
      }
    }
    this.lines.visible = positions.length > 0;
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  }
  dispose(): void { this.lines.removeFromParent(); this.geometry.dispose(); this.material.dispose(); }
}
