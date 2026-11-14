import type { Team } from './teams.ts';
import type { BitHome, BitPerson, BitPopulation } from './bits.ts';
import { kerbPoint } from './bits.ts';
import { findRoute } from './roads.ts';
import { kerbside } from './footNav.ts';
import { lotAt } from '../arch/DistrictGenerator.ts';
import { GRID } from '../world/planetCity.ts';
import { CITY, PLANET } from './layout.ts';
import { EVOLUTION } from './evolution.ts';

/**
 * Sappers: in a war, the side that holds a district drafts its Bits to set charges by hand in
 * the enemy's districts. Bits are still people: they side with whoever holds their lot (by
 * residence), they fight only while their side is at war with the target's (diplomacy, never
 * team id alone), and only through the draft.
 *
 * - **The draft.** Every few seconds a lot at war, with an enemy turret within reach, may draft
 *   a young grown Bit from its kerb, more likely the one with more nerve.
 * - **The mission.** It walks the kerbs (a road route moved to the kerb, as the Navigator walks
 *   the player) to the foot of the tower under an enemy turret, kneels to set its charge (the
 *   better its craft, the quicker), and walks home. Inside the enemy's district it may be
 *   spotted each second (more defence, more likely; more stealth, less) and is shot.
 * - **The ladder.** What it can set depends on its craft: a demolition charge at any skill
 *   (a clumsy one is often a dud), an EMP from 0.65, a nuke from 0.85 (and only under the rails
 *   in `BattleWorld.plant`). Founders have almost no craft: every rung has to evolve.
 * - **Fitness.** A sapper shot dead leaves no more children. One that comes home with its charge
 *   set is a veteran: a burst of energy, and standing (others are readier to say YES to it).
 *
 * Deterministic: draws come from the Bits' own streams. DOM- and scene-free; the world it acts
 * on is a `BattleWorld` (the Simulation in the game, a stub in the Evolution Lab).
 */
import type { ChargeKind } from './strategic.ts';
export type { ChargeKind };

export const SAPPERS = {
  /** How often each lot thinks about drafting (s), and its chance each time. */
  every: 5,
  chance: 0.12,
  /** Most sappers out at once (in view), and how far a target may be from the lot (m). */
  max: 4,
  reach: 450,
  /** Craft needed for an EMP and for a nuke. */
  emp: 0.65,
  nuke: 0.85,
  /** Setting a charge takes `set - craft × setSkill` seconds; a dud has chance `(1 - craft) × dud`. */
  set: 10,
  setSkill: 6,
  dud: 0.6,
  /** Spotting: per-second chance = defence × (1 - stealth) × spot. */
  spot: 0.03,
  /** A veteran's burst of energy (share of full) and standing. */
  vetEnergy: 0.4,
  vetPrestige: 1,
  /** Walking pace on a mission (× its own: it hurries). */
  pace: 2,
  /** Only young adults are drafted: grown, and under this share of their lifespan. */
  youth: 0.5,
  /** Out of sight (beyond this from the player, m), a mission is called off and it goes home. */
  sight: 700,
} as const;

/** An enemy target: where to set the charge (on the kerb at the tower's foot), and the tower. */
export interface BattleTarget {
  id: string;
  side: Team;
  x: number;
  z: number;
  /** The tower's foot (where a demolition charge bites) and the turret's roof (where a shot comes from). */
  baseX: number;
  baseZ: number;
  roofY: number;
}

/** What sappers need of the world. */
export interface BattleWorld {
  /** Who holds the district at (x, z). */
  sideAt(x: number, z: number): Team | null;
  atWar(a: Team, b: Team): boolean;
  /** Enemy targets within `reach` of (x, z) for a sapper of `side` (sides at war with it only). */
  targets(side: Team, x: number, z: number, reach: number): BattleTarget[];
  /** How well (x, z) is defended against `side` (0..1). */
  defenceAt(x: number, z: number, side: Team): number;
  /** Set a charge: false if the rails refuse it (not at war, own district, nuke limits). */
  plant(kind: ChargeKind, x: number, y: number, z: number, by: Team, target: BattleTarget, planter: number, time: number): boolean;
  /** Ground height at (x, z). */
  ground(x: number, z: number): number;
}

export interface Mission {
  side: Team;
  target: BattleTarget;
  kind: ChargeKind;
  phase: 'out' | 'set' | 'home';
  /** When the charge is set (s), and whether it was. */
  setUntil: number;
  planted: boolean;
  /** Where on its own kerb it goes back to. */
  homeS: number;
}

/** The charge a Bit of this craft would set (the highest rung it can reach), or null if none is allowed. */
export function chargeFor(craft: number, allowed: (k: ChargeKind) => boolean): ChargeKind {
  if (craft >= SAPPERS.nuke && allowed('nuke')) return 'nuke';
  if (craft >= SAPPERS.emp && allowed('emp')) return 'emp';
  return 'demo';
}

