import type { ArchetypeId } from './types.ts';
import { CITY, GROUND_HELIPADS, inCentral, isSea, PLANET, PLANET_HUBS, RUNWAYS, wrapCoord } from '../sim/layout.ts';
import { hash32, hashFloat, Rng } from './rng.ts';
import { onWorldReset, WORLD } from './world.ts';

/**
 * World → Region → District → Structure → Component.
 *
 * Regions are cells of a jittered lattice of sites over the whole (wrapping) planet; each site
 * is either a civilised region with a recognisable architectural identity or an Outlands
 * region with a terrain archetype. Any point blends its nearest sites over WORLD.transition
 * metres, so borders are transitional rather than hard. Hubs, airfields, helipads, the centre
 * and the coast always stay civilised and flat (they need level ground and clear airspace).
 */
export type CityRegion = 'control' | 'machine-city' | 'industrial' | 'communication' | 'transport' | 'plains' | 'caverns';
export type TerrainArchetype = 'grid-plains' | 'sea' | 'canyons' | 'wasteland' | 'mech-caverns';

export interface Atmosphere {
  /** Sky colours from the top down: zenith, upper sky, horizon, and the luminous horizon band. */
  zenith: string;
  upper: string;
  horizon: string;
  band: string;
  /** Fog / haze colour and visibility (m). */
  haze: string;
  visibility: number;
  /** Ground tint multiplier for the substrate. */
  ground: string;
}

export interface RegionProfile {
  label: string;
  description: string;
  /** Family weights for structure lots. */
  families: Partial<Record<ArchetypeId, number>>;
  /** Probability a lot is left as negative space (plaza, grid plane). */
  open: number;
  /** Lot sizes in blocks [w, d, weight]. */
  lots: ReadonlyArray<readonly [number, number, number]>;
  /** Height band (m) before hub monumentality. */
  height: readonly [number, number];
  atmosphere: Atmosphere;
}

export const REGION_PROFILES: Record<CityRegion, RegionProfile> = {
  control: {
    label: 'Monumental control centre',
    description: 'Processing towers and radial nodes at monumental scale; wide plazas between them.',
    families: { tower: 4, radial: 2.5, circuit: 1.5, industrial: 0.6 },
    open: 0.4, lots: [[2, 2, 3], [3, 3, 1.5], [1, 1, 1], [2, 3, 1]], height: [40, 420],
    atmosphere: { zenith: '#00020a', upper: '#03123d', horizon: '#0b3a7a', band: '#ffb347', haze: '#0a2a66', visibility: 14000, ground: '#0a1a44' },
  },
  'machine-city': {
    label: 'Dense machine city',
    description: 'Electronic caverns and circuit blocks packed around deep voids; little sky between.',
    families: { cavern: 4, circuit: 3, tower: 0.8, radial: 0.4 },
    open: 0.12, lots: [[1, 1, 2], [2, 2, 3], [2, 1, 2], [3, 2, 1]], height: [30, 240],
    atmosphere: { zenith: '#000108', upper: '#020c2c', horizon: '#06306a', band: '#36e2ff', haze: '#061a44', visibility: 9000, ground: '#071433' },
  },
  industrial: {
    label: 'Industrial processing zone',
    description: 'Halls, carriers and gantries along broad corridors; warm process light in a hazy sky.',
    families: { industrial: 5, circuit: 1.5, cavern: 0.6, tower: 0.5 },
    open: 0.22, lots: [[3, 1, 2], [4, 2, 2], [2, 1, 1.5], [3, 2, 2]], height: [20, 160],
    atmosphere: { zenith: '#020208', upper: '#0c1030', horizon: '#3a2a3a', band: '#ff7a1a', haze: '#1a1a33', visibility: 8000, ground: '#0b1230' },
  },
  communication: {
    label: 'Communication district',
    description: 'I/O towers, dishes and distributors on concentric plans; clear air, long sightlines.',
    families: { radial: 5, tower: 1.5, circuit: 1 },
    open: 0.35, lots: [[2, 2, 3], [1, 1, 2], [3, 3, 1]], height: [30, 300],
    atmosphere: { zenith: '#00030c', upper: '#04184a', horizon: '#1460a0', band: '#bfefff', haze: '#0e3a78', visibility: 18000, ground: '#0a1d4d' },
  },
  transport: {
    label: 'Transportation network',
    description: 'Terminals, transit hubs and carrier docks strung along the highways.',
    families: { industrial: 3, radial: 2.5, circuit: 1.5 },
    open: 0.3, lots: [[3, 1, 2], [2, 2, 2], [4, 1, 1], [1, 1, 1]], height: [20, 180],
    atmosphere: { zenith: '#00020a', upper: '#051540', horizon: '#123c74', band: '#ffb347', haze: '#0c2c66', visibility: 14000, ground: '#0a1a44' },
  },
  plains: {
    label: 'Open computational plain',
    description: 'Vast grid planes, sparse circuit blocks, enormous negative space.',
    families: { circuit: 3, radial: 1, tower: 0.6 },
    open: 0.7, lots: [[1, 1, 3], [2, 2, 1], [2, 1, 1]], height: [12, 90],
    atmosphere: { zenith: '#00030c', upper: '#04174a', horizon: '#1c6aa8', band: '#d8f4ff', haze: '#123f80', visibility: 20000, ground: '#0b2052' },
  },
  caverns: {
    label: 'Electronic caverns',
    description: 'Interlocking machine volumes over shafts and voids; dark, with light falling from above.',
    families: { cavern: 6, circuit: 1, industrial: 0.5 },
    open: 0.15, lots: [[2, 2, 3], [3, 3, 1.5], [1, 1, 1]], height: [40, 260],
    atmosphere: { zenith: '#000005', upper: '#010820', horizon: '#04224c', band: '#2f74ff', haze: '#03122e', visibility: 7000, ground: '#050f28' },
  },
};

