import * as THREE from 'three/webgpu';
import { BIT, BIT_LOOK, BIT_SHAPES, type BitState } from '../people/bit.ts';
import { neonFillMaterial, neonTint, neonize } from './neon.ts';

export const BIT_STATES: BitState[] = ['idle1', 'idle2', 'yes', 'no'];

/** One geometry per figure, shared by every Bit drawn. */
const geometries = new Map<BitState, THREE.BufferGeometry>();
export function bitGeometry(state: BitState): THREE.BufferGeometry {
  let g = geometries.get(state);
  if (!g) {
    const s = BIT_SHAPES[state];
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute('position', new THREE.Float32BufferAttribute(s.positions, 3));
    indexed.setIndex(s.indices);
    g = indexed.toNonIndexed(); // flat facets: every face keeps its own normal
    g.computeVertexNormals();
    indexed.dispose();
    geometries.set(state, g);
  }
  return g;
}

/**
 * One Bit, drawn (the player's own): four rigid figures of which exactly one shows, turning slowly, over a dim
 * disc of its light on the ground. No rig and no animation clips: a state change is a swap of
 * which mesh is visible, as in the film. Light states follow AGENTS.md §5 (idle dim, answering
 * bright, damaged flickering, inactive dark).
 */
export class BitFigure {
  readonly root = new THREE.Group();
  private readonly spinner = new THREE.Group();
  private readonly figures = new Map<BitState, THREE.Mesh>();
  private readonly fills = new Map<BitState, THREE.MeshStandardNodeMaterial>();
  private readonly lines: THREE.LineSegments[] = [];
  private readonly pool: THREE.Mesh;
  private readonly poolMat: THREE.MeshBasicNodeMaterial;
  private time = 0;
  private angle = 0;
  /** The figure showing now. */
  state: BitState = 'idle1';
  /** A wreck: dark and still. */
  inactive = false;
  /** 0..1: how badly hurt (flickers the light). */
  damage = 0;

  constructor() {
    this.spinner.position.y = BIT.hover;
    this.root.add(this.spinner);
    for (const s of BIT_STATES) {
      const look = BIT_LOOK[s];
      const fill = neonFillMaterial(neonTint(look.color).multiplyScalar(0.3), { flatShading: true });
      fill.emissive = new THREE.Color(look.color);
      fill.emissiveIntensity = 0.5;
      const mesh = new THREE.Mesh(bitGeometry(s), fill);
      const edges = neonize(bitGeometry(s), neonTint(look.color), { thresholdAngle: 8 });
      mesh.add(edges);
      mesh.scale.setScalar(look.radius);
      mesh.visible = false;
      this.spinner.add(mesh);
      this.figures.set(s, mesh);
      this.fills.set(s, fill);
      this.lines.push(edges);
    }
    // The ground link: a soft disc of the figure's light under it, so it reads as standing there.
    this.poolMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.25 });
    this.pool = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.5, 24).rotateX(-Math.PI / 2), this.poolMat);
    this.pool.position.y = 0.04;
    this.root.add(this.pool);
    this.show('idle1');
  }

  private show(state: BitState): void {
    this.state = state;
    for (const [s, m] of this.figures) m.visible = s === state;
    this.poolMat.color.copy(neonTint(BIT_LOOK[state].color));
  }

  /** Show `next` at `time` (s): the root sits on the ground under the figure. */
  update(time: number, next: BitState): void {
    const dt = Math.max(0, Math.min(0.1, time - this.time));
    this.time = time;
    if (this.inactive) {
      for (const f of this.fills.values()) f.emissiveIntensity = 0.02;
      this.pool.visible = false;
      return;
    }
    if (next !== this.state) this.show(next);
    const answering = next === 'yes' || next === 'no';
    this.angle += dt * Math.PI * 2 * (answering ? BIT.answerSpin : BIT.spin);
    this.spinner.rotation.set(0.3, this.angle, 0);
    // Light state: idle dim, answering bright, damaged flickering.
    const flicker = this.damage > 0.05 && Math.sin(time * 37) * Math.sin(time * 11.3) > 1 - this.damage * 1.6 ? 0.25 : 1;
    this.fills.get(next)!.emissiveIntensity = (answering ? 1.1 : 0.45) * flicker;
    this.pool.visible = true;
    this.poolMat.opacity = (answering ? 0.4 : 0.22) * flicker;
  }

  dispose(): void {
    for (const f of this.fills.values()) f.dispose();
    for (const l of this.lines) l.geometry.dispose(); // the line material is shared per colour
    this.pool.geometry.dispose();
    this.poolMat.dispose();
  }
}
