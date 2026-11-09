import * as THREE from 'three';
import { TUNING } from '../tuning.ts';
import { WorldEvents } from './events/WorldEvents.ts';

/** State of the air at one altitude. */
export interface AirState {
  /** Temperature (K). */
  temperature: number;
  /** Static pressure (Pa). */
  pressure: number;
  /** Density (kg/m³). */
  density: number;
  /** Speed of sound (m/s). */
  speedOfSound: number;
  /** Dynamic viscosity (Pa·s) and kinematic viscosity (m²/s). */
  viscosity: number;
  kinematicViscosity: number;
}

const R_AIR = 287.053; // J/(kg·K)
const GAMMA = 1.4;
const G0 = 9.80665;
const T0 = 288.15;
const P0 = 101325;
const LAPSE = 0.0065; // K/m, troposphere
const H_TROPO = 11000;

/**
 * International Standard Atmosphere (troposphere + lower stratosphere), with an optional
 * temperature offset from ISA (hot/cold day). Pressure follows the standard pressure lapse
 * (it depends on the standard temperature profile); density comes from the ideal gas law at
 * the actual temperature, so a hot day gives thinner air (higher density altitude), as in reality.
 */
export function isa(altitude: number, temperatureOffset = 0, qnhHpa = 1013.25, humidity = 0): AirState {
  const h = Math.min(Math.max(altitude, -500), 100000); // isothermal exponential above 11 km: near-vacuum by 60-100 km (orbits)
  let tStd: number;
  let p: number;
  if (h <= H_TROPO) {
    tStd = T0 - LAPSE * h;
    p = P0 * Math.pow(tStd / T0, G0 / (R_AIR * LAPSE));
  } else {
    const t11 = T0 - LAPSE * H_TROPO;
    const p11 = P0 * Math.pow(t11 / T0, G0 / (R_AIR * LAPSE));
    tStd = t11;
    p = p11 * Math.exp((-G0 * (h - H_TROPO)) / (R_AIR * t11));
  }
  const t = tStd + temperatureOffset;
  p *= qnhHpa / 1013.25; // higher sea-level pressure raises the whole column
  // Humid air is LIGHTER than dry air (water vapour, M=18, displaces N2/O2, M≈29).
  // Vapour pressure from relative humidity and the Tetens saturation formula.
  const tc = t - 273.15;
  const eSat = 610.94 * Math.exp((17.625 * tc) / (tc + 243.04));
  const e = Math.min(p * 0.2, Math.max(0, Math.min(1, humidity)) * eSat);
  const density = (p - e) / (R_AIR * t) + e / (461.5 * t);
  // Sutherland's law for viscosity.
  const viscosity = (1.458e-6 * Math.pow(t, 1.5)) / (t + 110.4);
  return {
    temperature: t,
    pressure: p,
    density,
    speedOfSound: Math.sqrt(GAMMA * R_AIR * t),
    viscosity,
    kinematicViscosity: viscosity / density,
  };
}

/** Air density (kg/m³) at an altitude, standard day. */
export function airDensity(altitude: number): number {
  return isa(altitude).density;
}

/** Density altitude (m): the standard-day altitude with the same density. */
export function densityAltitude(density: number): number {
  // Above the tropopause: invert the isothermal exponential (scale height R·T11 / g0).
  const t11 = T0 - LAPSE * H_TROPO;
  const rho11 = (P0 * Math.pow(t11 / T0, G0 / (R_AIR * LAPSE))) / (R_AIR * t11);
  if (density > 0 && density < rho11) return H_TROPO + ((R_AIR * t11) / G0) * Math.log(rho11 / density);
  // Invert the troposphere density relation rho = rho0 * (T/T0)^(g/(R*L) - 1).
  const rho0 = P0 / (R_AIR * T0);
  const n = G0 / (R_AIR * LAPSE) - 1;
  return (T0 / LAPSE) * (1 - Math.pow(density / rho0, 1 / n));
}

