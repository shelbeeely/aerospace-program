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
  const index = new Uint32Array(n);
  for (let i = 0; i < n; i++) index[i] = i;

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
    vertexStart: vertexOffset, vertexCount: n, indexStart: indexOffset, indexCount: n, groups,
  });
  posChunks.push(pos);
  idxChunks.push(index.map((i) => i + vertexOffset));
  vertexOffset += n;
  indexOffset += n;
  console.log(`${name.padEnd(20)} ${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)}  grid ${W}×${H}×${D}  ${filled} solid cells  ${boxes.length} boxes  ${n} verts`);
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
