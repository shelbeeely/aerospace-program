import { CITY, heightCap } from '../sim/layout.ts';
import { KIT, kitBlockFactor } from './kit.ts';

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

export interface CityKitTower {
  /** Index into KIT. */
  type: number;
  x: number;
  z: number;
  scale: number;
  /** Quarter turns about +Y. */
  rot: number;
}

export interface CityRoad {
  /** 'x' roads run along X (constant z), 'z' along Z (constant x). */
  axis: 'x' | 'z';
  /** Data highway (dense glowing traffic). */
  major?: boolean;
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
  /** Imported kit towers placed on city blocks. */
  kit: CityKitTower[];
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
  const nx = Math.floor((def.x1 - def.x0) / pitch);
  const nz = Math.floor((def.z1 - def.z0) / pitch);
  const x0 = def.x0;
  const z0 = def.z0;
  const plan: CityPlan = {
    pieces: [], buildings: [], spires: [], rings: [], beacons: [], roads: [], kit: [],
    x0, x1: x0 + nx * pitch, z0, z1: z0 + nz * pitch, pitch,
  };
  const pickColor = () => Math.floor(rnd() * def.colors.length);
  const bx = (i: number) => x0 + i * pitch + def.street / 2;
  const bz = (j: number) => z0 + j * pitch + def.street / 2;
  const blockOf = (x: number, z: number): [number, number] => [Math.floor((x - x0) / pitch), Math.floor((z - z0) / pitch)];
  /** Zoning cap over a whole block (its corners and centre). */
  const blockCap = (i: number, j: number) => {
    const xa = bx(i), za = bz(j), xb = xa + def.block, zb = za + def.block;
    return Math.min(heightCap(xa, za), heightCap(xb, za), heightCap(xa, zb), heightCap(xb, zb), heightCap((xa + xb) / 2, (za + zb) / 2));
  };
  /** Skyline: the tallest hub influence plus a low-rise base. */
  const skyline = (x: number, z: number) => {
    let h = def.baseHeight * (0.6 + rnd() * 0.8);
    let core = 0;
    for (const hub of def.hubs) {
      const k = Math.exp(-((Math.hypot(x - hub.x, z - hub.z) / hub.r) ** 2));
      h = Math.max(h, hub.h * k ** 1.3);
      core = Math.max(core, k);
    }
    return { h, core };
  };

  // Landmark sites are kept free of ordinary towers.
  const reserved = new Set<string>();
  const reserve = (i: number, j: number, w = 1, h = 1) => {
    for (let a = 0; a < w; a++) for (let b = 0; b < h; b++) reserved.add(`${i + a},${j + b}`);
  };
  const [ci, cj] = blockOf(def.hubs[0].x, def.hubs[0].z);
  reserve(ci, cj);
  const arena = { i: ci + 4, j: cj + 6 };
  reserve(arena.i, arena.j, 2, 2);
  const [si, sj] = blockOf(def.hubs[1].x, def.hubs[1].z);
  const stadium = { i: si - 3, j: sj - 3 };
  reserve(stadium.i, stadium.j, 2, 2);

