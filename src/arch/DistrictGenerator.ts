import { CITY, heightCap, heightCapRect, isSea, PLANET, PLANET_HUBS, wrapCoord } from '../sim/layout.ts';
import { generateStructure } from './ArchitectureGenerator.ts';
import { ARCHETYPES } from './BuildingArchetypeRegistry.ts';
import { blockArchetype, nearWasteland, outlandsLandmarks } from './DigitalTerrainGenerator.ts';
import { blockRect, GRID, isCentralBlock, isHighwayLine, mod } from './grid.ts';
import { corridor, pathways, pylonBlocks, pylonComponents, sailerNetwork, type InfraSet, type LotRect } from './InfrastructureNetwork.ts';
import { hash32, hashFloat, Rng } from './rng.ts';
import type { ArchetypeId, StructureSpec } from './types.ts';
import { cityRegionAt, intensityAt, REGION_PROFILES, type CityRegion, type TerrainArchetype } from './WorldRegionManager.ts';
import { onWorldReset, WORLD } from './world.ts';
import { KIT } from '../world/kit.ts';

/**
 * Districts: one per planet chunk (10 × 10 city blocks, ~1.36 km). A district is laid out as
 * lots on the block lattice (a lot spans 1–4 blocks each way and covers the minor streets
 * inside it, never a data highway), and every lot becomes a structure, a landmark or negative
 * space according to its region. The layout is cheap and computed for the whole planet (traffic
 * and the ground shader need it); structures are generated lazily when a district is needed.
 *
 * Functional clusters, not uniform scatter: each region has its own family mix, lot sizes,
 * open-space share and height band; hub cores raise heights and host landmarks; transitional
 * districts dither between two regions' rules.
 */
export interface Lot {
  /** Origin block (global indices) and size in blocks. */
  gi: number;
  gj: number;
  wb: number;
  db: number;
  /** Canonical buildable rectangle (m). */
  rect: LotRect;
  central: boolean;
  region: CityRegion | 'outlands';
  kind: 'structure' | 'open' | 'landmark' | 'kit';
  /** Imported kit tower ("Tron Buildings 1"): type, quarter turns, uniform scale. */
  kit?: { type: number; rot: number; scale: number };
  archetype?: ArchetypeId;
  minH: number;
  maxH: number;
  intensity: number;
  landmark?: string;
  func?: string;
  variant?: string;
}

export interface DistrictLayout {
  ci: number;
  cj: number;
  lots: Lot[];
  region: CityRegion;
  regionName: string;
}

export interface DistrictPlan {
  ci: number;
  cj: number;
  key: string;
  /** Canonical minimum corner (m). */
  x: number;
  z: number;
  layout: DistrictLayout;
  structures: StructureSpec[];
  /** Lot of each structure (same order). */
  lots: Lot[];
  infra: InfraSet;
  /** Imported kit towers standing in the district (canonical centre). */
  kits: Array<{ type: number; x: number; z: number; scale: number; rot: number; central: boolean }>;
  rejected: number;
  ms: number;
}

const C = PLANET.circumference;
const layoutCache = new Map<string, DistrictLayout>();
const planCache = new Map<string, DistrictPlan>();
let usableCache: Uint8Array | null = null;
let hubBlocks: Map<string, { name: string; h: number; main: boolean }> | null = null;
let pylonSet: Set<string> | null = null;
onWorldReset(() => { layoutCache.clear(); planCache.clear(); usableCache = null; hubBlocks = null; pylonSet = null; });

const HUB_NAMES = ['Grid Spire', 'Southwest Processor', 'South Relay', 'Northwest Core', 'Northeast Array'];

function hubBlockMap(): Map<string, { name: string; h: number; main: boolean }> {
  if (hubBlocks) return hubBlocks;
  hubBlocks = new Map();
  const all = [...CITY.hubs.map((h, i) => ({ ...h, name: HUB_NAMES[i] ?? `Hub ${i + 1}`, main: i === 0 })), ...PLANET_HUBS.map((h, i) => ({ ...h, name: `Hub ${CITY.hubs.length + i + 1}`, main: false }))];
  for (const h of all) {
    const gi = Math.floor(mod(h.x - GRID.x0, C) / GRID.pitch), gj = Math.floor(mod(h.z - GRID.z0, C) / GRID.pitch);
    hubBlocks.set(`${gi},${gj}`, { name: h.name, h: h.main ? 520 : h.h * 1.25, main: h.main });
  }
  return hubBlocks;
}

