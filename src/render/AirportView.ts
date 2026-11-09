import * as THREE from 'three/webgpu';
import { abs, attribute, color, float, fract, min, mix, step, time, uv, vec2 } from 'three/tsl';
import { AIRPORT, LAYOUT } from '../sim/layout.ts';
import { airportPlan, type AirportLight } from '../world/Airport.ts';
import { neonLineMaterial, type TslNode } from './neon.ts';

const LIGHT_COLOURS: Record<AirportLight['kind'], [string, number]> = {
  edge: ['#fff4d6', 5],
  threshold: ['#39ff6a', 6],
  end: ['#ff2030', 6],
  taxi: ['#2f6bff', 5],
  approach: ['#fff4d6', 4],
  strobe: ['#ffffff', 0],
};

/**
 * Airport dressing: the parallel taxiway and its connectors with green centrelines, the apron
 * with lead-in lines, runway edge / threshold / end lights, approach light bars with the
 * sequenced flasher ("the rabbit") running toward each threshold, taxiway edge lights, two
 * working PAPIs (each light shows white above its angle and red below, seen from the camera),
 * a windsock that swings and droops with the real wind, and the tower's rotating beacon.
 * The buildings themselves are destructible structures drawn by CityView.
 */
export class AirportView {
  readonly root = new THREE.Group();
  private readonly papi: THREE.InstancedMesh;
  private readonly papiLights: Array<{ x: number; z: number; angle: number }> = [];
  private readonly sock = new THREE.Group();
  private readonly sockPivot = new THREE.Group();
  private readonly beacon: THREE.Mesh;
  private readonly white = new THREE.Color('#ffffff').multiplyScalar(6);
  private readonly red = new THREE.Color('#ff1a2a').multiplyScalar(6);

  constructor(scene: THREE.Scene) {
    this.root.name = 'airport';
    const plan = airportPlan();
    const { width, length, centerZ } = LAYOUT.runway;
    const zN = centerZ - length / 2;
    const zS = centerZ + length / 2;

    // --- Taxiway, connectors and apron surfaces.
    const tw = AIRPORT.taxiwayWidth;
    this.root.add(this.strip(AIRPORT.taxiwayX, centerZ, tw, length + 40, 'z'));
    for (const cz of [zS - 30, centerZ, zN + 30]) {
      const xa = AIRPORT.taxiwayX + tw / 2;
      const xb = -width / 2;
      this.root.add(this.strip((xa + xb) / 2, cz, xb - xa, tw, 'x'));
    }
    const a = AIRPORT.apron;
    this.root.add(this.apron((a.x0 + a.x1) / 2, (a.z0 + a.z1) / 2, a.x1 - a.x0, a.z1 - a.z0));

    // --- Point lights, instanced per kind (strobes flash in sequence on the GPU).
    const byKind = new Map<AirportLight['kind'], AirportLight[]>();
    for (const l of plan.lights) {
      const list = byKind.get(l.kind) ?? [];
      list.push(l);
      byKind.set(l.kind, list);
    }
    const dot = new THREE.OctahedronGeometry(0.45, 0);
    for (const [kind, list] of byKind) {
      const [hex, k] = LIGHT_COLOURS[kind];
      const mat = new THREE.MeshBasicNodeMaterial();
      let geo: THREE.BufferGeometry = dot;
      if (kind === 'strobe') {
        // Each flasher fires once per 1 s cycle, in sequence toward the threshold.
        geo = dot.clone();
        const n = Math.max(...list.map((l) => l.seq ?? 0)) + 1;
        const seqAttr = new THREE.InstancedBufferAttribute(new Float32Array(list.map((l) => (l.seq ?? 0) / n)), 1);
        geo.setAttribute('seq', seqAttr);
        const phase: TslNode = fract(time.mul(2).sub(attribute('seq', 'float')));
        mat.colorNode = color(hex).mul(step(phase, float(0.06)).mul(14));
      } else {
        mat.colorNode = color(hex).mul(k);
      }
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((l, i) => mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(l.x, l.y, l.z)));
      mesh.computeBoundingSphere();
      this.root.add(mesh);
    }

