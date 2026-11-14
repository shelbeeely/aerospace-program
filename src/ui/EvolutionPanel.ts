import { BIT_STYLE_CHOICES } from '../people/bitStyle.ts';
import { BEHAVIOUR_GENES, COMBAT_GENES, GENE_LABEL, STYLE_FIELDS, type Gene, type StyleField } from '../people/genome.ts';
import { DEATH_CAUSES } from '../sim/evolution.ts';
import { CITY } from '../sim/layout.ts';
import type { EvolutionLab, LabSample, LabSettings } from '../sim/evolutionLab.ts';
import { CHART, GeneChart, ShareChart } from './EvolutionCharts.ts';

/**
 * What evolution looks like as numbers: the census of a population (how many, how many
 * generations, founder lines left, births and deaths by cause), the mean of each behaviour gene
 * over time, the shares of one look over time, and a table of where each gene stands now.
 *
 * Used twice: by the explorer's Evolution Lab (with controls: pressures, seed, speed) and,
 * read-only, by the K inspector's Bits tab over the game's own streets.
 */
export type LabSpeed = 0 | 1 | 10 | 100 | 'turbo';

export interface LabControls {
  lab: EvolutionLab;
  speed(): LabSpeed;
  setSpeed(s: LabSpeed): void;
}

const STYLE_LABEL: Record<StyleField, string> = { light: 'Idle light', size: 'Size', idle: 'Idle figure', spin: 'Spin' };
const CAUSE_LABEL: Record<string, string> = { 'run-over': 'run over', blast: 'blasts', 'old-age': 'old age', spent: 'ran dry', shot: 'shot' };

const SLIDERS: Array<{ key: keyof LabSettings; label: string; min: number; max: number; step: number; fmt: (v: number) => string }> = [
  { key: 'traffic', label: 'Kerb traffic (/lot/min)', min: 0, max: 3, step: 0.25, fmt: (v) => v.toFixed(2) },
  { key: 'blasts', label: 'Blasts (/min)', min: 0, max: 6, step: 0.5, fmt: (v) => v.toFixed(1) },
  { key: 'scarcity', label: 'Scarcity (× drain)', min: 0.5, max: 2.5, step: 0.1, fmt: (v) => v.toFixed(1) },
  { key: 'mutation', label: 'Mutation (/gene)', min: 0, max: 0.3, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'lifespan', label: 'Lifespan (s)', min: 300, max: 1200, step: 50, fmt: (v) => v.toFixed(0) },
  { key: 'war', label: 'War: enemy defence', min: 0, max: 1, step: 0.05, fmt: (v) => (v > 0 ? v.toFixed(2) : 'peace') },
];

export class EvolutionView {
  readonly root: HTMLDivElement;
  private readonly stats: HTMLTableElement;
  private readonly genes = new GeneChart('Gene means over time');
  private readonly combat = new GeneChart('Sapper genes over time (nerve, stealth, craft)');
  private readonly shares = new ShareChart('Looks over time');
  private readonly table: HTMLTableElement;
  private field: StyleField = 'light';
  private readonly speedButtons = new Map<LabSpeed, HTMLButtonElement>();

  constructor(private readonly history: () => readonly LabSample[], private readonly controls: LabControls | null = null, onReset: (() => void) | null = null) {
    this.root = document.createElement('div');
    this.root.className = 'evo-view';
    if (controls) this.root.append(this.buildControls(controls));
    this.stats = document.createElement('table');
    this.stats.className = 'arch-kv evo-stats';
    this.root.append(this.h4('Census'), this.stats);
    this.root.append(this.genes.root, this.combat.root);
    const pick = document.createElement('select');
    pick.setAttribute('aria-label', 'Look to chart');
    for (const f of STYLE_FIELDS) {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = STYLE_LABEL[f];
      pick.append(o);
    }
    pick.addEventListener('change', () => { this.field = pick.value as StyleField; this.refresh(); });
    const row = document.createElement('div');
    row.className = 'arch-row';
    row.append(document.createTextNode('Look: '), pick);
    this.root.append(row, this.shares.root);
    this.table = document.createElement('table');
    this.table.className = 'arch-kv evo-table';
    this.root.append(this.h4('Now (and where each gene started)'), this.table);
    if (onReset) {
      const b = document.createElement('button');
      b.textContent = 'Reset evolution';
      b.title = 'Forget every gene pool: the Bits start again from their founders';
      b.addEventListener('click', () => { if (confirm('Forget every gene pool? The Bits start again from their founders.')) onReset(); });
      const r = document.createElement('div');
      r.className = 'arch-row';
      r.append(b);
      this.root.append(r);
    }
  }

  private h4(text: string): HTMLHeadingElement {
    const h = document.createElement('h4');
    h.textContent = text;
    return h;
  }

