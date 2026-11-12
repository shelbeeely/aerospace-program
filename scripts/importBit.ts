/**
 * Converts the Bit figure meshes (assets/bit/*.stl, ASCII STL) into src/people/bitShapes.json:
 * welded vertices and triangle indices, centred, Y-up and scaled to a unit circumradius.
 * Run with `npm run import-bit`.
 *
 * Source: "BIT" by Fernando Jerez, CC-BY 4.0 (polyhedra from Kit Wallace's OpenSCAD generator,
 * George Hart's stellations of the icosahedron and David McCooey's coordinates).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const CREDIT = '"BIT" by Fernando Jerez, licensed under CC-BY 4.0 (http://creativecommons.org/licenses/by/4.0/)';
const FILES = { yes: 'bit_yes_up.stl', no: 'bit_no.stl', idle1: 'bit_idle_1.stl', idle2: 'bit_idle_2.stl' } as const;

function convert(file: string) {
  const text = readFileSync(`assets/bit/${file}`, 'utf8');
  const raw: number[][] = [];
  for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) raw.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  if (!raw.length || raw.length % 3) throw new Error(`${file}: not an ASCII STL of triangles`);
  // Centre on the bounding box (the solids are symmetric), then Z-up (print bed) to Y-up.
  const lo = [0, 1, 2].map((k) => Math.min(...raw.map((v) => v[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...raw.map((v) => v[k])));
  const c = lo.map((l, k) => (l + hi[k]) / 2);
  const pts = raw.map((v) => [v[0] - c[0], v[2] - c[2], -(v[1] - c[1])]);
  const radius = Math.max(...pts.map((p) => Math.hypot(p[0], p[1], p[2])));
  const key = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  const tri: number[] = [];
  for (const p of pts) {
    const q = p.map((x) => Math.round((x / radius) * 1e4) / 1e4 + 0);
    const k = q.join(',');
    let i = key.get(k);
    if (i === undefined) { i = positions.length / 3; key.set(k, i); positions.push(...q); }
    tri.push(i);
    if (tri.length === 3) {
      if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) indices.push(...tri);
      tri.length = 0;
    }
  }
  return { positions, indices, size: hi.map((h, k) => Math.round((h - lo[k]) * 100) / 100) };
}

const shapes: Record<string, { positions: number[]; indices: number[] }> = {};
for (const [name, file] of Object.entries(FILES)) {
  const { positions, indices, size } = convert(file);
  shapes[name] = { positions, indices };
  console.log(`${name.padEnd(6)} ${file.padEnd(16)} ${positions.length / 3} vertices, ${indices.length / 3} triangles, source ${size.join(' x ')} mm`);
}
writeFileSync('src/people/bitShapes.json', JSON.stringify({ credit: CREDIT, shapes }) + '\n');
