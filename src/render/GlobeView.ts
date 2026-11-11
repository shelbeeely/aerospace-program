import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GRID } from '../arch/grid.ts';
import type { CraftDef } from '../craft/types.ts';
import { knots, type AdsbRecord, type TrackPoint } from '../sim/adsb.ts';
import { globeToWorld, worldToGlobe, wrapDelta, type Contact } from '../sim/contacts.ts';
import { PLANET, type LandingSite } from '../sim/layout.ts';
import type { StrikeKind } from '../sim/strikes.ts';
import { GlobeCloseView, ModelPool, type CloseVehicle } from './GlobeCloseView.ts';

/** What the strike globe shows. */
export interface GlobeState {
  me: { x: number; z: number; heading: number };
  /** Every vehicle's ADS-B broadcast, and their last minute of track. */
  adsb: AdsbRecord[];
  tracks: ReadonlyMap<string, TrackPoint[]>;
  /** Turrets (from the radar contacts). */
  turrets: Contact[];
  sites: readonly LandingSite[];
  /** Strikes in flight: where they set out, the target, where they are now, ETA (s). */
  strikes: Array<{ kind: StrikeKind; x: number; z: number; fromX: number; fromZ: number; at: { x: number; z: number; y: number } | null; eta: number }>;
  /** Attack orders: their points. */
  orders: Array<{ x: number; z: number }>;
  /** The surface (one pixel per block) and the territory wash (one per district), or null. */
  surface: HTMLCanvasElement;
  wash: HTMLCanvasElement | null;
  /** Bumped when the wash changes (the texture is rebuilt). */
  washVersion: number;
  /** A vehicle's design and attitude (for its model), by ADS-B id; null: no model. */
  model: (id: string) => { def: CraftDef; pitch?: number; bank?: number } | null;
}

export type GlobeMode = 'basic' | 'detailed';

/**
 * The globe's frame: the planet's origin (the city) sits on the equator, facing longitude 180°,
 * so the poles (where a wrapped map pinches) fall far out in the Outlands.
 */
const C = PLANET.circumference;
const X0 = -C / 2, Z0 = -C / 2;
const CYAN = '#00d4ff', PALE = '#dff6ff', HOT = '#ffb347';
const TEX = 1480;
/** Globe camera distances (sphere radius 1): tags from here in, models from here in, and the hand-over to the close view. */
const TAGS_IN = 2.1, MODELS_IN = 2.3, CLOSE_IN = 1.3;
const MODE_KEY = 'globeMode';

/**
 * The strike globe: the whole planet as a real 3D globe in its own small three.js scene and
 * WebGL canvas, full screen over the view, rendered only while it is open.
 *
 * - The sphere carries the planet's surface map with the team territory washed over it, lit from
 *   one side, with a faint graticule and a thin glow on the limb against the dark.
 * - On it: runways, turrets in their team's colour, every vehicle from its ADS-B broadcast
 *   (aircraft as arrowheads, enemies solid; players as diamonds; the craft as a white chevron),
 *   with data tags (callsign, altitude, speed) and a minute of track as you zoom in;
 *   strikes in flight on their paths, attack orders as rings.
 * - Two modes: **basic** (markers) and **detailed** (the real aircraft models, at a readable
 *   size), chosen by the device and switchable (remembered).
 * - Zoom right in and it hands over, seamlessly, to the close view: the spot in 3D with its
 *   buildings and vehicles (GlobeCloseView); zoom out and it hands back.
 * - A click picks a spot (`onPick`), or a vehicle near the pointer (`onSelect`).
 */
