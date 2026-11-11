import type { CraftDef } from '../craft/types.ts';
import { designWithAgent, type AgentTrace } from '../gen/agent.ts';
import { isAgenticOnly, isFree, JOBS, modelsForJob, priceLabel } from '../gen/catalog.ts';
import type { DesignResult } from '../gen/craftDesigner.ts';
import type { Library, LibraryEntry } from '../gen/library.ts';
import { supportsTools, type ModelInfo, type OpenRouter } from '../gen/openrouter.ts';
import { runFlightTest } from '../sim/flightTestClient.ts';

/**
 * The model test bench: the same prompt, settings and test card run through several designer
 * models (each one or more times), a few at a time, compared side by side. Every finished
 * design can be previewed on the turntable, saved to the hangar or flown; the comparison
 * downloads as CSV (the numbers) or JSON (the numbers plus every craft). Each run's agent trace
 * is kept as training data like any other run.
 */

export interface BenchHost {
  client: OpenRouter;
  library: Library;
  /** The catalog as the Studio loaded it. */
  models(): ModelInfo[];
  freeOnly(): boolean;
  /** The Studio's prompt box and the agent settings every run shares. */
  prompt(): string;
  settings(): { effort: 'low' | 'medium' | 'high'; tests: number; detail: boolean };
  /** Lock the Studio's own buttons while the bench runs (null unlocks). */
  lock(ctrl: AbortController | null): void;
  canGenerate(): boolean;
  status(text: string, kind?: 'info' | 'error'): void;
  spendChanged(): void;
  keepTrace(t: AgentTrace): void;
  preview(craft: CraftDef | null): void;
  select(entry: LibraryEntry): void;
  fly(): void;
  hangarChanged(): void;
}

type RunState = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';

interface BenchRun {
  model: string;
  /** 1-based repeat number for this model. */
  rep: number;
  state: RunState;
  activity: string;
  turn: number;
  tests: number;
  started: number;
  seconds: number;
  result: DesignResult | null;
  error: string;
  /** Latest craft (partial while streaming), for Watch. */
  craft: CraftDef | null;
  saved: LibraryEntry | null;
  row: HTMLTableRowElement;
}

const STORE = 'aerospace.bench.v1';
const MAX_MODELS = 8;

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | ((e: Event) => void)> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const short = (id: string) => (id.split('/')[1] ?? id).replace(/:free$/, '');

