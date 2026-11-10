import * as THREE from 'three/webgpu';
import { abs, asin, atan, clamp, color, cos, exp, float, floor, fract, length, max, min, mix, normalize, positionLocal, sin, smoothstep, sqrt, step, uniform, vec3, vec4 } from 'three/tsl';
import { PLANET } from '../../sim/layout.ts';
import { wastelandAt } from '../../arch/DigitalTerrainGenerator.ts';
import { cityRegionAt, REGION_PROFILES, terrainMixAt, TERRAIN_PROFILES, type Atmosphere } from '../../arch/WorldRegionManager.ts';
import { GRID_SKY, NEON, SKY_PLANET, starField, type TslNode } from '../neon.ts';
import { ARCH_PARAMS } from './ArchitecturalMaterialLibrary.ts';

/**
 * The painted sky of the 1982 concept art: not black, but a deep airbrushed gradient from a
 * near-black zenith through deep blue to a luminous horizon band, whose colour belongs to the
 * region below (amber over the control centres and grid flats, orange over industrial zones and
 * canyons, cyan over the machine cities, pale blue over the Sea of Simulation). Faint painterly
 * strata hang above the horizon. From orbit it fades into space with sparse geometric stars and
 * a glowing limb.
 */
export const SKY = {
  zenith: new THREE.Color('#00020a'),
  upper: new THREE.Color('#03123d'),
  horizon: new THREE.Color('#0b3a7a'),
  band: new THREE.Color('#ffb347'),
};

/** Camera altitude (m) for the scattering (WorldView keeps it current). */
export const SCATTER = { altitude: uniform(0), shell: 3000 };

/**
 * Stylised atmospheric scattering, after the analytic ray/sphere single-scattering of the
 * volumetric atmosphere engine (see VolumetricClouds): the length of the view ray inside the
 * air shell (stopping at the planet) gives an optical depth; instead of Rayleigh/Mie colour,
 * that depth walks the region's painted palette (deep sky → horizon → luminous band) in soft
 * posterised steps. Returns rgb (colour) and a (amount of air in front of space).
 */
export function scatterNode(dir: TslNode): TslNode {
  const R = PLANET.radius, Ra = PLANET.radius + SCATTER.shell;
  const hR: TslNode = SCATTER.altitude.add(R);
  const b: TslNode = hR.mul(dir.y);
  const discOut: TslNode = b.mul(b).sub(hR.mul(hR)).add(Ra * Ra);
  const sq: TslNode = sqrt(max(discOut, 0));
  const tIn: TslNode = max(b.negate().sub(sq), 0);
  const tOut: TslNode = b.negate().add(sq);
  const discG: TslNode = b.mul(b).sub(hR.mul(hR)).add(R * R);
  const tG: TslNode = b.negate().sub(sqrt(max(discG, 0)));
  const hitsGround: TslNode = step(0, discG).mul(step(0, tG));
  const tEnd: TslNode = mix(tOut, min(tOut, tG), hitsGround);
  const L: TslNode = max(tEnd.sub(tIn), 0).mul(step(0, discOut));
  const amount: TslNode = float(1).sub(exp(L.div(SCATTER.shell * 2.2).negate()));
  const bands = 5;
  const q: TslNode = amount.mul(bands);
  const banded: TslNode = floor(q).add(smoothstep(0.35, 0.65, fract(q))).div(bands);
  const upr: TslNode = uniform(SKY.upper), hor: TslNode = uniform(SKY.horizon), bnd: TslNode = uniform(SKY.band);
  const c: TslNode = mix(mix(upr.mul(1.6), hor.mul(1.3), smoothstep(0.1, 0.55, banded)), bnd, smoothstep(0.6, 0.98, banded));
  return vec4(c, amount);
}

export function paintedSkyNode(): TslNode {
  const zen: TslNode = uniform(SKY.zenith), upr: TslNode = uniform(SKY.upper), hor: TslNode = uniform(SKY.horizon), bnd: TslNode = uniform(SKY.band);
  const d0: TslNode = normalize(positionLocal);
  const a: TslNode = asin(clamp(d0.y, -1, 1)).add(SKY_PLANET.dipAngle);
  const ac: TslNode = clamp(a, -Math.PI / 2, Math.PI / 2);
  const hz: TslNode = cos(ac).div(max(length(d0.xz), float(1e-5)));
  const d: TslNode = vec3(d0.x.mul(hz), sin(ac), d0.z.mul(hz));
  const up: TslNode = clamp(d.y, 0, 1);
  const az: TslNode = atan(d.z, d.x);
  // Three-stop airbrush gradient.
  let c: TslNode = mix(hor, upr, smoothstep(0.0, 0.28, up));
  c = mix(c, zen, smoothstep(0.22, 0.9, up));
  // The luminous horizon band, wide and soft, with a bright core.
  const below: TslNode = step(d.y, 0);
  const wide: TslNode = exp(abs(d.y).div(-0.05)).mul(0.75);
  const core: TslNode = exp(abs(d.y).div(-0.009)).mul(0.5);
  c = c.add(bnd.mul(wide)).add(mix(bnd, color('#ffffff') as TslNode, 0.35).mul(core));
  // Painterly strata above the horizon (slow, gently wavering bands).
  const strata: TslNode = sin(up.mul(95).add(sin(az.mul(3).add(1.3)).mul(1.4)).add(sin(az.mul(7.1)).mul(0.5))).mul(0.5).add(0.5);
  c = c.add(bnd.mul(strata.mul(exp(up.div(-0.12))).mul(0.06)));
  // Below the horizon: haze.
  c = mix(c, hor.mul(0.7).add(bnd.mul(0.1)), below.mul(smoothstep(0, 0.08, abs(d.y))));
  // Space: near-black with sparse stars, seen through the air shell (stylised scattering):
  // the planet's limb glows in banded palette colours where the view grazes the atmosphere.
  const sc: TslNode = scatterNode(d0);
  const stars: TslNode = starField(d0).mul(smoothstep(0.03, 0.2, a)).mul(1.3).mul(float(1).sub(sc.w));
  const space: TslNode = (color('#000208') as TslNode).add(stars).add(sc.xyz.mul(sc.w.mul(1.4)));
  void GRID_SKY;
  void NEON;
  return mix(c, space, SKY_PLANET.space as unknown as TslNode);
}

