import * as THREE from 'three/webgpu';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { districtPlan } from '../arch/DistrictGenerator.ts';
import { chunkHasTerrain, landformsInRect } from '../arch/DigitalTerrainGenerator.ts';
import { GRID } from '../arch/grid.ts';
import type { CraftDef } from '../craft/types.ts';
import { toLocal } from '../sim/contacts.ts';
import { PLANET } from '../sim/layout.ts';
import { craftBounds } from '../sim/weapons.ts';
import { chunkAt, planetChunk } from '../world/planetCity.ts';
import { archMaterialsFlat } from './arch/ArchitecturalMaterialLibrary.ts';
import { emitComponent, GeometryWriter, type Lod } from './arch/ArchitectureMeshBuilder.ts';
import { buildDistrict, finish } from './arch/DigitalWorldView.ts';
import { emitSlab, landformComponents } from './arch/TerrainView.ts';
import { RemoteCraftView } from './RemoteCraftView.ts';

const C = PLANET.circumference;
const ONE = new THREE.Vector3(1, 1, 1);
/** Districts drawn within this of the view's centre (m). */
const REACH = 3200;
/** The ground map's side (m) and resolution (px). */
const GROUND = 16000, GROUND_PX = 1024;
/** Zoomed out this far (m from the camera to its target), the view hands back to the globe. */
export const CLOSE_EXIT = 9000;

/**
 * A pool of aircraft models (RemoteCraftView) by vehicle id, shared by the globe and the close
 * view: a model is built once and moved between the two scenes; ones not used in a frame go.
 */
export class ModelPool {
  private readonly models = new Map<string, { view: RemoteCraftView; def: CraftDef; length: number; used: boolean }>();

  get(id: string, def: CraftDef, color: string): { view: RemoteCraftView; length: number } {
    let m = this.models.get(id);
    if (m && m.def !== def) { m.view.dispose(); m.view.root.removeFromParent(); m = undefined; }
    if (!m) {
      const b = craftBounds(def);
      const view = new RemoteCraftView(def, color, { beacon: false });
      m = { view, def, length: Math.max(4, b.max.z - b.min.z, b.max.x - b.min.x), used: true };
      this.models.set(id, m);
    }
    m.used = true;
    return m;
  }

  /** Start a frame: every model is unused until asked for. */
  begin(): void {
    for (const m of this.models.values()) m.used = false;
  }

  /** End a frame: the unused ones go. */
  sweep(): void {
    for (const [id, m] of this.models) if (!m.used) { m.view.root.removeFromParent(); m.view.dispose(); this.models.delete(id); }
  }

  get size(): number {
    return this.models.size;
  }
}

interface District {
  key: string;
  group: THREE.Group;
  /** Its origin on the planet (the group's local origin). */
  x: number;
  z: number;
  used: number;
}

/** One vehicle in the close view. */
export interface CloseVehicle {
  id: string;
  x: number;
  z: number;
  /** Altitude (m). */
  y: number;
  heading: number;
  pitch?: number;
  bank?: number;
  speed: number;
  color: string;
  def: CraftDef | null;
  rider?: boolean;
}

/**
 * The strike globe's close view, Google Earth style: the spot zoomed in on as a 3D scene in
 * metres round a centre (local = the shortest way round the planet, so it is seamless across
 * the wrap). A ground map from the planet's surface and territory, the district buildings
 * around the centre (full architecture in the detailed mode, their boxes in the basic), the
 * Outlands landforms, and the vehicles (real models in the detailed mode). The camera is a map
 * camera: pan, turn, tilt, zoom; zoomed far enough out it hands back to the globe.
 */
