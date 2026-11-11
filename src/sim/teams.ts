import type { CraftDef } from '../craft/types.ts';
import { LIGHTS, livery } from '../craft/style1982.ts';

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

/** Do these two sides fight? (Freelancers fight everyone, each other included.) */
export function hostile(a: Side, b: Side): boolean {
  return a === FREELANCER || b === FREELANCER || a !== b;
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
