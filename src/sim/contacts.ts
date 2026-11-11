import { PLANET } from './layout.ts';
import { HX, HZ, TRAFFIC } from './traffic.ts';
import { hostile } from './teams.ts';
import type { Simulation } from './Simulation.ts';

/**
 * Radar contacts: every vehicle in the world besides the player's own, as the radar scope and
 * the planet map draw them, and the wrap-aware geometry both use. The planet wraps every
 * `PLANET.circumference` metres in x and z, so "where is it from here" is always the shortest
 * way round.
 */

export type ContactKind = 'aircraft' | 'hostile' | 'turret' | 'rider' | 'player';

export interface Contact {
  /** Matches the vehicle's lock target id (air:…, rider:…, player:…). */
  id: string;
  kind: ContactKind;
  x: number;
  z: number;
  /** Altitude (m). */
  y: number;
  /** Heading (rad, 0 = north (-Z), clockwise from above). */
  heading: number;
  /** Its circuit colour. */
  color: string;
  name: string;
  /** A combat aircraft or turret that is fighting (attacking someone). */
  attacking?: boolean;
  /** Fights the player's side (enemy team, freelancer). */
  foe?: boolean;
  /** A hired mercenary. */
  merc?: boolean;
}

/** Shortest signed distance from a to b along one wrapped axis (m). */
export function wrapDelta(a: number, b: number): number {
  const C = PLANET.circumference;
  const d = b - a;
  return d - C * Math.round(d / C);
}

/** The simulation's vehicles: AI aircraft (peaceful and hostile) and the light-cycle riders. */
export function simContacts(sim: Simulation): Contact[] {
  const out: Contact[] = [];
  for (const f of sim.airTraffic.flyers) {
    if (f.derezAt !== null) continue;
    out.push({
      id: `air:${f.id}`, kind: f.hostile ? 'hostile' : 'aircraft', x: f.pos.x, z: f.pos.z, y: f.pos.y, heading: f.heading, color: f.color, name: f.name,
      attacking: f.hostile && f.combat !== 'patrol', foe: f.side !== null && hostile(sim.team, f.side), merc: f.role === 'merc',
    });
  }
  for (const t of sim.groundTurrets.turrets) {
    if (t.derezAt !== null) continue;
    out.push({ id: `turret:${t.site.id}`, kind: 'turret', x: t.pos.x, z: t.pos.z, y: t.pos.y, heading: t.pose.yaw, color: t.color, name: 'Tower turret', attacking: t.state === 'firing', foe: hostile(sim.team, t.side) });
  }
  for (const r of sim.traffic.riders) {
    if (r.derezAt !== null) continue;
    out.push({ id: `rider:${r.id}`, kind: 'rider', x: r.x, z: r.z, y: 0, heading: Math.atan2(HX[r.heading], -HZ[r.heading]), color: TRAFFIC.colors[r.team], name: 'Light cycle' });
  }
  return out;
}

/**
 * Where a contact sits on a heading-up radar scope of `range` metres: x to the right and y up,
 * in scope radii (the rim is 1). Beyond the range it is put on the rim (`inside` false).
 */
export function radarPoint(px: number, pz: number, heading: number, cx: number, cz: number, range: number): { x: number; y: number; inside: boolean; distance: number; bearing: number } {
  const dx = wrapDelta(px, cx), dz = wrapDelta(pz, cz);
  const distance = Math.hypot(dx, dz);
  const bearing = Math.atan2(dx, -dz);
  const rel = bearing - heading;
  const r = Math.min(1, distance / range);
  return { x: Math.sin(rel) * r, y: Math.cos(rel) * r, inside: distance <= range, distance, bearing };
}

/**
 * Where a point sits on the planet map: the whole planet unrolled north-up and centred on the
 * player, u east and v south, each 0..1 (the player is at 0.5, 0.5).
 */
export function mapPoint(px: number, pz: number, cx: number, cz: number): { u: number; v: number } {
  const C = PLANET.circumference;
  return { u: 0.5 + wrapDelta(px, cx) / C, v: 0.5 + wrapDelta(pz, cz) / C };
}

/**
 * The globe view of the planet map: the map's east-west becomes longitude and north-south
 * latitude (`u`, `v` as from mapPoint's frame: 0..1 across the whole planet), seen in an
 * orthographic projection looking at (`lon0`, `lat0`). x is to the right (east), y up (north), z
 * toward the viewer: a point with z < 0 is on the far side.
 */
export function globeAngles(u: number, v: number): { lon: number; lat: number } {
  return { lon: u * Math.PI * 2, lat: (0.5 - v) * Math.PI };
}

export function globeProject(lon: number, lat: number, lon0: number, lat0: number): { x: number; y: number; z: number } {
  const dl = lon - lon0;
  const cl = Math.cos(lat);
  const x = cl * Math.sin(dl), y0 = Math.sin(lat), z0 = cl * Math.cos(dl);
  return { x, y: y0 * Math.cos(lat0) - z0 * Math.sin(lat0), z: y0 * Math.sin(lat0) + z0 * Math.cos(lat0) };
}

/** The inverse: which longitude and latitude a point (x, y) on the disc shows (null: off the globe). */
export function globeUnproject(x: number, y: number, lon0: number, lat0: number): { lon: number; lat: number } | null {
  const r2 = x * x + y * y;
  if (r2 > 1) return null;
  const z = Math.sqrt(1 - r2);
  const y0 = y * Math.cos(lat0) + z * Math.sin(lat0);
  const z0 = -y * Math.sin(lat0) + z * Math.cos(lat0);
  return { lon: lon0 + Math.atan2(x, z0), lat: Math.asin(Math.max(-1, Math.min(1, y0))) };
}
