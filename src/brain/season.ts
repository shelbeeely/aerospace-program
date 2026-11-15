/**
 * Seasons: four-week stretches of the calendar during which each side's networks evolve and
 * each side keeps what it has learned about the players. A pure function of the time, so every
 * client and the relay agree on the season without talking. At a season's end its champions
 * are merged into the shipped NPC and the next season starts from them.
 */
export const SEASON_DAYS = 28;
const DAY = 86_400_000;
/** Season 1 starts here (Monday 2 November 2026, 00:00 UTC). */
export const SEASON_EPOCH = Date.UTC(2026, 10, 2);

export interface Season {
  /** 1, 2, 3… (before the epoch: 0 and below). */
  id: number;
  /** Day of the season, 1..SEASON_DAYS. */
  day: number;
  startsAt: number;
  endsAt: number;
}

export function seasonOf(ms: number): Season {
  const len = SEASON_DAYS * DAY;
  const k = Math.floor((ms - SEASON_EPOCH) / len);
  const startsAt = SEASON_EPOCH + k * len;
  return { id: k + 1, day: Math.floor((ms - startsAt) / DAY) + 1, startsAt, endsAt: startsAt + len };
}
