/**
 * Diplomacy between the three teams: how a war starts and how it ends. DOM- and scene-free.
 *
 * One state per pair of teams (Cyan-Red, Cyan-Amber, Red-Amber), moving through stances:
 *
 *   peace ⇄ tension → mobilising → war → truce → peace
 *
 * - **Incidents** (a round, a kill, a blast on another team's craft or turret while at peace)
 *   raise the pair's tension. Tension decays in quiet. Past `tense` the victim protests; past
 *   `breaking` the victim **mobilises**: war follows when the countdown runs out unless the
 *   offender **stands down** (pays reparations).
 * - **A declaration** is telegraphed too: the declaring side mobilises and war follows; it can
 *   be called off before then.
 * - **A cease fire** is accepted once the two sides have traded no fire for `quiet` seconds, and
 *   brings a **truce**: no fighting, and any incident breaks it at once (war again, and every
 *   other team trusts the treacherous side less). When the truce runs out, peace.
 *
 * Who did it matters: a single rogue (the player firing at peace) is hunted personally by the
 * victim before any war (`Simulation.wanted`); this module only keeps the teams' stances.
 */
export type DTeam = 0 | 1 | 2;
export type Stance = 'peace' | 'tension' | 'mobilising' | 'war' | 'truce';

export const DIPLOMACY = {
  /** Tension lost per second at peace or under tension. */
  decay: 0.4,
  /** Tension at which the victim protests (stance 'tension'). */
  tense: 40,
  /** Tension at which the victim mobilises for war. */
  breaking: 100,
  /** Countdown (s) from a victim's mobilisation, or from a declaration, to war. */
  mobilise: 20,
  declare: 15,
  /** A cease fire needs this long (s) without fire between the two sides. */
  quiet: 30,
  /** The truce after a cease fire (s). */
  truce: 120,
  /** Reparations (credits) that make a mobilising victim stand down. */
  reparations: 300,
  /** Tension the other teams add against a side that breaks a truce or declares during one. */
  treachery: 35,
  /** Incident severities. */
  severity: { hit: 8, turret: 6, kill: 30, turretKill: 35, strategic: 120, remoteHit: 10 },
} as const;

export interface PairState {
  stance: Stance;
  tension: number;
  /** When the current countdown (mobilising, truce) ends. */
  until: number;
  /** Who is mobilising (the victim, or the declaring side). */
  by: DTeam | null;
  /** Last fire traded between the two (a cease fire waits for quiet). */
  lastClash: number;
}

/** What changed, for notices and the network. */
export interface DiplomacyEvent {
  kind: 'protest' | 'mobilise' | 'war' | 'stand-down' | 'called-off' | 'truce' | 'truce-broken' | 'peace' | 'distrust';
  a: DTeam;
  b: DTeam;
  /** For mobilise / protest: the side acting (the victim, or the declaring side). */
  by?: DTeam;
  /** Seconds of countdown, tension now. */
  seconds?: number;
  tension?: number;
}

const PAIRS: Array<[DTeam, DTeam]> = [[0, 1], [0, 2], [1, 2]];
const pairIndex = (a: DTeam, b: DTeam): number => (a + b === 1 ? 0 : a + b === 2 ? 1 : 2);
const fresh = (): PairState => ({ stance: 'peace', tension: 0, until: 0, by: null, lastClash: -Infinity });

export class Diplomacy {
  readonly pairs: PairState[] = PAIRS.map(fresh);
  /** Bumped on every stance change. */
  version = 0;
  readonly events: DiplomacyEvent[] = [];

  private pair(a: DTeam, b: DTeam): PairState {
    return this.pairs[pairIndex(a, b)];
  }

  stance(a: DTeam, b: DTeam): Stance {
    return a === b ? 'peace' : this.pair(a, b).stance;
  }

  state(a: DTeam, b: DTeam): Readonly<PairState> {
    return this.pair(a, b);
  }

  atWar(a: DTeam, b: DTeam): boolean {
    return a !== b && this.pair(a, b).stance === 'war';
  }

  anyWar(): boolean {
    return this.pairs.some((p) => p.stance === 'war');
  }

  private set(a: DTeam, b: DTeam, stance: Stance, until = 0, by: DTeam | null = null): void {
    const p = this.pair(a, b);
    p.stance = stance;
    p.until = until;
    p.by = by;
    this.version++;
  }

  private emit(e: DiplomacyEvent): void {
    this.events.push(e);
    if (this.events.length > 64) this.events.splice(0, this.events.length - 64);
  }

  /** The third team (other than a and b). */
  private static third(a: DTeam, b: DTeam): DTeam {
    return (3 - a - b) as DTeam;
  }

  /** The others remember treachery: tension against `traitor` rises with the third team. */
  private distrust(traitor: DTeam, victim: DTeam, now: number): void {
    const t = Diplomacy.third(traitor, victim);
    const p = this.pair(traitor, t);
    if (p.stance === 'war') return;
    p.tension = Math.min(DIPLOMACY.breaking - 1, p.tension + DIPLOMACY.treachery);
    this.emit({ kind: 'distrust', a: t, b: traitor, tension: p.tension });
    this.escalate(traitor, t, t, now);
  }

  /** Move a pair up the ladder after its tension rose. `victim` acts. */
  private escalate(a: DTeam, b: DTeam, victim: DTeam, now: number): void {
    const p = this.pair(a, b);
    if ((p.stance === 'peace' || p.stance === 'tension') && p.tension >= DIPLOMACY.breaking) {
      this.set(a, b, 'mobilising', now + DIPLOMACY.mobilise, victim);
      this.emit({ kind: 'mobilise', a, b, by: victim, seconds: DIPLOMACY.mobilise, tension: p.tension });
    } else if (p.stance === 'peace' && p.tension >= DIPLOMACY.tense) {
      this.set(a, b, 'tension');
      this.emit({ kind: 'protest', a, b, by: victim, tension: p.tension });
    }
  }

