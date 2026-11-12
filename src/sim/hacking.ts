import type { CraftDef } from '../craft/types.ts';
import type { FlyerRole } from './aiTraffic.ts';
import type { Side, Team } from './teams.ts';

/**
 * The hacking beam: takes over an enemy aircraft, turret or light cycle for a minute.
 *
 * - Charges are bought in the armory, three for 600 credits; up to nine held (kept with the
 *   credits).
 * - Hold `;` with a charge and a **locked** target (an enemy aircraft or turret, or a light
 *   cycle) within 1.5 km and in clear line of sight: a beam holds on it, and after 3 s unbroken
 *   (4 s for a turret; half that if an EMP has it) it is yours and the charge is spent. Breaking
 *   the beam (letting go, losing the lock, out of range, the line blocked) resets it, free.
 * - For 60 s an aircraft flies for your side in your livery, escorting you and fighting its old
 *   side; a turret fires for your team from its tower; a light cycle rides in your colour and
 *   its jetwall can't derez you. Then each reverts (a notice says so). Its kills don't pay, and
 *   a hacked turret doesn't stand in the way of capturing its district.
 */
export const HACK = {
  price: 600,
  /** Charges per purchase, and most held. */
  pack: 3,
  max: 9,
  range: 1500,
  /** Seconds of unbroken beam: aircraft and light cycles, turrets. Halved under an EMP. */
  airTime: 3,
  turretTime: 4,
  /** How long a takeover lasts (s). */
  duration: 60,
} as const;

export type HackKind = 'air' | 'turret' | 'rider';

/** What a hacked aircraft was, to put back when the hack runs out. */
export interface HackedFlyer {
  until: number;
  was: Side;
  wasRole: FlyerRole;
  wasDef: CraftDef;
  wasColor: string;
}

/** A hacked turret: its old side. */
export interface HackedTurret {
  until: number;
  was: Team;
  wasColor: string;
}

/** Seconds of beam a target takes. */
export function hackTime(kind: HackKind, disabled: boolean): number {
  return (kind === 'turret' ? HACK.turretTime : HACK.airTime) * (disabled ? 0.5 : 1);
}

/** Why a beam can't hold (or 'beam' while it does). */
export type HackStatus = 'idle' | 'beam' | 'no charges' | 'no lock' | 'not hackable' | 'out of range' | 'blocked';

/** The candidate under the lock, as the beam sees it. */
export interface HackCandidate {
  id: string;
  kind: HackKind;
  /** It fights the player's side (or is a light cycle, which anyone can hack). */
  hackable: boolean;
  range: number;
  clear: boolean;
  /** An EMP has it (hacks in half the time). */
  disabled: boolean;
}

/**
 * The beam's progress on its target: it builds while the trigger is held on a valid target and
 * resets the moment anything breaks it. `step` returns the id when a hack completes.
 */
export class HackBeam {
  progress = 0;
  targetId: string | null = null;
  status: HackStatus = 'idle';

  step(dt: number, held: boolean, charges: number, c: HackCandidate | null): string | null {
    const fail = (s: HackStatus): null => {
      this.status = s;
      this.progress = 0;
      this.targetId = null;
      return null;
    };
    if (!held) return fail('idle');
    if (charges <= 0) return fail('no charges');
    if (!c) return fail('no lock');
    if (!c.hackable) return fail('not hackable');
    if (c.range > HACK.range) return fail('out of range');
    if (!c.clear) return fail('blocked');
    if (this.targetId !== c.id) { this.targetId = c.id; this.progress = 0; }
    this.status = 'beam';
    this.progress += dt / hackTime(c.kind, c.disabled);
    if (this.progress < 1) return null;
    this.progress = 0;
    this.targetId = null;
    this.status = 'idle';
    return c.id;
  }
}
