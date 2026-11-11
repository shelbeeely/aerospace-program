import * as THREE from 'three/webgpu';
import { partQuaternion } from '../craft/massProperties.ts';
import type { CraftDef, Vec3Tuple } from '../craft/types.ts';
import { validateCraft } from '../craft/validate.ts';
import { edgeColor, fillColor, geometryFor } from './CraftView.ts';
import { style1982 } from '../craft/style1982.ts';
import { glow, neonFillMaterial, neonize, neonTint } from './neon.ts';
import { buildGrammar, driveGrammarLights, type GrammarModel } from './VehicleGrammarView.ts';
import { turretOf, turretQuaternions, type TurretPose } from '../craft/turret.ts';

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
  private grammar: GrammarModel | null = null;
  /** Craft bounding radius (m), for the beacon height and proximity checks. */
  readonly radius: number;

  /** Everything drawn per part (for turret rigging). */
  private readonly partObjects = new Map<string, THREE.Object3D[]>();
  private turretYaw: THREE.Group | null = null;
  private turretPitch: THREE.Group | null = null;

  constructor(def: CraftDef, color: string, opts: { beacon?: boolean } = {}) {
    const ok = validateCraft(def).length === 0;
    // The same 1982 palette and body/light edges as the player's craft.
    if (ok) def = style1982(def);
    let radius = 2;
    if (ok) {
      for (const part of def.parts) {
        const geo = geometryFor(part.shape);
        const fill = neonFillMaterial(fillColor(part.color));
        this.fills.push(fill);
        const mesh = new THREE.Mesh(geo, fill);
        mesh.add(neonize(geo, edgeColor(part.color)));
        mesh.position.set(...part.position);
        const q = partQuaternion(part);
        mesh.quaternion.copy(q);
        this.root.add(mesh);
        this.partObjects.set(part.id, [mesh]);
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
      // The vehicle grammar's detail, lights steady (no engine state for a remote craft).
      this.grammar = buildGrammar(def, this.root);
      for (const [id, objs] of this.grammar.byPart) this.partObjects.set(id, [...(this.partObjects.get(id) ?? []), ...objs]);
      this.setLightState({ activity: 1, integrity: 1, time: 0 });
      this.rigTurret(def);
    } else {
      const geo = new THREE.BoxGeometry(2, 1, 4);
      const fill = neonFillMaterial(neonTint(color).multiplyScalar(0.035));
      this.fills.push(fill);
      const mesh = new THREE.Mesh(geo, fill);
      mesh.add(neonize(geo, neonTint(color)));
      this.root.add(mesh);
    }
    this.radius = radius;
    // Beacon: a thin vertical line of the player's colour above the craft (players, not AI traffic).
    const h = opts.beacon === false ? 0 : 40 + radius * 4;
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

  /**
   * The lights' state (AGENTS.md §5): `activity` 0 = idle (dim) to 1 = active (full), and
   * `integrity` below 1 = damaged (they flicker, the more the worse it is).
   */
  setLightState(s: { activity: number; integrity: number; time: number }): void {
    if (!this.grammar) return;
    driveGrammarLights(this.grammar, {
      activity: s.activity, time: s.time, integrity: () => s.integrity,
      engine: () => ({ spool: 0.5 + 0.3 * s.activity, afterburner: 0 }),
    });
  }

  /**
   * A craft with a turret part: its parts (and their grammar detail) move into a group that
   * traverses about the turret's pivot, and the barrels into one inside it that elevates about
   * the trunnion (as CraftView does for the player's craft).
   */
  private rigTurret(def: CraftDef): void {
    const rig = turretOf(def);
    if (!rig) return;
    const yaw = (this.turretYaw = new THREE.Group());
    yaw.position.copy(rig.pivot);
    const pitch = (this.turretPitch = new THREE.Group());
    pitch.position.copy(rig.trunnion).sub(rig.pivot);
    yaw.add(pitch);
    this.root.add(yaw);
    for (const [id, objs] of this.partObjects) {
      if (!rig.riders.has(id)) continue;
      const elevates = rig.barrels.has(id);
      for (const o of objs) {
        if (o.parent !== this.root) continue;
        o.removeFromParent();
        o.position.sub(elevates ? rig.trunnion : rig.pivot);
        (elevates ? pitch : yaw).add(o);
      }
    }
  }

  /** Point the turret (no-op for a craft without one). */
  setTurret(pose: TurretPose): void {
    if (this.turretYaw && this.turretPitch) turretQuaternions(pose, this.turretYaw.quaternion, this.turretPitch.quaternion);
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
