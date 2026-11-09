import * as THREE from 'three/webgpu';
import { attribute, color, float, fract, fwidth, max, min, mix, smoothstep, uniform } from 'three/tsl';
import { PLANET } from '../sim/layout.ts';
import { solidCell, TERRAIN } from '../sim/terrain.ts';
import { flatWorld } from './curvature.ts';
import { gridLines, type TslNode } from './neon.ts';

/**
 * The Off-Grid's geometric solids near the camera as real geometry (Rule 1): every pyramid and
 * mesa of both lattices whose cell centre lies within RANGE of the anchor is one instance of a
 * unit mesh, so faces are exact planes and edges are crisp at any distance. The instances use
 * the same cells, heights and footprints as sim/terrain.ts solidHulls (what the physics collides
 * with). The ground disc is left flat under them (see terrainHeightNode's `near` exclusion) and
 * keeps its displacement only beyond the range.
 *
 * Light defines the structure (Rule 2): every edge (ridgelines, base outline, mesa rim) glows
 * orange to red with height, amber square contours every 40 m, dark faces under the faint
 * electric-blue survey grid: the same look cityGround gives the far Off-Grid on the disc.
 */
const C = PLANET.circumference;
/** Cells whose centre is within this distance (m) of the anchor are drawn as instances. */
export const OFFGRID_RANGE = 8000;
/** Lattice cells examined per frame while rebuilding. */
const CELLS_PER_FRAME = 4000;
/** Mesa top half-size as a fraction of the base half-size (terrain.ts: mesa = 0.6). */
const MESA_TOP = 1 - 0.6;
const LATTICES = [
  { n: TERRAIN.bigCells, seed: 101, scale: 1 },
  { n: TERRAIN.smallCells, seed: 211, scale: 0.3 },
] as const;
const mod = (v: number, m: number) => ((v % m) + m) % m;

/** Upper bound on cells in range for one lattice (the square around the range circle). */
function maxCells(n: number): number {
  const side = 2 * Math.ceil(OFFGRID_RANGE / (C / n)) + 3;
  return side * side;
}
const CAPACITY = LATTICES.reduce((a, l) => a + maxCells(l.n), 0);

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
  return g;
}

function solidMaterial(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  const p: TslNode = flatWorld;
  const h: TslNode = max(p.y, float(0));
  // Edges: anti-aliased ~1.6 px lines where any barycentric reaches 0.
  const e: TslNode = attribute('edge', 'vec3');
  const w: TslNode = max(fwidth(e), float(1e-5)).mul(1.6);
  const d: TslNode = e.div(w);
  const edges: TslNode = float(1).sub(smoothstep(float(0.5), float(1.5), min(min(d.x, d.y), d.z)));
  // Amber square contours every 40 m from the flat world height.
  const t: TslNode = fract(h.div(40));
  const contour: TslNode = float(1).sub(smoothstep(0, max(fwidth(h.div(40)).mul(1.5), float(0.02)), min(t, float(1).sub(t)))).mul(smoothstep(2, 10, h));
  const hot: TslNode = mix(color('#ff8a1f'), color('#ff2a1a'), smoothstep(60, 300, h));
  const survey: TslNode = gridLines(p.xz, 50, 1).mul(0.35);
  mat.colorNode = mix(color('#010208'), color('#06102a'), smoothstep(0, 250, h))
    .add(color('#1f6bff').mul(survey))
    .add(color('#ffb347').mul(contour.mul(0.9)))
    .add(hot.mul(edges.mul(2.6)));
  return mat;
}


export class OffGridView {
  /**
   * Uniforms the ground disc reads to stay flat under the instanced solids: the canonical
   * anchor (x, z) of the shown set and the radius (m) within which cell centres are instanced.
   */
  readonly exclusion = { anchor: uniform(new THREE.Vector2()), radius: uniform(-1) };
  private readonly pyramids: THREE.InstancedMesh;
  private readonly mesas: THREE.InstancedMesh;
  /** Anchor of the shown set (canonical big-cell centre), NaN before the first build. */
  private shownX = NaN;
  private shownZ = NaN;
  // The set being built: anchor, cell cursor and staged instance matrices.
  private build: {
    ax: number; az: number; lattice: number; ix: number; iz: number;
    pyr: Float32Array; pyrN: number; mesa: Float32Array; mesaN: number;
  } | null = null;