export interface WeatherSettings {
  /** Mean wind speed at 10 m above ground (m/s). */
  windSpeed: number;
  /** Direction the wind blows FROM, compass degrees (0 = from -Z / "north"). */
  windFromDeg: number;
  /** Peak extra speed of discrete gusts (m/s). */
  gustStrength: number;
  /** 0..1 intensity of continuous turbulence. */
  turbulence: number;
  /** Seed for gusts/turbulence: same seed, same weather (fair races, replays). */
  seed: number;
  /** Deviation from the standard-day temperature (°C / K). +20 = a hot day. */
  temperatureOffset?: number;
  /** Sea-level pressure, hPa (QNH). Default 1013.25. */
  qnh?: number;
  /** Relative humidity 0..1 (moist air is less dense). Default 0.5. */
  humidity?: number;
  /** Rain (or snow below freezing) rate, mm/h of liquid water: 2.5 light, 10 moderate, 50 heavy, 100+ violent. */
  precipitation?: number;
  /** Cloud layer: base and top above ground (m) and fraction of sky covered 0..1. */
  cloudBase?: number;
  cloudTop?: number;
  cloudCover?: number;
  /** Thermal strength 0..1 (≈ up to 4 m/s updrafts under cumulus, sink between them). */
  thermals?: number;
  /** Thunderstorm intensity 0..1: heavy downdrafts, microbursts with low-level wind shear. */
  storm?: number;
  /** Horizontal visibility (m), for rendering fog/haze. Default 30000. */
  visibility?: number;
}

/** What falls through a point. */
export interface Precipitation {
  /** mm/h liquid-equivalent. */
  rate: number;
  kind: 'none' | 'rain' | 'snow';
  /** Liquid (or snow) water content of the air from precipitation, kg/m³. */
  waterContent: number;
  /** Drop/flake velocity relative to the ground (m/s): falling plus drifting with the wind. */
  velocity: THREE.Vector3;
}

/** Cloud at a point. */
export interface CloudSample {
  inCloud: boolean;
  /** Cloud liquid water content (kg/m³), ~0.3-2 g/m³ in cumulus. */
  liquidWater: number;
}

