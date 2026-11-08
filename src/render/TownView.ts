import * as THREE from 'three/webgpu';
import { attribute, positionLocal, uniform, vec3 } from 'three/tsl';
import type { Chunk } from '../world/DebrisPool.ts';
import type { Town } from '../world/Town.ts';

/** Edge glow (HDR multiplier: > 1 so bloom picks the outlines up). */
const EDGE_INTENSITY = 3;
const FILL_COLOR = '#04050b';

/**
 * Instanced blocks: a dark fill box and neon edge lines per block, both drawn as instances of
 * one geometry with a per-instance (x, y, z, scale) offset. A dead block gets scale 0. One fill
 * and one line draw call per building / chunk, on WebGPU and WebGL2 alike.
 */
class BlockMeshes {
  readonly group = new THREE.Group();
  private readonly offsets: THREE.InstancedBufferAttribute;
  private readonly fillGeo: THREE.InstancedBufferGeometry;
  private readonly lineGeo: THREE.InstancedBufferGeometry;

  constructor(
    centres: ArrayLike<number>,
    count: number,
    size: number,
    readonly fillMat: THREE.Material,
    readonly lineMat: THREE.Material,
    bounds: THREE.Sphere,
  ) {
    const data = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      data[i * 4] = centres[i * 3];
      data[i * 4 + 1] = centres[i * 3 + 1];
      data[i * 4 + 2] = centres[i * 3 + 2];
      data[i * 4 + 3] = 1;
    }
    this.offsets = new THREE.InstancedBufferAttribute(data, 4);
    this.offsets.setUsage(THREE.DynamicDrawUsage);

    // Fill a little smaller than the block so every block reads as its own cell.
    const box = new THREE.BoxGeometry(size * 0.97, size * 0.97, size * 0.97);
    this.fillGeo = new THREE.InstancedBufferGeometry().copy(box as unknown as THREE.InstancedBufferGeometry);
    box.dispose();
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(size * 0.985, size * 0.985, size * 0.985));
    this.lineGeo = new THREE.InstancedBufferGeometry().copy(edges as unknown as THREE.InstancedBufferGeometry);
    edges.dispose();
    for (const g of [this.fillGeo, this.lineGeo]) {
      g.instanceCount = count;
      g.setAttribute('blockOffset', this.offsets);
      // The base geometry's bounds know nothing about the instances.
      g.boundingSphere = bounds.clone();
    }
    const fill = new THREE.Mesh(this.fillGeo, fillMat);
    fill.receiveShadow = true;
    const lines = new THREE.LineSegments(this.lineGeo, lineMat);
    this.group.add(fill, lines);
  }

  setVisible(i: number, visible: boolean): void {
    this.offsets.setW(i, visible ? 1 : 0);
  }

  commit(): void {
    this.offsets.needsUpdate = true;
  }

  dispose(): void {
    this.fillGeo.dispose();
    this.lineGeo.dispose();
  }
}

/** Node materials that place each instance by its `blockOffset` attribute. */
function blockMaterials(color: string): { fill: THREE.Material; line: THREE.Material } {
  const offset = attribute('blockOffset', 'vec4');
  const placed = positionLocal.mul(offset.w).add(offset.xyz);
  const neon = new THREE.Color(color);
  const fill = new THREE.MeshStandardNodeMaterial({ color: FILL_COLOR, roughness: 0.55, metalness: 0.3 });
  fill.positionNode = placed;
  fill.emissiveNode = vec3(neon.r, neon.g, neon.b).mul(0.035);
  const line = new THREE.LineBasicNodeMaterial();
  line.positionNode = placed;
  line.colorNode = uniform(neon.clone().multiplyScalar(EDGE_INTENSITY));
  return { fill, line };
}

interface Spark {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dir: THREE.Vector3;
  color: THREE.Color;
  age: number;
  life: number;
}

const MAX_SPARKS = 768;

/**
 * Draws the town (src/world/Town.ts): each building as instanced dark blocks with glowing edges
 * (destroyed / fallen blocks hidden), each falling chunk from its rigid body's pose, and a burst
 * of neon shards wherever a block is destroyed.
 */
export class TownView {
  readonly root = new THREE.Group();
  private readonly buildings: Array<{ meshes: BlockMeshes; version: number }> = [];
  private readonly chunks = new Map<Chunk, BlockMeshes>();
  private readonly materials = new Map<string, { fill: THREE.Material; line: THREE.Material }>();
  private poolVersion = -1;
  private destroyedSeen = 0;

  private readonly sparks: Spark[] = Array.from({ length: MAX_SPARKS }, () => ({
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    color: new THREE.Color(),
    age: 1,
    life: 0,
  }));
  /** Next ring slot to overwrite. */
  private sparkNext = 0;
  private resetsSeen = 0;
  private readonly _color = new THREE.Color();
  private readonly sparkGeo = new THREE.BufferGeometry();
  private readonly sparkPos = new Float32Array(MAX_SPARKS * 6);
  private readonly sparkCol = new Float32Array(MAX_SPARKS * 6);