/** Can a structure stand on block (gi, gj)? (Land, flat, zoned for buildings, no sailer pylon.) */
export function blockUsable(gi: number, gj: number): boolean {
  const n = GRID.blocks;
  if (!usableCache) {
    usableCache = new Uint8Array(n * n);
    pylonSet = pylonBlocks();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const r = blockRect(i, j);
      let ok = !isSea(r.x0) && !isSea(r.x1) && !nearWasteland(i, j) && !pylonSet.has(`${i},${j}`);
      if (ok) {
        const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
        const cap = Math.min(heightCap(cx, cz), heightCap(r.x0, r.z0), heightCap(r.x1, r.z0), heightCap(r.x0, r.z1), heightCap(r.x1, r.z1));
        ok = cap >= CITY.minHeight;
      }
      usableCache[j * n + i] = ok ? 1 : 0;
    }
  }
  return usableCache[mod(gj, n) * n + mod(gi, n)] === 1;
}

/** The lot layout of district (ci, cj) (cached). */
export function districtLayout(ci: number, cj: number): DistrictLayout {
  ci = mod(ci, GRID.chunks);
  cj = mod(cj, GRID.chunks);
  const key = `${ci},${cj}`;
  let l = layoutCache.get(key);
  if (!l) layoutCache.set(key, (l = makeLayout(ci, cj)));
  return l;
}

