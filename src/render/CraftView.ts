import * as THREE from 'three/webgpu';
import { isBodyColor } from '../craft/style1982.ts';
import { axisRotation } from '../craft/Craft.ts';
import { abs, float, max, min, positionLocal, smoothstep } from 'three/tsl';
import type { Craft } from '../craft/Craft.ts';
import { partQuaternion } from '../craft/massProperties.ts';
import type { ShapeDef } from '../craft/types.ts';
import type { PartVoxels } from '../craft/voxels.ts';
import { AeroSurface } from '../modules/AeroSurface.ts';
import { Engine } from '../modules/Engine.ts';
import { Rotor } from '../modules/Rotor.ts';
import { Wheel } from '../modules/Wheel.ts';
import { Chute } from '../modules/Airbrake.ts';
import { NEON, glow, neonFillMaterial, neonize, neonTint, type TslNode } from './neon.ts';

export function geometryFor(shape: ShapeDef): THREE.BufferGeometry {
  switch (shape.type) {
    case 'box':
      return new THREE.BoxGeometry(...shape.size);
    case 'sphere':
      // Low-poly on purpose: every facet edge is drawn as a neon line.
      return new THREE.SphereGeometry(shape.radius, 12, 8);
    case 'cylinder': {
      const g = new THREE.CylinderGeometry(shape.radius, shape.radius, shape.length, 12);
      if (shape.axis === 'x') g.rotateZ(Math.PI / 2);
      if (shape.axis === 'z') g.rotateX(Math.PI / 2);
      return g;
    }
    case 'cone':
    case 'capsule': {
      // Same frame as the collider: built along +Y (a cone's apex at +Y), then onto its axis.
      const g = shape.type === 'cone'
        ? new THREE.ConeGeometry(shape.radius, shape.length, 12)
        : new THREE.CapsuleGeometry(shape.radius, Math.max(0.001, shape.length - 2 * shape.radius), 3, 12);
      g.applyQuaternion(axisRotation(shape.axis ?? 'y', shape.type === 'cone' ? (shape.tip ?? -1) : 1));
      return g;
    }
  }
}

/**
 * Fill colour for a part (1982 rules: large unlit surfaces, selective light): a body part shows
 * its dark navy / steel surface; a light part (accent strip, canopy, nozzle) glows in its colour.
 */
function fillColor(color: string): THREE.Color {
  return isBodyColor(color) ? new THREE.Color(color).multiplyScalar(0.55) : neonTint(color).multiplyScalar(0.35);
}

/** Edge colour: dim structural seams on body parts; only light parts carry bright edges. */
function edgeColor(color: string): THREE.Color {
  return isBodyColor(color) ? neonTint(color).multiplyScalar(0.22) : neonTint(color);
}

interface Animated {
  update(): void;
}

/** Voxel cubes with glowing edges (×instance colour): damaged parts are drawn voxel by voxel. */
function voxelMaterial(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  const p: TslNode = abs(positionLocal).mul(2);
  const a: TslNode = smoothstep(0.8, 0.98, p.x);
  const b: TslNode = smoothstep(0.8, 0.98, p.y);
  const c: TslNode = smoothstep(0.8, 0.98, p.z);
  mat.colorNode = float(0.05).add(max(max(min(a, b), min(b, c)), min(a, c)).mul(2.2)) as TslNode;
  return mat;
}

/** A part drawn as its surviving voxels once it has taken damage. */
interface VoxelPart {
  partId: string;
  voxels: PartVoxels;
  solid: THREE.Mesh;
  mesh: THREE.InstancedMesh | null;
  seen: number;
  color: THREE.Color;
}

/**
 * Visual representation of a Craft built from the same data: one primitive per part, plus
 * moving bits driven by module state (flaps, prop, wheels/suspension). Neon style: near-black
 * fills with glowing edges in each part's colour.
 */