  constructor(
    scene: THREE.Scene,
    private readonly town: Town,
  ) {
    this.root.name = 'town';
    const c = { x: 0, y: 0, z: 0 };
    for (const b of town.buildings) {
      const n = b.list.length;
      const centres = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        b.localCentre(b.list[i], c);
        centres[i * 3] = c.x;
        centres[i * 3 + 1] = c.y;
        centres[i * 3 + 2] = c.z;
      }
      const s = b.blockSize;
      const [w, h, d] = b.def.size;
      const half = new THREE.Vector3(w * s, h * s, d * s).multiplyScalar(0.5);
      const mats = this.materialsFor(b.def.color);
      const meshes = new BlockMeshes(centres, n, s, mats.fill, mats.line, new THREE.Sphere(half.clone(), half.length()));
      meshes.group.position.set(...b.def.origin);
      this.root.add(meshes.group);
      this.buildings.push({ meshes, version: -1 });
    }

    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.sparkGeo.setAttribute('color', new THREE.BufferAttribute(this.sparkCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.sparkGeo.setDrawRange(0, 0);
    const sparkLines = new THREE.LineSegments(this.sparkGeo, new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    sparkLines.frustumCulled = false;
    this.root.add(sparkLines);

    scene.add(this.root);
    this.update(0);
  }

  private materialsFor(color: string) {
    let m = this.materials.get(color);
    if (!m) this.materials.set(color, (m = blockMaterials(color)));
    return m;
  }

  /** Sync with the simulation (dt: frame time, for the shards). */
  update(dt: number): void {
    const town = this.town;
    for (let i = 0; i < this.buildings.length; i++) {
      const view = this.buildings[i];
      const b = town.buildings[i];
      if (view.version === b.version) continue;
      view.version = b.version;
      for (const block of b.list) view.meshes.setVisible(block.index, block.alive);
      view.meshes.commit();
    }

    if (town.pool.version !== this.poolVersion) {
      this.poolVersion = town.pool.version;
      const live = new Set(town.pool.chunks);
      for (const [chunk, meshes] of this.chunks) {
        if (live.has(chunk)) continue;
        meshes.group.removeFromParent();
        meshes.dispose();
        this.chunks.delete(chunk);
      }
      for (const chunk of town.pool.chunks) {
        if (this.chunks.has(chunk)) continue;
        const mats = this.materialsFor(chunk.building.def.color);
        let r = 0;
        for (let i = 0; i < chunk.offsets.length; i += 3) r = Math.max(r, Math.hypot(chunk.offsets[i], chunk.offsets[i + 1], chunk.offsets[i + 2]));
        const s = chunk.building.blockSize;
        const meshes = new BlockMeshes(chunk.offsets, chunk.blocks.length, s, mats.fill, mats.line, new THREE.Sphere(new THREE.Vector3(), r + s));
        this.root.add(meshes.group);
        this.chunks.set(chunk, meshes);
      }
    }
    for (const [chunk, meshes] of this.chunks) {
      if (chunk.frozen && meshes.group.userData.frozen) continue;
      const t = chunk.body.translation();
      const q = chunk.body.rotation();
      meshes.group.position.set(t.x, t.y, t.z);
      meshes.group.quaternion.set(q.x, q.y, q.z, q.w);
      meshes.group.userData.frozen = chunk.frozen;
    }

    this.updateSparks(dt);
  }

  private updateSparks(dt: number): void {
    const town = this.town;
    if (town.resets !== this.resetsSeen) {
      // The town was reset (maybe followed by new breaks in the same frame): start over.
      this.resetsSeen = town.resets;
      this.destroyedSeen = 0;
      for (const s of this.sparks) s.age = s.life;
    }
    const fresh = Math.min(town.destroyed - this.destroyedSeen, town.breaks.length);
    this.destroyedSeen = town.destroyed;
    // A whole chunk shattering is plenty at 2 shards per block.
    const perBlock = fresh > 60 ? 2 : 6;
    for (let i = town.breaks.length - fresh; i < town.breaks.length; i++) {
      const br = town.breaks[i];
      this._color.set(br.color).multiplyScalar(EDGE_INTENSITY * 1.5);
      for (let k = 0; k < perBlock; k++) {
        const s = this.sparks[this.sparkNext];
        this.sparkNext = (this.sparkNext + 1) % MAX_SPARKS;
        s.vel.set(Math.random() - 0.5, Math.random() * 0.8 + 0.1, Math.random() - 0.5).normalize().multiplyScalar(6 + Math.random() * 14);
        s.pos.set(br.x, br.y, br.z).addScaledVector(s.vel, 0.08);
        s.dir.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(0.6 + Math.random() * 1.2);
        s.color.copy(this._color);
        s.age = 0;
        s.life = 1.2 + Math.random() * 1.2;
      }
    }
    let n = 0;
    for (const s of this.sparks) {
      if (s.age >= s.life) continue;
      s.age += dt;
      if (s.age >= s.life) continue;
      s.vel.y -= 9.81 * dt;
      s.pos.addScaledVector(s.vel, dt);
      if (s.pos.y < 0.05) {
        s.pos.y = 0.05;
        s.vel.multiplyScalar(0.3);
        s.vel.y = Math.abs(s.vel.y);
      }
      const fade = 1 - s.age / s.life;
      const o = n * 6;
      this.sparkPos[o] = s.pos.x - s.dir.x;
      this.sparkPos[o + 1] = s.pos.y - s.dir.y;
      this.sparkPos[o + 2] = s.pos.z - s.dir.z;
      this.sparkPos[o + 3] = s.pos.x + s.dir.x;
      this.sparkPos[o + 4] = s.pos.y + s.dir.y;
      this.sparkPos[o + 5] = s.pos.z + s.dir.z;
      for (let k = 0; k < 2; k++) {
        this.sparkCol[o + k * 3] = s.color.r * fade;
        this.sparkCol[o + k * 3 + 1] = s.color.g * fade;
        this.sparkCol[o + k * 3 + 2] = s.color.b * fade;
      }
      n++;
    }
    this.sparkGeo.setDrawRange(0, n * 2);
    (this.sparkGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.sparkGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}
