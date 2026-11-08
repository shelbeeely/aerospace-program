import { Quaternion, Vector3 } from 'three';
import { intersectShape, type RayShape } from '../src/render/raytrace/shapes.ts';
import { MAX_RAY_SHAPES, packShapes } from '../src/render/raytrace/packShapes.ts';
let checks = 0;
function check(ok: boolean, name: string) { if (!ok) throw new Error(name); console.log(`PASS ${name}`); checks++; }
const shape = (kind: RayShape['kind']): RayShape => ({kind, position:new Vector3(), rotation:new Quaternion(), size:new Vector3(1,1,1),color:new Vector3(0,1,1)});
for (const kind of ['box','sphere','cylinder'] as const) {
  const s = shape(kind);
  const hit = intersectShape(new Vector3(0,0,3),new Vector3(0,0,-1),s);
  check(!!hit && Math.abs(hit.distance-2)<1e-6 && hit.normal.z > 0.99, `${kind} exterior hit`);
  const inside = intersectShape(new Vector3(),new Vector3(1,0,0),s);
  check(!!inside && Math.abs(inside.distance-1)<1e-6, `${kind} inside exit`);
  check(!intersectShape(new Vector3(3,3,3),new Vector3(0,0,1),s), `${kind} miss`);
}
const cylinder=shape('cylinder');
check(Math.abs(intersectShape(new Vector3(0,3,0),new Vector3(0,-1,0),cylinder)!.distance-2)<1e-6,'cylinder cap');
const faceBox=shape('box');
check(Math.abs(intersectShape(new Vector3(1,0,3),new Vector3(0,0,-1),faceBox)!.distance-2)<1e-6,'box face-parallel boundary hit');
check(!intersectShape(new Vector3(1.001,0,3),new Vector3(0,0,-1),faceBox),'box parallel outside slab miss');
check(Math.abs(intersectShape(new Vector3(1,1,3),new Vector3(0,0,-1),faceBox)!.distance-2)<1e-6,'box edge-parallel boundary hit');
const box=shape('box'); box.size.set(2,1,0.5); box.rotation.setFromAxisAngle(new Vector3(0,1,0),Math.PI/2);
check(Math.abs(intersectShape(new Vector3(0,0,3),new Vector3(0,0,-1),box)!.distance-1)<1e-6,'oriented box');
const plane=shape('plane');
check(intersectShape(new Vector3(0,2,0),new Vector3(0,-1,0),plane)!.distance===2,'plane hit');
check(!intersectShape(new Vector3(0,2,0),new Vector3(1,0,0),plane),'plane parallel miss');
check(!intersectShape(new Vector3(2,2,0),new Vector3(0,-1,0),plane),'finite plane outside miss');
check(!!intersectShape(new Vector3(1,2,1),new Vector3(0,-1,0),plane),'finite plane boundary hit');
plane.size.set(0,0,0);
check(!!intersectShape(new Vector3(2000,2,2000),new Vector3(0,-1,0),plane),'zero extents preserve infinite plane');
const candidates=Array.from({length:300},(_,i)=>{const s=shape('sphere');s.position.x=300-i;return s;});
const packed=packShapes(candidates,new Vector3());
check(packed.count===MAX_RAY_SHAPES && packed.shapes[0].position.x===1,'capacity and nearest selection');
check(packed.data.length===4096 && packed.data[0]===2 && packed.data[1]===1 && packed.data[7]===1,'RGBA32F layout');
check(packShapes(candidates,new Vector3(),0).count===0,'zero capacity');
console.log(`${checks} ray-trace reference checks passed`);
