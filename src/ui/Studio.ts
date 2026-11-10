import { BUILTINS, type BuiltinCraft } from '../craft/builtins.ts';
import type { CraftDef } from '../craft/types.ts';
import { defaultModel, fallbacksFor, isFree, JOBS, modelsForJob, priceLabel, type JobId } from '../gen/catalog.ts';
import { designCraft, type DesignResult } from '../gen/craftDesigner.ts';
import { fromImportJson, toExportJson, type Library, type LibraryEntry } from '../gen/library.ts';
import { composeMusic, MUSIC_STYLES } from '../gen/music.ts';
import {
  DIRECT_BASE_URL,
  OpenRouter,
  OpenRouterError,
  PROXY_BASE_URL,
  type ModelInfo,
} from '../gen/openrouter.ts';
import { formatReport } from '../sim/flightTest.ts';
import { runFlightTest } from '../sim/flightTestClient.ts';

export interface StudioHost {
  client: OpenRouter;
  library: Library;
  /** The library entry currently being flown (null = built-in trainer). */
  current(): { craft: CraftDef; entryId: string | null };
  /** Summary of the player's flight in the current craft. */
  flightNotes(): string;
  /** Show a craft on the hangar turntable (null = built-in trainer). */
  select(entry: LibraryEntry | null): void;
  /** Take the selected craft flying: switch to flight mode and reset to the runway. */
  fly(): void;
}

const SUGGESTIONS = [
  'a long, low light cycle with a jetwall',
  'a six-wheeled armoured hauler that skid-steers',
  'a ring-winged interceptor jet',
  'a flying-wing glider with a pusher prop',
  'a tandem-rotor heavy lifter',
  'a slow survey blimp with a gondola of light',
  'a three-wheeled desert racer',
  'a canard delta spaceplane that reaches orbit',
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

const PREFS_KEY = 'aerospace.studio.prefs.v2';
export const KEY_STORAGE = 'aerospace.openrouter.key';
export const CAP_STORAGE = 'aerospace.openrouter.cap';

interface Prefs {
  freeOnly: boolean;
  jobs: Partial<Record<JobId, string>>;
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return { freeOnly: p.freeOnly ?? true, jobs: p.jobs ?? {} };
  } catch {
    return { freeOnly: true, jobs: {} };
  }
}

/**
 * The generation workflow in-game. A crew of models, one per job (designer, engineer,
 * composer), free by default. Describe a craft, watch it get designed, validated,
 * flight-tested and repaired, fly it, refine it with notes from your own flight,
 * score it. Every result lands in the hangar with its provenance.
 */
export class Studio {
  readonly root: HTMLElement;
  private models: ModelInfo[] = [];
  private prefs = loadPrefs();
  private busy: AbortController | null = null;
  private lastResult: DesignResult | null = null;
  private readonly selects = {} as Record<JobId, HTMLSelectElement>;
  private readonly audioEl: HTMLAudioElement;

  private readonly el: {
    status: HTMLElement;
    spend: HTMLElement;
    keyInput: HTMLInputElement;
    keyNote: HTMLElement;
    settings: HTMLDetailsElement;
    prompt: HTMLTextAreaElement;
    rounds: HTMLSelectElement;
    drafts: HTMLSelectElement;
    log: HTMLOListElement;
    result: HTMLElement;
    musicPrompt: HTMLInputElement;
    musicStyle: HTMLSelectElement;
    musicInfo: HTMLElement;
    hangar: HTMLElement;
    buttons: HTMLButtonElement[];
    cancel: HTMLButtonElement;
  };

