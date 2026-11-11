import { GRID, mod } from '../arch/grid.ts';
import { TERRAIN_ARCHETYPES } from '../arch/WorldRegionManager.ts';
import { mapPoint, radarPoint, type Contact } from '../sim/contacts.ts';
import { PLANET, type LandingSite } from '../sim/layout.ts';
import { BLOCK_KIND, blockSummary } from '../world/planetCity.ts';

/** Radar ranges (m), cycled by the range button. */
export const RADAR_RANGES = [2000, 5000, 12000] as const;

export interface RadarState {
  /** The player's craft: position, altitude and heading (rad, 0 = north, clockwise). */
  x: number;
  z: number;
  y: number;
  heading: number;
  contacts: Contact[];
  sites: readonly LandingSite[];
  /** The locked vehicle's id (ringed on both), if any. */
  lockedId?: string | null;
}

const CYAN = '#00d4ff', RED = '#ff2a12', PALE = '#dff6ff', DIM = 'rgba(111, 138, 168, 0.55)';
/** The Outlands on the map: dark surfaces, one step apart (light stays for what moves). */
const OUTLANDS: Record<string, [number, number, number]> = {
  'grid-plains': [10, 26, 51], sea: [22, 44, 68], canyons: [30, 22, 38], wasteland: [18, 24, 36], 'mech-caverns': [6, 10, 20],
};

/**
 * The radar scope and the planet map (plain 2D canvases over the view).
 *
 * - **Radar:** a heading-up scope around the craft at 2, 5 or 12 km: range rings, a north mark,
 *   the landing sites and every vehicle in range (a hostile beyond it sits on the rim).
 * - **Planet map:** the whole planet unrolled north-up and centred on the craft: the city, the
 *   Outlands and the sea, the runways, and every vehicle in the world.
 *
 * Vehicles are drawn by what they are: aircraft as arrowheads on their heading (hostiles solid
 * red, the rest outlined in their circuit colour), light cycles as dots, other players as
 * diamonds. Dark surfaces, thin lines, light only on what matters.
 */
export class RadarMap {
  rangeIndex = 1;
  private open = false;
  private last = -Infinity;
  private base: HTMLCanvasElement | null = null;
  private readonly scope: HTMLCanvasElement | null;
  private readonly rangeButton: HTMLElement | null;
  private readonly panel: HTMLElement | null;
  private readonly map: HTMLCanvasElement | null;
  private readonly info: HTMLElement | null;

  constructor() {
    this.scope = document.getElementById('radar-scope') as HTMLCanvasElement | null;
    this.rangeButton = document.getElementById('radar-range');
    this.panel = document.getElementById('planet-map');
    this.map = document.getElementById('planet-map-canvas') as HTMLCanvasElement | null;
    this.info = document.getElementById('planet-map-info');
    this.scope?.addEventListener('click', () => this.toggleMap());
    this.rangeButton?.addEventListener('click', () => this.cycleRange());
    document.getElementById('planet-map-close')?.addEventListener('click', () => this.toggleMap(false));
    this.label();
  }

  get range(): number {
    return RADAR_RANGES[this.rangeIndex];
  }

  get mapOpen(): boolean {
    return this.open;
  }

  cycleRange(): number {
    this.rangeIndex = (this.rangeIndex + 1) % RADAR_RANGES.length;
    this.label();
    this.last = -Infinity;
    return this.range;
  }

  toggleMap(on = !this.open): void {
    this.open = on;
    this.panel?.classList.toggle('hidden', !on);
    this.last = -Infinity;
  }

  private label(): void {
    if (this.rangeButton) this.rangeButton.textContent = `${this.range / 1000} KM`;
  }

  /** Redraw (about 15 times a second: blips do not need more). `now` in seconds. */
  update(now: number, s: RadarState): void {
    if (now - this.last < 1 / 15) return;
    this.last = now;
    if (this.scope) this.drawScope(this.scope, s);
    if (this.open && this.map) this.drawMap(this.map, s);
  }

  /** Size a canvas's backing store to its CSS box; returns its side in pixels and the scale. */
  private fit(c: HTMLCanvasElement): { size: number; k: number } {
    const k = Math.min(2, window.devicePixelRatio || 1);
    const size = Math.max(64, Math.round(c.clientWidth * k));
    if (c.width !== size || c.height !== size) c.width = c.height = size;
    return { size, k };
  }

