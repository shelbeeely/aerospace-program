import type { Scenario, VehicleKind, VehicleView } from '../scenario/scenario.ts';

/**
 * The Scenario Lab's district drawn top-down on a canvas, in the 1982 palette: a dark substrate,
 * blocks as large unlit panels, the data channel recessed between dim cyan edges, roads in dim
 * cyan (the bridges brighter, Market Road amber), closed crossings dark with a red bar at each
 * end (the road-damage convention), places marked by function, and the vehicles as small lit
 * marks by role. Light says what something does; most of the map stays dark.
 */
export const ROLE_LIGHT: Record<VehicleKind, string> = {
  car: '#3d7cff',
  truck: '#ffb347',
  ambulance: '#dff6ff',
  evac: '#00d4ff',
  convoy: '#ff7a1a',
};

export class ScenarioMap {
  private readonly ctx: CanvasRenderingContext2D;
  /** World → screen: scale and offset, refitted on resize. */
  private k = 1;
  private ox = 0;
  private oz = 0;
  selected: number | null = null;
  private last: VehicleView[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Fit the district (±620 × ±360 m) into the canvas. */
  private fit(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.k = Math.min(w / 1320, h / 780);
    this.ox = w / 2;
    this.oz = h / 2;
  }

  private sx(x: number): number { return this.ox + x * this.k; }
  private sz(z: number): number { return this.oz + z * this.k; }

  /** The vehicle nearest a click (canvas pixels), within reach; null if none. */
  pick(px: number, py: number): number | null {
    let best: number | null = null, bd = 14;
    for (const v of this.last) {
      const d = Math.hypot(this.sx(v.x) - px, this.sz(v.z) - py);
      if (d < bd) { bd = d; best = v.id; }
    }
    return best;
  }

  draw(sc: Scenario, time: number): void {
    this.fit();
    const c = this.ctx, d = sc.district, k = this.k;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    c.fillStyle = '#02050d';
    c.fillRect(0, 0, w, h);
    // Blocks: large unlit panels between the roads.
    c.fillStyle = '#07112a';
    const xs = [...new Set(d.nodes.map((n) => n.x))].sort((a, b) => a - b), zs = [...new Set(d.nodes.map((n) => n.z))].sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i++) {
      if (xs[i] < 0 && xs[i + 1] > 0) continue; // the channel
      for (let j = 0; j + 1 < zs.length; j++) c.fillRect(this.sx(xs[i]) + 12 * k, this.sz(zs[j]) + 12 * k, (xs[i + 1] - xs[i] - 24) * k, (zs[j + 1] - zs[j] - 24) * k);
    }
    // The channel, recessed: darker floor, lit edges.
    const ch = d.channel;
    c.fillStyle = '#010309';
    c.fillRect(this.sx(-ch.half), this.sz(ch.z0), ch.half * 2 * k, (ch.z1 - ch.z0) * k);
    c.strokeStyle = 'rgba(54, 226, 255, 0.35)';
    c.lineWidth = 1;
    for (const x of [-ch.half, ch.half]) { c.beginPath(); c.moveTo(this.sx(x), this.sz(ch.z0)); c.lineTo(this.sx(x), this.sz(ch.z1)); c.stroke(); }
    // Roads (each pair once).
    for (const e of d.edges) {
      if (e.id > e.twin) continue;
      const a = d.nodes[e.from], b = d.nodes[e.to];
      const closed = e.closed || d.edges[e.twin].closed;
      const colour = closed ? 'rgba(80, 30, 30, 0.6)' : e.kind === 'bridge' ? 'rgba(54, 226, 255, 0.75)' : e.kind === 'market' ? 'rgba(255, 179, 71, 0.45)' : e.kind === 'avenue' ? 'rgba(61, 124, 255, 0.55)' : 'rgba(29, 79, 122, 0.8)';
      c.strokeStyle = colour;
      c.lineWidth = Math.max(1.5, (e.lanes + d.edges[e.twin].lanes) * 3 * k);
      c.setLineDash(d.edges[e.twin].emergencyOnly || e.emergencyOnly ? [6, 4] : []);
      c.beginPath();
      c.moveTo(this.sx(a.x), this.sz(a.z));
      c.lineTo(this.sx(b.x), this.sz(b.z));
      c.stroke();
      c.setLineDash([]);
      if (closed) {
        // A red bar across each end.
        const len = Math.hypot(b.x - a.x, b.z - a.z), nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
        c.strokeStyle = '#ff2a12';
        c.lineWidth = 3;
        for (const t of [0.12, 0.88]) {
          const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
          c.beginPath();
          c.moveTo(this.sx(px + nx * 12), this.sz(pz + nz * 12));
          c.lineTo(this.sx(px - nx * 12), this.sz(pz - nz * 12));
          c.stroke();
        }
      }
    }
    // Places.
    const place = (id: Parameters<Scenario['place']>[0], colour: string, label: string, fill: boolean) => {
      const p = sc.place(id);
      c.strokeStyle = colour;
      c.fillStyle = colour;
      c.lineWidth = 1.5;
      const r = 9;
      if (fill) c.fillRect(this.sx(p.x) - r / 2, this.sz(p.z) - r / 2, r, r);
      else c.strokeRect(this.sx(p.x) - r / 2, this.sz(p.z) - r / 2, r, r);
      c.fillStyle = '#8fb6e8';
      c.font = '11px ui-monospace, Menlo, Consolas, monospace';
      c.fillText(label, this.sx(p.x) + 8, this.sz(p.z) - 8);
    };
    place('depot', '#ffb347', 'Depot', true);
    place('station', '#dff6ff', 'Ambulances', false);
    place('shelter', '#00d4ff', `Shelter ${sc.shelterUsed}`, false);
    place('clinic', '#dff6ff', `Clinic ${Math.max(0, sc.stock.level).toFixed(0)}`, true);
    // Bridge names.
    c.fillStyle = '#6f8fbf';
    for (const [name, [e]] of Object.entries(d.crossings)) {
      const a = d.nodes[d.edges[e].from];
      c.fillText(name, this.sx(-ch.half) + 2, this.sz(a.z) - 10);
    }
    // Vehicles.
    this.last = sc.views();
    for (const v of this.last) {
      const flash = v.emergency && Math.floor(time * 4) % 2 === 0;
      c.fillStyle = flash ? '#ff2a12' : ROLE_LIGHT[v.kind];
      c.globalAlpha = v.detail ? 1 : 0.7;
      const len = (v.kind === 'truck' || v.kind === 'convoy' ? 9 : v.kind === 'ambulance' ? 6 : 4.5) * k + 2;
      const wd = 2.5;
      const cx = this.sx(v.x), cz = this.sz(v.z);
      c.save();
      c.translate(cx, cz);
      c.rotate(Math.atan2(v.dz, v.dx));
      c.fillRect(-len, -wd / 2, len, wd);
      c.restore();
      c.globalAlpha = 1;
      if (v.id === this.selected) {
        c.strokeStyle = '#ffffff';
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(cx, cz, 9, 0, Math.PI * 2);
        c.stroke();
      }
    }
  }
}
