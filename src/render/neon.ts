import * as THREE from 'three/webgpu';
import { flatWorld } from './curvature.ts';
import {
  abs, asin, cameraPosition, clamp, color, cos, distance, dot, exp, float, floor, fract, fwidth, hash, length, max, min, mix,
  normalize, positionLocal, pow, sin, smoothstep, step, uniform, vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';

/**
 * The 1980s neon / synthwave look shared by every view: near-black fills (they write depth, so
 * wireframes hide behind solid objects), HDR-bright edge lines (colour × 3+ so bloom catches
 * them), anti-aliased TSL grids, and a gradient sky with a big striped sun on the horizon.
 */
export const NEON = {
  cyan: '#00eaff',
  magenta: '#ff2bd6',
  pink: '#ff4f9a',
  purple: '#9d4dff',
  violet: '#6a2cff',
  orange: '#ff8a1f',
  yellow: '#ffd23f',
  green: '#3dffb0',
  /** Fill for solid objects: reads as black but keeps a hint of indigo. */
  fill: '#07060f',
  /** Sky gradient (clear night). */
  horizon: '#2b0b4f',
  zenith: '#04010c',
} as const;

/** Inside the Grid: a dark blue digital sky with a faint blue horizon glow, electric-blue grid. */
export const GRID_SKY = {
  horizon: '#0a1c5c',
  zenith: '#000209',
  grid: '#1f6bff',
  band: '#2a7bff',
} as const;

/** Default HDR multiplier for edge lines (> bloom threshold after the line colour's own luminance). */
export const GLOW = 3.2;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TslNode = Node & any;

/** HDR colour: `c` × `k` (linear), so it blooms. */
export function glow(c: THREE.ColorRepresentation, k = GLOW): THREE.Color {
  return new THREE.Color(c).multiplyScalar(k);
}

const _hsl = { h: 0, s: 0, l: 0 };
/**
 * Push an arbitrary (often dull) part colour toward a saturated neon hue of the same family.
 * Greys and near-blacks become cyan so they still read as glowing outlines.
 */
export function neonTint(c: THREE.ColorRepresentation): THREE.Color {
  const out = new THREE.Color(c);
  out.getHSL(_hsl);
  if (_hsl.s < 0.12) {
    // Neutral: light greys/whites → cyan, darker greys → violet.
    return out.set(_hsl.l > 0.45 ? NEON.cyan : NEON.purple);
  }
  out.setHSL(_hsl.h, Math.max(0.85, _hsl.s), 0.55);
  return out;
}

const lineMats = new Map<string, THREE.LineBasicMaterial>();
/**
 * Shared glowing line material for one colour / intensity. Fog applies, so distant lines fade
 * into the purple haze.
 */
export function neonLineMaterial(c: THREE.ColorRepresentation, intensity = GLOW, opts: { fog?: boolean } = {}): THREE.LineBasicMaterial {
  const base = new THREE.Color(c);
  const key = `${base.r},${base.g},${base.b}|${intensity}|${opts.fog ?? true}`;
  let m = lineMats.get(key);
  if (!m) {
    m = new THREE.LineBasicMaterial({ color: base.multiplyScalar(intensity), fog: opts.fog ?? true, toneMapped: true });
    lineMats.set(key, m);
  }
  return m;
}

/** Near-black solid fill, pushed back in depth so the edge lines drawn on it always win. */
export function neonFillMaterial(c: THREE.ColorRepresentation = NEON.fill, opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: c,
    roughness: 0.4,
    metalness: 0.6,
    flatShading: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    ...opts,
  });
}

/**
 * Neon wireframe of a geometry: `LineSegments(EdgesGeometry(geo, thresholdAngle))` in an HDR
 * line colour. The edges geometry is owned by the returned object (dispose it with the object);
 * the material is shared per colour.
 */
export function neonize(
  geo: THREE.BufferGeometry,
  c: THREE.ColorRepresentation,
  opts: { thresholdAngle?: number; intensity?: number; fog?: boolean } = {},
): THREE.LineSegments {
  const edges = new THREE.EdgesGeometry(geo, opts.thresholdAngle ?? 1);
  const lines = new THREE.LineSegments(edges, neonLineMaterial(c, opts.intensity ?? GLOW, { fog: opts.fog }));
  lines.castShadow = false;
  lines.receiveShadow = false;
  return lines;
}

/** A dark-filled mesh with glowing edges as a child (move/hide the mesh, the edges follow). */
export function neonMesh(
  geo: THREE.BufferGeometry,
  c: THREE.ColorRepresentation,
  fill: THREE.Material,
  opts: { thresholdAngle?: number; intensity?: number } = {},
): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, fill);
  mesh.add(neonize(geo, c, opts));
  return mesh;
}

/**
 * Anti-aliased grid lines (0..1) at `spacing` on a 2D coordinate: fract + fwidth gives a line
 * `width` pixels wide at any distance, and fades to its average when the cells shrink below a
 * pixel (no moiré).
 */
