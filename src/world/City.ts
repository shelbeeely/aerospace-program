import { CITY } from '../sim/layout.ts';

/**
 * Seeded city plan shared by the simulation (static colliders) and the renderer. Pure data, no
 * three.js or DOM: every piece is an axis-aligned box or an upright octagonal prism.
 */
/** box; oct = octagonal prism; cyl = round drum; cone = flared frustum (top radius × `taper`). */
export type CityShape = 'box' | 'oct' | 'cyl' | 'cone';

export interface CityPiece {
  shape: CityShape;
  /** Centre (m). */
  x: number;
  y: number;
  z: number;
  /** Full size (m): for 'oct' sx = sz = diameter. */
  sx: number;
  sy: number;
  sz: number;
  /** Index into CITY.colors. */
  color: number;
  /** Building it belongs to (-1 for highways). */
  building: number;
  /** Façade windows (towers yes, highway decks no). */
  windows: boolean;
  /** 'cone' only: top diameter / bottom diameter (< 1 flares out at the base). */
  taper?: number;
}

export interface CityBuilding {
  id: number;
  x: number;
  z: number;
  /** Roof height (m), excluding spires. */
  top: number;
  color: number;
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
  /** Constant coordinate of the road centreline. */
  at: number;
  from: number;
  to: number;
  /** Raised highway deck height (0 = street level). */
  y: number;
}