export class GlobeView {
  readonly root: HTMLElement;
  /** Where the strike panel goes (beside the globe). */
  readonly side: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly hint: HTMLElement;
  private renderer: THREE.WebGPURenderer | null = null;
  private ready = false;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.01, 50);
  private controls: OrbitControls | null = null;
  private readonly sphere: THREE.Mesh;
  private readonly texCanvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private texKey = '';
  readonly close = new GlobeCloseView();
  private readonly pool = new ModelPool();
  /** The picked spot (planet x, z), or null. */
  picked: { x: number; z: number } | null = null;
  /** The selected vehicle (ADS-B id), or null; `follow`: the view keeps it in the middle. */
  selected: string | null = null;
  follow = false;
  onPick: ((x: number, z: number) => void) | null = null;
  onSelect: ((id: string | null) => void) | null = null;
  onClose: (() => void) | null = null;
  /** Fired when the mode changes (the panel's switch). */
  onMode: ((m: GlobeMode) => void) | null = null;
  private modeValue: GlobeMode;
  /** Vehicles on screen at the last frame (for clicks). */
  private hits: Array<{ id: string; x: number; y: number }> = [];
  private lastFrame = performance.now();

  /** `detailedByDefault`: what the device suggests (a remembered choice overrides it). */
  constructor(detailedByDefault: boolean) {
    let stored: string | null = null;
    try { stored = localStorage.getItem(MODE_KEY); } catch { /* not remembered */ }
    this.modeValue = stored === 'basic' || stored === 'detailed' ? stored : detailedByDefault ? 'detailed' : 'basic';
    this.close.detailed = this.modeValue === 'detailed';
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
    this.hint = el('div', '', 'globe-hint');
    stage.append(this.canvas, this.overlay, this.hint);
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

    // A click (not a drag): a vehicle near the pointer is selected, else the spot is picked.
    let down: { x: number; y: number } | null = null;
    this.overlay.style.pointerEvents = 'none';
    this.canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down = null; return; }
      down = null;
      const r = this.canvas.getBoundingClientRect();
      this.click(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    });
    window.addEventListener('keydown', (e) => {
      if (this.visible && e.code === 'Escape') { e.preventDefault(); this.toggle(false); }
    });
    this.label();
  }

  get mode(): GlobeMode {
    return this.modeValue;
  }

  setMode(m: GlobeMode): void {
    if (m === this.modeValue) return;
    this.modeValue = m;
    try { localStorage.setItem(MODE_KEY, m); } catch { /* not remembered */ }
    this.close.detailed = m === 'detailed';
    this.close.clear();
    this.onMode?.(m);
  }

  /** In the close view (zoomed into a spot), else on the globe. */
  get closeUp(): boolean {
    return this.close.active;
  }

  private label(): void {
    this.hint.textContent = this.close.active
      ? 'Drag to pan · right-drag to turn and tilt · wheel to zoom (out far to return to the globe) · click to target · click a vehicle for its ADS-B'
      : 'Drag to turn · wheel to zoom (in close for buildings) · click a spot to target it · click a vehicle for its ADS-B · Shift+Tab closes';
  }

  /** Select a vehicle (or none). */
  select(id: string | null): void {
    this.selected = id;
    if (!id) this.follow = false;
    this.onSelect?.(id);
  }

  private click(px: number, py: number, w: number, h: number): void {
    let best: { id: string; d: number } | null = null;
    for (const v of this.hits) {
      const d = Math.hypot(v.x - px, v.y - py);
      if (d < 12 && (!best || d < best.d)) best = { id: v.id, d };
    }
    if (best) { this.select(best.id); return; }
    const ndc = new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1);
    let spot: { x: number; z: number } | null = null;
    if (this.close.active) spot = this.close.pick(ndc);
    else {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObject(this.sphere)[0];
      if (hit) spot = globeToWorld(hit.point.x, hit.point.y, hit.point.z, X0, Z0);
    }
    if (!spot) return;
    this.picked = spot;
    this.onPick?.(spot.x, spot.z);
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** Open (turned to face `centre`, the craft) or close. */
  toggle(on = !this.visible, centre?: { x: number; z: number }): void {
    this.root.classList.toggle('hidden', !on);
    if (!on) {
      // Closed: models and close-view districts go (they come back when it opens).
      if (this.close.active) this.leaveClose();
      this.close.clear();
      this.pool.begin();
      this.pool.sweep();
      this.onClose?.();
      return;
    }
    this.ensureRenderer();
    if (centre) this.face(centre.x, centre.z, this.camera.position.length());
  }

  /** Turn the globe to face a planet point from a distance. */
  private face(x: number, z: number, dist: number): void {
    const p = worldToGlobe(x, z, X0, Z0);
    this.camera.position.set(p.x, p.y, p.z).multiplyScalar(dist);
    this.camera.lookAt(0, 0, 0);
    this.controls?.update();
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
    c.minDistance = CLOSE_IN - 0.08;
    c.maxDistance = 6;
    c.zoomSpeed = 0.8;
    this.controls = c;
    this.close.attach(this.canvas);
  }

  /** Hand over to the close view at the spot in the middle of the screen. */
  private enterClose(): void {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hit = ray.intersectObject(this.sphere)[0];
    if (!hit) return;
    const w = globeToWorld(hit.point.x, hit.point.y, hit.point.z, X0, Z0);
    // Look the way the globe was turned: north up on screen is the view's heading.
    const north = this.screenDir(w.x, w.z);
    if (this.controls) this.controls.enabled = false;
    this.close.enter(w.x, w.z, north);
    this.label();
  }

  /** Which way the globe's camera looks across a point (rad from north), for the hand-over. */
  private screenDir(x: number, z: number): number {
    const a = this.project(x, z, 0, 1000, 1000), n = this.project(x, z - 500, 0, 1000, 1000);
    if (!a || !n) return 0;
    // Screen-up is the view's heading: north is at that angle from it.
    return -Math.atan2(n.x - a.x, -(n.y - a.y));
  }

  /** Back to the globe, facing where the close view looked. */
  private leaveClose(): void {
    const f = this.close.focus();
    this.close.leave();
    if (this.controls) this.controls.enabled = true;
    this.face(f.x, f.z, CLOSE_IN + 0.25);
    this.label();
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

  /** A point on the globe's surface (lifted) for a planet point. */
  private onSphere(x: number, z: number, lift: number, out: THREE.Vector3): THREE.Vector3 {
    const g = worldToGlobe(x, z, X0, Z0);
    return out.set(g.x, g.y, g.z).multiplyScalar(lift);
  }

  /** A planet point (at a height) on screen (CSS px), or null where it can't be seen. */
  private project(x: number, z: number, y: number, w: number, h: number): { x: number; y: number } | null {
    if (this.close.active) return this.close.project(x, z, y, w, h);
    const p = this.onSphere(x, z, 1.003, this._p);
    // Hidden behind the sphere: facing away from the camera.
    if (p.dot(this._cam.copy(this.camera.position).sub(p)) < 0.02) return null;
    p.project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
  }

  /** Draw a frame (call every frame; does nothing while closed). */
  render(s: GlobeState): void {
    if (!this.visible || !this.renderer || !this.ready) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      for (const cam of [this.camera, this.close.camera]) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
    }
    const sel = this.selected ? s.adsb.find((r) => r.id === this.selected) : undefined;
    if (this.selected && !sel) this.select(null);
    this.pool.begin();
    this.close.viewH = h;
    if (this.close.active) {
      if (this.follow && sel) this.close.follow(sel.x, sel.z);
      this.close.update(dt, { surface: s.surface, wash: s.wash, washVersion: s.washVersion, vehicles: this.vehicles(s), pool: this.pool });
      if (this.close.wantsExit()) this.leaveClose();
    }
    if (!this.close.active) {
      if (this.follow && sel) this.face(sel.x, sel.z, this.camera.position.length());
      this.controls?.update();
      if (this.camera.position.length() < CLOSE_IN) this.enterClose();
    }
    if (this.close.active) {
      this.renderer.render(this.close.scene, this.close.camera);
      this.close.camera.updateMatrixWorld();
    } else {
      this.paint(s);
      if (this.modeValue === 'detailed') this.placeModels(s, w, h);
      this.renderer.render(this.scene, this.camera);
      this.camera.updateMatrixWorld();
    }
    this.pool.sweep();
    this.drawOverlay(s, w, h, dpr);
  }

  /** The vehicles for the close view: aircraft and players with their models, riders as bars. */
  private vehicles(s: GlobeState): CloseVehicle[] {
    const out: CloseVehicle[] = [];
    for (const r of s.adsb) {
      const m = r.category === 'ground' ? null : s.model(r.id);
      out.push({ id: r.id, x: r.x, z: r.z, y: r.alt, heading: r.track, speed: r.gs, color: r.color, def: m?.def ?? null, pitch: m?.pitch, bank: m?.bank, rider: r.category === 'ground' });
    }
    return out;
  }

  private readonly _up = new THREE.Vector3();
  private readonly _fw = new THREE.Vector3();
  private readonly _rt = new THREE.Vector3();
  private readonly _m4 = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();

  /** Detailed globe: the nearest vehicles in view as their models, sized to read at this zoom. */
  private placeModels(s: GlobeState, w: number, h: number): void {
    const dist = this.camera.position.length();
    if (dist > MODELS_IN) return;
    const cands: Array<{ r: AdsbRecord; d: number }> = [];
    for (const r of s.adsb) {
      if (r.category === 'ground') continue;
      const p = this.project(r.x, r.z, r.alt, w, h);
      if (!p) continue;
      cands.push({ r, d: Math.hypot(p.x - w / 2, p.y - h / 2) - (r.id === this.selected ? 1e6 : 0) });
    }
    cands.sort((a, b) => a.d - b.d);
    for (const { r } of cands.slice(0, 30)) {
      const m = s.model(r.id);
      if (!m) continue;
      const v = this.pool.get(r.id, m.def, r.color);
      if (v.view.root.parent !== this.scene) this.scene.add(v.view.root);
      const lift = 1.004 + Math.min(3000, Math.max(0, r.agl)) / 8000 * 0.25;
      const p = this.onSphere(r.x, r.z, lift, this._p.clone());
      const ahead = this.onSphere(r.x + Math.sin(r.track) * 50, r.z - Math.cos(r.track) * 50, lift, this._fw);
      const up = this._up.copy(p).normalize();
      const fwd = ahead.sub(p).normalize();
      const right = this._rt.crossVectors(fwd, up).normalize();
      fwd.crossVectors(up, right).normalize();
      // A model faces -Z with +Y up: its axes are right, up and -forward.
      this._m4.makeBasis(right, up, fwd.clone().negate());
      this._q.setFromRotationMatrix(this._m4);
      // About 26 px long on screen whatever the zoom.
      const range = this.camera.position.distanceTo(p);
      const units = (2 * Math.tan((this.camera.fov * Math.PI) / 360) * range / h) * 26;
      v.view.update(p, this._q, r.gs, 0.6, 0);
      v.view.root.scale.setScalar(units / v.length);
    }
  }

  private drawOverlay(s: GlobeState, w: number, h: number, dpr: number): void {
    const c = this.overlay;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const close = this.close.active;
    const dist = this.camera.position.length();
    if (!close) {
      // The limb: a thin cyan glow just outside the sphere's outline.
      const centre = this._p.set(0, 0, 0).project(this.camera);
      const cx = (centre.x * 0.5 + 0.5) * w, cy = (-centre.y * 0.5 + 0.5) * h;
      const rad = (Math.tan(Math.asin(1 / dist)) / Math.tan((this.camera.fov * Math.PI) / 360)) * (h / 2);
      const halo = g.createRadialGradient(cx, cy, rad * 0.97, cx, cy, rad * 1.1);
      halo.addColorStop(0, 'rgba(0, 212, 255, 0)');
      halo.addColorStop(0.25, 'rgba(0, 212, 255, 0.32)');
      halo.addColorStop(1, 'rgba(0, 212, 255, 0)');
      g.fillStyle = halo;
      g.beginPath(); g.arc(cx, cy, rad * 1.1, 0, Math.PI * 2); g.arc(cx, cy, rad * 0.97, 0, Math.PI * 2, true); g.fill();
    }
    // How big things are: bigger as it zooms in.
    const k = close ? 1.5 : Math.max(0.8, Math.min(2.2, 3.4 / dist));
    const P = (x: number, z: number, y = 0) => this.project(x, z, y, w, h);
    // The heading of something on screen: from it to a point 300 m along its heading.
    const angle = (x: number, z: number, y: number, heading: number, at: { x: number; y: number }) => {
      const q = P(x + Math.sin(heading) * 300, z - Math.cos(heading) * 300, y);
      return q ? Math.atan2(q.x - at.x, -(q.y - at.y)) : 0;
    };
    // Runways.
    g.strokeStyle = 'rgba(223, 246, 255, 0.55)';
    g.lineWidth = 1;
    if (!close) for (const r of s.sites) {
      if (r.kind !== 'runway') continue;
      const a = P(r.x, r.z);
      if (!a) continue;
      g.beginPath(); g.moveTo(a.x - 3 * k, a.y); g.lineTo(a.x + 3 * k, a.y); g.stroke();
    }
    // Orders: rings 3 km round their points.
    g.setLineDash([3, 3]);
    g.strokeStyle = CYAN;
    for (const o of s.orders) this.ring(g, o.x, o.z, 3000, w, h);
    g.setLineDash([]);
    // Turrets: small squares (enemies solid). In the close view they stand on their roofs.
    for (const t of s.turrets) {
      const a = P(t.x, t.z, t.y);
      if (!a) continue;
      const r = 2.4 * k;
      g.strokeStyle = t.color;
      g.fillStyle = t.color;
      g.lineWidth = 1.2;
      if (t.foe) g.fillRect(a.x - r, a.y - r, r * 2, r * 2);
      else g.strokeRect(a.x - r, a.y - r, r * 2, r * 2);
    }
    // Vehicles from their ADS-B: tracks, markers, tags.
    const tagsOn = close || dist < TAGS_IN;
    const modelled = !close && this.modeValue === 'detailed' && dist < MODELS_IN;
    const ridersOn = close || dist < 1.6;
    this.hits = [];
    const shown: Array<{ r: AdsbRecord; at: { x: number; y: number } }> = [];
    for (const r of s.adsb) {
      if (r.category === 'ground' && !ridersOn) continue;
      const at = P(r.x, r.z, r.alt);
      if (!at) continue;
      if (at.x < -40 || at.y < -40 || at.x > w + 40 || at.y > h + 40) continue;
      shown.push({ r, at });
    }
    // A minute of track: a fading dotted line (aircraft and players; riders only when selected).
    if (tagsOn) for (const { r } of shown) {
      if (r.category === 'ground' && r.id !== this.selected) continue;
      const t = s.tracks.get(r.id);
      if (!t || t.length < 2) continue;
      g.fillStyle = r.color;
      for (let i = 0; i < t.length; i++) {
        const p = P(t[0].x + wrapDelta(t[0].x, t[i].x), t[0].z + wrapDelta(t[0].z, t[i].z), t[i].y);
        if (!p) continue;
        g.globalAlpha = 0.15 + 0.6 * (i / t.length);
        g.fillRect(p.x - 1, p.y - 1, 2, 2);
      }
      g.globalAlpha = 1;
    }
    for (const { r, at } of shown) {
      this.hits.push({ id: r.id, x: at.x, y: at.y });
      if (r.category === 'ground') {
        g.fillStyle = r.color;
        g.fillRect(at.x - 1.5, at.y - 1.5, 3, 3);
        continue;
      }
      const t = angle(r.x, r.z, r.alt, r.track, at), rad = (r.category === 'self' ? 6 : 4) * k;
      if (r.category === 'self') {
        g.save(); g.translate(at.x, at.y); g.rotate(t);
        g.strokeStyle = PALE; g.lineWidth = 1.8;
        g.beginPath(); g.moveTo(-rad * 0.7, rad * 0.5); g.lineTo(0, -rad); g.lineTo(rad * 0.7, rad * 0.5); g.stroke();
        g.restore();
        continue;
      }
      if (r.category === 'player') {
        g.strokeStyle = r.color; g.lineWidth = 1.4;
        g.beginPath(); g.moveTo(at.x, at.y - rad); g.lineTo(at.x + rad, at.y); g.lineTo(at.x, at.y + rad); g.lineTo(at.x - rad, at.y); g.closePath(); g.stroke();
        continue;
      }
      // Aircraft: an arrowhead on its track (enemies solid) — unless its model is drawn.
      const hasModel = (modelled || (close && this.modeValue === 'detailed')) && !!s.model(r.id);
      if (hasModel) continue;
      g.save(); g.translate(at.x, at.y); g.rotate(t);
      g.beginPath(); g.moveTo(0, -rad); g.lineTo(rad * 0.65, rad * 0.7); g.lineTo(0, rad * 0.3); g.lineTo(-rad * 0.65, rad * 0.7); g.closePath();
      if (r.foe) { g.fillStyle = r.color; g.fill(); } else { g.strokeStyle = r.color; g.lineWidth = 1.2; g.stroke(); }
      g.restore();
    }
    // Tags: callsign, altitude, speed; nearest the middle first, none overlapping, about 40.
    if (tagsOn) {
      const order = shown.filter(({ r }) => r.category !== 'ground' || r.id === this.selected)
        .map((v) => ({ ...v, d: v.r.id === this.selected ? -1 : Math.hypot(v.at.x - w / 2, v.at.y - h / 2) - (v.r.foe ? 80 : 0) }))
        .sort((a, b) => a.d - b.d);
      const taken: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
      g.font = '10px ui-monospace, Menlo, monospace';
      let n = 0;
      for (const { r, at } of order) {
        if (n >= 40) break;
        const line1 = r.callsign;
        const climb = r.vs > 2 ? '▲' : r.vs < -2 ? '▼' : '';
        const line2 = r.category === 'ground' ? `${knots(r.gs)} kt` : `${Math.round(r.alt).toLocaleString()} m ${climb} ${knots(r.gs)} kt`;
        const tw = Math.max(g.measureText(line1).width, g.measureText(line2).width) + 6;
        const box = { x0: at.x + 8, y0: at.y - 22, x1: at.x + 8 + tw, y1: at.y + 2 };
        if (r.id !== this.selected && taken.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
        taken.push(box);
        n++;
        // A thin leader, then the two lines (selected: brighter, with a box).
        g.strokeStyle = r.color;
        g.globalAlpha = r.id === this.selected ? 1 : 0.6;
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(at.x + 3, at.y - 3); g.lineTo(box.x0, box.y0 + 12); g.stroke();
        if (r.id === this.selected) { g.fillStyle = 'rgba(4, 10, 22, 0.8)'; g.fillRect(box.x0 - 2, box.y0 - 1, tw + 2, 26); g.strokeRect(box.x0 - 2, box.y0 - 1, tw + 2, 26); }
        g.fillStyle = r.color;
        g.fillText(line1, box.x0 + 1, box.y0 + 9);
        g.fillStyle = PALE;
        g.globalAlpha = r.id === this.selected ? 1 : 0.75;
        g.fillText(line2, box.x0 + 1, box.y0 + 21);
        g.globalAlpha = 1;
      }
    }
    // The selected vehicle: a ring round it.
    const sel = this.selected ? shown.find((v) => v.r.id === this.selected) : undefined;
    if (sel) {
      g.strokeStyle = '#fff';
      g.lineWidth = 1.2;
      g.beginPath(); g.arc(sel.at.x, sel.at.y, 9 * Math.min(k, 1.6), 0, Math.PI * 2); g.stroke();
    }
    // Strikes: a dotted path from where they set out to the target, a bright dot where they are.
    for (const st of s.strikes) {
      g.fillStyle = 'rgba(255, 179, 71, 0.7)';
      const n = 40;
      const dx = wrapDelta(st.fromX, st.x), dz = wrapDelta(st.fromZ, st.z);
      for (let i = 0; i <= n; i++) {
        const p = P(st.fromX + (dx * i) / n, st.fromZ + (dz * i) / n, close ? 1500 : 0);
        if (p) g.fillRect(p.x - 0.8, p.y - 0.8, 1.6, 1.6);
      }
      const tgt = P(st.x, st.z);
      if (tgt) {
        g.strokeStyle = HOT;
        g.lineWidth = 1.2;
        g.beginPath(); g.arc(tgt.x, tgt.y, 5 * k, 0, Math.PI * 2); g.stroke();
      }
      if (st.at) {
        const p = P(st.at.x, st.at.z, st.at.y);
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
    // The picked spot: a reticle and the barrage's 1.5 km reach.
    if (this.picked) {
      const p = P(this.picked.x, this.picked.z);
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
      const p = this.project(x + Math.sin(a) * radius, z - Math.cos(a) * radius, 0, w, h);
      if (!p) { pen = false; continue; }
      if (pen) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y);
      pen = true;
    }
    g.stroke();
  }

  /** Stats (tests): models alive, close-view districts loaded. */
  stats(): { models: number; districts: number; close: boolean } {
    return { models: this.pool.size, districts: this.close.loaded, close: this.close.active };
  }
}
