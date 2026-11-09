import * as THREE from 'three/webgpu';
import { abs, float, fwidth, max, smoothstep, step, uniform, uv, vec2 } from 'three/tsl';
import { COAST, PLANET, RUNWAYS, type LandingSite } from '../sim/layout.ts';
import { cityGroundNode } from './cityGround.ts';
import { flatWorld } from './curvature.ts';
import { GRID_SKY, NEON, glow, synthSkyNode, type TslNode } from './neon.ts';

const HORIZON = new THREE.Color(GRID_SKY.horizon);
const ZENITH = new THREE.Color(GRID_SKY.zenith);
const SUN_DIR = new THREE.Vector3(-0.45, 0.8, 0.35).normalize();
/** The striped synthwave sun sits on the horizon straight down the runway (spawn faces -Z). */
const SKY_SUN_DIR = new THREE.Vector3(0, 0.17, -1).normalize();

/** Deterministic PRNG so scenery is identical every load (and for every racer). */

/** Anti-aliased band mask (0..1) for |x - centre| < halfWidth, in the units of `x`. */
function band(x: TslNode, centre: number, halfWidth: number): TslNode {
  const d: TslNode = abs(x.sub(centre)).sub(halfWidth);
  return float(1).sub(smoothstep(float(0), max(fwidth(x), 1e-4), d));
}

/**
 * Static scenery in the neon / synthwave style: a glowing cyan grid to the horizon, a dark
 * gradient sky with a striped sun, the runway as neon outlines with a magenta centreline,
 * wireframe hangars, tower and trees. Exposes the live colours WeatherView drives.
 */
export class WorldView {
  readonly sun: THREE.DirectionalLight;
  private readonly sky: THREE.Mesh;
  readonly hemi: THREE.HemisphereLight;
  /** Sky gradient colours (uniforms: change them to dim the sky). */
  readonly horizon = HORIZON.clone();
  readonly zenith = ZENITH.clone();
  /** Brightness of the sky sun (r = g = b; 0 hides it, e.g. under an overcast deck). */
  /** No sun inside the Grid: the sky is a dark digital dome. */
  readonly skySun = new THREE.Color(0, 0, 0);
  /** Ground fill and grid line colours (HDR; uniforms). */
  readonly groundBase = new THREE.Color('#05020c');
  readonly gridColor = glow(GRID_SKY.grid, 2.4);
  /** Runway surface and marking colours (HDR; uniforms). */
  readonly runwayBase = new THREE.Color('#0a0716');
  readonly runwayEdge = glow(NEON.cyan, 2.4);
  readonly runwayCentre = glow(NEON.magenta, 2.6);
  groundMat!: THREE.MeshBasicNodeMaterial;
  runwayMat!: THREE.MeshBasicNodeMaterial;
  private readonly ground: THREE.Mesh;

