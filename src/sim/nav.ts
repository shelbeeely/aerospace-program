/**
 * Navigation for the flight computer: named destinations (every landing site, the downtown hubs
 * and the Grid Spire), wrapped bearings and distances on the planet, obstacle look-ahead, and
 * runway approach geometry (which end to land on, the initial fix, the 3° glideslope). Pure
 * functions over the layout: no DOM, no physics.
 */
import { cityPlan } from '../world/City.ts';
import { landingSites } from '../world/landingSites.ts';
import { obstacleTop } from '../world/structures.ts';
import { CITY, PLANET_HUBS, wrapCoord, type LandingSite } from './layout.ts';
import { terrainHeight } from './terrain.ts';

export const DEG = Math.PI / 180;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
export const wrap360 = (d: number) => ((d % 360) + 360) % 360;

/** Glideslope angle (deg) and its tangent. */
export const GLIDESLOPE = 3;
export const TAN_GS = Math.tan(GLIDESLOPE * DEG);
/** Initial fix: this far before the threshold on the extended centreline (m). */
export const IF_DISTANCE = 2500;
/** Assumed braking deceleration (m/s²) for runway length checks. */
export const BRAKING = 2.5;

export type DestinationKind = 'runway' | 'helipad' | 'hub' | 'landmark';

/** Somewhere the flight computer can fly to. Landing sites carry the site itself. */
export interface Destination {
  id: string;
  name: string;
  kind: DestinationKind;
  x: number;
  z: number;
  /** Height of the landing surface above the street (rooftop pads), else 0. */
  y: number;
  site?: LandingSite;
}

const HUB_NAMES = ['Downtown', 'Southwest', 'South', 'Northwest', 'Northeast'];

let cachedDestinations: Destination[] | null = null;

/** The Grid Spire (the tallest spire in the city plan). */
export function gridSpire(): { x: number; z: number; top: number } {
  const spires = cityPlan().spires;
  let best = spires[0];
  for (const s of spires) if (!best || s.y1 > best.y1) best = s;
  return best ? { x: best.x, z: best.z, top: best.y1 } : { x: CITY.hubs[0].x, z: CITY.hubs[0].z, top: 600 };
}

/** Every named destination: landing sites, the central and planet hubs, and the Grid Spire. */
export function destinations(): Destination[] {
  if (cachedDestinations) return cachedDestinations;
  const out: Destination[] = landingSites().map((s) => ({ id: s.id, name: s.name, kind: s.kind, x: s.x, z: s.z, y: s.y, site: s }));
  CITY.hubs.forEach((h, i) => out.push({ id: `hub-${i}`, name: `${HUB_NAMES[i] ?? `Hub ${i + 1}`} hub`, kind: 'hub', x: h.x, z: h.z, y: 0 }));
  PLANET_HUBS.forEach((h, i) => out.push({ id: `phub-${i}`, name: `Off-Grid hub ${i + 1}`, kind: 'hub', x: h.x, z: h.z, y: 0 }));
  const sp = gridSpire();
  out.push({ id: 'spire', name: 'Grid Spire', kind: 'landmark', x: sp.x, z: sp.z, y: 0 });
  cachedDestinations = out;
  return out;
}

export function destination(id: string): Destination | undefined {
  return destinations().find((d) => d.id === id);
}

/** Wrapped offset (dx, dz) from (x0, z0) to (x1, z1): the short way round the planet. */
export function delta(x0: number, z0: number, x1: number, z1: number): [number, number] {
  return [wrapCoord(x1 - x0), wrapCoord(z1 - z0)];
}

export function distance(x0: number, z0: number, x1: number, z1: number): number {
  const [dx, dz] = delta(x0, z0, x1, z1);
  return Math.hypot(dx, dz);
}

/** Compass bearing (deg, 0 = -Z, 90 = +X) from (x0, z0) to (x1, z1). */
export function bearing(x0: number, z0: number, x1: number, z1: number): number {
  const [dx, dz] = delta(x0, z0, x1, z1);
  return wrap360(Math.atan2(dx, -dz) / DEG);
}

/** Unit vector (x, z) of a compass heading. */
export function headingVector(h: number): [number, number] {
  return [Math.sin(h * DEG), -Math.cos(h * DEG)];
}

/**
 * Tallest obstacle (buildings and terrain, m above the street) along a corridor from (x, z) on
 * a compass heading, out to `reach` metres, `halfWidth` either side.
 */
export function obstacleAhead(x: number, z: number, heading: number, reach: number, halfWidth = 40, stepM = 20): number {
  const [fx, fz] = headingVector(heading);
  let top = 0;
  for (let d = 0; d <= reach; d += stepM) {
    const px = x + fx * d;
    const pz = z + fz * d;
    top = Math.max(top, obstacleTop(px, pz), obstacleTop(px - fz * halfWidth, pz + fx * halfWidth), obstacleTop(px + fz * halfWidth, pz - fx * halfWidth));
  }
  return top;
}

/** Ground (terrain) elevation under a site: the reference for its glideslope. */
export function siteElevation(s: { x: number; z: number; y: number }): number {
  return terrainHeight(s.x, s.z) + s.y;
}

/** Runway length an aircraft with approach speed `vapp` (m/s) needs to land and stop (m). */
export function landingDistanceNeeded(vapp: number): number {
  return (vapp * vapp) / (2 * BRAKING) + 300;
}

