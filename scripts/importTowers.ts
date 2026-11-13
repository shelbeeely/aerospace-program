// @ts-nocheck -- build-time Node script (no @types/node in this project); run via npm run import-towers.
/**
 * One-off importer for the "Tron Buildings 1" tower kit (assets/towerKit/scene.gltf, by
 * SpringSociety, CC-BY-4.0: credited in the README and in game). Run with `npm run import-towers`.
 *
 * For each Tower_* node it bakes the skinned meshes into static geometry, makes it Y-up with
 * its base on the ground and centred, and writes:
 *  - public/models/towerKit.bin: positions (Float32) + indices (Uint32) for every tower;
 *  - src/world/towerKit.json: per tower its size, material groups, its BLOCK GRID (a voxel
 *    bitset: which cubic cells are solid, from point-in-mesh tests along four directions plus
 *    the shell cells the surface passes through) and greedy collider boxes over those cells.
 * The game then treats each placed tower exactly like every other structure: static boxes while
 * intact, a block grid that fractures (crater, BFS anchor check, falling top) when hit.
 */
import { readFileSync, writeFileSync } from 'node:fs';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Buffer: any;
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// three's FileLoader reports progress with ProgressEvent, which Node lacks.
(globalThis as { ProgressEvent?: unknown }).ProgressEvent ??= class extends Event {
  constructor(type: string, init?: Record<string, unknown>) { super(type); Object.assign(this, init ?? {}); }
};

const SRC = 'assets/towerKit/scene.gltf';
const FLOORS = 30; // grid cells over the tower's height

const json = JSON.parse(readFileSync(SRC, 'utf8'));
const bin = readFileSync('assets/towerKit/scene.bin');
json.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gltf: { scene: THREE.Group } = await new Promise((resolve, reject) => (new GLTFLoader() as any).parse(JSON.stringify(json), '', resolve, reject));
const scene = gltf.scene;
scene.updateMatrixWorld(true);

const ROLES: Record<string, string> = {
  metal: 'metal', metal_light: 'metalLight', building_glow: 'glow', emissive: 'emissive', light_strip: 'strip',
  walls: 'walls', floor_hex: 'floor', glass: 'glass',
};
const ROLE_LIST = ['metal', 'metalLight', 'glow', 'emissive', 'strip', 'walls', 'floor', 'glass'];

interface Raw { tris: number[]; roles: number[] }
const towers = new Map<string, Raw>();
scene.traverse((o) => {
  const mesh = o as THREE.Mesh;
  if (!mesh.isMesh) return;
  let n: THREE.Object3D | null = mesh;
  while (n && !/^Tower_/.test(n.name)) n = n.parent;
  if (!n) return;
  const name = n.name.replace(/_ARM$/, '');
  const raw = towers.get(name) ?? { tris: [], roles: [] };
  towers.set(name, raw);
  const geo = mesh.geometry as THREE.BufferGeometry;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const idx = geo.getIndex();
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count: idx ? idx.count : pos.count, materialIndex: 0 }];
  const v = new THREE.Vector3();
  const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh;
  const world = (i: number) => {
    v.fromBufferAttribute(pos, i);
    if (skinned) (mesh as THREE.SkinnedMesh).applyBoneTransform(i, v);
    return v.applyMatrix4(mesh.matrixWorld);
  };
  for (const g of groups) {
    const mat = mats[g.materialIndex ?? 0] as THREE.Material;
    const role = ROLE_LIST.indexOf(ROLES[mat.name] ?? 'metal');
    for (let k = g.start; k < g.start + g.count; k += 3) {
      for (let j = 0; j < 3; j++) {
        const p = world(idx ? idx.getX(k + j) : k + j);
        raw.tris.push(p.x, p.y, p.z);
      }
      raw.roles.push(role);
    }
  }
});

