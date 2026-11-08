import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { MAX_RAY_SHAPES, packShapes } from './packShapes.ts';
import type { RayShape } from './shapes.ts';

// Analytic primitive tracing inspired by erichlof/THREE.js-RayTracing-Renderer (CC0).
// This implementation uses TSL so the same graph compiles for WebGPU and WebGL2.
const { Fn, If, Loop, Break, float, int, vec3, vec4, ivec2, uniform, texture,
  textureLoad, uv, normalize, dot, cross, abs, min, max, sqrt, reflect, mix, pow,
  fract, step, sin } = TSL as any;

export class RayTracer {
  readonly supported = true;
  readonly extraShapes: RayShape[] = [];
  private shapes: RayShape[] = [];
  private readonly shapeTexture: THREE.DataTexture;
  private readonly count = uniform(0, 'int');
  private readonly origin = uniform(new THREE.Vector3());
  private readonly inverseProjection = uniform(new THREE.Matrix4());
  private readonly cameraWorld = uniform(new THREE.Matrix4());
  private readonly sampleWeight = uniform(1);
  private readonly jitter = uniform(new THREE.Vector2());
  private readonly previous: any;
  private readonly material = new THREE.MeshBasicNodeMaterial();
  private readonly quad: THREE.QuadMesh;
  private readonly displayMaterial = new THREE.MeshBasicNodeMaterial();
  private readonly display: THREE.QuadMesh;
  private readonly output: any;
  private targets: THREE.RenderTarget[];
  private write = 0;
  samples = 0;
  private signature = '';
  private width = 1;
  private height = 1;
  private shapeSignature = '';

  constructor(private readonly renderer: THREE.WebGPURenderer, readonly scene: THREE.Scene,
    readonly camera: THREE.PerspectiveCamera) {
    this.shapeTexture = new THREE.DataTexture(new Float32Array(MAX_RAY_SHAPES * 16), 4, MAX_RAY_SHAPES, THREE.RGBAFormat, THREE.FloatType);
    this.shapeTexture.minFilter = this.shapeTexture.magFilter = THREE.NearestFilter;
    this.shapeTexture.generateMipmaps = false;
    this.shapeTexture.needsUpdate = true;
    this.targets = [this.target(), this.target()];
    this.previous = texture(this.targets[1].texture, uv());
    this.output = texture(this.targets[0].texture, uv());
    this.material.fragmentNode = this.shader();
    this.material.depthTest = this.material.depthWrite = false;
    this.quad = new THREE.QuadMesh(this.material);
    this.displayMaterial.fragmentNode = this.output;
    this.displayMaterial.depthTest = this.displayMaterial.depthWrite = false;
    this.display = new THREE.QuadMesh(this.displayMaterial);
  }

  private target(): THREE.RenderTarget {
    return new THREE.RenderTarget(1, 1, {type: THREE.HalfFloatType, depthBuffer: false});
  }

  setShapes(shapes: readonly RayShape[]): void { this.shapes = [...shapes]; }
  reset(): void { this.samples = 0; }

