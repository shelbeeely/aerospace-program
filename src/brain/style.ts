import { createNet, forward, fromJSON, softmax, toJSON, train, type Example, type Net } from './net.ts';
import { seededRand } from '../people/genome.ts';

/**
 * How the enemy learns your style, in realtime.
 *
 * While you fight a side, that side watches you: every half second it notes your situation
 * against its nearest unit (where the threat is, how it points at you, the range, your speed and
 * height, a missile on you, rounds coming at you, what you were just doing), and a moment later
 * what you did next: turned left, flew straight or turned right; climbed, held or dived. Two
 * tiny networks (src/brain/net.ts) learn to predict that from the situation, retrained every few
 * seconds on the last few hundred moments, warm-started, seeded. A side also counts habits
 * (which way you break when shot at or hit, what you do with a missile on you, how hard you turn) and
 * writes down what it notices, so its explanations come from records.
 *
 * Confidence is skill, not certainty: how much better than always guessing your most common
 * move the predictions have been lately. Fly unpredictably and it stays near zero, and nothing
 * that reads it (turret lead, fighter tactics) changes. Fly by habit and it rises.
 *
 * Kept per enemy side, per season, in the player's browser (src/app/styleStore.ts). DOM- and
 * scene-free and deterministic for the same flight, so the checks and the relay can run it.
 */
export const TURNS = ['left', 'straight', 'right'] as const;
export const VERTICALS = ['climb', 'level', 'dive'] as const;
export type Turn = (typeof TURNS)[number];
export type Vertical = (typeof VERTICALS)[number];

/** Your situation against the nearest unit of the side that is watching. */
export interface StyleSituation {
  /** Where the threat is, off your nose (rad, + to the right). */
  bearing: number;
  /** How the threat points at you (rad off its nose; 0: straight at you). */
  aspect: number;
  range: number;
  speed: number;
  /** Height above the ground (m). */
  agl: number;
  /** A missile homing on you (0/1); rounds or hits on you in the last moment (0/1); a hit on you just now (0/1). */
  missile: number;
  underFire: number;
  hit: number;
  /** What you were just doing: turn rate (rad/s, + right) and climb rate (m/s). */
  turnRate: number;
  climbRate: number;
}

/** Inputs: the situation, plus how fresh the shooting, the missile and the last hit are (1 at the onset, fading). */
const SCALES = [Math.PI, Math.PI, 2000, 150, 500, 1, 1, 0.5, 20, 1, 1, 1];
const encode = (s: StyleSituation, fireFresh: number, missileFresh: number, hitFresh: number): number[] =>
  [s.bearing, s.aspect, s.range, s.speed, s.agl, s.missile, s.underFire, s.turnRate, s.climbRate, fireFresh, missileFresh, hitFresh].map((v, i) => Math.max(-3, Math.min(3, v / SCALES[i])));
/** How fresh something that started `age` seconds ago is. */
const fresh = (on: number, age: number) => (on ? 1 / (1 + age) : 0);

export const STYLE = {
  /** A moment every this often (s), and what it did next judged this much later (s). */
  sampleEvery: 0.5,
  horizon: 1.5,
  /** A turn is this much heading change over the horizon (rad); a climb or dive this height (m). */
  turn: 0.15,
  climb: 8,
  /** Moments remembered, and how often the networks are retrained (s). */
  buffer: 600,
  retrainEvery: 3,
  epochs: 4,
  lr: 0.03,
  /** Confidence is judged over this many recent predictions, and needs this many first. */
  window: 60,
  minJudged: 20,
  /** A gap in the shooting longer than this (s) ends an episode under fire; hits further apart than this are separate (s). */
  episodeGap: 3,
  hitGap: 1.5,
  /** At the onset (this long after the shooting or the missile starts, s), the habit counts are blended in. */
  onset: 1,
} as const;

export interface StylePrediction {
  turn: number[];
  vertical: number[];
  turnConfidence: number;
  verticalConfidence: number;
}

