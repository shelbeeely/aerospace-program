import type { CraftDef } from '../craft/types.ts';
import { defaultModel, isFree, modelsForTask, priceLabel, TASKS, type GenTask } from '../gen/catalog.ts';
import { designCraft, type DesignResult } from '../gen/craftDesigner.ts';
import { fromImportJson, toExportJson, type Library, type LibraryEntry } from '../gen/library.ts';
import { paintLivery } from '../gen/livery.ts';
import { OpenRouterError, type ModelInfo, type OpenRouter } from '../gen/openrouter.ts';
import { formatReport } from '../sim/flightTest.ts';

export interface StudioHost {
  client: OpenRouter;
  library: Library;
  /** The library entry currently being flown (null = built-in trainer). */
  current(): { craft: CraftDef; entryId: string | null };
  /** Summary of the player's flight in the current craft. */
  flightNotes(): string;
  /** Put a craft on the runway. */
  fly(entry: LibraryEntry | null): void;
  /** Re-apply the livery of the current entry after painting. */
  applyLivery(dataUrl: string | null): void;
}

const SUGGESTIONS = [
  'a slow, forgiving bush plane with huge wings',
  'a twin-engine cargo plane',
  'a canard racer with a pusher prop',
  'a long-winged motor glider',
  'a tiny aerobatic biplane-style trainer',
];

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const PREF_KEY = 'aerospace.studio.models.v1';

/**
 * The generation workflow in-game: pick a model per task, describe a craft, watch it get
 * designed, validated and flight-tested, fly it, then refine it with notes from your own
 * flight. Every result lands in the hangar library with its provenance.
 */
export class Studio {
  readonly root: HTMLElement;
  private models: ModelInfo[] = [];
  private selected: Partial<Record<GenTask, string>> = {};
  private busy: AbortController | null = null;
  private lastResult: DesignResult | null = null;

  private readonly el: {
    status: HTMLElement;
    spend: HTMLElement;
    designer: HTMLSelectElement;
    designerInfo: HTMLElement;
    painter: HTMLSelectElement;
    prompt: HTMLTextAreaElement;
    rounds: HTMLSelectElement;
    log: HTMLOListElement;
    result: HTMLElement;
    liveryPrompt: HTMLInputElement;
    hangar: HTMLElement;
    buttons: HTMLButtonElement[];
    cancel: HTMLButtonElement;
  };

  constructor(private readonly host: StudioHost) {
    try {
      this.selected = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}');
    } catch {
      /* ignore */
    }
    const designer = h('select', { onchange: () => this.pick('design', designer.value) });
    const painter = h('select', { onchange: () => this.pick('livery', painter.value) });
    const prompt = h('textarea', {
      rows: '3',
      placeholder: 'Describe a craft… (Ctrl+Enter to design)',
      onkeydown: (e) => {
        const k = e as KeyboardEvent;
        if (k.key === 'Enter' && (k.ctrlKey || k.metaKey)) this.design(false);
      },
    });
    const rounds = h('select', { title: 'Model calls allowed, including self-repair after flight tests' });
    for (const n of [1, 2, 3, 4, 5]) rounds.append(h('option', { value: String(n) }, `${n} round${n > 1 ? 's' : ''}`));
    rounds.value = '3';
    const designBtn = h('button', { class: 'primary', onclick: () => this.design(false) }, 'Design new');
    const refineBtn = h('button', { onclick: () => this.design(true), title: 'Modify the craft you are flying, using your flight as feedback' }, 'Refine current');
    const cancel = h('button', { class: 'hidden', onclick: () => this.busy?.abort() }, 'Cancel');
    const liveryPrompt = h('input', { type: 'text', placeholder: 'e.g. racing stripes, red and cream' });
    const paintBtn = h('button', { onclick: () => this.paint() }, 'Paint');
    const importInput = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', onchange: () => this.importFile(importInput) });

    this.el = {
      status: h('div', { class: 'studio-status' }, 'Loading models…'),
      spend: h('span', { class: 'muted' }),
      designer,
      designerInfo: h('div', { class: 'muted small' }),
      painter,
      prompt,
      rounds,
      log: h('ol', { class: 'studio-log' }),
      result: h('div', { class: 'studio-result hidden' }),
      liveryPrompt,
      hangar: h('div', { class: 'studio-hangar' }),
      buttons: [designBtn, refineBtn, paintBtn],
      cancel,
    };

    const chips = h('div', { class: 'chips' });
    for (const s of SUGGESTIONS) chips.append(h('button', { class: 'chip', onclick: () => ((prompt.value = s), prompt.focus()) }, s));