export class CraftView {
  readonly root = new THREE.Group();
  private readonly animated: Animated[] = [];
  private readonly materials = new Map<string, THREE.MeshStandardNodeMaterial>();
  private readonly discMats: THREE.Material[] = [];
  /** Everything drawn for each part (its mesh and its modules' moving bits), for break-offs. */
  private readonly partObjects = new Map<string, THREE.Object3D[]>();
  /** The craft this view was built for. */
  readonly craft: Craft;
  private readonly voxelParts: VoxelPart[] = [];
  private voxelMat: THREE.MeshBasicNodeMaterial | null = null;
  private static readonly cube = new THREE.BoxGeometry(1, 1, 1);

  constructor(craft: Craft) {
    this.craft = craft;
    for (const part of craft.def.parts) {
      const mesh = this.neonPart(geometryFor(part.shape), part.color);
      mesh.position.set(...part.position);
      mesh.quaternion.copy(partQuaternion(part));
      this.root.add(mesh);
      this.track(part.id, mesh);
      const voxels = craft.voxels.get(part.id);
      if (voxels) this.voxelParts.push({ partId: part.id, voxels, solid: mesh, mesh: null, seen: 0, color: neonTint(part.color).multiplyScalar(1.3) });
    }
    for (const m of craft.modules) {
      if (m instanceof AeroSurface && m.def.control) this.addFlap(m);
      else if (m instanceof Engine) this.addProp(m);
      else if (m instanceof Wheel) this.addWheel(m);
      else if (m instanceof Rotor) this.addRotor(m);
      else if (m instanceof Chute) this.addChute(m);
    }
    this.hideParts(craft.detached);
  }

  private track(partId: string, o: THREE.Object3D): void {
    const list = this.partObjects.get(partId) ?? [];
    list.push(o);
    this.partObjects.set(partId, list);
  }

  /** Hide parts that broke off (the debris view draws them from then on). */
  hideParts(ids: Iterable<string>): void {
    for (const id of ids) for (const o of this.partObjects.get(id) ?? []) o.visible = false;
  }

  /** Dark fill for parts of this colour (keyed by colour). */
  private material(color: string): THREE.MeshStandardNodeMaterial {
    let m = this.materials.get(color);
    if (!m) {
      m = neonFillMaterial(fillColor(color));
      this.materials.set(color, m);
    }
    return m;
  }