/** Habits counted over episodes (one per spell under fire or with a missile on you). */
export interface Habits {
  underFire: Record<Turn, number>;
  hit: Record<Turn, number>;
  missile: Record<Vertical, number>;
  /** Moving averages: turn rate when turning (rad/s), climb rate when climbing or diving (m/s), range and speed in a fight. */
  turnRate: number;
  climbRate: number;
  range: number;
  speed: number;
  moments: number;
}

export interface StyleRecord {
  t: number;
  kind: 'break' | 'hit' | 'missile';
  text: string;
}

interface Pending {
  t: number;
  x: number[];
  heading: number;
  alt: number;
  /** What was predicted at the time (for the confidence), and which episodes this moment starts. */
  predTurn: number;
  predVert: number;
  fireEpisode: boolean;
  missileEpisode: boolean;
  hitEpisode: boolean;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** An example rounded to three decimals, for saving. */
const r3 = (e: Example): Example => ({ x: e.x.map((v) => Math.round(v * 1000) / 1000), y: e.y });
const argmax = (xs: readonly number[]) => xs.reduce((b, v, i) => (v > xs[b] ? i : b), 0);

export class StyleModel {
  turnNet: Net;
  verticalNet: Net;
  readonly habits: Habits = { underFire: { left: 0, straight: 0, right: 0 }, hit: { left: 0, straight: 0, right: 0 }, missile: { climb: 0, level: 0, dive: 0 }, turnRate: 0.35, climbRate: 10, range: 1200, speed: 120, moments: 0 };
  readonly records: StyleRecord[] = [];
  private turnData: Example[] = [];
  private verticalData: Example[] = [];
  private pending: Pending[] = [];
  /** Recent predictions against what happened: [predicted turn, turn, predicted vertical, vertical]. */
  private judged: Array<[number, number, number, number]> = [];
  private nextSample = -Infinity;
  private nextTrain = 0;
  private lastFireAt = -Infinity;
  private lastMissileAt = -Infinity;
  /** When the current spell under fire and with a missile on you began, and which spells were counted. */
  private fireSince = -Infinity;
  private missileSince = -Infinity;
  private countedFire = -Infinity;
  private countedMissile = -Infinity;
  private lastHitAt = -Infinity;
  private hitSince = -Infinity;
  private countedHit = -Infinity;
  private now = 0;
  private trainings = 0;
  private readonly rand: () => number;

  /** `who`: the side's name, for what it writes down ("Red"). */
  constructor(readonly who: string, readonly seed = 1) {
    this.rand = seededRand(seed);
    this.turnNet = createNet([SCALES.length, 8, 3], this.rand);
    this.verticalNet = createNet([SCALES.length, 8, 3], this.rand);
  }

  /** Every step: your heading (rad, clockwise from north) and height, and your situation if this side is fighting you. */
  step(t: number, heading: number, alt: number, s: StyleSituation | null): void {
    this.now = t;
    if (s?.underFire) { if (t - this.lastFireAt > STYLE.episodeGap) this.fireSince = t; this.lastFireAt = t; }
    if (s?.missile) { if (t - this.lastMissileAt > STYLE.episodeGap) this.missileSince = t; this.lastMissileAt = t; }
    if (s?.hit) { if (t - this.lastHitAt > STYLE.hitGap) this.hitSince = t; this.lastHitAt = t; }
    // What you did next, for the moments a horizon ago.
    while (this.pending.length && t - this.pending[0].t >= STYLE.horizon) {
      const p = this.pending.shift()!;
      if (t - p.t > STYLE.horizon + 1) continue; // a gap (paused, out of the fight): no label
      const dh = wrapAngle(heading - p.heading), dy = alt - p.alt;
      const turn = dh < -STYLE.turn ? 0 : dh > STYLE.turn ? 2 : 1;
      const vert = dy > STYLE.climb ? 0 : dy < -STYLE.climb ? 2 : 1;
      this.learn(p, turn, vert, Math.abs(dh) / STYLE.horizon, Math.abs(dy) / STYLE.horizon, t);
    }
    if (s && t >= this.nextSample) {
      this.nextSample = t + STYLE.sampleEvery;
      const x = this.inputs(s);
      // The first moment of a spell under fire (or with a missile on you) counts for the habits.
      const fireEpisode = !!s.underFire && this.fireSince > this.countedFire;
      const missileEpisode = !!s.missile && this.missileSince > this.countedMissile;
      if (fireEpisode) this.countedFire = this.fireSince;
      if (missileEpisode) this.countedMissile = this.missileSince;
      const hitEpisode = this.hitSince > this.countedHit && t - this.hitSince <= STYLE.onset;
      if (hitEpisode) this.countedHit = this.hitSince;
      const p = this.predict(s);
      this.pending.push({ t, x, heading, alt, predTurn: argmax(p.turn), predVert: argmax(p.vertical), fireEpisode, missileEpisode, hitEpisode });
      const h = this.habits, k = 0.05;
      h.range += (s.range - h.range) * k;
      h.speed += (s.speed - h.speed) * k;
    }
    if (t >= this.nextTrain && this.turnData.length >= STYLE.minJudged) {
      this.nextTrain = t + STYLE.retrainEvery;
      this.retrain();
    }
  }

