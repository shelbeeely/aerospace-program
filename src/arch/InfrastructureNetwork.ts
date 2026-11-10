import { CITY, heightCap, PLANET, PLANET_HUBS, wrapCoord } from '../sim/layout.ts';
import { highwayDistance, OUTLANDS, outlandsLandmarks, terrainTop } from './DigitalTerrainGenerator.ts';
import { blockAt, GRID, mod } from './grid.ts';
import type { LightRole } from './palette.ts';
import { hash32, hashFloat } from './rng.ts';
import type { ColliderPiece, Component, StructureSpec } from './types.ts';
import { onWorldReset, WORLD } from './world.ts';

/**
 * Infrastructure: what connects the structures, and why.
 *
 * - Pathways (inside a district): every ground connection point of a structure runs out to the
 *   street its lot faces: data points as bright-blue lit traces, energy points as white-topped
 *   conduits on the ground, transport points as amber entrance lanes. Function → light.
 * - Elevated corridors (inside a district): where two neighbouring structures across a street
 *   both have faces at the same height, a lit corridor bridges the street between them.
 * - Lightcycle highways: every sixth street line (and every 37th through the Outlands), drawn
 *   by the ground shader and ridden by traffic.
 * - Solar Sailer routes (world): energy beams in the sky between landmarks, carried by slender
 *   pylons across cities and Outlands alike; sailers ride them as moving light.
 */
const C = PLANET.circumference;

export interface InfraSet {
  /** Components in canonical world metres relative to (ox, oz) (the district origin). */
  components: Component[];
  colliders: ColliderPiece[];
  ox: number;
  oz: number;
}

export interface LotRect { x0: number; x1: number; z0: number; z1: number }

/** Ground pathways from each structure's connection points to its lot edge. */
export function pathways(set: InfraSet, s: StructureSpec, lot: LotRect): void {
  for (const c of s.connections) {
    if (c.y > 1 || c.dir < 0) continue;
    const dx = [1, 0, -1, 0][c.dir], dz = [0, 1, 0, -1][c.dir];
    const ex = dx > 0 ? lot.x1 : dx < 0 ? lot.x0 : c.x;
    const ez = dz > 0 ? lot.z1 : dz < 0 ? lot.z0 : c.z;
    const len = Math.abs(ex - c.x) + Math.abs(ez - c.z);
    if (len < 2) continue;
    const mx = (c.x + ex) / 2 - set.ox, mz = (c.z + ez) / 2 - set.oz;
    const alongX = dx !== 0;
    const light: LightRole = c.kind === 'energy' ? 'energy' : c.kind === 'transport' || c.kind === 'bridge' ? 'entrance' : 'data';
    if (c.kind === 'energy') {
      set.components.push({ prim: { kind: 'box', w: alongX ? len : 1.6, h: 0.9, d: alongX ? 1.6 : len }, x: mx, y: 0, z: mz, tier: 3, surface: 'metal', edges: 'top', light, glow: 1, role: 'conduit' });
    } else if (c.kind === 'transport') {
      for (const o of [-3, 3]) set.components.push({ prim: { kind: 'box', w: alongX ? len : 0.6, h: 0.08, d: alongX ? 0.6 : len }, x: mx + (alongX ? 0 : o), y: 0.02, z: mz + (alongX ? o : 0), tier: 3, surface: 'glow', edges: 'none', light, glow: 0.9, role: 'lane' });
    } else {
      set.components.push({ prim: { kind: 'box', w: alongX ? len : 0.9, h: 0.08, d: alongX ? 0.9 : len }, x: mx, y: 0.02, z: mz, tier: 3, surface: 'glow', edges: 'none', light, glow: 1, role: 'pathway' });
    }
  }
}

/**
 * Elevated corridors between structures in lots facing each other across one street.
 * `a` is west/south of `b` along `axis`.
 */
