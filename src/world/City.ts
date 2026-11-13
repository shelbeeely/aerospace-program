import { structureRoom } from '../arch/InteriorGenerator.ts';
import { districtPlan, type DistrictPlan } from '../arch/DistrictGenerator.ts';
import { blockAt, GRID, isCentralBlock } from '../arch/grid.ts';
import { BLOCK_COLORS } from '../arch/palette.ts';
import { CITY } from '../sim/layout.ts';

/**
 * The city plan: every solid of the digital architecture in a region, as axis-aligned pieces
 * shared by the simulation (static colliders, fracture) and the zoning/landing/traffic logic.
 * The architecture itself (forms, light, interiors) comes from the procedural generator in
 * src/arch; a plan only carries each structure's collider pieces, tagged with the structure id
 * so the renderer can hide a structure while it is fractured. Pure data, no three.js or DOM.
 */
/** box; oct = octagonal prism; cyl = round drum; cone = flared frustum (top radius × `taper`). */
export type CityShape = 'box' | 'oct' | 'cyl' | 'cone';

export interface CityPiece {
  shape: CityShape;
  /** Centre (m). */
  x: number;
  y: number;
  z: number;
  /** Full size (m): for round shapes sx = sz = diameter. */
  sx: number;
  sy: number;
  sz: number;
  /** Index into CITY.colors (fracture block colour). */
  color: number;
  /** Building it belongs to (-1 for infrastructure). */
  building: number;
  /** Legacy façade flag (always false: the digital architecture has no windows). */
  windows: boolean;
  /** 'cone' only: top diameter / bottom diameter. */
  taper?: number;
  /** Structure id (src/arch) or infrastructure item id: pieces with the same id fracture together. */
  arch: string;
}

export interface CityBuilding {
  id: number;
  /** Structure id in the architecture system. */
  arch: string;
  x: number;
  z: number;
  /** Roof height (m). */
  top: number;
  color: number;
  /** Its room, if it has one: hollow space that stays hollow when the structure fractures. */
  room?: CityRoom;
}

/** A structure's interior as the destruction engine needs it: the inner volume and the door openings (world, m). */
export interface CityRoom {
  /** Who lives there: the structure's id (a kit tower: kit@x,z). The people's homes know it by this. */
  id: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
  /** A round room: centre and inner radius (the rectangle above is the square round it). */
  round?: { x: number; z: number; r: number };
  /** Each doorway at the middle of its wall; `through`: the wall's thickness there (the tunnel). */
  doors: Array<{ x: number; z: number; nx: number; nz: number; width: number; height: number; through: number }>;
}

export interface CitySpire {
  x: number;
  z: number;
  y0: number;
  y1: number;
  color: number;
}

export interface CityRing {
  x: number;
  y: number;
  z: number;
  radius: number;
  color: number;
}

export interface CityRoad {
  /** 'x' roads run along X (constant z), 'z' along Z (constant x). */
  axis: 'x' | 'z';
  major?: boolean;
  at: number;
  from: number;
  to: number;
  y: number;
}

export interface CityKitTower {
  /** Index into KIT. */
  type: number;
  x: number;
  z: number;
  scale: number;
  /** Quarter turns about +Y. */
  rot: number;
}

export interface CityPlan {
  pieces: CityPiece[];
  buildings: CityBuilding[];
  /** Landmark towers (navigation destinations, lightning conductors). */
  spires: CitySpire[];
  rings: CityRing[];
  beacons: Array<[number, number, number]>;
  roads: CityRoad[];
  /** What holds what: infrastructure item id → the structures it rests on and where. */
  links: Array<{ id: string; ends: Array<{ arch: string; x: number; y: number; z: number }> }>;
  /** Imported kit towers ("Tron Buildings 1") placed on lots. */
  kit: CityKitTower[];
  /** Districts the plan was built from (canonical chunk indices). */
  districts: Array<[number, number]>;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  pitch: number;
}

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function emptyPlan(x0: number, x1: number, z0: number, z1: number): CityPlan {
  return { pieces: [], buildings: [], spires: [], rings: [], beacons: [], roads: [], kit: [], links: [], districts: [], x0, x1, z0, z1, pitch: GRID.pitch };
}