/** Deterministic 2D value noise in [0,1]. */
function hash2(x: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash2(x0, z0, seed);
  const b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed);
  const d = hash2(x0 + 1, z0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

export function calmWeather(): WeatherSettings {
  return { windSpeed: 0, windFromDeg: 0, gustStrength: 0, turbulence: 0, seed: 1 };
}

/** Named weather presets (F3 panel, Studio/LLM world generation, races). */
export const WEATHER_PRESETS: Record<string, { label: string; settings: Partial<WeatherSettings> }> = {
  clear: { label: 'Clear and calm', settings: { windSpeed: 0, gustStrength: 0, turbulence: 0, precipitation: 0, cloudCover: 0, thermals: 0, storm: 0, temperatureOffset: 0, visibility: 30000 } },
  summer: { label: 'Hot summer afternoon (thermals)', settings: { windSpeed: 4, gustStrength: 2, turbulence: 0.3, precipitation: 0, cloudBase: 1500, cloudTop: 2500, cloudCover: 0.35, thermals: 0.8, storm: 0, temperatureOffset: 18, humidity: 0.4, visibility: 25000 } },
  moderate: { label: 'Moderate breeze', settings: { windSpeed: 5, windFromDeg: 30, gustStrength: 3, turbulence: 0.25, precipitation: 0, cloudCover: 0.3, cloudBase: 1500, thermals: 0, storm: 0, temperatureOffset: 0, visibility: 30000 } },
  breezy: { label: 'Gusty crosswind', settings: { windSpeed: 9, windFromDeg: 90, gustStrength: 6, turbulence: 0.5, precipitation: 0, cloudCover: 0.4, cloudBase: 1200, thermals: 0.2, storm: 0, temperatureOffset: 0, visibility: 30000 } },
  drizzle: { label: 'Overcast drizzle', settings: { windSpeed: 3, gustStrength: 1, turbulence: 0.2, precipitation: 2.5, cloudBase: 500, cloudTop: 2000, cloudCover: 1, thermals: 0, storm: 0, temperatureOffset: -3, humidity: 0.95, visibility: 6000 } },
  rain: { label: 'Heavy rain', settings: { windSpeed: 6, gustStrength: 4, turbulence: 0.4, precipitation: 50, cloudBase: 350, cloudTop: 3000, cloudCover: 1, thermals: 0, storm: 0, temperatureOffset: -2, humidity: 1, visibility: 2500 } },
  storm: { label: 'Thunderstorm (microbursts)', settings: { windSpeed: 10, gustStrength: 9, turbulence: 0.9, precipitation: 30, cloudBase: 600, cloudTop: 9000, cloudCover: 0.8, thermals: 0.3, storm: 0.8, temperatureOffset: 5, humidity: 0.9, visibility: 2000 } },
  icing: { label: 'Freezing fog (icing)', settings: { windSpeed: 2, gustStrength: 0, turbulence: 0.1, precipitation: 0, cloudBase: 0, cloudTop: 1500, cloudCover: 1, thermals: 0, storm: 0, temperatureOffset: -21, humidity: 1, visibility: 300 } },
  snow: { label: 'Snow', settings: { windSpeed: 5, gustStrength: 3, turbulence: 0.3, precipitation: 4, cloudBase: 400, cloudTop: 2500, cloudCover: 1, thermals: 0, storm: 0, temperatureOffset: -20, humidity: 0.9, visibility: 1500 } },
};

const _drift = new THREE.Vector3();

export function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Wave {
  k: THREE.Vector3; // spatial frequency (rad/m)
  w: number; // temporal frequency (rad/s)
  phase: number;
  amp: number;
  axis: 0 | 1 | 2;
}

/**
 * The moving air: steady wind with a logarithmic boundary-layer profile (calmer near the
 * ground), discrete "1-cosine" gusts, and smooth turbulence made from a fixed set of travelling
 * waves. Everything is deterministic from the seed.
 */
export class Atmosphere {
  settings: WeatherSettings;
  time = 0;
  readonly events: WorldEvents;
  /** Additive environmental sources (e.g. fire plumes); callbacks accumulate into out. */
  readonly windContributors: Array<(p: THREE.Vector3, time: number, out: THREE.Vector3) => void> = [];
  private waves: Wave[] = [];
  private rand: () => number;
  // Current gust: direction, peak, start time, duration.
  private gust = { dir: new THREE.Vector3(), peak: 0, start: -100, duration: 1 };
  private nextGust = 0;

  constructor(settings: WeatherSettings = calmWeather()) {
    this.settings = { ...settings };
    this.events = new WorldEvents(settings.seed);
    this.rand = mulberry32(settings.seed);
    this.reseed(settings.seed);
  }

  /** Change settings; reseeds if the seed changed. */
  configure(patch: Partial<WeatherSettings>): void {
    const seedChanged = patch.seed !== undefined && patch.seed !== this.settings.seed;
    this.settings = { ...this.settings, ...patch };
    if (seedChanged) this.reseed(this.settings.seed);
  }

  /** Restart the weather timeline (on craft reset), so runs are repeatable. */
  restart(): void {
    this.reseed(this.settings.seed);
  }

  private reseed(seed: number): void {
    this.rand = mulberry32(seed);
    this.time = 0;
    this.events.reset(seed);
    this.waves = [];
    // A few octaves per axis: long slow swells down to short quick bumps.
    for (let i = 0; i < 12; i++) {
      const lambda = 400 / 2 ** (i % 4); // 400, 200, 100, 50 m
      const dir = new THREE.Vector3(this.rand() - 0.5, (this.rand() - 0.5) * 0.4, this.rand() - 0.5).normalize();
      this.waves.push({
        k: dir.multiplyScalar((Math.PI * 2) / lambda),
        w: 0.2 + this.rand() * 1.2,
        phase: this.rand() * Math.PI * 2,
        amp: 1 / (1 + (i % 4)),
        axis: (i % 3) as 0 | 1 | 2,
      });
    }
    this.gust.start = -100;
    this.nextGust = 2 + this.rand() * 6;
  }

  /** Full air state at an altitude, including this weather's temperature, pressure and humidity. */
  air(altitude: number): AirState {
    const s = this.settings;
    return isa(altitude, s.temperatureOffset ?? 0, s.qnh ?? 1013.25, s.humidity ?? 0.5);
  }

  /** Cumulus cell field (0..1, >threshold = under/in a cloud cell), drifting with the wind. */
  /** Cloud-cell field 0..1 at a ground position (drifts with the wind); cloud where > 1 − cover. */
  cellValue(x: number, z: number): number {
    const drift = this.meanDirection(_drift).multiplyScalar((this.settings.windSpeed ?? 0) * this.time);
    const scale = 1 / 900; // cells ~1 km across
    return valueNoise((x - drift.x) * scale, (z - drift.z) * scale, this.settings.seed) * 0.7 +
      valueNoise((x - drift.x) * scale * 3.1, (z - drift.z) * scale * 3.1, this.settings.seed + 7) * 0.3;
  }

  /** Is there cloud here, and how wet is it? */
  cloudAt(p: THREE.Vector3, groundHeight = 0, out: CloudSample = { inCloud: false, liquidWater: 0 }): CloudSample {
    const s = this.settings;
    const cover = s.cloudCover ?? 0;
    const h = p.y - groundHeight;
    out.inCloud = false;
    out.liquidWater = 0;
    if (cover <= 0 || h < (s.cloudBase ?? 1200) || h > (s.cloudTop ?? 2500)) return out;
    const v = this.cellValue(p.x, p.z);
    if (v < 1 - cover) return out;
    out.inCloud = true;
    // Wetter in the middle of the cell and of the layer; storms are very wet.
    const depth = Math.max(1, (s.cloudTop ?? 2500) - (s.cloudBase ?? 1200));
    const mid = 1 - Math.abs(((h - (s.cloudBase ?? 1200)) / depth) * 2 - 1);
    out.liquidWater = (0.3e-3 + 1.2e-3 * Math.min(1, (v - (1 - cover)) / Math.max(0.05, cover)) + 2e-3 * (s.storm ?? 0)) * (0.5 + 0.5 * mid);
    return out;
  }

  /** Rain or snow at a point (below and inside the cloud layer, under cloud cells when cover < 1). */
  precipitationAt(p: THREE.Vector3, groundHeight = 0, out?: Precipitation): Precipitation {
    const o = out ?? { rate: 0, kind: 'none', waterContent: 0, velocity: new THREE.Vector3() };
    const s = this.settings;
    let rate = (s.precipitation ?? 0) + (s.storm ?? 0) * 80;
    const h = p.y - groundHeight;
    if (rate > 0 && h > (s.cloudTop ?? 2500)) rate = 0; // above the tops: no precipitation
    // Showers fall from cells: patchy when cover < 1.
    const cover = s.cloudCover ?? 0;
    if (rate > 0 && cover > 0 && cover < 0.95) {
      const v = this.cellValue(p.x, p.z);
      rate *= Math.max(0, Math.min(1, (v - (1 - cover)) / 0.1));
    }
    // Event rain bands are independent of the background preset's cloud coverage.
    if (h <= 2500) rate += this.events.rainAt(p.x, p.z);
    o.rate = rate;
    if (rate <= 0) {
      o.kind = 'none';
      o.waterContent = 0;
      o.velocity.set(0, 0, 0);
      return o;
    }
    const tLocal = this.air(p.y).temperature - 273.15;
    o.kind = tLocal < 0.5 ? 'snow' : 'rain';
    // Terminal velocity: bigger drops in heavier rain (Marshall-Palmer); snow ~1 m/s.
    const vt = o.kind === 'snow' ? 1.0 : Math.min(9, 3.8 + 1.2 * Math.log1p(rate));
    // Water mass flux (kg/m²/s) = rate (mm/h = kg/m²/h) / 3600; content = flux / fall speed.
    o.waterContent = rate / 3600 / vt;
    // Drops drift with the wind.
    this.windAt(p, groundHeight, o.velocity);
    o.velocity.y -= vt;
    return o;
  }

  /**
   * Vertical air motion from convection: thermals under cumulus cells (with gentle sink
   * between), storm downdrafts, and microburst outflow spreading along the ground.
   */
  private convection(p: THREE.Vector3, h: number, out: THREE.Vector3): void {
    const s = this.settings;
    const base = s.cloudBase ?? 1200;
    const thermals = s.thermals ?? 0;
    const storm = s.storm ?? 0;
    if (thermals <= 0 && storm <= 0) return;
    const v = this.cellValue(p.x, p.z);
    const cover = Math.max(0.2, s.cloudCover ?? 0.4);
    const core = Math.max(0, (v - (1 - cover)) / cover); // 0 outside cells, →1 at the core
    // Thermals: grow from the surface (weak below ~50 m), strongest up to cloud base.
    if (thermals > 0 && h < base) {
      const profile = Math.min(1, h / 150) * (1 - 0.3 * (h / base));
      out.y += thermals * (core > 0 ? 4 * core : -0.6) * profile;
    }
    if (storm > 0 && core > 0.5) {
      // Downdraft in the storm core; near the ground it turns into a radial outflow
      // (microburst): headwind then tailwind plus sink across an approach.
      const strength = storm * 14 * (core - 0.5) * 2;
      const nearGround = Math.max(0, 1 - h / 300);
      out.y -= strength * (1 - nearGround * 0.7);
      // Outflow direction: away from the local cell centre (gradient of the cell field).
      const e = 30;
      const gx = this.cellValue(p.x + e, p.z) - this.cellValue(p.x - e, p.z);
      const gz = this.cellValue(p.x, p.z + e) - this.cellValue(p.x, p.z - e);
      const gl = Math.hypot(gx, gz) || 1;
      out.x -= (gx / gl) * strength * nearGround;
      out.z -= (gz / gl) * strength * nearGround;
    }
  }

  density(altitude: number): number {
    return this.air(altitude).density;
  }

  advance(dt: number): void {
    this.time += dt;
    this.events.advance(dt);
    const s = this.settings;
    if (s.gustStrength > 0 && this.time >= this.nextGust) {
      // New gust, mostly along the mean wind (or random if calm), with some vertical.
      const base = this.meanDirection(new THREE.Vector3());
      if (base.lengthSq() < 1e-6) base.set(this.rand() - 0.5, 0, this.rand() - 0.5).normalize();
      this.gust.dir.copy(base).add(new THREE.Vector3((this.rand() - 0.5) * 0.6, (this.rand() - 0.5) * 0.4, (this.rand() - 0.5) * 0.6)).normalize();
      this.gust.peak = s.gustStrength * (0.4 + this.rand() * 0.6);
      this.gust.duration = 1.5 + this.rand() * 4;
      this.gust.start = this.time;
      this.nextGust = this.time + this.gust.duration + 2 + this.rand() * 8;
    }
  }

  /** Unit vector the mean wind blows TOWARD (zero if calm). */
  meanDirection(out: THREE.Vector3): THREE.Vector3 {
    if (this.settings.windSpeed <= 0) return out.set(0, 0, 0);
    const a = (this.settings.windFromDeg * Math.PI) / 180;
    // "From" heading a points at (sin a, 0, -cos a); air moves the opposite way.
    return out.set(-Math.sin(a), 0, Math.cos(a));
  }

  /** Velocity of the air mass at a world point (m/s). `groundHeight` is terrain height there. */
  windAt(p: THREE.Vector3, groundHeight: number, out: THREE.Vector3): THREE.Vector3 {
    const s = this.settings;
    out.set(0, 0, 0);
    const h = Math.max(0, p.y - groundHeight);
    // Log wind profile relative to the 10 m reference, with roughness length z0.
    const z0 = TUNING.windRoughnessLength;
    const profile = Math.min(TUNING.windMaxProfile, Math.log((h + z0) / z0) / Math.log((10 + z0) / z0));
    if (s.windSpeed > 0) this.meanDirection(out).multiplyScalar(s.windSpeed * Math.max(0, profile));

    const gt = this.time - this.gust.start;
    if (gt >= 0 && gt < this.gust.duration) {
      const shape = 0.5 * (1 - Math.cos((2 * Math.PI * gt) / this.gust.duration));
      out.addScaledVector(this.gust.dir, this.gust.peak * shape * Math.max(0.3, Math.min(1, profile)));
    }

    if (s.turbulence > 0) {
      // Turbulence strength grows with wind, fades a little with height, never fully zero.
      const sigma = s.turbulence * (1.2 + 0.25 * s.windSpeed) * (h < 300 ? 1 : 0.7);
      const t = this.time;
      let ux = 0;
      let uy = 0;
      let uz = 0;
      for (const w of this.waves) {
        const v = w.amp * Math.sin(w.k.x * p.x + w.k.y * p.y + w.k.z * p.z + w.w * t + w.phase);
        if (w.axis === 0) ux += v;
        else if (w.axis === 1) uy += v * 0.6;
        else uz += v;
      }
      // Near the ground, vertical gusts are suppressed.
      const groundDamp = Math.min(1, h / 30);
      out.x += ux * sigma * 0.5;
      out.y += uy * sigma * 0.5 * groundDamp;
      out.z += uz * sigma * 0.5;
    }
    this.convection(p, h, out);
    this.events.addWind(p, out);
    for (const contributor of this.windContributors) contributor(p, this.time, out);
    return out;
  }
}
