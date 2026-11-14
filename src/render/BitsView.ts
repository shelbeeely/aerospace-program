import * as THREE from 'three/webgpu';
import { BIT, BIT_LOOK, type BitState } from '../people/bit.ts';
import { BITS, type BitPopulation, type BitWalker } from '../sim/bits.ts';
import { BIT_STATES, BitFigure, bitGeometry } from './BitFigure.ts';
import { neonTint } from './neon.ts';
import { STYLE_LIGHT, STYLE_SIZE, STYLE_SPIN, styledState, type BitStyle } from '../people/bitStyle.ts';
import type { Errands } from '../sim/errands.ts';
import type { Sappers } from '../sim/sappers.ts';
import { sideLight } from '../sim/teams.ts';
import { CHARGE_LIGHT } from './ChargesView.ts';

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
 *
 * Each Bit wears its genes' look: its idle light (per-instance colour, so a crowd of many
 * lineages is still four draw calls), its size, which idle figure it holds and how fast it
 * turns. YES is yellow and NO red for every Bit.
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
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly tones = new Map<BitState, THREE.Color>();
  /** Idle tone per inherited light. */
  private readonly idleTones = new Map<string, THREE.Color>();
  /** Errand markers: a lit cube over Bits with a packet to send, a lit ring over Bits wanting an
   *  escort, the packet riding over the player's Bit, and a beam at the doorway it goes to. */
  private readonly offerCubes: THREE.InstancedMesh;
  private readonly offerRings: THREE.InstancedMesh;
  private readonly packet: THREE.Mesh;
  private readonly beam: THREE.Mesh;
  private errands: Errands | null = null;
  /** Sappers: the charge each carries over it (by kind), and the beams that shoot them. */
  private sappers: Sappers | null = null;
  private readonly carried: THREE.InstancedMesh;
  private readonly shotLines: THREE.LineSegments;
  private readonly shotPos = new Float32Array(16 * 6);
  private readonly sideTones = new Map<number, THREE.Color>();

  constructor(scene: THREE.Scene, private readonly bits: BitPopulation, private readonly walker: BitWalker | null) {
    for (const [name, c] of Object.entries(STYLE_LIGHT)) this.idleTones.set(name, neonTint(c).multiplyScalar(0.75));
    for (const s of BIT_STATES) {
      const answering = s === 'yes' || s === 'no';
      const tone = neonTint(BIT_LOOK[s].color).multiplyScalar(answering ? 1.5 : 0.75);
      this.tones.set(s, tone);
      // The tone rides on each instance (its inherited light); the material only shades.
      const mesh = new THREE.InstancedMesh(shadedGeometry(s), new THREE.MeshBasicNodeMaterial({ vertexColors: true, color: 0xffffff }), BITS.max);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BITS.max * 3), 3).setUsage(THREE.DynamicDrawUsage);
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
    const white = new THREE.MeshBasicNodeMaterial({ color: neonTint('#dff6ff').multiplyScalar(1.8) });
    this.offerCubes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), white, BITS.max);
    this.offerRings = new THREE.InstancedMesh(new THREE.TorusGeometry(0.42, 0.05, 6, 20).rotateX(Math.PI / 2), white, BITS.max);
    for (const m of [this.offerCubes, this.offerRings]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count = 0; m.frustumCulled = false; scene.add(m); }
    this.packet = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), white);
    this.packet.visible = false;
    scene.add(this.packet);
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 120, 8, 1, true).translate(0, 60, 0), new THREE.MeshBasicNodeMaterial({ color: neonTint('#dff6ff').multiplyScalar(0.9), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    this.beam.visible = false;
    this.beam.name = 'errand-beam';
    scene.add(this.beam);
    this.player.root.visible = false;
    this.player.root.name = 'bit.player';
    scene.add(this.player.root);
    this.carried = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.3, 0).scale(1, 0.8, 1), new THREE.MeshBasicNodeMaterial({ color: 0xffffff }), 32);
    this.carried.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(32 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.carried.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.carried.count = 0;
    this.carried.frustumCulled = false;
    this.carried.name = 'bits.sapper-charges';
    scene.add(this.carried);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.shotPos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setDrawRange(0, 0);
    this.shotLines = new THREE.LineSegments(lg, new THREE.LineBasicNodeMaterial({ color: neonTint('#ff2a12').multiplyScalar(2.2) }));
    this.shotLines.frustumCulled = false;
    this.shotLines.name = 'bits.sapper-shots';
    scene.add(this.shotLines);
    for (const t of [0, 1, 2]) this.sideTones.set(t, neonTint(sideLight(t as 0 | 1 | 2)).multiplyScalar(0.5));
  }

  /** Draw the sappers' charges and the shots at them. */
  setSappers(s: Sappers): void {
    this.sappers = s;
  }

  /** Show what the people are asking for, and where the errand under way is going. */
  setErrands(e: Errands): void {
    this.errands = e;
  }

  /** Style the player's own Bit. */
  setStyle(style: BitStyle): void {
    this.player.setStyle(style);
  }

  /** Show or hide the people (the explorer's Evolution Lab switches them with its view). */
  setVisible(v: boolean): void {
    for (const m of this.meshes.values()) m.visible = v;
    this.pools.visible = v;
    this.offerCubes.visible = this.offerRings.visible = v;
    this.carried.visible = this.shotLines.visible = v;
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
      const style = p.genome.style;
      const state = styledState(this.bits.stateOf(p, time), style);
      const mesh = this.meshes.get(state)!;
      const i = counts.get(state)!;
      counts.set(state, i + 1);
      const answering = state === 'yes' || state === 'no';
      const tone = answering ? this.tones.get(state)! : this.idleTones.get(style.light)!;
      // Each turns slowly on its own axis (at its inherited pace); talking, it faces whoever it is talking to.
      const spin = (time + p.beat) * Math.PI * 2 * (answering ? BIT.answerSpin : BIT.spin * STYLE_SPIN[style.spin]);
      this._e.set(0.3, p.yaw + spin, 0, 'YXZ');
      this._q.setFromEuler(this._e);
      this._p.set(p.x, p.y, p.z);
      const size = STYLE_SIZE[style.size];
      this._s.setScalar(BIT_LOOK[state].radius * size);
      mesh.setMatrixAt(i, this._m.compose(this._p, this._q, this._s));
      mesh.setColorAt(i, tone);
      this._p.y = p.y - BIT.hover + 0.05;
      this._q.identity();
      this._s.setScalar(size);
      this.pools.setMatrixAt(n, this._m.compose(this._p, this._q, this._s));
      // A sapper's pool shows whose side it fights for.
      this.pools.setColorAt(n, p.mission ? this._c.copy(this.sideTones.get(p.mission.side)!) : this._c.copy(tone).multiplyScalar(answering ? 0.5 : 0.35));
      n++;
    }
    // Sappers carry their charge over them until it is set.
    let ncarry = 0;
    for (const p of this.bits.people) {
      const m = p.mission;
      if (!m || m.planted || m.phase === 'home' || ncarry >= 32) continue;
      this._p.set(p.x, p.y + 1.3, p.z);
      this._q.setFromAxisAngle(this._up, time * 2 + p.beat);
      this._s.setScalar(1);
      this.carried.setMatrixAt(ncarry, this._m.compose(this._p, this._q, this._s));
      this.carried.setColorAt(ncarry, this._c.copy(neonTint(CHARGE_LIGHT[m.kind])).multiplyScalar(1.4));
      ncarry++;
    }
    this.carried.count = ncarry;
    this.carried.instanceMatrix.needsUpdate = true;
    if (this.carried.instanceColor) this.carried.instanceColor.needsUpdate = true;
    // A shot at a sapper: a red line from the turret for a moment.
    let ns = 0;
    if (this.sappers) for (const s of this.sappers.shots) {
      if (time - s.time > 0.3 || time < s.time || ns >= 16) continue;
      this.shotPos.set([s.x, s.y, s.z, s.tx, s.ty, s.tz], ns * 6);
      ns++;
    }
    this.shotLines.geometry.setDrawRange(0, ns * 2);
    (this.shotLines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    for (const s of BIT_STATES) {
      const mesh = this.meshes.get(s)!;
      mesh.count = counts.get(s)!;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.pools.count = n;
    this.pools.instanceMatrix.needsUpdate = true;
    if (this.pools.instanceColor) this.pools.instanceColor.needsUpdate = true;

    const w = this.walker;
    this.player.root.visible = !!w && w.active && w.downAt === null;
    if (w && w.active && w.downAt === null) {
      this.player.root.position.set(w.prevX + (w.x - w.prevX) * alpha, w.prevY + (w.y - w.prevY) * alpha, w.prevZ + (w.z - w.prevZ) * alpha);
      this.player.update(time, w.state(time));
    }
    // Errands: who is asking, what is being carried, where it goes.
    const e = this.errands;
    let nc = 0, nr = 0;
    if (e) for (const p of this.bits.people) {
      const offer = e.offerOf(p, time);
      if (!offer) continue;
      this._p.set(p.x, p.y + 1.25, p.z);
      this._q.setFromAxisAngle(this._p.clone().set(0, 1, 0), time * 1.5 + p.beat);
      this._s.setScalar(1);
      if (offer === 'courier') this.offerCubes.setMatrixAt(nc++, this._m.compose(this._p, this._q, this._s));
      else this.offerRings.setMatrixAt(nr++, this._m.compose(this._p, this._q, this._s));
    }
    this.offerCubes.count = nc; this.offerRings.count = nr;
    this.offerCubes.instanceMatrix.needsUpdate = true; this.offerRings.instanceMatrix.needsUpdate = true;
    const t = e?.target();
    this.packet.visible = !!t && t.kind === 'courier' && this.player.root.visible;
    if (this.packet.visible) { this.packet.position.copy(this.player.root.position).add(this._p.set(0, 2.6, 0)); this.packet.rotation.y = time * 2; }
    this.beam.visible = !!t;
    if (t) this.beam.position.set(t.x, 0, t.z);
  }
}
