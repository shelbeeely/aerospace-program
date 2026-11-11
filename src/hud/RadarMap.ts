import { GRID, mod } from '../arch/grid.ts';
import { TERRAIN_ARCHETYPES } from '../arch/WorldRegionManager.ts';
import { globeAngles, globeProject, globeUnproject, mapPoint, radarPoint, type Contact } from '../sim/contacts.ts';
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
  /** A carried nuke: where it would burst if dropped now, and the fireball's radius (m). */
  drop?: { x: number; z: number; radius: number; armed: boolean } | null;
  /** Who holds each district (the planet map washes it in the team's colour). */
  territory?: { version: number; ownerOf(ci: number, cj: number): number | null };
  /** The teams' light colours, by team id. */
  teamColors?: readonly string[];
}

const CYAN = '#00d4ff', PALE = '#dff6ff', DIM = 'rgba(111, 138, 168, 0.55)';
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
    // Flat map or globe (remembered); the globe turns with a drag and zooms with the wheel.
    this.modeButton = document.getElementById('planet-map-mode');
    try { this.globe = localStorage.getItem('mapGlobe') === '1'; } catch { /* default flat */ }
    this.modeButton?.addEventListener('click', () => this.setGlobe(!this.globe));
    this.setGlobe(this.globe);
    const c = this.map;
    if (c) {
      let drag: { x: number; y: number } | null = null;
      c.addEventListener('pointerdown', (e) => {
        if (!this.globe) return;
        drag = { x: e.clientX, y: e.clientY };
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', (e) => {
        if (!drag || !this.globe) return;
        const k = Math.PI / (c.clientWidth * this.zoom);
        this.view.lon -= (e.clientX - drag.x) * k;
        this.view.lat = Math.max(-1.45, Math.min(1.45, this.view.lat + (e.clientY - drag.y) * k));
        this.view.free = true;
        this.turning = performance.now();
        drag = { x: e.clientX, y: e.clientY };
        this.last = -Infinity;
      });
      const end = () => { drag = null; this.last = -Infinity; };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('wheel', (e) => {
        if (!this.globe) return;
        e.preventDefault();
        this.zoom = Math.max(0.8, Math.min(4, this.zoom * Math.exp(-e.deltaY * 0.0015)));
        this.turning = performance.now();
        this.last = -Infinity;
      }, { passive: false });
      c.addEventListener('dblclick', () => { this.view.free = false; this.zoom = 1; this.last = -Infinity; });
    }
    this.label();
  }

  private globe = false;
  private readonly modeButton: HTMLElement | null;
  /** Where the globe looks (rad); `free` once dragged (else it follows the craft). */
  private readonly view = { lon: 0, lat: 0, free: false };
  private zoom = 1;
  private turning = 0;
  private sphere: { canvas: HTMLCanvasElement; key: string } | null = null;
  private texels: { base: Uint8ClampedArray; n: number } | null = null;

  setGlobe(on: boolean): void {
    this.globe = on;
    if (this.modeButton) this.modeButton.textContent = on ? 'Flat' : 'Globe';
    try { localStorage.setItem('mapGlobe', on ? '1' : '0'); } catch { /* not remembered */ }
    this.last = -Infinity;
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
    if (this.open && this.map) (this.globe ? this.drawGlobe(this.map, s) : this.drawMap(this.map, s));
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
      // A tower turret: a small square in its team's colour, solid if it is an enemy's.
      g.globalAlpha = c.attacking ? 1 : 0.75;
      g.strokeStyle = g.fillStyle = c.color;
      if (c.foe) g.fillRect(-3 * k, -3 * k, 6 * k, 6 * k);
      else g.strokeRect(-3 * k, -3 * k, 6 * k, 6 * k);
      if (c.rail) {
        // A railgun turret: a diamond set in its square.
        g.globalAlpha = 1;
        g.fillStyle = c.foe ? '#02050c' : c.color;
        g.beginPath();
        g.moveTo(0, -2 * k); g.lineTo(2 * k, 0); g.lineTo(0, 2 * k); g.lineTo(-2 * k, 0);
        g.closePath();
        g.fill();
      }
    } else if (c.kind === 'player') {
      g.strokeStyle = PALE;
      g.beginPath();
      g.moveTo(0, -4.5 * k); g.lineTo(4 * k, 0); g.lineTo(0, 4.5 * k); g.lineTo(-4 * k, 0);
      g.closePath();
      g.stroke();
    } else {
      // An arrowhead on its heading in its side's colour: an enemy solid (brighter while it
      // fights), a friend outlined with a dot, a mercenary marked M, other traffic outlined dim.
      g.save();
      g.rotate(angle);
      g.beginPath();
      g.moveTo(0, -5.5 * k); g.lineTo(3.6 * k, 4 * k); g.lineTo(0, 2 * k); g.lineTo(-3.6 * k, 4 * k);
      g.closePath();
      g.strokeStyle = g.fillStyle = c.color;
      if (c.kind === 'hostile' && c.foe) {
        g.globalAlpha = c.attacking ? 1 : 0.7;
        g.fill();
      } else if (c.kind === 'hostile') {
        g.stroke();
        g.fillRect(-0.8 * k, -0.8 * k, 1.6 * k, 1.6 * k);
      } else {
        g.globalAlpha = 0.6;
        g.stroke();
      }
      g.restore();
      if (c.merc) {
        g.fillStyle = c.color;
        g.font = `bold ${8 * k}px ui-monospace, monospace`;
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText('M', 5 * k, -4 * k);
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
    if (s.drop) {
      // Where a nuke dropped now would burst: the fireball's reach to scale, dashed if it would be a dud.
      const p = radarPoint(s.x, s.z, s.heading, s.drop.x, s.drop.z, this.range);
      if (p.inside) {
        g.save();
        g.strokeStyle = PALE;
        g.lineWidth = k;
        if (!s.drop.armed) g.setLineDash([3 * k, 3 * k]);
        g.beginPath();
        g.arc(o + p.x * R, o - p.y * R, Math.max(3 * k, (s.drop.radius / this.range) * R), 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }
    }
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

  private wash: HTMLCanvasElement | null = null;
  private washVersion = -1;

  /** One pixel per district in its holder's colour (rebuilt when territory changes hands). */
  private washMap(s: RadarState): HTMLCanvasElement | null {
    const t = s.territory, colors = s.teamColors;
    if (!t || !colors) return null;
    if (this.wash && this.washVersion === t.version) return this.wash;
    const n = GRID.chunks;
    const c = (this.wash ??= document.createElement('canvas'));
    c.width = c.height = n;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, n, n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const team = t.ownerOf(i, j);
      if (team === null) continue;
      g.fillStyle = colors[team];
      g.fillRect(i, j, 1, 1);
    }
    this.washVersion = t.version;
    return c;
  }

  /**
   * The globe: the same map on a sphere, lit from the upper left with a thin glowing limb. The
   * surface is drawn pixel by pixel into a smaller canvas (half size while it turns) and cached
   * until the view or the territory changes; the vehicles, sites and the radar's reach go on top.
   */
  private drawGlobe(c: HTMLCanvasElement, s: RadarState): void {
    const { size, k } = this.fit(c);
    const g = c.getContext('2d');
    if (!g) return;
    const C = PLANET.circumference;
    const uv = (x: number, z: number) => ({ u: mod(x - GRID.x0, C) / C, v: mod(z - GRID.z0, C) / C });
    const me = uv(s.x, s.z);
    if (!this.view.free) {
      const a = globeAngles(me.u, me.v);
      this.view.lon = a.lon;
      this.view.lat = Math.max(-1.45, Math.min(1.45, a.lat));
    }
    const R = (size / 2 - 14 * k) * this.zoom, cx = size / 2, cy = size / 2;
    // The surface.
    const moving = performance.now() - this.turning < 250;
    const res = Math.max(96, Math.round(Math.min(size, 2 * R + 4) * (moving ? 0.4 : 0.75)));
    const key = `${this.view.lon.toFixed(4)},${this.view.lat.toFixed(4)},${this.zoom.toFixed(3)},${res},${s.territory?.version ?? 0}`;
    if (!this.sphere || this.sphere.key !== key) this.sphere = { canvas: this.paintSphere(res, s), key };
    g.fillStyle = '#02050c';
    g.fillRect(0, 0, size, size);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.sphere.canvas, cx - R, cy - R, 2 * R, 2 * R);
    // The limb: a thin line of light round the edge.
    g.strokeStyle = 'rgba(0, 212, 255, 0.55)';
    g.lineWidth = 1.5 * k;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    const at = (x: number, z: number) => {
      const p = uv(x, z);
      const a = globeAngles(p.u, p.v);
      const q = globeProject(a.lon, a.lat, this.view.lon, this.view.lat);
      return { x: cx + q.x * R, y: cy - q.y * R, front: q.z > 0.02 };
    };
    g.font = `${9 * k}px ui-monospace, monospace`;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (const site of s.sites) {
      if (site.kind !== 'runway') continue;
      const p = at(site.x, site.z);
      if (!p.front) continue;
      g.fillStyle = PALE;
      g.fillRect(p.x - 1.5 * k, p.y - 1.5 * k, 3 * k, 3 * k);
      g.fillStyle = 'rgba(223, 246, 255, 0.7)';
      g.fillText(site.name, p.x + 5 * k, p.y - 5 * k);
    }
    // The radar's reach round the craft (a small circle on the surface).
    const reach = (this.range / C) * Math.PI * 2 * R;
    const own = at(s.x, s.z);
    if (own.front) {
      g.strokeStyle = 'rgba(0, 212, 255, 0.35)';
      g.lineWidth = k;
      g.beginPath();
      g.arc(own.x, own.y, Math.max(3 * k, reach), 0, Math.PI * 2);
      g.stroke();
    }
    const order = { rider: 0, aircraft: 1, player: 2, turret: 3, hostile: 4 } as const;
    for (const ct of [...s.contacts].sort((a, b) => order[a.kind] - order[b.kind])) {
      const p = at(ct.x, ct.z);
      if (!p.front) continue;
      this.mark(g, ct, p.x, p.y, ct.heading, k * 0.85);
      if (ct.id === s.lockedId) this.ring(g, p.x, p.y, k);
    }
    if (own.front) this.own(g, own.x, own.y, s.heading, k * 1.2);
    g.fillStyle = DIM;
    g.textAlign = 'center';
    g.fillText('drag to turn · wheel to zoom · double-click to recentre', size / 2, size - 8 * k);
    if (this.info) this.info.textContent = `${s.contacts.filter((x) => x.kind === 'hostile' && x.foe).length} enemy aircraft · ${s.contacts.filter((x) => x.kind === 'turret').length} turrets`;
  }

  /** Paint the globe's lit surface (base map and territory) into a res × res canvas. */
  private paintSphere(res: number, s: RadarState): HTMLCanvasElement {
    if (!this.texels) {
      const b = this.baseMap();
      const n = b.width;
      this.texels = { base: b.getContext('2d')!.getImageData(0, 0, n, n).data, n };
    }
    const { base, n } = this.texels;
    const wash = s.territory && s.teamColors ? this.washMap(s) : null;
    const washPx = wash ? wash.getContext('2d')!.getImageData(0, 0, wash.width, wash.height).data : null;
    const wn = wash?.width ?? 1;
    const c = document.createElement('canvas');
    c.width = c.height = res;
    const g = c.getContext('2d')!;
    const img = g.createImageData(res, res);
    const L = { x: -0.45, y: 0.55, z: 0.7 }; // light from the upper left
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const x = (i + 0.5) / res * 2 - 1, y = 1 - (j + 0.5) / res * 2;
      const a = globeUnproject(x, y, this.view.lon, this.view.lat);
      if (!a) continue;
      const u = mod(a.lon / (Math.PI * 2), 1), v = Math.min(0.9999, Math.max(0, 0.5 - a.lat / Math.PI));
      const bi = (Math.floor(v * n) * n + Math.floor(u * n)) * 4;
      let r = base[bi], gg = base[bi + 1], bb = base[bi + 2];
      if (washPx) {
        const wi = (Math.floor(v * wn) * wn + Math.floor(u * wn)) * 4;
        if (washPx[wi + 3]) {
          r += (washPx[wi] - r) * 0.28; gg += (washPx[wi + 1] - gg) * 0.28; bb += (washPx[wi + 2] - bb) * 0.28;
        }
      }
      const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      const lit = 0.45 + 0.75 * Math.max(0, x * L.x + y * L.y + z * L.z);
      const o = (j * res + i) * 4;
      img.data[o] = Math.min(255, r * lit); img.data[o + 1] = Math.min(255, gg * lit); img.data[o + 2] = Math.min(255, bb * lit); img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
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
    // Territory: each district faintly washed in its holder's colour.
    const wash = this.washMap(s);
    if (wash) {
      g.imageSmoothingEnabled = true;
      g.globalAlpha = 0.28;
      for (const tx of [ox - size, ox]) for (const ty of [oy - size, oy]) g.drawImage(wash, tx, ty, size, size);
      g.globalAlpha = 1;
      g.imageSmoothingEnabled = false;
    }
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
    const count = { rider: 0, aircraft: 0, player: 0, turret: 0, hostile: 0, friend: 0 };
    for (const ct of [...s.contacts].sort((a, b) => order[a.kind] - order[b.kind])) {
      if (ct.kind === 'hostile' && !ct.foe) count.friend++;
      else count[ct.kind]++;
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
      const text = `${count.aircraft} aircraft · ${count.friend} friendly · ${count.hostile} enemy${count.turret ? ` · ${count.turret} turrets` : ''} · ${count.rider} light cycles${count.player ? ` · ${count.player} players` : ''}`;
      if (this.info.textContent !== text) this.info.textContent = text;
    }
  }
}