export function gridLines(coord: TslNode, spacing: number, width = 1): TslNode {
  const c: TslNode = coord.div(spacing);
  const fw: TslNode = max(fwidth(c), 1e-4);
  const g: TslNode = abs(fract(c.sub(0.5)).sub(0.5)).div(fw);
  const line = float(1).sub(min(min(g.x, g.y).div(width), 1));
  // Where a cell is smaller than a few pixels, blend toward the mean coverage instead of aliasing.
  const shrink = clamp(max(fw.x, fw.y).mul(4).sub(1), 0, 1);
  return mix(line, float(width * 0.5).mul(max(fw.x, fw.y)).min(1), shrink);
}

/**
 * Ground grid colour node: dark base, minor and major cyan lines, faded with distance from the
 * camera so the horizon stays clean. All colours are live `uniform`-backed THREE.Color objects.
 */
export function groundGridNode(
  base: TslNode,
  lineColor: TslNode,
  opts: { minor: number; major: number; fade: number; coord?: TslNode },
): TslNode {
  const p = opts.coord ?? flatWorld.xz;
  const minor = gridLines(p, opts.minor, 1).mul(0.35);
  const major = gridLines(p, opts.major, 1.6);
  const d = distance(flatWorld.xz, cameraPosition.xz);
  const fade = float(1).sub(smoothstep(opts.fade * 0.25, opts.fade, d));
  return base.add(lineColor.mul(max(minor, major).mul(fade)));
}

/**
 * Synthwave sky colour for a dome centred on the camera: horizon → zenith gradient, a thin
 * glowing horizon band, and a big sun sitting on the horizon with the classic horizontal cut
 * stripes in its lower half.
 */
/**
 * The sky seen from the planet: `dip` is sin of how far below eye level the horizon has sunk
 * (acos(R/(R+h))), `space` fades the air to black as the craft leaves the atmosphere.
 * Update `altitude` each frame (main.ts) and call `updateSkyPlanet`.
 */
export const SKY_PLANET = {
  dip: uniform(0),
  space: uniform(0),
  altitude: 0,
  /** The horizon's depression angle acos(R / (R + h)) (rad). */
  dipAngle: uniform(0),
  /** Angular thickness (rad) of the glowing air on the planet's limb as seen from here. */
  limbWidth: uniform(0.02),
  /** 0 near the ground → 1 high up: how much the air shell over the ground shows. */
  shell: uniform(0),
};
/** Visual thickness (m) of the glowing air shell drawn on the limb from altitude. */
const LIMB_AIR = 650;
export function updateSkyPlanet(altitude: number, radius: number): void {
  SKY_PLANET.altitude = altitude;
  const h = Math.max(0, altitude);
  const dip = Math.acos(radius / (radius + h));
  SKY_PLANET.dip.value = Math.sin(dip);
  SKY_PLANET.dipAngle.value = dip;
  // Seen from the tangent distance the shell spans about LIMB_AIR / distance radians; kept
  // between ~1/3° (still a visible line) and the low-altitude horizon band's width.
  const tangent = Math.sqrt(2 * radius * h + h * h);
  SKY_PLANET.limbWidth.value = Math.min(0.05, Math.max(0.006, LIMB_AIR / Math.max(1, tangent)));
  const t = Math.min(1, Math.max(0, (h - 5000) / 25000));
  SKY_PLANET.space.value = t * t * (3 - 2 * t);
  const s = Math.min(1, Math.max(0, (h - 1500) / 8500));
  SKY_PLANET.shell.value = s * s * (3 - 2 * s);
}

/**
 * A sparse, geometric star field on unit direction `d` (rgb): small diamonds in a few percent
 * of the cells of a 3D lattice, each centred on its cell's jittered point projected onto the
 * sphere, kept only when that point stays inside the cell (so no star straddles a cell edge).
 * Cool white, some cyan, a rare amber.
 */
function starField(d: TslNode): TslNode {
  const N = 70;
  const q: TslNode = d.mul(N);
  const cell: TslNode = floor(q);
  const h1: TslNode = hash(cell.x.mul(127.1).add(cell.y.mul(311.7)).add(cell.z.mul(74.7)));
  const h2: TslNode = hash(cell.x.mul(269.5).add(cell.y.mul(183.3)).add(cell.z.mul(246.1)));
  const jitter: TslNode = vec3(h1, h2, fract(h1.mul(h2).mul(17.3))).sub(0.5).mul(0.5);
  const centre: TslNode = normalize(cell.add(0.5).add(jitter)).mul(N);
  const rel: TslNode = centre.sub(cell);
  const inCell: TslNode = step(0, rel.x).mul(step(rel.x, 1)).mul(step(0, rel.y)).mul(step(rel.y, 1)).mul(step(0, rel.z)).mul(step(rel.z, 1));
  const o: TslNode = abs(q.sub(centre));
  const diamond: TslNode = o.x.add(o.y).add(o.z);
  const size: TslNode = h2.mul(0.05).add(0.06);
  const shape: TslNode = float(1).sub(smoothstep(size.mul(0.45), size, diamond));
  const present: TslNode = step(0.968, h1).mul(inCell);
  const cool: TslNode = mix(color('#cfe9ff') as TslNode, color(NEON.cyan) as TslNode, step(0.6, h2));
  const tint: TslNode = mix(cool, color('#ffb347') as TslNode, step(0.9, h2));
  return tint.mul(shape.mul(present).mul(h2.mul(0.8).add(0.5)));
}

