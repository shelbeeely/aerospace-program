import * as THREE from 'three/webgpu';
import { BIT, BIT_LOOK, type BitState } from '../people/bit.ts';
import { BITS, type BitPopulation, type BitWalker } from '../sim/bits.ts';
import { BIT_STATES, BitFigure, bitGeometry } from './BitFigure.ts';
import { neonTint } from './neon.ts';

/** A figure's geometry with its facets shaded into vertex colours, so a crowd needs no lights. */
function shadedGeometry(state: BitState): THREE.BufferGeometry {
  const g = bitGeometry(state).clone();
  const n = g.getAttribute('normal');
  const col = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    // Lit from above and to one side: each facet a flat tone, as in the film.
    const d = n.getX(i) * 0.35 + n.getY(i) * 0.8 + n.getZ(i) * 0.48;
    const shade = 0.42 + 0.58 * Math.max(0, Math.min(1, d * 0.5 + 0.5));
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = shade;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * The people, drawn: every Bit near the player as an instance of the figure it shows (four
 * instanced meshes, one per state), each over a dim pool of its light on the ground, and the
 * player's own Bit when it is on foot. Rigid figures only: a change of state is a change of
 * which mesh an instance belongs to. Idle light is dim, an answer is bright (§5).
 */
export class BitsView {
  private readonly meshes = new Map<BitState, THREE.InstancedMesh>();
  private readonly pools: THREE.InstancedMesh;
  private readonly player = new BitFigure();
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _c = new THREE.Color();
  private readonly tones = new Map<BitState, THREE.Color>();

  constructor(scene: THREE.Scene, private readonly bits: BitPopulation, private readonly walker: BitWalker) {
    for (const s of BIT_STATES) {
      const answering = s === 'yes' || s === 'no';
      const tone = neonTint(BIT_LOOK[s].color).multiplyScalar(answering ? 1.5 : 0.75);
      this.tones.set(s, tone);
      const mesh = new THREE.InstancedMesh(shadedGeometry(s), new THREE.MeshBasicNodeMaterial({ vertexColors: true, color: tone }), BITS.max);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.name = `bits.${s}`;
      scene.add(mesh);
      this.meshes.set(s, mesh);
    }
    const ring = new THREE.RingGeometry(0.28, 0.5, 20).rotateX(-Math.PI / 2);
    this.pools = new THREE.InstancedMesh(ring, new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.3 }), BITS.max);
    this.pools.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BITS.max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pools.count = 0;
    this.pools.frustumCulled = false;
    this.pools.name = 'bits.pools';
    scene.add(this.pools);
    this.player.root.visible = false;
    this.player.root.name = 'bit.player';
    scene.add(this.player.root);
  }

  /** People drawn last frame. */
  get drawn(): number {
    return this.pools.count;
  }

  /** `alpha`: how far between the last two simulation steps this frame is (0..1), for the player. */
  update(time: number, alpha: number): void {
    const counts = new Map<BitState, number>();
    for (const s of BIT_STATES) counts.set(s, 0);
    let n = 0;
    for (const p of this.bits.people) {
      const state = this.bits.stateOf(p, time);
      const mesh = this.meshes.get(state)!;
      const i = counts.get(state)!;
      counts.set(state, i + 1);
      const answering = state === 'yes' || state === 'no';
      // Each turns slowly on its own axis; talking, it faces whoever it is talking to.
      const spin = (time + p.beat) * Math.PI * 2 * (answering ? BIT.answerSpin : BIT.spin);
      this._e.set(0.3, p.yaw + spin, 0, 'YXZ');
      this._q.setFromEuler(this._e);
      this._p.set(p.x, p.y, p.z);
      this._s.setScalar(BIT_LOOK[state].radius);
      mesh.setMatrixAt(i, this._m.compose(this._p, this._q, this._s));
      this._p.y = p.y - BIT.hover + 0.05;
      this._q.identity();
      this._s.setScalar(1);
      this.pools.setMatrixAt(n, this._m.compose(this._p, this._q, this._s));
      this.pools.setColorAt(n, this._c.copy(this.tones.get(state)!).multiplyScalar(answering ? 0.5 : 0.35));
      n++;
    }
    for (const s of BIT_STATES) {
      const mesh = this.meshes.get(s)!;
      mesh.count = counts.get(s)!;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.pools.count = n;
    this.pools.instanceMatrix.needsUpdate = true;
    if (this.pools.instanceColor) this.pools.instanceColor.needsUpdate = true;

    const w = this.walker;
    this.player.root.visible = w.active && w.downAt === null;
    if (w.active && w.downAt === null) {
      this.player.root.position.set(w.prevX + (w.x - w.prevX) * alpha, w.prevY + (w.y - w.prevY) * alpha, w.prevZ + (w.z - w.prevZ) * alpha);
      this.player.update(time, w.state(time));
    }
  }
}
