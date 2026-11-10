import * as THREE from 'three/webgpu';
import {
  abs, cameraPosition, clamp, color, dot, exp, float, floor, Fn, fract, hash, If, Loop, max, min, mix, normalize, pow, screenCoordinate,
  smoothstep, texture, texture3D, time, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { flatWorld } from '../curvature.ts';
import type { TslNode } from '../neon.ts';
import { ARCH_PARAMS } from './ArchitecturalMaterialLibrary.ts';
import { SKY } from './SkyAtmosphere.ts';

/**
 * Volumetric clouds, after Leonardo Soares Gonçalves's "Universal Planetary Volumetric Clouds &
 * Scattering Atmosphere Engine" (MIT, github.com/leoawen/volumetric_cloud_atmosphere_scattering),
 * rewritten for this renderer (WebGPU/WebGL2 through TSL) and restyled for the 1982 digital
 * world:
 *
 * - the same technique: a baked, tiling Perlin-Worley 3D noise texture shapes the cloud; a
 *   weather map sets coverage and how tall cells grow; the view ray is marched through the
 *   cloud slab with jittered steps, front-to-back compositing, a one-sample shadow toward the
 *   light (Beer's law), a powder term on thin edges and a forward-scattering lobe;
 * - the weather map is the simulation's own cloud field (Atmosphere.cellValue, painted by
 *   WeatherView), so the clouds you see are the ones that rain, ice and buffet the craft;
 * - stylised, not photoreal: light is posterised into a few airbrush bands between the region's
 *   deep sky colour and pale blue-white tops, edges facing the light catch the horizon band's
 *   colour, and a faint survey grid is traced on cloud bases (the computer drew these clouds).
 */
export const CLOUD_PARAMS = {
  /** Slab: base and top altitude (m) and the weather map's centre (x, z) and span (m). */
  base: uniform(1200),
  top: uniform(2500),
  center: uniform(new THREE.Vector2()),
  span: uniform(16000),
  /** Overall coverage scale (the map already holds the cells' coverage) and storm darkening. */
  coverage: uniform(1),
  storm: uniform(0),
  /** March steps (quality) and noise scale (cycles per metre). */
  steps: uniform(36),
  scale: uniform(1 / 1800),
  detailScale: uniform(1 / 380),
  absorption: uniform(5),
  /** Posterisation bands of the lighting (0 = smooth). */
  bands: uniform(4),
  wind: uniform(new THREE.Vector2(6, 2)),
};

const N = 40;

/** Tiling 3D noise: R = Perlin-Worley base shape, G = Worley detail (bytes). */
function bakeNoise(): THREE.Data3DTexture {
  const data = new Uint8Array(N * N * N * 4);
  const h3 = (x: number, y: number, z: number, s: number) => {
    let h = Math.imul(x * 73856093 ^ y * 19349663 ^ z * 83492791 ^ s * 2654435761, 0x27d4eb2d);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
    return (h >>> 0) / 4294967296;
  };
  const m = (v: number, p: number) => ((v % p) + p) % p;
  /** Tiling value-gradient noise at frequency f (cells per tile). */
  const perlin = (x: number, y: number, z: number, f: number, s: number) => {
    const X = x * f, Y = y * f, Z = z * f;
    const xi = Math.floor(X), yi = Math.floor(Y), zi = Math.floor(Z);
    const xf = X - xi, yf = Y - yi, zf = Z - zi;
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    const u = fade(xf), v = fade(yf), w = fade(zf);
    let acc = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const gx = h3(m(xi + dx, f), m(yi + dy, f), m(zi + dz, f), s) * 2 - 1;
      const gy = h3(m(xi + dx, f), m(yi + dy, f), m(zi + dz, f), s + 1) * 2 - 1;
      const gz = h3(m(xi + dx, f), m(yi + dy, f), m(zi + dz, f), s + 2) * 2 - 1;
      const dot3 = gx * (xf - dx) + gy * (yf - dy) + gz * (zf - dz);
      acc += dot3 * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
    }
    return acc * 0.5 + 0.5;
  };
  /** Tiling Worley (cellular) noise: 1 at feature points, 0 far from them. */
  const worley = (x: number, y: number, z: number, f: number, s: number) => {
    const X = x * f, Y = y * f, Z = z * f;
    const xi = Math.floor(X), yi = Math.floor(Y), zi = Math.floor(Z);
    let best = 9;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const cx = xi + a, cy = yi + b, cz = zi + c;
      const px = cx + h3(m(cx, f), m(cy, f), m(cz, f), s), py = cy + h3(m(cx, f), m(cy, f), m(cz, f), s + 7), pz = cz + h3(m(cx, f), m(cy, f), m(cz, f), s + 13);
      best = Math.min(best, (px - X) ** 2 + (py - Y) ** 2 + (pz - Z) ** 2);
    }
    return 1 - Math.min(1, Math.sqrt(best));
  };
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = i / N, y = j / N, z = k / N;
    const p = perlin(x, y, z, 4, 1) * 0.6 + perlin(x, y, z, 8, 5) * 0.3 + perlin(x, y, z, 16, 9) * 0.1;
    const w = worley(x, y, z, 4, 21) * 0.62 + worley(x, y, z, 8, 31) * 0.26 + worley(x, y, z, 16, 41) * 0.12;
    // Perlin-Worley: the Perlin base remapped by the cellular structure (billowy cells).
    const pw = Math.min(1, Math.max(0, (p - (1 - w)) / (1 - (1 - w) + 1e-3) * 0.5 + w * 0.5));
    const d = worley(x, y, z, 10, 51) * 0.6 + worley(x, y, z, 20, 61) * 0.4;
    const o = ((k * N + j) * N + i) * 4;
    data[o] = Math.round(pw * 255);
    data[o + 1] = Math.round(d * 255);
    data[o + 3] = 255;
  }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export class VolumetricClouds {
  readonly mesh: THREE.Mesh;

  constructor(scene: THREE.Scene, weather: THREE.DataTexture) {
    const noise = bakeNoise();
    const P = CLOUD_PARAMS;
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.BackSide, fog: false });
    const deep: TslNode = color('#0b1a44'), pale: TslNode = color('#a9c9ec');
    const band: TslNode = uniform(SKY.band), haze: TslNode = uniform(SKY.horizon);

    /** Cloud density at a flat world point (0..1). */
    const density = (p: TslNode, detail: boolean): TslNode => {
      const hf: TslNode = clamp(p.y.sub(P.base).div(max(P.top.sub(P.base), 1)), 0, 1);
      const uvw: TslNode = vec2(p.x.sub(P.center.x).div(P.span).add(0.5), float(0.5).sub(p.z.sub(P.center.y).div(P.span)));
      const w: TslNode = texture(weather, uvw);
      const cover: TslNode = w.a.mul(P.coverage);
      const core: TslNode = float(1).sub(w.r); // dense cell cores grow taller
      const profile: TslNode = smoothstep(0, 0.12, hf).mul(float(1).sub(smoothstep(core.mul(0.45).add(0.4), float(1), hf)));
      const drift: TslNode = vec3(P.wind.x, 0, P.wind.y).mul(time);
      const n: TslNode = texture3D(noise, p.add(drift).mul(P.scale)).r;
      const cov: TslNode = cover.mul(profile);
      let d: TslNode = clamp(n.sub(float(1).sub(cov)).div(max(cov, 0.02)), 0, 1);
      if (detail) {
        const e: TslNode = texture3D(noise, p.add(drift.mul(1.6)).mul(P.detailScale)).g;
        d = clamp(d.sub(e.mul(0.35).mul(float(1).sub(d))), 0, 1);
      }
      return d;
    };

    // One march returns colour and opacity together (the node is shared, so it runs once).
    const out: TslNode = this.shaderOut(density, deep, pale, band, haze);
    mat.colorNode = out.xyz;
    mat.opacityNode = out.w;
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 48, 1, 48), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    this.mesh.name = 'volumetric-clouds';
    scene.add(this.mesh);
  }

  private shaderOut(density: (p: TslNode, detail: boolean) => TslNode, deep: TslNode, pale: TslNode, band: TslNode, haze: TslNode): TslNode {
    const P = CLOUD_PARAMS;
    return Fn(() => {
      const ro: TslNode = cameraPosition;
      const toFar: TslNode = flatWorld.sub(ro);
      const farDist: TslNode = toFar.length();
      const rd: TslNode = normalize(toFar);
      const sy: TslNode = rd.y.greaterThanEqual(0).select(float(1), float(-1));
      const invY: TslNode = float(1).div(rd.y.add(sy.mul(1e-5)));
      const ta: TslNode = P.base.sub(ro.y).mul(invY), tb: TslNode = P.top.sub(ro.y).mul(invY);
      const t0: TslNode = max(min(ta, tb), 0);
      const t1: TslNode = min(max(ta, tb), farDist);
      const col: TslNode = vec3(0, 0, 0).toVar();
      const alpha: TslNode = float(0).toVar();
      const entry: TslNode = float(0).toVar();
      If(t1.greaterThan(t0), () => {
        const len: TslNode = min(t1.sub(t0), 9000);
        const stepLen: TslNode = len.div(P.steps);
        const jitter: TslNode = hash(screenCoordinate.x.mul(0.618).add(screenCoordinate.y.mul(1.73)));
        const t: TslNode = t0.add(stepLen.mul(jitter)).toVar();
        const L: TslNode = ARCH_PARAMS.keyDir;
        const fwd: TslNode = pow(clamp(dot(rd, L), 0, 1), 6);
        Loop(64, ({ i }: { i: TslNode }) => {
          If(float(i).lessThan(P.steps).and(alpha.lessThan(0.97)), () => {
            const p: TslNode = ro.add(rd.mul(t));
            const d: TslNode = density(p, true);
            If(d.greaterThan(0.002), () => {
              const sd: TslNode = density(p.add(L.mul(90)), false);
              const beer: TslNode = exp(sd.mul(P.absorption).negate());
              const powder: TslNode = float(1).sub(exp(d.mul(-6)));
              const hf: TslNode = clamp(p.y.sub(P.base).div(max(P.top.sub(P.base), 1)), 0, 1);
              const light: TslNode = beer.mul(0.75).add(hf.mul(0.25));
              const q: TslNode = light.mul(P.bands);
              const banded: TslNode = floor(q).add(smoothstep(0.4, 0.6, fract(q))).div(max(P.bands, 1));
              const lv: TslNode = mix(light, banded, P.bands.greaterThan(0.5).select(float(1), float(0)));
              const c: TslNode = mix(deep, pale, lv).mul(float(1).sub(P.storm.mul(0.55)))
                .add(band.mul(powder.mul(beer).mul(fwd.mul(0.9).add(0.12))));
              const dA: TslNode = float(1).sub(exp(d.mul(stepLen).mul(-0.012)));
              If(alpha.lessThan(0.01), () => { entry.assign(t); });
              col.addAssign(c.mul(dA).mul(float(1).sub(alpha)));
              alpha.addAssign(dA.mul(float(1).sub(alpha)));
            });
          });
          t.addAssign(stepLen);
        });
        // A faint survey grid traced on the cloud base, seen from below.
        const baseHit: TslNode = ro.add(rd.mul(ta));
        const g: TslNode = abs(fract(baseHit.xz.div(250)).sub(0.5));
        const grid: TslNode = float(1).sub(smoothstep(0.0, 0.01, min(g.x, g.y)));
        const below: TslNode = rd.y.greaterThan(0).and(ro.y.lessThan(P.base)).select(float(1), float(0));
        col.addAssign(color('#36e2ff').mul(grid.mul(alpha).mul(below).mul(0.22)));
        // Aerial perspective: distant clouds sink into the haze.
        col.assign(mix(col, haze.mul(alpha), float(1).sub(exp(entry.div(-14000))).mul(0.7)));
      });
      return vec4(col.div(max(alpha, 1e-3)), alpha);
    })();
  }

  /** Follow the weather: slab altitudes, the weather map's centre, coverage and storm. */
  update(base: number, top: number, cx: number, cz: number, span: number, cover: number, storm: number): void {
    const P = CLOUD_PARAMS;
    P.base.value = base;
    P.top.value = top;
    P.center.value.set(cx, cz);
    P.span.value = span;
    P.coverage.value = cover > 0 ? 1 : 0;
    P.storm.value = storm;
    this.mesh.position.set(cx, (base + top) / 2, cz);
    this.mesh.scale.set(span, Math.max(10, top - base), span);
  }
}