export interface TerrainProfile {
  label: string;
  description: string;
  atmosphere: Atmosphere;
}

export const TERRAIN_PROFILES: Record<TerrainArchetype, TerrainProfile> = {
  'grid-plains': {
    label: 'Grid plains',
    description: 'Broad uninterrupted grid surfaces to the horizon, occasional elevated platforms.',
    atmosphere: { zenith: '#00030c', upper: '#051a4c', horizon: '#1d5f9c', band: '#ffb347', haze: '#123a74', visibility: 22000, ground: '#08183f' },
  },
  sea: {
    label: 'Sea of Simulation',
    description: 'Pale smooth swells, domes and lenses under a deep blue haze; orbs hang in the sky.',
    atmosphere: { zenith: '#02041a', upper: '#141a5c', horizon: '#4a6fb0', band: '#bcd6ff', haze: '#2c4a8c', visibility: 12000, ground: '#2a4f86' },
  },
  canyons: {
    label: 'Electronic canyons',
    description: 'Immense angular walls, stepped terraces, narrow passages and recessed valleys.',
    atmosphere: { zenith: '#020208', upper: '#14102a', horizon: '#5a2a1a', band: '#ff7a1a', haze: '#2a1a24', visibility: 11000, ground: '#0a0f26' },
  },
  wasteland: {
    label: 'Geometric wasteland',
    description: 'Sparse polygonal formations and isolated structures on dusty, empty ground.',
    atmosphere: { zenith: '#030308', upper: '#151c38', horizon: '#5a5a6a', band: '#ffb347', haze: '#30364c', visibility: 13000, ground: '#141a30' },
  },
  'mech-caverns': {
    label: 'Mechanical caverns',
    description: 'Enormous geometric voids under massive slabs, pillars and shafts of light.',
    atmosphere: { zenith: '#000004', upper: '#020818', horizon: '#0a1e40', band: '#36e2ff', haze: '#040c22', visibility: 6000, ground: '#040a1c' },
  },
};

export const CITY_REGIONS = Object.keys(REGION_PROFILES) as CityRegion[];
export const TERRAIN_ARCHETYPES = Object.keys(TERRAIN_PROFILES) as TerrainArchetype[];

