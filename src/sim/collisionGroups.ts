/**
 * Rapier collision groups: (membership << 16) | filter; two colliders interact when each one's
 * membership is in the other's filter. Everything else keeps the default (all/all).
 *
 * The player's craft and the player's own light walls skip each other: a vehicle never runs
 * into its own jetwall (a U-turn across it is safe), while riders, debris, other players and
 * other players' walls all still collide with both.
 */
const ALL = 0xffff;
export const PLAYER = 0x0004;
export const OWN_WALL = 0x0008;
const groups = (member: number, filter: number) => ((member << 16) | filter) >>> 0;

/** The player's craft colliders (and its wheel rays): everything except its own walls. */
export const CRAFT_GROUPS = groups(PLAYER, ALL & ~OWN_WALL);
/** The player's own light-wall colliders: everything except the player's craft. */
export const OWN_WALL_GROUPS = groups(OWN_WALL, ALL & ~PLAYER);