    this.root = h(
      'div',
      { id: 'studio', class: 'panel' },
      h('div', { class: 'studio-head' }, h('h3', {}, '✦ STUDIO'), this.el.spend),
      this.el.status,
      h('section', {},
        h('label', {}, TASKS.design.label, designer),
        this.el.designerInfo,
        prompt,
        chips,
        h('div', { class: 'row' }, rounds, designBtn, refineBtn, cancel),
        this.el.log,
        this.el.result,
      ),
      h('section', {},
        h('h4', {}, 'Livery'),
        h('label', {}, TASKS.livery.label, painter),
        h('div', { class: 'row' }, liveryPrompt, paintBtn),
      ),
      h('section', {},
        h('h4', {}, 'Hangar'),
        this.el.hangar,
        h('div', { class: 'row' }, h('button', { onclick: () => importInput.click() }, 'Import JSON…'), importInput),
      ),
    );
    document.body.append(this.root);
    this.renderHangar();
    void this.loadModels();
  }

  toggle(): void {
    this.root.classList.toggle('hidden');
  }

  private pick(task: GenTask, id: string): void {
    this.selected[task] = id;
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(this.selected));
    } catch {
      /* ignore */
    }
    this.renderModelInfo();
  }

  private async loadModels(): Promise<void> {
    try {
      this.models = await this.host.client.models();
    } catch (e) {
      this.setStatus(
        `Can't reach OpenRouter through the dev server (${e instanceof Error ? e.message : e}). ` +
          'Run "npm run dev" with OPENROUTER_API_KEY set (see .env.example). Flying still works.',
        'error',
      );
      return;
    }
    this.fillSelect(this.el.designer, 'design');
    this.fillSelect(this.el.painter, 'livery');
    this.renderModelInfo();
    this.setStatus(`${this.models.length} models available.`);
  }

  private fillSelect(sel: HTMLSelectElement, task: GenTask): void {
    const list = modelsForTask(this.models, task);
    const preferred = new Set(TASKS[task].preferred);
    const groups: Array<[string, ModelInfo[]]> = [
      ['Recommended', list.filter((m) => preferred.has(m.id))],
      ['Free', list.filter((m) => isFree(m) && !preferred.has(m.id))],
      ['All (newest first)', list.filter((m) => !isFree(m) && !preferred.has(m.id))],
    ];
    sel.replaceChildren();
    for (const [label, ms] of groups) {
      if (!ms.length) continue;
      const g = h('optgroup', { label });
      for (const m of ms) g.append(h('option', { value: m.id }, `${m.name} · ${priceLabel(m)}`));
      sel.append(g);
    }
    const want = this.selected[task];
    sel.value = want && list.some((m) => m.id === want) ? want : (defaultModel(this.models, task) ?? '');
    this.selected[task] = sel.value;
  }

  private renderModelInfo(): void {
    const m = this.models.find((x) => x.id === this.selected.design);
    this.el.designerInfo.textContent = m ? `${m.id} · ${Math.round(m.contextLength / 1000)}K ctx · ${priceLabel(m)}` : '';
  }

  private setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
    this.el.status.textContent = text;
    this.el.status.classList.toggle('error', kind === 'error');
  }

  private updateSpend(): void {
    this.el.spend.textContent = `session $${this.host.client.spent.toFixed(4)}`;
  }

  private setBusy(ctrl: AbortController | null): void {
    this.busy = ctrl;
    for (const b of this.el.buttons) b.disabled = !!ctrl;
    this.el.cancel.classList.toggle('hidden', !ctrl);
  }

  private logLine(text: string, cls = ''): HTMLLIElement {
    const li = h('li', cls ? { class: cls } : {}, text);
    this.el.log.append(li);
    li.scrollIntoView({ block: 'nearest' });
    return li;
  }

  private async design(refine: boolean): Promise<void> {
    if (this.busy) return;
    const model = this.selected.design;
    const text = this.el.prompt.value.trim();
    if (!model) return this.setStatus('Pick a designer model first.', 'error');
    if (!text && !refine) return this.setStatus('Describe the craft you want.', 'error');
    const cur = this.host.current();
    const ctrl = new AbortController();
    this.setBusy(ctrl);
    this.el.log.replaceChildren();
    this.el.result.classList.add('hidden');
    try {
      const result = await designCraft(this.host.client, {
        model,
        prompt: text || 'Fix whatever made it fly badly.',
        base: refine ? cur.craft : undefined,
        feedback: refine ? this.host.flightNotes() : undefined,
        maxIterations: Number(this.el.rounds.value),
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === 'status') this.setStatus(e.message);
          else {
            const a = e.attempt;
            if (a.error) this.logLine(`Round ${a.iteration}: ${a.error}`, 'bad');
            else if (a.validationErrors) this.logLine(`Round ${a.iteration}: ${a.validationErrors.length} format errors, asking for a fix`, 'warn');
            else if (a.report) this.logLine(`Round ${a.iteration}: "${a.craft?.name}" scored ${a.report.score}/100`, a.report.passed ? 'good' : 'warn');
          }
          this.updateSpend();
        },
      });
      this.lastResult = result;
      const entry = this.host.library.add({
        name: result.name,
        craft: result.craft,
        provenance: {
          source: 'generated',
          model: result.model,
          prompt: result.prompt,
          notes: result.notes,
          score: result.report.score,
          rounds: result.attempts.length,
          costUsd: result.cost,
          createdAt: new Date().toISOString(),
          parentId: refine ? cur.entryId ?? undefined : undefined,
        },
      });
      this.showResult(result, entry);
      this.renderHangar();
      this.host.fly(entry);
      this.setStatus(`"${result.name}" is on the runway. Fly it, then hit Refine with what you'd change.`);
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      this.setStatus(aborted ? 'Cancelled.' : `Design failed: ${explain(e)}`, aborted ? 'info' : 'error');
    } finally {
      this.setBusy(null);
      this.updateSpend();
    }
  }

  private showResult(r: DesignResult, entry: LibraryEntry): void {
    const pre = h('pre', {}, formatReport(r.report));
    this.el.result.replaceChildren(
      h('div', { class: 'row' }, h('b', {}, r.name), h('span', { class: r.report.passed ? 'good' : 'warn' }, ` ${r.report.score}/100`)),
      r.notes ? h('div', { class: 'muted' }, r.notes) : '',
      h('details', {}, h('summary', {}, 'Flight test report'), pre),
      h('div', { class: 'row' },
        h('button', { onclick: () => this.host.fly(entry) }, 'Fly again'),
        h('span', { class: 'muted small' }, `${r.attempts.length} round(s) · $${r.cost.toFixed(4)}`),
      ),
    );
    this.el.result.classList.remove('hidden');
  }

  private async paint(): Promise<void> {
    if (this.busy) return;
    const model = this.selected.livery;
    const cur = this.host.current();
    if (!model) return this.setStatus('Pick a painter (image) model first.', 'error');
    const style = this.el.liveryPrompt.value.trim() || 'classic aviation stripes';
    const ctrl = new AbortController();
    this.setBusy(ctrl);
    this.setStatus(`Painting with ${model}…`);
    try {
      const res = await paintLivery(this.host.client, model, style, cur.craft.name, ctrl.signal);
      this.host.applyLivery(res.image);
      if (cur.entryId) {
        const e = this.host.library.get(cur.entryId);
        this.host.library.update(cur.entryId, {
          livery: res.image,
          provenance: { ...e!.provenance, liveryModel: res.model, liveryPrompt: style },
        });
      }
      this.setStatus(`Painted ($${res.cost.toFixed(4)}).${cur.entryId ? '' : ' (The built-in trainer\'s livery is not saved.)'}`);
      this.renderHangar();
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      this.setStatus(aborted ? 'Cancelled.' : `Painting failed: ${explain(e)}`, aborted ? 'info' : 'error');
    } finally {
      this.setBusy(null);
      this.updateSpend();
    }
  }

  renderHangar(): void {
    const cur = this.host.current().entryId;
    const rows: HTMLElement[] = [
      h('div', { class: `hangar-row${cur === null ? ' active' : ''}` },
        h('span', { class: 'name' }, 'Trainer T-1'),
        h('span', { class: 'muted small' }, 'built-in'),
        h('button', { onclick: () => this.host.fly(null) }, 'Fly'),
      ),
    ];
    for (const e of this.host.library.list()) {
      const p = e.provenance;
      const meta = [p.score !== undefined ? `${p.score}/100` : '', p.model?.split('/')[1]?.replace(/:free$/, '') ?? p.source].filter(Boolean).join(' · ');
      rows.push(
        h('div', { class: `hangar-row${cur === e.id ? ' active' : ''}`, title: p.prompt ?? '' },
          e.livery ? h('img', { src: e.livery, alt: '' }) : null,
          h('span', { class: 'name' }, e.name),
          h('span', { class: 'muted small' }, meta),
          h('button', { onclick: () => this.host.fly(e) }, 'Fly'),
          h('button', { title: 'Download JSON', onclick: () => download(`${e.name}.json`, toExportJson(e)) }, '⤓'),
          h('button', { title: 'Delete', onclick: () => { this.host.library.remove(e.id); this.renderHangar(); } }, '✕'),
        ),
      );
    }
    this.el.hangar.replaceChildren(...rows);
  }

  private async importFile(input: HTMLInputElement): Promise<void> {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const entry = this.host.library.add(fromImportJson(await f.text()));
      this.renderHangar();
      this.host.fly(entry);
      this.setStatus(`Imported "${entry.name}".`);
    } catch (e) {
      this.setStatus(`Import failed: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  /** Expose the last design for debugging in the console. */
  get last(): DesignResult | null {
    return this.lastResult;
  }
}

/** Error text with a hint for the common billing/limit failures. */
function explain(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof OpenRouterError && (e.status === 402 || e.status === 403))
    return `${msg} (Pick a free model, or raise the key's credit/limit on openrouter.ai.)`;
  if (e instanceof OpenRouterError && e.status === 429) return `${msg} (Rate limited: wait a bit or pick another model.)`;
  return msg;
}

function download(name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name.replace(/[^\w.-]+/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