  private learn(p: Pending, turn: number, vert: number, turnRate: number, climbRate: number, t: number): void {
    const push = (arr: Example[], e: Example) => { arr.push(e); if (arr.length > STYLE.buffer) arr.shift(); };
    push(this.turnData, { x: p.x, y: turn });
    push(this.verticalData, { x: p.x, y: vert });
    this.judged.push([p.predTurn, turn, p.predVert, vert]);
    if (this.judged.length > STYLE.window) this.judged.shift();
    const h = this.habits;
    h.moments++;
    if (turn !== 1) h.turnRate += (turnRate - h.turnRate) * 0.1;
    if (vert !== 1) h.climbRate += (climbRate - h.climbRate) * 0.1;
    if (p.fireEpisode) {
      h.underFire[TURNS[turn]]++;
      this.notice(t);
    }
    if (p.missileEpisode) {
      h.missile[VERTICALS[vert]]++;
      this.notice(t);
    }
    if (p.hitEpisode) {
      h.hit[TURNS[turn]]++;
      this.notice(t);
    }
  }

  /** Write down what stands out (one record per kind, kept current). */
  private notice(t: number): void {
    const h = this.habits;
    const write = (kind: StyleRecord['kind'], text: string) => {
      const last = this.records[this.records.length - 1];
      if (last && last.kind === kind) { last.t = t; last.text = text; return; }
      const prev = this.records.findIndex((r) => r.kind === kind);
      if (prev >= 0) this.records.splice(prev, 1);
      this.records.push({ t, kind, text });
      if (this.records.length > 12) this.records.shift();
    };
    const uf = h.underFire, nF = uf.left + uf.straight + uf.right;
    const side = uf.left >= uf.right ? 'left' : 'right', kF = Math.max(uf.left, uf.right);
    if (nF >= 5 && kF / nF >= 0.6) write('break', `${this.who} has seen you break ${side} ${kF} of ${nF} times under fire`);
    const hh = h.hit, nH = hh.left + hh.straight + hh.right;
    const hside = hh.left >= hh.right ? 'left' : 'right', kH = Math.max(hh.left, hh.right);
    if (nH >= 5 && kH / nH >= 0.6) write('hit', `${this.who} has seen you turn ${hside} ${kH} of ${nH} times when hit`);
    const m = h.missile, nM = m.climb + m.level + m.dive;
    const mv: Vertical = m.climb >= m.dive && m.climb >= m.level ? 'climb' : m.dive >= m.level ? 'dive' : 'level';
    if (nM >= 4 && m[mv] / nM >= 0.6) write('missile', `${this.who} has seen you ${mv === 'level' ? 'hold your height' : mv} with a missile on you ${m[mv]} of ${nM} times`);
  }