  /** A vehicle's mark at (x, y), pointing along `angle` (rad, 0 = up, clockwise). */
  private mark(g: CanvasRenderingContext2D, c: Contact, x: number, y: number, angle: number, k: number): void {
    g.save();
    g.translate(x, y);
    g.lineWidth = k;
    if (c.kind === 'rider') {
      g.fillStyle = c.color;
      g.fillRect(-k, -k, 2 * k, 2 * k);
    } else if (c.kind === 'turret') {
      // A tower turret: a small red square, solid while it is firing.
      g.globalAlpha = c.attacking ? 1 : 0.75;
      g.strokeStyle = g.fillStyle = RED;
      if (c.attacking) g.fillRect(-3 * k, -3 * k, 6 * k, 6 * k);
      else g.strokeRect(-3 * k, -3 * k, 6 * k, 6 * k);
    } else if (c.kind === 'player') {
      g.strokeStyle = PALE;
      g.beginPath();
      g.moveTo(0, -4.5 * k); g.lineTo(4 * k, 0); g.lineTo(0, 4.5 * k); g.lineTo(-4 * k, 0);
      g.closePath();
      g.stroke();
    } else {
      // An arrowhead on its heading: a hostile solid red (brighter while it attacks).
      g.rotate(angle);
      g.beginPath();
      g.moveTo(0, -5.5 * k); g.lineTo(3.6 * k, 4 * k); g.lineTo(0, 2 * k); g.lineTo(-3.6 * k, 4 * k);
      g.closePath();
      if (c.kind === 'hostile') {
        g.globalAlpha = c.attacking ? 1 : 0.7;
        g.fillStyle = RED;
        g.fill();
      } else {
        g.strokeStyle = c.color;
        g.stroke();
      }
    }
    g.restore();
  }

  /** The locked vehicle: a cyan ring around its mark. */
  private ring(g: CanvasRenderingContext2D, x: number, y: number, k: number): void {
    g.strokeStyle = CYAN;
    g.lineWidth = 1.5 * k;
    g.beginPath();
    g.arc(x, y, 8 * k, 0, Math.PI * 2);
    g.stroke();
  }

  /** The player's own mark: a pale chevron. */
  private own(g: CanvasRenderingContext2D, x: number, y: number, angle: number, k: number): void {
    g.save();
    g.translate(x, y);
    g.rotate(angle);
    g.strokeStyle = PALE;
    g.lineWidth = 1.5 * k;
    g.beginPath();
    g.moveTo(-4.5 * k, 4.5 * k); g.lineTo(0, -6 * k); g.lineTo(4.5 * k, 4.5 * k);
    g.stroke();
    g.restore();
  }

