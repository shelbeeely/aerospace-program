import { BUILTINS, type BuiltinCraft } from '../craft/builtins.ts';
import type { CraftDef } from '../craft/types.ts';
import { AGENTIC_ONLY, defaultModel, fallbacksFor, isAgenticOnly, isFree, JOBS, modelsForJob, priceLabel, type JobId } from '../gen/catalog.ts';
import { type DesignResult } from '../gen/craftDesigner.ts';
import { fromImportJson, toExportJson, type Library, type LibraryEntry } from '../gen/library.ts';
import { composeMusic, MUSIC_STYLES } from '../gen/music.ts';
import { deleteTheme, saveTheme, themeStyleForPrompt } from '../gen/tracks.ts';

interface ComposedTheme { audio: string; model: string; cost: number }
import { designWithAgent, type AgentEvent, type AgentTrace } from '../gen/agent.ts';
import { clearTraces, listTraces, saveTrace, toJsonl } from '../gen/traces.ts';
import {
  DIRECT_BASE_URL,
  supportsTools,
  OpenRouter,
  OpenRouterError,
  PROXY_BASE_URL,
  type ModelInfo,
} from '../gen/openrouter.ts';
import { formatReport } from '../sim/flightTest.ts';
import { runFlightTest } from '../sim/flightTestClient.ts';
import { ModelBench } from './ModelBench.ts';

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
  /** Show a craft on the turntable while the agent builds it (null = back to the current craft). */
  preview(craft: CraftDef | null): void;
  /** Play the saved theme of this hangar entry, if it is the current one. */
  playTheme(entryId: string): void;
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
  /** Agent reasoning effort. */
  effort: 'low' | 'medium' | 'high';
  /** Flight tests the agent may run per job. */
  tests: number;
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return { freeOnly: p.freeOnly ?? true, jobs: p.jobs ?? {}, effort: p.effort ?? 'medium', tests: p.tests ?? 8 };
  } catch {
    return { freeOnly: true, jobs: {}, effort: 'medium', tests: 8 };
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
  /** Model search text (lower case) and the tool-calling filter. */
  private search = '';
  private searchInfo!: HTMLElement;
  /** The selected Designer's endpoint terms, when it is agentic-only. */
  private termsNote!: HTMLElement;
  /** The model test bench (several designers, one prompt, compared). */
  private bench!: ModelBench;

  private readonly el: {
    status: HTMLElement;
    spend: HTMLElement;
    keyInput: HTMLInputElement;
    keyNote: HTMLElement;
    settings: HTMLDetailsElement;
    prompt: HTMLTextAreaElement;
    detailPass: HTMLInputElement;
    /** Compose a theme track alongside the vehicle. */
    themeBox: HTMLInputElement;
    log: HTMLOListElement;
    /** Live agent console: reasoning and text as they stream, tool calls and results. */
    console: HTMLElement;
    /** "Download this run" after an agent run ends (its trace, for fine-tuning). */
    traceRow: HTMLElement;
    traceCount: HTMLElement;
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
      // The agent does the Engineer's job itself, so only the Designer (agent) and Composer show.
      if (job !== 'engineer') crew.append(h('label', { title: JOBS[job].description }, job === 'designer' ? 'Designer (agent)' : JOBS[job].label, sel));
    }
    const freeOnly = h('input', { type: 'checkbox', onchange: () => this.setFreeOnly(freeOnly.checked) });
    freeOnly.checked = this.prefs.freeOnly;
    // Model search: any model in the OpenRouter catalog, by name, id or description.
    const search = h('input', { type: 'search', placeholder: 'Search all models (name, id, e.g. "claude", "qwen coder")', 'aria-label': 'Search models' }) as HTMLInputElement;
    search.addEventListener('input', () => { this.search = search.value.trim().toLowerCase(); this.fillSelects(); });
    this.searchInfo = h('div', { class: 'muted small' });
    this.termsNote = h('div', { class: 'small warn hidden', role: 'note' });

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
    // Reasoning effort and the flight-test budget for the agent.
    const effort = h('select', { title: 'How hard the model thinks each turn: more effort is slower and uses more tokens' }) as HTMLSelectElement;
    for (const [v, l] of [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]) effort.append(h('option', { value: v }, l));
    effort.value = this.prefs.effort;
    effort.addEventListener('change', () => { this.prefs.effort = effort.value as Prefs['effort']; this.savePrefs(); });
    const tests = h('select', { title: 'Flight tests the agent may run per job' }) as HTMLSelectElement;
    for (const n of [4, 8, 12]) tests.append(h('option', { value: String(n) }, `${n} flight tests`));
    tests.value = String(this.prefs.tests);
    tests.addEventListener('change', () => { this.prefs.tests = Number(tests.value); this.savePrefs(); });
    const designBtn = h('button', { class: 'primary', onclick: () => this.design(false) }, 'Generate vehicle');
    const detailBtn = h('button', { onclick: () => this.detailCurrent(), title: 'The agent adds visual detail (panels, plates, intakes, light lines) to the current craft. Its physics stay exactly as tested.' }, 'Add detail');
    const detailPass = h('input', { type: 'checkbox', checked: '' }) as HTMLInputElement;
    const passedOnly = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const themeBox = h('input', { type: 'checkbox', checked: '' }) as HTMLInputElement;
    const refineBtn = h('button', { onclick: () => this.design(true), title: 'Modify the craft you are flying, using your flight as feedback' }, 'Refine current');
    const cancel = h('button', { class: 'hidden', onclick: () => this.busy?.abort() }, 'Cancel');
    const musicPrompt = h('input', { type: 'text', placeholder: 'extra direction, e.g. slower, with a guitar solo' });
    const musicStyle = h('select', { title: 'Genre', 'aria-label': 'Music genre' });
    for (const [id, s] of Object.entries(MUSIC_STYLES)) musicStyle.append(h('option', { value: id }, s.label));
    musicStyle.value = 'grid';
    const composeBtn = h('button', { onclick: () => this.compose() }, 'Compose theme');
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
      log: h('ol', { class: 'studio-log' }),
      console: h('div', { class: 'agent-console hidden', 'aria-live': 'off' }),
      traceRow: h('div', { class: 'row hidden' }),
      traceCount: h('span', { class: 'muted small' }),
      result: h('div', { class: 'studio-result hidden' }),
      musicPrompt,
      musicStyle,
      musicInfo: h('div', { class: 'muted small' }),
      hangar: h('div', { class: 'studio-hangar' }),
      buttons: [designBtn, refineBtn, detailBtn, composeBtn],
      detailPass,
      themeBox,
      cancel,
    };
    settings.append(this.el.keyNote);

    this.bench = new ModelBench({
      client: host.client,
      library: host.library,
      models: () => this.models,
      freeOnly: () => this.prefs.freeOnly,
      prompt: () => this.el.prompt.value,
      settings: () => ({ effort: this.prefs.effort, tests: this.prefs.tests, detail: this.el.detailPass.checked }),
      lock: (ctrl) => this.setBusy(ctrl),
      canGenerate: () => this.canGenerate(),
      status: (t, k) => this.setStatus(t, k),
      spendChanged: () => this.updateSpend(),
      keepTrace: (t) => void saveTrace(t).then(() => this.updateTraceCount()),
      preview: (c) => host.preview(c),
      select: (e) => host.select(e),
      fly: () => host.fly(),
      hangarChanged: () => this.renderHangar(),
    });

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
        h('div', { class: 'row' }, designBtn, refineBtn, detailBtn, cancel),
        h('label', { class: 'muted small', title: 'Once the design passes, the agent adds visual detail (re-tested; physics unchanged)' }, detailPass, ' Add detail once it passes'),
        h('label', { class: 'muted small', title: 'The Composer writes a theme for the vehicle while the agent builds it; it is saved with the vehicle and plays when you fly it' }, themeBox, ' Compose a theme track for it'),
        this.el.console,
        this.el.traceRow,
        this.el.log,
        this.el.result,
      ),
      this.bench.root,
      settings,
      h('details', { class: 'settings crew-settings' },
        h('summary', {}, 'Models & generation settings'),
        h('div', { class: 'row spread' }, h('h4', {}, 'Crew'), h('label', { class: 'inline' }, freeOnly, ' Free only')),
        h('div', { class: 'muted small' }, 'The Designer runs as an agent with tools, so only tool-calling models are listed for it.'),
        h('div', { class: 'row' }, search),
        this.searchInfo,
        this.termsNote,
        crew, h('label', {}, 'Reasoning effort', effort), h('label', {}, 'Flight-test budget', tests),
      ),
      h('details', { class: 'settings' },
        h('summary', {}, 'Training data'),
        h('div', { class: 'muted small' }, 'Every agent run is kept in this browser (nothing is uploaded): the model\'s reasoning, each tool call and result, and how it went. Download as JSONL (OpenAI chat format with tools, reasoning on each assistant turn) to fine-tune a model.'),
        h('div', { class: 'row' }, this.el.traceCount),
        h('div', { class: 'row' },
          h('label', { class: 'inline' }, passedOnly, ' Passed runs only'),
          h('button', { onclick: () => this.downloadTraces(passedOnly.checked) }, 'Download all (JSONL)'),
          h('button', { onclick: () => this.clearTraces() }, 'Clear'),
        ),
      ),
      h('section', {},
        h('h4', {}, 'Music'),
        h('div', { class: 'muted small' }, 'Theme for the vehicle you are in: saved with it and played whenever you fly it (M mutes).'),
        h('div', { class: 'row' }, musicStyle, musicPrompt, composeBtn, h('button', { title: 'Remove this vehicle theme', onclick: () => this.removeTheme() }, '✕')),
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
    void this.updateTraceCount();
    void this.loadModels();
    // ?bench opens the Studio on the test bench.
    if (new URLSearchParams(location.search).has('bench')) { this.show(); this.bench.open(); }
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
      const textJob = job === 'designer' || job === 'engineer';
      let list = modelsForJob(this.models, job, this.prefs.freeOnly);
      if (job === 'designer') list = list.filter((m) => supportsTools(m)); // the agent needs tools
      const q = this.search;
      const hits = q ? list.filter((m) => `${m.id} ${m.name} ${m.description}`.toLowerCase().includes(q)).slice(0, 60) : [];
      const info = JOBS[job];
      const paidPref = new Set(info.paid);
      const groups: Array<[string, ModelInfo[]]> = [
        ...(q ? [[`Search "${q}" (${hits.length})`, hits] as [string, ModelInfo[]]] : []),
        ['Recommended free', info.free.map((id) => list.find((m) => m.id === id)).filter((m): m is ModelInfo => !!m)],
        ['Other free', list.filter((m) => isFree(m) && !info.free.includes(m.id) && !isAgenticOnly(m.id))],
        ['Free, Agent mode only (read its terms)', list.filter((m) => isAgenticOnly(m.id))],
        ['Recommended paid', list.filter((m) => !isFree(m) && paidPref.has(m.id))],
        ['All paid (newest first)', list.filter((m) => !isFree(m) && !paidPref.has(m.id))],
      ];
      sel.replaceChildren();
      for (const [label, ms] of groups) {
        if (!ms.length) continue;
        const g = h('optgroup', { label });
        for (const m of ms) g.append(h('option', { value: m.id }, `${m.name} · ${priceLabel(m)}${textJob && supportsTools(m) ? ' · tools' : ''}`));
        sel.append(g);
      }
      if (!list.length) sel.append(h('option', { value: '' }, this.prefs.freeOnly ? 'no free model for this job' : 'none available'));
      const want = this.prefs.jobs[job];
      // A search jumps the selection to its best hit, so typing a name picks the model.
      const top = q && hits[0] && job === 'designer' ? hits[0].id : '';
      sel.value = top || (want && list.some((m) => m.id === want) ? want : (defaultModel(this.models, job, this.prefs.freeOnly) ?? ''));
      this.prefs.jobs[job] = sel.value || undefined;
    }
    if (this.searchInfo) {
      const n = this.search ? modelsForJob(this.models, 'designer', this.prefs.freeOnly).filter((m) => `${m.id} ${m.name} ${m.description}`.toLowerCase().includes(this.search)).length : 0;
      this.showTerms();
      this.searchInfo.textContent = this.search ? `${n} matching text model(s) of ${this.models.length} in the catalog; matches are listed first in each job.` : '';
    }
    this.savePrefs();
    this.bench?.refresh();
  }

  private pick(job: JobId, id: string): void {
    this.prefs.jobs[job] = id;
    this.savePrefs();
    this.showTerms();
  }

  /** Show the provider's notice while an agentic-only endpoint is the Designer. */
  private showTerms(): void {
    if (!this.termsNote) return;
    const id = this.prefs.jobs.designer;
    const note = id ? AGENTIC_ONLY[id] : undefined;
    this.termsNote.textContent = note ?? '';
    this.termsNote.classList.toggle('hidden', !note);

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

  /**
   * Every job runs through the agent: the model drives the pipeline with tools while the console
   * streams its reasoning and tool calls and the turntable builds the vehicle as parts arrive.
   */
  private async runAgent(kind: 'design' | 'refine' | 'detail'): Promise<void> {
    const designer = this.guard('designer');
    if (!designer) return;
    const text = this.el.prompt.value.trim();
    if (kind === 'design' && !text) return this.setStatus('Describe the vehicle you want.', 'error');
    const cur = this.host.current();
    this.el.log.replaceChildren();
    this.el.result.classList.add('hidden');
    this.consoleReset();
    this.el.traceRow.classList.add('hidden');
    const prompt = kind === 'detail'
      ? `Keep this design exactly as it is (do not patch it). flight_test it, then add_detail with 25-80 visual detail parts in the 1982 style${text ? ` (direction: ${text})` : ''}, check, flight_test again and finish.`
      : kind === 'refine' ? (text || 'Fix whatever made it fly badly.') : text;
    let ok = false;
    // A theme track, composed in parallel with the build (it doesn't need the finished vehicle).
    const composer = kind !== 'detail' && this.el.themeBox.checked ? this.crew('composer') : null;
    const style = themeStyleForPrompt(text || cur.craft.name);
    let theme: Promise<ComposedTheme | null> | null = null;
    await this.run(kind === 'detail' ? 'Detail' : 'Design', async (signal) => {
      if (composer?.model) {
        this.logLine(`Composer (${shortName(composer.model)}): writing a ${MUSIC_STYLES[style]?.label ?? style} theme alongside…`, 'muted');
        theme = composeMusic(this.host.client, { model: composer.model, fallbacks: composer.fallbacks, prompt: text, style, craftName: text || cur.craft.name, signal })
          .then((r) => ({ audio: r.audio, model: r.model, cost: r.cost }))
          .catch((e) => { if (!signal.aborted) this.logLine(`Composer: no theme (${e instanceof Error ? e.message.slice(0, 140) : e})`, 'warn'); return null; });
      }
      const result = await designWithAgent(this.host.client, {
        model: designer.model,
        designerFallbacks: designer.fallbacks,
        modelInfo: designer.info,
        effort: this.prefs.effort,
        maxTests: this.prefs.tests,
        prompt,
        base: kind === 'design' ? undefined : cur.craft,
        feedback: kind === 'refine' ? this.host.flightNotes() : undefined,
        detail: kind === 'detail' || this.el.detailPass.checked,
        tester: runFlightTest,
        signal,
        onTrace: (t) => this.keepTrace(t),
        onEvent: (e) => {
          if (e.type === 'status') this.setStatus(e.message);
          else if (e.attempt.report) {
            const a = e.attempt;
            this.logLine(`Flight test ${a.iteration}: "${a.craft?.name}" scored ${a.report!.score}/100${a.report!.gusty ? ` (gusty ${a.report!.gusty.score}, advisory)` : ''}`, a.report!.passed ? 'good' : 'warn');
          }
          this.updateSpend();
        },
      }, (e) => this.agentEvent(e));
      this.lastResult = result;
      const parent = cur.entryId ? this.host.library.get(cur.entryId) : undefined;
      const entry = this.host.library.add({
        name: kind === 'detail' ? `${cur.craft.name} (detailed)` : result.name,
        craft: result.craft,
        provenance: {
          ...(kind === 'detail' ? parent?.provenance ?? {} : {}),
          source: 'generated',
          model: result.model,
          prompt: kind === 'detail' ? parent?.provenance.prompt ?? prompt : result.prompt,
          notes: result.notes,
          score: result.report.score,
          rounds: result.attempts.length,
          costUsd: result.cost,
          createdAt: new Date().toISOString(),
          parentId: kind === 'design' ? undefined : cur.entryId ?? undefined,
        },
      });
      ok = true;
      this.showResult(result, entry);
      this.renderHangar();
      this.host.select(entry);
      if (theme) {
        this.setStatus(`"${entry.name}" is built. Finishing its theme track…`);
        const t = await (theme as Promise<ComposedTheme | null>);
        if (t) {
          await saveTheme(entry.id, { audio: t.audio, style, model: t.model, prompt: text, createdAt: new Date().toISOString() });
          this.host.library.update(entry.id, { provenance: { ...entry.provenance, theme: MUSIC_STYLES[style]?.label ?? style } });
          this.logLine(`Composer (${shortName(t.model)}): theme saved with "${entry.name}" ($${t.cost.toFixed(4)}). It plays when you fly it.`, 'good');
          this.renderHangar();
          this.host.playTheme(entry.id);
        }
      }
      this.setStatus(`"${entry.name}" is ready in the hangar. FLY ▸ to try it, then Refine with what you'd change.`);
    });
    if (!ok) this.host.preview(null); // cancelled or failed: back to the craft we had
  }

  // ---------------------------------------------------------------- training data



  /** Keep a finished run's trace (IndexedDB) and offer it for download right away. */
  private keepTrace(t: AgentTrace): void {

    void saveTrace(t).then(() => this.updateTraceCount());
    const m = t.metadata;
    const name = `agent-run-${m.startedAt.replace(/[:.]/g, '-')}.jsonl`;
    this.el.traceRow.replaceChildren(
      h('button', { onclick: () => downloadText(name, toJsonl([t])), title: 'This run as one JSONL line: reasoning, tool calls, results and outcome' }, '⬇ Download this run'),
      h('span', { class: 'muted small' }, `${m.turns} turns · ${m.flightTests} tests · ${m.passed ? `passed ${m.score}/100` : m.error ? m.error.slice(0, 60) : `best ${m.score ?? '–'}/100`}`),
    );
    this.el.traceRow.classList.remove('hidden');
  }

  private async updateTraceCount(): Promise<void> {
    const all = await listTraces();
    const passed = all.filter((t) => t.metadata.passed).length;
    this.el.traceCount.textContent = `${all.length} run(s) stored, ${passed} passed.`;
  }

  private async downloadTraces(passedOnly: boolean): Promise<void> {
    const all = await listTraces();
    const lines = toJsonl(all, { passedOnly });
    if (lines.trim() === '') return this.setStatus('No agent runs stored yet.', 'error');
    downloadText(`agent-runs-${new Date().toISOString().slice(0, 10)}${passedOnly ? '-passed' : ''}.jsonl`, lines);
  }

  private async clearTraces(): Promise<void> {
    if (!confirm('Delete every stored agent run from this browser?')) return;
    await clearTraces();
    void this.updateTraceCount();
  }

  private design(refine: boolean): Promise<void> {
    return this.runAgent(refine ? 'refine' : 'design');
  }

  // ---------------------------------------------------------------- live agent console

  private consoleFlush = 0;
  private previewAt = 0;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;

  private consoleReset(): void {
    this.el.console.replaceChildren();
    this.el.console.classList.remove('hidden');
  }

  /** Append streaming text to the console's current block (a new block when the kind changes). */
  private consoleStream(kind: 'thinking' | 'text', text: string): void {
    const box = this.el.console;
    let last = box.lastElementChild as HTMLElement | null;
    if (!last || last.dataset.kind !== kind) {
      last = h('div', { class: `ac-${kind}` });
      last.dataset.kind = kind;
      box.append(last);
    }
    last.textContent = (last.textContent ?? '') + text;
    // Keep the console bounded: drop the oldest blocks past ~200 KB.
    while (box.childElementCount > 2 && (box.textContent?.length ?? 0) > 200_000) box.firstElementChild?.remove();
    if (!this.consoleFlush) {
      this.consoleFlush = requestAnimationFrame(() => {
        this.consoleFlush = 0;
        box.scrollTop = box.scrollHeight;
      });
    }
  }

  private consoleLine(cls: string, text: string): void {
    const el = h('div', { class: cls }, text);
    el.dataset.kind = cls;
    this.el.console.append(el);
    this.el.console.scrollTop = this.el.console.scrollHeight;
  }

  private agentEvent(e: AgentEvent): void {
    if (e.type === 'thinking') this.consoleStream('thinking', e.text);
    else if (e.type === 'text') this.consoleStream('text', e.text);
    else if (e.type === 'calling') {
      // One live line per streaming tool call, updated as its arguments arrive.
      const last = this.el.console.lastElementChild as HTMLElement | null;
      const label = `▸ ${e.name}${e.bytes ? ` (${(e.bytes / 1024).toFixed(1)} KB…)` : ''}`;
      if (last?.dataset.kind === 'ac-calling') last.textContent = label;
      else this.consoleLine('ac-calling', label);
    } else if (e.type === 'tool') {
      const last = this.el.console.lastElementChild as HTMLElement | null;
      if (last?.dataset.kind === 'ac-calling') last.remove();
      const bad = /^(ERROR|REJECTED|NOT)/.test(e.summary);
      this.consoleLine(bad ? 'ac-tool bad' : 'ac-tool', `● ${e.name} → ${e.summary}`);
    } else if (e.type === 'craft') this.previewCraft(e.craft, e.partial);
  }

  /** Throttled turntable preview: the vehicle builds up as parts stream in. */
  private previewCraft(craft: CraftDef, partial: boolean): void {
    const show = () => {
      this.previewAt = performance.now();
      this.previewTimer = null;
      this.host.preview(craft);
    };
    if (this.previewTimer) clearTimeout(this.previewTimer);
    const wait = 350 - (performance.now() - this.previewAt);
    if (!partial || wait <= 0) show();
    else this.previewTimer = setTimeout(show, wait);
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

  /** Detail the current craft through the agent (physics untouched, re-tested). */
  private detailCurrent(): Promise<void> {
    return this.runAgent('detail');
  }

  /** Compose (or replace) the current vehicle's theme: saved with it, played through the game's audio. */
  private async compose(): Promise<void> {
    const composer = this.guard('composer');
    if (!composer) return;
    const cur = this.host.current();
    const id = cur.entryId ?? 'builtin:trainer';
    const extra = this.el.musicPrompt.value.trim();
    const style = this.el.musicStyle.value;
    this.setStatus(`Composer (${shortName(composer.model)}) writing a theme for "${cur.craft.name}"…`);
    await this.run('Composing', async (signal) => {
      const res = await composeMusic(this.host.client, { model: composer.model, fallbacks: composer.fallbacks, prompt: extra, style, craftName: cur.craft.name, signal });
      await saveTheme(id, { audio: res.audio, style, model: res.model, prompt: extra, createdAt: new Date().toISOString() });
      const e = this.host.library.get(id);
      if (e) this.host.library.update(id, { provenance: { ...e.provenance, theme: MUSIC_STYLES[style]?.label ?? style } });
      this.el.musicInfo.textContent = `${shortName(res.model)} · $${res.cost.toFixed(4)}${res.text ? ` · ${res.text.slice(0, 120)}` : ''}`;
      this.renderHangar();
      this.host.playTheme(id);
      this.setStatus(`Theme saved with "${cur.craft.name}": it plays whenever you fly it (M mutes).`);
    });
  }

  /** Remove the current vehicle's theme. */
  private async removeTheme(): Promise<void> {
    const cur = this.host.current();
    const id = cur.entryId ?? 'builtin:trainer';
    await deleteTheme(id);
    const e = this.host.library.get(id);
    if (e) this.host.library.update(id, { provenance: { ...e.provenance, theme: undefined } });
    this.renderHangar();
    this.host.playTheme(id);
    this.setStatus(`"${cur.craft.name}" has no theme now.`);
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
      const meta = [p.score !== undefined ? `${p.score}/100` : '', p.model ? shortName(p.model.split(' + ')[0]) : p.source, p.theme ? `♪ ${p.theme}` : '']
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

/** Save text as a file (a download). */
function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/jsonl' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
