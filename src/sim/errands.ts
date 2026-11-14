import { hash01 } from './layout.ts';
import { BITS, type BitHome, type BitPerson, type BitPopulation, type BitWalker } from './bits.ts';
import type { BitAnswer } from '../people/bit.ts';

/**
 * Errands: what there is to do on foot when nobody is fighting. The roadmap's "missions:
 * deliveries between generated points of interest", at the scale of the people. The points of
 * interest are the rooms of the buildings, and the people ask:
 *
 * - **Courier.** A Bit indoors with a data packet to send (a small lit cube over it) asks for a
 *   courier. Walk up and say YES: you carry the packet (it rides over your Bit) to the room of
 *   another building a few hundred metres off. Walk into that room and it is delivered; its
 *   people answer YES, and you are paid.
 * - **Escort.** A Bit on the kerb that wants to move to another building (a small lit ring over
 *   it) asks to be shown the way. Say YES and it follows you, on the trail you walk (so never
 *   through a wall). Bring it to the door of its new building; it goes in and lives there now.
 *
 * Say NO with an errand under way and you drop it (an escorted Bit walks back home the way it
 * came). One errand at a time; the offers change every minute and a half. Pure data, no DOM.
 */
export const ERRANDS = {
  /** Share of the people with something to ask at any one time. */
  share: { courier: 0.18, escort: 0.1 },
  /** Offers are redrawn this often (s). */
  epoch: 90,
  /** Where the errand goes: a room this far from where it starts (m). */
  minDist: 110,
  maxDist: 520,
  /** Pay: a base and so much a metre, in credits. */
  base: 40,
  perMetre: 1 / 6,
  /** The escorted Bit keeps this far behind the player (m), and must come this close to the door. */
  gap: 2.5,
  arrive: 6,
} as const;

export type ErrandKind = 'courier' | 'escort';

/** Where an errand goes: a room, by what the game needs of it (kept even if its lot streams out). */
export interface ErrandTarget {
  id: string;
  y: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** The doorway to make for (outside it, on the way in). */
  door: { x: number; z: number };
  /** Where it is from the start, for the player. */
  distance: number;
  compass: string;
}

export interface Errand {
  kind: ErrandKind;
  to: ErrandTarget;
  reward: number;
  /** The Bit being escorted. */
  who: BitPerson | null;
  startedAt: number;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
/** Compass direction from a to b (-z is north, +x east). */
export function compassOf(dx: number, dz: number): string {
  const deg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}
/** Bearing in degrees, 0 north, clockwise. */
export function bearingOf(dx: number, dz: number): number {
  return ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
}

export class Errands {
  active: Errand | null = null;
  completed = 0;
  earned = 0;
  /** The trail the player has walked since an escort began (the follower walks it). */
  private readonly trail: Array<{ x: number; z: number; y: number }> = [];

  reset(): void {
    this.active = null;
    this.trail.length = 0;
  }

  /** What this Bit is asking for now, if anything (the same for the same person and minute). */
  offerOf(p: BitPerson, time: number): ErrandKind | null {
    if (this.active?.who === p || p.mood === 'scared' || p.hurry || p.home.ruined) return null;
    const epoch = Math.floor(time / ERRANDS.epoch);
    const r = hash01(p.home.key + epoch * 7919, p.slot, 0xe44);
    if (p.place === 'inside' && p.home.room && r < ERRANDS.share.courier) return 'courier';
    if (p.place === 'kerb' && r >= 1 - ERRANDS.share.escort) return 'escort';
    return null;
  }

  /** A room for an errand from this Bit: another building's, at a good distance (the same one every time). */
  private destination(p: BitPerson, bits: BitPopulation): ErrandTarget | null {
    const rooms = [...bits.homes.values()].filter((h): h is BitHome & { room: NonNullable<BitHome['room']> } => !!h.room && !h.ruined && h !== p.home && h.room.doors.length > 0);
    const at = (h: BitHome) => { const r = h.room!; return Math.hypot((r.x0 + r.x1) / 2 - p.x, (r.z0 + r.z1) / 2 - p.z); };
    const fit = rooms.filter((h) => { const d = at(h); return d >= ERRANDS.minDist && d <= ERRANDS.maxDist; });
    const pool = fit.length ? fit : rooms.filter((h) => at(h) >= 40);
    if (!pool.length) return null;
    pool.sort((a, b) => hash01(a.key, p.slot, 0xd57) - hash01(b.key, p.slot, 0xd57));
    const h = pool[0], r = h.room!;
    const d = r.doors[0];
    const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, dist = at(h);
    return {
      id: r.id, y: r.y, x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1,
      door: { x: d.x + d.nx * (d.inset + 2), z: d.z + d.nz * (d.inset + 2) },
      distance: dist, compass: compassOf(cx - p.x, cz - p.z),
    };
  }

