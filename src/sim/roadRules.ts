import { GRID, isHighwayLine, mod } from '../arch/grid.ts';
import { outlandsLandmarks, OUTLANDS, terrainTop } from '../arch/DigitalTerrainGenerator.ts';
import { PLANET, wrapCoord } from './layout.ts';

/**
 * The road rules: which street segments exist, read from the planet's block summary (one RGBA
 * texel per block). Shared by the ground shader (what is drawn), traffic (where riders go) and
 * the road network (where the flight computer can drive), so the three always agree.
 *
 * Summary bits used: B = block kind; G bit 64 = the block's lot continues across its +x street
 * (no street there), bit 128 = across its +z street; G bit 16 = an extra road on the block's
 * -z edge (along x), bit 32 = an extra road on its -x edge (along z): connector roads that
 * link islands of streets to the network (see connectRoads).
 */
export const KIND = { lot: 0, plain: 32, outlands: 64, open: 128, airfield: 192, sea: 255 } as const;
export const BIT = { roadN: 16, roadW: 32, joinX: 64, joinZ: 128 } as const;
const N = GRID.blocks;
const P = GRID.pitch;

/** Is grid line i an Outlands highway (every OUTLANDS.highwayEvery-th line, seamless)? */
export function isOutlandsHighway(i: number): boolean {
  const k = Math.round((wrapCoord(GRID.x0 + mod(i, N) * P) - GRID.x0) / P);
  return mod(k, OUTLANDS.highwayEvery) === 0;
}

const at = (_s: Uint8Array, gi: number, gj: number) => (mod(gj, N) * N + mod(gi, N)) * 4;
const kind = (s: Uint8Array, gi: number, gj: number) => s[at(s, gi, gj) + 2];
const bits = (s: Uint8Array, gi: number, gj: number) => s[at(s, gi, gj) + 1];
const road = (k: number) => k === KIND.lot || k === KIND.open;
const highwayOk = (k: number) => road(k) || k === KIND.plain;
const passable = (k: number) => k !== KIND.sea && k !== KIND.airfield;

/** The two blocks either side of a segment. alongX: on z-line j from node (i, j) to (i + 1, j). */
function sides(alongX: boolean, i: number, j: number): [number, number, number, number] {
  return alongX ? [i, j - 1, i, j] : [i - 1, j, i, j];
}

/**
 * Does the segment exist? `traffic`: the riders' network (no Outlands highways: riders stay in
 * the cities); otherwise every road, Outlands highways and connectors included.
 */
export function segmentExists(s: Uint8Array, alongX: boolean, i: number, j: number, traffic: boolean): boolean {
  const [ai, aj, bi, bj] = sides(alongX, i, j);
  const covered = alongX ? (bits(s, ai, aj) & BIT.joinZ) !== 0 : (bits(s, ai, aj) & BIT.joinX) !== 0;
  if (covered) return false;
  const ka = kind(s, ai, aj), kb = kind(s, bi, bj);
  const extra = (bits(s, i, j) & (alongX ? BIT.roadN : BIT.roadW)) !== 0;
  if (extra) return traffic ? road(ka) && road(kb) : true;
  const line = alongX ? j : i;
  if (isHighwayLine(line) ? highwayOk(ka) && highwayOk(kb) : road(ka) && road(kb)) return true;
  if (traffic) return false;
  return isOutlandsHighway(line) && passable(ka) && passable(kb);
}

const EXITS = (i: number, j: number): Array<[number, number, boolean, number, number]> => [[1, 0, true, i, j], [-1, 0, true, i - 1, j], [0, 1, false, i, j], [0, -1, false, i, j - 1]];

/** Could a connector road run along this segment? Land, not through a lot, clear of terrain and landmarks. */
function connectable(s: Uint8Array, alongX: boolean, i: number, j: number): boolean {
  const [ai, aj, bi, bj] = sides(alongX, i, j);
  const ka = kind(s, ai, aj), kb = kind(s, bi, bj);
  if (!passable(ka) || !passable(kb)) return false;
  if (alongX ? (bits(s, ai, aj) & BIT.joinZ) !== 0 : (bits(s, ai, aj) & BIT.joinX) !== 0) return false;
  const x0 = GRID.x0 + i * P, z0 = GRID.z0 + j * P;
  const dx = alongX ? P : 0, dz = alongX ? 0 : P;
  for (const l of outlandsLandmarks()) {
    const cx = x0 + dx / 2, cz = z0 + dz / 2;
    if (Math.hypot(wrapCoord(cx - l.x), wrapCoord(cz - l.z)) < OUTLANDS.landmarkClear + P) return false;
  }
  if (ka !== KIND.outlands && kb !== KIND.outlands) return true;
  for (let t = 0; t <= P; t += 12) for (const o of [-10, 0, 10]) {
    const x = x0 + (alongX ? t : o), z = z0 + (alongX ? o : t);
    if (terrainTop(x, z) > 0.2) return false;
  }
  return true;
}

