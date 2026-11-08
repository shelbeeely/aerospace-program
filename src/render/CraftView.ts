import * as THREE from 'three/webgpu';
import type { Craft } from '../craft/Craft.ts';
import { partQuaternion } from '../craft/massProperties.ts';
import type { ShapeDef } from '../craft/types.ts';
import { AeroSurface } from '../modules/AeroSurface.ts';
import { Engine } from '../modules/Engine.ts';
import { Rotor } from '../modules/Rotor.ts';
import { Wheel } from '../modules/Wheel.ts';
import { NEON, glow, neonFillMaterial, neonize, neonTint } from './neon.ts';

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
  }
}

/** Fill colour for a part: a whisper of its hue on black; lifted when a livery is shown on it. */
function fillColor(color: string, livery: boolean): THREE.Color {
  const tint = neonTint(color);
  return livery ? tint.lerp(new THREE.Color('#ffffff'), 0.6).multiplyScalar(0.28) : tint.multiplyScalar(0.035);
}

interface Animated {
  update(): void;
}

/**
 * Visual representation of a Craft built from the same data: one primitive per part, plus
 * moving bits driven by module state (flaps, prop, wheels/suspension). Neon style: near-black
 * fills (a livery shows faintly on them) with glowing edges in each part's colour.
 */
export class CraftView {
  readonly root = new THREE.Group();
  private readonly animated: Animated[] = [];
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private livery: THREE.Texture | null = null;
  private readonly discMats: THREE.Material[] = [];
  /** Everything drawn for each part (its mesh and its modules' moving bits), for break-offs. */
  private readonly partObjects = new Map<string, THREE.Object3D[]>();
  /** The craft this view was built for. */
  readonly craft: Craft;

  constructor(craft: Craft) {
    this.craft = craft;
    for (const part of craft.def.parts) {
      const mesh = this.neonPart(geometryFor(part.shape), part.color);
      mesh.position.set(...part.position);
      mesh.quaternion.copy(partQuaternion(part));
      this.root.add(mesh);
      this.track(part.id, mesh);
    }
    for (const m of craft.modules) {
      if (m instanceof AeroSurface && m.def.control) this.addFlap(m);
      else if (m instanceof Engine) this.addProp(m);
      else if (m instanceof Wheel) this.addWheel(m);
      else if (m instanceof Rotor) this.addRotor(m);
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

  /** Dark fill for parts of this colour (keyed by colour so a livery can tint per part). */
  private material(color: string): THREE.MeshStandardMaterial {
    let m = this.materials.get(color);
    if (!m) {
      m = neonFillMaterial(fillColor(color, false));
      this.materials.set(color, m);
    }
    return m;
  }

  /** A dark-filled mesh with neon edges in the (saturated) part colour. */
  private neonPart(geo: THREE.BufferGeometry, color: string): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, this.material(color));
    mesh.add(neonize(geo, neonTint(color)));
    mesh.castShadow = true;
    return mesh;
  }

  /** Motion-blur disc for a spinning prop/rotor: additive neon haze, opacity animated. */
  private disc(color: string, side: THREE.Side): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({
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

  /**
   * Apply a generated livery texture (data URL) to every part's fill, dimmed so the neon edges
   * stay dominant, or remove it with null.
   */
  setLivery(url: string | null): void {
    this.livery?.dispose();
    this.livery = null;
    const tex = url ? new THREE.TextureLoader().load(url) : null;
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      this.livery = tex;
    }
    for (const [color, m] of this.materials) {
      m.map = tex;
      m.color.copy(fillColor(color, !!tex));
      m.needsUpdate = true;
    }
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
    });
    for (const m of this.materials.values()) m.dispose();
    for (const m of this.discMats) m.dispose();
    this.livery?.dispose();
  }

  /** Place the craft at an (interpolated) pose and animate moving parts. */
  update(position: THREE.Vector3, rotation: THREE.Quaternion): void {
    this.root.position.copy(position);
    this.root.quaternion.copy(rotation);
    for (const a of this.animated) a.update();
  }
}
