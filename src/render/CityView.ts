import * as THREE from 'three/webgpu';
import { abs, color, float, floor, fract, hash, instanceIndex, max, min, mix, positionWorld, step, time, uniform } from 'three/tsl';
import { CITY, LAYOUT } from '../sim/layout.ts';
import { airportPlan } from '../world/Airport.ts';
import { cityPlan, mulberry32 } from '../world/City.ts';
import type { StaticWorld } from '../world/staticWorld.ts';
import { worldStructures } from '../world/structures.ts';
import { gridLines, neonLineMaterial, type TslNode } from './neon.ts';
import { StructuresView, type StructurePiece } from './StructuresView.ts';

const TRAFFIC = 1600;

/**
 * The neon city (and the airport's buildings): every destructible structure drawn by one
 * StructuresView, plus city dressing: road surfaces with glowing lanes, light-cycle traffic on
 * the streets and raised highways, spires, halo rings and blinking red aviation lights. When a
 * structure fractures, its intact meshes hide (the block grid takes over in TownView); a reset
 * shows them again.
 */
export class CityView {
  readonly root = new THREE.Group();
  private readonly structures: StructuresView;
  private seenVersion = -1;
  private readonly cars: Array<{ road: number; lane: number; dir: 1 | -1; s: number; speed: number; mesh: 0 | 1; index: number }> = [];
  private readonly carMeshes: THREE.InstancedMesh[] = [];
  private readonly beacons: THREE.InstancedMesh;
  private readonly beaconGroup: number[] = [];
  private readonly beaconMatrix: THREE.Matrix4[] = [];
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3(1, 1, 1);
  private readonly turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

  constructor(scene: THREE.Scene, private readonly world: StaticWorld) {
    this.root.name = 'city';
    const city = cityPlan();
    const ws = worldStructures();
    const groupOf = new Map(ws.groups.map((g) => [g.name, g.id]));
    const pieces: StructurePiece[] = ws.list.map((p) => ({ ...p }));
    // Spires render as thin masts that fall with their building.
    for (const s of city.spires) {
      const b = city.buildings.find((x) => Math.abs(x.x - s.x) < 1e-6 && Math.abs(x.z - s.z) < 1e-6);
      const group = b ? groupOf.get(`city:${b.id}`) ?? -1 : -1;
      pieces.push({ shape: 'oct', x: s.x, y: (s.y0 + s.y1) / 2, z: s.z, sx: 1.6, sy: s.y1 - s.y0, sz: 1.6, color: CITY.colors[s.color], windows: false, group });
    }
    this.structures = new StructuresView(pieces, { name: 'structures' });
    this.root.add(this.structures.root);

    // Road surface everywhere except the airfield (split into four rectangles around it).
    const af = { x0: -560, x1: 260, z0: LAYOUT.runway.centerZ - LAYOUT.runway.length / 2 - 200, z1: LAYOUT.runway.centerZ + LAYOUT.runway.length / 2 + 200 };
    for (const [ax0, ax1, az0, az1] of [
      [city.x0, af.x0, city.z0, city.z1], [af.x1, city.x1, city.z0, city.z1],
      [af.x0, af.x1, city.z0, af.z0], [af.x0, af.x1, af.z1, city.z1],
    ]) if (ax1 > ax0 && az1 > az0) this.root.add(this.roads(ax0, ax1, az0, az1, city.pitch, city.x0, city.z0));

    // Halo rings around the Grid Spire and the stadium crown.
    const ringPts: number[] = [];
    const ringByColor = new Map<string, number[]>();
    for (const r of city.rings) {
      const c = CITY.colors[r.color];
      const arr = ringByColor.get(c) ?? [];
      for (let k = 0; k < 96; k++) {
        const a0 = (k / 96) * Math.PI * 2;
        const a1 = ((k + 1) / 96) * Math.PI * 2;
        arr.push(r.x + Math.cos(a0) * r.radius, r.y, r.z + Math.sin(a0) * r.radius, r.x + Math.cos(a1) * r.radius, r.y, r.z + Math.sin(a1) * r.radius);
      }
      ringByColor.set(c, arr);
    }
    void ringPts;
    for (const [c, arr] of ringByColor) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      this.root.add(new THREE.LineSegments(g, neonLineMaterial(c, 4)));
    }

