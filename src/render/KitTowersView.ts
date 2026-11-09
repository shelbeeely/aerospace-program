import * as THREE from 'three/webgpu';
import { color } from 'three/tsl';
import { cityPlan } from '../world/City.ts';
import { KIT, KIT_INDEX_BYTES, KIT_POSITION_BYTES } from '../world/kit.ts';
import type { StaticWorld } from '../world/staticWorld.ts';
import { worldStructures, type StructureGroup } from '../world/structures.ts';
import { facadeMaterial } from './StructuresView.ts';

/**
 * The imported kit towers ("Tron Buildings 1" by SpringSociety, CC-BY-4.0) placed across the
 * Grid: one InstancedMesh per tower type with a material per role from the model (steel metal,
 * HDR glow strips and panels, dark glass). A fractured tower's instance hides; its block grid
 * (from the same voxels) takes over in TownView.
 */
export class KitTowersView {
  readonly root = new THREE.Group();
  private readonly instances = new Map<number, { mesh: THREE.InstancedMesh; index: number; matrix: THREE.Matrix4 }>();
  /** Far LOD: each tower's collider boxes drawn as plain façade boxes (a few hundred vertices). */
  private readonly proxies = new Map<number, { start: number; count: number; matrices: THREE.Matrix4[] }>();
  private proxyMesh: THREE.InstancedMesh | null = null;
  /** Per group: 0 hidden (fractured), 1 full model, 2 proxy. */
  private readonly lod = new Map<number, number>();
  private readonly centres = new Map<number, THREE.Vector3>();
  private readonly lastCam = new THREE.Vector3(Infinity, 0, 0);
  private lastLodTime = 0;
  private seen = -1;
  private ready = false;
  private static readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(scene: THREE.Scene, private readonly world: StaticWorld, baseUrl = '/') {
    this.root.name = 'kit-towers';
    scene.add(this.root);
    void this.load(`${baseUrl}models/towerKit.bin`);
  }

