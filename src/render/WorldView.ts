import * as THREE from 'three/webgpu';
import { abs, cameraPosition, clamp, color, dot, float, fwidth, max, normalize, positionWorld, pow, smoothstep, step, uniform, uv, vec2, vec3 } from 'three/tsl';
import { COAST, PLANET, RUNWAYS, type LandingSite } from '../sim/layout.ts';
import { AtmosphereController, paintedSkyNode, SKY } from './arch/SkyAtmosphere.ts';
import { CITY_LIGHTS_FROM, CITY_LIGHTS_GAIN, GLOBE_VIEW, GLOBE_VIEW_ALT, cityGroundNode } from './cityGround.ts';
import { curveOrigin, flatWorld } from './curvature.ts';
import { GRID_SKY, NEON, SKY_PLANET, glow, type TslNode } from './neon.ts';

const SUN_DIR = new THREE.Vector3(-0.45, 0.8, 0.35).normalize();

/** Anti-aliased band mask (0..1) for |x - centre| < halfWidth, in the units of `x`. */
function band(x: TslNode, centre: number, halfWidth: number): TslNode {
  const d: TslNode = abs(x.sub(centre)).sub(halfWidth);
  return float(1).sub(smoothstep(float(0), max(fwidth(x), 1e-4), d));
}

/**
 * The world's backdrop in the 1982 language: the painted sky dome (its gradient and luminous
 * horizon band follow the region below, see AtmosphereController), regional haze, the planet's
 * electronic ground (cityGround.ts) and the runways as lit strips. The Outlands' landforms and
 * the architecture are drawn by their own streaming views (render/arch). Exposes the live
 * colours WeatherView dims under cloud.
 */
export class WorldView {
  readonly sun: THREE.DirectionalLight;
  private readonly sky: THREE.Mesh;
  readonly hemi: THREE.HemisphereLight;
  /** Sky colours (uniform-backed; WeatherView dims them). */
  readonly horizon = SKY.horizon;
  readonly zenith = SKY.zenith;
  readonly upper = SKY.upper;
  readonly band = SKY.band;
  /** Kept for compatibility: there is no sun disc in the digital sky. */
  readonly skySun = new THREE.Color(0, 0, 0);
  /** Ground fill and grid line colours (HDR; uniforms). */
  readonly groundBase = new THREE.Color('#05020c');
  readonly gridColor = glow(GRID_SKY.grid, 2.4);
  /** Runway surface and marking colours (HDR; uniforms). */
  readonly runwayBase = new THREE.Color('#050a1c');
  readonly runwayEdge = glow(NEON.cyan, 1.3);
  readonly runwayCentre = glow('#ffb347', 1.4);
  groundMat!: THREE.MeshBasicNodeMaterial;
  runwayMat!: THREE.MeshBasicNodeMaterial;
  private readonly ground: THREE.Mesh;
  /** Region-driven clear-sky atmosphere. */
  readonly atmosphere = new AtmosphereController();
  private readonly oceanCut = uniform(1);

  constructor(scene: THREE.Scene, renderer: THREE.WebGPURenderer | null, opts: { runways?: boolean; ocean?: boolean } = {}) {
    void renderer;
    this.scene = scene;
    scene.background = this.horizon;
    scene.fog = new THREE.FogExp2(this.atmosphere.clear.haze.clone(), 1.978 / 14000);

    const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    skyMat.colorNode = paintedSkyNode();
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(9500, 48, 24), skyMat);
    this.sky.renderOrder = -1;
    this.sky.userData.noCurve = true;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // Lights only touch the craft and any standard materials (the architecture shades itself).
    this.hemi = new HemisphereLightBlue();
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#cfe6ff', 0.9);
    this.sun.castShadow = false;
    scene.add(this.sun, this.sun.target);

