import * as THREE from 'three/webgpu';
import { attribute, color, float, fract, fwidth, max, min, mix, positionLocal, smoothstep, uniform, vec3 } from 'three/tsl';
import { PLANET } from '../sim/layout.ts';
import { butteCell, cragCell, OUTLANDS, rubbleCell, TERRAIN } from '../sim/terrain.ts';
import { flatWorld } from './curvature.ts';
import { gridLines, type TslNode } from './neon.ts';

/**
 * The Outlands' landforms near the camera as real geometry (Rule 1): every butte, crag and
 * rubble shard (sim/terrain.ts butteCell / cragCell / rubbleCell, the same cells and sizes the
 * physics hulls use) is one instance of a unit mesh, so the sheer walls are exact planes and
 * every edge is crisp. The ground disc is left flat under the instanced buttes and crags
 * (terrainHeightNode's `near` exclusion) and keeps its displacement only beyond the range.
 *
 * Light defines the structure (Rule 2): every edge (butte rims and wall corners, crag
 * ridgelines) glows orange to red with height, amber strata every 40 m up the walls, dark faces
 * under the faint electric-blue survey grid: the same look cityGround gives the far Outlands.
 */
const C = PLANET.circumference;
/** Buttes and crags whose cell centre is within this distance (m) of the anchor are drawn as instances. */
export const OUTLANDS_RANGE = 8000;
/** Rubble is drawn this far (m): small, and only seen up close. */
const RUBBLE_RANGE = 2500;
/** Lattice cells examined per frame while rebuilding. */
const CELLS_PER_FRAME = 6000;
type Kind = 'butte' | 'crag' | 'rubble';
const LATTICES: ReadonlyArray<{ kind: Kind; n: number; range: number; glow: number }> = [
  { kind: 'butte', n: TERRAIN.bigCells, range: OUTLANDS_RANGE, glow: 2.6 },
  { kind: 'crag', n: TERRAIN.smallCells, range: OUTLANDS_RANGE, glow: 2.0 },
  { kind: 'rubble', n: OUTLANDS.rubbleCells, range: RUBBLE_RANGE, glow: 1.2 },
];
const mod = (v: number, m: number) => ((v % m) + m) % m;

/** Upper bound on cells in range for one lattice (the square around the range circle). */
function maxCells(n: number, range: number): number {
  const side = 2 * (Math.ceil(range / (C / n)) + 1) + 1;
  return side * side;
}

/**
 * A unit solid: base square [-1, 1]² at y = 0, top at y = 1 (a point for a pyramid, a square
 * of half-size `top` for a mesa). Non-indexed, one set of vertices per face, each carrying an
 * `edge` attribute: per-triangle barycentrics where a component reaches 0 only on a real face
 * edge (quad diagonals are pushed away), so the fragment shader can light every edge.
 */