// Which axis is up? Towers are much taller than wide: the longest extent overall is "up".
const all = new THREE.Box3();
for (const r of towers.values()) for (let i = 0; i < r.tris.length; i += 3) all.expandByPoint(new THREE.Vector3(r.tris[i], r.tris[i + 1], r.tris[i + 2]));
const tall = [...towers.entries()].filter(([n]) => /^Tower_0\d$/.test(n));
const ext = new THREE.Vector3();
for (const [, r] of tall) {
  const b = new THREE.Box3();
  for (let i = 0; i < r.tris.length; i += 3) b.expandByPoint(new THREE.Vector3(r.tris[i], r.tris[i + 1], r.tris[i + 2]));
  const s = b.getSize(new THREE.Vector3());
  ext.add(s);
}
const upAxis = ext.x > ext.y && ext.x > ext.z ? 0 : ext.z > ext.y ? 2 : 1;
console.log('up axis', 'xyz'[upAxis], 'mean extents', ext.toArray().map((x) => (x / tall.length).toFixed(1)).join(' '));
const toYUp = (x: number, y: number, z: number): [number, number, number] =>
  upAxis === 1 ? [x, y, z] : upAxis === 2 ? [x, z, -y] : [y, x, -z];

const out: Array<Record<string, unknown>> = [];
const posChunks: Float32Array[] = [];
const idxChunks: Uint32Array[] = [];
let vertexOffset = 0;
let indexOffset = 0;

