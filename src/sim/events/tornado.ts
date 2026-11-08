import * as THREE from 'three';

/** Rankine vortex: solid-body rotation inside Rc, conserved angular momentum outside. */
export function tornadoTangentialSpeed(radius: number, coreRadius: number, peakSpeed: number): number {
  if (radius <= 0 || coreRadius <= 0) return 0;
  return peakSpeed * (radius <= coreRadius ? radius / coreRadius : coreRadius / radius);
}

export interface Tornado {
  x: number;
  z: number;
  velocityX: number;
  velocityZ: number;
  coreRadius: number;
  peakSpeed: number;
  height: number;
}

/** Adds swirl, near-surface inflow and a core updraft; the axis follows a moving path. */
export function tornadoWind(p: THREE.Vector3, age: number, tornado: Tornado, out: THREE.Vector3): THREE.Vector3 {
  const dx = p.x - tornado.x - age * tornado.velocityX;
  const dz = p.z - tornado.z - age * tornado.velocityZ;
  const r = Math.hypot(dx, dz);
  const altitude = Math.max(0, p.y);
  const verticalFade = Math.max(0, 1 - altitude / tornado.height);
  if (r < 1e-8 || verticalFade === 0) {
    if (verticalFade > 0) out.y += tornado.peakSpeed * 0.4 * verticalFade;
    return out;
  }
  const speed = tornadoTangentialSpeed(r, tornado.coreRadius, tornado.peakSpeed) * verticalFade;
  const inflow = speed * 0.25 * Math.exp(-altitude / 250);
  out.x += (-dz * speed - dx * inflow) / r;
  out.z += (dx * speed - dz * inflow) / r;
  out.y += tornado.peakSpeed * 0.4 * Math.exp(-((r / tornado.coreRadius) ** 2)) * verticalFade;
  return out;
}
