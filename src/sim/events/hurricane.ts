import * as THREE from 'three';

/** Normalized Holland pressure-gradient wind. Zero in the eye; peak exactly at Rmax. */
export function hurricaneSpeed(radius: number, maxRadius: number, peakSpeed: number, hollandB = 1.5): number {
  if (radius <= 0 || maxRadius <= 0) return 0;
  const q = (maxRadius / radius) ** hollandB;
  if (q > 1500) return 0; // eye limit, including exponent overflow
  // Evaluate in log space to avoid Infinity * 0 at the centre.
  return peakSpeed * Math.exp(0.5 * (Math.log(q) + 1 - q));
}

export interface Hurricane {
  x: number;
  z: number;
  maxRadius: number;
  peakSpeed: number;
  hollandB: number;
}

export function hurricaneWind(p: THREE.Vector3, hurricane: Hurricane, out: THREE.Vector3): THREE.Vector3 {
  const dx = p.x - hurricane.x;
  const dz = p.z - hurricane.z;
  const r = Math.hypot(dx, dz);
  if (r < 1e-8) return out;
  const speed = hurricaneSpeed(r, hurricane.maxRadius, hurricane.peakSpeed, hurricane.hollandB);
  const inflow = 0.15 * speed * Math.exp(-Math.max(0, p.y) / 1000);
  out.x += (-dz * speed - dx * inflow) / r;
  out.z += (dx * speed - dz * inflow) / r;
  return out;
}

/** Spiral rain bands in mm/h, weighted by the eyewall wind profile. */
export function hurricaneRain(x: number, z: number, age: number, hurricane: Hurricane): number {
  const dx = x - hurricane.x;
  const dz = z - hurricane.z;
  const r = Math.hypot(dx, dz);
  const radial = hurricaneSpeed(r, hurricane.maxRadius, 1, hurricane.hollandB);
  const spiral = 0.5 + 0.5 * Math.cos(3 * Math.atan2(dz, dx) + 4 * Math.log(1 + r / hurricane.maxRadius) - age * 0.025);
  return 100 * radial * (0.25 + 0.75 * spiral ** 4);
}

/** Bounded coastal surge (metres); coast x=2500, a local game-scale sea, no ocean dependency. */
export function surgeHeight(x: number, t: number, peak = 3): number {
  const coast = Math.exp(-Math.abs(x - 2500) / 3000);
  return Math.max(0, peak) * coast * (0.5 - 0.5 * Math.cos(t * Math.PI / 180));
}
