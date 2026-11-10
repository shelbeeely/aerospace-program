import * as THREE from 'three/webgpu';
import { abs, float, floor, fwidth, length, max, min, mix, mod, smoothstep, step, texture, uint, vec2 } from 'three/tsl';
import { CITY, PLANET } from '../sim/layout.ts';
import { OUTLANDS, TERRAIN } from '../sim/terrain.ts';
import type { TslNode } from './neon.ts';

/**
 * GPU twin of sim/terrain.ts: the same integer-hashed lattice of geometric solids and the
 * bilinear Outlands mask (from the block-summary texture's alpha), so the drawn landforms are
 * the ones the physics collides with.
 */
const C = PLANET.circumference;
const PITCH = C / TERRAIN.blocks;

function hashLattice(ix: TslNode, iz: TslNode, seed: number): TslNode {
  let h: TslNode = ix.toUint().mul(uint(0x27d4eb2d)).bitXor(iz.toUint().mul(uint(0x165667b1))).bitXor(uint(Math.imul(seed, 0x9e3779b9) >>> 0));
  h = h.bitXor(h.shiftRight(uint(15))).mul(uint(0x2c1b3c6d));
  h = h.bitXor(h.shiftRight(uint(12)));
  h = h.mul(uint(0x297a2d39));
  h = h.bitXor(h.shiftRight(uint(15)));
  return h.shiftRight(uint(8)).toFloat().div(16777216);
}

/**
 * Landforms drawn elsewhere as real geometry (render/OutlandsView.ts): cells whose butte centre
 * lies nearer than `radius` to the canonical `anchor` (x, z) are left out of the height.
 */
export interface TerrainExclusion {
  anchor: TslNode;
  radius: TslNode;
}

/** x wrapped into [-C/2, C/2). */
const wrapC = (x: TslNode): TslNode => x.sub(x.add(C / 2).div(C).floor().mul(C));
const HWY = PITCH * OUTLANDS.highwayEvery;

/** Nearest Outlands highway line to canonical coordinate c (same frame). */
function nearestLine(c: TslNode, origin: number): TslNode {
  const t: TslNode = mod(c.sub(origin), HWY);
  return c.sub(t).add(step(HWY / 2, t).mul(HWY));
}

/** [a, b] clipped off the corridor around `line`, keeping the wider side (terrain.ts clipSpan). */
function clipSpan(a: TslNode, b: TslNode, line: TslNode): [TslNode, TslNode] {
  const HW = OUTLANDS.highwayHalf;
  const hit: TslNode = step(a.sub(HW), line).mul(step(line, b.add(HW)));
  const keepLeft: TslNode = step(b.sub(line.add(HW)), line.sub(HW).sub(a));
  return [
    mix(a, max(a, line.add(HW)), hit.mul(float(1).sub(keepLeft))),
    mix(b, min(b, line.sub(HW)), hit.mul(keepLeft)),
  ];
}

/** The butte of the big cell containing canonical (px, pz): base rectangle, height (0 if none). */
function butte(summary: THREE.DataTexture, px: TslNode, pz: TslNode, near: TerrainExclusion | null) {
  const n = TERRAIN.bigCells;
  const cell = C / n;
  const ix: TslNode = floor(px.div(cell)), iz: TslNode = floor(pz.div(cell));
  const a: TslNode = mod(ix, n).toInt(), b: TslNode = mod(iz, n).toInt();
  const cx: TslNode = ix.add(0.5).mul(cell), cz: TslNode = iz.add(0.5).mul(cell);
  const O = OUTLANDS;
  const gap = (s: number): TslNode => hashLattice(a, b, s).mul(O.gapMax - O.gapMin).add(O.gapMin);
  let [x0, x1] = [cx.sub(cell / 2).add(gap(102)), cx.add(cell / 2).sub(gap(103))];
  let [z0, z1] = [cz.sub(cell / 2).add(gap(104)), cz.add(cell / 2).sub(gap(105))];
  [x0, x1] = clipSpan(x0, x1, nearestLine(cx, CITY.x0));
  [z0, z1] = clipSpan(z0, z1, nearestLine(cz, CITY.z0));
  const h: TslNode = hashLattice(a, b, 101);
  const w: TslNode = wasteland(summary, cx, cz);
  let H: TslNode = h.sub(O.basin).div(1 - O.basin).mul(0.75).add(0.25).mul(TERRAIN.peak).mul(w).mul(w)
    .mul(step(O.basin, h)).mul(step(O.minSide, x1.sub(x0))).mul(step(O.minSide, z1.sub(z0)));
  H = H.mul(step(0.5, H));
  if (near) {
    const d: TslNode = vec2(wrapC(cx.sub(near.anchor.x)), wrapC(cz.sub(near.anchor.y)));
    H = H.mul(step(near.radius, length(d)));
  }
  return { x0, x1, z0, z1, H };
}

