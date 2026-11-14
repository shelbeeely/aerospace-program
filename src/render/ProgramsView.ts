import * as THREE from 'three/webgpu';
import { BIT_LOOK } from '../people/bit.ts';
import { programLight, PROGRAMS, PROGRAM_KIND_LIST, type Program, type ProgramKind, type Programs } from '../sim/programs.ts';
import { neonTint } from './neon.ts';

/**
 * The programs of the streets, drawn: each kind a rigid figure of a few solids, dark bodies with
 * selective light in its side's colour (§4, §5), one instanced mesh per part so the whole
 * population costs a couple of dozen draw calls. Light has states: dim while idle, bright at
 * work, YES/NO in the Bits' yellow and red, a sentinel's halo flashing when it has warned you.
 * Work is shown as a thin beam: an archivist uploading into a building, a tender mending a road,
 * a sentinel's shot.
 */

interface Part {
  geo: THREE.BufferGeometry;
  lit: boolean;
  /** Offset from the figure's foot (m), in its own frame. */
  at: [number, number, number];
  /** Fixed tilt of the part (Euler XYZ). */
  tilt?: [number, number, number];
  /** Spin about its own vertical axis (turns per second). */
  spin?: number;
  /** Circling the figure's axis: radius (m), turns per second and phase (turns). */
  orbit?: [number, number, number];
}

/** Facets shaded into vertex colours, lit from above and to one side, as the Bits are. */
function shaded(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  geo.computeVertexNormals();
  const n = geo.getAttribute('normal');
  const col = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const d = n.getX(i) * 0.35 + n.getY(i) * 0.8 + n.getZ(i) * 0.48;
    const shade = 0.45 + 0.55 * Math.max(0, Math.min(1, d * 0.5 + 0.5));
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

const ring = (r: number, t: number, sides: number) => new THREE.TorusGeometry(r, t, 4, sides).rotateX(Math.PI / 2);

/** The figures (see src/sim/programs.ts for who they are). */
const PARTS: Record<ProgramKind, Part[]> = {
  // Cyan: a tall hexagonal bipyramid with a waist ring, a data cube riding over it.
  archivist: [
    { geo: new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(0.55, 1.7), new THREE.Vector2(0, 3.4)], 6), lit: false, at: [0, 0.3, 0] },
    { geo: ring(0.6, 0.035, 6), lit: true, at: [0, 2.0, 0] },
    { geo: new THREE.BoxGeometry(0.42, 0.42, 0.42), lit: true, at: [0, 4.1, 0], tilt: [0.6, 0, 0.6], spin: 0.35 },
  ],
  // Red: an inverted square frustum under a cap and a halo, a slit of light for an eye.
  sentinel: [
    { geo: new THREE.CylinderGeometry(0.75, 0.22, 3.6, 4).rotateY(Math.PI / 4).translate(0, 1.8, 0), lit: false, at: [0, 0.3, 0] },
    { geo: new THREE.BoxGeometry(1.15, 0.12, 1.15), lit: false, at: [0, 4.0, 0] },
    { geo: ring(0.8, 0.05, 24), lit: true, at: [0, 4.5, 0] },
    { geo: new THREE.BoxGeometry(0.62, 0.07, 0.06), lit: true, at: [0, 3.5, -0.64] },
  ],
  // Amber: a squat octagonal drum with an amber band and a capstan on top.
  tender: [
    { geo: new THREE.CylinderGeometry(0.85, 0.95, 1.0, 8), lit: false, at: [0, 0.85, 0] },
    { geo: new THREE.CylinderGeometry(0.32, 0.55, 0.4, 8), lit: false, at: [0, 1.55, 0] },
    { geo: ring(0.9, 0.05, 8), lit: true, at: [0, 0.95, 0] },
  ],
  // Freelancers: a low tetrahedron, fragments of what it has picked up circling it.
  scavenger: [
    { geo: new THREE.TetrahedronGeometry(0.85), lit: false, at: [0, 0.95, 0], tilt: [0.62, 0, 0.785], spin: 0.08 },
    { geo: new THREE.BoxGeometry(0.2, 0.2, 0.2), lit: true, at: [0, 1.1, 0], orbit: [1.05, 0.3, 0], spin: 1 },
    { geo: new THREE.BoxGeometry(0.16, 0.16, 0.16), lit: true, at: [0, 1.35, 0], orbit: [0.9, 0.3, 0.5], spin: 1 },
  ],
  // Mercenaries: a cube stood on its corner over a dark disc ringed in light, a lit tip.
  broker: [
    { geo: new THREE.CylinderGeometry(1.0, 1.0, 0.12, 24), lit: false, at: [0, 0.18, 0] },
    { geo: ring(1.0, 0.07, 24), lit: true, at: [0, 0.26, 0] },
    { geo: new THREE.BoxGeometry(0.95, 0.95, 0.95), lit: false, at: [0, 1.95, 0], tilt: [Math.atan(Math.SQRT1_2), 0, Math.PI / 4], spin: 0.06 },
    { geo: new THREE.OctahedronGeometry(0.13), lit: true, at: [0, 2.9, 0], spin: 0.5 },
  ],
};

/** Body tones: dark navy, warm near-black for Red. */
const BODY: Record<ProgramKind, string> = { archivist: '#34588a', sentinel: '#55302a', tender: '#3a5274', scavenger: '#46546a', broker: '#32508a' };