export function synthSkyNode(horizon: TslNode, zenith: TslNode, opts: { sunDir: THREE.Vector3; sunRadius?: number; sun?: TslNode } ): TslNode {
  const d0: TslNode = normalize(positionLocal);
  // Sky directions are measured from the (sunken) planet horizon: `a` is the angle above it
  // (rad). Rotating the elevation (rather than shifting its sine) keeps the band thin from orbit.
  const a: TslNode = asin(clamp(d0.y, -1, 1)).add(SKY_PLANET.dipAngle);
  const ac: TslNode = clamp(a, -Math.PI / 2, Math.PI / 2);
  const hz: TslNode = cos(ac).div(max(length(d0.xz), float(1e-5)));
  const d: TslNode = vec3(d0.x.mul(hz) as TslNode, sin(ac) as TslNode, d0.z.mul(hz) as TslNode);
  const up = clamp(d.y, 0, 1);
  const sky = mix(horizon, zenith, pow(clamp(up.mul(2.2), 0, 1), 0.6));
  // Coloured haze at the horizon: the electric-blue band, a thin cyan-white core, and a faint
  // amber under-glow of the city lights in the lowest degree.
  const band = float(1).sub(smoothstep(0, 0.05, abs(d.y))).mul(0.6);
  const core = float(1).sub(smoothstep(0, 0.012, abs(d.y))).mul(0.22);
  const amber = float(1).sub(smoothstep(0, 0.02, abs(d.y))).mul(0.05);
  const bandCol = (color(GRID_SKY.band) as TslNode).mul(band)
    .add((color(NEON.cyan) as TslNode).mul(core))
    .add((color(NEON.orange) as TslNode).mul(amber));
  // Sun: angle from its centre on the horizon.
  const sd = opts.sunDir.clone().normalize();
  const sunDir = vec3(sd.x, sd.y, sd.z);
  const r = opts.sunRadius ?? 0.2;
  const cosA = dot(d, sunDir);
  const disc = smoothstep(Math.cos(r * 1.01), Math.cos(r * 0.99), cosA);
  // Vertical position within the disc: 0 at the bottom edge, 1 at the top.
  const v = clamp(d.y.sub(sd.y - r).div(2 * r), 0, 1);
  const sunGrad = mix(color(NEON.magenta), color(NEON.yellow), v).mul(1.15);
  // Stripes in the lower 60%: bands that get thicker toward the bottom.
  const stripeCoord = fract(v.mul(10));
  const gap = clamp(float(0.6).sub(v), 0, 0.6).mul(1.2);
  const cut = step(gap, stripeCoord);
  const sunMask = disc.mul(cut).mul(step(-0.02, d.y)); // nothing below the horizon
  const halo = smoothstep(Math.cos(r * 2.2), Math.cos(r), cosA).mul(0.12).mul(step(-0.02, d.y));
  const sunCol = (opts.sun ?? float(1)) as TslNode;
  const air = sky.add(bandCol).add(color(NEON.pink).mul(halo).mul(sunCol)).mul(float(1).sub(sunMask.mul(sunCol))).add(sunGrad.mul(sunMask).mul(sunCol));
  // Space: near-black with sparse geometric stars, and the planet's limb: a thin shell of
  // glowing air hugging the silhouette (cyan core, electric-blue falloff above it).
  const w: TslNode = SKY_PLANET.limbWidth;
  const above: TslNode = max(a, float(0));
  const onSky: TslNode = step(float(-0.002), a);
  const shellGlow: TslNode = exp(above.div(w).negate()).mul(onSky);
  const coreGlow: TslNode = exp(above.div(w.mul(0.2)).negate()).mul(onSky);
  const limb: TslNode = (color(GRID_SKY.band) as TslNode).mul(shellGlow.mul(0.8)).add((color(NEON.cyan) as TslNode).mul(coreGlow.mul(1.5)));
  const stars: TslNode = starField(d0).mul(smoothstep(0.03, 0.2, a)).mul(1.3);
  const space: TslNode = (color('#000208') as TslNode).add(limb).add(stars);
  return mix(air as TslNode, space, SKY_PLANET.space as unknown as TslNode);
}

/** Merge several (already positioned) line geometries' positions into one LineSegments geometry. */
export function mergeLines(parts: { geo: THREE.BufferGeometry; matrix: THREE.Matrix4 }[]): THREE.BufferGeometry {
  let total = 0;
  for (const p of parts) total += p.geo.getAttribute('position').count;
  const out = new Float32Array(total * 3);
  const v = new THREE.Vector3();
  let o = 0;
  for (const p of parts) {
    const pos = p.geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(p.matrix);
      out[o++] = v.x;
      out[o++] = v.y;
      out[o++] = v.z;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.computeBoundingSphere();
  return g;
}
