import { TouchDevice } from '../input/TouchDevice.ts';
import { emptyRaw, loadInputSettings, type Action, type InputSettings } from '../input/types.ts';
import { uiProfile } from '../hud/profiles.ts';
import type { TvFrame } from '../tv/format.ts';
import type { WorkerIn, WorkerOut } from '../tv/host.worker.ts';
import { castAppId, CastSenderLink, LocalLink, RelayLink, relayBase, type Link, type LinkState } from '../tv/links.ts';
import { isPairCode, PAD_INPUT_HZ, PAD_VERSION, PadInputPacker, parseTvMessage, type PadAction, type TvContextMsg } from '../tv/protocol.ts';

/**
 * The phone as the gamepad (pad.html). The game's own thumb controls (TouchDevice: lever, stick,
 * brake, fire, board) laid out for the vehicle on the TV, sent to the TV about 30 times a second
 * (src/tv/protocol.ts) over the Cast session or the relay's pairing. The TV answers with the
 * vehicle's control profile, the throttle and a few readouts, toasts and rumble.
 *
 * "Run the game on this phone": the phone simulates (in a worker) and sends the TV frames to
 * draw, for a receiver too slow to run the game itself. Over Cast or within one browser only:
 * the relay carries controls, not frames.
 *
 * `?code=ABCD` pairs at once, `?host=1` ticks "run the game here", `?castApp=ID` sets the Cast
 * receiver app id (remembered).
 */

const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const connectView = $('pad-connect');
const top = $('pad-top');
const chip = $('pad-chip');
const lines = $('pad-lines');
const menu = $('pad-menu');
const menuBtn = $('pad-menu-btn');
const toastEl = $('pad-toast');
const statusEl = $('pad-status');
const codeInput = $<HTMLInputElement>('pad-code');
const hostBox = $<HTMLInputElement>('pad-host');
const castBtn = $<HTMLButtonElement>('pad-cast');
const castNote = $('pad-cast-note');
hostBox.checked = params.get('host') === '1';

const settings: InputSettings = { ...loadInputSettings(), touchControls: 'on' };
const touch = new TouchDevice();
const packer = new PadInputPacker();
let links: Link[] = [];
let ctx: TvContextMsg | null = null;
let playing = false;
let runsGame = false;
let worker: Worker | null = null;
let menuActions: Action[] = [];
let flapCycle = false;
let sentAt = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

function vibrate(s: number, ms: number): void {
  if (!settings.haptics) return;
  try { navigator.vibrate?.(s > 0.6 ? [ms, 60, ms * 0.5] : ms); } catch { /* not allowed */ }
}

// --- The pad's menu: what a gamepad's other buttons do (the TV carries out PAD_ACTIONS).
const MENU: Array<[string, PadAction | 'flaps' | 'leave']> = [
  ['Next vehicle', 'nextVehicle'], ['Previous vehicle', 'prevVehicle'],
  ['Camera', 'camera'], ['Overhead', 'map'],
  ['Navigator hold', 'autopilot'], ['Light trail', 'trail'],
  ['Weapons', 'loadout'], ['On foot / board', 'foot'],
  ['Flaps', 'flaps'], ['Radar range', 'radarRange'],
  ['Trim reset', 'trimReset'], ['Strategic', 'strategic'],
  ['New vehicle', 'reset'], ['Reset world', 'resetWorld'],
  ['Help on the TV', 'help'], ['Disconnect', 'leave'],
];
for (const [label, a] of MENU) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => {
    if (a === 'leave') { leave(); return; }
    if (a === 'flaps') flapCycle = true;
    else menuActions.push(a);
    closeMenu();
  });
  menu.append(b);
}
const closeMenu = () => { menu.classList.add('hidden'); menuBtn.setAttribute('aria-expanded', 'false'); };
menuBtn.addEventListener('click', () => {
  const open = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  menuBtn.setAttribute('aria-expanded', String(open));
});

// --- Linking.
const states = new Map<Link, [LinkState, string]>();
/** The chip shows the best link: connected if any is. */
function linkState(link: Link, state: LinkState, detail: string): void {
  states.set(link, [state, detail]);
  const all = [...states.values()];
  const [best, text] = all.find(([s]) => s === 'connected') ?? all.find(([s]) => s === 'waiting') ?? [state, detail];
  chip.textContent = text || best;
  chip.classList.toggle('off', best !== 'connected');
  statusEl.textContent = all.map(([s, d]) => d || s).join('\n');
  if (state === 'connected') hello();
}

function hello(): void {
  for (const l of links) l.send({ t: 'hello', v: PAD_VERSION, name: 'Phone', host: runsGame });
}

function onTv(raw: unknown): void {
  const m = parseTvMessage(raw);
  if (!m) return;
  if (m.t === 'welcome') {
    if ((m.host === 'pad') !== runsGame) toast(runsGame ? 'The TV runs the game itself' : 'The TV expects this phone to run the game');
  } else if (m.t === 'ctx') {
    if (!runsGame) applyContext(m);
  } else if (m.t === 'toast') toast(m.text);
  else if (m.t === 'rumble') vibrate(m.s, m.ms);
}