  constructor(private readonly host: StudioHost) {
    const crew = h('div', { class: 'crew' });
    for (const job of Object.keys(JOBS) as JobId[]) {
      const sel = h('select', { title: JOBS[job].description, onchange: () => this.pick(job, sel.value) });
      this.selects[job] = sel;
      crew.append(h('label', { title: JOBS[job].description }, JOBS[job].label, sel));
    }
    const freeOnly = h('input', { type: 'checkbox', onchange: () => this.setFreeOnly(freeOnly.checked) });
    freeOnly.checked = this.prefs.freeOnly;

    const keyInput = h('input', { type: 'password', placeholder: 'sk-or-… (optional)', autocomplete: 'off' });
    keyInput.value = safeGet(KEY_STORAGE) ?? '';
    const capInput = h('input', { type: 'number', min: '0', step: '0.5', title: 'Hard cap on spend per session (USD)' });
    capInput.value = String(Number.isFinite(host.client.maxSpendUsd) ? host.client.maxSpendUsd : 1);
    capInput.addEventListener('change', () => {
      const v = Math.max(0, Number(capInput.value) || 0);
      host.client.configure({ maxSpendUsd: v });
      safeSet(CAP_STORAGE, String(v));
      this.updateSpend();
    });

    const prompt = h('textarea', {
      rows: '3',
      id: 'aircraft-prompt',
      'aria-label': 'Describe your vehicle',
      placeholder: 'e.g. a ring-winged jet, a six-wheeled tank, a light cycle',
      onkeydown: (e) => {
        const k = e as KeyboardEvent;
        if (k.key === 'Enter' && (k.ctrlKey || k.metaKey)) void this.design(false);
      },
    });
    const rounds = h('select', { title: 'Model calls allowed: 1 designer draft, then engineer repair rounds' });
    for (const n of [1, 2, 3, 4, 5]) rounds.append(h('option', { value: String(n) }, `${n} round${n > 1 ? 's' : ''}`));
    rounds.value = '4';
    const drafts = h('select', { title: 'Independent first drafts, flight-tested in parallel; the best one goes on to repair' });
    for (const n of [1, 2, 3]) drafts.append(h('option', { value: String(n) }, `${n} draft${n > 1 ? 's' : ''}`));
    drafts.value = '2';
    const designBtn = h('button', { class: 'primary', onclick: () => this.design(false) }, 'Generate aircraft');
    const refineBtn = h('button', { onclick: () => this.design(true), title: 'Modify the craft you are flying, using your flight as feedback' }, 'Refine current');
    const cancel = h('button', { class: 'hidden', onclick: () => this.busy?.abort() }, 'Cancel');
    const musicPrompt = h('input', { type: 'text', placeholder: 'extra direction, e.g. slower, with a guitar solo' });
    const musicStyle = h('select', { title: 'Genre', 'aria-label': 'Music genre' });
    for (const [id, s] of Object.entries(MUSIC_STYLES)) musicStyle.append(h('option', { value: id }, s.label));
    musicStyle.value = 'grid';
    const composeBtn = h('button', { onclick: () => this.compose() }, 'Compose');
    this.audioEl = h('audio', { controls: '', loop: '', class: 'hidden' });
    const importInput = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', onchange: () => this.importFile(importInput) });
    const settings = h('details', { class: 'settings' },
      h('summary', {}, 'Key & spend'),
      h('label', {}, 'Your OpenRouter key (stored in this browser, sent only to openrouter.ai)', keyInput),
      h('div', { class: 'row' },
        h('button', { onclick: () => this.saveKey() }, 'Save key'),
        h('button', { onclick: () => ((keyInput.value = ''), this.saveKey()) }, 'Forget key'),
      ),
      h('label', {}, 'Session spend cap (USD)', capInput),
    );

    this.el = {
      status: h('div', { class: 'studio-status' }, 'Loading models…'),
      spend: h('span', { class: 'muted' }),
      keyInput,
      keyNote: h('div', { class: 'muted small' }),
      settings,
      prompt,
      rounds,
      drafts,
      log: h('ol', { class: 'studio-log' }),
      result: h('div', { class: 'studio-result hidden' }),
      musicPrompt,
      musicStyle,
      musicInfo: h('div', { class: 'muted small' }),
      hangar: h('div', { class: 'studio-hangar' }),
      buttons: [designBtn, refineBtn, composeBtn],
      cancel,
    };
    settings.append(this.el.keyNote);

    const chips = h('div', { class: 'chips' });
    for (const s of SUGGESTIONS) chips.append(h('button', { class: 'chip', onclick: () => ((prompt.value = s), prompt.focus()) }, s));

    this.root = h(
      'div',
      { id: 'studio', class: 'panel' },
      h('div', { class: 'studio-head' },
        h('h3', {}, '✦ CREATE · STUDIO'),
        this.el.spend,
        h('button', { class: 'studio-close', title: 'Close', 'aria-label': 'Close Studio', onclick: () => this.toggle() }, '✕'),
      ),
      this.el.status,
      h('section', {},
        h('label', { for: 'aircraft-prompt', class: 'prompt-label' }, 'Describe your vehicle'),
        prompt,
        chips,
        h('div', { class: 'row' }, designBtn, refineBtn, cancel),
        this.el.log,
        this.el.result,
      ),
      settings,
      h('details', { class: 'settings crew-settings' },
        h('summary', {}, 'Models & generation settings'),
        h('div', { class: 'row spread' }, h('h4', {}, 'Crew'), h('label', { class: 'inline' }, freeOnly, ' Free only')),
        crew, h('label', {}, 'Design and repair rounds', rounds), h('label', {}, 'Parallel first drafts (best one kept)', drafts),
      ),
      h('section', {},
        h('h4', {}, 'Music'),
        h('div', { class: 'row' }, musicStyle, musicPrompt, composeBtn),
        this.audioEl,
        this.el.musicInfo,
      ),
      h('section', {},
        h('h4', {}, 'Hangar'),
        this.el.hangar,
        h('div', { class: 'row' }, h('button', { onclick: () => importInput.click() }, 'Import JSON…'), importInput),
      ),
    );
    document.body.append(this.root);
    this.renderHangar();
    this.updateSpend();
    void this.loadModels();
  }