  private retrain(): void {
    this.trainings++;
    train(this.turnNet, this.turnData, { epochs: STYLE.epochs, lr: STYLE.lr, rand: this.rand });
    train(this.verticalNet, this.verticalData, { epochs: STYLE.epochs, lr: STYLE.lr, rand: this.rand });
  }

  /** Skill over always guessing the commonest move lately (0..1), for turns and for climbs. */
  confidence(): { turn: number; vertical: number } {
    const j = this.judged;
    if (j.length < STYLE.minJudged) return { turn: 0, vertical: 0 };
    const skill = (pi: number, ai: number) => {
      const counts = [0, 0, 0];
      let hit = 0;
      for (const r of j) { counts[r[ai]]++; if (r[pi] === r[ai]) hit++; }
      const base = Math.max(...counts) / j.length, acc = hit / j.length;
      return base >= 1 ? 0 : Math.max(0, Math.min(1, (acc - base) / (1 - base)));
    };
    return { turn: skill(0, 1), vertical: skill(2, 3) };
  }

  /** The networks' inputs for a situation now. */
  private inputs(s: StyleSituation): number[] {
    return encode(s, fresh(s.underFire, this.now - this.fireSince), fresh(s.missile, this.now - this.missileSince), fresh(this.now - this.lastHitAt < STYLE.hitGap ? 1 : 0, this.now - this.hitSince));
  }

  /**
   * What it expects you to do next. The networks say; at the onset of shooting or of a missile,
   * the habit counts are blended in (by how many spells they rest on), since a habit is what
   * you do when it starts.
   */
  predict(s: StyleSituation): StylePrediction {
    const x = this.inputs(s), c = this.confidence(), h = this.habits;
    let turn = softmax(forward(this.turnNet, x)), vertical = softmax(forward(this.verticalNet, x));
    let turnConfidence = c.turn, verticalConfidence = c.vertical;
    // A habit's weight grows with the spells it rests on; its strength is how lopsided it is.
    const habit = (counts: number[]) => {
      const n = counts.reduce((a, b) => a + b, 0), w = n / (n + 4);
      return { w, p: counts.map((k) => (k + 0.5) / (n + 1.5)), strength: n ? w * Math.max(0, (Math.max(...counts) / n - 1 / 3) * 1.5) : 0 };
    };
    if (s.underFire && this.now - this.fireSince <= STYLE.onset) {
      const hb = habit(TURNS.map((k) => h.underFire[k]));
      turn = turn.map((v, i) => (1 - hb.w) * v + hb.w * hb.p[i]);
      turnConfidence = Math.max(turnConfidence, hb.strength);
    }
    if (this.now - this.hitSince <= STYLE.onset) {
      const hb = habit(TURNS.map((k) => h.hit[k]));
      turn = turn.map((v, i) => (1 - hb.w) * v + hb.w * hb.p[i]);
      turnConfidence = Math.max(turnConfidence, hb.strength);
    }
    if (s.missile && this.now - this.missileSince <= STYLE.onset) {
      const hb = habit(VERTICALS.map((k) => h.missile[k]));
      vertical = vertical.map((v, i) => (1 - hb.w) * v + hb.w * hb.p[i]);
      verticalConfidence = Math.max(verticalConfidence, hb.strength);
    }
    return { turn, vertical, turnConfidence, verticalConfidence };
  }

  /**
   * The acceleration this side expects of you next (m/s²): sideways (+ to your right) and
   * vertical (+ up), each weighted by its confidence. What a turret leads into.
   */
  lean(s: StyleSituation): { lateral: number; vertical: number } {
    const p = this.predict(s), h = this.habits;
    return {
      lateral: (p.turn[2] - p.turn[0]) * s.speed * h.turnRate * p.turnConfidence,
      vertical: ((p.vertical[0] - p.vertical[2]) * h.climbRate / STYLE.horizon) * p.verticalConfidence,
    };
  }

  /** How many times it has retrained (the UI shows learning happen). */
  get retrained(): number { return this.trainings; }