// Only the free-standing towers are placed in the city.
for (const [name, raw] of [...towers.entries()].filter(([n]) => /^Tower_(0\d|Construction)$/.test(n)).sort()) {
  // Y-up, base on the ground, centred in X/Z.
  const n = raw.tris.length / 3;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = toYUp(raw.tris[i * 3], raw.tris[i * 3 + 1], raw.tris[i * 3 + 2]);
    p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
  }
  const box = new THREE.Box3();
  for (let i = 0; i < n; i++) box.expandByPoint(new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]));
  const c = box.getCenter(new THREE.Vector3());
  for (let i = 0; i < n; i++) { p[i * 3] -= c.x; p[i * 3 + 1] -= box.min.y; p[i * 3 + 2] -= c.z; }
  const size = box.getSize(new THREE.Vector3());

  // Sort triangles by role into contiguous groups; weld nothing (flat-shaded look).
  const order = [...Array(n / 3).keys()].sort((a, b) => raw.roles[a] - raw.roles[b]);
  const pos = new Float32Array(n * 3);
  const groups: Array<{ role: string; start: number; count: number }> = [];
  order.forEach((t, k) => {
    pos.set(p.subarray(t * 9, t * 9 + 9), k * 9);
    const role = ROLE_LIST[raw.roles[t]];
    const last = groups[groups.length - 1];
    if (last && last.role === role) last.count += 3;
    else groups.push({ role, start: k * 3, count: 3 });
  });

  // --- Block grid (voxels).
  const cell = Math.max(size.y / FLOORS, Math.max(size.x, size.z) / 24);
  const W = Math.max(1, Math.ceil(size.x / cell));
  const H = Math.max(1, Math.ceil(size.y / cell));
  const D = Math.max(1, Math.ceil(size.z / cell));
  const x0 = -(W * cell) / 2;
  const z0 = -(D * cell) / 2;
  const solid = new Uint8Array(W * H * D);
  const at = (x: number, y: number, z: number) => (y * D + z) * W + x;
  // Shell: every cell a triangle passes through (sample points on each triangle).
  const tri = (t: number, j: number) => pos.subarray(t * 9 + j * 3, t * 9 + j * 3 + 3);
  for (let t = 0; t < n / 3; t++) {
    const a = tri(t, 0), b = tri(t, 1), cc = tri(t, 2);
    const len = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]));
    const steps = Math.max(1, Math.ceil((len / cell) * 2));
    for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps - i; j++) {
      const u = i / steps, w = j / steps;
      const px = a[0] + (b[0] - a[0]) * u + (cc[0] - a[0]) * w;
      const py = a[1] + (b[1] - a[1]) * u + (cc[1] - a[1]) * w;
      const pz = a[2] + (b[2] - a[2]) * u + (cc[2] - a[2]) * w;
      const gx = Math.floor((px - x0) / cell), gy = Math.min(H - 1, Math.floor(py / cell)), gz = Math.floor((pz - z0) / cell);
      if (gx >= 0 && gx < W && gy >= 0 && gz >= 0 && gz < D) solid[at(gx, gy, gz)] = 1;
    }
  }
  // Interior: per horizontal row, parity of crossings along ±X and ±Z (majority of 4 rays).
  const triY = (t: number) => [Math.min(tri(t, 0)[1], tri(t, 1)[1], tri(t, 2)[1]), Math.max(tri(t, 0)[1], tri(t, 1)[1], tri(t, 2)[1])];
  const rows: number[][] = Array.from({ length: H }, () => []);
  for (let t = 0; t < n / 3; t++) {
    const [lo, hi] = triY(t);
    for (let y = Math.max(0, Math.floor(lo / cell - 0.5)); y <= Math.min(H - 1, Math.ceil(hi / cell + 0.5)); y++) rows[y].push(t);
  }
  const hits = (ox: number, oy: number, oz: number, dx: number, dz: number, list: number[]) => {
    let k = 0;
    for (const t of list) if (rayTri(ox, oy, oz, dx, 0, dz, tri(t, 0), tri(t, 1), tri(t, 2))) k++;
    return k;
  };
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    if (solid[at(x, y, z)]) continue;
    const ox = x0 + (x + 0.5) * cell, oy = (y + 0.5) * cell + 1e-3, oz = z0 + (z + 0.5) * cell;
    const odd = [hits(ox, oy, oz, 1, 0, rows[y]), hits(ox, oy, oz, -1, 0, rows[y]), hits(ox, oy, oz, 0, 1, rows[y]), hits(ox, oy, oz, 0, -1, rows[y])].filter((k) => k % 2 === 1).length;
    if (odd >= 3) solid[at(x, y, z)] = 1;
  }

  // --- A room for the people who live in it, cut into the ground floor (see cutRoom).
  const room = cutRoom(name, solid, W, H, D, cell, x0, z0, at);
  let n2 = n, pos2 = pos, groups2 = groups;
  if (room) {
    // Re-cut the mesh: what lies in the room and its doorways goes (big faces are split until the
    // part inside can be dropped), and the room's own faces go in.
    const tris: Array<{ p: number[]; role: number }> = [];
    for (const g of groups) for (let k = g.start; k < g.start + g.count; k += 3) tris.push({ p: Array.from(pos.subarray(k * 3, k * 3 + 9)), role: ROLE_LIST.indexOf(g.role) });
    const kept: Array<{ p: number[]; role: number }> = [];
    for (const t of tris) clipOut(t.p, t.role, room.cuts, kept, 0);
    for (const f of room.faces) kept.push(f);
    kept.sort((a, b) => a.role - b.role);
    n2 = kept.length * 3;
    pos2 = new Float32Array(n2 * 3);
    groups2 = [];
    kept.forEach((t, k) => {
      pos2.set(t.p, k * 9);
      const role = ROLE_LIST[t.role];
      const last = groups2[groups2.length - 1];
      if (last && last.role === role) last.count += 3;
      else groups2.push({ role, start: k * 3, count: 3 });
    });
  }
  const index2 = new Uint32Array(n2);
  for (let i = 0; i < n2; i++) index2[i] = i;

  // --- Greedy boxes over solid cells (colliders while intact).
  const used = new Uint8Array(solid.length);
  const boxes: number[][] = [];
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    if (!solid[at(x, y, z)] || used[at(x, y, z)]) continue;
    let x1 = x; while (x1 + 1 < W && solid[at(x1 + 1, y, z)] && !used[at(x1 + 1, y, z)]) x1++;
    let z1 = z; outer: while (z1 + 1 < D) { for (let i = x; i <= x1; i++) if (!solid[at(i, y, z1 + 1)] || used[at(i, y, z1 + 1)]) break outer; z1++; }
    let y1 = y; up: while (y1 + 1 < H) { for (let k = z; k <= z1; k++) for (let i = x; i <= x1; i++) if (!solid[at(i, y1 + 1, k)] || used[at(i, y1 + 1, k)]) break up; y1++; }
    for (let yy = y; yy <= y1; yy++) for (let k = z; k <= z1; k++) for (let i = x; i <= x1; i++) used[at(i, yy, k)] = 1;
    boxes.push([x, y, z, x1 + 1, y1 + 1, z1 + 1]);
  }
  let filled = 0;
  for (const v of solid) filled += v;
  const bits = new Uint8Array(Math.ceil(solid.length / 8));
  solid.forEach((v, i) => { if (v) bits[i >> 3] |= 1 << (i & 7); });

  out.push({
    name, size: [size.x, size.y, size.z].map((v) => +v.toFixed(3)), cell: +cell.toFixed(4), grid: [W, H, D],
    voxels: Buffer.from(bits).toString('base64'), boxes,
    vertexStart: vertexOffset, vertexCount: n2, indexStart: indexOffset, indexCount: n2, groups: groups2,
    ...(room ? { room: room.info } : {}),
  });
  posChunks.push(pos2);
  idxChunks.push(index2.map((i) => i + vertexOffset));
  vertexOffset += n2;
  indexOffset += n2;
  console.log(`${name.padEnd(20)} ${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)}  grid ${W}×${H}×${D}  ${filled} solid cells  ${boxes.length} boxes  ${n2} verts${room ? `  room ${room.summary}` : '  no room'}`);
}