const P = CITY.block + CITY.street;
const N = GRID.blocks;
const C = PLANET.circumference;

interface Rect { x0: number; x1: number; z0: number; z1: number }
type Pt = { x: number; z: number };

/** The kerb rectangle of the lot at (x, z) (image-aware), or null off the lots. */
export function kerbRect(x: number, z: number): Rect | null {
  const gi = Math.floor((x - GRID.x0) / P), gj = Math.floor((z - GRID.z0) / P);
  const lot = lotAt(gi, gj);
  if (!lot) return null;
  const sx = Math.floor(gi / N) * C, sz = Math.floor(gj / N) * C;
  const k = 0.8;
  return { x0: lot.rect.x0 + sx - k, x1: lot.rect.x1 + sx + k, z0: lot.rect.z0 + sz - k, z1: lot.rect.z1 + sz + k };
}

/** The point on a rectangle's edge nearest (x, z). */
function onRect(r: Rect, x: number, z: number): Pt {
  const cx = Math.max(r.x0, Math.min(r.x1, x)), cz = Math.max(r.z0, Math.min(r.z1, z));
  const inside = x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;
  if (!inside) return { x: cx, z: cz };
  const dW = x - r.x0, dE = r.x1 - x, dN = z - r.z0, dS = r.z1 - z;
  const m = Math.min(dW, dE, dN, dS);
  return m === dW ? { x: r.x0, z } : m === dE ? { x: r.x1, z } : m === dN ? { x, z: r.z0 } : { x, z: r.z1 };
}

/** Distance round a rectangle's edge (clockwise from its north-west corner) of a point on it. */
function perim(r: Rect, q: Pt): number {
  const wx = r.x1 - r.x0, wz = r.z1 - r.z0;
  const dN = Math.abs(q.z - r.z0), dE = Math.abs(q.x - r.x1), dS = Math.abs(q.z - r.z1), dW = Math.abs(q.x - r.x0);
  const m = Math.min(dN, dE, dS, dW);
  if (m === dN) return q.x - r.x0;
  if (m === dE) return wx + (q.z - r.z0);
  if (m === dS) return wx + wz + (r.x1 - q.x);
  return 2 * wx + wz + (r.z1 - q.z);
}

/** From one point on a rectangle's edge to another, round the edge the short way (its corners, then `to`). */
function aroundRect(r: Rect, from: Pt, to: Pt): Pt[] {
  const wx = r.x1 - r.x0, wz = r.z1 - r.z0, L = 2 * (wx + wz);
  const a = perim(r, from), b = perim(r, to);
  const fwd = (((b - a) % L) + L) % L;
  const dir = fwd <= L / 2 ? 1 : -1;
  const corners = [{ s: 0, x: r.x0, z: r.z0 }, { s: wx, x: r.x1, z: r.z0 }, { s: wx + wz, x: r.x1, z: r.z1 }, { s: 2 * wx + wz, x: r.x0, z: r.z1 }];
  const span = dir > 0 ? fwd : L - fwd;
  const out: Pt[] = [];
  const ahead = (s: number) => (dir > 0 ? (((s - a) % L) + L) % L : (((a - s) % L) + L) % L);
  for (const c of [...corners].sort((p, q) => ahead(p.s) - ahead(q.s))) if (ahead(c.s) > 0.01 && ahead(c.s) < span - 0.01) out.push({ x: c.x, z: c.z });
  out.push(to);
  return out;
}

/**
 * A walk on foot from `from` (on the kerb of rectangle `a`) to `to` (on the kerb of rectangle
 * `b`), never through a lot: round its own kerb to the side facing the road route, the route
 * moved to the kerb (as the Navigator walks the player), and round the far kerb to `to`.
 */
export function kerbWalk(from: Pt, a: Rect, to: Pt, b: Rect): Pt[] | null {
  const route = findRoute(from.x, from.z, to.x, to.z);
  if (!route) return null;
  const mid = kerbside(route.points);
  if (!mid.length) return [...aroundRect(a, onRect(a, from.x, from.z), onRect(a, to.x, to.z)), to];
  const first = mid[0], last = mid[mid.length - 1];
  return unblock([
    from,
    ...aroundRect(a, onRect(a, from.x, from.z), onRect(a, first.x, first.z)),
    ...mid,
    onRect(b, last.x, last.z),
    ...aroundRect(b, onRect(b, last.x, last.z), to),
  ]).slice(1);
}

const insideRect = (r: Rect, q: Pt, m = 0.5) => q.x > r.x0 + m && q.x < r.x1 - m && q.z > r.z0 + m && q.z < r.z1 - m;

