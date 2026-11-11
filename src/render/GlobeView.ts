import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GRID } from '../arch/grid.ts';
import { globeToWorld, worldToGlobe, wrapDelta, type Contact } from '../sim/contacts.ts';
import { PLANET, type LandingSite } from '../sim/layout.ts';
import type { StrikeKind } from '../sim/strikes.ts';

/** What the strike globe shows. */
export interface GlobeState {
  me: { x: number; z: number; heading: number };
  contacts: Contact[];
  sites: readonly LandingSite[];
  /** Strikes in flight: where they set out, the target, where they are now, ETA (s). */
  strikes: Array<{ kind: StrikeKind; x: number; z: number; fromX: number; fromZ: number; at: { x: number; z: number } | null; eta: number }>;
  /** Attack orders: their points. */
  orders: Array<{ x: number; z: number }>;
  /** The surface (one pixel per block) and the territory wash (one per district), or null. */
  surface: HTMLCanvasElement;
  wash: HTMLCanvasElement | null;
  /** Bumped when the wash changes (the texture is rebuilt). */
  washVersion: number;
}

/**
 * The globe's frame: the planet's origin (the city) sits on the equator, facing longitude 180°,
 * so the poles (where a wrapped map pinches) fall far out in the Outlands.
 */
const C = PLANET.circumference;
const X0 = -C / 2, Z0 = -C / 2;
const CYAN = '#00d4ff', PALE = '#dff6ff', HOT = '#ffb347';
const TEX = 1480;

/**
 * The strike globe: the whole planet as a real 3D globe in its own small three.js scene and
 * WebGL canvas, full screen over the view, rendered only while it is open.
 *
 * - The sphere carries the planet's surface map with the team territory washed over it, lit from
 *   one side, with a faint graticule and a thin glow on the limb against the dark.
 * - On it: runways as pale ticks, turrets as small squares in their team's colour, aircraft as
 *   arrowheads (enemies solid), other players as diamonds, the craft as a white chevron;
 *   strikes in flight as bright dots on a dotted path to their target, attack orders as rings.
 * - Drag (or touch) to turn it, wheel or pinch to zoom; a click or tap picks a spot (a ray
 *   against the sphere, back to planet x, z), marked with a reticle. `onPick` hears of it.
 */