const totalPos = posChunks.reduce((a, c) => a + c.length, 0);
const buf = Buffer.alloc(totalPos * 4 + indexOffset * 4);
let o = 0;
for (const c of posChunks) { Buffer.from(c.buffer, c.byteOffset, c.byteLength).copy(buf, o); o += c.byteLength; }
for (const c of idxChunks) { Buffer.from(c.buffer, c.byteOffset, c.byteLength).copy(buf, o); o += c.byteLength; }
writeFileSync('public/models/towerKit.bin', buf);
writeFileSync('src/world/towerKit.json', JSON.stringify({
  credit: 'This work is based on "Tron Buildings 1" (https://sketchfab.com/3d-models/tron-buildings-1-88ca3618bfbe42dea14f5b438250c9e2) by SpringSociety (https://sketchfab.com/jcreadingtutor) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)',
  positionBytes: totalPos * 4, indexBytes: indexOffset * 4, towers: out,
}));
console.log(`wrote public/models/towerKit.bin (${(buf.length / 1024).toFixed(0)} KB) and src/world/towerKit.json`);

/** Möller–Trumbore ray / triangle test (t > 0). */
function rayTri(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, a: Float32Array, b: Float32Array, c: Float32Array): boolean {
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return false;
  const inv = 1 / det;
  const tx = ox - a[0], ty = oy - a[1], tz = oz - a[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  return (e2x * qx + e2y * qy + e2z * qz) * inv > 1e-6;
}

interface Box6 { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }
interface CutRoom {
  cuts: Box6[];
  faces: Array<{ p: number[]; role: number }>;
  info: Record<string, unknown>;
  summary: string;
}

/**
 * Choose and cut the ground-floor room of a tower: the largest rectangle of cells that is solid
 * from the ground up through a ceiling layer, keeping one cell of wall all round; a doorway in
 * the middle of each side whose wall leads out to open ground within three cells (two doors at
 * most, an opposite pair if there is one). Clears those cells from the voxel grid and returns
 * the boxes to cut out of the mesh, the faces that line the room and its doorways (facing in),
 * a lit frame round each doorway, and the room for the game (local metres, centred like the mesh).
 */
function cutRoom(name: string, solid: Uint8Array, W: number, H: number, D: number, cell: number, x0: number, z0: number, at: (x: number, y: number, z: number) => number): CutRoom | null {
  const hr = Math.max(2, Math.min(H - 2, Math.round(6.5 / cell))); // room height in cells; layer hr is the ceiling
  const full = (x: number, z: number) => { for (let y = 0; y <= hr; y++) if (!solid[at(x, y, z)]) return false; return true; };
  const F = new Uint8Array(W * D);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) F[z * W + x] = full(x, z) ? 1 : 0;
  // The largest rectangle of full columns (with its interior at least 2 × 2 cells).
  let best: { a: number; b: number; c: number; d: number; area: number } | null = null;
  for (let a = 0; a < W; a++) for (let c = 0; c < D; c++) for (let b = a + 3; b < W; b++) for (let d = c + 3; d < D; d++) {
    const area = (b - a - 1) * (d - c - 1);
    if (best && area <= best.area) continue;
    let ok = true;
    for (let z = c; z <= d && ok; z++) for (let x = a; x <= b && ok; x++) if (!F[z * W + x]) ok = false;
    if (ok) best = { a, b, c, d, area };
  }
  if (!best) return null;
  const { a, b, c, d } = best;
  // Doorways: in the middle of each side, through the wall to open ground.
  const dw = Math.max(1, Math.min(Math.round(4 / cell), 2));
  const dh = Math.max(2, hr - 1);
  type Door = { side: number; lo: number; hi: number; len: number };
  const doors: Door[] = [];
  for (let side = 0; side < 4; side++) {
    const alongX = side % 2 === 1; // doors in the ±z walls run along x
    const span0 = alongX ? a + 1 : c + 1, span1 = alongX ? b - 1 : d - 1;
    if (span1 - span0 + 1 < dw) continue;
    const lo = Math.floor((span0 + span1 + 1 - dw) / 2), hi = lo + dw - 1;
    const ux = side === 0 ? 1 : side === 2 ? -1 : 0, uz = side === 1 ? 1 : side === 3 ? -1 : 0;
    const wall = side === 0 ? b : side === 2 ? a : side === 1 ? d : c;
    // Is the doorway's cross-section open at row p (outside the grid counts as open)?
    const openAt = (p: number) => {
      const inGrid = alongX ? p >= 0 && p < D : p >= 0 && p < W;
      if (!inGrid) return true;
      for (let q = lo; q <= hi; q++) for (let y = 0; y < dh; y++) if (solid[alongX ? at(q, y, p) : at(p, y, q)]) return false;
      return true;
    };
    let len = -1;
    for (let k = 1; k <= 3; k++) if (openAt(wall + k * (ux + uz))) { len = k; break; }
    if (len < 0) continue;
    // And clear from there all the way out of the tower (no fin or plinth further out in the way).
    let clear = true;
    for (let p = wall + len * (ux + uz); p >= -1 && p <= (alongX ? D : W) && clear; p += ux + uz) if (!openAt(p)) clear = false;
    if (clear) doors.push({ side, lo, hi, len });
  }
  if (!doors.length) return null;
  let use = doors;
  if (use.length > 2) {
    const pair = [[0, 2], [1, 3]].find(([p, q]) => use.some((o) => o.side === p) && use.some((o) => o.side === q));
    use = pair ? use.filter((o) => pair.includes(o.side)) : use.slice(0, 2);
  }
  // Clear the room and the doorways from the grid.
  for (let y = 0; y < hr; y++) for (let z = c + 1; z <= d - 1; z++) for (let x = a + 1; x <= b - 1; x++) solid[at(x, y, z)] = 0;
  const X = (i: number) => x0 + i * cell, Z = (i: number) => z0 + i * cell;
  const cuts: Box6[] = [{ x0: X(a + 1), x1: X(b), y0: -0.5, y1: hr * cell, z0: Z(c + 1), z1: Z(d) }];
  for (const o of use) {
    const ux = o.side === 0 ? 1 : o.side === 2 ? -1 : 0, uz = o.side === 1 ? 1 : o.side === 3 ? -1 : 0;
    const wall = o.side === 0 ? b : o.side === 2 ? a : o.side === 1 ? d : c;
    for (let k = 0; k < o.len; k++) for (let y = 0; y < dh; y++) for (let q = o.lo; q <= o.hi; q++) {
      const p = wall + k * (ux + uz);
      if (o.side % 2 === 1) solid[at(q, y, p)] = 0; else solid[at(p, y, q)] = 0;
    }
    // The doorway's box, reaching half a cell past the outer face so the façade there is cut too.
    const inner = ux + uz > 0 ? wall : wall + 1, outer = ux + uz > 0 ? wall + o.len : wall + 1 - o.len;
    const p0 = Math.min(inner, outer) - (ux + uz < 0 ? 0.5 : 0), p1 = Math.max(inner, outer) + (ux + uz > 0 ? 0.5 : 0);
    if (o.side % 2 === 1) cuts.push({ x0: X(o.lo), x1: X(o.hi + 1), y0: -0.5, y1: dh * cell, z0: Z(p0), z1: Z(p1) });
    else cuts.push({ x0: X(p0), x1: X(p1), y0: -0.5, y1: dh * cell, z0: Z(o.lo), z1: Z(o.hi + 1) });
  }
  // The faces that line the room (facing in), cell by cell, leaving the doorways open.
  const faces: Array<{ p: number[]; role: number }> = [];
  const METAL = ROLE_LIST.indexOf('metal'), GLOW = ROLE_LIST.indexOf('glow'), FLOOR = ROLE_LIST.indexOf('floor');
  const quad = (q: number[][], nrm: number[], role: number) => {
    // Wind so the face looks along nrm.
    const [A, B, C, D2] = q;
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const flip = cr[0] * nrm[0] + cr[1] * nrm[1] + cr[2] * nrm[2] < 0;
    const t1 = flip ? [A, C, B] : [A, B, C], t2 = flip ? [A, D2, C] : [A, C, D2];
    faces.push({ p: t1.flat(), role }, { p: t2.flat(), role });
  };
  const doorAt = (side: number, q: number, y: number) => use.some((o) => o.side === side && q >= o.lo && q <= o.hi && y < dh);
  const yt = hr * cell;
  for (let y = 0; y < hr; y++) {
    const ya = y * cell, yb = (y + 1) * cell;
    for (let q = c + 1; q <= d - 1; q++) {
      if (!doorAt(0, q, y)) quad([[X(b), ya, Z(q)], [X(b), ya, Z(q + 1)], [X(b), yb, Z(q + 1)], [X(b), yb, Z(q)]], [-1, 0, 0], METAL);
      if (!doorAt(2, q, y)) quad([[X(a + 1), ya, Z(q)], [X(a + 1), ya, Z(q + 1)], [X(a + 1), yb, Z(q + 1)], [X(a + 1), yb, Z(q)]], [1, 0, 0], METAL);
    }
    for (let q = a + 1; q <= b - 1; q++) {
      if (!doorAt(1, q, y)) quad([[X(q), ya, Z(d)], [X(q + 1), ya, Z(d)], [X(q + 1), yb, Z(d)], [X(q), yb, Z(d)]], [0, 0, -1], METAL);
      if (!doorAt(3, q, y)) quad([[X(q), ya, Z(c + 1)], [X(q + 1), ya, Z(c + 1)], [X(q + 1), yb, Z(c + 1)], [X(q), yb, Z(c + 1)]], [0, 0, 1], METAL);
    }
  }
  quad([[X(a + 1), yt, Z(c + 1)], [X(b), yt, Z(c + 1)], [X(b), yt, Z(d)], [X(a + 1), yt, Z(d)]], [0, -1, 0], METAL);
  quad([[X(a + 1), 0.05, Z(c + 1)], [X(b), 0.05, Z(c + 1)], [X(b), 0.05, Z(d)], [X(a + 1), 0.05, Z(d)]], [0, 1, 0], FLOOR);
  // Light that says what the room is for (§5): a lit band round the walls under the ceiling,
  // and a line on the floor from each doorway to the middle.
  const STRIP = ROLE_LIST.indexOf('strip');
  const band = 0.35, yb0 = yt - 0.9, yb1 = yb0 + band;
  quad([[X(b) - 0.03, yb0, Z(c + 1)], [X(b) - 0.03, yb0, Z(d)], [X(b) - 0.03, yb1, Z(d)], [X(b) - 0.03, yb1, Z(c + 1)]], [-1, 0, 0], STRIP);
  quad([[X(a + 1) + 0.03, yb0, Z(c + 1)], [X(a + 1) + 0.03, yb0, Z(d)], [X(a + 1) + 0.03, yb1, Z(d)], [X(a + 1) + 0.03, yb1, Z(c + 1)]], [1, 0, 0], STRIP);
  quad([[X(a + 1), yb0, Z(d) - 0.03], [X(b), yb0, Z(d) - 0.03], [X(b), yb1, Z(d) - 0.03], [X(a + 1), yb1, Z(d) - 0.03]], [0, 0, -1], STRIP);
  quad([[X(a + 1), yb0, Z(c + 1) + 0.03], [X(b), yb0, Z(c + 1) + 0.03], [X(b), yb1, Z(c + 1) + 0.03], [X(a + 1), yb1, Z(c + 1) + 0.03]], [0, 0, 1], STRIP);
  const mx = (X(a + 1) + X(b)) / 2, mz = (Z(c + 1) + Z(d)) / 2;
  for (const o of use) {
    const lat = (o.lo + o.hi + 1) / 2;
    const lw = 0.3;
    if (o.side % 2 === 1) { const xl = X(lat), zf = o.side === 1 ? Z(d) : Z(c + 1); quad([[xl - lw, 0.07, Math.min(zf, mz)], [xl + lw, 0.07, Math.min(zf, mz)], [xl + lw, 0.07, Math.max(zf, mz)], [xl - lw, 0.07, Math.max(zf, mz)]], [0, 1, 0], STRIP); }
    else { const zl = Z(lat), xf = o.side === 0 ? X(b) : X(a + 1); quad([[Math.min(xf, mx), 0.07, zl - lw], [Math.max(xf, mx), 0.07, zl - lw], [Math.max(xf, mx), 0.07, zl + lw], [Math.min(xf, mx), 0.07, zl + lw]], [0, 1, 0], STRIP); }
  }
  const infoDoors: Array<Record<string, number>> = [];
  for (const o of use) {
    const ux = o.side === 0 ? 1 : o.side === 2 ? -1 : 0, uz = o.side === 1 ? 1 : o.side === 3 ? -1 : 0;
    const wall = o.side === 0 ? b : o.side === 2 ? a : o.side === 1 ? d : c;
    const inner = ux + uz > 0 ? wall : wall + 1, outer = ux + uz > 0 ? wall + o.len : wall + 1 - o.len;
    const yd = dh * cell;
    // Tunnel: its two sides and its ceiling, facing into it.
    const P = (along: number, lat: number, y: number) => (o.side % 2 === 1 ? [X(lat), y, Z(along)] : [X(along), y, Z(lat)]);
    const latN = o.side % 2 === 1 ? [1, 0, 0] : [0, 0, 1];
    quad([P(inner, o.lo, 0), P(outer, o.lo, 0), P(outer, o.lo, yd), P(inner, o.lo, yd)], latN, METAL);
    quad([P(inner, o.hi + 1, 0), P(outer, o.hi + 1, 0), P(outer, o.hi + 1, yd), P(inner, o.hi + 1, yd)], latN.map((v) => -v), METAL);
    quad([P(inner, o.lo, yd), P(outer, o.lo, yd), P(outer, o.hi + 1, yd), P(inner, o.hi + 1, yd)], [0, -1, 0], METAL);
    // The lit frame round the mouth, facing out (entrance light).
    const m = 0.35, f = outer + (ux + uz) * 0.02, nOut = [ux, 0, uz];
    quad([P(f, o.lo - m / cell, yd), P(f, o.hi + 1 + m / cell, yd), P(f, o.hi + 1 + m / cell, yd + m), P(f, o.lo - m / cell, yd + m)], nOut, GLOW);
    for (const e of [o.lo - m / cell, o.hi + 1]) quad([P(f, e, 0), P(f, e + m / cell, 0), P(f, e + m / cell, yd), P(f, e, yd)], nOut, GLOW);
    // For the game: the door at the middle of its tunnel, its way out, size and length.
    const mid = (inner + outer) / 2, lat = (o.lo + o.hi + 1) / 2;
    const [px, , pz] = P(mid, lat, 0);
    infoDoors.push({ side: o.side, x: +px.toFixed(3), z: +pz.toFixed(3), nx: ux, nz: uz, width: +(dw * cell).toFixed(3), height: +yd.toFixed(3), through: +(Math.abs(outer - inner) * cell).toFixed(3) });
  }
  return {
    cuts, faces,
    info: { x0: +X(a + 1).toFixed(3), x1: +X(b).toFixed(3), z0: +Z(c + 1).toFixed(3), z1: +Z(d).toFixed(3), y1: +yt.toFixed(3), doors: infoDoors },
    summary: `${b - a - 1}×${d - c - 1}×${hr} cells, ${use.length} door${use.length > 1 ? 's' : ''}`,
  };
  void name;
}