/** The clear-weather atmosphere at a place (before weather dims it). */
export interface ClearSky {
  zenith: THREE.Color;
  upper: THREE.Color;
  horizon: THREE.Color;
  band: THREE.Color;
  haze: THREE.Color;
  ground: THREE.Color;
  visibility: number;
}

const toColors = (a: Atmosphere): ClearSky => ({
  zenith: new THREE.Color(a.zenith), upper: new THREE.Color(a.upper), horizon: new THREE.Color(a.horizon), band: new THREE.Color(a.band),
  haze: new THREE.Color(a.haze), ground: new THREE.Color(a.ground), visibility: a.visibility,
});

function blend(out: ClearSky, src: ClearSky, k: number): void {
  out.zenith.lerp(src.zenith, k); out.upper.lerp(src.upper, k); out.horizon.lerp(src.horizon, k); out.band.lerp(src.band, k);
  out.haze.lerp(src.haze, k); out.ground.lerp(src.ground, k);
  out.visibility += (src.visibility - out.visibility) * k;
}

const CITY_SKIES = Object.fromEntries(Object.entries(REGION_PROFILES).map(([k, v]) => [k, toColors(v.atmosphere)])) as Record<string, ClearSky>;
const TERRAIN_SKIES = Object.fromEntries(Object.entries(TERRAIN_PROFILES).map(([k, v]) => [k, toColors(v.atmosphere)])) as Record<string, ClearSky>;

/** The region's atmosphere at (x, z): civilised regions blended with the Outlands archetypes. */
export function atmosphereAt(x: number, z: number): ClearSky {
  const c = cityRegionAt(x, z);
  const out = toColors(REGION_PROFILES[c.primary].atmosphere);
  blend(out, CITY_SKIES[c.secondary], c.t * 0.5);
  const w = wastelandAt(x, z);
  if (w > 0.01) {
    const mix = terrainMixAt(x, z);
    const t = toColors(TERRAIN_PROFILES['grid-plains'].atmosphere);
    let acc = 0;
    for (const [k, v] of Object.entries(mix)) {
      if (v <= 0) continue;
      acc += v;
      blend(t, TERRAIN_SKIES[k], v / acc);
    }
    blend(out, t, Math.min(1, w * 1.3));
  }
  return out;
}

/**
 * Follows the camera through regions and eases the clear-sky colours, haze and visibility toward
 * the region below (and the architecture's sky fill and rim colours with them).
 */
export class AtmosphereController {
  readonly clear: ClearSky = toColors(REGION_PROFILES.control.atmosphere);
  private target: ClearSky = toColors(REGION_PROFILES.control.atmosphere);
  private timer = 1e9;
  private first = true;
  /** Region name under the camera (debug UI). */
  label = '';

  update(dt: number, x: number, z: number): void {
    this.timer += dt;
    if (this.timer > 0.4) {
      this.timer = 0;
      this.target = atmosphereAt(x, z);
      const c = cityRegionAt(x, z);
      this.label = wastelandAt(x, z) > 0.5 ? `Outlands` : `${c.name} · ${REGION_PROFILES[c.primary].label}`;
    }
    blend(this.clear, this.target, this.first ? 1 : Math.min(1, dt * 0.6));
    this.first = false;
    ARCH_PARAMS.sky.value.copy(this.clear.upper).multiplyScalar(2.2).lerp(this.clear.horizon, 0.4);
    ARCH_PARAMS.bounce.value.copy(this.clear.ground).multiplyScalar(1.2);
    ARCH_PARAMS.horizon.value.copy(this.clear.horizon).lerp(this.clear.band, 0.35);
  }

  /** Jump straight to the target (teleports). */
  snap(): void {
    this.first = true;
    this.timer = 1e9;
  }
}
