import * as THREE from 'three/webgpu';
import { abs, asin, clamp, color, cos, exp, float, length, max, mix, normalize, positionLocal, sin, smoothstep, step, uniform, vec3, atan } from 'three/tsl';
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
  // Space: near-black, stars, the planet's glowing limb.
  const w: TslNode = SKY_PLANET.limbWidth;
  const above: TslNode = max(a, float(0));
  const onSky: TslNode = step(float(-0.002), a);
  const limb: TslNode = (color(GRID_SKY.band) as TslNode).mul(exp(above.div(w).negate()).mul(onSky).mul(0.8))
    .add((color(NEON.cyan) as TslNode).mul(exp(above.div(w.mul(0.2)).negate()).mul(onSky).mul(1.5)));
  const space: TslNode = (color('#000208') as TslNode).add(limb).add(starField(d0).mul(smoothstep(0.03, 0.2, a)).mul(1.3));
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