/**
 * Keep the part of a triangle outside every cut box, exactly: against each box the polygon is
 * split by the box's six planes in turn; what lies outside a plane is kept (it cannot be in the
 * box), and what is left at the end is inside the box and dropped. Pieces stay convex, so they
 * fan into triangles.
 */
function clipOut(p: number[], role: number, cuts: Box6[], out: Array<{ p: number[]; role: number }>, _depth: number): void {
  let pieces: number[][][] = [[p.slice(0, 3), p.slice(3, 6), p.slice(6, 9)]];
  for (const b of cuts) {
    const next: number[][][] = [];
    for (const poly of pieces) {
      const xs = poly.map((v) => v[0]), ys = poly.map((v) => v[1]), zs = poly.map((v) => v[2]);
      if (!(Math.max(...xs) > b.x0 && Math.min(...xs) < b.x1 && Math.max(...ys) > b.y0 && Math.min(...ys) < b.y1 && Math.max(...zs) > b.z0 && Math.min(...zs) < b.z1)) { next.push(poly); continue; }
      let rest = poly;
      // Each plane as (axis, value, sign): "outside" is sign·(v[axis] − value) > 0.
      for (const [ax, val, sg] of [[0, b.x0, -1], [0, b.x1, 1], [1, b.y0, -1], [1, b.y1, 1], [2, b.z0, -1], [2, b.z1, 1]] as Array<[number, number, number]>) {
        const [outside, inside] = split(rest, ax, val, sg);
        if (outside.length >= 3) next.push(outside);
        rest = inside;
        if (rest.length < 3) break;
      }
    }
    pieces = next;
  }
  for (const poly of pieces) for (let k = 1; k + 1 < poly.length; k++) out.push({ p: [...poly[0], ...poly[k], ...poly[k + 1]], role });
}

/** Split a convex polygon by the plane v[ax] = val into the side where sg·(v[ax] − val) > 0 and the rest. */
function split(poly: number[][], ax: number, val: number, sg: number): [number[][], number[][]] {
  const out: number[][] = [], inn: number[][] = [];
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i], B = poly[(i + 1) % poly.length];
    const da = sg * (A[ax] - val), db = sg * (B[ax] - val);
    if (da > 0) out.push(A); else inn.push(A);
    if ((da > 0) !== (db > 0)) {
      const t = da / (da - db);
      const P = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
      out.push(P);
      inn.push(P);
    }
  }
  return [out, inn];
}
