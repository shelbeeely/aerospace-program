import * as THREE from 'three';
import { TUNING } from '../tuning.ts';

/** Air density (kg/m^3) at an altitude above sea level, exponential falloff. */
export function airDensity(altitude: number): number {
  const h = Math.max(0, altitude);
  return TUNING.seaLevelDensity * Math.exp(-h / TUNING.densityScaleHeight);
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
}

export function calmWeather(): WeatherSettings {
  return { windSpeed: 0, windFromDeg: 0, gustStrength: 0, turbulence: 0, seed: 1 };
}

function mulberry32(seed: number) {
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
  private waves: Wave[] = [];
  private rand: () => number;
  // Current gust: direction, peak, start time, duration.
  private gust = { dir: new THREE.Vector3(), peak: 0, start: -100, duration: 1 };
  private nextGust = 0;

  constructor(settings: WeatherSettings = calmWeather()) {
    this.settings = { ...settings };
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

  density(altitude: number): number {
    return airDensity(altitude);
  }

  advance(dt: number): void {
    this.time += dt;
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
    return out;
  }
}
