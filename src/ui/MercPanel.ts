import type { CraftDef } from '../craft/types.ts';
import { MAX_MERCS } from '../sim/aiTraffic.ts';
import { hireable, mercPrice } from '../sim/mercenaries.ts';
import type { Simulation } from '../sim/Simulation.ts';

/**
 * The Mercenaries panel (' key, or touch More → "Mercenaries"): your credits, the aircraft you
 * can hire for a five-minute contract and what each costs, and the contracts running now.
 * Credits come from shooting down the other sides' aircraft and turrets and capturing districts.
 */
export class MercPanel {
  readonly root: HTMLElement;
  private readonly credits: HTMLElement;
  private readonly list: HTMLElement;
  private readonly active: HTMLElement;
  private readonly status: HTMLElement;
  private timer = 0;
  private shown = '';

  constructor(
    private readonly sim: Simulation,
    /** Designs on offer: the built-in aircraft, plus your own in single player. */
    private readonly designs: () => CraftDef[],
    private readonly toast: (text: string) => void,
  ) {
    const el = (tag: string, cls = '', text = '') => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    this.root = el('div', 'panel hidden');
    this.root.id = 'merc-panel';
    const close = el('button', 'panel-close', 'Close ✕');
    close.addEventListener('click', () => this.toggle(false));
    const title = el('h3', '', 'MERCENARIES');
    this.credits = el('div', 'merc-credits');
    const note = el('p', 'muted small', `Hire up to ${MAX_MERCS} wingmen for 5 minutes. They fly for you whatever your team: escort, go for anything attacking you, then for your enemies nearby. Credits: 100 per aircraft, 150 per turret, 300 per district captured.`);
    this.active = el('div', 'merc-active');
    this.list = el('div', 'merc-list');
    this.status = el('p', 'merc-status small');
    this.root.append(close, title, this.credits, note, this.active, this.list, this.status);
    document.body.append(this.root);
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  toggle(on = !this.visible): void {
    this.root.classList.toggle('hidden', !on);
    this.shown = '';
    if (on) this.refresh(true);
  }

  /** Call every frame; it redraws a few times a second while open. */
  refresh(force = false): void {
    if (!this.visible) return;
    const now = performance.now();
    if (!force && now - this.timer < 250) return;
    this.timer = now;
    const sim = this.sim;
    this.credits.textContent = `${sim.credits} credits`;
    const mercs = sim.airTraffic.mercs();
    this.active.textContent = mercs.length
      ? `Hired: ${mercs.map((f) => `${f.name} ${clock(f.mercUntil - sim.time)}`).join(' · ')}`
      : 'No one hired.';
    const offers = this.designs().filter(hireable);
    const key = `${sim.credits}|${mercs.length}|${offers.map((d) => d.name).join(',')}`;
    if (key === this.shown) return;
    this.shown = key;
    this.list.replaceChildren();
    for (const def of offers) {
      const price = mercPrice(def);
      const row = document.createElement('div');
      row.className = 'merc-row';
      const name = document.createElement('span');
      name.textContent = def.name;
      const cost = document.createElement('small');
      cost.textContent = `${price} cr`;
      const hire = document.createElement('button');
      hire.textContent = 'Hire';
      hire.disabled = sim.credits < price || mercs.length >= MAX_MERCS;
      hire.addEventListener('click', () => {
        const why = sim.hireMercenary(def);
        this.status.textContent = why ?? `${def.name} is on its way.`;
        if (!why) this.toast(`${def.name} hired: on its way`);
        this.refresh(true);
      });
      row.append(name, cost, hire);
      this.list.append(row);
    }
  }
}

const clock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${Math.floor(Math.max(0, s) % 60).toString().padStart(2, '0')}`;