export interface CityPlan {
  pieces: CityPiece[];
  buildings: CityBuilding[];
  spires: CitySpire[];
  rings: CityRing[];
  /** Red aviation obstruction lights (x, y, z). */
  beacons: Array<[number, number, number]>;
  /** Drivable lanes for traffic (streets and highway decks). */
  roads: CityRoad[];
  /** City rectangle. */
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

let cached: CityPlan | null = null;

/** The city plan (deterministic; computed once). */
export function cityPlan(): CityPlan {
  return (cached ??= buildCity());
}

function buildCity(def = CITY): CityPlan {
  const rnd = mulberry32(def.seed);
  const pitch = def.block + def.street;
  const nx = Math.floor(def.sizeX / pitch);
  const nz = Math.floor(def.sizeZ / pitch);
  const x0 = def.centerX - (nx * pitch) / 2;
  const z0 = def.centerZ - (nz * pitch) / 2;
  const plan: CityPlan = {
    pieces: [], buildings: [], spires: [], rings: [], beacons: [], roads: [],
    x0, x1: x0 + nx * pitch, z0, z1: z0 + nz * pitch, pitch,
  };
  const pickColor = () => Math.floor(rnd() * def.colors.length);

  // Landmark sites (block indices) are kept free of ordinary towers.
  const ci = Math.floor(nx / 2);
  const cj = Math.floor(nz / 2);
  const reserved = new Set<string>();
  const reserve = (i: number, j: number, w = 1, h = 1) => {
    for (let a = 0; a < w; a++) for (let b = 0; b < h; b++) reserved.add(`${i + a},${j + b}`);
  };
  reserve(ci, cj); // the Grid Spire
  const arena = { i: Math.min(nx - 3, ci + 4), j: Math.min(nz - 3, cj + 6) };
  reserve(arena.i, arena.j, 2, 2);
  const stadium = { i: Math.max(1, ci - 6), j: Math.max(1, cj - 8) };
  reserve(stadium.i, stadium.j, 2, 2);
  // Highways run above the streets on these grid lines.
  const hwX = [Math.floor(nz * 0.3), Math.floor(nz * 0.7)]; // along X at these row lines
  const hwZ = [Math.floor(nx * 0.35), Math.floor(nx * 0.75)]; // along Z at these column lines

  // Block corner (min x, min z) of block (i, j).
  const bx = (i: number) => x0 + i * pitch + def.street / 2;
  const bz = (j: number) => z0 + j * pitch + def.street / 2;

  /**
   * One tower in the 1980s computer-world style: flared frustum bases, stacked octagonal or
   * round shafts with band rings, hammerhead top blocks, or boxy setback slabs.
   */
  const addTower = (cx: number, cz: number, foot: number, height: number) => {
    const id = plan.buildings.length;
    const color = pickColor();
    let y = 0;
    const piece = (shape: CityShape, sx: number, sy: number, sz: number, extra: Partial<CityPiece> = {}) => {
      plan.pieces.push({ shape, x: cx, y: y + sy / 2, z: cz, sx, sy, sz, color, building: id, windows: shape !== 'cone', ...extra });
      y += sy;
    };
    const style = rnd();
    if (height < 40) {
      // Low blocks: a box or drum with a thin band on top.
      if (rnd() < 0.5) piece('box', foot, height, foot * (0.7 + rnd() * 0.5));
      else piece('cyl', foot, height, foot);
    } else if (style < 0.4) {
      // Stacked octagons on a flared base, a band ring, a narrower upper shaft, a top block.
      const base = Math.min(height * 0.18, 10 + rnd() * 18);
      piece('cone', foot * 1.7, base, foot * 1.7, { taper: 0.62 });
      const s1 = (height - base) * (0.45 + rnd() * 0.15);
      piece('oct', foot, s1, foot);
      piece('cyl', foot * 1.18, 3 + rnd() * 3, foot * 1.18);
      const s2 = (height - y) * (0.6 + rnd() * 0.15);
      piece('oct', foot * 0.72, s2, foot * 0.72);
      const head = height - y;
      if (rnd() < 0.5) piece('box', foot * 1.05, head, foot * 0.8); // hammerhead
      else { piece('cone', foot * 0.72, head * 0.4, foot * 0.72, { taper: 0.55 }); piece('oct', foot * 0.4, height - y, foot * 0.4); }
    } else if (style < 0.65) {
      // Drum tower: wide round podium, round shaft with rings, flared crown.
      const base = 8 + rnd() * 10;
      piece('cyl', foot * 1.6, base, foot * 1.6);
      const rings = 1 + Math.floor(rnd() * 3);
      const seg = (height * 0.9 - base) / rings;
      for (let r = 0; r < rings; r++) {
        piece('cyl', foot * (1 - r * 0.12), seg - 3, foot * (1 - r * 0.12));
        piece('cyl', foot * (1.12 - r * 0.12), 3, foot * (1.12 - r * 0.12));
      }
      piece('cone', foot * 0.9, Math.max(2, height - y), foot * 0.9, { taper: 0.35 });
    } else {
      // Boxy slab with setbacks (podium, shaft, setback, crown).
      const depth = foot * (0.7 + rnd() * 0.5);
      const podium = 10 + rnd() * 14;
      piece('box', foot + 10, podium, depth + 10);
      piece('box', foot, (height - podium) * (0.55 + rnd() * 0.2), depth);
      piece('box', foot * 0.74, (height - y) * (0.6 + rnd() * 0.25), depth * 0.74);
      piece('box', foot * 0.5, height - y, depth * 0.5);
    }
    plan.buildings.push({ id, x: cx, z: cz, top: height, color });
    if (height > 140) {
      const spire = height * (0.08 + rnd() * 0.12);
      plan.spires.push({ x: cx, z: cz, y0: height, y1: height + spire, color });
      plan.beacons.push([cx, height + spire, cz]);
    } else if (height > 90) {
      plan.beacons.push([cx, height + 1, cz]);
    }
  };

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      if (reserved.has(`${i},${j}`)) continue;
      const cx = bx(i) + def.block / 2;
      const cz = bz(j) + def.block / 2;
      const d = Math.hypot(cx - def.centerX, cz - def.centerZ);
      const core = Math.exp(-((d / def.downtownRadius) ** 2));
      // Sparse parks/plazas on the outskirts.
      if (rnd() < 0.06 + 0.12 * (1 - core)) continue;
      const tall = def.minHeight + (def.maxHeight - def.minHeight) * core ** 1.4;
      const layout = rnd();
      if (layout < 0.45 || core > 0.75) {
        // One big tower per block.
        const foot = 36 + rnd() * 30;
        addTower(cx, cz, foot, Math.max(def.minHeight, tall * (0.55 + rnd() * 0.6)));
      } else {
        // Four smaller towers on a 2×2 lot grid.
        for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          if (rnd() < 0.15) continue;
          const foot = 18 + rnd() * 16;
          addTower(cx + ox * 27, cz + oz * 27, foot, Math.max(def.minHeight, tall * (0.25 + rnd() * 0.5)));
        }
      }
    }
  }

  // --- Landmarks
  // The Grid Spire: tallest structure in the world, haloed by rings, at the centre of downtown.
  {
    const cx = bx(ci) + def.block / 2;
    const cz = bz(cj) + def.block / 2;
    const id = plan.buildings.length;
    const c = 0;
    const tiers: Array<[number, number]> = [[70, 40], [40, 300], [26, 130], [14, 60]];
    let y = 0;
    for (const [w, h] of tiers) {
      plan.pieces.push({ shape: 'box', x: cx, y: y + h / 2, z: cz, sx: w, sy: h, sz: w, color: c, building: id, windows: true });
      y += h;
    }
    plan.buildings.push({ id, x: cx, z: cz, top: y, color: c });
    plan.spires.push({ x: cx, z: cz, y0: y, y1: y + 90, color: 1 });
    plan.beacons.push([cx, y + 90, cz], [cx, 340, cz], [cx, 470, cz]);
    plan.rings.push({ x: cx, y: 330, z: cz, radius: 46, color: 2 }, { x: cx, y: 455, z: cz, radius: 34, color: 3 }, { x: cx, y: 520, z: cz, radius: 22, color: 0 });
  }
  // Pyramid arena: stepped pyramid (stacked boxes), 2×2 blocks.
  {
    const cx = bx(arena.i) + pitch - def.street / 2;
    const cz = bz(arena.j) + pitch - def.street / 2;
    const id = plan.buildings.length;
    const steps = 7;
    const base = 2 * def.block;
    const h = 14;
    for (let k = 0; k < steps; k++) {
      const w = base * (1 - k / steps);
      plan.pieces.push({ shape: 'box', x: cx, y: k * h + h / 2, z: cz, sx: w, sy: h, sz: w, color: 1, building: id, windows: false });
    }
    plan.buildings.push({ id, x: cx, z: cz, top: steps * h, color: 1 });
    plan.beacons.push([cx, steps * h + 1, cz]);
  }
  // Stadium: a ring of 20 stands around an open pitch, 2×2 blocks.
  {
    const cx = bx(stadium.i) + pitch - def.street / 2;
    const cz = bz(stadium.j) + pitch - def.street / 2;
    const id = plan.buildings.length;
    const r = 95;
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      const along = Math.abs(Math.cos(a)) > Math.abs(Math.sin(a));
      plan.pieces.push({
        shape: 'box', x: cx + Math.cos(a) * r, y: 12, z: cz + Math.sin(a) * r,
        sx: along ? 14 : 32, sy: 24, sz: along ? 32 : 14, color: 4, building: id, windows: false,
      });
    }
    plan.buildings.push({ id, x: cx, z: cz, top: 24, color: 4 });
    plan.rings.push({ x: cx, y: 26, z: cz, radius: r + 10, color: 4 }, { x: cx, y: 0.5, z: cz, radius: 60, color: 5 });
  }

  // Floating slabs: thin platforms hovering over downtown (solid: you can land on one).
  for (let k = 0; k < 9; k++) {
    const a = rnd() * Math.PI * 2;
    const r = 250 + rnd() * 900;
    const id = plan.buildings.length;
    const y = 280 + rnd() * 260;
    const w = 60 + rnd() * 90;
    plan.pieces.push({ shape: 'box', x: def.centerX + Math.cos(a) * r, y, z: def.centerZ + Math.sin(a) * r, sx: w, sy: 6, sz: w * (0.4 + rnd() * 0.4), color: pickColor(), building: id, windows: false });
    plan.buildings.push({ id, x: def.centerX + Math.cos(a) * r, z: def.centerZ + Math.sin(a) * r, top: y + 3, color: 0 });
  }

  // --- Streets (traffic lanes) and raised highways on the grid lines
  for (let j = 0; j <= nz; j++) plan.roads.push({ axis: 'x', at: z0 + j * pitch, from: plan.x0, to: plan.x1, y: 0 });
  for (let i = 0; i <= nx; i++) plan.roads.push({ axis: 'z', at: x0 + i * pitch, from: plan.z0, to: plan.z1, y: 0 });
  const H = def.highwayHeight;
  for (const j of hwX) {
    const z = z0 + j * pitch;
    plan.pieces.push({ shape: 'box', x: (plan.x0 + plan.x1) / 2, y: H, z, sx: plan.x1 - plan.x0, sy: 1.6, sz: 16, color: 1, building: -1, windows: false });
    for (let x = plan.x0 + pitch / 2; x < plan.x1; x += pitch) plan.pieces.push({ shape: 'box', x, y: H / 2, z, sx: 3, sy: H, sz: 3, color: 1, building: -1, windows: false });
    plan.roads.push({ axis: 'x', at: z, from: plan.x0, to: plan.x1, y: H + 0.9 });
  }
  for (const i of hwZ) {
    const x = x0 + i * pitch;
    plan.pieces.push({ shape: 'box', x, y: H + 6, z: (plan.z0 + plan.z1) / 2, sx: 16, sy: 1.6, sz: plan.z1 - plan.z0, color: 3, building: -1, windows: false });
    for (let z = plan.z0 + pitch / 2; z < plan.z1; z += pitch) plan.pieces.push({ shape: 'box', x, y: (H + 6) / 2, z, sx: 3, sy: H + 6, sz: 3, color: 3, building: -1, windows: false });
    plan.roads.push({ axis: 'z', at: x, from: plan.z0, to: plan.z1, y: H + 6.9 });
  }
  return plan;
}