/** Bilinear Outlands mask (0..1) from the summary texture's alpha (exact texel fetches). */
function wasteland(summary: THREE.DataTexture, x: TslNode, z: TslNode): TslNode {
  const n = TERRAIN.blocks;
  const u: TslNode = mod(x.sub(CITY.x0), C).div(PITCH).sub(0.5);
  const v: TslNode = mod(z.sub(CITY.z0), C).div(PITCH).sub(0.5);
  const i: TslNode = floor(u), j: TslNode = floor(v);
  const tu: TslNode = u.sub(i), tv: TslNode = v.sub(j);
  const at = (a: TslNode, b: TslNode): TslNode =>
    texture(summary, vec2(mod(a, n).add(0.5).div(n), mod(b, n).add(0.5).div(n))).level(float(0)).a;
  const top: TslNode = mix(at(i, j), at(i.add(1), j), tu);
  const bot: TslNode = mix(at(i, j.add(1)), at(i.add(1), j.add(1)), tu);
  return mix(top, bot, tv);
}

/**
 * Terrain height (m) at flat world (x, z): terrain.ts terrainHeight's buttes and crags (the
 * rubble is only drawn near the camera, as instances). With `near`, the landforms drawn as
 * instances near the camera are left out (the ground stays flat under them).
 */
export function terrainHeightNode(summary: THREE.DataTexture, x: TslNode, z: TslNode, near: TerrainExclusion | null = null): TslNode {
  const px: TslNode = mod(x, C), pz: TslNode = mod(z, C);
  const bt = butte(summary, px, pz, near);
  const d: TslNode = min(min(px.sub(bt.x0), bt.x1.sub(px)), min(pz.sub(bt.z0), bt.z1.sub(pz)));
  const hb: TslNode = min(bt.H, max(float(0), d.div(OUTLANDS.batter)));
  // Crag on the top: inner 2 × 2 small cells of the butte, footprint inside the top rectangle.
  const n = TERRAIN.smallCells;
  const cell = C / n;
  const sx: TslNode = floor(px.div(cell)), sz: TslNode = floor(pz.div(cell));
  const a: TslNode = mod(sx, n).toInt(), b: TslNode = mod(sz, n).toInt();
  const la: TslNode = mod(sx, 4), lb: TslNode = mod(sz, 4);
  const inner: TslNode = step(0.5, la).mul(step(la, 2.5)).mul(step(0.5, lb)).mul(step(lb, 2.5));
  const cx: TslNode = sx.add(0.5).mul(cell), cz: TslNode = sz.add(0.5).mul(cell);
  const half = OUTLANDS.cragBase * cell;
  const inset: TslNode = bt.H.mul(OUTLANDS.batter);
  const fits: TslNode = step(bt.x0.add(inset), cx.sub(half)).mul(step(cx.add(half), bt.x1.sub(inset)))
    .mul(step(bt.z0.add(inset), cz.sub(half))).mul(step(cz.add(half), bt.z1.sub(inset)));
  let Hc: TslNode = min(float(OUTLANDS.cragSlope * half), bt.H.mul(hashLattice(a, b, 218).mul(0.45).add(0.15)));
  Hc = Hc.mul(step(0.5, Hc)).mul(step(0.55, hashLattice(a, b, 211))).mul(inner).mul(fits).mul(step(0.5, bt.H));
  const shape: TslNode = max(float(0), float(1).sub(max(abs(px.sub(cx)), abs(pz.sub(cz))).div(half)));
  return hb.add(Hc.mul(shape));
}

/**
 * Light on the landforms' structure (Rule 2): every butte's base outline and top rim, 0..1,
 * anti-aliased by screen-space width.
 */
export function terrainEdgesNode(summary: THREE.DataTexture, x: TslNode, z: TslNode): TslNode {
  const px: TslNode = mod(x, C), pz: TslNode = mod(z, C);
  const bt = butte(summary, px, pz, null);
  const d: TslNode = min(min(px.sub(bt.x0), bt.x1.sub(px)), min(pz.sub(bt.z0), bt.z1.sub(pz)));
  const aa: TslNode = max(fwidth(d).mul(1.5), float(0.05));
  const base: TslNode = float(1).sub(smoothstep(float(0), aa, abs(d)));
  const rim: TslNode = float(1).sub(smoothstep(float(0), aa, abs(d.sub(bt.H.mul(OUTLANDS.batter)))));
  return max(base, rim).mul(step(0.5, bt.H));
}