  /**
   * The player said something on foot. YES beside a Bit that is asking takes its errand (when
   * none is under way); NO with an errand under way drops it. Returns a word for the player.
   */
  say(answer: BitAnswer, walker: BitWalker, bits: BitPopulation, time: number): string | null {
    if (answer === 'no') {
      if (!this.active) return null;
      const e = this.active;
      if (e.who) bits.release(e.who, time, [...this.trail].reverse());
      this.reset();
      return e.kind === 'courier' ? 'Delivery dropped' : 'Escort dropped: it walks home';
    }
    if (this.active) return null;
    let best: BitPerson | null = null, bestD: number = BITS.earshot;
    for (const p of bits.people) {
      const d = Math.hypot(p.x - walker.x, p.z - walker.z);
      if (d < bestD && this.offerOf(p, time)) { best = p; bestD = d; }
    }
    if (!best) return null;
    const kind = this.offerOf(best, time)!;
    const to = this.destination(best, bits);
    if (!to) return null;
    const reward = Math.round(ERRANDS.base + to.distance * ERRANDS.perMetre);
    this.active = { kind, to, reward, who: kind === 'escort' ? best : null, startedAt: time };
    this.trail.length = 0;
    if (kind === 'escort') {
      bits.lead(best, time);
      this.trail.push({ x: best.x, z: best.z, y: best.y - 1.35 });
    }
    const where = `${Math.round(to.distance / 10) * 10} m ${to.compass}`;
    return kind === 'courier' ? `Courier: take the packet to the building ${where} · ${reward} cr` : `Escort: show this Bit to the building ${where} · ${reward} cr`;
  }

  /**
   * Advance the errand: feed the escorted Bit the player's trail, and see whether it is done.
   * Returns the pay and a word when it is, or a word when it failed.
   */
  step(time: number, walker: BitWalker, bits: BitPopulation): { reward: number; text: string } | { failed: string } | null {
    const e = this.active;
    if (!e) return null;
    if (e.kind === 'courier') {
      const t = e.to;
      if (walker.active && walker.downAt === null && walker.x > t.x0 && walker.x < t.x1 && walker.z > t.z0 && walker.z < t.z1 && Math.abs(walker.y - t.y) < 3) {
        // The people there take it: one of them answers YES.
        const home = [...bits.homes.values()].find((h) => h.room?.id === t.id);
        const someone = home && bits.people.find((p) => p.home === home);
        if (someone) { someone.answer = 'yes'; someone.answeredAt = time; }
        return this.finish(`Packet delivered`);
      }
      return null;
    }
    const p = e.who!;
    if (!bits.people.includes(p) || p.place !== 'follow') {
      this.reset();
      return { failed: 'The Bit you were escorting is gone' };
    }
    // The trail: a point every metre and a half the player walks (on foot; in a vehicle it waits).
    if (walker.active && walker.downAt === null) {
      const last = this.trail[this.trail.length - 1];
      if (!last || Math.hypot(walker.x - last.x, walker.z - last.z) > 1.5) this.trail.push({ x: walker.x, z: walker.z, y: walker.y });
    }
    // It walks the trail up to a couple of metres short of the player.
    const lead = walker.active ? Math.hypot(walker.x - p.x, walker.z - p.z) : 0;
    if (lead > ERRANDS.gap && this.trail.length) {
      // Its path: the trail from the point after the nearest one on to the newest point but one
      // (starting at the nearest would walk it back to a point it has already passed).
      let k = 0, dk = Infinity;
      this.trail.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < dk) { dk = d; k = i; } });
      const from = Math.min(k + 1, this.trail.length - 1);
      p.path = this.trail.slice(from, Math.max(from + 1, this.trail.length - 1)).map((q) => ({ x: q.x, z: q.z, y: q.y }));
    } else p.path = [];
    if (Math.hypot(p.x - e.to.door.x, p.z - e.to.door.z) < ERRANDS.arrive) {
      const home = [...bits.homes.values()].find((h) => h.room?.id === e.to.id);
      if (home && bits.arrive(p, home, time)) return this.finish('Escort done: it has a new home');
    }
    return null;
  }

  private finish(text: string): { reward: number; text: string } {
    const reward = this.active!.reward;
    this.completed++;
    this.earned += reward;
    this.reset();
    return { reward, text };
  }

  /** Where the player is heading, for the HUD and the beacon. */
  target(): { x: number; z: number; kind: ErrandKind; reward: number } | null {
    const e = this.active;
    return e ? { x: e.to.door.x, z: e.to.door.z, kind: e.kind, reward: e.reward } : null;
  }
}