let shownProfile = '';
function applyContext(m: TvContextMsg): void {
  ctx = m;
  document.body.classList.toggle('armed', m.armed);
  const p = uiProfile(m.profile, m.foot);
  if (p !== shownProfile) {
    if (shownProfile) document.body.classList.remove(`profile-${shownProfile}`);
    document.body.classList.add(`profile-${p}`);
    shownProfile = p;
  }
  lines.textContent = [m.craft, ...m.lines].join('  ·  ');
}

function play(next: Link[]): void {
  links = next;
  playing = true;
  runsGame = hostBox.checked;
  connectView.classList.add('hidden');
  top.classList.remove('hidden');
  states.clear();
  for (const l of links) {
    l.onMessage = onTv;
    l.onState = (st, d) => linkState(l, st, d);
  }
  if (runsGame) startGame();
  hello();
  // Keep the phone awake while it is a gamepad.
  void (navigator as Navigator & { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request('screen').catch(() => {});
}

function leave(): void {
  for (const l of links) { l.send({ t: 'bye' }); l.close(); }
  links = [];
  playing = false;
  worker?.terminate();
  worker = null;
  closeMenu();
  connectView.classList.remove('hidden');
  top.classList.add('hidden');
  document.body.classList.remove('touch-ui');
}

// The phone runs the game: frames to the TV about 15 a second (what an undrawn frame carried moves on).
let pending: TvFrame | null = null;
let frameSentAt = 0;
function startGame(): void {
  worker?.terminate();
  worker = new Worker(new URL('../tv/host.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<WorkerOut>) => {
    const m = e.data;
    if (m.t === 'progress') toast(m.text);
    else if (m.t === 'ctx') applyContext(m.ctx);
    else if (m.t === 'rumble') vibrate(m.s, m.ms);
    else if (m.t === 'error') toast(`The game stopped: ${m.text}`);
    else if (m.t === 'frame') {
      const f = m.f;
      if (pending) {
        f.notes = [...pending.notes, ...f.notes];
        f.ui = [...pending.ui, ...f.ui];
        if (pending.craft && !f.craft) f.craft = pending.craft;
        if (pending.chunks && !f.chunks) f.chunks = pending.chunks;
      }
      for (const n of m.f.notes) if (!pending?.notes.includes(n)) toast(n);
      pending = f;
      const now = performance.now();
      if (now - frameSentAt > 66) {
        frameSentAt = now;
        for (const l of links) l.send({ t: 'frame', f: pending });
        pending = null;
      }
      // About 15 frames a second is what goes to the TV: ask for the next one in time for it.
      setTimeout(() => worker?.postMessage({ t: 'want' } satisfies WorkerIn), Math.max(0, 60 - (performance.now() - frameSentAt)));
    }
  };
  worker.postMessage({ t: 'start', job: 'host', structures: false } satisfies WorkerIn);
}

// --- Cast.
const appId = castAppId(params);
let castLink: CastSenderLink | null = null;
if (!appId) {
  castNote.textContent = 'Casting needs the game\'s Cast receiver app id (open this page with ?castApp=YOUR_ID once). Pairing by code works without it.';
} else {
  castLink = new CastSenderLink(appId);
  castNote.textContent = 'Chrome on Android (or a computer) casts; on an iPhone, pair by code instead.';
  castLink.onState = (state, detail) => {
    castNote.textContent = detail;
    if (state === 'connected' && !playing) play([castLink!]);
  };
  void castLink.ready.then((ok) => { castBtn.disabled = !ok; });
  castBtn.addEventListener('click', () => {
    void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
    void castLink!.start();
  });
}

// --- Pairing by code.
function pair(): void {
  const code = codeInput.value.trim().toUpperCase();
  if (!isPairCode(code)) { statusEl.textContent = 'Enter the four letters shown on the TV.'; return; }
  void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  if (hostBox.checked) toast('Over the relay the TV runs the game; the phone runs it only when casting or in this browser');
  play([new RelayLink(relayBase(params), code, 'pad'), new LocalLink(code, 'pad')]);
}
$('pad-pair').addEventListener('click', pair);
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pair(); });
const preset = params.get('code')?.toUpperCase();
if (preset && isPairCode(preset)) {
  codeInput.value = preset;
  pair();
}

// --- The controls, every frame.
const portrait = () => document.body.classList.toggle('portrait', window.innerHeight > window.innerWidth);
window.addEventListener('resize', portrait);
portrait();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const raw = emptyRaw();
  const ictx = { profile: ctx?.profile ?? 'airplane', onFoot: ctx?.foot ?? false, throttle: ctx?.thr ?? 0, settings };
  if (playing) touch.read(raw, ictx);
  const actions: Action[] = [];
  touch.drainActions(actions);
  if (!playing) return;
  actions.push(...menuActions);
  menuActions = [];
  if (flapCycle) { raw.flapCycle = true; flapCycle = false; }
  packer.add(raw, actions);
  if (packer.urgent || now - sentAt > 1000 / PAD_INPUT_HZ) {
    sentAt = now;
    const msg = packer.take();
    if (runsGame) worker?.postMessage({ t: 'in', msg, src: 'pad' } satisfies WorkerIn);
    else for (const l of links) l.send(msg);
  }
}
requestAnimationFrame(frame);