  constructor(scene: THREE.Scene, renderer: THREE.WebGPURenderer) {
    void renderer;
    scene.background = this.horizon;
    // Haze. FogExp2 uses exp(-(ρd)²); ρ = √3.912 / V puts the 2% contrast threshold
    // (Koschmieder's definition of visibility) at distance V. Tinted the horizon purple.
    scene.fog = new THREE.FogExp2(HORIZON.clone(), 1.978 / 15000);

    // Sky dome (follows the camera): gradient, horizon glow band, striped sun.
    const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    skyMat.colorNode = synthSkyNode(uniform(this.horizon), uniform(this.zenith), {
      sunDir: SKY_SUN_DIR,
      sunRadius: 0.2,
      sun: uniform(this.skySun),
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(9500, 48, 24), skyMat);
    this.sky.renderOrder = -1;
    this.sky.userData.noCurve = true;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // Dim, coloured light: only the near-black fills are lit, giving them a hint of shape.
    this.hemi = new THREE.HemisphereLight('#6a3cff', '#ff2bd6', 0.5);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#ff9be8', 0.9);
    this.sun.castShadow = false; // unlit neon ground: shadows would not show
    scene.add(this.sun, this.sun.target);

    // Ground: dark plane with an anti-aliased cyan grid (10 m minor, 100 m major).
    this.groundMat = new THREE.MeshBasicNodeMaterial({
      // Pushed back slightly in depth so the runway never z-fights with it at distance.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 4,
    });
    // Streets everywhere on the seamless block grid, and city lights far away (cityGround.ts).
    this.groundMat.colorNode = cityGroundNode();
    // The planet's ground: a disc that follows the camera, its rings widening with distance out
    // to just short of the antipode, so the curvature bend has vertices to bend. The ocean band
    // is cut out (the sea surface sits below the land level).
    const sea: TslNode = wrapX(flatWorld.x);
    this.groundMat.opacityNode = float(1).sub(step(float(COAST.x), sea).mul(step(sea, float(COAST.x + COAST.width))));
    this.groundMat.alphaTest = 0.5;
    this.ground = new THREE.Mesh(groundDisc(PLANET.radius * Math.PI * 0.97), this.groundMat);
    this.ground.frustumCulled = false;
    scene.add(this.ground);

    // Runway (visual only; physically the ground is flat everywhere): dark strip, neon edge
    // lines, threshold bars and aiming points, dashed magenta centreline.
    for (const r of RUNWAYS) scene.add(this.runway(r));

    this.addScenery(scene);
  }

  /** One runway: dark strip, neon edges, threshold bars, aiming points, dashed magenta centreline. */
  private runway(r: LandingSite): THREE.Mesh {
    const { length, width } = r;
    const mat = new THREE.MeshBasicNodeMaterial({
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    this.runwayMat ??= mat;
    // Metres across (0..width) and along (0..length) the strip.
    const p = uv().mul(vec2(width, length));
    const x = p.x;
    const z = p.y;
    const edges = band(x, 1.0, 0.45).add(band(x, width - 1.0, 0.45));
    const dash = float(1).sub(step(float(0.6), z.sub(70).div(50).fract())).mul(step(70, z)).mul(step(z, length - 70));
    const centre = band(x, width / 2, 0.45).mul(dash);
    let keys: TslNode = float(0);
    for (let i = 0; i < 6; i++) {
      const xk = 2.5 + i * 1.8 + 0.6;
      keys = keys.add(band(x, xk, 0.6)).add(band(x, width - xk, 0.6));
    }
    const nearEnd = band(z, 21, 15).add(band(z, length - 21, 15));
    const aim = band(x, width / 2 - 7, 2).add(band(x, width / 2 + 7, 2)).mul(band(z, 322.5, 22.5).add(band(z, length - 322.5, 22.5)));
    const ends = band(z, 1.2, 0.6).add(band(z, length - 1.2, 0.6));
    const marks: TslNode = edges.add(keys.mul(nearEnd).mul(0.1)).add(aim.mul(0.14)).add(ends).min(1);
    const surface: TslNode = uniform(this.runwayBase);
    mat.colorNode = surface.add(uniform(this.runwayEdge).mul(marks)).add(uniform(this.runwayCentre).mul(centre));
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, length, 1, Math.ceil(length / 40)), mat);
    mesh.rotation.x = -Math.PI / 2;
    if (r.axis === 'x') mesh.rotation.z = Math.PI / 2;
    mesh.position.set(r.x, 0.03, r.z);
    return mesh;
  }

  private addScenery(_scene: THREE.Scene): void {
    // The Grid covers the land: buildings (CityView) replace the old scattered trees.
  }

  /** Keep the sky and the ground disc centred on the camera and the light around the focus point. */
  update(camera: THREE.Camera, focus: THREE.Vector3): void {
    this.sky.position.copy(camera.position);
    this.ground.position.set(camera.position.x, 0, camera.position.z);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(SUN_DIR, 300);
  }
}

/** x wrapped into [-C/2, C/2) in a shader (the ocean band repeats every circumference). */
function wrapX(x: TslNode): TslNode {
  const c = PLANET.circumference;
  return x.sub(x.add(c / 2).div(c).floor().mul(c));
}

/** A flat disc (y = 0) of exponentially widening rings: dense near the centre, sparse far out. */
function groundDisc(radius: number): THREE.BufferGeometry {
  const rings = 120;
  const segs = 160;
  const r0 = 2;
  const k = Math.pow(radius / r0, 1 / (rings - 1));
  const pos: number[] = [0, 0, 0];
  for (let i = 0; i < rings; i++) {
    const r = r0 * Math.pow(k, i);
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = 1 + i * segs + j;
      const b = 1 + i * segs + ((j + 1) % segs);
      const c = a + segs;
      const d = b + segs;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
