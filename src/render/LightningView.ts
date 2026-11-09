import * as THREE from 'three/webgpu';
import type { Craft } from '../craft/Craft.ts';
import type { LightningStrike } from '../sim/lightning.ts';
import { glow, NEON } from './neon.ts';

/** Neon lightning leader and violet St. Elmo coronas on exposed aircraft extremities. */
export class LightningView {
  private readonly boltGeometry = new THREE.BufferGeometry();
  private readonly boltMaterial = new THREE.LineBasicNodeMaterial({ color: glow('#d6f6ff', 6), transparent: true, fog: false });
  private readonly bolt = new THREE.Line(this.boltGeometry, this.boltMaterial);
  private readonly coronaGeometry = new THREE.BufferGeometry();
  private readonly coronaMaterial = new THREE.LineBasicNodeMaterial({ color: glow(NEON.purple, 3), transparent: true, depthWrite: false });
  private readonly corona = new THREE.LineSegments(this.coronaGeometry, this.coronaMaterial);
  private lastStrike = -1;
  constructor(scene: THREE.Scene) {
    this.coronaGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(80 * 12), 3).setUsage(THREE.DynamicDrawUsage));
    this.bolt.frustumCulled = this.corona.frustumCulled = false;
    scene.add(this.bolt, this.corona);
  }
  update(time: number, strikes: readonly LightningStrike[], craft: Craft, storm: number): void {
    const latest = strikes.at(-1);
    const age = latest ? time - latest.time : Infinity;
    this.bolt.visible = age >= 0 && age < 0.45;
    if (latest && this.lastStrike !== latest.id) {
      this.lastStrike = latest.id;
      this.boltGeometry.setFromPoints(latest.points);
    }
    this.boltMaterial.opacity = Math.max(0, 1 - age / 0.45);
    this.corona.visible = storm > 0.25;
    if (!this.corona.visible) return;
    const pos = craft.body.translation(), rot = craft.body.rotation();
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const lines: number[] = [];
    for (const part of craft.parts.slice(0, 80)) {
      const p = new THREE.Vector3(...part.position).applyQuaternion(q).add(new THREE.Vector3(pos.x, pos.y, pos.z));
      const height = (0.12 + 0.15 * Math.sin(time * 13 + p.x)) * storm;
      lines.push(p.x - 0.06, p.y, p.z, p.x, p.y + height, p.z,
        p.x, p.y + height, p.z, p.x + 0.06, p.y, p.z);
    }
    const attribute = this.coronaGeometry.getAttribute('position') as THREE.BufferAttribute;
    (attribute.array as Float32Array).set(lines); attribute.needsUpdate = true;
    this.coronaGeometry.setDrawRange(0, lines.length / 3);
    this.coronaMaterial.opacity = Math.min(1, storm);
  }
  dispose(): void {
    this.bolt.removeFromParent(); this.corona.removeFromParent();
    this.boltGeometry.dispose(); this.coronaGeometry.dispose(); this.boltMaterial.dispose(); this.coronaMaterial.dispose();
  }
}
