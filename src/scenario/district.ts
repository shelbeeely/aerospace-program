/**
 * The Scenario Lab's district: one deterministic road graph, about 1.2 km × 0.6 km, cut in two by
 * a recessed data channel (the 1982 world's stand-in for a river) running north to south. North
 * Bridge and South Bridge cross it, one lane each way. The west bank holds the depot, the
 * ambulance station, the shelter and a slow Market Road through a dense block toward the South
 * Bridge; the east bank holds the clinic (with a landing pad) and most homes. Channel Avenue,
 * the faster row through the middle, stops at the channel on both banks.
 *
 * Layout variants (the design test: does a different street network change the plan?):
 * - `backup`: a third, northern crossing.
 * - `emergencyLane`: Market Road and South Bridge keep a lane that only emergency vehicles use.
 * - `depotEast`: the depot sits on the clinic's bank.
 */
export type Layout = 'base' | 'backup' | 'emergencyLane' | 'depotEast';
export const LAYOUTS: readonly Layout[] = ['base', 'backup', 'emergencyLane', 'depotEast'];
export const LAYOUT_LABEL: Record<Layout, string> = {
  base: 'Two crossings',
  backup: 'Backup crossing (north)',
  emergencyLane: 'Emergency lane on Market Road',
  depotEast: 'Depot on the clinic bank',
};

export type RoadKind = 'street' | 'avenue' | 'market' | 'bridge';

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  name: string;
  bank: 'west' | 'east';
}

/** One direction of a road. */
export interface RoadEdge {
  id: number;
  from: number;
  to: number;
  length: number;
  lanes: number;
  /** Speed limit (m/s). */
  limit: number;
  kind: RoadKind;
  name: string;
  /** The edge the other way. */
  twin: number;
  /** Closed to entry (a fight broke it): nobody enters; anyone on it drives off. */
  closed: boolean;
  /** Only emergency vehicles may enter (an emergency lane, or a contraflow's other side). */
  emergencyOnly: boolean;
  /** Lane 1 is kept for emergency vehicles (an emergency lane). */
  emergencyLane: boolean;
}

export type PlaceId = 'depot' | 'station' | 'shelter' | 'clinic' | 'westEntry' | 'eastExit';

export interface District {
  layout: Layout;
  nodes: RoadNode[];
  edges: RoadEdge[];
  /** Edges leaving each node. */
  out: number[][];
  places: Record<PlaceId, number>;
  homesWest: number[];
  homesEast: number[];
  /** The crossings by name, each as its two edges (eastbound, westbound). */
  crossings: Record<string, [number, number]>;
  /** The channel's extent (m): x from -half to +half. */
  channel: { half: number; z0: number; z1: number };
}

const XW = [-560, -400, -240, -80];
const XE = [80, 240, 400, 560];
const ZS = [-300, -150, 0, 150, 300];

export function buildDistrict(layout: Layout = 'base'): District {
  const nodes: RoadNode[] = [];
  const at = new Map<string, number>();
  const rowName = (z: number) => (z === -300 ? 'North Row' : z === -150 ? 'Bridge Row' : z === 0 ? 'Channel Avenue' : z === 150 ? 'Market Row' : 'South Row');
  for (const [bank, xs] of [['west', XW], ['east', XE]] as const) {
    for (const x of xs) for (const z of ZS) {
      const id = nodes.length;
      at.set(`${x},${z}`, id);
      nodes.push({ id, x, z, bank, name: `${bank === 'west' ? 'W' : 'E'}${xs.indexOf(x) + 1}-${rowName(z)}` });
    }
  }
  const edges: RoadEdge[] = [];
  const out: number[][] = nodes.map(() => []);
  const road = (a: number, b: number, kind: RoadKind, name: string, lanes: number, limit: number) => {
    const na = nodes[a], nb = nodes[b];
    const length = Math.hypot(nb.x - na.x, nb.z - na.z);
    const ab = edges.length, ba = ab + 1;
    edges.push({ id: ab, from: a, to: b, length, lanes, limit, kind, name, twin: ba, closed: false, emergencyOnly: false, emergencyLane: false });
    edges.push({ id: ba, from: b, to: a, length, lanes, limit, kind, name, twin: ab, closed: false, emergencyOnly: false, emergencyLane: false });
    out[a].push(ab);
    out[b].push(ba);
    return ab;
  };
  // Each bank's grid.
  for (const xs of [XW, XE]) {
    for (let i = 0; i < xs.length; i++) for (let j = 0; j < ZS.length; j++) {
      const n = at.get(`${xs[i]},${ZS[j]}`)!;
      if (i + 1 < xs.length) {
        const m = at.get(`${xs[i + 1]},${ZS[j]}`)!;
        const market = xs === XW && ZS[j] === 150;
        const avenue = ZS[j] === 0;
        road(n, m, market ? 'market' : avenue ? 'avenue' : 'street', market ? 'Market Road' : avenue ? 'Channel Avenue' : rowName(ZS[j]), market ? 1 : 2, market ? 8 : avenue ? 16 : 13);
      }
      if (j + 1 < ZS.length) road(n, at.get(`${xs[i]},${ZS[j + 1]}`)!, 'street', `${xs === XW ? 'West' : 'East'} ${i + 1} Street`, 2, 13);
    }
  }
  // The crossings.
  const crossings: Record<string, [number, number]> = {};
  const bridge = (z: number, name: string) => {
    const e = road(at.get(`-80,${z}`)!, at.get(`80,${z}`)!, 'bridge', name, 1, 12);
    crossings[name] = [e, e + 1];
  };
  bridge(-150, 'North Bridge');
  bridge(150, 'South Bridge');
  if (layout === 'backup') bridge(-300, 'Backup Bridge');
  if (layout === 'emergencyLane') {
    for (const e of edges) if (e.kind === 'market') { e.lanes = 2; e.emergencyLane = true; }
    const [sbE, sbW] = crossings['South Bridge'];
    for (const id of [sbE, sbW]) { edges[id].lanes = 2; edges[id].emergencyLane = true; }
  }
  const node = (x: number, z: number) => at.get(`${x},${z}`)!;
  const places: Record<PlaceId, number> = {
    depot: layout === 'depotEast' ? node(560, -300) : node(-560, -150),
    station: node(-400, -300),
    shelter: node(-400, 300),
    clinic: node(400, -150),
    westEntry: node(-560, 0),
    eastExit: node(560, 0),
  };
  const taken = new Set(Object.values(places));
  const homesWest = nodes.filter((n) => n.bank === 'west' && !taken.has(n.id) && n.x !== -80).map((n) => n.id);
  const homesEast = nodes.filter((n) => n.bank === 'east' && !taken.has(n.id) && n.x !== 80).map((n) => n.id);
  for (const [k, id] of Object.entries(places)) nodes[id].name = { depot: 'Depot', station: 'Ambulance station', shelter: 'Shelter', clinic: 'Clinic', westEntry: 'West entry', eastExit: 'East exit' }[k as PlaceId];
  for (const [name, [e]] of Object.entries(crossings)) {
    nodes[edges[e].from].name = `${name} west head`;
    nodes[edges[e].to].name = `${name} east head`;
  }
  return { layout, nodes, edges, out, places, homesWest, homesEast, crossings, channel: { half: 40, z0: -340, z1: 340 } };
}

/** An edge's vehicle capacity (one per 8 m of lane). */
export const edgeCapacity = (e: RoadEdge): number => Math.max(2, Math.floor((e.length * e.lanes) / 8));
