import * as THREE from 'three/webgpu';
import { Fn, Loop, abs, exp, int, uniformArray, cameraPosition, distance, float, positionLocal, positionWorld, sin, cos, smoothstep, uniform, vec3 } from 'three/tsl';
import type { WorldEvents } from '../sim/events/WorldEvents.ts';
import { MAX_SURGE_PROFILES, surgeProfiles } from '../sim/events/surgeProfiles.ts';
import { COAST, LAYOUT } from '../sim/layout.ts';
import { OCEAN_STEEPNESS, OCEAN_WAVES, type Ocean } from '../sim/ocean.ts';
import { NEON, glow } from './neon.ts';

/** Gerstner-displaced neon ocean. The exact same constants drive headless water contact. */
export class OceanView {
  readonly root = new THREE.Group();
  private readonly time = uniform(0);
  private readonly surge = uniform(0);
  private readonly profileValues = Array.from({ length: MAX_SURGE_PROFILES }, () => new THREE.Vector2());
  private readonly profiles = uniformArray<'vec2'>(this.profileValues, 'vec2');
  private readonly profileCount = uniform(0, 'int');
  private readonly initialSurge: Ocean['surge'];
  constructor(scene: THREE.Scene, private readonly ocean: Ocean, private readonly events?: WorldEvents) {
    this.initialSurge = ocean.surge;
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
    // Evaluate at final displaced XZ, just as oceanHeight inverts Gerstner displacement before
    // adding CPU surge. A camera-local scalar falsely raises the entire sea by one value.
    const hurricaneSurge = Fn(() => {
      const total = float(0).toVar();
      const coast = exp(abs(x.sub(COAST.x)).negate().div(3000));
      Loop({ start: int(0), end: this.profileCount, type: 'int', condition: '<' }, ({ i }) => {
        const profile = this.profiles.element(i);
        total.addAssign(profile.y.mul(coast).mul(exp(abs(z.sub(profile.x)).negate().div(8000))));
      });
      return total;
    })();
    y = y.add(hurricaneSurge);
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
    // Preserve the existing generic callback fallback when callers replace the default source.
    // Only the known WorldEvents callback can be expressed exactly as these shader profiles.
    const useEvents = this.events && this.ocean.surge === this.initialSurge;
    const profiles = useEvents ? surgeProfiles(this.events!.active, this.events!.time) : [];
    this.profileCount.value = profiles.length;
    for (let i = 0; i < profiles.length; i++) this.profileValues[i].set(profiles[i].centerZ, profiles[i].amplitude);
    this.surge.value = useEvents ? 0 : this.ocean.surge?.(camera.position.x, camera.position.z, time) ?? 0;
  }
}
