import * as THREE from 'three/webgpu';
import { partQuaternion } from '../craft/massProperties.ts';
import type { CraftDef, Vec3Tuple } from '../craft/types.ts';
import { validateCraft } from '../craft/validate.ts';
import { geometryFor } from './CraftView.ts';
import { glow, neonFillMaterial, neonize, neonTint } from './neon.ts';

/**
 * Another player's craft, drawn from their CraftDef alone (no physics body): one neon primitive
 * per part like CraftView, wheels that spin with speed and props/rotor discs that glow with
 * throttle, plus a tall beacon line in the player's colour so they can be found from afar.
 * An invalid or hostile CraftDef is drawn as a plain marker box instead.
 */
export class RemoteCraftView {
  readonly root = new THREE.Group();
  private readonly fills: THREE.Material[] = [];
  private readonly wheels: Array<{ spin: THREE.Object3D; radius: number }> = [];
  private readonly discs: THREE.MeshBasicMaterial[] = [];
  private readonly beaconMat: THREE.LineBasicMaterial;
  /** Craft bounding radius (m), for the beacon height and proximity checks. */
  readonly radius: number;

  constructor(def: CraftDef, color: string) {
    const ok = validateCraft(def).length === 0;
    let radius = 2;
    if (ok) {
      for (const part of def.parts) {
        const geo = geometryFor(part.shape);
        const fill = neonFillMaterial(neonTint(part.color).multiplyScalar(0.035));
        this.fills.push(fill);
        const mesh = new THREE.Mesh(geo, fill);
        mesh.add(neonize(geo, neonTint(part.color)));
        mesh.position.set(...part.position);
        const q = partQuaternion(part);
        mesh.quaternion.copy(q);
        this.root.add(mesh);
        const s = part.shape;
        const half = s.type === 'box' ? Math.hypot(...s.size) / 2 : s.type === 'sphere' ? s.radius : Math.max(s.radius, s.length / 2);
        radius = Math.max(radius, Math.hypot(...part.position) + half);
        for (const m of part.modules ?? []) {
          const at = new THREE.Vector3(...((m as { offset?: Vec3Tuple }).offset ?? [0, 0, 0])).applyQuaternion(q).add(mesh.position);
          if (m.type === 'wheel') this.addWheel(at, q, m.radius, m.restLength);
          else if (m.type === 'engine' && m.propRadius) this.addDisc(at, q, m.propRadius, false, color);
          else if (m.type === 'rotor') this.addDisc(at, q, m.radius, true, color);
        }
      }
    } else {
      const geo = new THREE.BoxGeometry(2, 1, 4);
      const fill = neonFillMaterial(neonTint(color).multiplyScalar(0.035));
      this.fills.push(fill);
      const mesh = new THREE.Mesh(geo, fill);
      mesh.add(neonize(geo, neonTint(color)));
      this.root.add(mesh);
    }
    this.radius = radius;
    // Beacon: a thin vertical line of the player's colour above the craft.
    const h = 40 + radius * 4;
    const beaconGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, radius + 1, 0, 0, radius + 1 + h, 0], 3));
    this.beaconMat = new THREE.LineBasicMaterial({ color: glow(color, 2.4), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
    const beacon = new THREE.LineSegments(beaconGeo, this.beaconMat);
    beacon.frustumCulled = false;
    // The beacon stays upright in the world (the craft root rotates; see update).
    beacon.name = 'beacon';
    this.root.add(beacon);
  }

  private addWheel(at: THREE.Vector3, q: THREE.Quaternion, r: number, rest: number): void {
    const frame = new THREE.Group();
    frame.position.copy(at).add(new THREE.Vector3(0, -rest * 0.8, 0).applyQuaternion(q));
    frame.quaternion.copy(q);
    const spin = new THREE.Group();
    frame.add(spin);
    const geo = new THREE.CylinderGeometry(r, r, r * 0.6, 12).rotateZ(Math.PI / 2);
    const fill = neonFillMaterial(neonTint('#ff2bd6').multiplyScalar(0.035));
    this.fills.push(fill);
    const tyre = new THREE.Mesh(geo, fill);
    tyre.add(neonize(geo, neonTint('#ff2bd6')));
    spin.add(tyre);
    this.root.add(frame);
    this.wheels.push({ spin, radius: r });
  }

  private addDisc(at: THREE.Vector3, q: THREE.Quaternion, r: number, horizontal: boolean, color: string): void {
    const m = new THREE.MeshBasicMaterial({ color: glow(color, 1.4), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    this.discs.push(m);
    const geo = new THREE.CircleGeometry(r, 32);
    if (horizontal) geo.rotateX(-Math.PI / 2);
    const disc = new THREE.Mesh(geo, m);
    disc.position.copy(at);
    disc.quaternion.copy(q);
    this.root.add(disc);
  }

  private readonly _inv = new THREE.Quaternion();
  /** Place at an (interpolated) pose; `speed` (m/s) spins the wheels, `throttle` lights the discs. */
  update(position: THREE.Vector3, rotation: THREE.Quaternion, speed: number, throttle: number, dt: number): void {
    this.root.position.copy(position);
    this.root.quaternion.copy(rotation);
    for (const w of this.wheels) w.spin.rotation.x -= (speed / Math.max(0.05, w.radius)) * dt;
    for (const d of this.discs) d.opacity = Math.min(0.25, throttle * 0.35);
    const beacon = this.root.getObjectByName('beacon');
    if (beacon) beacon.quaternion.copy(this._inv.copy(rotation).invert());
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
    });
    for (const m of this.fills) m.dispose();
    for (const m of this.discs) m.dispose();
    this.beaconMat.dispose();
  }
}