function unitSolid(top: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const edge: number[] = [];
  const FAR = 8; // a barycentric that never reaches 0: the quad diagonal stays dark
  const tri = (a: number[], b: number[], c: number[], ea: number[], eb: number[], ec: number[]) => {
    pos.push(...a, ...b, ...c);
    edge.push(...ea, ...eb, ...ec);
  };
  /** Quad a-b-c-d (counter-clockwise seen from outside), split along a-c. */
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    tri(a, b, c, [1, FAR, 0], [0, 1, 0], [0, FAR, 1]);
    tri(a, c, d, [1, 0, FAR], [0, 1, FAR], [0, 0, 1]);
  };
  // Base corners counter-clockwise seen from above (+y): (-1,-1) → (-1,1) → (1,1) → (1,-1).
  const corners = [[-1, -1], [-1, 1], [1, 1], [1, -1]];
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = corners[i];
    const [x1, z1] = corners[(i + 1) % 4];
    const b0 = [x0, 0, z0], b1 = [x1, 0, z1];
    if (top <= 0) tri(b0, b1, [0, 1, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    else quad(b0, b1, [x1 * top, 1, z1 * top], [x0 * top, 1, z0 * top]);
  }
  if (top > 0) {
    const t = corners.map(([x, z]) => [x * top, 1, z * top]);
    quad(t[0], t[1], t[2], t[3]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('edge', new THREE.Float32BufferAttribute(edge, 3));
  // Which way each vertex leans in with height (buttes: the wall batter, see buttePosition).
  const corner: number[] = [];
  for (let i = 0; i < pos.length; i += 3) corner.push(pos[i], pos[i + 2]);
  g.setAttribute('corner', new THREE.Float32BufferAttribute(corner, 2));
  return g;
}

/**
 * Butte walls batter in by OUTLANDS.batter m per metre of height: after the instance transform
 * (scale (half-width, H, half-depth)) each vertex moves in by batter × its height, toward the
 * centre, so every butte has the physics hull's exact top whatever its size.
 */
const buttePosition: TslNode = positionLocal.sub(vec3(attribute('corner', 'vec2').x, 0, attribute('corner', 'vec2').y).mul(positionLocal.y.mul(OUTLANDS.batter)));

function solidMaterial(glow: number, butte: boolean): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  if (butte) mat.positionNode = buttePosition;
  const p: TslNode = flatWorld;
  const h: TslNode = max(p.y, float(0));
  // Edges: anti-aliased ~1.5 px lines where any barycentric reaches 0, dimmed where the face is
  // only a few pixels across (far away the lines would otherwise cover it).
  const e: TslNode = attribute('edge', 'vec3');
  const fw: TslNode = max(fwidth(e), float(1e-5));
  const d: TslNode = e.div(fw.mul(1.5));
  const tiny: TslNode = smoothstep(0.02, 0.12, min(min(fw.x, fw.y), fw.z));
  const edges: TslNode = float(1).sub(smoothstep(float(0.5), float(1.5), min(min(d.x, d.y), d.z))).mul(float(1).sub(tiny.mul(0.7)));
  // Amber square contours every 40 m from the flat world height.
  const t: TslNode = fract(h.div(40));
  const contour: TslNode = float(1).sub(smoothstep(0, max(fwidth(h.div(40)).mul(1.5), float(0.02)), min(t, float(1).sub(t)))).mul(smoothstep(2, 10, h));
  const hot: TslNode = mix(color('#ff8a1f'), color('#ff2a1a'), smoothstep(60, 300, h));
  const survey: TslNode = gridLines(p.xz, 50, 1).mul(0.35);
  mat.colorNode = mix(color('#010208'), color('#06102a'), smoothstep(0, 250, h))
    .add(color('#1f6bff').mul(survey))
    .add(color('#ffb347').mul(contour.mul(0.9)))
    .add(hot.mul(edges.mul(glow)));
  return mat;
}

/** One lattice's instances and the staging array for a rebuild. */
interface LatticeSet {
  mesh: THREE.InstancedMesh;
  staged: Float32Array;
  count: number;
}

export class OutlandsView {
  /**
   * Uniforms the ground disc reads to stay flat under the instanced buttes and crags: the
   * canonical anchor (x, z) of the shown set and the radius (m) within which butte centres are
   * instanced.
   */
  readonly exclusion = { anchor: uniform(new THREE.Vector2()), radius: uniform(-1) };
  private readonly sets: LatticeSet[];
  /** Anchor of the shown set (canonical big-cell centre), NaN before the first build. */
  private shownX = NaN;
  private shownZ = NaN;
  /** The rebuild in progress: its anchor and cell cursor. */
  private build: { ax: number; az: number; lattice: number; ix: number; iz: number } | null = null;

  constructor(scene: THREE.Scene) {
    const box = unitSolid(1), pyramid = unitSolid(0);
    this.sets = LATTICES.map((l) => {
      const cap = maxCells(l.n, l.range);
      const mesh = new THREE.InstancedMesh(l.kind === 'butte' ? box : pyramid, solidMaterial(l.glow, l.kind === 'butte'), cap);
      mesh.count = 0;
      mesh.frustumCulled = false; // bent by curvature and spread over the whole range
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.name = `outlands-${l.kind}`;
      scene.add(mesh);
      return { mesh, staged: new Float32Array(cap * 16), count: 0 };
    });
  }

  /** Follow the camera: rebuild when it enters another big cell, a slice per frame. */
  update(camera: THREE.Vector3): void {
    const big = C / TERRAIN.bigCells;
    const ax = (Math.floor(mod(camera.x, C) / big) + 0.5) * big;
    const az = (Math.floor(mod(camera.z, C) / big) + 0.5) * big;
    const target = this.build ?? { ax: this.shownX, az: this.shownZ };
    if (ax !== target.ax || az !== target.az) {
      this.build = { ax, az, lattice: 0, ix: NaN, iz: NaN };
      for (const s of this.sets) s.count = 0;
    }
    if (this.build) this.step(this.build);
    // Place the shown set at the whole-circumference image nearest the camera.
    if (!Number.isNaN(this.shownX)) {
      const ox = this.shownX + Math.round((camera.x - this.shownX) / C) * C;
      const oz = this.shownZ + Math.round((camera.z - this.shownZ) / C) * C;
      for (const s of this.sets) s.mesh.position.set(ox, 0, oz);
    }
  }

  /** Stage one instance: scale (sx, sy, sz), then translate (tx, ty, tz) (column-major). */
  private put(set: LatticeSet, sx: number, sy: number, sz: number, tx: number, ty: number, tz: number): void {
    const a = set.staged, o = set.count++ * 16;
    a.fill(0, o, o + 16);
    a[o] = sx;
    a[o + 5] = sy;
    a[o + 10] = sz;
    a[o + 12] = tx;
    a[o + 13] = ty;
    a[o + 14] = tz;
    a[o + 15] = 1;
  }

  private step(b: NonNullable<OutlandsView['build']>): void {
    let budget = CELLS_PER_FRAME;
    while (b.lattice < LATTICES.length && budget > 0) {
      const { kind, n, range } = LATTICES[b.lattice];
      const set = this.sets[b.lattice];
      const cell = C / n;
      const reach = Math.ceil(range / cell) + 1;
      const ci = Math.floor(b.ax / cell), cj = Math.floor(b.az / cell);
      if (Number.isNaN(b.ix)) {
        b.ix = ci - reach;
        b.iz = cj - reach;
      }
      for (; b.ix <= ci + reach && budget > 0; b.ix++, b.iz = cj - reach) {
        for (; b.iz <= cj + reach && budget > 0; b.iz++, budget--) {
          // Cell centre in the anchor's frame (indices unwrapped, so continuous around it).
          const cx = (b.ix + 0.5) * cell, cz = (b.iz + 0.5) * cell;
          if (Math.hypot(cx - b.ax, cz - b.az) >= range) continue;
          // Canonical → anchor frame: the cell's canonical centre sits at (cx, cz) here.
          const ox = cx - (mod(b.ix, n) + 0.5) * cell, oz = cz - (mod(b.iz, n) + 0.5) * cell;
          if (kind === 'butte') {
            const t = butteCell(b.ix, b.iz);
            if (t) this.put(set, (t.x1 - t.x0) / 2, t.H, (t.z1 - t.z0) / 2, (t.x0 + t.x1) / 2 + ox - b.ax, 0, (t.z0 + t.z1) / 2 + oz - b.az);
          } else {
            const p = kind === 'crag' ? cragCell(b.ix, b.iz) : rubbleCell(b.ix, b.iz);
            if (p) this.put(set, p.half, p.H, p.half, p.cx + ox - b.ax, p.y0, p.cz + oz - b.az);
          }
        }
        if (b.iz <= cj + reach) break; // out of budget mid-column: resume here next frame
      }
      if (b.ix > ci + reach) {
        b.lattice++;
        b.ix = NaN;
      }
    }
    if (b.lattice < LATTICES.length) return;
    // Done: swap the new set in, together with the disc's exclusion.
    for (const s of this.sets) {
      s.mesh.instanceMatrix.array.set(s.staged.subarray(0, s.count * 16));
      s.mesh.count = s.count;
      s.mesh.instanceMatrix.needsUpdate = true;
    }
    this.shownX = b.ax;
    this.shownZ = b.az;
    this.exclusion.anchor.value.set(b.ax, b.az);
    // A hair inside the instanced range: a borderline cell is drawn twice rather than not at all.
    this.exclusion.radius.value = OUTLANDS_RANGE - 2;
    this.build = null;
  }

  /** Number of instanced landforms shown (tests, debugging). */
  get count(): number {
    return this.sets.reduce((a, s) => a + s.mesh.count, 0);
  }
}