export interface RegionSite {
  i: number;
  j: number;
  x: number;
  z: number;
  kind: 'city' | 'outlands' | 'sea';
  city: CityRegion;
  terrain: TerrainArchetype;
  name: string;
}

const C = PLANET.circumference;
const NAMES_A = ['Kernel', 'Vector', 'Cipher', 'Buffer', 'Parity', 'Octal', 'Binary', 'Lattice', 'Register', 'Carry', 'Stack', 'Cache', 'Scalar', 'Matrix', 'Pixel', 'Signal'];
const NAMES_C: Record<CityRegion, string> = { control: 'Control', 'machine-city': 'Works', industrial: 'Foundry', communication: 'Relay', transport: 'Junction', plains: 'Plain', caverns: 'Hollows' };
const NAMES_T: Record<TerrainArchetype, string> = { 'grid-plains': 'Flats', sea: 'Sea', canyons: 'Canyons', wasteland: 'Waste', 'mech-caverns': 'Vaults' };

let sitesCache: RegionSite[] | null = null;
onWorldReset(() => { sitesCache = null; });

function distToHubs(x: number, z: number): number {
  let best = Infinity;
  for (const h of [...CITY.hubs, ...PLANET_HUBS]) best = Math.min(best, Math.hypot(wrapCoord(x - h.x), wrapCoord(z - h.z)) / (h.r * 2.2));
  return best;
}

/** All region sites (cached per seed). */
export function regionSites(): RegionSite[] {
  if (sitesCache) return sitesCache;
  const n = WORLD.regionCells;
  const cell = C / n;
  const out: RegionSite[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const r = new Rng(hash32(WORLD.seed, i, j, 0x5173));
    const x = wrapCoord((i + 0.5 + r.range(-0.4, 0.4)) * cell);
    const z = wrapCoord((j + 0.5 + r.range(-0.4, 0.4)) * cell);
    const nearHub = distToHubs(x, z) < 1;
    const sea = isSea(x);
    const kind: RegionSite['kind'] = sea ? 'sea' : inCentral(x, z, 500) || nearHub ? 'city' : r.chance(WORLD.outlandsShare) ? 'outlands' : 'city';
    const mainHub = Math.hypot(wrapCoord(x - CITY.hubs[0].x), wrapCoord(z - CITY.hubs[0].z)) < cell * 0.75;
    const city: CityRegion = mainHub ? 'control' : r.weighted([['machine-city', 3], ['industrial', 2], ['communication', 2], ['transport', 1.5], ['plains', 1.6], ['caverns', 1], ['control', 0.7]] as const);
    const terrain: TerrainArchetype = r.weighted([['grid-plains', 2], ['sea', 2], ['canyons', 2.2], ['wasteland', 1.6], ['mech-caverns', 1.1]] as const);
    const name = `${NAMES_A[hash32(WORLD.seed, i, j, 77) % NAMES_A.length]} ${kind === 'outlands' ? NAMES_T[terrain] : kind === 'sea' ? 'Deep' : NAMES_C[city]}`;
    out.push({ i, j, x, z, kind, city, terrain, name });
  }
  return (sitesCache = out);
}

export interface SiteWeight {
  site: RegionSite;
  d: number;
  w: number;
}

/** The nearest region sites to (x, z), with blend weights (sum 1) over the transition width. */
export function regionWeights(x: number, z: number, k = 3, filter?: (s: RegionSite) => boolean): SiteWeight[] {
  const n = WORLD.regionCells;
  const cell = C / n;
  const sites = regionSites();
  const ci = Math.floor(((x % C) + C) % C / cell), cj = Math.floor(((z % C) + C) % C / cell);
  const best: SiteWeight[] = [];
  const reach = filter ? 3 : 2;
  for (let di = -reach; di <= reach; di++) for (let dj = -reach; dj <= reach; dj++) {
    const s = sites[(((ci + di) % n + n) % n) * n + (((cj + dj) % n + n) % n)];
    if (filter && !filter(s)) continue;
    const d = Math.hypot(wrapCoord(x - s.x), wrapCoord(z - s.z));
    best.push({ site: s, d, w: 0 });
  }
  best.sort((a, b) => a.d - b.d);
  const top = best.slice(0, k);
  if (!top.length) return top;
  const T = WORLD.transition;
  let sum = 0;
  for (const t of top) { t.w = Math.max(0, 1 - (t.d - top[0].d) / T); sum += t.w; }
  for (const t of top) t.w /= sum || 1;
  return top;
}

