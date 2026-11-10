import * as THREE from 'three/webgpu';
import { abs, float, normalView, positionLocal, positionViewDirection, pow, smoothstep, uniform } from 'three/tsl';
import type { TslNode } from './neon.ts';

const SLOTS = 4;
const LIFE = 2.6;

interface Slot {
  shell: THREE.Mesh;
  core: THREE.Mesh;
  ring: THREE.Mesh;
  crown: THREE.Mesh;
  light: THREE.PointLight;
  tint: { value: THREE.Color };
  fade: { value: number };
  ringFade: { value: number };
  crownFade: { value: number };
  time: number;
  radius: number;
  speed: number;
  baseY: number;
}

/**
 * Derez (reads `sim.explosions`): a program's equivalent of death. Everything reflects the
 * vehicle's circuit colour: a brief white flash collapsing into a shell of its light, a ring
 * racing out along the Grid, and, for a fast-moving vehicle, an energy splash, a crown of light
 * that rises from the impact like liquid and dissipates. The voxels it shatters into are drawn by
 * ChipsView and stay on the Grid. Visual only; the physics happened in the simulation.
 */
export class ExplosionView {
  readonly root = new THREE.Group();
  private readonly slots: Slot[] = [];
  private seen = -Infinity;
  private next = 0;

  constructor(scene: THREE.Scene) {
    this.root.name = 'derez';
    const sphere = new THREE.IcosahedronGeometry(1, 2);
    const ringGeo = new THREE.RingGeometry(0.9, 1, 96).rotateX(-Math.PI / 2);
    // Splash crown: an open cylinder of unit height standing on its base, flaring outward at the top.
    const crownGeo = new THREE.CylinderGeometry(1.35, 0.6, 1, 48, 8, true).translate(0, 0.5, 0);
    for (let i = 0; i < SLOTS; i++) {
      const tint = uniform(new THREE.Color('#00eaff'));
      const fade = uniform(0);
      const ringFade = uniform(0);
      const crownFade = uniform(0);
      const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;
      const shellMat = new THREE.MeshBasicNodeMaterial(add);
      // A glowing shell of light (bright at the limb), in the circuit colour.
      const rim: TslNode = pow(float(1).sub(abs(normalView.dot(positionViewDirection))), 2);
      shellMat.colorNode = (tint as TslNode).mul(float(0.02).add(rim.mul(0.7))).mul(fade);
      const coreMat = new THREE.MeshBasicNodeMaterial(add);
      coreMat.colorNode = (tint as TslNode).mul(1.1).add(float(0.25)).mul(fade).mul(fade);
      const ringMat = new THREE.MeshBasicNodeMaterial({ ...add, side: THREE.DoubleSide });
      ringMat.colorNode = (tint as TslNode).mul(2.6).mul(ringFade);
      const crownMat = new THREE.MeshBasicNodeMaterial({ ...add, side: THREE.DoubleSide });
      // Brightest at the lip, thinning toward the base, like a splash sheet catching light.
      const lip: TslNode = smoothstep(0.2, 1, positionLocal.y);
      crownMat.colorNode = (tint as TslNode).mul(float(0.25).add(lip.mul(2.2))).mul(crownFade);
      const shell = new THREE.Mesh(sphere, shellMat);
      const core = new THREE.Mesh(sphere, coreMat);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      const crown = new THREE.Mesh(crownGeo, crownMat);
      const light = new THREE.PointLight('#00eaff', 0, 400, 1.6);
      for (const o of [shell, core, ring, crown, light]) {
        o.visible = false;
        o.frustumCulled = false;
        this.root.add(o);
      }
      this.slots.push({ shell, core, ring, crown, light, tint, fade, ringFade, crownFade, time: -Infinity, radius: 10, speed: 0, baseY: 0 });
    }
    scene.add(this.root);
  }

  /** Flush on reset. */
  clear(): void {
    for (const s of this.slots) {
      s.time = -Infinity;
      for (const o of [s.shell, s.core, s.ring, s.crown, s.light]) o.visible = false;
    }
  }

  update(time: number, explosions: ReadonlyArray<{ x: number; y: number; z: number; time: number; radius: number; color?: string; speed?: number }>): void {
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
      s.speed = e.speed ?? 0;
      s.baseY = e.y;
      s.tint.value.set(e.color ?? '#00eaff');
      s.light.color.set(e.color ?? '#00eaff');
      s.shell.position.set(e.x, e.y, e.z);
      s.core.position.set(e.x, e.y, e.z);
      s.light.position.set(e.x, e.y + 2, e.z);
      s.ring.position.set(e.x, Math.max(0.3, e.y - 1.5), e.z);
      s.crown.position.set(e.x, Math.max(0.05, e.y - 1.5), e.z);
    }
    for (const s of this.slots) {
      const age = time - s.time;
      const live = age >= 0 && age < LIFE;
      for (const o of [s.shell, s.core, s.ring, s.crown, s.light]) o.visible = live;
      if (!live) continue;
      // Flash and shell: a quick bloom of the circuit colour that collapses (derez is
      // dissolution, not a fireball).
      const grow = 1 - Math.pow(1 - Math.min(1, age / 0.35), 3);
      s.shell.scale.setScalar(s.radius * (0.2 + 0.55 * grow));
      s.fade.value = Math.max(0, 1 - age / 0.9) ** 1.5;
      s.shell.visible = age < 0.9;
      s.core.scale.setScalar(s.radius * 0.3 * Math.max(0.05, 1 - age / 0.4));
      s.core.visible = age < 0.4;
      // Ring racing out along the Grid.
      const ringAge = Math.min(age, 1.1);
      s.ring.scale.setScalar(2 + ringAge * 110);
      s.ringFade.value = Math.max(0, 1 - ringAge / 1.1);
      s.ring.visible = age < 1.1;
      // Energy splash: only for fast-moving vehicles; rises, flares, falls back and dissipates.
      const splash = s.speed > 20;
      s.crown.visible = splash;
      if (splash) {
        const h = Math.min(40, 6 + s.speed * 0.45);
        const rise = Math.sin(Math.min(Math.PI, (age / LIFE) * Math.PI * 1.1)); // up then down
        const width = 2 + age * (3 + s.speed * 0.08);
        s.crown.scale.set(width, Math.max(0.01, h * rise), width);
        s.crownFade.value = Math.max(0, 1 - age / LIFE) ** 1.2;
      }
      s.light.intensity = 2.5e4 * Math.max(0, 1 - age / 0.7) ** 2;
    }
  }
}
