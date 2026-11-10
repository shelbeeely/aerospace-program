import * as THREE from 'three/webgpu';
import { abs, attribute, color, float, fract, max, smoothstep, time } from 'three/tsl';
import { sailerNetwork } from '../../arch/InfrastructureNetwork.ts';
import { PLANET } from '../../sim/layout.ts';
import type { TslNode } from '../neon.ts';

/**
 * Solar Sailer routes: energy beams strung between landmarks across cities and Outlands, carried
 * by the pylons the districts build. Each beam is a pair of crossed ribbons (subdivided so the
 * planet's curvature bends them) whose shader runs bright sailer packets along it.
 */
const C = PLANET.circumference;

function beamMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const uv: TslNode = attribute('uv', 'vec2');
  const along: TslNode = uv.y;
  const route: TslNode = attribute('route', 'float');
  // Across the ribbon: bright core, soft falloff.
  const across: TslNode = float(1).sub(smoothstep(0.0, 1.0, abs(uv.x.sub(0.5)).mul(2)));
  // Sailers: packets moving at ~70 m/s, spaced along each route by its id.
  const ph: TslNode = fract(along.div(2400).sub(time.mul(70 / 2400)).add(route.mul(0.137)));
  const packet: TslNode = smoothstep(0.985, 0.997, ph).mul(4);
  const beam: TslNode = (color('#eaf6ff') as TslNode).mul(0.35).add((color('#ffd27a') as TslNode).mul(packet));
  m.colorNode = beam.mul(across).mul(max(float(0.2), float(1)));
  m.name = 'sailer-beam';
  return m;
}

export class InfrastructureView {
  readonly root = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private readonly mat = beamMaterial();
  private centre = new THREE.Vector2(NaN, NaN);
  range = 12000;

  constructor(scene: THREE.Scene) {
    this.root.name = 'sailer-routes';
    scene.add(this.root);
  }

  update(cam: THREE.Vector3): void {
    if (Math.hypot(cam.x - this.centre.x, cam.z - this.centre.y) < 1500) return;
    this.centre.set(cam.x, cam.z);
    this.rebuild(cam);
  }

  private rebuild(cam: THREE.Vector3): void {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    const pos: number[] = [], uv: number[] = [], rid: number[] = [];
    const { routes } = sailerNetwork();
    for (const r of routes) {
      const mx = (r.a.x + r.b.x) / 2, mz = (r.a.z + r.b.z) / 2;
      const ox = Math.round((cam.x - mx) / C) * C, oz = Math.round((cam.z - mz) / C) * C;
      const ax = r.a.x + ox, az = r.a.z + oz, bx = r.b.x + ox, bz = r.b.z + oz;
      // Skip routes entirely out of range.
      const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
      const t = Math.max(0, Math.min(1, ((cam.x - ax) * dx + (cam.z - az) * dz) / (L * L)));
      if (Math.hypot(ax + dx * t - cam.x, az + dz * t - cam.z) > this.range) continue;
      const n = Math.max(2, Math.ceil(L / 120));
      const sx = -dz / L, sz = dx / L;
      const w = 1.4;
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n;
        const p0 = [ax + dx * t0, r.y, az + dz * t0], p1 = [ax + dx * t1, r.y, az + dz * t1];
        // Horizontal ribbon and vertical ribbon.
        for (const [ex, ey, ez] of [[sx * w, 0, sz * w], [0, w, 0]]) {
          const q = [
            [p0[0] - ex, p0[1] - ey, p0[2] - ez, 0, t0 * L], [p0[0] + ex, p0[1] + ey, p0[2] + ez, 1, t0 * L],
            [p1[0] + ex, p1[1] + ey, p1[2] + ez, 1, t1 * L], [p1[0] - ex, p1[1] - ey, p1[2] - ez, 0, t1 * L],
          ];
          for (const i of [0, 1, 2, 0, 2, 3]) {
            pos.push(q[i][0], q[i][1], q[i][2]);
            uv.push(q[i][3], q[i][4]);
            rid.push(r.id % 97);
          }
        }
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('route', new THREE.Float32BufferAttribute(rid, 1));
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.root.add(this.mesh);
  }

  get routes(): number {
    return sailerNetwork().routes.length;
  }

  clear(): void {
    this.centre.set(NaN, NaN);
  }
}
