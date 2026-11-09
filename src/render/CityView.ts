import * as THREE from 'three/webgpu';
import { color, float, fract, hash, instanceIndex, step, time } from 'three/tsl';
import { CITY } from '../sim/layout.ts';
import { airportPlan } from '../world/Airport.ts';
import { cityPlan } from '../world/City.ts';
import type { StaticWorld } from '../world/staticWorld.ts';
import { worldStructures } from '../world/structures.ts';
import { neonLineMaterial, type TslNode } from './neon.ts';
import { StructuresView, type StructurePiece } from './StructuresView.ts';

/**
 * The neon city (and the airport's buildings): every destructible structure drawn by one
 * StructuresView, plus city dressing: spires, halo rings and blinking red aviation lights
 * (light-cycle traffic rides the streets in TrafficView). When a
 * structure fractures, its intact meshes hide (the block grid takes over in TownView); a reset
 * shows them again.
 */
export class CityView {
  readonly root = new THREE.Group();
  private readonly structures: StructuresView;
  private seenVersion = -1;
  private readonly beacons: THREE.InstancedMesh;
  private readonly beaconGroup: number[] = [];
  private readonly beaconMatrix: THREE.Matrix4[] = [];
  private readonly _m = new THREE.Matrix4();

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

    scene.add(this.root);
  }

  update(_dt: number): void {
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
  }
}