    // Blinking red aviation obstruction lights (each blinks on its own phase).
    const beaconMat = new THREE.MeshBasicNodeMaterial();
    const blink: TslNode = step(0.55, fract(time.mul(0.8).add(hash(instanceIndex))));
    beaconMat.colorNode = color('#ff1030').mul(float(0.6).add(blink.mul(7)));
    this.beacons = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1.8, 0), beaconMat, city.beacons.length + 1);
    city.beacons.forEach(([x, y, z], i) => {
      const m = new THREE.Matrix4().makeTranslation(x, y, z);
      this.beacons.setMatrixAt(i, m);
      this.beaconMatrix.push(m);
      // The beacon belongs to the nearest building (by plan position).
      let best = -1;
      let bd = Infinity;
      for (const b of city.buildings) {
        const d = (b.x - x) ** 2 + (b.z - z) ** 2;
        if (d < bd) { bd = d; best = b.id; }
      }
      this.beaconGroup.push(groupOf.get(`city:${best}`) ?? -1);
    });
    const ab = airportPlan().beacon;
    this.beacons.setMatrixAt(city.beacons.length, new THREE.Matrix4().makeTranslation(ab.x, ab.y + 2, ab.z));
    this.beaconMatrix.push(new THREE.Matrix4().makeTranslation(ab.x, ab.y + 2, ab.z));
    this.beaconGroup.push(groupOf.get('airport:tower') ?? -1);
    this.beacons.computeBoundingSphere();
    this.root.add(this.beacons);

    // Light-cycle traffic: glowing streaks on every street and highway deck.
    for (const [hex, k] of [['#ff8a1f', 4], ['#00eaff', 4]] as const) {
      const mat = new THREE.MeshBasicNodeMaterial();
      mat.colorNode = color(hex).mul(k);
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.1, 0.7, 5.5), mat, TRAFFIC / 2);
      mesh.frustumCulled = false;
      this.carMeshes.push(mesh);
      this.root.add(mesh);
    }
    const rnd = mulberry32(CITY.seed + 7);
    const roads = city.roads;
    for (let i = 0; i < TRAFFIC; i++) {
      // Data highways carry most of the traffic.
      const majors = roads.map((r, k) => (r.major ? k : -1)).filter((k) => k >= 0);
      const road = rnd() < 0.7 && majors.length ? majors[Math.floor(rnd() * majors.length)] : Math.floor(rnd() * roads.length);
      const r = roads[road];
      const dir = rnd() < 0.5 ? 1 : -1;
      const lane = dir * (3 + Math.floor(rnd() * 2) * 4) * (r.y > 0 ? 0.8 : 1);
      this.cars.push({ road, lane, dir, s: r.from + rnd() * (r.to - r.from), speed: (r.y > 0 ? 28 : 14) + rnd() * 14, mesh: (i % 2) as 0 | 1, index: i >> 1 });
    }

    scene.add(this.root);
  }

  /** Road surface: dark blue blocks with a faint grid, streets with glowing lanes. */
  private roads(x0: number, x1: number, z0: number, z1: number, pitch: number, gx0: number, gz0: number): THREE.Mesh {
    const mat = new THREE.MeshBasicNodeMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    const S = CITY.street;
    const p = positionWorld;
    const lx: TslNode = fract(p.x.sub(gx0).div(pitch)).mul(pitch);
    const lz: TslNode = fract(p.z.sub(gz0).div(pitch)).mul(pitch);
    // Data highways: every Nth street glows brighter (circuits like freeways).
    const n = CITY.highwayEvery;
    const majorX: TslNode = step(fract(floor(p.x.sub(gx0).div(pitch).add(0.5)).div(n)), float(0.5 / n));
    const majorZ: TslNode = step(fract(floor(p.z.sub(gz0).div(pitch).add(0.5)).div(n)), float(0.5 / n));
    const dx: TslNode = min(lx, float(pitch).sub(lx)); // distance to the nearest N-S road centre
    const dz: TslNode = min(lz, float(pitch).sub(lz));
    const onX: TslNode = step(dx, float(S / 2)); // inside a N-S street
    const onZ: TslNode = step(dz, float(S / 2));
    const street: TslNode = max(onX, onZ);
    const centreX: TslNode = step(dx, float(0.22)).mul(float(1).sub(onZ));
    const centreZ: TslNode = step(dz, float(0.22)).mul(float(1).sub(onX));
    const dashZ: TslNode = step(fract(p.z.div(9)), float(0.5));
    const dashX: TslNode = step(fract(p.x.div(9)), float(0.5));
    const laneX: TslNode = step(abs(dx.sub(S / 4)), float(0.12)).mul(dashZ).mul(float(1).sub(onZ));
    const laneZ: TslNode = step(abs(dz.sub(S / 4)), float(0.12)).mul(dashX).mul(float(1).sub(onX));
    const curb: TslNode = max(step(abs(dx.sub(S / 2)), float(0.3)), step(abs(dz.sub(S / 2)), float(0.3))).mul(float(1).sub(street).add(0.5).min(1));
    const pad: TslNode = mix(color('#040820'), color('#0b1a5a'), gridLines(p.xz, 10, 1).mul(0.6));
    const asphalt: TslNode = color('#020311');
    let c: TslNode = mix(pad, asphalt, street);
    c = c.add(color('#ff8a1f').mul(max(centreX.mul(majorX.mul(2).add(1)), centreZ.mul(majorZ.mul(2).add(1))).mul(2.2)));
    c = c.add(color('#00eaff').mul(max(laneX.mul(majorX.mul(1.5).add(1)), laneZ.mul(majorZ.mul(1.5).add(1))).mul(1.4)));
    c = c.add(uniform(new THREE.Color('#2a5cff')).mul(curb.mul(1.8)));
    mat.colorNode = c;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2), mat);
    mesh.position.set((x0 + x1) / 2, 0.02, (z0 + z1) / 2);
    return mesh;
  }

  update(dt: number): void {
    // Fractured structures: intact meshes out; reset: back in.
    if (this.world.version !== this.seenVersion) {
      this.seenVersion = this.world.version;
      if (this.world.fractured.size === 0) {
        this.structures.showAll();
        this.beaconMatrix.forEach((m, i) => this.beacons.setMatrixAt(i, m));
      } else {
        for (const g of this.world.fractured.keys()) this.structures.hide(g);
        this.beaconGroup.forEach((g, i) => {
          if (this.world.fractured.has(g)) this.beacons.setMatrixAt(i, this._m.makeScale(0, 0, 0));
        });
      }
      this.beacons.instanceMatrix.needsUpdate = true;
    }

    // Traffic.
    const roads = cityPlan().roads;
    for (const car of this.cars) {
      const r = roads[car.road];
      car.s += car.dir * car.speed * dt;
      if (car.s > r.to) car.s = r.from;
      if (car.s < r.from) car.s = r.to;
      if (r.axis === 'x') {
        this._p.set(car.s, r.y + 0.5, r.at + car.lane);
        this._q.copy(this.turn);
      } else {
        this._p.set(r.at + car.lane, r.y + 0.5, car.s);
        this._q.identity();
      }
      this._m.compose(this._p, this._q, this._s);
      this.carMeshes[car.mesh].setMatrixAt(car.index, this._m);
    }
    for (const m of this.carMeshes) m.instanceMatrix.needsUpdate = true;
  }
}
