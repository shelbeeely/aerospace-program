import type { Craft } from '../craft/Craft.ts';
import type { PartDef } from '../craft/types.ts';
import { TUNING } from '../tuning.ts';

/**
 * One Rapier contact-force event, copied out of the WASM temp object. The same object is
 * reused for every event: copy the fields if you need to keep them past the handler call.
 * Forces are in newtons over the last physics step (impulse = force × dt).
 */
export interface ContactForceInfo {
  /** Rapier collider handles of the pair. */
  collider1: number;
  collider2: number;
  /** Sum of the contact force magnitudes of the pair (N). */
  totalForceMagnitude: number;
  /** Largest single contact force of the pair (N). */
  maxForceMagnitude: number;
  /** Step length (s) and simulation time (s) of the step that produced it. */
  dt: number;
  time: number;
}

export type ContactForceHandler = (e: ContactForceInfo) => void;

/** A part the damage model wants broken off. */
export interface ImpactFailure {
  partId: string;
  /** Window-averaged impact force (N). */
  load: number;
  /** The part's structural strength (N; Infinity = unbreakable by overload). */
  strength: number;
}

interface PairWindow {
  partId: string;
  start: number;
  impulse: number;
}

/** Part volume from its shape (m³). */
function partVolume(p: PartDef): number {
  const s = p.shape;
  if (s.type === 'box') return s.size[0] * s.size[1] * s.size[2];
  if (s.type === 'sphere') return (4 / 3) * Math.PI * s.radius ** 3;
  if (s.type === 'cone') return (Math.PI * s.radius * s.radius * s.length) / 3;
  if (s.type === 'capsule') return Math.PI * s.radius * s.radius * (s.length - (2 / 3) * s.radius);
  return Math.PI * s.radius * s.radius * s.length;
}

/** Landing gear: wheels, gear legs and skids are built to take landing impacts. */
function isGear(p: PartDef): boolean {
  if (p.modules?.some((m) => m.type === 'wheel')) return true;
  return /^(gear|skid)/.test(p.kind);
}

/**
 * Impact damage. Each craft part has hit points (PartDef.hp, or a default from its mass and
 * volume). Contact impulses on a part's collider are summed per collider pair over a short
 * window (so one impact split over several physics steps counts once, and a pair can't deal
 * damage more often than once per window), then turned into damage:
 *
 * - impulse energy E = J² / (2·m_part) above a tolerance, the energy of the whole craft
 *   stopping at `impactSafeSpeed` on that part (normal landings and bumps do nothing);
 * - force overload: window-averaged force above the part's structural strength takes
 *   (F/strength − 1) of its full HP.
 *
 * Landing gear is exempt up to the impulse of the craft arriving at `gearSinkLimit`. A part whose HP
 * reaches zero is reported by `flush()` so the simulation can detach it through the same path
 * as structural failures.
 */
export class DamageModel {
  /** Remaining HP per attached part (J). Infinity = indestructible. */
  readonly hp = new Map<string, number>();
  readonly maxHp = new Map<string, number>();
  private readonly windows = new Map<string, PairWindow>();
  private craft!: Craft;

  constructor(craft: Craft) {
    this.reset(craft);
  }

  /** Full HP for every part of (a possibly new) craft. */
  reset(craft: Craft): void {
    this.craft = craft;
    this.hp.clear();
    this.maxHp.clear();
    this.windows.clear();
    for (const p of craft.parts) {
      const hp =
        p.hp !== undefined
          ? p.hp > 0
            ? p.hp
            : Infinity
          : TUNING.hpPerKg * p.mass + TUNING.hpPerCubicMetre * partVolume(p);
      const reinforced = hp * (1 + 0.8 * Math.min(3, Math.max(0, Math.round(p.reinforce ?? 0)))) * Math.max(1, craft.def.armor ?? 1);
      this.hp.set(p.id, reinforced);
      this.maxHp.set(p.id, reinforced);
    }
  }

  /** Feed one contact-force event. */
  onContact(e: ContactForceInfo): void {
    let partId = this.craft.partIdForCollider(e.collider1);
    let other = e.collider2;
    if (partId === undefined) {
      partId = this.craft.partIdForCollider(e.collider2);
      other = e.collider1;
    }
    if (partId === undefined || !this.hp.has(partId)) return;
    // Rapier may report pairs below our threshold (it takes the lower of the two colliders').
    const weight = this.craft.massProps.mass * TUNING.gravity;
    if (e.totalForceMagnitude < TUNING.impactForceThreshold * weight) return;
    const key = `${partId}|${other}`;
    let w = this.windows.get(key);
    if (!w) {
      w = { partId, start: e.time, impulse: 0 };
      this.windows.set(key, w);
    }
    w.impulse += e.totalForceMagnitude * e.dt;
  }

  /**
   * Close windows older than `impactWindow` and apply their damage. Returns the parts whose HP
   * ran out (in the order they failed).
   */
  flush(time: number, force = false): ImpactFailure[] {
    const out: ImpactFailure[] = [];
    if (!this.windows.size) return out;
    const craftMass = this.craft.massProps.mass;
    for (const [key, w] of this.windows) {
      if (!force && time - w.start < TUNING.impactWindow - 1e-9) continue;
      this.windows.delete(key);
      const hp = this.hp.get(w.partId);
      if (hp === undefined || hp <= 0 || !Number.isFinite(hp)) continue;
      const part = this.craft.parts.find((p) => p.id === w.partId);
      if (!part) continue;
      const m = Math.max(0.01, part.mass);
      // Gear takes the impulse of the whole craft arriving at up to `gearSinkLimit` (a hard
      // landing) for free; any direction, so a wheel driven into a wall still breaks.
      const jTol = craftMass * (isGear(part) ? TUNING.gearSinkLimit : TUNING.impactSafeSpeed);
      let damage = Math.max(0, (w.impulse * w.impulse - jTol * jTol) / (2 * m));
      // Averaged over the whole window on purpose: rigid contacts resolve in one step, but a
      // real structure crushes over tens of ms, so J/dt would wildly overstate the load.
      const avgForce = w.impulse / TUNING.impactWindow;
      const strength = this.craft.strength.get(w.partId) ?? Infinity;
      if (w.impulse > jTol && avgForce > strength) damage += (this.maxHp.get(w.partId) ?? hp) * (avgForce / strength - 1);
      if (damage <= 0) continue;
      const left = hp - damage;
      this.hp.set(w.partId, Math.max(0, left));
      if (left <= 0) out.push({ partId: w.partId, load: avgForce, strength });
    }
    return out;
  }

  /** Forget a part (it broke off). */
  remove(partId: string): void {
    this.hp.delete(partId);
    this.maxHp.delete(partId);
    for (const [key, w] of this.windows) if (w.partId === partId) this.windows.delete(key);
  }

  /** Remaining HP fraction (0..1) of each attached, destructible part. */
  fractions(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, hp] of this.hp) {
      const max = this.maxHp.get(id) ?? hp;
      if (Number.isFinite(max) && max > 0) out[id] = Math.round((hp / max) * 100) / 100;
    }
    return out;
  }

  /** True if any part has taken damage. */
  get damaged(): boolean {
    for (const [id, hp] of this.hp) if (hp < (this.maxHp.get(id) ?? hp)) return true;
    return false;
  }
}