  show(): void {
    this.root.classList.remove('hidden');
    document.getElementById('studio-open')?.setAttribute('aria-expanded', 'true');
    this.root.scrollTop = 0;
  }

  /** Start a new design from text (e.g. a spoken "design a seaplane"). */
  designFromText(text: string): void {
    this.show();
    this.el.prompt.value = text;
    void this.design(false);
  }

  toggle(): void {
    this.root.classList.toggle('hidden');
    const open = !this.root.classList.contains('hidden');
    document.getElementById('studio-open')?.setAttribute('aria-expanded', String(open));
    if (!open) document.getElementById('studio-open')?.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- models & crew

  private async loadModels(): Promise<void> {
    const client = this.host.client;
    try {
      this.models = await client.models(true);
    } catch {
      // No dev-server proxy (e.g. GitHub Pages). The model list is public, so show it anyway
      // and ask for the player's own key.
      try {
        this.models = await new OpenRouter({ baseUrl: DIRECT_BASE_URL }).models();
        if (client.baseUrl === PROXY_BASE_URL) client.configure({ baseUrl: DIRECT_BASE_URL });
        if (!client.hasKey) this.el.settings.open = true;
      } catch (e) {
        this.setStatus(`Can't reach OpenRouter (${e instanceof Error ? e.message : e}). Flying still works.`, 'error');
        return;
      }
    }
    this.el.keyNote.textContent = client.hasKey
      ? 'Using your key, directly with openrouter.ai.'
      : client.baseUrl === PROXY_BASE_URL
        ? 'Using the dev server (key held server-side).'
        : 'No server here: paste your own key to generate. Free models cost nothing.';
    this.fillSelects();
    const freeCount = this.models.filter(isFree).length;
    this.setStatus(
      `${this.models.length} models (${freeCount} free).${this.canGenerate() ? '' : ' Add a key under "Key & spend" to generate.'}`,
    );
  }

  private canGenerate(): boolean {
    return this.host.client.hasKey || this.host.client.baseUrl === PROXY_BASE_URL;
  }

  private fillSelects(): void {
    for (const job of Object.keys(JOBS) as JobId[]) {
      const sel = this.selects[job];
      const list = modelsForJob(this.models, job, this.prefs.freeOnly);
      const info = JOBS[job];
      const paidPref = new Set(info.paid);
      const groups: Array<[string, ModelInfo[]]> = [
        ['Recommended free', info.free.map((id) => list.find((m) => m.id === id)).filter((m): m is ModelInfo => !!m)],
        ['Other free', list.filter((m) => isFree(m) && !info.free.includes(m.id))],
        ['Recommended paid', list.filter((m) => !isFree(m) && paidPref.has(m.id))],
        ['All paid (newest first)', list.filter((m) => !isFree(m) && !paidPref.has(m.id))],
      ];
      sel.replaceChildren();
      for (const [label, ms] of groups) {
        if (!ms.length) continue;
        const g = h('optgroup', { label });
        for (const m of ms) g.append(h('option', { value: m.id }, `${m.name} · ${priceLabel(m)}`));
        sel.append(g);
      }
      if (!list.length) sel.append(h('option', { value: '' }, this.prefs.freeOnly ? 'no free model for this job' : 'none available'));
      const want = this.prefs.jobs[job];
      sel.value = want && list.some((m) => m.id === want) ? want : (defaultModel(this.models, job, this.prefs.freeOnly) ?? '');
      this.prefs.jobs[job] = sel.value || undefined;
    }
    this.savePrefs();
  }

  private pick(job: JobId, id: string): void {
    this.prefs.jobs[job] = id;
    this.savePrefs();
  }

  private setFreeOnly(v: boolean): void {
    this.prefs.freeOnly = v;
    this.fillSelects();
  }

  private savePrefs(): void {
    safeSet(PREFS_KEY, JSON.stringify(this.prefs));
  }

  private crew(job: JobId): { model: string; fallbacks: string[]; info?: ModelInfo } {
    const model = this.prefs.jobs[job] ?? '';
    return {
      model,
      fallbacks: model ? fallbacksFor(this.models, job, model) : [],
      info: this.models.find((m) => m.id === model),
    };
  }

  private saveKey(): void {
    const key = this.el.keyInput.value.trim();
    if (key) safeSet(KEY_STORAGE, key);
    else safeRemove(KEY_STORAGE);
    this.host.client.configure(key ? { baseUrl: DIRECT_BASE_URL, apiKey: key } : { baseUrl: PROXY_BASE_URL, apiKey: undefined });
    void this.loadModels();
  }

  // ---------------------------------------------------------------- status helpers

  private setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
    this.el.status.textContent = text;
    this.el.status.classList.toggle('error', kind === 'error');
  }