  const addTower = makeTowerBuilder(plan, rnd, pickColor);

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      if (reserved.has(`${i},${j}`)) continue;
      const cap = blockCap(i, j);
      if (cap < def.minHeight) continue;
      const cx = bx(i) + def.block / 2;
      const cz = bz(j) + def.block / 2;
      const { h: sky, core } = skyline(cx, cz);
      // Open data plains and plazas, more of them away from the hubs.
      if (rnd() < 0.05 + 0.1 * (1 - core)) continue;
      // Kit towers (imported models), anywhere tall enough to fit one.
      if (rnd() < def.kitFraction && cap > 70) {
        const type = Math.floor(rnd() * KIT.length);
        const t = KIT[type];
        const rot = Math.floor(rnd() * 4);
        const want = Math.min(cap, Math.max(70, sky * (0.8 + rnd() * 0.5)));
        const scale = Math.min(want / t.size[1], 96 / Math.max(t.size[0], t.size[2]));
        void kitBlockFactor;
        plan.kit.push({ type, x: cx, z: cz, scale, rot });
        continue;
      }
      const tall = Math.min(cap, sky);
      if (core > 0.75 || rnd() < 0.45) {
        addTower(cx, cz, 34 + rnd() * 30, Math.max(def.minHeight, Math.min(cap, tall * (0.6 + rnd() * 0.6))));
      } else {
        for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          if (rnd() < 0.2) continue;
          addTower(cx + ox * 27, cz + oz * 27, 18 + rnd() * 16, Math.max(def.minHeight, Math.min(cap, tall * (0.3 + rnd() * 0.5))));
        }
      }
    }
  }

  // --- Landmarks
  addLandmarks(plan, def, bx, bz, pitch, ci, cj, arena, stadium, pickColor, rnd);

  // --- Streets (traffic lanes) and data highways on the grid lines
  for (let j = 0; j <= nz; j++) plan.roads.push({ axis: 'x', at: z0 + j * pitch, from: plan.x0, to: plan.x1, y: 0, major: j % def.highwayEvery === 0 });
  for (let i = 0; i <= nx; i++) plan.roads.push({ axis: 'z', at: x0 + i * pitch, from: plan.z0, to: plan.z1, y: 0, major: i % def.highwayEvery === 0 });

  // --- Raised freeways across the world, broken wherever the zoning forbids a 40 m structure.
  const H = def.highwayHeight;
  const freewaysX = [Math.floor(nz * 0.22), Math.floor(nz * 0.5), Math.floor(nz * 0.8)];
  const freewaysZ = [Math.floor(nx * 0.18), Math.floor(nx * 0.42)];
  for (const j of freewaysX) {
    const z = z0 + j * pitch;
    let run: number | null = null;
    for (let i = 0; i <= nx; i++) {
      const xa = x0 + i * pitch;
      const ok = i < nx && heightCap(xa, z) > H + 10 && heightCap(xa + pitch, z) > H + 10;
      if (ok && run === null) run = i;
      if ((!ok || i === nx) && run !== null && i - run >= 2) {
        const xs = x0 + run * pitch, xe = x0 + i * pitch;
        plan.pieces.push({ shape: 'box', x: (xs + xe) / 2, y: H, z, sx: xe - xs, sy: 1.6, sz: 16, color: 1, building: -1, windows: false });
        for (let x = xs + pitch / 2; x < xe; x += pitch) plan.pieces.push({ shape: 'box', x, y: H / 2, z, sx: 3, sy: H, sz: 3, color: 1, building: -1, windows: false });
        plan.roads.push({ axis: 'x', at: z, from: xs, to: xe, y: H + 0.9, major: true });
      }
      if (!ok) run = null;
    }
  }
  for (const i of freewaysZ) {
    const x = x0 + i * pitch;
    let run: number | null = null;
    for (let j = 0; j <= nz; j++) {
      const za = z0 + j * pitch;
      const ok = j < nz && heightCap(x, za) > H + 16 && heightCap(x, za + pitch) > H + 16;
      if (ok && run === null) run = j;
      if ((!ok || j === nz) && run !== null && j - run >= 2) {
        const zs = z0 + run * pitch, ze = z0 + j * pitch;
        plan.pieces.push({ shape: 'box', x, y: H + 6, z: (zs + ze) / 2, sx: 16, sy: 1.6, sz: ze - zs, color: 4, building: -1, windows: false });
        for (let zz = zs + pitch / 2; zz < ze; zz += pitch) plan.pieces.push({ shape: 'box', x, y: (H + 6) / 2, z: zz, sx: 3, sy: H + 6, sz: 3, color: 4, building: -1, windows: false });
        plan.roads.push({ axis: 'z', at: x, from: zs, to: ze, y: H + 6.9, major: true });
      }
      if (!ok) run = null;
    }
  }
  return plan;
}

/** Tower builder in the 1980s computer-world style (see the styles below). */
function makeTowerBuilder(plan: CityPlan, rnd: () => number, pickColor: () => number) {
  return (cx: number, cz: number, foot: number, height: number) => {
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
}

/** The Grid Spire, the stepped arena, the stadium and floating slabs. */
function addLandmarks(
  plan: CityPlan, def: typeof CITY, bx: (i: number) => number, bz: (j: number) => number, pitch: number,
  ci: number, cj: number, arena: { i: number; j: number }, stadium: { i: number; j: number },
  pickColor: () => number, rnd: () => number,
): void {
  const centerX = def.hubs[0].x;
  const centerZ = def.hubs[0].z;
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
    plan.pieces.push({ shape: 'box', x: centerX + Math.cos(a) * r, y, z: centerZ + Math.sin(a) * r, sx: w, sy: 6, sz: w * (0.4 + rnd() * 0.4), color: pickColor(), building: id, windows: false });
    plan.buildings.push({ id, x: centerX + Math.cos(a) * r, z: centerZ + Math.sin(a) * r, top: y + 3, color: 0 });
  }

}