export function corridor(set: InfraSet, a: StructureSpec, b: StructureSpec, la: LotRect, lb: LotRect, axis: 'x' | 'z', salt: number): boolean {
  if (hashFloat(WORLD.seed, salt, 0xc0) > 0.6) return false;
  const near = 30;
  const faceA = a.colliders.filter((c) => axis === 'x' ? c.x + c.sx / 2 > la.x1 - near : c.z + c.sz / 2 > la.z1 - near);
  const faceB = b.colliders.filter((c) => axis === 'x' ? c.x - c.sx / 2 < lb.x0 + near : c.z - c.sz / 2 < lb.z0 + near);
  for (const ca of faceA) for (const cb of faceB) {
    if (ca.shape !== 'box' || cb.shape !== 'box') continue;
    // Overlap across the other axis and in height.
    const o0 = axis === 'x' ? Math.max(ca.z - ca.sz / 2, cb.z - cb.sz / 2) : Math.max(ca.x - ca.sx / 2, cb.x - cb.sx / 2);
    const o1 = axis === 'x' ? Math.min(ca.z + ca.sz / 2, cb.z + cb.sz / 2) : Math.min(ca.x + ca.sx / 2, cb.x + cb.sx / 2);
    const y0 = Math.max(ca.y - ca.sy / 2, cb.y - cb.sy / 2, 14), y1 = Math.min(ca.y + ca.sy / 2, cb.y + cb.sy / 2) - 5;
    if (o1 - o0 < 10 || y1 - y0 < 2) continue;
    const y = y0 + (y1 - y0) * hashFloat(WORLD.seed, salt, 0xc1) * 0.6;
    const from = axis === 'x' ? ca.x + ca.sx / 2 : ca.z + ca.sz / 2;
    const to = axis === 'x' ? cb.x - cb.sx / 2 : cb.z - cb.sz / 2;
    const len = to - from;
    if (len < 8 || len > 90) continue;
    const mid = (o0 + o1) / 2, width = Math.min(8, (o1 - o0) * 0.5);
    const cx = axis === 'x' ? (from + to) / 2 : mid, cz = axis === 'x' ? mid : (from + to) / 2;
    const w = axis === 'x' ? len + 1 : width, d = axis === 'x' ? width : len + 1;
    if (heightCap(cx, cz) < y + 6) continue;
    set.components.push({ prim: { kind: 'box', w, h: 4, d }, x: cx - set.ox, y, z: cz - set.oz, tier: 2, surface: 'hullDark', edges: 'base', light: 'data', glow: 0.9, role: 'corridor' });
    set.components.push({ prim: { kind: 'box', w: axis === 'x' ? len : 0.5, h: 0.2, d: axis === 'x' ? 0.5 : len }, x: cx - set.ox, y: y - 0.2, z: cz - set.oz, tier: 3, surface: 'glow', edges: 'none', light: 'data', glow: 1, role: 'corridor' });
    set.colliders.push({ shape: 'box', x: cx, y: y + 2, z: cz, sx: w, sy: 4, sz: d });
    return true;
  }
  return false;
}

// --- Solar Sailer routes ---

export interface RouteNode { x: number; z: number; name: string }
export interface SailerRoute { a: RouteNode; b: RouteNode; y: number; length: number; id: number }
export interface Pylon { x: number; z: number; y: number; route: number }

let routeCache: { routes: SailerRoute[]; pylons: Pylon[] } | null = null;
onWorldReset(() => { routeCache = null; });

/** Landmarks the sailer network links: the planet's hubs and the Outlands landmarks. */
export function routeNodes(): RouteNode[] {
  const out: RouteNode[] = [];
  CITY.hubs.forEach((h, i) => out.push({ x: h.x, z: h.z, name: i === 0 ? 'Grid Spire' : `Hub ${i + 1}` }));
  PLANET_HUBS.forEach((h, i) => out.push({ x: h.x, z: h.z, name: `Hub ${CITY.hubs.length + i + 1}` }));
  outlandsLandmarks().forEach((l, i) => out.push({ x: l.x, z: l.z, name: `Outlands landmark ${i + 1}` }));
  return out;
}

const PYLON_SPACING = 650;
/** Distance (m) from a coordinate to the nearest street centreline on that axis. */
const lineDistance = (v: number, origin: number) => {
  const t = mod(v - origin, GRID.pitch);
  return Math.min(t, GRID.pitch - t);
};