  private drawScope(c: HTMLCanvasElement, s: RadarState): void {
    const { size, k } = this.fit(c);
    const g = c.getContext('2d');
    if (!g) return;
    const o = size / 2, R = o - 2 * k;
    g.clearRect(0, 0, size, size);
    // The scope: a dark disc, two thin range rings, a lubber line.
    g.beginPath();
    g.arc(o, o, R, 0, Math.PI * 2);
    g.fillStyle = 'rgba(4, 10, 22, 0.8)';
    g.fill();
    g.lineWidth = k;
    g.strokeStyle = 'rgba(0, 212, 255, 0.55)';
    g.stroke();
    g.strokeStyle = 'rgba(0, 212, 255, 0.16)';
    g.beginPath();
    g.arc(o, o, R / 2, 0, Math.PI * 2);
    g.moveTo(o, o - R); g.lineTo(o, o - R + 7 * k);
    g.stroke();
    // North, on the rim.
    const nx = o + Math.sin(-s.heading) * (R - 9 * k), ny = o - Math.cos(-s.heading) * (R - 9 * k);
    g.fillStyle = DIM;
    g.font = `${9 * k}px ui-monospace, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', nx, ny);
    g.save();
    g.beginPath();
    g.arc(o, o, R, 0, Math.PI * 2);
    g.clip();
    // Landing sites: small open squares.
    g.strokeStyle = DIM;
    for (const site of s.sites) {
      if (site.y > 0) continue; // rooftop pads would crowd the scope
      const p = radarPoint(s.x, s.z, s.heading, site.x, site.z, this.range);
      if (!p.inside) continue;
      const w = (site.kind === 'runway' ? 3 : 2) * k;
      g.strokeRect(o + p.x * R - w, o - p.y * R - w, 2 * w, 2 * w);
    }
    // Vehicles: riders first, aircraft over them, hostiles on top.
    const order = { rider: 0, aircraft: 1, player: 2, turret: 3, hostile: 4 } as const;
    for (const ct of [...s.contacts].sort((a, b) => order[a.kind] - order[b.kind])) {
      const p = radarPoint(s.x, s.z, s.heading, ct.x, ct.z, this.range);
      if (!p.inside && ct.kind !== 'hostile' && ct.kind !== 'turret' && ct.kind !== 'player') continue;
      const edge = p.inside ? 1 : (R - 5 * k) / R;
      this.mark(g, ct, o + p.x * R * edge, o - p.y * R * edge, ct.heading - s.heading, p.inside ? k : k * 0.75);
      if (ct.id === s.lockedId) this.ring(g, o + p.x * R * edge, o - p.y * R * edge, k);
    }
    g.restore();
    this.own(g, o, o, 0, k);
  }

  /** The planet's surface, one pixel per block (painted once). */
  private baseMap(): HTMLCanvasElement {
    if (this.base) return this.base;
    const n = GRID.blocks;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d')!;
    const img = g.createImageData(n, n);
    const sum = blockSummary();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 4;
      const tall = sum[o] / 255, region = sum[o + 1] & 15, kind = sum[o + 2];
      let rgb: [number, number, number];
      if (kind === BLOCK_KIND.sea) rgb = [3, 12, 30];
      else if (kind === BLOCK_KIND.outlands) rgb = OUTLANDS[TERRAIN_ARCHETYPES[region]] ?? [10, 20, 40];
      else if (kind === BLOCK_KIND.airfield) rgb = [111, 138, 168];
      else if (kind === BLOCK_KIND.open) rgb = [9, 20, 44];
      else if (kind === BLOCK_KIND.plain) rgb = [11, 26, 51];
      // City blocks: the taller the skyline, the paler the block.
      else rgb = [16 + tall * 40, 40 + tall * 70, 79 + tall * 80];
      img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return (this.base = c);
  }

  private drawMap(c: HTMLCanvasElement, s: RadarState): void {
    const { size, k } = this.fit(c);
    const g = c.getContext('2d');
    if (!g) return;
    const C = PLANET.circumference;
    // The surface, slid so the craft is at the centre (the planet wraps: four tiles cover it).
    const u0 = mod(s.x - GRID.x0, C) / C, v0 = mod(s.z - GRID.z0, C) / C;
    const ox = mod((0.5 - u0) * size, size), oy = mod((0.5 - v0) * size, size);
    g.imageSmoothingEnabled = false;
    const base = this.baseMap();
    for (const tx of [ox - size, ox]) for (const ty of [oy - size, oy]) g.drawImage(base, tx, ty, size, size);
    const at = (x: number, z: number) => {
      const p = mapPoint(s.x, s.z, x, z);
      return [p.u * size, p.v * size] as const;
    };
    const m = size / C; // pixels per metre
    // Runways to scale (never shorter than a tick), helipads as small squares.
    g.font = `${9 * k}px ui-monospace, monospace`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (const site of s.sites) {
      const [x, y] = at(site.x, site.z);
      g.strokeStyle = g.fillStyle = PALE;
      g.lineWidth = 1.5 * k;
      if (site.kind === 'runway') {
        const half = Math.max(3 * k, (site.length * m) / 2);
        g.beginPath();
        if (site.axis === 'x') { g.moveTo(x - half, y); g.lineTo(x + half, y); } else { g.moveTo(x, y - half); g.lineTo(x, y + half); }
        g.stroke();
        g.fillStyle = 'rgba(223, 246, 255, 0.7)';
        g.fillText(site.name, x + 6 * k, y - 6 * k);
      } else if (site.y === 0) {
        g.lineWidth = k;
        g.strokeRect(x - 1.5 * k, y - 1.5 * k, 3 * k, 3 * k);
      }
    }
    // The radar's reach around the craft.
    g.strokeStyle = 'rgba(0, 212, 255, 0.3)';
    g.lineWidth = k;
    g.beginPath();
    g.arc(size / 2, size / 2, this.range * m, 0, Math.PI * 2);
    g.stroke();
    const order = { rider: 0, aircraft: 1, player: 2, turret: 3, hostile: 4 } as const;
    const count = { rider: 0, aircraft: 0, player: 0, turret: 0, hostile: 0 };
    for (const ct of [...s.contacts].sort((a, b) => order[a.kind] - order[b.kind])) {
      count[ct.kind]++;
      const [x, y] = at(ct.x, ct.z);
      this.mark(g, ct, x, y, ct.heading, k);
      if (ct.id === s.lockedId) this.ring(g, x, y, k);
      if (ct.kind === 'player') {
        g.fillStyle = PALE;
        g.fillText(ct.name, x + 7 * k, y);
      }
    }
    this.own(g, size / 2, size / 2, s.heading, k * 1.2);
    // A scale bar: 5 km.
    const bar = 5000 * m;
    g.strokeStyle = g.fillStyle = CYAN;
    g.lineWidth = k;
    g.beginPath();
    g.moveTo(12 * k, size - 12 * k); g.lineTo(12 * k + bar, size - 12 * k);
    g.moveTo(12 * k, size - 16 * k); g.lineTo(12 * k, size - 8 * k);
    g.moveTo(12 * k + bar, size - 16 * k); g.lineTo(12 * k + bar, size - 8 * k);
    g.stroke();
    g.fillText('5 km', 18 * k + bar, size - 12 * k);
    g.textAlign = 'center';
    g.fillStyle = DIM;
    g.fillText('N', size / 2, 10 * k);
    if (this.info) {
      const text = `${count.aircraft} aircraft · ${count.hostile} hostile${count.turret ? ` · ${count.turret} turrets` : ''} · ${count.rider} light cycles${count.player ? ` · ${count.player} players` : ''}`;
      if (this.info.textContent !== text) this.info.textContent = text;
    }
  }
}