/** The region a point belongs to (nearest site) and how far into a transition it is (0 = core). */
export function regionAt(x: number, z: number): { site: RegionSite; secondary: RegionSite | null; blend: number } {
  const w = regionWeights(x, z, 2);
  return { site: w[0].site, secondary: w[1]?.site ?? null, blend: w[1]?.w ?? 0 };
}

/** Nearest civilised region identity (and the next one with its weight, for mixed districts). */
export function cityRegionAt(x: number, z: number): { primary: CityRegion; secondary: CityRegion; t: number; name: string } {
  const w = regionWeights(x, z, 2, (s) => s.kind === 'city');
  if (!w.length) return { primary: 'plains', secondary: 'plains', t: 0, name: 'Open Plain' };
  return { primary: w[0].site.city, secondary: (w[1] ?? w[0]).site.city, t: w[1]?.w ?? 0, name: w[0].site.name };
}

/** Terrain archetype weights at a point (from the nearest Outlands sites), summing to 1. */
export function terrainMixAt(x: number, z: number): Record<TerrainArchetype, number> {
  const out: Record<TerrainArchetype, number> = { 'grid-plains': 0, sea: 0, canyons: 0, wasteland: 0, 'mech-caverns': 0 };
  const w = regionWeights(x, z, 3, (s) => s.kind === 'outlands');
  if (!w.length) { out['grid-plains'] = 1; return out; }
  for (const t of w) out[t.site.terrain] += t.w;
  return out;
}

/**
 * Raw Outlands strength (0..1) before smoothing: the blended share of Outlands sites, faded to
 * zero around hubs, airfields, helipads, the centre and the coast.
 */
export function outlandsStrength(x: number, z: number): number {
  if (isSea(x) || inCentral(x, z, 1500)) return 0;
  const w = regionWeights(x, z, 3);
  let m = 0;
  for (const t of w) if (t.site.kind === 'outlands') m += t.w;
  if (m <= 0) return 0;
  const fadeNear = (dx: number, dz: number, r0: number, r1: number) => {
    const d = Math.hypot(wrapCoord(dx), wrapCoord(dz));
    return d < r0 ? 0 : d > r1 ? 1 : (d - r0) / (r1 - r0);
  };
  for (const h of PLANET_HUBS) m *= fadeNear(x - h.x, z - h.z, h.r * 1.2, h.r * 2.2);
  for (const r of RUNWAYS) m *= fadeNear(x - r.x, z - r.z, r.length / 2 + 1500, r.length / 2 + 2600);
  for (const p of GROUND_HELIPADS) m *= fadeNear(x - p.x, z - p.z, 300, 700);
  const coast = Math.abs(wrapCoord(x - 2500)), coast2 = Math.abs(wrapCoord(x - 8500));
  m *= Math.min(1, Math.min(coast, coast2) / 1500);
  // Region cores are fully Outlands; only the blend band is transitional.
  return Math.min(1, Math.max(0, (m - 0.3) / 0.4));
}

/** Monumentality (0..1) at a point: hub influence, as the skyline field. */
export function intensityAt(x: number, z: number): { core: number; peak: number } {
  let core = 0, peak = 0;
  for (const hub of [...CITY.hubs, ...PLANET_HUBS]) {
    const dx = wrapCoord(x - hub.x), dz = wrapCoord(z - hub.z);
    const d2 = (dx * dx + dz * dz) / (hub.r * hub.r);
    if (d2 > 9) continue;
    const k = Math.exp(-d2);
    if (k > core) { core = k; peak = hub.h; }
  }
  return { core, peak };
}

/** Deterministic per-lot draw helper. */
export const lotHash = (gi: number, gj: number, salt: number) => hashFloat(WORLD.seed, gi, gj, salt);