  private async load(url: string): Promise<void> {
    let buf: ArrayBuffer;
    try {
      buf = await (await fetch(url)).arrayBuffer();
    } catch (e) {
      console.warn('tower kit not loaded:', e);
      return;
    }
    if (buf.byteLength < KIT_POSITION_BYTES + KIT_INDEX_BYTES) return;
    const positions = new Float32Array(buf, 0, KIT_POSITION_BYTES / 4);
    const roles: Record<string, THREE.Material> = {
      metal: facadeMaterial('#1f8bff', false),
      metalLight: facadeMaterial('#00eaff', false),
      walls: facadeMaterial('#1f6bff', false),
      floor: facadeMaterial('#1f8bff', false),
      glow: glowMaterial('#00eaff', 3.2),
      emissive: glowMaterial('#ff8a1f', 3.6),
      strip: glowMaterial('#1f8bff', 4),
      glass: new THREE.MeshStandardNodeMaterial({ color: '#050a26', metalness: 0.9, roughness: 0.12, emissive: '#0a1a5a', emissiveIntensity: 0.6 }),
    };
    const roleNames = Object.keys(roles);
    const materials = roleNames.map((r) => roles[r]);
    this.materials = materials;
    this.positions = positions;
    this.roleNames = roleNames;

    const plan = cityPlan();
    const ws = worldStructures();
    const groups = ws.groups.filter((g) => g.kit);
    // Proxy boxes: the collider boxes (render: false pieces) of every kit tower.
    let total = 0;
    for (const g of groups) total += g.pieces.length;
    this.proxyMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), facadeMaterial('#00eaff', true), Math.max(1, total));
    let at = 0;
    const pm = new THREE.Matrix4();
    for (const g of groups) {
      const matrices = g.pieces.map((i) => {
        const p = ws.list[i];
        return pm.compose(new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion(), new THREE.Vector3(p.sx, p.sy, p.sz)).clone();
      });
      this.proxies.set(g.id, { start: at, count: matrices.length, matrices });
      for (let k = 0; k < matrices.length; k++) this.proxyMesh.setMatrixAt(at + k, KitTowersView.zero);
      at += matrices.length;
      this.centres.set(g.id, new THREE.Vector3(g.x0 + (g.size[0] * g.blockSize) / 2, 0, g.z0 + (g.size[2] * g.blockSize) / 2));
    }
    this.proxyMesh.frustumCulled = false;
    this.root.add(this.proxyMesh);
    const byType = new Map<number, typeof groups>();
    for (const g of groups) {
      const list = byType.get(g.kit!.type) ?? [];
      list.push(g);
      byType.set(g.kit!.type, list);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const [type, list] of byType) {
      const t = KIT[type];
      const geo = this.typeGeometry(type);
      void t;
      const mesh = new THREE.InstancedMesh(geo, materials, list.length);
      list.forEach((g, i) => {
        const inst = plan.kit[g.kit!.index];
        q.setFromAxisAngle(up, (inst.rot * Math.PI) / 2);
        m.compose(new THREE.Vector3(inst.x, 0, inst.z), q, new THREE.Vector3(inst.scale, inst.scale, inst.scale));
        mesh.setMatrixAt(i, KitTowersView.zero);
        this.instances.set(g.id, { mesh, index: i, matrix: m.clone() });
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      this.root.add(mesh);
    }
    this.ready = true;
    this.seen = -1;
    this.fillOuter();
  }

  private materials: THREE.Material[] = [];
  private positions: Float32Array | null = null;
  private roleNames: string[] = [];
  private readonly geometries = new Map<number, THREE.BufferGeometry>();
  private readonly outerMeshes = new Map<number, THREE.InstancedMesh>();
  private outerGroups: StructureGroup[] = [];

  private typeGeometry(type: number): THREE.BufferGeometry {
    let geo = this.geometries.get(type);
    if (geo) return geo;
    const t = KIT[type];
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions!.slice(t.vertexStart * 3, (t.vertexStart + t.vertexCount) * 3), 3));
    geo.computeVertexNormals();
    for (const g of t.groups) geo.addGroup(g.start, g.count, Math.max(0, this.roleNames.indexOf(g.role)));
    this.geometries.set(type, geo);
    return geo;
  }

  /** Kit towers of the planet city's near chunks, drawn as real models (PlanetCityView). */
  setOuter(groups: StructureGroup[]): void {
    this.outerGroups = groups;
    this.fillOuter();
  }

  private fillOuter(): void {
    if (!this.ready) return;
    const byType = new Map<number, StructureGroup[]>();
    for (const g of this.outerGroups) {
      if (this.world.fractured.has(g.id)) continue;
      const list = byType.get(g.kit!.type) ?? [];
      list.push(g);
      byType.set(g.kit!.type, list);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (let type = 0; type < KIT.length; type++) {
      const list = byType.get(type) ?? [];
      let mesh = this.outerMeshes.get(type);
      if (!mesh || mesh.instanceMatrix.count < list.length) {
        if (mesh) { mesh.removeFromParent(); mesh.dispose(); }
        if (!list.length) continue;
        mesh = new THREE.InstancedMesh(this.typeGeometry(type), this.materials, Math.max(32, list.length * 2));
        mesh.frustumCulled = false;
        this.outerMeshes.set(type, mesh);
        this.root.add(mesh);
      }
      list.forEach((g, i) => {
        const k = g.kit!;
        q.setFromAxisAngle(up, (k.rot * Math.PI) / 2);
        m.compose(new THREE.Vector3(k.x, 0, k.z), q, new THREE.Vector3(k.scale, k.scale, k.scale));
        mesh!.setMatrixAt(i, m);
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * LOD and fractures: full models within FULL_RANGE of the camera, box proxies beyond, nothing
   * for a fractured tower (its blocks are drawn by TownView). Re-bucketed every 0.5 s or 100 m.
   */
  update(camera?: THREE.Vector3, now = performance.now()): void {
    if (!this.ready || !this.proxyMesh) return;
    const cam = camera ?? this.lastCam;
    const moved = camera ? cam.distanceToSquared(this.lastCam) > 100 * 100 : false;
    const due = now - this.lastLodTime > 500;
    if (this.world.version === this.seen && !moved && !(due && camera)) return;
    if (this.world.version !== this.seen) this.fillOuter();
    this.seen = this.world.version;
    this.lastLodTime = now;
    if (camera) this.lastCam.copy(camera);
    const touched = new Set<THREE.InstancedMesh>();
    let proxyTouched = false;
    for (const [group, it] of this.instances) {
      const c = this.centres.get(group)!;
      const want = this.world.fractured.has(group) ? 0 : Math.hypot(c.x - this.lastCam.x, c.z - this.lastCam.z) < FULL_RANGE ? 1 : 2;
      if (this.lod.get(group) === want) continue;
      this.lod.set(group, want);
      it.mesh.setMatrixAt(it.index, want === 1 ? it.matrix : KitTowersView.zero);
      touched.add(it.mesh);
      const px = this.proxies.get(group)!;
      for (let k = 0; k < px.count; k++) this.proxyMesh.setMatrixAt(px.start + k, want === 2 ? px.matrices[k] : KitTowersView.zero);
      proxyTouched = true;
    }
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
    if (proxyTouched) this.proxyMesh.instanceMatrix.needsUpdate = true;
  }
}

/** Full kit models within this distance of the camera (m); box proxies beyond. */
const FULL_RANGE = 1400;

function glowMaterial(hex: string, k: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = color(hex).mul(k);
  return m;
}