/**
 * Keep a walk out of the lots: any leg that cuts through a lot (a road route moved to the kerb
 * can put a waypoint a few metres inside one) is replaced by a walk round that lot's kerb, from
 * where the leg would enter to where it would leave.
 */
function unblock(path: Pt[]): Pt[] {
  let out = path.slice();
  for (let pass = 0; pass < 24; pass++) {
    let fixed = false;
    for (let i = 1; i < out.length && !fixed; i++) {
      const a = out[i - 1], b = out[i];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(L / 1.5));
      for (let k = 1; k < n; k++) {
        const q = { x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n };
        const r = kerbRect(q.x, q.z);
        if (!r || !insideRect(r, q)) continue;
        // In a lot: from the last point outside it to the first one past it, round its kerb.
        const enter = onRect(r, a.x + ((b.x - a.x) * (k - 1)) / n, a.z + ((b.z - a.z) * (k - 1)) / n);
        let j = k;
        while (j < n && insideRect(r, { x: a.x + ((b.x - a.x) * j) / n, z: a.z + ((b.z - a.z) * j) / n })) j++;
        // Leaving inside it (a waypoint in the lot): the waypoint moves onto the kerb.
        const exitPt = j >= n ? onRect(r, b.x, b.z) : onRect(r, a.x + ((b.x - a.x) * j) / n, a.z + ((b.z - a.z) * j) / n);
        const tail = j >= n && insideRect(r, b) ? out.slice(i + 1) : out.slice(i);
        out = [...out.slice(0, i), enter, ...aroundRect(r, enter, exitPt), ...tail];
        fixed = true;
        break;
      }
    }
    if (!fixed) break;
  }
  return out;
}

/** The kerb point of the lot at (x, z) nearest that point (image-aware), or null off the lots. */
export function kerbNear(x: number, z: number): Pt | null {
  const r = kerbRect(x, z);
  return r ? onRect(r, x, z) : null;
}

export class Sappers {
  enabled = true;
  /** Most sappers out at once, and from one lot (the lab sends more than the city shows). */
  max: number;
  perLot: number;
  /** Chance each lot drafts at each look (SAPPERS.chance; the lab drafts harder). */
  chance: number;
  /** Missions sent, charges set, sappers shot, duds, veterans home. */
  readonly stats = { sent: 0, set: 0, shot: 0, duds: 0, home: 0 };
  /**
   * Who fared how (the genes selection acts on): the stealth of sappers shot and of sappers home
   * again, the craft of veterans and of sappers whose charge was a dud. The last 2000 of each.
   */
  readonly record = { shotStealth: [] as number[], homeStealth: [] as number[], vetCraft: [] as number[], dudCraft: [] as number[] };
  private note(list: number[], v: number): void {
    list.push(v);
    if (list.length > 2000) list.shift();
  }
  /** Shots at sappers this run (the view draws a beam for a moment). */
  readonly shots: Array<{ x: number; y: number; z: number; tx: number; ty: number; tz: number; time: number }> = [];
  private draftAt = 0;

  constructor(opts: { max?: number; perLot?: number; chance?: number } = {}) {
    this.max = opts.max ?? SAPPERS.max;
    this.perLot = opts.perLot ?? 1;
    this.chance = opts.chance ?? SAPPERS.chance;
  }

  reset(): void {
    for (const k of Object.keys(this.stats) as Array<keyof typeof this.stats>) this.stats[k] = 0;
    for (const l of Object.values(this.record)) l.length = 0;
    this.shots.length = 0;
    this.draftAt = 0;
  }

  /** Sappers out now. */
  out(bits: BitPopulation): BitPerson[] {
    return bits.people.filter((p) => p.mission);
  }

