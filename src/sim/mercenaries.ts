import type { CraftDef } from '../craft/types.ts';
import { flyerKind } from './aiTraffic.ts';

/**
 * Mercenaries and the credits that pay for them. The player earns credits by shooting down
 * aircraft and turrets of the sides it fights and by capturing districts; a mercenary is an AI
 * aircraft hired for a five-minute contract (sim/aiTraffic.ts flies it), priced by how fast and
 * well armed the design is.
 */
export const CREDITS = { aircraft: 100, turret: 150, capture: 300 } as const;

/** What hiring this design costs (credits): 200 for a light plane up to 600 for a rocket. */
export function mercPrice(def: CraftDef): number {
  const kind = flyerKind(def);
  if (kind === 'ground' || kind === 'lighter-than-air') return 0;
  const engines = def.parts.flatMap((p) => p.modules ?? []).filter((m) => m.type === 'engine');
  const fast = engines.some((e) => e.type === 'engine' && (e.kind === 'rocket' || e.kind === 'ramjet' || e.kind === 'scramjet'));
  const jet = engines.some((e) => e.type === 'engine' && (e.kind === 'turbojet' || e.kind === 'turbofan' || (e.kind === undefined && e.propMaxSpeed === undefined)));
  const armed = def.parts.some((p) => p.modules?.some((m) => m.type === 'weapon'));
  const base = fast ? 600 : jet ? 500 : kind === 'rotorcraft' ? 250 : engines.length > 1 ? 300 : 200;
  return base + (armed ? 50 : 0);
}

/** Can this design be hired? (It must fly: no ground vehicles, no blimps.) */
export const hireable = (def: CraftDef): boolean => mercPrice(def) > 0;