  /** A dark-filled mesh with neon edges in the (saturated) part colour. */
  private neonPart(geo: THREE.BufferGeometry, color: string): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, this.material(color));
    mesh.add(neonize(geo, edgeColor(color)));
    return mesh;
  }

  /** Motion-blur disc for a spinning prop/rotor: additive neon haze, opacity animated. */
  private disc(color: string, side: THREE.Side): THREE.MeshBasicNodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial({
      color: glow(color, 1.4),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side,
      blending: THREE.AdditiveBlending,
    });
    this.discMats.push(m);
    return m;
  }

  private moduleFrame(m: { partId: string; localPosition: THREE.Vector3; localRotation: THREE.Quaternion }): THREE.Group {
    const g = new THREE.Group();
    g.position.copy(m.localPosition);
    g.quaternion.copy(m.localRotation);
    this.root.add(g);
    this.track(m.partId, g);
    return g;
  }

  private addRotor(r: Rotor): void {
    const frame = this.moduleFrame(r);
    const hub = new THREE.Group();
    frame.add(hub);
    const R = r.def.radius;
    for (let i = 0; i < r.def.blades; i++) {
      const arm = new THREE.Group();
      arm.rotation.y = (i / r.def.blades) * Math.PI * 2;
      const blade = this.neonPart(new THREE.BoxGeometry(R * 0.92, Math.max(0.01, R * 0.012), Math.max(0.02, r.def.chord)), NEON.purple);
      blade.position.x = R * 0.5;
      arm.add(blade);
      hub.add(arm);
    }
    // Motion-blurred disc, fades in with rotor speed.
    const discMat = this.disc(NEON.purple, THREE.DoubleSide);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 40).rotateX(-Math.PI / 2), discMat);
    frame.add(disc);
    const tilt = (r.def.cyclicDeg ?? 0) * (Math.PI / 180);
    this.animated.push({
      update: () => {
        const speed = r.omega / Math.max(1, r.maxOmega);
        hub.rotation.y = r.angle;
        hub.visible = speed < 0.6;
        discMat.opacity = Math.min(0.22, speed * 0.3);
        // Show the cyclic tilt of the disk.
        frame.children.forEach((c) => c.rotation.set(r.cyclicPitch * tilt, c === hub ? r.angle : 0, -r.cyclicRoll * tilt));
      },
    });
  }

  private addFlap(s: AeroSurface): void {
    const ctrl = s.def.control!;
    const flapChord = s.def.chord * (ctrl.chordFraction ?? 0.3);
    const flapSpan = s.def.span * (ctrl.spanFraction ?? 1);
    const frame = this.moduleFrame(s);
    const hinge = new THREE.Group();
    // Trailing edge is at +Z (chord points to -Z). Hinge sits flapChord ahead of it.
    hinge.position.set(s.outerSign * (s.def.span - flapSpan) * 0.5, 0, s.def.chord / 2 - flapChord);
    frame.add(hinge);
    const flap = this.neonPart(new THREE.BoxGeometry(flapSpan * 0.98, 0.09, flapChord), NEON.orange);
    flap.position.set(0, 0, flapChord / 2);
    hinge.add(flap);
    // Positive deflection = trailing edge toward -normal (more lift) = +X rotation.
    this.animated.push({ update: () => (hinge.rotation.x = s.deflection) });
  }

  private addProp(e: Engine): void {
    const frame = this.moduleFrame(e);
    const r = e.def.propRadius ?? 0.8;
    const spinner = this.neonPart(new THREE.ConeGeometry(0.18, 0.4, 8), NEON.cyan);
    spinner.rotation.x = -Math.PI / 2;
    spinner.position.z = -0.15;
    frame.add(spinner);
    const hub = new THREE.Group();
    frame.add(hub);
    for (let i = 0; i < 2; i++) {
      const blade = this.neonPart(new THREE.BoxGeometry(0.12, r, 0.03), NEON.purple);
      blade.position.y = r / 2;
      const arm = new THREE.Group();
      arm.rotation.z = i * Math.PI;
      arm.add(blade);
      hub.add(arm);
    }
    // Blurred disc that fades in with RPM.
    const discMat = this.disc(NEON.cyan, THREE.FrontSide);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 32), discMat);
    frame.add(disc);
    this.animated.push({
      update: () => {
        hub.rotation.z = -e.propAngle;
        discMat.opacity = Math.min(0.25, e.spool * 0.45);
        hub.visible = e.spool < 0.5;
      },
    });
  }

  private addWheel(w: Wheel): void {
    const frame = this.moduleFrame(w);
    const strut = this.neonPart(new THREE.CylinderGeometry(0.04, 0.04, 1, 6), '#888888');
    frame.add(strut);
    const steer = new THREE.Group();
    frame.add(steer);
    const spin = new THREE.Group();
    steer.add(spin);
    const tyre = this.neonPart(
      new THREE.CylinderGeometry(w.def.radius, w.def.radius, w.def.radius * 0.6, 12).rotateZ(Math.PI / 2),
      NEON.magenta,
    );
    spin.add(tyre);
    const hubcap = this.neonPart(new THREE.BoxGeometry(w.def.radius * 0.65, w.def.radius * 0.5, w.def.radius * 0.5), NEON.cyan);
    spin.add(hubcap);
    this.animated.push({
      update: () => {
        const len = w.suspensionLength;
        steer.position.set(0, -len, 0);
        steer.rotation.y = -w.steerAngle;
        spin.rotation.x = -w.spinAngle;
        strut.scale.y = Math.max(0.01, len);
        strut.position.y = -len / 2;
      },
    });
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
    });
    for (const m of this.materials.values()) m.dispose();
    for (const m of this.discMats) m.dispose();
    this.voxelMat?.dispose();
  }

  /** Place the craft at an (interpolated) pose and animate moving parts. */
  /**
   * A drag chute: a canopy (open cone, edges lit in the craft's circuit colour) with shroud lines,
   * streaming behind its pack point, growing as it opens; hidden while packed or once cut away.
   */
  private readonly chutes: Array<{ m: Chute; g: THREE.Group }> = [];
  private addChute(m: Chute): void {
    const r = Math.sqrt(m.def.cdA / (Math.PI * 1.4)); // canopy radius from Cd ≈ 1.4
    const g = new THREE.Group();
    const canopy = new THREE.ConeGeometry(r, r * 0.9, 16, 1, true).rotateX(-Math.PI / 2); // mouth toward the craft
    const accent = this.craft.def.parts.find((p) => !isBodyColor(p.color))?.color ?? '#00d4ff';
    const mesh = this.neonPart(canopy, accent);
    mesh.position.z = r * 3 + r * 0.45;
    const lines = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return [new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, r * 3)];
      }).flat(),
    );
    g.add(mesh, new THREE.LineSegments(lines, new THREE.LineBasicNodeMaterial({ color: neonTint(accent).multiplyScalar(0.6) })));
    g.position.copy(m.localPosition);
    g.visible = false;
    this.root.add(g);
    this.track(m.partId, g);
    this.chutes.push({ m, g });
  }

  update(position: THREE.Vector3, rotation: THREE.Quaternion): void {
    this.root.position.copy(position);
    this.root.quaternion.copy(rotation);
    for (const { m, g } of this.chutes) {
      g.visible = m.state === 'deployed' && m.open > 0.02;
      if (g.visible) g.scale.setScalar(0.2 + 0.8 * m.open);
    }
    for (const a of this.animated) a.update();
    for (const v of this.voxelParts) if (v.voxels.version !== v.seen) this.rebuildVoxels(v);
  }

  /**
   * A part took a bite: swap its smooth mesh for its surviving voxels (surface voxels only;
   * the inside can't be seen). Rebuilt only when the part's voxels change.
   */
  private rebuildVoxels(v: VoxelPart): void {
    v.seen = v.voxels.version;
    if (this.craft.detached.has(v.partId)) return;
    const vox = v.voxels;
    if (!v.mesh) {
      this.voxelMat ??= voxelMaterial();
      v.mesh = new THREE.InstancedMesh(CraftView.cube, this.voxelMat, Math.max(1, vox.aliveCount));
      v.mesh.position.copy(v.solid.position);
      v.mesh.quaternion.copy(v.solid.quaternion);
      v.mesh.frustumCulled = false;
      this.root.add(v.mesh);
      this.track(v.partId, v.mesh);
    }
    v.solid.visible = false;
    const [W, H, D] = vox.grid;
    const alive = (x: number, y: number, z: number) =>
      x >= 0 && y >= 0 && z >= 0 && x < W && y < H && z < D && vox.alive[(y * D + z) * W + x] === 1;
    const m = new THREE.Matrix4();
    const s = vox.cell * 0.97;
    let n = 0;
    const cap = v.mesh.instanceMatrix.count;
    for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      if (!alive(x, y, z)) continue;
      if (alive(x - 1, y, z) && alive(x + 1, y, z) && alive(x, y - 1, z) && alive(x, y + 1, z) && alive(x, y, z - 1) && alive(x, y, z + 1)) continue;
      if (n >= cap) break;
      const [px, py, pz] = vox.centre(x, y, z);
      m.makeScale(s, s, s).setPosition(px, py, pz);
      v.mesh.setMatrixAt(n, m);
      v.mesh.setColorAt(n, v.color);
      n++;
    }
    v.mesh.count = n;
    v.mesh.instanceMatrix.needsUpdate = true;
    if (v.mesh.instanceColor) v.mesh.instanceColor.needsUpdate = true;
  }
}
