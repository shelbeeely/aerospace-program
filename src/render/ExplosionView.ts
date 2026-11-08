import * as THREE from 'three/webgpu';
import { abs, float, normalView, positionViewDirection, pow, uniform } from 'three/tsl';
import type { TslNode } from './neon.ts';

const SLOTS = 4;
const LIFE = 3.2;

interface Slot {
  fireball: THREE.Mesh;
  core: THREE.Mesh;
  ring: THREE.Mesh;
  light: THREE.PointLight;
  fade: { value: number };
  ringFade: { value: number };
  time: number;
  radius: number;
  baseY: number;
}

/**
 * Craft explosions (reads `sim.explosions`): a white-hot core, an orange fireball that swells and
 * cools to violet, a cyan shockwave ring racing out along the ground, and a brief flash of light.
 * Visual only; the blast's physical effects happen in the simulation.
 */
export class ExplosionView {
  readonly root = new THREE.Group();
  private readonly slots: Slot[] = [];
  private seen = -Infinity;
  private next = 0;

  constructor(scene: THREE.Scene) {
    this.root.name = 'explosions';
    const sphere = new THREE.IcosahedronGeometry(1, 3);
    const ringGeo = new THREE.RingGeometry(0.86, 1, 96).rotateX(-Math.PI / 2);
    for (let i = 0; i < SLOTS; i++) {
      const fade = uniform(0);
      const ringFade = uniform(0);
      const fire = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      // Brighter at the limb (a glowing shell rather than a flat disc).
      const rim: TslNode = pow(float(1).sub(abs(normalView.dot(positionViewDirection))), 1.5);
      const tint = uniform(new THREE.Color('#ff8a1f'));
      fire.colorNode = (tint as TslNode).mul(float(0.08).add(rim.mul(1.1))).mul(fade);
      const coreMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      coreMat.colorNode = uniform(new THREE.Color('#fff2d0')).mul(2.5).mul(fade).mul(fade);
      const ringMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      ringMat.colorNode = uniform(new THREE.Color('#5ff6ff')).mul(2.5).mul(ringFade);
      const fireball = new THREE.Mesh(sphere, fire);
      const core = new THREE.Mesh(sphere, coreMat);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      const light = new THREE.PointLight('#ff9a40', 0, 400, 1.6);
      for (const o of [fireball, core, ring, light]) {
        o.visible = false;
        o.frustumCulled = false;
        this.root.add(o);
      }
      fireball.userData.tint = tint;
      this.slots.push({ fireball, core, ring, light, fade, ringFade, time: -Infinity, radius: 10, baseY: 0 });
    }
    scene.add(this.root);
  }

  /** Flush on reset. */
  clear(): void {
    for (const s of this.slots) {
      s.time = -Infinity;
      for (const o of [s.fireball, s.core, s.ring, s.light]) o.visible = false;
    }
  }

  update(time: number, explosions: ReadonlyArray<{ x: number; y: number; z: number; time: number; radius: number }>): void {
    if (!explosions.length && this.seen > -Infinity) {
      this.seen = -Infinity; // the world was reset
      this.clear();
    }
    for (const e of explosions) {
      if (e.time <= this.seen) continue;
      this.seen = e.time;
      const s = this.slots[this.next];
      this.next = (this.next + 1) % SLOTS;
      s.time = e.time;
      s.radius = e.radius;
      s.baseY = e.y;
      s.fireball.position.set(e.x, e.y, e.z);
      s.core.position.set(e.x, e.y, e.z);
      s.light.position.set(e.x, e.y + 2, e.z);
      s.ring.position.set(e.x, Math.max(0.3, e.y - 2), e.z);
    }
    for (const s of this.slots) {
      const age = time - s.time;
      const live = age >= 0 && age < LIFE;
      for (const o of [s.fireball, s.core, s.ring, s.light]) o.visible = live;
      if (!live) continue;
      const u = age / LIFE;
      // Fireball: fast swell (ease-out) to ~0.8 radius, then a slow rise as it cools.
      const grow = 1 - Math.pow(1 - Math.min(1, age / 0.6), 3);
      const r = s.radius * (0.15 + 0.65 * grow + 0.15 * u);
      s.fireball.scale.setScalar(r);
      s.fireball.position.y = s.baseY + 2 * age + 2 * age * age; // buoyant rise
      s.fade.value = Math.pow(1 - u, 1.6);
      (s.fireball.userData.tint as { value: THREE.Color }).value.setHSL(0.07 - 0.25 * u, 1, 0.55 - 0.15 * u);
      s.core.scale.setScalar(s.radius * 0.35 * Math.max(0.05, 1 - age / 0.5));
      s.core.visible = age < 0.5;
      s.core.position.copy(s.fireball.position);
      // Shockwave: ~120 m/s outward along the ground, fading over 1.2 s.
      const ringAge = Math.min(age, 1.2);
      s.ring.scale.setScalar(2 + ringAge * 120);
      s.ringFade.value = Math.max(0, 1 - ringAge / 1.2);
      s.ring.visible = age < 1.2;
      s.light.intensity = 6e4 * Math.max(0, 1 - age / 0.8) ** 2;
    }
  }
}