    // --- PAPI: colour per light from the camera's elevation angle (updated each frame).
    const papiMat = new THREE.MeshBasicNodeMaterial();
    for (const p of plan.papis) for (const l of p.lights) this.papiLights.push({ x: l.x, z: p.z, angle: l.angle });
    this.papi = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 1, 0.6), papiMat, this.papiLights.length);
    this.papiLights.forEach((l, i) => {
      this.papi.setMatrixAt(i, new THREE.Matrix4().makeTranslation(l.x, 0.6, l.z));
      this.papi.setColorAt(i, this.red);
    });
    this.root.add(this.papi);

    // --- Windsock: mast plus a striped orange/white cone that turns downwind and droops.
    const ws = plan.windsock;
    const mast = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, ws.height, 0)]),
      neonLineMaterial('#e8f6ff', 3),
    );
    this.sock.position.set(ws.x, 0, ws.z);
    this.sock.add(mast);
    this.sockPivot.position.y = ws.height;
    for (let k = 0; k < 4; k++) {
      const cone = new THREE.CylinderGeometry(0.42 - k * 0.08, 0.5 - k * 0.08, 1, 10, 1, true);
      cone.rotateZ(Math.PI / 2);
      cone.translate(0.5 + k, 0, 0);
      this.sockPivot.add(new THREE.LineSegments(new THREE.EdgesGeometry(cone, 1), neonLineMaterial(k % 2 ? '#ffffff' : '#ff8a1f', 4)));
    }
    this.sock.add(this.sockPivot);
    this.root.add(this.sock);

    // --- Tower beacon: alternating green / white flashes.
    const bMat = new THREE.MeshBasicNodeMaterial();
    const cycle: TslNode = fract(time.mul(0.75));
    bMat.colorNode = mix(color('#3dff6a'), color('#ffffff'), step(0.5, cycle)).mul(step(fract(cycle.mul(2)), float(0.18)).mul(12));
    this.beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.9, 0), bMat);
    this.beacon.position.set(plan.beacon.x, plan.beacon.y, plan.beacon.z);
    this.root.add(this.beacon);

    scene.add(this.root);
  }

  /** Taxiway strip: dark, glowing green centreline, yellow edge lines. */
  private strip(x: number, z: number, w: number, l: number, along: 'x' | 'z'): THREE.Mesh {
    const mat = new THREE.MeshBasicNodeMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -3 });
    // u across, v along (metres).
    const p: TslNode = uv().mul(along === 'z' ? vec2(w, l) : vec2(l, w));
    const across: TslNode = along === 'z' ? p.x : p.y;
    const centre: TslNode = step(abs(across.sub(w / 2)), float(0.2)) as TslNode;
    const edge: TslNode = step(min(across, float(w).sub(across)) as TslNode, float(0.35)) as TslNode;
    mat.colorNode = (color('#03050f') as TslNode).add(color('#39ff6a').mul(centre.mul(2.2))).add(color('#ffd23f').mul(edge.mul(1.6)));
    const n = Math.ceil(l / 40);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(along === 'z' ? w : l, along === 'z' ? l : w, along === 'z' ? 1 : n, along === 'z' ? n : 1).rotateX(-Math.PI / 2), mat);
    mesh.position.set(x, 0.025, z);
    return mesh;
  }

  /** Apron: dark concrete with a faint grid and yellow lead-in lines to each gate. */
  private apron(x: number, z: number, w: number, d: number): THREE.Mesh {
    const mat = new THREE.MeshBasicNodeMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -3 });
    const p: TslNode = uv().mul(vec2(w, d));
    const t = AIRPORT.terminal;
    let lead: TslNode = float(0);
    for (let g = 0; g < 6; g++) {
      const gz = t.z - t.length / 2 + 40 + g * ((t.length - 80) / 5);
      const v = gz - (z - d / 2); // apron-local metres along Z (uv.y runs +Z → -Z after rotation)
      lead = lead.add(step(abs(float(d).sub(p.y).sub(v)), float(0.25)));
    }
    const grid: TslNode = step(fract(p.x.div(20)), float(0.02)).add(step(fract(p.y.div(20)), float(0.02))).min(1);
    mat.colorNode = (color('#04071a') as TslNode).add(color('#1f3cff').mul(grid.mul(0.35))).add(color('#ffd23f').mul(lead.min(1).mul(1.6)));
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d, Math.ceil(w / 40), Math.ceil(d / 40)).rotateX(-Math.PI / 2), mat);
    mesh.position.set(x, 0.022, z);
    return mesh;
  }

  /** camera: for the PAPI angles; wind: world wind at 10 m (m/s, +X east, -Z north). */
  update(camera: THREE.Camera, wind: THREE.Vector3): void {
    const c = camera.position;
    this.papiLights.forEach((l, i) => {
      const d = Math.hypot(c.x - l.x, c.z - l.z);
      const elev = (Math.atan2(c.y - 0.6, Math.max(1, d)) * 180) / Math.PI;
      this.papi.setColorAt(i, elev > l.angle ? this.white : this.red);
    });
    if (this.papi.instanceColor) this.papi.instanceColor.needsUpdate = true;

    // The sock points downwind (where the wind blows to) and lifts with wind speed.
    const speed = Math.hypot(wind.x, wind.z);
    this.sock.rotation.y = Math.atan2(-wind.z, wind.x);
    this.sockPivot.rotation.z = -(1 - Math.min(1, speed / 15)) * 1.25;
  }
}