export class GlobeCloseView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 2, 60000);
  controls: MapControls | null = null;
  /** The planet point at the local origin. */
  readonly centre = { x: 0, z: 0 };
  active = false;
  detailed = true;
  private readonly districts = new Map<string, District>();
  private readonly world = new THREE.Group();
  private readonly ground: THREE.Mesh;
  private readonly groundCanvas = document.createElement('canvas');
  private readonly groundTex: THREE.CanvasTexture;
  private groundAt: { x: number; z: number; key: string } | null = null;
  private readonly riders: THREE.InstancedMesh;
  private readonly boxMat = new THREE.MeshLambertMaterial({ color: 0x24507f, emissive: 0x0a1f3c });
  private readonly kitMat = new THREE.MeshLambertMaterial({ color: 0x16304f, emissive: 0x081a33 });
  private readonly unitBox = new THREE.BoxGeometry(1, 1, 1);
  private readonly unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);

  constructor() {
    this.scene.background = new THREE.Color(0x050c1a);
    this.scene.fog = new THREE.Fog(0x071428, 5000, 16000);
    this.scene.add(new THREE.AmbientLight(0xbfd8ff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(-3000, 6000, 2000);
    this.scene.add(sun);
    this.groundCanvas.width = this.groundCanvas.height = GROUND_PX;
    this.groundTex = new THREE.CanvasTexture(this.groundCanvas);
    this.groundTex.colorSpace = THREE.SRGBColorSpace;
    this.groundTex.anisotropy = 8;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND, GROUND), new THREE.MeshBasicMaterial({ map: this.groundTex }));
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground, this.world);
    const cycle = new THREE.BoxGeometry(1.4, 1.6, 4.2);
    this.riders = new THREE.InstancedMesh(cycle, new THREE.MeshBasicMaterial({ color: 0xffffff }), 600);
    this.riders.count = 0;
    this.riders.frustumCulled = false;
    this.scene.add(this.riders);
    this.camera.position.set(0, 5200, 3600);
  }

  /** Controls on the shared canvas (made once; only enabled while the close view is). */
  attach(canvas: HTMLCanvasElement): void {
    if (this.controls) return;
    const c = new MapControls(this.camera, canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.12;
    c.screenSpacePanning = false;
    c.minDistance = 120;
    c.maxDistance = CLOSE_EXIT + 600;
    c.maxPolarAngle = 1.42;
    c.zoomSpeed = 1.1;
    c.enabled = false;
    this.controls = c;
  }

  /** Zoom in on a planet point: the camera 6 km out on its heading of view, tilted 50°. */
  enter(x: number, z: number, heading = 0): void {
    this.centre.x = x;
    this.centre.z = z;
    this.active = true;
    const d = 6500, tilt = (50 * Math.PI) / 180;
    this.camera.position.set(-Math.sin(heading) * Math.sin(tilt) * d, Math.cos(tilt) * d, Math.cos(heading) * Math.sin(tilt) * d);
    if (this.controls) {
      this.controls.target.set(0, 0, 0);
      this.controls.enabled = true;
      this.controls.update();
    }
  }

  leave(): void {
    this.active = false;
    if (this.controls) this.controls.enabled = false;
  }

  /** Where the camera looks, on the planet. */
  focus(): { x: number; z: number } {
    const t = this.controls?.target ?? new THREE.Vector3();
    return { x: this.centre.x + t.x, z: this.centre.z + t.z };
  }

  /** The camera's heading of view (rad, 0 = north). */
  viewHeading(): number {
    const t = this.controls?.target ?? new THREE.Vector3();
    return Math.atan2(t.x - this.camera.position.x, -(t.z - this.camera.position.z));
  }

  /** Zoomed out past the hand-back distance. */
  wantsExit(): boolean {
    const t = this.controls?.target;
    return !!t && this.camera.position.distanceTo(t) > CLOSE_EXIT;
  }

  /** Keep the camera's target near the local origin: past 1.5 km, move the centre under it. */
  private recentre(): void {
    const c = this.controls;
    if (!c) return;
    const t = c.target;
    if (Math.hypot(t.x, t.z) < 1500) return;
    this.centre.x += t.x;
    this.centre.z += t.z;
    this.camera.position.x -= t.x;
    this.camera.position.z -= t.z;
    t.set(0, t.y, 0);
    c.update();
  }

  /** Follow a planet point (a vehicle): the view slides to keep it in the middle. */
  follow(x: number, z: number): void {
    const c = this.controls;
    if (!c) return;
    const l = toLocal(x, z, this.centre.x, this.centre.z);
    const dx = l.x - c.target.x, dz = l.z - c.target.z;
    c.target.x += dx;
    c.target.z += dz;
    this.camera.position.x += dx;
    this.camera.position.z += dz;
  }

  /** The ground map round the centre: surface blocks, territory, district and street lines. */
  private paintGround(surface: HTMLCanvasElement, wash: HTMLCanvasElement | null, washVersion: number): void {
    const near = this.groundAt && Math.hypot(this.groundAt.x - this.centre.x, this.groundAt.z - this.centre.z) < 3000;
    const key = `${washVersion}`;
    if (near && this.groundAt!.key === key) return;
    const gx = near ? this.groundAt!.x : this.centre.x, gz = near ? this.groundAt!.z : this.centre.z;
    this.groundAt = { x: gx, z: gz, key };
    const g = this.groundCanvas.getContext('2d')!;
    const k = GROUND_PX / GROUND; // px per metre
    const full = C * k;
    const ox = (GRID.x0 - (gx - GROUND / 2)) * k, oz = (GRID.z0 - (gz - GROUND / 2)) * k;
    const start = (o: number) => o - Math.ceil(o / full) * full;
    const tile = (img: HTMLCanvasElement, alpha: number) => {
      g.globalAlpha = alpha;
      for (let x = start(ox); x < GROUND_PX; x += full) for (let y = start(oz); y < GROUND_PX; y += full) g.drawImage(img, x, y, full, full);
    };
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#030a18';
    g.fillRect(0, 0, GROUND_PX, GROUND_PX);
    tile(surface, 1);
    // Large unlit surfaces (1982): the map dimmed well down; territory only a faint tint.
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(2, 6, 16, 0.55)';
    g.fillRect(0, 0, GROUND_PX, GROUND_PX);
    if (wash) tile(wash, 0.07);
    g.globalAlpha = 1;
    // Street lines every block, faint; district edges a little stronger.
    const line = (step: number, style: string, width: number) => {
      g.strokeStyle = style;
      g.lineWidth = width;
      g.beginPath();
      for (let x = start(ox) % (step * k) - step * k; x < GROUND_PX; x += step * k) { g.moveTo(x, 0); g.lineTo(x, GROUND_PX); }
      for (let y = start(oz) % (step * k) - step * k; y < GROUND_PX; y += step * k) { g.moveTo(0, y); g.lineTo(GROUND_PX, y); }
      g.stroke();
    };
    line(GRID.pitch, 'rgba(0, 212, 255, 0.07)', 1);
    line(GRID.chunkSize, 'rgba(0, 212, 255, 0.22)', 1.5);
    this.groundTex.needsUpdate = true;
  }

  /** Build the buildings of one district (and its Outlands landforms). */
  private build(ci: number, cj: number, lod: Lod): THREE.Group {
    const cs = GRID.chunkSize;
    const group = new THREE.Group();
    const pc = planetChunk(ci, cj);
    const kitGroups = new Set(pc.structures.groups.filter((g) => g.kit).map((g) => g.id));
    const plan = districtPlan(ci, cj);
    if (this.detailed) {
      const d = buildDistrict(plan, lod, () => 0, archMaterialsFlat());
      d.group.position.set(plan.x - pc.x, 0, plan.z - pc.z);
      group.add(d.group);
    }
    // Boxes: the kit towers (both modes), and in the basic mode every procedural building as
    // its collider pieces (planet coordinates).
    const boxes: Array<{ shape: string; x: number; y: number; z: number; sx: number; sy: number; sz: number }> = pc.structures.list.filter((p) => kitGroups.has(p.group));
    if (!this.detailed) for (const st of plan.structures) boxes.push(...st.colliders);
    if (boxes.length) {
      const round = boxes.filter((p) => p.shape !== 'box');
      const square = boxes.filter((p) => p.shape === 'box');
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3();
      for (const [list, geo] of [[square, this.unitBox], [round, this.unitCyl]] as const) {
        if (!list.length) continue;
        const mesh = new THREE.InstancedMesh(geo, this.detailed ? this.kitMat : this.boxMat, list.length);
        list.forEach((p, i) => mesh.setMatrixAt(i, m.compose(v.set(p.x - pc.x, p.y, p.z - pc.z), q, s.set(p.sx, p.sy, p.sz))));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        group.add(mesh);
      }
    }
    if (this.detailed && chunkHasTerrain(ci, cj)) {
      const x0 = GRID.x0 + ci * cs, z0 = GRID.z0 + cj * cs;
      const w = new GeometryWriter(), l = new GeometryWriter();
      w.sid = 0; w.hgtBase = 0; w.hgtScale = 1 / 280;
      for (const f of landformsInRect(x0, z0, x0 + cs, z0 + cs, lod === 0)) {
        if (lod === 2 && f.tier === 3) continue;
        if (f.shape === 'slab') { emitSlab(w, f, x0, z0); continue; }
        for (const c of landformComponents(f, x0, z0)) emitComponent(w, c, { ox: 0, oz: 0, rot: 0 }, lod);
      }
      const t = finish(w, l, archMaterialsFlat());
      t.group.position.set(x0 - pc.x, 0, z0 - pc.z);
      group.add(t.group);
    }
    group.userData.origin = { x: pc.x, z: pc.z };
    return group;
  }

  /** Stream the districts round the camera's target: at most one new one a frame (two in basic). */
  private stream(frame: number): void {
    const f = this.focus();
    const cs = GRID.chunkSize, n = GRID.chunks;
    const [fi, fj] = chunkAt(f.x, f.z);
    const r = Math.ceil(REACH / cs);
    const want: Array<{ key: string; ci: number; cj: number; d: number; lod: Lod }> = [];
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      const ci = (((fi + di) % n) + n) % n, cj = (((fj + dj) % n) + n) % n;
      const cx = GRID.x0 + (ci + 0.5) * cs, cz = GRID.z0 + (cj + 0.5) * cs;
      const l = toLocal(cx, cz, f.x, f.z);
      const d = Math.max(0, Math.hypot(l.x, l.z) - cs * 0.7);
      if (d > REACH) continue;
      const lod: Lod = d < 1400 ? 1 : 2;
      want.push({ key: `${ci},${cj},${lod},${this.detailed ? 'd' : 'b'}`, ci, cj, d, lod });
    }
    want.sort((a, b) => a.d - b.d);
    let built = 0;
    const keep = new Set<string>();
    for (const w of want) {
      keep.add(w.key);
      const have = this.districts.get(w.key);
      if (have) { have.used = frame; continue; }
      if (built >= (this.detailed ? 1 : 2)) {
        // Keep showing another LOD of it until this one is built.
        for (const [k, d] of this.districts) if (k.startsWith(`${w.ci},${w.cj},`)) { d.used = frame; keep.add(k); }
        continue;
      }
      const group = this.build(w.ci, w.cj, w.lod);
      const o = group.userData.origin as { x: number; z: number };
      this.world.add(group);
      this.districts.set(w.key, { key: w.key, group, x: o.x, z: o.z, used: frame });
      built++;
      // The other LODs of it go now.
      for (const [k, d] of this.districts) if (k !== w.key && k.startsWith(`${w.ci},${w.cj},`)) { this.drop(d); keep.delete(k); }
    }
    for (const d of [...this.districts.values()]) if (!keep.has(d.key)) this.drop(d);
  }

  private drop(d: District): void {
    d.group.removeFromParent();
    d.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry !== this.unitBox && m.geometry !== this.unitCyl) m.geometry.dispose();
    });
    this.districts.delete(d.key);
  }

  /** Throw everything away (closing the globe, or switching modes). */
  clear(): void {
    for (const d of [...this.districts.values()]) this.drop(d);
    this.groundAt = null;
  }

  private frame = 0;
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();
  private readonly _m = new THREE.Matrix4();
  private readonly _v = new THREE.Vector3();
  private readonly _c = new THREE.Color();

  /** The view's height in CSS px (for keeping models readable). */
  viewH = 720;

  /** A frame: recentre, stream, place everything. */
  update(dt: number, o: { surface: HTMLCanvasElement; wash: HTMLCanvasElement | null; washVersion: number; vehicles: CloseVehicle[]; pool: ModelPool }): void {
    this.frame++;
    this.controls?.update();
    this.recentre();
    this.paintGround(o.surface, o.wash, o.washVersion);
    const g = toLocal(this.groundAt!.x, this.groundAt!.z, this.centre.x, this.centre.z);
    this.ground.position.set(g.x, 0, g.z);
    this.stream(this.frame);
    for (const d of this.districts.values()) {
      const l = toLocal(d.x, d.z, this.centre.x, this.centre.z);
      d.group.position.set(l.x, 0, l.z);
    }
    // Vehicles: models (detailed) within 7 km; riders as small bars in their colour.
    let nr = 0;
    for (const v of o.vehicles) {
      const l = toLocal(v.x, v.z, this.centre.x, this.centre.z);
      if (Math.hypot(l.x - (this.controls?.target.x ?? 0), l.z - (this.controls?.target.z ?? 0)) > 7000) continue;
      if (v.rider) {
        if (nr >= this.riders.instanceMatrix.count) continue;
        this._q.setFromEuler(this._e.set(0, -v.heading, 0, 'YXZ'));
        this.riders.setMatrixAt(nr, this._m.compose(this._v.set(l.x, v.y + 0.8, l.z), this._q, ONE));
        this.riders.setColorAt(nr, this._c.set(v.color));
        nr++;
        continue;
      }
      if (!this.detailed || !v.def) continue;
      const m = o.pool.get(v.id, v.def, v.color);
      if (m.view.root.parent !== this.scene) this.scene.add(m.view.root);
      this._q.setFromEuler(this._e.set(v.pitch ?? 0, -v.heading, -(v.bank ?? 0), 'YXZ'));
      m.view.update(this._v.set(l.x, v.y, l.z), this._q, v.speed, 0.6, dt);
      // True size up close; from further off, scaled up so it still reads (at least ~18 px).
      const range = this.camera.position.distanceTo(this._v);
      const px = (m.length / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * range)) * this.viewH;
      m.view.root.scale.setScalar(Math.max(1, 18 / Math.max(1e-3, px)));
    }
    this.riders.count = nr;
    this.riders.instanceMatrix.needsUpdate = true;
    if (this.riders.instanceColor) this.riders.instanceColor.needsUpdate = true;
  }

  /** A planet point (and height) on screen, or null behind the camera / off screen. */
  project(x: number, z: number, y: number, w: number, h: number): { x: number; y: number } | null {
    const l = toLocal(x, z, this.centre.x, this.centre.z);
    const p = this._v.set(l.x, y, l.z).project(this.camera);
    if (p.z > 1 || p.z < -1 || Math.abs(p.x) > 1.3 || Math.abs(p.y) > 1.3) return null;
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
  }

  /** The planet point under a screen point (normalised device coordinates), on the ground. */
  pick(ndc: THREE.Vector2): { x: number; z: number } | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (!hit) return null;
    return { x: this.centre.x + hit.x, z: this.centre.z + hit.z };
  }

  /** Districts loaded (stats, tests). */
  get loaded(): number {
    return this.districts.size;
  }
}