  private updateSpend(): void {
    const c = this.host.client;
    this.el.spend.textContent = `session $${c.spent.toFixed(4)}${Number.isFinite(c.maxSpendUsd) ? ` / $${c.maxSpendUsd}` : ''}`;
  }

  private setBusy(ctrl: AbortController | null): void {
    this.busy = ctrl;
    for (const b of this.el.buttons) b.disabled = !!ctrl;
    this.el.cancel.classList.toggle('hidden', !ctrl);
  }

  private logLine(text: string, cls = ''): void {
    const li = h('li', cls ? { class: cls } : {}, text);
    this.el.log.append(li);
    li.scrollIntoView({ block: 'nearest' });
  }

  private guard(job: JobId): { model: string; fallbacks: string[]; info?: ModelInfo } | null {
    if (this.busy) return null;
    if (!this.canGenerate()) {
      this.setStatus('Add your OpenRouter key under "Key & spend" first (free models cost nothing).', 'error');
      this.el.settings.open = true;
      this.el.keyInput.scrollIntoView({ block: 'nearest' });
      this.el.keyInput.focus({ preventScroll: true });
      return null;
    }
    const c = this.crew(job);
    if (!c.model) {
      this.setStatus(`Pick a ${JOBS[job].label} model under Models & generation settings.`, 'error');
      const models = this.root.querySelector<HTMLDetailsElement>('.crew-settings');
      if (models) { models.open = true; models.scrollIntoView({ block: 'nearest' }); }
      return null;
    }
    return c;
  }

  private async run(label: string, fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const ctrl = new AbortController();
    this.setBusy(ctrl);
    try {
      await fn(ctrl.signal);
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      this.setStatus(aborted ? 'Cancelled.' : `${label} failed: ${explain(e)}`, aborted ? 'info' : 'error');
    } finally {
      this.setBusy(null);
      this.updateSpend();
    }
  }

  // ---------------------------------------------------------------- jobs

