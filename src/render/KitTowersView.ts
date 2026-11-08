import * as THREE from 'three/webgpu';
import { color } from 'three/tsl';
import { cityPlan } from '../world/City.ts';
import { KIT, KIT_INDEX_BYTES, KIT_POSITION_BYTES } from '../world/kit.ts';
import type { StaticWorld } from '../world/staticWorld.ts';
import { worldStructures } from '../world/structures.ts';
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
  private seen = -1;
  private ready = false;

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
      walls: facadeMaterial('#9d4dff', false),
      floor: facadeMaterial('#1f8bff', false),
      glow: glowMaterial('#00eaff', 3.2),
      emissive: glowMaterial('#ff8a1f', 3.6),
      strip: glowMaterial('#1f8bff', 4),
      glass: new THREE.MeshStandardNodeMaterial({ color: '#050a26', metalness: 0.9, roughness: 0.12, emissive: '#0a1a5a', emissiveIntensity: 0.6 }),
    };
    const roleNames = Object.keys(roles);
    const materials = roleNames.map((r) => roles[r]);

    const plan = cityPlan();
    const groups = worldStructures().groups.filter((g) => g.kit);
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
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions.slice(t.vertexStart * 3, (t.vertexStart + t.vertexCount) * 3), 3));
      geo.computeVertexNormals();
      for (const g of t.groups) geo.addGroup(g.start, g.count, Math.max(0, roleNames.indexOf(g.role)));
      const mesh = new THREE.InstancedMesh(geo, materials, list.length);
      list.forEach((g, i) => {
        const inst = plan.kit[g.kit!.index];
        q.setFromAxisAngle(up, (inst.rot * Math.PI) / 2);
        m.compose(new THREE.Vector3(inst.x, 0, inst.z), q, new THREE.Vector3(inst.scale, inst.scale, inst.scale));
        mesh.setMatrixAt(i, m);
        this.instances.set(g.id, { mesh, index: i, matrix: m.clone() });
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.root.add(mesh);
    }
    this.ready = true;
    this.seen = -1;
  }

  update(): void {
    if (!this.ready || this.world.version === this.seen) return;
    this.seen = this.world.version;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const touched = new Set<THREE.InstancedMesh>();
    for (const [group, it] of this.instances) {
      it.mesh.setMatrixAt(it.index, this.world.fractured.has(group) ? zero : it.matrix);
      touched.add(it.mesh);
    }
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
  }
}

function glowMaterial(hex: string, k: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = color(hex).mul(k);
  return m;
}
