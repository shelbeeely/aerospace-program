import type { CraftDef } from '../craft/types.ts';
import { LIGHTS, livery } from '../craft/style1982.ts';
import { diplomacy } from './diplomacy.ts';

/**
 * Sides in the war. Three teams hold the planet's territory: Cyan, Red and Amber. Freelancers
 * belong to no one and fight everyone. Mercenaries are hired by the player and fight on the
 * player's side whatever its team (they wear their own livery so they can be told apart).
 */

export type Team = 0 | 1 | 2;
/** The teamless: every side is their enemy, and they are everyone's. */
export const FREELANCER = 3;
export type Side = Team | typeof FREELANCER;

export interface TeamInfo {
  id: Team;
  name: string;
  /** Its light (a 1982 light colour) and whether its bodies are the warm near-blacks. */
  light: string;
  warm: boolean;
}

export const TEAMS: readonly TeamInfo[] = [
  { id: 0, name: 'Cyan', light: LIGHTS[0], warm: false },
  { id: 1, name: 'Red', light: LIGHTS[2], warm: true },
  { id: 2, name: 'Amber', light: LIGHTS[4], warm: false },
];
export const FREELANCER_LIGHT = LIGHTS[5];
export const MERC_LIGHT = LIGHTS[1];

export const isTeam = (v: unknown): v is Team => v === 0 || v === 1 || v === 2;

/**
 * Diplomacy (src/sim/diplomacy.ts): tension, mobilisation, war, truce and peace per pair of
 * teams. The world starts at peace. These are the short questions everything else asks.
 */
export { diplomacy, DIPLOMACY, type Stance } from './diplomacy.ts';

/** Are these two teams at war? */
export function atWar(a: Team, b: Team): boolean {
  return diplomacy.atWar(a, b);
}

/** Straight to war (on) or peace (off), skipping the ladder (the network, checks). */
export function setWar(a: Team, b: Team, on: boolean, now = 0): boolean {
  return diplomacy.setWar(a, b, on, now);
}

/** Is any pair of teams at war? (Freelancers only come out while one is.) */
export const anyWar = (): boolean => diplomacy.anyWar();
/** The war flags as 3 bits (Cyan-Red 1, Cyan-Amber 2, Red-Amber 4), for the network. */
export const warMask = (): number => diplomacy.mask();
export const setWarMask = (m: number): void => diplomacy.setMask(m);
/** Back to peace everywhere (a world reset). */
export function resetDiplomacy(): void {
  diplomacy.reset();
}
/** Every team at war with every other (the old always-at-war world; checks use it). */
export function allAtWar(): void {
  diplomacy.setMask(7);
}

/**
 * Do these two sides fight? Freelancers fight everyone; two teams fight only while at war; a
 * side never fights itself.
 */
export function hostile(a: Side, b: Side): boolean {
  if (a === FREELANCER || b === FREELANCER) return true;
  return a !== b && atWar(a, b);
}

/** Does `side` fight this target? A target may carry its own rule (a rogue player is hunted). */
export function foeHostile(side: Side, foe: { side: Side; hostileTo?: (s: Side) => boolean }): boolean {
  return foe.hostileTo ? foe.hostileTo(side) : hostile(side, foe.side);
}

export function sideName(s: Side): string {
  return s === FREELANCER ? 'Freelancer' : TEAMS[s].name;
}

/** A side's light colour. */
export function sideLight(s: Side): string {
  return s === FREELANCER ? FREELANCER_LIGHT : TEAMS[s].light;
}

/** A craft in a side's livery (mercenaries: blue light on cool bodies). */
export function sideLivery(def: CraftDef, s: Side, merc = false): CraftDef {
  if (merc) return livery(def, MERC_LIGHT, false);
  return s === FREELANCER ? livery(def, FREELANCER_LIGHT, false) : livery(def, TEAMS[s].light, TEAMS[s].warm);
}