export class ProgramsView {
  private readonly meshes = new Map<ProgramKind, Array<{ part: Part; mesh: THREE.InstancedMesh }>>();
  private readonly beams: THREE.InstancedMesh;
  private readonly _m = new THREE.Matrix4();
  private readonly _l = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();
  private readonly _p = new THREE.Vector3();
  private readonly _a = new THREE.Vector3();
  private readonly _b = new THREE.Vector3();
  private readonly _s = new THREE.Vector3(1, 1, 1);
  private readonly _c = new THREE.Color();
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly yes = neonTint(BIT_LOOK.yes.color);
  private readonly no = neonTint(BIT_LOOK.no.color);
  private readonly lights = new Map<string, THREE.Color>();
  private readonly tilts = new Map<Part, THREE.Quaternion>();

  constructor(scene: THREE.Scene, private readonly programs: Programs) {
    const max = PROGRAMS.max;
    for (const kind of PROGRAM_KIND_LIST) {
      const list: Array<{ part: Part; mesh: THREE.InstancedMesh }> = [];
      for (const part of PARTS[kind]) {
        const mat = part.lit
          ? new THREE.MeshBasicNodeMaterial({ color: 0xffffff })
          : new THREE.MeshBasicNodeMaterial({ vertexColors: true, color: new THREE.Color(BODY[kind]) });
        const mesh = new THREE.InstancedMesh(part.lit ? part.geo : shaded(part.geo), mat, max);
        if (part.lit) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.name = `programs.${kind}`;
        scene.add(mesh);
        list.push({ part, mesh });
        if (part.tilt) this.tilts.set(part, new THREE.Quaternion().setFromEuler(new THREE.Euler(...part.tilt)));
      }
      this.meshes.set(kind, list);
    }
    this.beams = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.06, 0.06, 1, 6, 1, true).translate(0, 0.5, 0),
      new THREE.MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }),
      64,
    );
    this.beams.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(64 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beams.count = 0;
    this.beams.frustumCulled = false;
    this.beams.name = 'programs.beams';
    scene.add(this.beams);
  }

  /** Programs drawn last frame. */
  drawn = 0;

  private light(p: Program): THREE.Color {
    const key = String(p.side);
    let c = this.lights.get(key);
    if (!c) { c = neonTint(programLight(p.side)); this.lights.set(key, c); }
    return c;
  }

  private beam(a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color, k: number): number {
    if (k >= 64) return k;
    const d = this._p.subVectors(b, a);
    const len = d.length();
    if (len < 0.1) return k;
    this._q.setFromUnitVectors(this._up, d.divideScalar(len));
    this._s.set(1, len, 1);
    this.beams.setMatrixAt(k, this._m.compose(a, this._q, this._s));
    this.beams.setColorAt(k, color);
    this._s.set(1, 1, 1);
    return k + 1;
  }

  update(time: number): void {
    const counts = new Map<THREE.InstancedMesh, number>();
    let beams = 0;
    for (const p of this.programs.people) {
      const g = p.group;
      const list = this.meshes.get(p.kind)!;
      // Light state: dim idle, bright at work, flashing on alert, the Bits' colours for YES/NO.
      const answering = p.answer && time >= p.answeredAt && time - p.answeredAt < 1.6;
      let tone: THREE.Color;
      if (answering) tone = this._c.copy(p.answer === 'yes' ? this.yes : this.no).multiplyScalar(1.6);
      else {
        let k = 0.85;
        if (g.activity === 'work') k = 1.5;
        if (g.activity === 'alert') k = 0.8 + 0.9 * (Math.sin(time * 14) > 0 ? 1 : 0);
        tone = this._c.copy(this.light(p)).multiplyScalar(k);
      }
      // The figure's frame: at its foot, facing where it faces, with a gentle hover.
      const bob = Math.sin((time + p.beat) * 1.7) * 0.06;
      this._e.set(0, -p.yaw, 0);
      this._q.setFromEuler(this._e);
      this._m.compose(this._p.set(p.x, p.y + bob, p.z), this._q, this._s);
      for (const { part, mesh } of list) {
        const i = counts.get(mesh) ?? 0;
        counts.set(mesh, i + 1);
        let [ox, oy, oz] = part.at;
        if (part.orbit) {
          const a = (time * part.orbit[1] + part.orbit[2] + p.beat) * Math.PI * 2;
          ox += Math.cos(a) * part.orbit[0];
          oz += Math.sin(a) * part.orbit[0];
        }
        this._q2.identity();
        if (part.spin) this._q2.setFromAxisAngle(this._up, (time + p.beat) * part.spin * Math.PI * 2);
        const tq = this.tilts.get(part);
        if (tq) this._q2.multiply(tq);
        this._l.compose(this._a.set(ox, oy, oz), this._q2, this._s);
        mesh.setMatrixAt(i, this._l.premultiply(this._m));
        if (part.lit) mesh.setColorAt(i, tone);
      }
      // Work beams, from the leader.
      if (g.activity === 'work' && g.goal && p.k === 0) {
        if (p.kind === 'archivist') beams = this.beam(this._a.set(p.x, p.y + 4.1, p.z), this._b.set(g.goal.x, p.y + 6, g.goal.z), tone, beams);
        if (p.kind === 'tender') beams = this.beam(this._a.set(p.x, p.y + 1.6, p.z), this._b.set(g.goal.x, p.y + 0.4, g.goal.z), tone, beams);
      }
    }
    // Sentinel shots: a red line for a moment.
    for (const s of this.programs.shots) {
      const f = 1 - Math.min(1, time - s.time);
      if (f <= 0) continue;
      beams = this.beam(this._a.set(s.x, s.y, s.z), this._b.set(s.tx, s.ty, s.tz), this._c.copy(this.no).multiplyScalar(2 * f), beams);
    }
    for (const list of this.meshes.values()) for (const { mesh } of list) {
      mesh.count = counts.get(mesh) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.beams.count = beams;
    this.beams.instanceMatrix.needsUpdate = true;
    if (this.beams.instanceColor) this.beams.instanceColor.needsUpdate = true;
    this.drawn = this.programs.people.length;
  }
}
