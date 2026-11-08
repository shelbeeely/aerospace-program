import * as THREE from 'three/webgpu';
import { cameraPosition, distance, float, positionLocal, positionWorld, sin, cos, smoothstep, uniform, vec3 } from 'three/tsl';
import { COAST, LAYOUT } from '../sim/layout.ts';
import { OCEAN_STEEPNESS, OCEAN_WAVES, type Ocean } from '../sim/ocean.ts';
import { NEON, glow } from './neon.ts';

/** Gerstner-displaced neon ocean. The exact same constants drive headless water contact. */
export class OceanView {
  readonly root = new THREE.Group();
  private readonly time = uniform(0);
  private readonly surge = uniform(0);
  constructor(scene: THREE.Scene, private readonly ocean: Ocean) {
    const width = LAYOUT.groundSize / 2 - COAST.x;
    const geometry = new THREE.PlaneGeometry(width, LAYOUT.groundSize, 180, 300);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(COAST.x + width / 2, 0, 0);
    const p = positionLocal;
    let x = p.x;
    let z = p.z;
    let y = float(COAST.seaLevel).add(this.surge);
    for (const w of OCEAN_WAVES) {
      const k = 2 * Math.PI / w.wavelength;
      const phase = p.x.mul(w.dx).add(p.z.mul(w.dz)).mul(k).sub(this.time.mul(Math.sqrt(9.81 * k))).add(w.phase);
      const horizontal = cos(phase).mul(OCEAN_STEEPNESS * w.amplitude);
      x = x.add(horizontal.mul(w.dx));
      z = z.add(horizontal.mul(w.dz));
      y = y.add(sin(phase).mul(w.amplitude));
    }
    const fill = new THREE.MeshBasicNodeMaterial({ color: '#020919', side: THREE.DoubleSide });
    fill.positionNode = vec3(x, y, z);
    const wire = new THREE.MeshBasicNodeMaterial({ color: glow(NEON.cyan, 1.6), wireframe: true, transparent: true, opacity: 0.5 });
    // A dense horizon of unattenuated HDR triangles otherwise blooms into a white wall.
    wire.colorNode = uniform(glow(NEON.cyan, 1.2)).mul(float(1).sub(smoothstep(250, 1800, distance(cameraPosition, positionWorld))));
    wire.positionNode = vec3(x, y.add(0.01), z);
    const mesh = new THREE.Mesh(geometry, fill);
    const lines = new THREE.Mesh(geometry, wire);
    mesh.frustumCulled = false;
    lines.frustumCulled = false;
    this.root.name = 'ocean';
    this.root.add(mesh, lines);
    scene.add(this.root);
  }
  update(time: number, camera: THREE.Camera): void {
    this.time.value = time;
    this.surge.value = this.ocean.surge?.(camera.position.x, camera.position.z, time) ?? 0;
  }
}