  private buildControls(c: LabControls): HTMLDivElement {
    const box = document.createElement('div');
    box.append(this.h4('Pressures'));
    for (const s of SLIDERS) {
      const row = document.createElement('label');
      row.className = 'arch-slider';
      const name = document.createElement('span');
      name.textContent = s.label;
      name.style.textAlign = 'left';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(s.min);
      input.max = String(s.max);
      input.step = String(s.step);
      input.value = String(c.lab.settings[s.key]);
      const val = document.createElement('span');
      val.textContent = s.fmt(Number(input.value));
      input.addEventListener('input', () => {
        val.textContent = s.fmt(Number(input.value));
        c.lab.tune({ [s.key]: Number(input.value) });
      });
      row.append(name, input, val);
      box.append(row);
    }
    const run = document.createElement('div');
    run.className = 'arch-row';
    for (const [sp, label] of [[0, 'Pause'], [1, '1×'], [10, '10×'], [100, '100×'], ['turbo', 'Turbo']] as Array<[LabSpeed, string]>) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => { c.setSpeed(sp); this.refresh(); });
      this.speedButtons.set(sp, b);
      run.append(b);
    }
    box.append(this.h4('Run'), run);
    const again = document.createElement('div');
    again.className = 'arch-row';
    const seed = document.createElement('input');
    seed.type = 'number';
    seed.value = String(c.lab.settings.seed);
    seed.setAttribute('aria-label', 'Seed');
    const hub = document.createElement('select');
    hub.setAttribute('aria-label', 'District');
    CITY.hubs.forEach((_, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `Downtown ${i + 1}`;
      hub.append(o);
    });
    hub.value = String(c.lab.settings.hub);
    const reset = document.createElement('button');
    reset.textContent = 'Start again';
    reset.addEventListener('click', () => { c.lab.reset({ seed: Number(seed.value) | 0, hub: Number(hub.value) }); this.refresh(); });
    const seedLabel = document.createElement('label');
    seedLabel.append(document.createTextNode('Seed '), seed);
    again.append(seedLabel, hub, reset);
    box.append(again);
    return box;
  }

  /** Redraw from the history as it stands. */
  refresh(): void {
    const h = this.history();
    const last = h[h.length - 1];
    if (this.controls) for (const [sp, b] of this.speedButtons) b.classList.toggle('on', sp === this.controls.speed());
    this.stats.replaceChildren();
    const kv = (k: string, v: string) => {
      const tr = this.stats.insertRow();
      tr.insertCell().textContent = k;
      tr.insertCell().textContent = v;
    };
    if (!last) {
      kv('Bits', 'nobody in view yet');
    } else {
      if (this.controls) kv('Simulated', `${Math.round(last.t / 60)} min (${this.controls.lab.blasts} blasts)`);
      kv('Bits alive', String(last.count));
      kv('Generation', `${last.maxGen} deepest · ${last.meanGen.toFixed(1)} mean`);
      kv('Founder lines', String(last.lineages));
      kv('Born', String(last.births));
      kv('Died', DEATH_CAUSES.filter((c) => last.deaths[c] > 0).map((c) => `${last.deaths[c]} ${CAUSE_LABEL[c]}`).join(' · ') || 'none yet');
      const w = last.combat;
      if (w.sent > 0) kv('Sappers', `${w.sent} sent · ${w.set} charges set · ${w.shot} shot · ${w.duds} duds · ${w.home} veterans home`);
      kv('Could set', `a sure demolition ${Math.round(last.tiers.demo * 100)}% · EMP ${Math.round(last.tiers.emp * 100)}% · nuke ${Math.round(last.tiers.nuke * 100)}%`);
    }
    const times = h.map((s) => s.t);
    this.genes.set(times, BEHAVIOUR_GENES.map((g, i) => ({ label: GENE_LABEL[g], color: CHART.series[i], values: h.map((s) => s.mean[g]) })));
    // Slots 4-6, so no colour means two genes on one screen.
    this.combat.set(times, COMBAT_GENES.map((g, i) => ({ label: GENE_LABEL[g], color: CHART.series[3 + i], values: h.map((s) => s.mean[g]) })));
    const choices = BIT_STYLE_CHOICES[this.field] as ReadonlyArray<readonly [string, string]>;
    this.shares.set(times, choices.map(([c, label], i) => ({ label, color: CHART.series[i], values: h.map((s) => s.style[this.field][c] ?? 0) })));
    // The table view: every gene's mean now, and the look shares now.
    this.table.replaceChildren();
    if (last) {
      for (const g of [...BEHAVIOUR_GENES, ...COMBAT_GENES] as Gene[]) {
        const tr = this.table.insertRow();
        tr.insertCell().textContent = GENE_LABEL[g];
        const first = h[0].mean[g];
        tr.insertCell().textContent = `${last.mean[g].toFixed(2)} (from ${first.toFixed(2)})`;
      }
      for (const f of STYLE_FIELDS) {
        const tr = this.table.insertRow();
        tr.insertCell().textContent = STYLE_LABEL[f];
        tr.insertCell().textContent = (BIT_STYLE_CHOICES[f] as ReadonlyArray<readonly [string, string]>).map(([c, label]) => `${label} ${Math.round((last.style[f][c] ?? 0) * 100)}%`).join(' · ');
      }
    }
  }
}