/** Usable now? Rooftop pads are gone while their tower is fractured. */
export function siteUsable(s: LandingSite, fractured?: { has(group: number): boolean }): boolean {
  return s.group === undefined || !fractured || !fractured.has(s.group);
}

/** Nearest runway long enough for `vapp`, or null. */
export function nearestRunway(x: number, z: number, vapp: number): LandingSite | null {
  const need = landingDistanceNeeded(vapp);
  let best: LandingSite | null = null;
  let bestD = Infinity;
  for (const s of landingSites()) {
    if (s.kind !== 'runway' || s.length < need) continue;
    const d = distance(x, z, s.x, s.z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** Nearest usable helipad (street-level or rooftop), or null. */
export function nearestPad(x: number, z: number, fractured?: { has(group: number): boolean }): LandingSite | null {
  let best: LandingSite | null = null;
  let bestD = Infinity;
  for (const s of landingSites()) {
    if (s.kind !== 'helipad' || !siteUsable(s, fractured)) continue;
    const d = distance(x, z, s.x, s.z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** A runway approach: one landing direction of one runway. */
export interface Approach {
  site: LandingSite;
  /** Landing heading (deg). */
  heading: number;
  /** Unit vector along the landing direction (x, z) and to its right. */
  dir: [number, number];
  right: [number, number];
  /** Threshold (start of the usable runway) and far end. */
  threshold: [number, number];
  /** Aim point: this far past the threshold (m). */
  aim: number;
  /** Runway surface elevation (m). */
  elevation: number;
}

/** Aim point distance past the threshold (m): further for long runways, never past a quarter. */
export function aimDistance(site: LandingSite): number {
  return Math.min(250, site.length * 0.18);
}

export function makeApproach(site: LandingSite, heading: number): Approach {
  const dir = headingVector(heading);
  const right: [number, number] = [-dir[1], dir[0]];
  const half = site.length / 2;
  return {
    site,
    heading: wrap360(heading),
    dir,
    right,
    threshold: [site.x - dir[0] * half, site.z - dir[1] * half],
    aim: aimDistance(site),
    elevation: siteElevation(site),
  };
}

/** The two landing headings of a runway. */
export function runwayHeadings(site: LandingSite): [number, number] {
  return site.axis === 'z' ? [0, 180] : [90, 270];
}

/**
 * Pick the runway end: into the wind when the headwind component favours one end by more than
 * 1 m/s, else the approach whose initial fix is nearer.
 */
export function chooseApproach(site: LandingSite, x: number, z: number, wind: readonly [number, number, number]): Approach {
  const [a, b] = runwayHeadings(site).map((h) => makeApproach(site, h));
  // Headwind = -(wind · landing direction).
  const ha = -(wind[0] * a.dir[0] + wind[2] * a.dir[1]);
  if (Math.abs(ha) > 1) return ha > 0 ? a : b;
  const fa = initialFix(a);
  const fb = initialFix(b);
  return distance(x, z, fa[0], fa[1]) <= distance(x, z, fb[0], fb[1]) ? a : b;
}

/** Along-track (from the threshold, + toward the far end) and cross-track (+ right) of (x, z). */
export function approachFrame(ap: Approach, x: number, z: number): { along: number; cross: number } {
  const [dx, dz] = delta(ap.threshold[0], ap.threshold[1], x, z);
  return { along: dx * ap.dir[0] + dz * ap.dir[1], cross: dx * ap.right[0] + dz * ap.right[1] };
}

/** World point at (along, cross) in an approach frame. */
export function approachPoint(ap: Approach, along: number, cross = 0): [number, number] {
  return [
    wrapCoord(ap.threshold[0] + ap.dir[0] * along + ap.right[0] * cross),
    wrapCoord(ap.threshold[1] + ap.dir[1] * along + ap.right[1] * cross),
  ];
}

export function initialFix(ap: Approach): [number, number] {
  return approachPoint(ap, -IF_DISTANCE);
}

/** Glideslope height above the runway (m) at an along-track position. */
export function glideslopeHeight(ap: Approach, along: number): number {
  return Math.max(0, (ap.aim - along) * TAN_GS);
}

/**
 * Height to cross the initial fix: on the glideslope, raised to clear whatever stands on the
 * final approach (the tallest obstacle under it plus 40 m, above the runway).
 */
export function initialFixHeight(ap: Approach): number {
  let top = 0;
  for (let s = -IF_DISTANCE; s < -200; s += 25) {
    for (const c of [-60, 0, 60]) {
      const [px, pz] = approachPoint(ap, s, c);
      top = Math.max(top, obstacleTop(px, pz) - ap.elevation - glideslopeHeight(ap, s) + glideslopeHeight(ap, -IF_DISTANCE));
    }
  }
  return Math.max(glideslopeHeight(ap, -IF_DISTANCE), top + 40);
}

/** Localizer: the ground track that intercepts the extended centreline (at most 40° off). */
export function localizerTrack(ap: Approach, cross: number, distToGo: number): number {
  const off = Math.atan2(cross, Math.max(400, 0.3 * Math.abs(distToGo))) / DEG;
  return wrap360(ap.heading - clamp(off, -40, 40));
}

/** Level-flight turn radius (m) at ground speed v and bank angle (deg). */
export function turnRadius(v: number, bankDeg = 30): number {
  return (v * v) / (9.81 * Math.tan(bankDeg * DEG));
}
