import type { District, RoadEdge } from './district.ts';

/**
 * Routing in the Scenario Lab: Dijkstra over the district's nodes, by travel time. An edge costs
 * its length over its limit, stretched by how full it is (`load`, vehicles over capacity), and
 * cannot be used if the asker knows it is closed, or may not enter it (emergency only).
 */
export interface RouteAsk {
  /** Closed edges this driver knows about. */
  known: ReadonlySet<number>;
  /** It is an emergency vehicle (may use emergency-only edges). */
  emergency: boolean;
  /** Vehicles on each edge now, and each edge's capacity. */
  load: ArrayLike<number>;
}

export function edgeTime(e: RoadEdge, load: number): number {
  return (e.length / e.limit) * (1 + 1.6 * Math.min(3, load));
}

/** The quickest route from node `a` to node `b` as edges, and its estimated time (s); null if none. */
export function route(d: District, a: number, b: number, ask: RouteAsk): { edges: number[]; time: number } | null {
  if (a === b) return { edges: [], time: 0 };
  const n = d.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[a] = 0;
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0 || u === b) break;
    done[u] = 1;
    for (const id of d.out[u]) {
      const e = d.edges[id];
      if (ask.known.has(id) || (e.emergencyOnly && !ask.emergency)) continue;
      const t = best + edgeTime(e, ask.load[id] ?? 0);
      if (t < dist[e.to]) { dist[e.to] = t; via[e.to] = id; }
    }
  }
  if (!Number.isFinite(dist[b])) return null;
  const edges: number[] = [];
  for (let v = b; v !== a; v = d.edges[via[v]].from) edges.push(via[v]);
  edges.reverse();
  return { edges, time: dist[b] };
}

/** The estimated time (s) of the rest of a route (edges from index `from`, the first `done` m of it already behind). */
export function routeTime(d: District, edges: readonly number[], from: number, done: number, load: ArrayLike<number>): number {
  let t = 0;
  for (let i = from; i < edges.length; i++) {
    const e = d.edges[edges[i]];
    t += edgeTime(e, load[e.id] ?? 0) * (i === from ? Math.max(0, 1 - done / e.length) : 1);
  }
  return t;
}

/** How a route is described to the player: by the named roads it takes through the crossing. */
export function describeRoute(d: District, edges: readonly number[]): string {
  const names: string[] = [];
  for (const id of edges) {
    const e = d.edges[id];
    if ((e.kind === 'bridge' || e.kind === 'market') && names[names.length - 1] !== e.name) names.push(e.name);
  }
  return names.length ? `via ${names.join(' → ')}` : 'on its own bank';
}