  private shader(): any {
    const load = (i: any, column: number) => textureLoad(this.shapeTexture, ivec2(column, i));
    const rotate = Fn(([v, q]: any[]) => v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2)));
    const hit = Fn(([worldO, worldD, i]: any[]) => {
      const header = load(i, 0), q = load(i, 1), dimensions = load(i, 2).xyz;
      const inverseQ = vec4(q.xyz.negate(), q.w);
      const o = rotate(worldO.sub(header.yzw), inverseQ).toVar();
      const d = rotate(worldD, inverseQ).toVar();
      const t = float(1e20).toVar(), n = vec3(0).toVar();
      const accept = (distance: any, normal: any) => { If(distance.greaterThan(0.001).and(distance.lessThan(t)), () => { t.assign(distance); n.assign(normal); }); };
      If(header.x.equal(2), () => {
        const b = dot(o,d), c = dot(o,o).sub(dimensions.x.mul(dimensions.x)), disc = b.mul(b).sub(c);
        If(disc.greaterThanEqual(0), () => {
          const near = b.negate().sub(sqrt(disc)), far = b.negate().add(sqrt(disc));
          accept(near, normalize(o.add(d.mul(near)))); accept(far, normalize(o.add(d.mul(far))));
        });
      }).ElseIf(header.x.equal(4), () => {
        If(abs(d.y).greaterThan(1e-6), () => accept(o.y.negate().div(d.y), vec3(0, d.y.lessThan(0).select(1,-1), 0)));
      }).ElseIf(header.x.equal(1), () => {
        // Clamped inverse avoids NaNs for exactly parallel rays, including rays on a face.
        const safe = d.lessThan(0).select(vec3(-1), vec3(1)).mul(max(abs(d),vec3(1e-8)));
        const a = dimensions.negate().sub(o).div(safe), b = dimensions.sub(o).div(safe);
        const lo = min(a,b), hi = max(a,b);
        const near = max(max(lo.x,lo.y),lo.z), far = min(min(hi.x,hi.y),hi.z);
        If(far.greaterThanEqual(near), () => {
          const distance = near.greaterThan(0.001).select(near,far);
          const p = o.add(d.mul(distance)).div(max(dimensions,vec3(1e-6)));
          const axis = abs(p);
          const normal = vec3(0).toVar();
          If(axis.x.greaterThanEqual(axis.y).and(axis.x.greaterThanEqual(axis.z)),()=>normal.x.assign(p.x.lessThan(0).select(-1,1)))
            .ElseIf(axis.y.greaterThanEqual(axis.z),()=>normal.y.assign(p.y.lessThan(0).select(-1,1)))
            .Else(()=>normal.z.assign(p.z.lessThan(0).select(-1,1)));
          accept(distance, normal);
        });
      }).Else(() => {
        const a = d.x.mul(d.x).add(d.z.mul(d.z));
        const b = o.x.mul(d.x).add(o.z.mul(d.z));
        const c = o.x.mul(o.x).add(o.z.mul(o.z)).sub(dimensions.x.mul(dimensions.x));
        const disc = b.mul(b).sub(a.mul(c));
        If(a.greaterThan(1e-8).and(disc.greaterThanEqual(0)), () => {
          const roots = [b.negate().sub(sqrt(disc)).div(a), b.negate().add(sqrt(disc)).div(a)];
          for (const distance of roots) {
            const p=o.add(d.mul(distance));
            If(abs(p.y).lessThanEqual(dimensions.y),()=>accept(distance,normalize(vec3(p.x,0,p.z))));
          }
        });
        If(abs(d.y).greaterThan(1e-6),()=>{
          for (const side of [-1,1]) {
            const distance=dimensions.y.mul(side).sub(o.y).div(d.y), p=o.add(d.mul(distance));
            If(dot(p.xz,p.xz).lessThanEqual(dimensions.x.mul(dimensions.x)),()=>accept(distance,vec3(0,side,0)));
          }
        });
      });
      return vec4(rotate(n,q),t);
    });
    return Fn(() => {
      const clip = uv().add(this.jitter).mul(2).sub(1);
      const view = this.inverseProjection.mul(vec4(clip.x,clip.y.negate(),1,1));
      const direction = normalize(this.cameraWorld.mul(vec4(normalize(view.xyz.div(view.w)),0)).xyz).toVar();
      const rayOrigin = this.origin.toVar();
      const radiance = vec3(0).toVar(), throughput = vec3(1).toVar();
      const light = normalize(vec3(-0.4,0.8,0.25));
      Loop(3, () => {
        const closest = float(1e19).toVar(), normal = vec3(0).toVar(), index = int(-1).toVar();
        Loop({start:int(0),end:this.count,type:'int',condition:'<'},({i}: any)=>{
          const h=hit(rayOrigin,direction,i);
          If(h.w.lessThan(closest),()=>{closest.assign(h.w);normal.assign(h.xyz);index.assign(i);});
        });
        If(index.lessThan(0),()=>{
          radiance.addAssign(throughput.mul(mix(vec3(0.06,0.006,0.13),vec3(0.004,0.001,0.015),max(direction.y,0))));
          Break();
        });
        const p=rayOrigin.add(direction.mul(closest)).toVar();
        const header=load(index,0), q=load(index,1), size=load(index,2), material=load(index,3);
        const local=rotate(p.sub(header.yzw),vec4(q.xyz.negate(),q.w));
        const edge=float(0).toVar();
        If(header.x.equal(4),()=>{
          const grid=abs(fract(p.xz.div(20).add(0.5)).sub(0.5));
          edge.assign(float(1).sub(step(0.012,min(grid.x,grid.y))));
        }).ElseIf(header.x.equal(1),()=>{
          const near=abs(abs(local).sub(size.xyz));
          const pair=min(max(near.x,near.y),min(max(near.x,near.z),max(near.y,near.z)));
          edge.assign(float(1).sub(step(0.035,pair)));
        }).Else(()=>{
          const stripes=abs(sin(local.y.mul(10))).mul(abs(sin(local.x.mul(10))));
          edge.assign(float(1).sub(step(0.12,stripes)));
        });
        const shadow=float(1).toVar();
        Loop({start:int(0),end:this.count,type:'int',condition:'<'},({i}: any)=>{
          const blocker=hit(p.add(normal.mul(0.01)),light,i);
          If(blocker.w.lessThan(5000),()=>{shadow.assign(0.12);Break();});
        });
        const diffuse=max(dot(normal,light),0).mul(shadow).mul(0.35).add(0.05);
        const fresnel=float(0.08).add(pow(float(1).sub(max(dot(direction.negate(),normal),0)),5).mul(0.92));
        radiance.addAssign(throughput.mul(material.xyz).mul(diffuse.mul(0.1).add(edge.mul(size.w))));
        throughput.mulAssign(mix(vec3(0.15),material.xyz.mul(0.25).add(0.15),0.5).mul(fresnel));
        rayOrigin.assign(p.add(normal.mul(0.01)));
        direction.assign(reflect(direction,normal));
      });
      return vec4(mix(this.previous.rgb,radiance,this.sampleWeight),1);
    })();
  }

  render(): void {
    const destination=this.renderer.getRenderTarget();
    const size=destination ? new THREE.Vector2(destination.width,destination.height) : this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if(size.x!==this.width || size.y!==this.height) {
      this.width=size.x; this.height=size.y;
      for(const target of this.targets) target.setSize(this.width,this.height);
      this.reset();
    }
    this.camera.updateMatrixWorld();
    const cameraSignature=this.camera.matrixWorld.elements.join(',')+';'+this.camera.projectionMatrix.elements.join(',');
    if(cameraSignature!==this.signature) {this.signature=cameraSignature;this.reset();}
    const packed=packShapes([...this.shapes,...this.extraShapes],this.camera.getWorldPosition(new THREE.Vector3()));
    const signature=Array.from(packed.data).join(',');
    if(signature!==this.shapeSignature) {
      this.shapeSignature=signature;
      (this.shapeTexture.image.data as Float32Array).set(packed.data);
      this.shapeTexture.needsUpdate=true; this.reset();
    }
    this.count.value=packed.count;
    this.origin.value.copy(this.camera.getWorldPosition(new THREE.Vector3()));
    this.inverseProjection.value.copy(this.camera.projectionMatrixInverse);
    this.cameraWorld.value.copy(this.camera.matrixWorld);
    const n=this.samples+1;
    this.sampleWeight.value=1/n;
    // Deterministic subpixel sequence; accumulation resets on camera/geometry/size changes.
    this.jitter.value.set(((n*0.754877666)%1-0.5)/this.width,((n*0.569840296)%1-0.5)/this.height);
    this.previous.value=this.targets[1-this.write].texture;
    try {
      this.renderer.setRenderTarget(this.targets[this.write]);
      this.quad.render(this.renderer);
      this.output.value=this.targets[this.write].texture;
      this.renderer.setRenderTarget(destination);
      this.display.render(this.renderer);
      this.samples=n; this.write=1-this.write;
    } finally {this.renderer.setRenderTarget(destination);}
  }

  dispose(): void {
    this.shapeTexture.dispose(); this.targets.forEach(t=>t.dispose());
    this.material.dispose(); this.displayMaterial.dispose();
  }
}