function makeLayout(ci: number, cj: number): DistrictLayout {
  const B = GRID.chunkBlocks;
  const gi0 = ci * B, gj0 = cj * B;
  const cx = GRID.x0 + (gi0 + B / 2) * GRID.pitch, cz = GRID.z0 + (gj0 + B / 2) * GRID.pitch;
  const reg = cityRegionAt(cx, cz);
  const used = new Uint8Array(B * B);
  const lots: Lot[] = [];
  const hubs = hubBlockMap();

  const fits = (bi: number, bj: number, wb: number, db: number, central: boolean): boolean => {
    if (bi + wb > B || bj + db > B) return false;
    for (let a = 0; a < wb; a++) for (let b = 0; b < db; b++) {
      const gi = gi0 + bi + a, gj = gj0 + bj + b;
      if (used[(bj + b) * B + bi + a] || !blockUsable(gi, gj) || isCentralBlock(gi, gj) !== central) return false;
    }
    for (let a = 1; a < wb; a++) if (isHighwayLine(gi0 + bi + a)) return false;
    for (let b = 1; b < db; b++) if (isHighwayLine(gj0 + bj + b)) return false;
    return true;
  };
  const claim = (bi: number, bj: number, wb: number, db: number) => {
    for (let a = 0; a < wb; a++) for (let b = 0; b < db; b++) used[(bj + b) * B + bi + a] = 1;
  };
  const lotRect = (bi: number, bj: number, wb: number, db: number): LotRect => {
    const r0 = blockRect(gi0 + bi, gj0 + bj), r1 = blockRect(gi0 + bi + wb - 1, gj0 + bj + db - 1);
    // r1 may have wrapped to the canonical start: rebuild from r0 and the block counts.
    return { x0: r0.x0, z0: r0.z0, x1: r0.x0 + (r1.x1 - r1.x0) + (wb - 1) * GRID.pitch, z1: r0.z0 + (r1.z1 - r1.z0) + (db - 1) * GRID.pitch };
  };

  // Landmarks first: the hub blocks host monumental structures on the biggest lot that fits.
  for (let bj = 0; bj < B; bj++) for (let bi = 0; bi < B; bi++) {
    const hub = hubs.get(`${gi0 + bi},${gj0 + bj}`);
    if (!hub) continue;
    const central = isCentralBlock(gi0 + bi, gj0 + bj);
    let placed = false;
    for (const [w, d] of [[3, 3], [2, 2], [2, 1], [1, 2], [1, 1]]) {
      for (const [oa, ob] of [[0, 0], [-1, 0], [0, -1], [-1, -1], [-2, 0], [0, -2], [-2, -2]]) {
        const a = bi + oa, b = bj + ob;
        if (a < 0 || b < 0 || !fits(a, b, w, d, central)) continue;
        claim(a, b, w, d);
        const rect = lotRect(a, b, w, d);
        const lr = cityRegionAt((rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2).primary;
        const cap = heightCapRect(rect.x0, rect.z0, rect.x1, rect.z1);
        const tower = hub.main || lr === 'control' || lr === 'machine-city' || lr === 'caverns' || lr === 'industrial';
        lots.push({
          gi: gi0 + a, gj: gj0 + b, wb: w, db: d, rect, central, region: lr, kind: 'landmark',
          archetype: tower ? 'tower' : 'radial', minH: Math.min(hub.h * 0.8, cap * 0.9), maxH: Math.min(hub.h, cap * 0.96), intensity: 1,
          landmark: hub.name, func: hub.main ? 'control-tower' : undefined, variant: hub.main ? 'trumpet' : undefined,
        });
        placed = true;
        break;
      }
      if (placed) break;
    }
  }

  // Greedy partition of the rest, region by region.
  for (let bj = 0; bj < B; bj++) for (let bi = 0; bi < B; bi++) {
    if (used[bj * B + bi]) continue;
    const gi = gi0 + bi, gj = gj0 + bj;
    if (!blockUsable(gi, gj)) continue;
    const central = isCentralBlock(gi, gj);
    const r = blockRect(gi, gj);
    const here = cityRegionAt((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
    const region = hashFloat(WORLD.seed, gi, gj, 11) < here.t * 0.8 ? here.secondary : here.primary;
    const prof = REGION_PROFILES[region];
    const rng = new Rng(hash32(WORLD.seed, gi, gj, 12));
    const want = rng.weighted(prof.lots.map(([w, d, k]) => [[w, d] as [number, number], k] as const));
    const tries: Array<[number, number]> = [want, [want[1], want[0]], [Math.min(want[0], 2), Math.min(want[1], 2)], [2, 1], [1, 2], [1, 1]];
    let size: [number, number] = [1, 1];
    for (const t of tries) if (fits(bi, bj, t[0], t[1], central)) { size = t; break; }
    if (!fits(bi, bj, size[0], size[1], central)) continue;
    claim(bi, bj, size[0], size[1]);
    const rect = lotRect(bi, bj, size[0], size[1]);
    const mx = (rect.x0 + rect.x1) / 2, mz = (rect.z0 + rect.z1) / 2;
    const { core, peak } = intensityAt(mx, mz);
    const open = rng.next() < prof.open * (1 - 0.55 * core);
    const cap = heightCapRect(rect.x0, rect.z0, rect.x1, rect.z1);
    let maxH = prof.height[0] + (prof.height[1] - prof.height[0]) * (0.18 + 0.5 * rng.next() ** 2) + core * Math.max(0, peak - prof.height[0]) * 0.75;
    maxH = Math.min(maxH, prof.height[1] * 1.15, cap * 0.96);
    const minH = Math.min(prof.height[0], maxH * 0.45);
    const lot: Lot = { gi, gj, wb: size[0], db: size[1], rect, central, region, kind: open || maxH < 12 ? 'open' : 'structure', minH, maxH, intensity: core };
    // Imported kit towers keep their place in the dense regions (single and double lots).
    const kitShare = region === 'machine-city' ? 0.22 : region === 'control' || region === 'transport' ? 0.14 : region === 'caverns' || region === 'industrial' ? 0.08 : 0.03;
    if (lot.kind === 'structure' && cap > 45 && Math.max(size[0], size[1]) <= 2 && rng.next() < kitShare * (1 + core)) {
      const type = Math.floor(rng.next() * KIT.length);
      const t = KIT[type];
      const side = Math.min(rect.x1 - rect.x0, rect.z1 - rect.z0) * 0.88;
      const want = Math.min(cap * 0.96, Math.max(45, maxH * (0.8 + rng.next() * 0.5)));
      lot.kind = 'kit';
      lot.kit = { type, rot: Math.floor(rng.next() * 4), scale: Math.min(want / t.size[1], side / Math.max(t.size[0], t.size[2])) };
    } else if (lot.kind === 'structure') lot.archetype = pickFamily(region, size, rng);
    lots.push(lot);
  }
  return { ci, cj, lots, region: reg.primary, regionName: reg.name };
}

function pickFamily(region: CityRegion, [wb, db]: [number, number], rng: Rng): ArchetypeId {
  const prof = REGION_PROFILES[region];
  const e = Math.max(wb, db) / Math.min(wb, db);
  const entries: Array<[ArchetypeId, number]> = [];
  for (const [id, w] of Object.entries(prof.families) as Array<[ArchetypeId, number]>) {
    const g = ARCHETYPES[id];
    if (Math.min(wb, db) < g.lot.min || Math.max(wb, db) > g.lot.max) continue;
    const shape = g.elongated ? (e >= 1.5 ? 1.6 : 0.8) : (e >= 1.5 ? 0.15 : 1.2);
    entries.push([id, w * shape]);
  }
  return entries.length ? rng.weighted(entries) : 'circuit';
}

/** Lot rectangles by block (for traffic and the ground): which lot covers block (gi, gj). */
export function lotAt(gi: number, gj: number): Lot | null {
  const ci = Math.floor(mod(gi, GRID.blocks) / GRID.chunkBlocks), cj = Math.floor(mod(gj, GRID.blocks) / GRID.chunkBlocks);
  const L = districtLayout(ci, cj);
  const a = mod(gi, GRID.blocks), b = mod(gj, GRID.blocks);
  for (const l of L.lots) {
    const la = mod(l.gi, GRID.blocks), lb = mod(l.gj, GRID.blocks);
    if (a >= la && a < la + l.wb && b >= lb && b < lb + l.db) return l;
  }
  return null;
}

/** The full district (cached, oldest dropped past 220): structures, rejections, infrastructure. */
export function districtPlan(ci: number, cj: number): DistrictPlan {
  ci = mod(ci, GRID.chunks);
  cj = mod(cj, GRID.chunks);
  const key = `${ci},${cj}`;
  let p = planCache.get(key);
  if (p) {
    planCache.delete(key);
    planCache.set(key, p);
    return p;
  }
  p = makePlan(ci, cj, key);
  planCache.set(key, p);
  if (planCache.size > 220) planCache.delete(planCache.keys().next().value!);
  return p;
}

const LANDMARK_FOR_TERRAIN: Record<TerrainArchetype, { archetype: ArchetypeId; variant: string; func: string }> = {
  canyons: { archetype: 'tower', variant: 'control', func: 'central-processor' },
  sea: { archetype: 'tower', variant: 'spire', func: 'scheduler' },
  wasteland: { archetype: 'radial', variant: 'stepped', func: 'beacon' },
  'grid-plains': { archetype: 'radial', variant: 'rings', func: 'comm-node' },
  'mech-caverns': { archetype: 'cavern', variant: 'shaft', func: 'io-buffer' },
};

function makePlan(ci: number, cj: number, key: string): DistrictPlan {
  const t0 = performance.now();
  const layout = districtLayout(ci, cj);
  const x = GRID.x0 + ci * GRID.chunkSize, z = GRID.z0 + cj * GRID.chunkSize;
  const structures: StructureSpec[] = [];
  const lots: Lot[] = [];
  const signatures = new Map<string, number>();
  const infra: InfraSet = { components: [], colliders: [], ox: x, oz: z };
  const kits: DistrictPlan['kits'] = [];
  let rejected = 0;
  for (const lot of layout.lots) {
    if (lot.kind === 'kit' && lot.kit) {
      kits.push({ ...lot.kit, x: (lot.rect.x0 + lot.rect.x1) / 2, z: (lot.rect.z0 + lot.rect.z1) / 2, central: lot.central });
      continue;
    }
    if (lot.kind === 'open' || !lot.archetype) continue;
    const r = lot.rect;
    // Zoning is a hard limit (airport obstacle surfaces): regenerate lower until every solid
    // stays under it, or leave the lot open.
    let s: StructureSpec | null = null;
    let maxH = lot.maxH;
    for (let k = 0; k < 4 && !s; k++) {
      const c = generateStructure({
        archetype: lot.archetype, seed: hash32(WORLD.seed, lot.gi, lot.gj, 0xa7c + k),
        x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0,
        minHeight: Math.min(lot.minH, maxH * 0.5), maxHeight: maxH, intensity: lot.intensity, region: lot.region,
        landmark: lot.landmark, func: lot.func, variant: lot.variant,
      }, { signatures });
      if (zoned(c)) s = c;
      else maxH *= 0.75;
    }
    if (!s || (!s.validation?.pass && lot.kind !== 'landmark')) { rejected++; continue; }
    structures.push(s);
    lots.push(lot);
    pathways(infra, s, r);
  }
  // Outlands landmarks standing in this district.
  for (const l of outlandsLandmarks()) {
    const lx = x + mod(l.x - x, C), lz = z + mod(l.z - z, C);
    if (lx >= x + GRID.chunkSize || lz >= z + GRID.chunkSize) continue;
    const spec = LANDMARK_FOR_TERRAIN[l.arch];
    const size = 380;
    const s = generateStructure({
      archetype: spec.archetype, seed: hash32(WORLD.seed, l.i, l.j, 0x0a7), x: lx, z: lz, w: size, d: size,
      minHeight: 120, maxHeight: 300, intensity: 0.8, region: 'outlands', func: spec.func, variant: spec.variant,
      landmark: `${blockArchetype(Math.floor(mod(l.x - GRID.x0, C) / GRID.pitch), Math.floor(mod(l.z - GRID.z0, C) / GRID.pitch)).primary} landmark`,
    });
    const rect = { x0: lx - size / 2, x1: lx + size / 2, z0: lz - size / 2, z1: lz + size / 2 };
    structures.push(s);
    lots.push({ gi: -1, gj: -1, wb: 0, db: 0, rect, central: false, region: 'outlands', kind: 'landmark', archetype: spec.archetype, minH: 120, maxH: 300, intensity: 0.8, landmark: s.landmark });
  }
  // Elevated corridors between facing structures across one street.
  const P = GRID.pitch;
  for (let i = 0; i < structures.length; i++) for (let j = 0; j < structures.length; j++) {
    const la = lots[i], lb = lots[j];
    if (i === j || la.central !== lb.central || la.kind === 'landmark' || lb.kind === 'landmark') continue;
    const ax = Math.abs(lb.rect.x0 - la.rect.x1 - CITY.street) < 1 && Math.min(la.rect.z1, lb.rect.z1) - Math.max(la.rect.z0, lb.rect.z0) > 20;
    const az = Math.abs(lb.rect.z0 - la.rect.z1 - CITY.street) < 1 && Math.min(la.rect.x1, lb.rect.x1) - Math.max(la.rect.x0, lb.rect.x0) > 20;
    if (ax) corridor(infra, structures[i], structures[j], la.rect, lb.rect, 'x', hash32(la.gi, la.gj, lb.gi, lb.gj));
    if (az) corridor(infra, structures[i], structures[j], la.rect, lb.rect, 'z', hash32(la.gi, la.gj, lb.gi, lb.gj, 1));
  }
  // Solar Sailer pylons standing in this district.
  for (const py of sailerNetwork().pylons) {
    const px = x + mod(py.x - x, C), pz = z + mod(py.z - z, C);
    if (px >= x + GRID.chunkSize || pz >= z + GRID.chunkSize) continue;
    const pc = pylonComponents({ ...py, x: px, z: pz }, x, z);
    infra.components.push(...pc.components);
    infra.colliders.push(...pc.colliders);
  }
  void P;
  void wrapCoord;
  return { ci, cj, key, x, z, layout, structures, lots, infra, kits, rejected, ms: performance.now() - t0 };
}

/** Does every solid of the structure stay under the airport zoning (heightCap) where it stands? */
function zoned(s: StructureSpec): boolean {
  for (const c of s.colliders) {
    const top = c.y + c.sy / 2;
    const x0 = c.x - c.sx / 2, x1 = c.x + c.sx / 2, z0 = c.z - c.sz / 2, z1 = c.z + c.sz / 2;
    if (top > Math.min(heightCap(c.x, c.z), heightCap(x0, z0), heightCap(x1, z0), heightCap(x0, z1), heightCap(x1, z1)) + 0.4) return false;
  }
  // Visual-only height (halo rings, beams) stays under the cap over the lot centre too.
  return s.height <= heightCap(s.x, s.z) + 0.4 || !Number.isFinite(heightCap(s.x, s.z)) || s.height <= heightCap(s.x, s.z);
}

/** Is the street segment between two blocks covered by one lot (no street there)? */
export function joined(gi: number, gj: number, alongX: boolean): boolean {
  const l = lotAt(gi, gj);
  if (!l) return false;
  const a = mod(gi - l.gi, GRID.blocks), b = mod(gj - l.gj, GRID.blocks);
  return alongX ? a + 1 < l.wb : b + 1 < l.db;
}
