import * as THREE from 'three/webgpu';
import { abs, float, fwidth, max, smoothstep, step, uniform, uv, vec2 } from 'three/tsl';
import { LAYOUT } from '../sim/layout.ts';
import { NEON, glow, groundGridNode, mergeLines, neonFillMaterial, neonize, neonLineMaterial, synthSkyNode, type TslNode } from './neon.ts';

const HORIZON = new THREE.Color(NEON.horizon);
const ZENITH = new THREE.Color(NEON.zenith);
const SUN_DIR = new THREE.Vector3(-0.45, 0.8, 0.35).normalize();
/** The striped synthwave sun sits on the horizon straight down the runway (spawn faces -Z). */
const SKY_SUN_DIR = new THREE.Vector3(0, 0.17, -1).normalize();

/** Deterministic PRNG so scenery is identical every load (and for every racer). */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  readonly skySun = new THREE.Color(1, 1, 1);
  /** Ground fill and grid line colours (HDR; uniforms). */
  readonly groundBase = new THREE.Color('#05020c');
  readonly gridColor = glow(NEON.cyan, 2.2);
  /** Runway surface and marking colours (HDR; uniforms). */
  readonly runwayBase = new THREE.Color('#0a0716');
  readonly runwayEdge = glow(NEON.cyan, 2.4);
  readonly runwayCentre = glow(NEON.magenta, 2.6);
  groundMat!: THREE.MeshBasicNodeMaterial;
  runwayMat!: THREE.MeshBasicNodeMaterial;

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
    this.groundMat.colorNode = groundGridNode(uniform(this.groundBase), uniform(this.gridColor), {
      minor: 10,
      major: 100,
      fade: 6000,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(LAYOUT.groundSize, LAYOUT.groundSize), this.groundMat);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // Runway (visual only; physically the ground is flat everywhere): dark strip, neon edge
    // lines, threshold bars and aiming points, dashed magenta centreline.
    const { length, width, centerZ } = LAYOUT.runway;
    this.runwayMat = new THREE.MeshBasicNodeMaterial({
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    // Metres across (0..width) and along (0..length) the strip.
    const p = uv().mul(vec2(width, length));
    const x = p.x;
    const z = p.y;
    const edges = band(x, 1.0, 0.45).add(band(x, width - 1.0, 0.45));
    const dash = float(1).sub(step(float(0.6), z.sub(70).div(50).fract())).mul(step(70, z)).mul(step(z, length - 70));
    const centre = band(x, width / 2, 0.45).mul(dash);
    // Threshold "piano keys" and aiming points at both ends.
    let keys: TslNode = float(0);
    for (let i = 0; i < 6; i++) {
      const xk = 2.5 + i * 1.8 + 0.6;
      keys = keys.add(band(x, xk, 0.6)).add(band(x, width - xk, 0.6));
    }
    const nearEnd = band(z, 21, 15).add(band(z, length - 21, 15));
    const aim = band(x, width / 2 - 7, 2).add(band(x, width / 2 + 7, 2)).mul(band(z, 322.5, 22.5).add(band(z, length - 322.5, 22.5)));
    const ends = band(z, 1.2, 0.6).add(band(z, length - 1.2, 0.6)); // cross bars at the very ends
    const marks: TslNode = edges.add(keys.mul(nearEnd).mul(0.1)).add(aim.mul(0.14)).add(ends).min(1);
    const surface: TslNode = uniform(this.runwayBase);
    this.runwayMat.colorNode = surface.add(uniform(this.runwayEdge).mul(marks)).add(uniform(this.runwayCentre).mul(centre));
    const runway = new THREE.Mesh(new THREE.PlaneGeometry(width, length), this.runwayMat);
    runway.rotation.x = -Math.PI / 2;
    runway.position.set(0, 0.03, centerZ);
    scene.add(runway);

    this.addScenery(scene);
  }

  private addScenery(scene: THREE.Scene): void {
    const rnd = mulberry32(42);
    const { width, centerZ, length } = LAYOUT.runway;
    const fill = neonFillMaterial();

    // Hangars next to the runway for scale: dark boxes with magenta outlines.
    const hangarGeo = new THREE.BoxGeometry(24, 9, 20);
    for (let i = 0; i < 4; i++) {
      const h = new THREE.Mesh(hangarGeo, fill);
      h.add(neonize(hangarGeo, NEON.magenta));
      h.position.set(-width / 2 - 70, 4.5, LAYOUT.spawnZ - 60 - i * 34);
      scene.add(h);
    }
    // Tower: cyan wireframe.
    const towerGeo = new THREE.CylinderGeometry(2.5, 3, 18, 8);
    const tower = new THREE.Mesh(towerGeo, fill);
    tower.add(neonize(towerGeo, NEON.cyan));
    tower.position.set(-width / 2 - 60, 9, LAYOUT.spawnZ - 220);
    scene.add(tower);

    // Trees: instanced dark cones (they occlude) plus one merged violet wireframe for all of them.
    const count = 1500;
    const treeGeo = new THREE.ConeGeometry(2.2, 9, 6);
    treeGeo.translate(0, 4.5, 0);
    const trees = new THREE.InstancedMesh(treeGeo, fill, count);
    const treeEdges = new THREE.EdgesGeometry(treeGeo, 1);
    const lineParts: { geo: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const p = new THREE.Vector3();
    let n = 0;
    while (n < count) {
      // Clustered: pick a cluster centre, scatter around it.
      const cx = (rnd() - 0.5) * 6000;
      const cz = (rnd() - 0.5) * 6000;
      const clusterSize = 5 + Math.floor(rnd() * 25);
      for (let k = 0; k < clusterSize && n < count; k++) {
        p.set(cx + (rnd() - 0.5) * 120, 0, cz + (rnd() - 0.5) * 120);
        const nearRunway = Math.abs(p.x) < 150 && Math.abs(p.z - centerZ) < length / 2 + 400;
        if (nearRunway) continue;
        const s = 0.6 + rnd() * 0.9;
        sc.set(s, s * (0.8 + rnd() * 0.6), s);
        const m = new THREE.Matrix4().compose(p, q, sc);
        trees.setMatrixAt(n++, m);
        lineParts.push({ geo: treeEdges, matrix: m });
      }
    }
    scene.add(trees);
    const treeLines = new THREE.LineSegments(mergeLines(lineParts), neonLineMaterial(NEON.purple, 1.8));
    treeEdges.dispose();
    scene.add(treeLines);
  }

  /** Keep the sky centred on the camera and the light around the focus point. */
  update(camera: THREE.Camera, focus: THREE.Vector3): void {
    this.sky.position.copy(camera.position);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(SUN_DIR, 300);
  }
}