  toJSON(): StoredStyle {
    return {
      who: this.who, seed: this.seed, turn: toJSON(this.turnNet), vertical: toJSON(this.verticalNet), habits: this.habits, records: this.records,
      turnData: this.turnData.slice(-200).map(r3), verticalData: this.verticalData.slice(-200).map(r3), judged: this.judged,
    };
  }

  static fromJSON(o: unknown, who: string, seed = 1): StyleModel {
    const m = new StyleModel(who, seed);
    const s = (o ?? {}) as Partial<StoredStyle>;
    const tn = fromJSON(s.turn), vn = fromJSON(s.vertical);
    if (tn && tn.sizes.join() === m.turnNet.sizes.join()) m.turnNet = tn;
    if (vn && vn.sizes.join() === m.verticalNet.sizes.join()) m.verticalNet = vn;
    if (s.habits) Object.assign(m.habits, s.habits, { underFire: { ...m.habits.underFire, ...s.habits.underFire }, hit: { ...m.habits.hit, ...s.habits.hit }, missile: { ...m.habits.missile, ...s.habits.missile } });
    if (Array.isArray(s.records)) m.records.push(...s.records.slice(-12));
    const ok = (e: Example) => Array.isArray(e?.x) && e.x.length === SCALES.length && e.y >= 0 && e.y < 3;
    if (Array.isArray(s.turnData)) m.turnData = s.turnData.filter(ok);
    if (Array.isArray(s.verticalData)) m.verticalData = s.verticalData.filter(ok);
    if (Array.isArray(s.judged)) m.judged = s.judged.filter((r) => Array.isArray(r) && r.length === 4).slice(-STYLE.window);
    return m;
  }
}

export interface StoredStyle {
  who: string;
  seed: number;
  turn: ReturnType<typeof toJSON>;
  vertical: ReturnType<typeof toJSON>;
  habits: Habits;
  records: StyleRecord[];
  turnData: Example[];
  verticalData: Example[];
  judged: Array<[number, number, number, number]>;
}

/**
 * Every side's model of you, and what the side fighting you expects of you right now.
 * `step` each simulation step: your heading and height, and who is fighting you (the side of
 * the nearest unit on you, and your situation against it), or null.
 */
export class StyleBook {
  readonly models = new Map<number, StyleModel>();
  /** What the side fighting you expects of you now, as a world acceleration (m/s², x east, y up, z south). */
  readonly leans = new Map<number, { x: number; y: number; z: number }>();
  /** Off: the sides still learn, but nothing leads into what they expect. */
  enabled = true;
  /** The side fighting you now, and your situation against it (the Brains tab shows it). */
  fight: { side: number; s: StyleSituation } | null = null;

  constructor(private readonly name: (side: number) => string, private readonly seed = 1) {}

  model(side: number): StyleModel {
    let m = this.models.get(side);
    if (!m) { m = new StyleModel(this.name(side), (this.seed * 31 + side + 7) >>> 0); this.models.set(side, m); }
    return m;
  }

  step(t: number, heading: number, alt: number, fight: { side: number; s: StyleSituation } | null): void {
    this.fight = fight;
    if (fight) this.model(fight.side);
    for (const [side, m] of this.models) m.step(t, heading, alt, fight && fight.side === side ? fight.s : null);
    this.leans.clear();
    if (!fight || !this.enabled) return;
    const l = this.model(fight.side).lean(fight.s);
    // Your right, for a heading clockwise from north (x east, z south): (cos h, sin h).
    this.leans.set(fight.side, { x: Math.cos(heading) * l.lateral, y: l.vertical, z: Math.sin(heading) * l.lateral });
  }

  toJSON(): Record<string, StoredStyle> {
    const out: Record<string, StoredStyle> = {};
    for (const [side, m] of this.models) out[side] = m.toJSON();
    return out;
  }

  load(o: unknown): void {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const side = Number(k);
      if (!Number.isInteger(side) || side < 0 || side > 8) continue;
      this.models.set(side, StyleModel.fromJSON(v, this.name(side), (this.seed * 31 + side + 7) >>> 0));
    }
  }
}