export class GlobeView {
  readonly root: HTMLElement;
  /** Where the strike panel goes (beside the globe). */
  readonly side: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private renderer: THREE.WebGPURenderer | null = null;
  private ready = false;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.05, 50);
  private controls: OrbitControls | null = null;
  private readonly sphere: THREE.Mesh;
  private readonly texCanvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private texKey = '';
  /** The picked spot (planet x, z), or null. */
  picked: { x: number; z: number } | null = null;
  onPick: ((x: number, z: number) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor() {
    const el = (tag: string, id = '', cls = '') => {
      const e = document.createElement(tag);
      if (id) e.id = id;
      if (cls) e.className = cls;
      return e;
    };
    this.root = el('div', 'strike-globe', 'hidden');
    const stage = el('div', '', 'globe-stage');
    this.canvas = el('canvas', 'strike-globe-canvas') as HTMLCanvasElement;
    this.overlay = el('canvas', '', 'globe-overlay') as HTMLCanvasElement;
    const hint = el('div', '', 'globe-hint');
    hint.textContent = 'Drag to turn · wheel to zoom · click a spot to target it · Shift+Tab closes';
    stage.append(this.canvas, this.overlay, hint);
    this.side = el('div', '', 'globe-side');
    this.root.append(stage, this.side);
    document.body.append(this.root);

    this.texCanvas.width = this.texCanvas.height = TEX;
    this.texture = new THREE.CanvasTexture(this.texCanvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const mat = new THREE.MeshLambertMaterial({ map: this.texture, emissive: 0xffffff, emissiveMap: this.texture, emissiveIntensity: 0.55 });
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), mat);
    this.scene.add(this.sphere);
    // A faint graticule (every 30°) just above the surface.
    const pts: number[] = [];
    const push = (a: THREE.Vector3, b: THREE.Vector3) => pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    const at = (lat: number, lon: number) => new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)).multiplyScalar(1.002);
    for (let lat = -60; lat <= 60; lat += 30) for (let lon = 0; lon < 360; lon += 4) push(at(lat * Math.PI / 180, lon * Math.PI / 180), at(lat * Math.PI / 180, (lon + 4) * Math.PI / 180));
    for (let lon = 0; lon < 360; lon += 30) for (let lat = -88; lat < 88; lat += 4) push(at(lat * Math.PI / 180, lon * Math.PI / 180), at((lat + 4) * Math.PI / 180, lon * Math.PI / 180));
    const grid = new THREE.BufferGeometry();
    grid.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.LineSegments(grid, new THREE.LineBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.1 })));
    // (The limb's thin glow is drawn in the overlay, round the sphere's outline.)
    // Lit from the upper left of the view (the light rides with the camera).
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(-2, 1.5, 1);
    this.camera.add(sun);
    this.scene.add(this.camera);
    this.camera.position.set(0, 0, 3.4);

    // Picking: a click (not a drag) casts a ray at the sphere.
    let down: { x: number; y: number } | null = null;
    this.overlay.style.pointerEvents = 'none';
    this.canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down = null; return; }
      down = null;
      const r = this.canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObject(this.sphere)[0];
      if (!hit) return;
      const w = globeToWorld(hit.point.x, hit.point.y, hit.point.z, X0, Z0);
      this.picked = w;
      this.onPick?.(w.x, w.z);
    });
    window.addEventListener('keydown', (e) => {
      if (this.visible && e.code === 'Escape') { e.preventDefault(); this.toggle(false); }
    });
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** Open (turned to face `centre`, the craft) or close. */
  toggle(on = !this.visible, centre?: { x: number; z: number }): void {
    this.root.classList.toggle('hidden', !on);
    if (!on) { this.onClose?.(); return; }
    this.ensureRenderer();
    if (centre) {
      const p = worldToGlobe(centre.x, centre.z, X0, Z0);
      const d = this.camera.position.length();
      this.camera.position.set(p.x, p.y, p.z).multiplyScalar(d);
      this.camera.lookAt(0, 0, 0);
      this.controls?.update();
    }
  }

  private ensureRenderer(): void {
    if (this.renderer) return;
    // Its own small renderer on WebGL (it leaves the main view's GPU device alone).
    this.renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true, alpha: true, forceWebGL: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    void this.renderer.init().then(() => { this.ready = true; });
    const c = new OrbitControls(this.camera, this.canvas);
    c.enablePan = false;
    c.enableDamping = true;
    c.dampingFactor = 0.12;
    c.rotateSpeed = 0.45;
    c.minDistance = 1.35;
    c.maxDistance = 6;
    c.zoomSpeed = 0.8;
    this.controls = c;
  }

  /** The surface texture: the map at four times its size, the territory washed over it. */
  private paint(s: GlobeState): void {
    const key = `${s.washVersion}`;
    if (key === this.texKey) return;
    this.texKey = key;
    const g = this.texCanvas.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.globalAlpha = 1;
    // The maps start at GRID.x0, z0; the globe's frame at X0, Z0: draw them shifted (and wrapped).
    const ox = ((((GRID.x0 - X0) / C) % 1) + 1) % 1 * TEX, oy = ((((GRID.z0 - Z0) / C) % 1) + 1) % 1 * TEX;
    const tile = (img: HTMLCanvasElement) => {
      for (const dx of [ox - TEX, ox]) for (const dy of [oy - TEX, oy]) g.drawImage(img, dx, dy, TEX, TEX);
    };
    tile(s.surface);
    if (s.wash) {
      g.globalAlpha = 0.2;
      tile(s.wash);
      // District edges, faintly, so the held patches read as districts.
      g.globalAlpha = 0.12;
      g.strokeStyle = '#000';
      g.lineWidth = 2;
      const n = GRID.chunks, step = TEX / n;
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const x = (ox + i * step) % TEX, y = (oy + i * step) % TEX;
        g.moveTo(x, 0); g.lineTo(x, TEX); g.moveTo(0, y); g.lineTo(TEX, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    this.texture.needsUpdate = true;
  }

  private readonly _p = new THREE.Vector3();
  private readonly _cam = new THREE.Vector3();

  /** A planet point on screen (CSS px), or null on the far side. */
  private screen(x: number, z: number, w: number, h: number, lift = 1.003): { x: number; y: number } | null {
    const g = worldToGlobe(x, z, X0, Z0);
    const p = this._p.set(g.x, g.y, g.z).multiplyScalar(lift);
    // Hidden behind the sphere: facing away from the camera.
    if (p.dot(this._cam.copy(this.camera.position).sub(p)) < 0.02) return null;
    p.project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
  }

  /** Draw a frame (call every frame; does nothing while closed). */
  render(s: GlobeState): void {
    if (!this.visible || !this.renderer || !this.ready) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.paint(s);
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
    this.camera.updateMatrixWorld();
    this.drawOverlay(s, w, h, dpr);
  }

  private drawOverlay(s: GlobeState, w: number, h: number, dpr: number): void {
    const c = this.overlay;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    // The limb: a thin cyan glow just outside the sphere's outline.
    const dist = this.camera.position.length();
    const centre = this._p.set(0, 0, 0).project(this.camera);
    const cx = (centre.x * 0.5 + 0.5) * w, cy = (-centre.y * 0.5 + 0.5) * h;
    const rad = (Math.tan(Math.asin(1 / dist)) / Math.tan((this.camera.fov * Math.PI) / 360)) * (h / 2);
    const halo = g.createRadialGradient(cx, cy, rad * 0.97, cx, cy, rad * 1.1);
    halo.addColorStop(0, 'rgba(0, 212, 255, 0)');
    halo.addColorStop(0.25, 'rgba(0, 212, 255, 0.32)');
    halo.addColorStop(1, 'rgba(0, 212, 255, 0)');
    g.fillStyle = halo;
    g.beginPath(); g.arc(cx, cy, rad * 1.1, 0, Math.PI * 2); g.arc(cx, cy, rad * 0.97, 0, Math.PI * 2, true); g.fill();
    // How big things are: bigger as it zooms in.
    const zoom = 3.4 / dist;
    const k = Math.max(0.8, Math.min(2.2, zoom));
    // The heading of something on screen: from it to a point 300 m along its heading.
    const angle = (x: number, z: number, heading: number, at: { x: number; y: number }) => {
      const q = this.screen(x + Math.sin(heading) * 300, z - Math.cos(heading) * 300, w, h);
      return q ? Math.atan2(q.x - at.x, -(q.y - at.y)) : 0;
    };
    // Runways.
    g.strokeStyle = 'rgba(223, 246, 255, 0.55)';
    g.lineWidth = 1;
    for (const r of s.sites) {
      if (r.kind !== 'runway') continue;
      const a = this.screen(r.x, r.z, w, h);
      if (!a) continue;
      g.beginPath(); g.moveTo(a.x - 3 * k, a.y); g.lineTo(a.x + 3 * k, a.y); g.stroke();
    }
    // Orders: rings 3 km round their points.
    g.setLineDash([3, 3]);
    g.strokeStyle = CYAN;
    for (const o of s.orders) this.ring(g, o.x, o.z, 3000, w, h);
    g.setLineDash([]);
    // Vehicles.
    for (const ct of s.contacts) {
      if (ct.kind === 'rider') continue;
      const a = this.screen(ct.x, ct.z, w, h);
      if (!a) continue;
      if (ct.kind === 'turret') {
        const r = 2.4 * k;
        g.strokeStyle = ct.color;
        g.fillStyle = ct.color;
        g.lineWidth = 1.2;
        if (ct.foe) g.fillRect(a.x - r, a.y - r, r * 2, r * 2);
        else g.strokeRect(a.x - r, a.y - r, r * 2, r * 2);
        continue;
      }
      if (ct.kind === 'player') {
        const r = 4 * k;
        g.strokeStyle = ct.color;
        g.lineWidth = 1.4;
        g.beginPath(); g.moveTo(a.x, a.y - r); g.lineTo(a.x + r, a.y); g.lineTo(a.x, a.y + r); g.lineTo(a.x - r, a.y); g.closePath(); g.stroke();
        continue;
      }
      // Aircraft: an arrowhead on its heading; enemies solid.
      const t = angle(ct.x, ct.z, ct.heading, a), r = 4 * k;
      g.save();
      g.translate(a.x, a.y);
      g.rotate(t);
      g.beginPath(); g.moveTo(0, -r); g.lineTo(r * 0.65, r * 0.7); g.lineTo(0, r * 0.3); g.lineTo(-r * 0.65, r * 0.7); g.closePath();
      if (ct.foe) { g.fillStyle = ct.color; g.fill(); } else { g.strokeStyle = ct.color; g.lineWidth = 1.2; g.stroke(); }
      g.restore();
    }
    // Strikes: a dotted path from where they set out to the target, a bright dot where they are.
    for (const st of s.strikes) {
      g.fillStyle = 'rgba(255, 179, 71, 0.7)';
      const n = 40;
      const dx = wrapDelta(st.fromX, st.x), dz = wrapDelta(st.fromZ, st.z);
      for (let i = 0; i <= n; i++) {
        const p = this.screen(st.fromX + (dx * i) / n, st.fromZ + (dz * i) / n, w, h, 1.006);
        if (p) g.fillRect(p.x - 0.8, p.y - 0.8, 1.6, 1.6);
      }
      const tgt = this.screen(st.x, st.z, w, h);
      if (tgt) {
        g.strokeStyle = HOT;
        g.lineWidth = 1.2;
        g.beginPath(); g.arc(tgt.x, tgt.y, 5 * k, 0, Math.PI * 2); g.stroke();
      }
      if (st.at) {
        const p = this.screen(st.at.x, st.at.z, w, h, 1.01);
        if (p) {
          g.fillStyle = '#fff';
          g.shadowColor = HOT; g.shadowBlur = 8;
          g.beginPath(); g.arc(p.x, p.y, 2.6 * k, 0, Math.PI * 2); g.fill();
          g.shadowBlur = 0;
          g.fillStyle = PALE;
          g.font = '11px system-ui, sans-serif';
          g.fillText(`${st.kind === 'bomber' ? 'BOMBER' : st.kind === 'emp' ? 'EMP' : 'BARRAGE'} ${Math.max(0, Math.round(st.eta))} s`, p.x + 6, p.y - 6);
        }
      }
    }
    // The craft: a white chevron on its heading.
    const me = this.screen(s.me.x, s.me.z, w, h);
    if (me) {
      const t = angle(s.me.x, s.me.z, s.me.heading, me), r = 6 * k;
      g.save();
      g.translate(me.x, me.y);
      g.rotate(t);
      g.strokeStyle = PALE;
      g.lineWidth = 1.8;
      g.beginPath(); g.moveTo(-r * 0.7, r * 0.5); g.lineTo(0, -r); g.lineTo(r * 0.7, r * 0.5); g.stroke();
      g.restore();
    }
    // The picked spot: a reticle and the barrage's 1.5 km reach.
    if (this.picked) {
      const p = this.screen(this.picked.x, this.picked.z, w, h);
      g.strokeStyle = HOT;
      g.lineWidth = 1;
      g.setLineDash([4, 3]);
      this.ring(g, this.picked.x, this.picked.z, 1500, w, h);
      g.setLineDash([]);
      if (p) {
        const r = 9;
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(p.x - r * 1.8, p.y); g.lineTo(p.x - r * 0.6, p.y);
        g.moveTo(p.x + r * 0.6, p.y); g.lineTo(p.x + r * 1.8, p.y);
        g.moveTo(p.x, p.y - r * 1.8); g.lineTo(p.x, p.y - r * 0.6);
        g.moveTo(p.x, p.y + r * 0.6); g.lineTo(p.x, p.y + r * 1.8);
        g.stroke();
      }
    }
  }

  /** A ring of `radius` metres round a planet point, as far as it shows. */
  private ring(g: CanvasRenderingContext2D, x: number, z: number, radius: number, w: number, h: number): void {
    g.beginPath();
    let pen = false;
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const p = this.screen(x + Math.sin(a) * radius, z - Math.cos(a) * radius, w, h, 1.004);
      if (!p) { pen = false; continue; }
      if (pen) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y);
      pen = true;
    }
    g.stroke();
  }
}
