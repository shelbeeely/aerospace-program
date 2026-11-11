import * as THREE from 'three/webgpu';
import type { StrategicBlast } from '../sim/strategic.ts';
import { STRATEGIC } from '../sim/strategic.ts';
import { glow } from './neon.ts';

/**
 * Strategic detonations (reads `sim.blasts`), in the 1982 language: geometry and light, not
 * smoke. A nuke: a white flash, a pale fireball of light edges swelling to the fireball radius,
 * a column of stacked rings rising and spreading into a flat disc, and a ring of light racing
 * out along the Grid to the shock radius. An EMP: a blue-white shell of lattice lines expanding
 * to its radius, with a ring along the ground. Additive, few draw calls, a handful at once.
 */

const SLOTS = 3;
const NUKE_LIFE = 18;
const EMP_LIFE = 3;

interface Slot {
  root: THREE.Group;
  flash: THREE.Mesh;
  shell: THREE.Mesh;
  lattice: THREE.LineSegments;
  ground: THREE.Mesh;
  rings: THREE.Mesh[];
  disc: THREE.Mesh;
  mats: Array<THREE.MeshBasicMaterial | THREE.LineBasicMaterial>;
  blast: StrategicBlast | null;
}

const additive = (color: THREE.ColorRepresentation, k: number, side: THREE.Side = THREE.FrontSide) =>
  new THREE.MeshBasicMaterial({ color: glow(color, k), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side });

export class StrategicView {
  readonly root = new THREE.Group();
  private readonly slots: Slot[] = [];
  private readonly seen = new Set<StrategicBlast>();
  private next = 0;

  constructor(scene: THREE.Scene) {
    this.root.name = 'strategic';
    const sphere = new THREE.IcosahedronGeometry(1, 3);
    const lattice = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1, 2));
    const ringGeo = new THREE.RingGeometry(0.93, 1, 128).rotateX(-Math.PI / 2);
    const torus = new THREE.TorusGeometry(1, 0.06, 6, 64).rotateX(Math.PI / 2);
    for (let i = 0; i < SLOTS; i++) {
      const root = new THREE.Group();
      root.visible = false;
      const flash = new THREE.Mesh(sphere, additive('#ffffff', 2.5, THREE.BackSide));
      const shell = new THREE.Mesh(sphere, additive('#dff6ff', 1.2));
      const latMat = new THREE.LineBasicMaterial({ color: glow('#dff6ff', 1.8), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const lat = new THREE.LineSegments(lattice, latMat);
      const ground = new THREE.Mesh(ringGeo, additive('#dff6ff', 2, THREE.DoubleSide));
      const rings: THREE.Mesh[] = [];
      const ringMat = additive('#ffb000', 1.6, THREE.DoubleSide);
      for (let k = 0; k < 7; k++) {
        const r = new THREE.Mesh(torus, ringMat);
        rings.push(r);
        root.add(r);
      }
      const disc = new THREE.Mesh(torus, additive('#ffb000', 1.4, THREE.DoubleSide));
      root.add(flash, shell, lat, ground, disc);
      for (const o of [flash, shell, lat, ground, disc, ...rings]) o.frustumCulled = false;
      this.root.add(root);
      this.slots.push({ root, flash, shell, lattice: lat, ground, rings, disc, mats: [flash.material as THREE.MeshBasicMaterial, shell.material as THREE.MeshBasicMaterial, latMat, ground.material as THREE.MeshBasicMaterial, ringMat, disc.material as THREE.MeshBasicMaterial], blast: null });
    }
    scene.add(this.root);
  }

  update(time: number, blasts: readonly StrategicBlast[]): void {
    for (const b of blasts) {
      if (this.seen.has(b)) continue;
      this.seen.add(b);
      const s = this.slots[this.next++ % SLOTS];
      s.blast = b;
      s.root.position.set(b.x, b.y, b.z);
      s.root.visible = true;
      const tint = b.kind === 'nuke' ? '#dff6ff' : '#9fd8ff';
      (s.shell.material as THREE.MeshBasicMaterial).color.copy(glow(tint, b.kind === 'nuke' ? 1.2 : 0.35));
      (s.lattice.material as THREE.LineBasicMaterial).color.copy(glow(tint, 1.8));
      (s.ground.material as THREE.MeshBasicMaterial).color.copy(glow(tint, 2));
    }
    if (this.seen.size > 64) for (const b of [...this.seen]) if (!blasts.includes(b)) this.seen.delete(b);
    for (const s of this.slots) {
      const b = s.blast;
      if (!b) continue;
      const age = time - b.time;
      const life = b.kind === 'nuke' ? NUKE_LIFE : EMP_LIFE;
      if (age < 0 || age > life) {
        s.root.visible = false;
        s.blast = null;
        continue;
      }
      const [flashM, shellM, latM, groundM, ringM, discM] = s.mats;
      const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
      if (b.kind === 'nuke') {
        const { fireball: F, shock: S } = STRATEGIC.nuke;
        // The flash: a blinding sphere for half a second.
        s.flash.scale.setScalar(F * 1.6);
        flashM.opacity = Math.max(0, 1 - age / 0.5) * 0.9;
        // The fireball swells to its radius in 1.5 s, then dims over the next ten.
        s.shell.scale.setScalar(F * ease(age / 1.5));
        shellM.opacity = 0.35 * Math.max(0, 1 - Math.max(0, age - 1.5) / 10);
        s.lattice.scale.copy(s.shell.scale);
        latM.opacity = 0.8 * Math.max(0, 1 - Math.max(0, age - 1) / 9);
        // The ring of light races out along the ground to the shock radius in 4 s.
        s.ground.position.y = -Math.max(0, b.y - 2) + 1;
        s.ground.scale.setScalar(Math.max(1, S * ease(age / 4)));
        groundM.opacity = 0.9 * Math.max(0, 1 - age / 6);
        // The column: stacked rings rising, narrowing, then a flat disc spreading on top.
        const top = 1200 * ease(age / 9);
        s.rings.forEach((r, k) => {
          const f = (k + 1) / s.rings.length;
          r.position.y = top * f * 0.92;
          r.scale.setScalar(F * (0.35 + 0.25 * (1 - f)) * ease(age / 2));
        });
        ringM.opacity = 0.6 * Math.min(1, age / 1.5) * Math.max(0, 1 - Math.max(0, age - 8) / 10);
        s.disc.position.y = top;
        s.disc.scale.setScalar(F * (0.6 + 1.4 * ease((age - 2) / 10)));
        discM.opacity = 0.7 * Math.min(1, Math.max(0, age - 1) / 2) * Math.max(0, 1 - Math.max(0, age - 9) / 9);
      } else {
        const R = STRATEGIC.emp.radius;
        s.flash.scale.setScalar(60);
        flashM.opacity = Math.max(0, 1 - age / 0.25) * 0.8;
        s.shell.scale.setScalar(R * ease(age / 1.2));
        shellM.opacity = 0.25 * Math.max(0, 1 - age / EMP_LIFE);
        s.lattice.scale.copy(s.shell.scale);
        s.lattice.rotation.y = age * 0.4;
        latM.opacity = 0.9 * Math.max(0, 1 - age / EMP_LIFE);
        s.ground.position.y = -Math.max(0, b.y - 2) + 1;
        s.ground.scale.setScalar(Math.max(1, R * ease(age / 1.2)));
        groundM.opacity = 0.8 * Math.max(0, 1 - age / EMP_LIFE);
        ringM.opacity = discM.opacity = 0;
      }
    }
  }
}