    this.groundMat = new THREE.MeshBasicNodeMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 });
    // From altitude a shell of air hazes the ground toward the limb.
    const centre: TslNode = vec3(curveOrigin.x, -PLANET.radius, curveOrigin.z);
    const normal: TslNode = normalize(positionWorld.sub(centre));
    const toEye: TslNode = normalize(cameraPosition.sub(positionWorld));
    const graze: TslNode = float(1).sub(clamp(dot(normal, toEye), 0, 1));
    const rim: TslNode = pow(graze, 6);
    const haze: TslNode = (color('#0a1c5c') as TslNode).mul(pow(graze, 2).mul(0.35))
      .add((color(GRID_SKY.band) as TslNode).mul(rim.mul(0.55)))
      .add((color(NEON.cyan) as TslNode).mul(pow(graze, 18).mul(0.6)));
    this.groundMat.colorNode = cityGroundNode().add(haze.mul(SKY_PLANET.shell));
    const sx: TslNode = wrapX(flatWorld.x);
    const inOcean: TslNode = step(float(COAST.x), sx).mul(step(sx, float(COAST.x + COAST.width)));
    this.groundMat.opacityNode = float(1).sub(inOcean.mul(this.oceanCut));
    this.groundMat.alphaTest = 0.5;
    this.hasOcean = opts.ocean !== false;
    this.ground = new THREE.Mesh(groundDisc(PLANET.radius * Math.PI * 0.97), this.groundMat);
    this.ground.frustumCulled = false;
    scene.add(this.ground);

    if (opts.runways !== false) for (const r of RUNWAYS) scene.add(this.runway(r));
  }

  /** One runway: dark strip, cyan edges, threshold bars, aiming points, amber centreline. */
  private runway(r: LandingSite): THREE.Mesh {
    const { length, width } = r;
    const mat = new THREE.MeshBasicNodeMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    this.runwayMat ??= mat;
    const p = uv().mul(vec2(width, length));
    const x = p.x, z = p.y;
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
    const base: TslNode = uniform(this.runwayBase);
    mat.colorNode = base.add(uniform(this.runwayEdge).mul(marks)).add(uniform(this.runwayCentre).mul(centre));
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, length, 1, Math.ceil(length / 40)), mat);
    mesh.rotation.x = -Math.PI / 2;
    if (r.axis === 'x') mesh.rotation.z = Math.PI / 2;
    mesh.position.set(r.x, 0.03, r.z);
    return mesh;
  }

  /** Keep the sky and the ground disc on the camera, the atmosphere on the region below. */
  update(camera: THREE.Camera, focus: THREE.Vector3, dt = 1 / 60): void {
    const alt = camera.position.y;
    const globe = alt > GLOBE_VIEW_ALT;
    GLOBE_VIEW.on = globe;
    CITY_LIGHTS_FROM.value = globe ? 1 : 6000;
    this.oceanCut.value = globe || !this.hasOcean ? 0 : 1;
    CITY_LIGHTS_GAIN.value = 1 + 0.25 * Math.min(1, Math.max(0, (alt - 3000) / 20000));
    this.atmosphere.update(dt, camera.position.x, camera.position.z);
    // Clear-weather sky (WeatherView, when present, dims it after this).
    const c = this.atmosphere.clear;
    this.horizon.copy(c.horizon);
    this.zenith.copy(c.zenith);
    this.upper.copy(c.upper);
    this.band.copy(c.band);
    const fog = this.scene?.fog as THREE.FogExp2 | undefined;
    if (fog && !this.weatherDriven) {
      fog.color.copy(c.haze);
      fog.density = (1.978 / c.visibility) * Math.exp(-Math.max(0, alt) / 2500);
    }
    this.sky.position.copy(camera.position);
    this.ground.position.set(camera.position.x, 0, camera.position.z);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(SUN_DIR, 300);
  }

  /** False: no ocean mesh, the ground draws the sea itself. */
  private hasOcean = true;
  /** Set when a WeatherView owns the fog. */
  weatherDriven = false;
  scene: THREE.Scene | null = null;
}

class HemisphereLightBlue extends THREE.HemisphereLight {
  constructor() {
    super('#4a7cff', '#0a1840', 0.6);
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
