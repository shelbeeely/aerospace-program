import * as THREE from 'three/webgpu';
import { neonFillMaterial, neonTint, neonize } from './neon.ts';

/**
 * Charges set down by hand (the player's, and Bit sappers'): a squat dark octahedral casing on a
 * low plinth, with a ring of light round its waist that pulses faster as the fuse runs down (red
 * for a nuke, white for an EMP, amber for a sapper's demolition charge). Light that says what it
 * is doing (§5); the casing stays unlit.
 */
export const CHARGE_LIGHT: Record<string, string> = { nuke: '#ff2a12', emp: '#dff6ff', demo: '#ffb347' };
export class ChargesView {
  private readonly root = new THREE.Group();
  private readonly items: Array<{ g: THREE.Group; ring: THREE.MeshBasicNodeMaterial; key: object }> = [];
  private readonly casing = new THREE.OctahedronGeometry(0.9, 0).scale(1, 0.8, 1);
  private readonly plinth = new THREE.CylinderGeometry(1.1, 1.3, 0.3, 8);
  private readonly band = new THREE.TorusGeometry(0.95, 0.07, 6, 24).rotateX(Math.PI / 2);
  private readonly fill = neonFillMaterial(new THREE.Color('#0b1a33'));

  constructor(scene: THREE.Scene) {
    this.root.name = 'charges';
    scene.add(this.root);
  }

  update(time: number, charges: ReadonlyArray<{ kind: string; x: number; y: number; z: number; setAt: number; fuse: number }>): void {
    // Drop views of charges that are gone, add views for new ones.
    for (let i = this.items.length - 1; i >= 0; i--) if (!charges.includes(this.items[i].key as never)) {
      this.items[i].g.removeFromParent();
      this.items[i].ring.dispose();
      this.items.splice(i, 1);
    }
    for (const c of charges) {
      let it = this.items.find((x) => x.key === c);
      if (!it) {
        const g = new THREE.Group();
        const color = CHARGE_LIGHT[c.kind] ?? '#dff6ff';
        const p = new THREE.Mesh(this.plinth, this.fill);
        p.position.y = 0.15;
        const body = new THREE.Mesh(this.casing, this.fill);
        body.position.y = 1.0;
        body.add(neonize(this.casing, neonTint(color).multiplyScalar(0.25), { thresholdAngle: 10 }));
        const ring = new THREE.MeshBasicNodeMaterial({ color: neonTint(color).multiplyScalar(2) });
        const band = new THREE.Mesh(this.band, ring);
        band.position.y = 1.0;
        g.add(p, body, band);
        g.position.set(c.x, c.y, c.z);
        this.root.add(g);
        it = { g, ring, key: c };
        this.items.push(it);
      }
      // Pulse: once every two seconds at first, five times a second in the last ten.
      const left = Math.max(0, c.setAt + c.fuse - time);
      const rate = left < 10 ? 5 : left < 30 ? 1.5 : 0.5;
      const on = Math.sin(time * rate * Math.PI * 2) > 0;
      it.ring.color.copy(neonTint(CHARGE_LIGHT[c.kind] ?? '#dff6ff').multiplyScalar(on ? 2.4 : 0.35));
    }
  }
}