  private async design(refine: boolean): Promise<void> {
    const designer = this.guard('designer');
    if (!designer) return;
    const engineer = this.crew('engineer');
    const text = this.el.prompt.value.trim();
    if (!text && !refine) return this.setStatus('Describe the craft you want.', 'error');
    const cur = this.host.current();
    this.el.log.replaceChildren();
    this.el.result.classList.add('hidden');
    await this.run('Design', async (signal) => {
      const result = await designCraft(this.host.client, {
        model: designer.model,
        designerFallbacks: designer.fallbacks,
        engineerModel: engineer.model || designer.model,
        engineerFallbacks: engineer.model ? engineer.fallbacks : designer.fallbacks,
        prompt: text || 'Fix whatever made it fly badly.',
        base: refine ? cur.craft : undefined,
        feedback: refine ? this.host.flightNotes() : undefined,
        maxIterations: Number(this.el.rounds.value),
        drafts: refine ? 1 : Number(this.el.drafts.value),
        tester: runFlightTest,
        signal,
        onEvent: (e) => {
          if (e.type === 'status') this.setStatus(e.message);
          else {
            const a = e.attempt;
            const who = `${a.role === 'designer' ? 'Designer' : 'Engineer'}${a.model ? ` (${shortName(a.model)})` : ''}`;
            if (a.error) this.logLine(`${who}: ${a.error}`, 'bad');
            else if (a.validationErrors) this.logLine(`${who}: ${a.validationErrors.length} format errors → engineer`, 'warn');
            else if (a.report) {
              const fixed = a.fixes?.length ? ` (${a.fixes.length} auto-fix${a.fixes.length > 1 ? 'es' : ''})` : '';
              this.logLine(`${who}: "${a.craft?.name}" scored ${a.report.score}/100${a.report.gusty ? ` (gusty ${a.report.gusty.score}, advisory)` : ''}${fixed}`, a.report.passed ? 'good' : 'warn');
            }
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
      this.host.select(entry);
      this.setStatus(`"${result.name}" is ready in the hangar. FLY ▸ to try it, then Refine with what you'd change.`);
    });
  }

  private showResult(r: DesignResult, entry: LibraryEntry): void {
    this.el.result.replaceChildren(
      h('div', { class: 'row' }, h('b', {}, r.name), h('span', { class: r.report.passed ? 'good' : 'warn' }, ` ${r.report.score}/100`)),
      r.notes ? h('div', { class: 'muted' }, r.notes) : '',
      h('div', { class: 'muted small' }, `Crew: ${r.model}`),
      h('details', {}, h('summary', {}, 'Flight test report'), h('pre', {}, formatReport(r.report))),
      h('div', { class: 'row' },
        h('button', { onclick: () => this.flyEntry(entry) }, 'Fly'),
        h('span', { class: 'muted small' }, `${r.attempts.length} round(s) · $${r.cost.toFixed(4)}`),
      ),
    );
    this.el.result.classList.remove('hidden');
  }

  private async compose(): Promise<void> {
    const composer = this.guard('composer');
    if (!composer) return;
    const extra = this.el.musicPrompt.value.trim();
    const genre = this.el.musicStyle.value;
    const style = `${MUSIC_STYLES[genre]?.label ?? 'Music'}${extra ? ` · ${extra}` : ''}`;
    this.setStatus(`Composer (${shortName(composer.model)}) writing…`);
    await this.run('Composing', async (signal) => {
      const res = await composeMusic(this.host.client, {
        model: composer.model,
        fallbacks: composer.fallbacks,
        prompt: extra,
        style: genre,
        craftName: this.host.current().craft.name,
        signal,
      });
      this.audioEl.src = res.audio;
      this.audioEl.volume = 0.5;
      this.audioEl.classList.remove('hidden');
      void this.audioEl.play().catch(() => {});
      // Media Session: title on the lock screen / media hub, hardware play-pause keys.
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: style.slice(0, 60),
          artist: `Composed by ${shortName(res.model)}`,
          album: `Aerospace Program · ${this.host.current().craft.name}`,
        });
        navigator.mediaSession.setActionHandler('play', () => void this.audioEl.play());
        navigator.mediaSession.setActionHandler('pause', () => this.audioEl.pause());
        navigator.mediaSession.setActionHandler('stop', () => {
          this.audioEl.pause();
          this.audioEl.currentTime = 0;
        });
      }
      this.el.musicInfo.textContent = `${shortName(res.model)} · $${res.cost.toFixed(4)}${res.text ? ` · ${res.text.slice(0, 120)}` : ''}`;
      this.setStatus('Now playing. (Music is kept for this session only.)');
    });
  }

  // ---------------------------------------------------------------- hangar

  renderHangar(): void {
    const cur = this.host.current().entryId;
    const rows: HTMLElement[] = BUILTINS.map((b, i) => {
      const entry = builtinEntry(b);
      const active = cur === entry.id || (cur === null && i === 0);
      const pick = () => {
        if (!this.isCurrent(entry.id)) this.host.select(entry);
        this.setStatus(b.hint);
      };
      return h('div', { class: `hangar-row${active ? ' active' : ''}`, title: b.hint, onclick: pick },
        h('span', { class: 'name' }, b.label),
        h('span', { class: 'muted small' }, 'built-in'),
        h('button', { onclick: (ev) => { ev.stopPropagation(); this.flyEntry(entry); } }, 'Fly'),
      );
    });
    for (const e of this.host.library.list()) {
      const p = e.provenance;
      const meta = [p.score !== undefined ? `${p.score}/100` : '', p.model ? shortName(p.model.split(' + ')[0]) : p.source]
        .filter(Boolean)
        .join(' · ');
      rows.push(
        h('div', {
          class: `hangar-row${cur === e.id ? ' active' : ''}`,
          title: `${p.prompt ?? ''}\n${p.model ?? ''}`,
          onclick: () => {
            if (!this.isCurrent(e.id)) this.host.select(e);
          },
        },
          h('span', { class: 'name' }, e.name),
          h('span', { class: 'muted small' }, meta),
          h('button', { onclick: (ev) => { ev.stopPropagation(); this.flyEntry(e); } }, 'Fly'),
          h('button', { title: 'Download JSON', onclick: (ev) => { ev.stopPropagation(); download(`${e.name}.json`, toExportJson(e)); } }, '⤓'),
          h('button', { title: 'Delete', onclick: (ev) => { ev.stopPropagation(); this.host.library.remove(e.id); this.renderHangar(); } }, '✕'),
        ),
      );
    }
    this.el.hangar.replaceChildren(...rows);
  }

  /** Select a craft (unless it is already the one on the turntable) and take it flying. */
  private flyEntry(entry: LibraryEntry): void {
    if (!this.isCurrent(entry.id)) this.host.select(entry);
    this.host.fly();
  }

  /** Is this entry the craft already loaded? (null = the built-in trainer, the first built-in.) */
  private isCurrent(id: string): boolean {
    const cur = this.host.current().entryId;
    return cur === id || (cur === null && id === builtinEntry(BUILTINS[0]).id);
  }

  private async importFile(input: HTMLInputElement): Promise<void> {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const entry = this.host.library.add(fromImportJson(await f.text()));
      this.renderHangar();
      this.host.select(entry);
      this.setStatus(`Imported "${entry.name}".`);
    } catch (e) {
      this.setStatus(`Import failed: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  /** The last design, for debugging in the console. */
  get last(): DesignResult | null {
    return this.lastResult;
  }
}

/** Built-in craft as (unsaved) hangar entries, so they fly through the same path. */
export function builtinEntry(b: BuiltinCraft): LibraryEntry {
  return { id: `builtin:${b.id}`, name: b.label, craft: b.craft, provenance: { source: 'builtin', createdAt: '' } };
}

function shortName(id: string): string {
  return (id.split('/')[1] ?? id).replace(/:free$/, '');
}

/** Error text with a hint for the common billing/limit failures. */
function explain(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof OpenRouterError && e.status === 401) return `${msg} (Check your OpenRouter key.)`;
  if (e instanceof OpenRouterError && (e.status === 402 || e.status === 403))
    return `${msg} (Use a :free model, or raise the key's credit/limit on openrouter.ai.)`;
  if (e instanceof OpenRouterError && e.status === 429) return `${msg} (All picked models are rate-limited: wait a bit or pick others.)`;
  return msg;
}

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked */
  }
}
function safeRemove(k: string): void {
  try {
    localStorage.removeItem(k);
  } catch {
    /* storage blocked */
  }
}

function download(name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name.replace(/[^\w.-]+/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