/**
 * Append a district's structures (and infrastructure) to a plan: the central ones or the rest.
 * Infrastructure pieces sharing a footprint centre (a pylon's footing and mast) share an id.
 */
export function appendDistrict(plan: CityPlan, d: DistrictPlan, central: boolean): void {
  plan.districts.push([d.ci, d.cj]);
  d.structures.forEach((s, i) => {
    if (d.lots[i].central !== central) return;
    const color = BLOCK_COLORS.indexOf(paletteOf(s)) >= 0 ? BLOCK_COLORS.indexOf(paletteOf(s)) : 0;
    const building = plan.buildings.length;
    const room = structureRoom(s);
    const I = s.interior;
    plan.buildings.push({
      id: building, arch: s.id, x: s.x, z: s.z, top: s.height, color,
      ...(room && I ? { room: { id: s.id, x0: room.x0, x1: room.x1, z0: room.z0, z1: room.z1, y0: room.y, y1: s.y + I.y1, ...(room.round ? { round: room.round } : {}), doors: room.doors.map((d) => ({ x: d.x, z: d.z, nx: d.nx, nz: d.nz, width: d.width, height: d.height, through: d.inset * 2 })) } } : {}),
    });
    for (const c of s.colliders) plan.pieces.push({ shape: c.shape, x: c.x, y: c.y, z: c.z, sx: c.sx, sy: c.sy, sz: c.sz, taper: c.taper, color, building, windows: false, arch: s.id });
    if (s.landmark && (s.archetype === 'tower' || s.archetype === 'radial')) plan.spires.push({ x: s.x, z: s.z, y0: s.height * 0.7, y1: s.height, color });
  });
  for (const k of d.kits) if (k.central === central) plan.kit.push({ type: k.type, x: k.x, z: k.z, scale: k.scale, rot: k.rot });
  for (const l of d.infra.links ?? []) {
    const [gi, gj] = blockAt(l.x, l.z);
    if (isCentralBlock(gi, gj) === central) plan.links.push({ id: `infra:${d.key}:${Math.round(l.x)},${Math.round(l.z)}`, ends: l.ends });
  }
  for (const c of d.infra.colliders) {
    const [gi, gj] = blockAt(c.x, c.z);
    if (isCentralBlock(gi, gj) !== central) continue;
    plan.pieces.push({ shape: c.shape, x: c.x, y: c.y, z: c.z, sx: c.sx, sy: c.sy, sz: c.sz, taper: c.taper, color: 1, building: -1, windows: false, arch: `infra:${d.key}:${Math.round(c.x)},${Math.round(c.z)}` });
  }
}

const paletteOf = (s: { palette: { accent: string } }) => {
  const map: Record<string, string> = { structure: BLOCK_COLORS[0], data: BLOCK_COLORS[1], process: BLOCK_COLORS[3], energy: BLOCK_COLORS[4], entrance: BLOCK_COLORS[5], warning: BLOCK_COLORS[3] };
  return map[s.palette.accent] ?? BLOCK_COLORS[0];
};

let cached: CityPlan | null = null;

/** The planned centre around Grid International (deterministic; computed once). */
export function cityPlan(): CityPlan {
  if (cached) return cached;
  const plan = emptyPlan(CITY.x0, CITY.x0 + GRID.centralX * GRID.pitch, CITY.z0, CITY.z0 + GRID.centralZ * GRID.pitch);
  const nx = Math.ceil(GRID.centralX / GRID.chunkBlocks), nz = Math.ceil(GRID.centralZ / GRID.chunkBlocks);
  for (let ci = 0; ci < nx; ci++) for (let cj = 0; cj < nz; cj++) appendDistrict(plan, districtPlan(ci, cj), true);
  return (cached = plan);
}

/** Forget the cached centre (a new world seed). */
export function resetCityPlan(): void {
  cached = null;
}
