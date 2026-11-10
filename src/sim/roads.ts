import { blockSummary, GRID } from '../world/planetCity.ts';
import { isOutlandsHighway, segmentExists } from './roadRules.ts';
import { CITY, PLANET, wrapCoord } from './layout.ts';
import { isHighwayLine, segmentOpen } from './traffic.ts';

/**
 * The road network: every drivable road on the planet in one graph, so the flight computer can
 * drive any ground vehicle anywhere (AGENTS.md §14).
 *
 * Nodes are the street intersections of the seamless block lattice (370 × 370, wrapping).
 * An edge is a street segment between two intersections that exists on the ground:
 * - every segment traffic rides (city streets and data highways; none inside a lot that
 *   covers both sides, none through airfields, the sea or the Outlands);
 * - the Outlands highways (every 37th line), whose corridors the terrain keeps clear.
 * Routing is A* on travel time (highways faster), wrap-aware.
 */
const N = GRID.blocks;
const P = GRID.pitch;
const C = PLANET.circumference;
const mod = (v: number, m: number) => ((v % m) + m) % m;

/** Cruise speeds the router assumes (m/s). */
export const ROAD_SPEED = { street: 16, highway: 30, outlands: 30 } as const;

export { isOutlandsHighway };

/**
 * Does the road segment exist? alongX: on z-line j from node (i, j) to (i + 1, j); otherwise on
 * x-line i from (i, j) to (i, j + 1). (Same segment indexing as traffic.segmentOpen.)
 */
export function roadOpen(alongX: boolean, i: number, j: number): boolean {
  return segmentExists(blockSummary(), alongX, i, j, false);
}

/** Kind of a segment (for speed and the route's description). */
export function roadKind(alongX: boolean, i: number, j: number): 'street' | 'highway' | 'outlands' {
  const line = alongX ? j : i;
  if (!segmentOpen(alongX, i, j)) return isOutlandsHighway(line) ? 'outlands' : 'street';
  return isHighwayLine(line) ? 'highway' : 'street';
}

/** World position of intersection (i, j) (unbounded indices: continuous across the wrap). */
export const nodeX = (i: number) => GRID.x0 + i * P;
export const nodeZ = (j: number) => GRID.z0 + j * P;

/** The four ways out of an intersection: [di, dj, alongX, segment i, segment j]. */
function exits(i: number, j: number): Array<[number, number, boolean, number, number]> {
  return [[1, 0, true, i, j], [-1, 0, true, i - 1, j], [0, 1, false, i, j], [0, -1, false, i, j - 1]];
}

export function nodeDegree(i: number, j: number): number {
  let n = 0;
  for (const [, , ax, si, sj] of exits(i, j)) if (roadOpen(ax, si, sj)) n++;
  return n;
}

export interface RoutePoint {
  x: number;
  z: number;
  /** Kind of the road from the previous point to this one. */
  kind: 'street' | 'highway' | 'outlands' | 'access';
}

export interface Route {
  points: RoutePoint[];
  /** Total length (m) and estimated driving time (s). */
  length: number;
  time: number;
  /** Intersections expanded by the search. */
  expanded: number;
}

/** Nearest intersection with at least one road, searching outward from (x, z) (unbounded indices near x, z). */
export function nearestNode(x: number, z: number, maxRing = 12): [number, number] | null {
  const i0 = Math.round((x - GRID.x0) / P), j0 = Math.round((z - GRID.z0) / P);
  let best: [number, number] | null = null, bd = Infinity;
  for (let r = 0; r <= maxRing; r++) {
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
      const i = i0 + a, j = j0 + b;
      if (nodeDegree(i, j) === 0) continue;
      const d = Math.hypot(nodeX(i) - x, nodeZ(j) - z);
      if (d < bd) { bd = d; best = [i, j]; }
    }
    if (best && bd < (r + 0.5) * P) break;
  }
  return best;
}

