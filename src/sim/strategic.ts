/**
 * Strategic weapons: the nuke and the EMP. They are bought with credits (one carried at a time),
 * launched from under the nose (the backquote key) and fly as heavy homing missiles
 * (sim/weapons.ts); the simulation plays out what they do when they go off.
 *
 * - Nuke: arms 3 s after launch (an earlier impact is a dud). A 400 m fireball fractures and
 *   flattens the structures in it and derezzes a craft inside; a shock ring out to 1.2 km
 *   derezzes aircraft, turrets and light cycles and badly damages a craft in it.
 * - EMP: arms after 1.5 s. Inside 800 m aircraft lose engines and lights for 8 s and glide,
 *   turrets go dark for 20 s, light cycles stall, homing missiles lose their lock, and a craft
 *   caught in it loses its engines for 8 s. It destroys nothing.
 */
import type { StrategicKind } from './weapons.ts';

export const STRATEGIC = {
  nuke: { label: 'Nuke', price: 1500, fireball: 400, shock: 1200 },
  emp: { label: 'EMP', price: 800, radius: 800, aircraft: 8, turrets: 20, riders: 8, craft: 8 },
} as const;

export const strategicPrice = (k: StrategicKind): number => STRATEGIC[k].price;

/** A strategic detonation (renderer, audio, the network), newest last. */
export interface StrategicBlast {
  kind: StrategicKind;
  x: number;
  y: number;
  z: number;
  time: number;
  /** It came over the network (another player's): not sent on again. */
  remote: boolean;
}
