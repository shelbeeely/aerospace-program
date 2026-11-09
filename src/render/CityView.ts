import * as THREE from 'three/webgpu';
import { color, float, fract, hash, instanceIndex, step, time } from 'three/tsl';
import { CITY } from '../sim/layout.ts';
import { airportPlan } from '../world/Airport.ts';
import { cityPlan, mulberry32 } from '../world/City.ts';
import type { StaticWorld } from '../world/staticWorld.ts';
import { worldStructures } from '../world/structures.ts';
import { neonLineMaterial, type TslNode } from './neon.ts';
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

    // Streets are drawn by the planet ground (cityGround.ts) everywhere, seamlessly.

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