class Heap {
  private readonly a: Array<[number, number]> = [];
  get size(): number { return this.a.length; }
  push(k: number, v: number): void {
    const a = this.a;
    a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Shortest-time route on the road network from (x0, z0) to (x1, z1): from the nearest road
 * intersection to the nearest one at the destination, with access legs at both ends. Points are
 * unbounded (continuous across the planet's wrap, starting near x0, z0). Null if unreachable.
 */
export function findRoute(x0: number, z0: number, x1: number, z1: number, maxExpanded = 400000, blocked?: (alongX: boolean, i: number, j: number) => boolean): Route | null {
  const s = nearestNode(x0, z0);
  // The goal in the image nearest the start, so the search runs the short way round.
  const gx = x0 + wrapCoord(x1 - x0), gz = z0 + wrapCoord(z1 - z0);
  const g = nearestNode(gx, gz);
  if (!s || !g) return null;
  const key = (i: number, j: number) => mod(i, N) * N + mod(j, N);
  const goalKey = key(g[0], g[1]);
  const vmax = ROAD_SPEED.highway;
  const h = (i: number, j: number) => Math.hypot(wrapCoord(nodeX(i) - nodeX(g[0])), wrapCoord(nodeZ(j) - nodeZ(g[1]))) / vmax;
  const cost = new Map<number, number>();
  const from = new Map<number, number>();
  const pos = new Map<number, [number, number]>();
  const kindOf = new Map<number, RoutePoint['kind']>();
  const sk = key(s[0], s[1]);
  cost.set(sk, 0);
  pos.set(sk, s);
  const open = new Heap();
  open.push(h(s[0], s[1]), sk);
  let expanded = 0;
  let found = sk === goalKey;
  while (open.size && !found) {
    const [, k] = open.pop();
    if (++expanded > maxExpanded) return null;
    const [i, j] = pos.get(k)!;
    const ck = cost.get(k)!;
    for (const [di, dj, ax, si, sj] of exits(i, j)) {
      if (!roadOpen(ax, si, sj) || blocked?.(ax, mod(si, N), mod(sj, N))) continue;
      const kind = roadKind(ax, si, sj);
      const ni = i + di, nj = j + dj;
      const nk = key(ni, nj);
      const nc = ck + P / ROAD_SPEED[kind];
      if (nc >= (cost.get(nk) ?? Infinity)) continue;
      cost.set(nk, nc);
      from.set(nk, k);
      pos.set(nk, [ni, nj]);
      kindOf.set(nk, kind);
      if (nk === goalKey) { found = true; break; }
      open.push(nc + h(ni, nj), nk);
    }
  }
  if (!found) return null;
  const nodes: number[] = [];
  for (let k: number | undefined = goalKey; k !== undefined; k = from.get(k)) nodes.push(k);
  nodes.reverse();
  const points: RoutePoint[] = [{ x: x0, z: z0, kind: 'access' }];
  for (const k of nodes) {
    const [i, j] = pos.get(k)!;
    points.push({ x: nodeX(i), z: nodeZ(j), kind: kindOf.get(k) ?? 'access' });
  }
  const last = points[points.length - 1];
  points.push({ x: last.x + wrapCoord(gx - last.x), z: last.z + wrapCoord(gz - last.z), kind: 'access' });
  let length = 0, time = 0;
  for (let n = 1; n < points.length; n++) {
    const d = Math.hypot(points[n].x - points[n - 1].x, points[n].z - points[n - 1].z);
    length += d;
    time += d / (points[n].kind === 'access' ? 8 : ROAD_SPEED[points[n].kind as keyof typeof ROAD_SPEED]);
  }
  return { points, length, time, expanded };
}

/** Candidate spots on open road segments near (x, z), nearest first: [x, z, yaw (0 faces -Z)]. */
export function roadSpots(x: number, z: number, ring = 6): Array<[number, number, number]> {
  const i0 = Math.round((x - GRID.x0) / P), j0 = Math.round((z - GRID.z0) / P);
  const out: Array<[number, number, number, number]> = [];
  for (let a = -ring; a <= ring; a++) for (let b = -ring; b <= ring; b++) {
    const i = i0 + a, j = j0 + b;
    for (const f of [0.3, 0.7]) {
      if (roadOpen(true, i, j)) { const px = nodeX(i + f), pz = nodeZ(j); out.push([px, pz, Math.PI / 2, Math.hypot(px - x, pz - z)]); }
      if (roadOpen(false, i, j)) { const px = nodeX(i), pz = nodeZ(j + f); out.push([px, pz, 0, Math.hypot(px - x, pz - z)]); }
    }
  }
  out.sort((p, q) => p[3] - q[3]);
  return out.map(([px, pz, yaw]) => [px, pz, yaw]);
}

void CITY;
void C;

/** The road segment a point lies on (nearest street line), as [alongX, i, j] (canonical indices). */
export function segmentAt(x: number, z: number): [boolean, number, number] {
  const fx = (x - GRID.x0) / P, fz = (z - GRID.z0) / P;
  const dx = Math.abs(fx - Math.round(fx)), dz = Math.abs(fz - Math.round(fz));
  return dx < dz ? [false, mod(Math.round(fx), N), mod(Math.floor(fz), N)] : [true, mod(Math.floor(fx), N), mod(Math.round(fz), N)];
}