/** Routes (each node to its two nearest, ≤ 7.5 km) and their pylons, cached per seed. */
export function sailerNetwork(): { routes: SailerRoute[]; pylons: Pylon[] } {
  if (routeCache) return routeCache;
  const nodes = routeNodes();
  const routes: SailerRoute[] = [];
  const pylons: Pylon[] = [];
  const seen = new Set<string>();
  nodes.forEach((a, i) => {
    const near = nodes.map((b, j) => ({ j, d: Math.hypot(wrapCoord(b.x - a.x), wrapCoord(b.z - a.z)) })).filter((n) => n.j !== i).sort((p, q) => p.d - q.d).slice(0, 2);
    for (const { j, d } of near) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key) || d > 7500 || d < 600) continue;
      seen.add(key);
      const b = nodes[j];
      const dx = wrapCoord(b.x - a.x), dz = wrapCoord(b.z - a.z);
      // Altitude: clear of the terrain and zoning under the whole route.
      let y = 150, ok = true;
      const steps = Math.ceil(d / 120);
      for (let k = 0; k <= steps; k++) {
        const t = k / steps, x = a.x + dx * t, z = a.z + dz * t;
        y = Math.max(y, terrainTop(x, z) + 45);
        if (heightCap(x, z) < y + 20) { ok = false; break; }
      }
      if (!ok || y > 360) continue;
      const id = hash32(WORLD.seed, i, j) % 100000;
      routes.push({ a, b: { ...b, x: a.x + dx, z: a.z + dz }, y, length: d, id });
      const np = Math.floor(d / PYLON_SPACING);
      for (let k = 1; k <= np - 1; k++) {
        // Slide each pylon along the route (±90 m) to a spot clear of streets, highways and landforms.
        for (const off of [0, 30, -30, 60, -60, 90, -90]) {
          const t = k / np + off / d, x = wrapCoord(a.x + dx * t), z = wrapCoord(a.z + dz * t);
          if (lineDistance(x, GRID.x0) < 22 || lineDistance(z, GRID.z0) < 22) continue;
          if (highwayDistance(x, CITY.x0) < OUTLANDS.highwayHalf + 8 || highwayDistance(z, CITY.z0) < OUTLANDS.highwayHalf + 8) continue;
          if (terrainTop(x, z) > 0 || terrainTop(x + 6, z + 6) > 0 || terrainTop(x - 6, z - 6) > 0) continue;
          pylons.push({ x, z, y, route: routes.length - 1 });
          break;
        }
      }
    }
  });
  return (routeCache = { routes, pylons });
}

/** A pylon carrying a route: slender column, crossarm and a lit receptor. Local to (px, pz). */
export function pylonComponents(p: Pylon, ox: number, oz: number): { components: Component[]; colliders: ColliderPiece[] } {
  const x = p.x - ox, z = p.z - oz;
  const r = 1.8;
  return {
    components: [
      { prim: { kind: 'box', w: 10, h: 2, d: 10 }, x, y: 0, z, tier: 2, surface: 'hullDark', edges: 'top', light: 'energy', glow: 0.6, role: 'footing' },
      { prim: { kind: 'prism', sides: 6, r0: r, r1: r * 0.6, h: p.y - 2 }, x, y: 2, z, tier: 1, surface: 'metal', edges: 'none', role: 'pylon', pattern: 'flutes' },
      { prim: { kind: 'box', w: 14, h: 1.2, d: 1.2 }, x, y: p.y - 3, z, tier: 2, surface: 'hullDark', edges: 'silhouette', light: 'energy', glow: 0.8, role: 'crossarm' },
      { prim: { kind: 'torus', R: 3, r: 0.4, sides: 24, tube: 6 }, x, y: p.y - 0.4, z, tier: 3, surface: 'glow', edges: 'none', light: 'energy', glow: 1.6, role: 'receptor' },
    ],
    colliders: [
      { shape: 'box', x: p.x, y: 1, z: p.z, sx: 10, sy: 2, sz: 10 },
      { shape: 'cyl', x: p.x, y: 2 + (p.y - 2) / 2, z: p.z, sx: r * 2, sy: p.y - 2, sz: r * 2 },
    ],
  };
}

/** Pylon blocks: the block a pylon stands in (district planning keeps those lots open). */
export function pylonBlocks(): Set<string> {
  const out = new Set<string>();
  for (const p of sailerNetwork().pylons) {
    const [gi, gj] = blockAt(p.x, p.z);
    out.add(`${gi},${gj}`);
  }
  return out;
}

void C;