  constructor(scene: THREE.Scene) {
    const mat = solidMaterial();
    this.pyramids = new THREE.InstancedMesh(unitSolid(0), mat, CAPACITY);
    this.mesas = new THREE.InstancedMesh(unitSolid(MESA_TOP), mat, CAPACITY);
    for (const m of [this.pyramids, this.mesas]) {
      m.count = 0;
      m.frustumCulled = false; // bent by curvature and spread over the whole range
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.name = 'off-grid-solids';
      scene.add(m);
    }
  }

  /** Follow the camera: rebuild when it enters another big cell, a slice per frame. */
  update(camera: THREE.Vector3): void {
    const big = C / TERRAIN.bigCells;
    const ax = (Math.floor(mod(camera.x, C) / big) + 0.5) * big;
    const az = (Math.floor(mod(camera.z, C) / big) + 0.5) * big;
    const target = this.build ?? { ax: this.shownX, az: this.shownZ };
    if (ax !== target.ax || az !== target.az) {
      this.build = { ax, az, lattice: 0, ix: NaN, iz: NaN, pyr: this.build?.pyr ?? new Float32Array(CAPACITY * 16), pyrN: 0, mesa: this.build?.mesa ?? new Float32Array(CAPACITY * 16), mesaN: 0 };
    }
    if (this.build) this.step(this.build);
    // Place the shown set at the whole-circumference image nearest the camera.
    if (!Number.isNaN(this.shownX)) {
      const ox = this.shownX + Math.round((camera.x - this.shownX) / C) * C;
      const oz = this.shownZ + Math.round((camera.z - this.shownZ) / C) * C;
      this.pyramids.position.set(ox, 0, oz);
      this.mesas.position.set(ox, 0, oz);
    }
  }

  private step(b: NonNullable<OffGridView['build']>): void {
    let budget = CELLS_PER_FRAME;
    while (b.lattice < LATTICES.length && budget > 0) {
      const { n, seed, scale } = LATTICES[b.lattice];
      const cell = C / n;
      const reach = Math.ceil(OFFGRID_RANGE / cell) + 1;
      const ci = Math.floor(b.ax / cell), cj = Math.floor(b.az / cell);
      if (Number.isNaN(b.ix)) {
        b.ix = ci - reach;
        b.iz = cj - reach;
      }
      for (; b.ix <= ci + reach && budget > 0; b.ix++, b.iz = cj - reach) {
        for (; b.iz <= cj + reach && budget > 0; b.iz++, budget--) {
          // Cell centre in the anchor's frame (indices unwrapped, so continuous around it).
          const cx = (b.ix + 0.5) * cell, cz = (b.iz + 0.5) * cell;
          if (Math.hypot(cx - b.ax, cz - b.az) >= OFFGRID_RANGE) continue;
          const s = solidCell(b.ix, b.iz, n, seed);
          if (!s) continue;
          const H = s.height * scale * TERRAIN.peak;
          if (H < 0.5) continue; // solidHulls skips these too
          const base = 0.45 * cell;
          const pyramid = s.mesa >= 1;
          const arr = pyramid ? b.pyr : b.mesa;
          const o = (pyramid ? b.pyrN++ : b.mesaN++) * 16;
          // Scale (base, H, base) then translate, relative to the anchor (column-major).
          arr.fill(0, o, o + 16);
          arr[o] = base;
          arr[o + 5] = H;
          arr[o + 10] = base;
          arr[o + 12] = cx - b.ax;
          arr[o + 14] = cz - b.az;
          arr[o + 15] = 1;
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
    this.pyramids.instanceMatrix.array.set(b.pyr.subarray(0, b.pyrN * 16));
    this.mesas.instanceMatrix.array.set(b.mesa.subarray(0, b.mesaN * 16));
    this.pyramids.count = b.pyrN;
    this.mesas.count = b.mesaN;
    this.pyramids.instanceMatrix.needsUpdate = true;
    this.mesas.instanceMatrix.needsUpdate = true;
    this.shownX = b.ax;
    this.shownZ = b.az;
    this.exclusion.anchor.value.set(b.ax, b.az);
    // A hair inside the instanced range: a borderline cell is drawn twice rather than not at all.
    this.exclusion.radius.value = OFFGRID_RANGE - 2;
    this.build = null;
  }

  /** Number of instanced solids shown (tests, debugging). */
  get count(): number {
    return this.pyramids.count + this.mesas.count;
  }
}