  /**
   * `offender` struck `victim` (severity from DIPLOMACY.severity). At war it is just fighting;
   * in a truce it breaks the truce; otherwise tension rises and may tip into mobilisation.
   */
  incident(offender: DTeam, victim: DTeam, severity: number, now: number): void {
    if (offender === victim) return;
    const p = this.pair(offender, victim);
    p.lastClash = now;
    if (p.stance === 'war') return;
    if (p.stance === 'truce') {
      this.set(offender, victim, 'war');
      this.emit({ kind: 'truce-broken', a: offender, b: victim, by: offender });
      this.distrust(offender, victim, now);
      return;
    }
    p.tension = Math.min(200, p.tension + severity);
    this.escalate(offender, victim, victim, now);
  }

  /** `a` declares war on `b`: it mobilises, and war follows. Null, or why not. */
  declare(a: DTeam, b: DTeam, now: number): string | null {
    if (a === b) return 'That is your own team';
    const p = this.pair(a, b);
    if (p.stance === 'war') return 'Already at war';
    if (p.stance === 'mobilising') return p.by === a ? 'Already mobilising' : 'They are already mobilising against you';
    if (p.stance === 'truce') {
      // Declaring during a truce is treachery: war at once.
      this.set(a, b, 'war');
      this.emit({ kind: 'truce-broken', a, b, by: a });
      this.distrust(a, b, now);
      return null;
    }
    this.set(a, b, 'mobilising', now + DIPLOMACY.declare, a);
    this.emit({ kind: 'mobilise', a, b, by: a, seconds: DIPLOMACY.declare, tension: p.tension });
    return null;
  }

  /** Call off one's own declaration while still mobilising. */
  callOff(a: DTeam, b: DTeam): string | null {
    const p = this.pair(a, b);
    if (p.stance !== 'mobilising' || p.by !== a) return 'Nothing to call off';
    p.tension = Math.min(p.tension, DIPLOMACY.tense);
    this.set(a, b, p.tension >= DIPLOMACY.tense ? 'tension' : 'peace');
    this.emit({ kind: 'called-off', a, b, by: a });
    return null;
  }

  /** `a` stands down `b`'s mobilisation against it (the caller takes the reparations). */
  standDown(a: DTeam, b: DTeam): string | null {
    const p = this.pair(a, b);
    if (p.stance !== 'mobilising' || p.by !== b) return 'They are not mobilising against you';
    p.tension = DIPLOMACY.tense;
    this.set(a, b, 'tension');
    this.emit({ kind: 'stand-down', a, b, by: b });
    return null;
  }

  /** A cease fire: accepted after `quiet` seconds without fire; then a truce. */
  ceaseFire(a: DTeam, b: DTeam, now: number): string | null {
    const p = this.pair(a, b);
    if (p.stance !== 'war') return 'Not at war';
    const quiet = now - p.lastClash;
    if (quiet < DIPLOMACY.quiet) return `refused while shots are still flying (${Math.ceil(DIPLOMACY.quiet - quiet)} s)`;
    p.tension = 0;
    this.set(a, b, 'truce', now + DIPLOMACY.truce);
    this.emit({ kind: 'truce', a, b, seconds: DIPLOMACY.truce });
    return null;
  }

  /** Clocks: decay, mobilisation running out into war, truces running out into peace. */
  step(now: number, dt: number): void {
    PAIRS.forEach(([a, b], i) => {
      const p = this.pairs[i];
      if (p.stance === 'peace' || p.stance === 'tension') {
        p.tension = Math.max(0, p.tension - DIPLOMACY.decay * dt);
        if (p.stance === 'tension' && p.tension < DIPLOMACY.tense / 2) {
          this.set(a, b, 'peace');
          this.emit({ kind: 'peace', a, b });
        }
      } else if (p.stance === 'mobilising' && now >= p.until) {
        this.set(a, b, 'war');
        p.lastClash = now;
        this.emit({ kind: 'war', a, b, by: p.by ?? undefined });
      } else if (p.stance === 'truce' && now >= p.until) {
        p.tension = 0;
        this.set(a, b, 'peace');
        this.emit({ kind: 'peace', a, b });
      }
    });
  }

  /** Straight to war or peace (the network, checks). True if it changed. */
  setWar(a: DTeam, b: DTeam, on: boolean, now = 0): boolean {
    if (a === b || this.atWar(a, b) === on) return false;
    const p = this.pair(a, b);
    p.tension = on ? DIPLOMACY.breaking : 0;
    p.lastClash = on ? now : -Infinity;
    this.set(a, b, on ? 'war' : 'peace');
    return true;
  }

  /** War flags as 3 bits (Cyan-Red 1, Cyan-Amber 2, Red-Amber 4). */
  mask(): number {
    return this.pairs.reduce((m, p, i) => (p.stance === 'war' ? m | (1 << i) : m), 0);
  }

  setMask(m: number): void {
    PAIRS.forEach(([a, b], i) => this.setWar(a, b, (m & (1 << i)) !== 0));
  }

  reset(): void {
    for (let i = 0; i < 3; i++) this.pairs[i] = fresh();
    this.events.length = 0;
    this.version++;
  }
}

/** The one diplomacy of the world (like WORLD, shared by everything that asks `hostile()`). */
export const diplomacy = new Diplomacy();