  step(dt: number, time: number, bits: BitPopulation, world: BattleWorld, player: { x: number; z: number }): void {
    if (!this.enabled) return;
    const people = bits.people;
    for (let i = people.length - 1; i >= 0; i--) {
      const p = people[i];
      const m = p.mission;
      if (!m) continue;
      // Out of sight: the mission is called off and it goes home.
      if (Math.hypot(p.x - player.x, p.z - player.z) > SAPPERS.sight) { this.homeNow(p, bits, time); continue; }
      // Spotted inside the enemy's district: shot.
      if (world.sideAt(p.x, p.z) === m.target.side) {
        const chance = world.defenceAt(p.x, p.z, m.side) * (1 - p.genome.stealth) * SAPPERS.spot;
        if (p.rand() < 1 - Math.exp(-chance * dt)) {
          this.shots.push({ x: m.target.baseX, y: m.target.roofY, z: m.target.baseZ, tx: p.x, ty: p.y, tz: p.z, time });
          if (this.shots.length > 16) this.shots.shift();
          this.stats.shot++;
          this.note(this.record.shotStealth, p.genome.stealth);
          bits.derez(p, i, time, 'shot');
          continue;
        }
      }
      if (p.path.length) continue; // still walking
      if (m.phase === 'out') {
        m.phase = 'set';
        m.setUntil = time + SAPPERS.set - SAPPERS.setSkill * p.genome.craft;
        p.mood = 'stand';
      } else if (m.phase === 'set' && time >= m.setUntil) {
        const dud = p.rand() < (1 - p.genome.craft) * SAPPERS.dud;
        m.planted = !dud && world.plant(m.kind, p.x, world.ground(p.x, p.z), p.z, m.side, m.target, p.id, time);
        if (m.planted) this.stats.set++;
        else { this.stats.duds++; this.note(this.record.dudCraft, p.genome.craft); }
        bits.say(p, m.planted ? 'yes' : 'no', time);
        // Home the way it came (by the roads), to where it set off from.
        const h = p.home;
        const k = { x: 0, z: 0, tx: 0, tz: 0 };
        kerbPoint(h, m.homeS, 0, k);
        const far = kerbRect(m.target.baseX, m.target.baseZ) ?? { x0: p.x, x1: p.x, z0: p.z, z1: p.z };
        p.path = kerbWalk({ x: p.x, z: p.z }, far, { x: k.x, z: k.z }, h) ?? [{ x: k.x, z: k.z }];
        m.phase = 'home';
        p.mood = 'walk';
      } else if (m.phase === 'home') {
        this.homeNow(p, bits, time);
      }
    }
    // The draft.
    if (time < this.draftAt) return;
    this.draftAt = time + SAPPERS.every;
    let out = people.filter((p) => p.mission).length;
    for (const h of bits.homes.values()) {
      if (out >= this.max) break;
      if (bits.linked && !bits.holds(h.key)) continue; // in the shared world only a lot's holder drafts from it
      const cx = (h.x0 + h.x1) / 2, cz = (h.z0 + h.z1) / 2;
      const side = world.sideAt(cx, cz);
      if (side === null) continue;
      if (people.filter((p) => p.home === h && p.mission).length >= this.perLot) continue;
      const targets = world.targets(side, cx, cz, SAPPERS.reach);
      if (!targets.length) continue;
      const crew = people.filter((p) => p.home === h && p.place === 'kerb' && !p.hurry && !p.bound && p.mood !== 'scared'
        && p.age >= p.life * EVOLUTION.maturity && p.age <= p.life * SAPPERS.youth && p.energy >= 0.5 * p.ph.size);
      if (!crew.length) continue;
      // The lot's own stream decides (the first of its Bits there is as good as any).
      const r = crew[0].rand;
      if (r() >= this.chance) continue;
      // More nerve, likelier to step forward.
      let total = 0;
      for (const p of crew) total += 0.05 + p.genome.nerve;
      let pick = r() * total, who = crew[0];
      for (const p of crew) { pick -= 0.05 + p.genome.nerve; if (pick <= 0) { who = p; break; } }
      const target = targets.reduce((a, t) => (Math.hypot(t.x - cx, t.z - cz) < Math.hypot(a.x - cx, a.z - cz) ? t : a));
      if (this.send(who, side, target, world, time)) out++;
    }
  }

  /** Send a Bit out to `target`. False if there is no way there. */
  send(p: BitPerson, side: Team, target: BattleTarget, world: BattleWorld, time: number): boolean {
    const h = p.home;
    const far = kerbRect(target.baseX, target.baseZ) ?? { x0: target.x, x1: target.x, z0: target.z, z1: target.z };
    const path = kerbWalk({ x: p.x, z: p.z }, h, { x: target.x, z: target.z }, far);
    if (!path) return false;
    const kind = chargeFor(p.genome.craft, (k) => k === 'demo' || world.atWar(side, target.side));
    p.mission = { side, target, kind, phase: 'out', setUntil: 0, planted: false, homeS: p.s };
    p.place = 'mission';
    p.path = path;
    p.door = null;
    p.bound = null;
    p.mood = 'walk';
    p.pending = null;
    p.answer = 'yes';
    p.answeredAt = time;
    this.stats.sent++;
    return true;
  }

  /** Back home (on its kerb, or into its lot's pool if the lot is out of view): a veteran if it set its charge. */
  private homeNow(p: BitPerson, bits: BitPopulation, time: number): void {
    const m = p.mission!;
    this.note(this.record.homeStealth, p.genome.stealth);
    if (m.planted) {
      p.prestige = SAPPERS.vetPrestige;
      p.energy = Math.min(p.ph.size, p.energy + SAPPERS.vetEnergy * p.ph.size);
      this.stats.home++;
      this.note(this.record.vetCraft, p.genome.craft);
    }
    p.mission = null;
    bits.rehome(p, m.homeS, time);
  }
}

export type { BitHome };