function save(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export class ModelBench {
  readonly root: HTMLDetailsElement;
  private chosen: string[] = [];
  private parallel = 2;
  private repeats = 1;
  private autoSave = false;
  private runs: BenchRun[] = [];
  private ctrl: AbortController | null = null;
  private watching: BenchRun | null = null;
  private readonly el: {
    filter: HTMLInputElement;
    pick: HTMLSelectElement;
    chips: HTMLElement;
    start: HTMLButtonElement;
    stop: HTMLButtonElement;
    table: HTMLTableSectionElement;
    summary: HTMLElement;
    exports: HTMLElement;
  };

  constructor(private readonly host: BenchHost) {
    this.load();
    const filter = h('input', { type: 'search', placeholder: 'Filter models (e.g. "qwen", "claude", "free")', 'aria-label': 'Filter bench models' }) as HTMLInputElement;
    filter.addEventListener('input', () => this.fillPicker());
    const pick = h('select', { 'aria-label': 'Model to add' }) as HTMLSelectElement;
    const parallel = h('select', { title: 'How many runs go at once (free models rate-limit: 2 is gentle)' }) as HTMLSelectElement;
    for (const n of [1, 2, 3, 4]) parallel.append(h('option', { value: String(n) }, `${n} at once`));
    parallel.value = String(this.parallel);
    parallel.addEventListener('change', () => { this.parallel = Number(parallel.value); this.persist(); });
    const repeats = h('select', { title: 'Runs per model, to see how consistent each one is' }) as HTMLSelectElement;
    for (const n of [1, 2, 3, 5]) repeats.append(h('option', { value: String(n) }, `${n}× each`));
    repeats.value = String(this.repeats);
    repeats.addEventListener('change', () => { this.repeats = Number(repeats.value); this.persist(); });
    const autoSave = h('input', { type: 'checkbox' }) as HTMLInputElement;
    autoSave.checked = this.autoSave;
    autoSave.addEventListener('change', () => { this.autoSave = autoSave.checked; this.persist(); });

    this.el = {
      filter,
      pick,
      chips: h('div', { class: 'chips bench-chips' }),
      start: h('button', { class: 'primary', onclick: () => void this.start() }, 'Run comparison'),
      stop: h('button', { class: 'hidden', onclick: () => this.ctrl?.abort() }, 'Stop all'),
      table: h('tbody'),
      summary: h('div', { class: 'small bench-summary' }),
      exports: h('div', { class: 'row hidden' }),
    };
    this.el.exports.append(
      h('button', { onclick: () => this.exportCsv() }, '⬇ Results (CSV)'),
      h('button', { onclick: () => this.exportJson() }, '⬇ Results + crafts (JSON)'),
    );

    this.root = h('details', { class: 'settings bench', id: 'model-bench' },
      h('summary', {}, 'Test bench: compare models'),
      h('div', { class: 'muted small' }, 'Run the prompt above through several designer models with the same settings (reasoning effort, flight-test budget, detail) and the same test card, then compare. Uses your session spend cap; free models cost nothing but rate-limit, so keep a couple at once.'),
      h('div', { class: 'row' }, filter),
      h('div', { class: 'row' }, pick, h('button', { onclick: () => this.add(pick.value) }, 'Add'), h('button', { title: 'Add the recommended free designers', onclick: () => this.addRecommended() }, '+ Recommended free')),
      this.el.chips,
      h('div', { class: 'row' }, parallel, repeats, h('label', { class: 'inline small', title: 'Put every design that passes into the hangar as it finishes' }, autoSave, ' Save passing designs to the hangar')),
      h('div', { class: 'row' }, this.el.start, this.el.stop),
      h('div', { class: 'bench-table-wrap' },
        h('table', { class: 'bench-table' },
          h('thead', {}, h('tr', {}, ...['Model / status', 'Score', 'Time', ''].map((t) => h('th', {}, t)))),
          this.el.table,
        ),
      ),
      this.el.summary,
      this.el.exports,
    );
    this.renderChips();
  }

  /** Call when the Studio's catalog (or the Free-only filter) changes. */
  refresh(): void {
    this.fillPicker();
    this.renderChips();
  }

  open(): void {
    this.root.open = true;
    this.root.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- choosing models

  private candidates(): ModelInfo[] {
    return modelsForJob(this.host.models(), 'designer', this.host.freeOnly()).filter((m) => supportsTools(m));
  }

  private fillPicker(): void {
    const q = this.el.filter.value.trim().toLowerCase();
    const list = this.candidates().filter((m) => !this.chosen.includes(m.id) && (!q || `${m.id} ${m.name} ${isFree(m) ? 'free' : ''}`.toLowerCase().includes(q)));
    this.el.pick.replaceChildren();
    for (const m of list.slice(0, 200)) {
      this.el.pick.append(h('option', { value: m.id }, `${m.name} · ${priceLabel(m)}${isAgenticOnly(m.id) ? ' · agent-only terms' : ''}`));
    }
    if (!list.length) this.el.pick.append(h('option', { value: '' }, this.host.models().length ? 'no matching tool-calling model' : 'loading models…'));
  }

  private add(id: string): void {
    if (!id || this.chosen.includes(id)) return;
    if (this.chosen.length >= MAX_MODELS) return this.host.status(`The bench takes up to ${MAX_MODELS} models.`, 'error');
    this.chosen.push(id);
    this.persist();
    this.renderChips();
    this.fillPicker();
  }

  private addRecommended(): void {
    const have = new Set(this.candidates().map((m) => m.id));
    for (const id of JOBS.designer.free) if (have.has(id)) this.add(id);
  }

  private renderChips(): void {
    const known = new Map(this.host.models().map((m) => [m.id, m]));
    this.el.chips.replaceChildren(...this.chosen.map((id) => {
      const m = known.get(id);
      return h('span', { class: 'chip bench-chip', title: id },
        `${m?.name ?? short(id)}${m ? ` · ${priceLabel(m)}` : ''}`,
        h('button', { 'aria-label': `Remove ${id}`, onclick: () => { this.chosen = this.chosen.filter((x) => x !== id); this.persist(); this.renderChips(); this.fillPicker(); } }, '✕'),
      );
    }));
    if (!this.chosen.length) this.el.chips.append(h('span', { class: 'muted small' }, 'No models yet: add two or more to compare.'));
  }

  // ---------------------------------------------------------------- running

  private async start(): Promise<void> {
    if (this.ctrl) return;
    const prompt = this.host.prompt().trim();
    if (!prompt) return this.host.status('Describe the vehicle in the prompt box first: every model gets the same prompt.', 'error');
    if (!this.host.canGenerate()) return this.host.status('Add your OpenRouter key under "Key & spend" first.', 'error');
    if (!this.chosen.length) return this.host.status('Add at least one model to the bench.', 'error');
    const settings = this.host.settings();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.host.lock(ctrl);
    this.el.start.disabled = true;
    this.el.stop.classList.remove('hidden');
    this.el.exports.classList.add('hidden');
    this.el.table.replaceChildren();
    this.watching = null;
    this.runs = [];
    for (let rep = 1; rep <= this.repeats; rep++) {
      for (const model of this.chosen) {
        const run: BenchRun = { model, rep, state: 'queued', activity: '', turn: 0, tests: 0, started: 0, seconds: 0, result: null, error: '', craft: null, saved: null, row: h('tr') };
        this.runs.push(run);
        this.el.table.append(run.row);
        this.render(run);
      }
    }
    this.host.status(`Bench: ${this.runs.length} run(s) of "${prompt}", ${this.parallel} at once.`);
    this.summarize();
    const queue = [...this.runs];
    const worker = async () => {
      for (let run = queue.shift(); run; run = queue.shift()) {
        if (ctrl.signal.aborted) { run.state = 'cancelled'; this.render(run); continue; }
        await this.runOne(run, prompt, settings, ctrl.signal);
        this.summarize();
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(this.parallel, this.runs.length) }, worker));
    } finally {
      this.ctrl = null;
      this.host.lock(null);
      this.el.start.disabled = false;
      this.el.stop.classList.add('hidden');
      this.el.exports.classList.remove('hidden');
      this.summarize();
      this.host.spendChanged();
      const done = this.runs.filter((r) => r.result).length;
      this.host.status(`Bench finished: ${this.runs.filter((r) => r.state === 'passed').length} passed, ${done} produced a design, of ${this.runs.length} run(s).`);
    }
  }

  private async runOne(run: BenchRun, prompt: string, settings: ReturnType<BenchHost['settings']>, signal: AbortSignal): Promise<void> {
    const models = this.host.models();
    run.state = 'running';
    run.started = performance.now();
    run.activity = 'starting…';
    this.render(run);
    const tick = setInterval(() => { run.seconds = (performance.now() - run.started) / 1000; this.render(run); }, 1000);
    try {
      const result = await designWithAgent(this.host.client, {
        model: run.model,
        designerFallbacks: [], // a bench run measures this model alone: no fail-over to others
        modelInfo: models.find((m) => m.id === run.model),
        effort: settings.effort,
        maxTests: settings.tests,
        prompt,
        detail: settings.detail,
        tester: runFlightTest,
        signal,
        onTrace: (t) => this.host.keepTrace(t),
        onEvent: (e) => {
          if (e.type === 'attempt' && e.attempt.report) { run.tests++; run.activity = `flight test: ${e.attempt.report.score}/100`; this.render(run); }
          this.host.spendChanged();
        },
      }, (e) => {
        run.turn = Math.max(run.turn, e.turn);
        if (e.type === 'tool') run.activity = `${e.name} → ${e.summary.slice(0, 60)}`;
        else if (e.type === 'calling') run.activity = `▸ ${e.name}${e.bytes ? ` ${(e.bytes / 1024).toFixed(1)} KB` : ''}`;
        else if (e.type === 'thinking' && !run.activity.startsWith('thinking')) run.activity = 'thinking…';
        else if (e.type === 'craft') {
          run.craft = e.craft;
          if (this.watching === run) this.host.preview(e.craft);
        }
        this.render(run);
      });
      run.result = result;
      run.craft = result.craft;
      run.state = result.report.passed ? 'passed' : 'failed';
      run.activity = result.report.passed ? 'passed' : (result.report.issues[0] ?? 'did not pass').slice(0, 80);
      if (this.autoSave && result.report.passed) this.saveRun(run);
    } catch (e) {
      const aborted = signal.aborted || (e instanceof DOMException && e.name === 'AbortError');
      run.state = aborted ? 'cancelled' : 'error';
      run.error = aborted ? '' : (e instanceof Error ? e.message : String(e));
      run.activity = aborted ? 'cancelled' : run.error.slice(0, 100);
    } finally {
      clearInterval(tick);
      run.seconds = (performance.now() - run.started) / 1000;
      this.render(run);
    }
  }

  // ---------------------------------------------------------------- results

  private render(run: BenchRun): void {
    const r = run.result?.report;
    const label = this.repeats > 1 ? `${short(run.model)} #${run.rep}` : short(run.model);
    const status = { queued: 'queued', running: `turn ${run.turn}`, passed: '✔ passed', failed: '✖ failed', error: '⚠ error', cancelled: 'cancelled' }[run.state];
    const actions = h('td', { class: 'bench-actions' });
    if (run.craft) {
      actions.append(h('button', {
        title: run.state === 'running' ? 'Watch this run build on the turntable' : 'Show this design on the turntable',
        class: this.watching === run ? 'on' : '',
        onclick: () => { this.watching = run; this.host.preview(run.craft); this.runs.forEach((x) => this.render(x)); },
      }, run.state === 'running' ? 'Watch' : 'View'));
    }
    if (run.result) {
      actions.append(
        h('button', { title: 'Save to the hangar', onclick: () => this.saveRun(run) }, run.saved ? 'Saved' : 'Save'),
        h('button', { title: 'Save and fly it', onclick: () => { const e = this.saveRun(run); this.host.select(e); this.host.fly(); } }, 'Fly'),
      );
    }
    run.row.className = `bench-${run.state}`;
    const parts = run.result ? String(run.result.craft.parts.length) : run.craft ? `${run.craft.parts.length}…` : '–';
    run.row.replaceChildren(
      h('td', { title: `${run.model} · ${run.error || run.activity}` },
        h('div', { class: 'bench-model' }, label),
        h('div', { class: 'bench-status' }, status),
        h('div', { class: 'muted bench-activity' }, run.activity),
        h('div', { class: 'muted bench-stats', title: 'Parts · model turns · flight tests' }, `${parts} parts · ${run.turn || 0} turns · ${run.tests} tests`)),
      h('td', { class: 'bench-score', title: 'Calm score / gusty crosswind score (advisory)' }, r ? `${r.score}` : '–', r?.gusty ? h('div', { class: 'muted' }, `gust ${r.gusty.score}`) : null),
      h('td', { class: 'muted' }, run.started ? `${Math.round(run.seconds)} s` : '–', h('div', {}, run.result ? `$${run.result.cost.toFixed(4)}` : '')),
      actions,
    );
  }

  private saveRun(run: BenchRun): LibraryEntry {
    if (run.saved) return run.saved;
    const r = run.result!;
    run.saved = this.host.library.add({
      name: `${r.name} (${short(run.model)})`,
      craft: r.craft,
      provenance: {
        source: 'generated', model: r.model, prompt: r.prompt, notes: `Test bench run${this.repeats > 1 ? ` #${run.rep}` : ''}. ${r.notes}`,
        score: r.report.score, rounds: r.attempts.length, costUsd: r.cost, createdAt: new Date().toISOString(),
      },
    });
    this.host.hangarChanged();
    this.render(run);
    return run.saved;
  }

  /** Per model: passes, best and mean score, mean time and cost; the leader by pass rate then score. */
  private stats() {
    return this.chosen.map((model) => {
      const rs = this.runs.filter((r) => r.model === model);
      const done = rs.filter((r) => r.result);
      const scores = done.map((r) => r.result!.report.score);
      const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
      return {
        model,
        runs: rs.length,
        finished: rs.filter((r) => ['passed', 'failed', 'error'].includes(r.state)).length,
        passed: rs.filter((r) => r.state === 'passed').length,
        errors: rs.filter((r) => r.state === 'error').length,
        best: scores.length ? Math.max(...scores) : NaN,
        meanScore: mean(scores),
        meanSeconds: mean(rs.filter((r) => r.state !== 'queued' && r.state !== 'cancelled').map((r) => r.seconds)),
        cost: done.reduce((s, r) => s + r.result!.cost, 0),
      };
    }).filter((s) => s.runs > 0);
  }

  private summarize(): void {
    const st = this.stats();
    if (!st.length) { this.el.summary.replaceChildren(); return; }
    const ranked = [...st].filter((s) => s.finished).sort((a, b) => b.passed / b.runs - a.passed / a.runs || (b.meanScore || 0) - (a.meanScore || 0) || a.meanSeconds - b.meanSeconds);
    const f = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '–');
    this.el.summary.replaceChildren(
      h('div', {}, ranked.length ? `Leader: ${short(ranked[0].model)} (${ranked[0].passed}/${ranked[0].runs} passed, mean score ${f(ranked[0].meanScore)})` : 'Running…'),
      ...st.map((s) => h('div', { class: 'muted' }, `${short(s.model)}: ${s.passed}/${s.runs} passed${s.errors ? `, ${s.errors} error(s)` : ''} · best ${f(s.best)} · mean ${f(s.meanScore)} · ${f(s.meanSeconds)} s · $${s.cost.toFixed(4)}`)),
    );
  }

  private rows() {
    return this.runs.map((r) => ({
      model: r.model, run: r.rep, state: r.state,
      score: r.result?.report.score ?? null, gusty: r.result?.report.gusty?.score ?? null,
      parts: r.result?.craft.parts.length ?? null, turns: r.turn || null, flightTests: r.tests || null,
      seconds: r.started ? +r.seconds.toFixed(1) : null, costUsd: r.result ? +r.result.cost.toFixed(5) : null,
      name: r.result?.name ?? null, error: r.error || null,
    }));
  }

  private exportCsv(): void {
    const rows = this.rows();
    if (!rows.length) return;
    const cols = Object.keys(rows[0]) as Array<keyof (typeof rows)[number]>;
    const cell = (v: unknown) => (v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    save(`bench-${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.csv`, [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'), 'text/csv');
  }

  private exportJson(): void {
    const s = this.host.settings();
    const out = {
      prompt: this.host.prompt().trim(), settings: s, at: new Date().toISOString(),
      summary: this.stats(),
      runs: this.runs.map((r, i) => ({ ...this.rows()[i], craft: r.result?.craft ?? null, notes: r.result?.notes ?? null, issues: r.result?.report.issues ?? null })),
    };
    save(`bench-${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.json`, JSON.stringify(out, null, 2), 'application/json');
  }

  // ---------------------------------------------------------------- prefs

  private load(): void {
    try {
      const p = JSON.parse(localStorage.getItem(STORE) ?? '{}');
      this.chosen = Array.isArray(p.models) ? p.models.filter((x: unknown) => typeof x === 'string').slice(0, MAX_MODELS) : [];
      this.parallel = [1, 2, 3, 4].includes(p.parallel) ? p.parallel : 2;
      this.repeats = [1, 2, 3, 5].includes(p.repeats) ? p.repeats : 1;
      this.autoSave = !!p.autoSave;
    } catch { /* storage blocked */ }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORE, JSON.stringify({ models: this.chosen, parallel: this.parallel, repeats: this.repeats, autoSave: this.autoSave }));
    } catch { /* storage blocked */ }
  }
}
