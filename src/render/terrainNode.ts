import * as THREE from 'three/webgpu';
import { abs, float, floor, fwidth, length, max, min, mix, mod, smoothstep, step, texture, uint, vec2 } from 'three/tsl';
import { CITY, PLANET } from '../sim/layout.ts';
import { TERRAIN } from '../sim/terrain.ts';
import type { TslNode } from './neon.ts';

/**
 * GPU twin of sim/terrain.ts: the same integer-hashed lattice of geometric solids and the
 * bilinear Off-Grid mask (from the block-summary texture's alpha), so the drawn mountains are
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
 * Solids drawn elsewhere as real geometry (render/OffGridView.ts): cells whose centre lies
 * nearer than `radius` to the canonical `anchor` (x, z) are left out of the height.
 */
export interface TerrainExclusion {
  anchor: TslNode;
  radius: TslNode;
}

/** x wrapped into [-C/2, C/2). */
const wrapC = (x: TslNode): TslNode => x.sub(x.add(C / 2).div(C).floor().mul(C));

/** One lattice of geometric solids (pyramids / mesas): same as terrain.ts solid(). */
function solid(x: TslNode, z: TslNode, n: number, seed: number, summary: THREE.DataTexture | null = null, near: TerrainExclusion | null = null): { h: TslNode; u: TslNode; v: TslNode; present: TslNode } {
  const cell = C / n;
  const fx: TslNode = mod(x, C).div(cell);
  const fz: TslNode = mod(z, C).div(cell);
  const ix: TslNode = floor(fx), iz: TslNode = floor(fz);
  const cx: TslNode = mod(ix, n).toInt(), cz: TslNode = mod(iz, n).toInt();
  const hh: TslNode = hashLattice(cx, cz, seed);
  const present: TslNode = step(0.3, hh);
  const u: TslNode = fx.sub(ix).sub(0.5), v: TslNode = fz.sub(iz).sub(0.5);
  const shape: TslNode = max(float(0), float(0.9).sub(max(abs(u), abs(v)).mul(2))).div(0.9);
  const mesa: TslNode = mix(float(1), float(0.6), float(1).sub(step(0.35, hashLattice(cx, cz, seed + 7))));
  // Height scaled by the wasteland mask² at the cell centre (terrain.ts solidCell), so faces stay planar.
  let scale: TslNode = float(1);
  if (summary) {
    const w: TslNode = wasteland(summary, cx.toFloat().add(0.5).mul(cell), cz.toFloat().add(0.5).mul(cell));
    scale = w.mul(w);
  }
  let h: TslNode = min(shape, mesa).div(mesa).mul(hh.sub(0.3).div(0.7)).mul(present).mul(scale);
  if (near) {
    // Cell centre (this vertex's image) to the anchor, across the wrap.
    const d: TslNode = vec2(wrapC(x.sub(u.mul(cell)).sub(near.anchor.x)), wrapC(z.sub(v.mul(cell)).sub(near.anchor.y)));
    h = h.mul(step(near.radius, length(d)));
  }
  return { h, u, v, present: present.mul(step(float(0.0001), scale)) };
}

/** Bilinear Off-Grid mask (0..1) from the summary texture's alpha (exact texel fetches). */
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
 * Terrain height (m) at flat world (x, z): same formula as terrain.ts terrainHeight. With
 * `near`, the solids drawn as instances near the camera are left out (the ground stays flat
 * under them).
 */
export function terrainHeightNode(summary: THREE.DataTexture, x: TslNode, z: TslNode, near: TerrainExclusion | null = null): TslNode {
  const big = solid(x, z, TERRAIN.bigCells, 101, summary, near);
  const small = solid(x, z, TERRAIN.smallCells, 211, summary, near);
  return max(big.h, small.h.mul(0.3)).mul(TERRAIN.peak);
}

/**
 * Light on the solids' structure (Rule 2): straight diagonal ridgelines and the base outline
 * of every big solid, 0..1, anti-aliased by screen-space width.
 */
export function terrainEdgesNode(summary: THREE.DataTexture, x: TslNode, z: TslNode): TslNode {
  const big = solid(x, z, TERRAIN.bigCells, 101, summary);
  const au: TslNode = abs(big.u), av: TslNode = abs(big.v);
  const aa: TslNode = max(fwidth(big.u).mul(1.5), float(0.002));
  const ridge: TslNode = float(1).sub(smoothstep(float(0), aa, abs(au.sub(av)))).mul(step(max(au, av), float(0.45)));
  const base: TslNode = float(1).sub(smoothstep(float(0), aa, abs(max(au, av).sub(0.45))));
  return max(ridge, base).mul(big.present);
}
