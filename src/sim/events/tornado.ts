import * as THREE from 'three';

/**
 * Core updraft as a share of the peak swirl. Measured tornado cores carry 50-80 m/s updrafts
 * near the ground (where the corner flow turns upward), enough to loft what the inflow brings in.
 */
const UPDRAFT = 0.7;

/** Rankine vortex: solid-body rotation inside Rc, conserved angular momentum outside. */
export function tornadoTangentialSpeed(radius: number, coreRadius: number, peakSpeed: number): number {
  if (radius <= 0 || coreRadius <= 0) return 0;
  return peakSpeed * (radius <= coreRadius ? radius / coreRadius : coreRadius / radius);
}

export interface Tornado {
  /** Where the axis is NOW (m). The event scheduler moves it along its path each step. */
  x: number;
  z: number;
  /** Current ground-track velocity (m/s), for the renderer and anything leading the path. */
  velocityX: number;
  velocityZ: number;
  coreRadius: number;
  peakSpeed: number;
  height: number;
  /**
   * The path: the heading (rad) it is tracking along, its ground speed (m/s) and a seeded phase
   * for its meander, so it snakes across the world rather than sliding on a ruler line.
   * Optional so a bare Tornado still works (it then holds its velocity).
   */
  heading?: number;
  speed?: number;
  wander?: number;
}

/**
 * Move a tornado along its path by dt (age: seconds since it formed). Real tornado tracks are
 * long and roughly straight with slow sinuous swings and occasional loops; the heading here
 * drifts on two incommensurate sine terms (periods ~70 s and ~23 s) plus a slow bias, so each
 * tornado carves its own winding swath. Deterministic for a given wander phase.
 */
export function advanceTornado(t: Tornado, age: number, dt: number): void {
  if (t.heading === undefined || t.speed === undefined) {
    t.x += t.velocityX * dt;
    t.z += t.velocityZ * dt;
    return;
  }
  const w = t.wander ?? 0;
  const turn = 0.012 * Math.sin(age / 11 + w) + 0.02 * Math.sin(age / 3.7 + w * 2.3) + 0.002 * Math.sin(w * 7);
  t.heading += turn * dt * 2.2;
  // Speed surges a little as it goes (8-ish % either way).
  const v = t.speed * (1 + 0.08 * Math.sin(age / 9 + w * 1.7));
  t.velocityX = Math.cos(t.heading) * v;
  t.velocityZ = Math.sin(t.heading) * v;
  t.x += t.velocityX * dt;
  t.z += t.velocityZ * dt;
}

/**
 * Adds swirl, near-surface inflow and a core updraft at p. The axis is at (t.x, t.z), where the
 * scheduler has moved it. The inflow is strong in the surface layer (as in real tornadoes, where
 * the boundary-layer inflow is comparable to the swirl): it is what draws loose things in to the
 * core, where the updraft lifts them.
 */
export function tornadoWind(p: THREE.Vector3, _age: number, tornado: Tornado, out: THREE.Vector3): THREE.Vector3 {
  const dx = p.x - tornado.x;
  const dz = p.z - tornado.z;
  const r = Math.hypot(dx, dz);
  const altitude = Math.max(0, p.y);
  const verticalFade = Math.max(0, 1 - altitude / tornado.height);
  if (r < 1e-8 || verticalFade === 0) {
    if (verticalFade > 0) out.y += tornado.peakSpeed * UPDRAFT * verticalFade;
    return out;
  }
  const speed = tornadoTangentialSpeed(r, tornado.coreRadius, tornado.peakSpeed) * verticalFade;
  // Surface-layer inflow (the "corner flow"): near the ground it is about as strong as the
  // swirl, fading to a quarter of it aloft.
  const inflow = speed * (0.25 + 0.7 * Math.exp(-altitude / 60));
  out.x += (-dz * speed - dx * inflow) / r;
  out.z += (dx * speed - dz * inflow) / r;
  // The updraft: strongest in the core, still lifting a little beyond its edge.
  out.y += tornado.peakSpeed * UPDRAFT * Math.exp(-((r / (tornado.coreRadius * 1.3)) ** 2)) * verticalFade;
  return out;
}

/**
 * Aerodynamic force (N) of the wind `wind` on a loose body of mass m moving at `vel`: bluff-body
 * drag on the relative wind, F = ½ρ·Cd·A·|v|·v, with the frontal area of a solid of that mass
 * (A ≈ (m/ρs)^(2/3), ρs the body's bulk density: hollow rubble blocks and airframe pieces are
 * light for their size). Written into `out`.
 */
export function windForce(wind: THREE.Vector3, vel: { x: number; y: number; z: number }, mass: number, out: THREE.Vector3, bulkDensity = 250, cd = 1.1): THREE.Vector3 {
  const rx = wind.x - vel.x, ry = wind.y - vel.y, rz = wind.z - vel.z;
  const v = Math.hypot(rx, ry, rz);
  const area = Math.cbrt((mass / bulkDensity) ** 2);
  const k = 0.5 * 1.2 * cd * area * v;
  return out.set(rx * k, ry * k, rz * k);
}