/**
 * Make the road graph one network: label connected components; link every island to the main
 * network with connector roads along terrain-clear segments (shortest first, up to a few km);
 * remove the rare fragment that cannot be linked (it stops being drawn too). Edits the summary.
 * Returns stats.
 */
export function connectRoads(s: Uint8Array): { components: number; linked: number; removed: number; connectors: number } {
  const comp = new Int32Array(N * N).fill(-1);
  const sizes: number[] = [];
  const key = (i: number, j: number) => mod(i, N) * N + mod(j, N);
  const degree = (i: number, j: number) => { let n = 0; for (const [, , ax, si, sj] of EXITS(i, j)) if (segmentExists(s, ax, si, sj, false)) n++; return n; };
  for (let k = 0; k < N * N; k++) {
    if (comp[k] >= 0) continue;
    const i0 = Math.floor(k / N), j0 = k % N;
    if (!degree(i0, j0)) continue;
    const id = sizes.length;
    let n = 0;
    const stack = [k];
    comp[k] = id;
    while (stack.length) {
      const c = stack.pop()!;
      n++;
      const i = Math.floor(c / N), j = c % N;
      for (const [di, dj, ax, si, sj] of EXITS(i, j)) {
        if (!segmentExists(s, ax, si, sj, false)) continue;
        const nk = key(i + di, j + dj);
        if (comp[nk] < 0) { comp[nk] = id; stack.push(nk); }
      }
    }
    sizes.push(n);
  }
  if (!sizes.length) return { components: 0, linked: 0, removed: 0, connectors: 0 };
  const main = sizes.indexOf(Math.max(...sizes));
  const inMain = new Uint8Array(N * N);
  for (let k = 0; k < N * N; k++) if (comp[k] === main) inMain[k] = 1;
  const members: number[][] = sizes.map(() => []);
  for (let k = 0; k < N * N; k++) if (comp[k] >= 0) members[comp[k]].push(k);
  const order = sizes.map((n, id) => [n, id]).filter(([, id]) => id !== main).sort((a, b) => b[0] - a[0]);
  let linked = 0, removed = 0, connectors = 0;
  const setExtra = (ax: boolean, si: number, sj: number) => { s[at(s, si, sj) + 1] |= ax ? BIT.roadN : BIT.roadW; connectors++; };
  const absorb = (start: number[]) => {
    const stack = [...start];
    for (const k of start) inMain[k] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const i = Math.floor(c / N), j = c % N;
      for (const [di, dj, ax, si, sj] of EXITS(i, j)) {
        if (!segmentExists(s, ax, si, sj, false)) continue;
        const nk = key(i + di, j + dj);
        if (!inMain[nk]) { inMain[nk] = 1; stack.push(nk); }
      }
    }
  };
  for (const [, id] of order) {
    const nodes = members[id];
    if (inMain[nodes[0]]) continue;
    // Breadth-first over existing roads and connectable segments, until the main network.
    const prev = new Map<number, [number, boolean, number, number] | null>();
    const queue: Array<[number, number, number]> = [];
    for (const k of nodes) { prev.set(k, null); queue.push([Math.floor(k / N), k % N, 0]); }
    let hit = -1;
    for (let q = 0; q < queue.length && hit < 0; q++) {
      const [i, j, depth] = queue[q];
      if (depth > 40) break;
      for (const [di, dj, ax, si, sj] of EXITS(i, j)) {
        const nk = key(i + di, j + dj);
        if (prev.has(nk)) continue;
        const exists = segmentExists(s, ax, si, sj, false);
        if (!exists && !connectable(s, ax, si, sj)) continue;
        prev.set(nk, [key(i, j), ax, si, sj]);
        if (inMain[nk]) { hit = nk; break; }
        queue.push([i + di, j + dj, depth + 1]);
      }
    }
    if (hit >= 0) {
      for (let k: number = hit, p = prev.get(k); p; k = p[0], p = prev.get(k)) {
        if (!segmentExists(s, p[1], p[2], p[3], false)) setExtra(p[1], p[2], p[3]);
      }
      absorb(nodes);
      linked++;
    } else {
      // Unlinkable fragment: remove its segments (no longer drawn, ridden or routed).
      for (const k of nodes) {
        const i = Math.floor(k / N), j = k % N;
        for (const [, , ax, si, sj] of EXITS(i, j)) {
          if (!segmentExists(s, ax, si, sj, false)) continue;
          const [ai, aj] = sides(ax, si, sj);
          s[at(s, ai, aj) + 1] |= ax ? BIT.joinZ : BIT.joinX;
          s[at(s, si, sj) + 1] &= ~(ax ? BIT.roadN : BIT.roadW);
        }
      }
      removed++;
    }
  }
  return { components: sizes.length, linked, removed, connectors };
}

void PLANET;
