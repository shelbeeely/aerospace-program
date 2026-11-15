import { GamepadDevice } from '../input/GamepadDevice.ts';
import { KeyboardDevice } from '../input/KeyboardDevice.ts';
import { emptyRaw, loadInputSettings, type Action, type ControlProfile } from '../input/types.ts';
import type { TvFrame } from './format.ts';
import type { WorkerIn, WorkerOut } from './host.worker.ts';
import { CastReceiverLink, LocalLink, onCastDevice, RelayLink, relayBase, type Link, type LinkState } from './links.ts';
import { isPairCode, pairCode, PAD_INPUT_HZ, PAD_VERSION, PadInputPacker, parsePadMessage, type TvMessage } from './protocol.ts';
import { StructureStore } from './structures.ts';
import { TvRenderer } from './TvRenderer.ts';

/**
 * The TV page (tv.html): the game on the big screen, drawn with Canvas 2D, played from a phone.
 * On a Chromecast it is the Cast receiver app; anywhere else (a smart TV's browser, a laptop on
 * the HDMI) it shows a pairing code for the phone. The game runs in a worker on this device, or
 * on the phone when the phone says so (its frames come over the link and are drawn here).
 *
 * `?code=ABCD` fixes the pairing code, `?cast` acts as a receiver off a Cast device, `?host=pad`
 * waits for a phone that runs the game, `?craft=cycle` starts in a built-in, `?lite` thins the
 * world for a slow receiver, `?scale=1` sets the drawing resolution, `?stats` shows the timing.
 */

const params = new URLSearchParams(location.search);
const castDevice = onCastDevice() || params.has('cast');
const $ = (id: string) => document.getElementById(id)!;
const canvas = $('tv') as HTMLCanvasElement;
const card = $('tv-card');
const status = $('tv-status');
const progress = $('tv-progress');
const badge = $('tv-badge');

const store = new StructureStore();
const renderer = new TvRenderer(canvas, store);
renderer.showStats = params.has('stats');
// A Cast receiver draws at 720p (cheap, and what the screen is scaled from); elsewhere a little sharper.
const scale = Number(params.get('scale')) || (castDevice ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
const resize = () => renderer.resize(Math.round(window.innerWidth * scale), Math.round(window.innerHeight * scale));
window.addEventListener('resize', resize);
resize();

// --- Who runs the game: this TV's worker ('tv'), or the phone ('pad').
let hostMode: 'tv' | 'pad' = params.get('host') === 'pad' ? 'pad' : 'tv';
let worker: Worker | null = null;
let latest: TvFrame | null = null;
let drawn: TvFrame | null = null;
let craftShape: TvFrame['craft'] | null = null;
let frameAt = 0;

/**
 * A new frame. Frames can come faster than the screen draws them, so what an undrawn frame
 * carried once (toasts, view actions) moves on to the next, and the craft's shape is kept.
 */
function accept(f: TvFrame): void {
  if (latest && latest !== drawn) {
    f.notes = [...latest.notes, ...f.notes];
    f.ui = [...latest.ui, ...f.ui];
  }
  if (f.craft) craftShape = f.craft;
  latest = f;
  frameAt = performance.now();
}
let padAt = -Infinity;
let ready = false;

function startWorker(): void {
  worker?.terminate();
  ready = false;
  latest = null;
  craftShape = null;
  store.clear();
  renderer.restart();
  worker = new Worker(new URL('./host.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<WorkerOut>) => onWorker(e.data);
  worker.onerror = (e) => { progress.textContent = `The game stopped: ${e.message}`; };
  const start: WorkerIn = {
    t: 'start',
    job: hostMode === 'tv' ? 'host' : 'plan',
    opts: { craft: params.get('craft') ?? undefined, lite: params.has('lite') || castDevice },
  };
  worker.postMessage(start);
  progress.textContent = hostMode === 'tv' ? 'Starting the game…' : 'Waiting for the phone to run the game…';
}

function onWorker(m: WorkerOut): void {
  switch (m.t) {
    case 'progress': progress.textContent = m.text; break;
    case 'summary': renderer.roads = m.data; break;
    case 'structs': store.add(m.pack); break;
    case 'ready': ready = true; progress.textContent = hostMode === 'tv' ? '' : 'Waiting for the phone to run the game…'; break;
    case 'frame':
      if (hostMode !== 'tv') break;
      accept(m.f);
      for (const text of m.f.notes) broadcast({ t: 'toast', text });
      break;
    case 'ctx': if (hostMode === 'tv') broadcast(m.ctx); break;
    case 'rumble': broadcast({ t: 'rumble', s: m.s, ms: m.ms }); break;
    case 'stats': renderer.simLine = `sim ${m.realtime.toFixed(2)}× real time, busy ${Math.round(m.busy * 100)}%`; break;
    case 'error': progress.textContent = `The game stopped: ${m.text}`; break;
  }
}

// --- Links to the phone.
const code = isPairCode(params.get('code')?.toUpperCase()) ? params.get('code')!.toUpperCase() : pairCode(() => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32);
const links: Link[] = [];
const linkState = new Map<Link, string>();
if (castDevice) links.push(new CastReceiverLink());
if (!castDevice || params.has('relay')) {
  links.push(new RelayLink(relayBase(params), code, 'tv'));
  links.push(new LocalLink(code, 'tv'));
}
const padUrl = new URL('pad.html', location.href);
$('tv-pad-url').textContent = `${padUrl.host}${padUrl.pathname}`;
$('tv-code').textContent = code;
$('tv-pair').classList.toggle('hidden', castDevice && !params.has('relay'));
$('tv-cast').classList.toggle('hidden', !castDevice);
badge.textContent = castDevice && !params.has('relay') ? '' : `PAD CODE ${code}`;

function broadcast(m: TvMessage): void {
  for (const l of links) l.send(m);
}

const LINK_NAMES: Record<Link['kind'], string> = { cast: 'Cast', relay: 'Relay', local: 'This browser' };
for (const link of links) {
  link.onState = (state: LinkState, detail: string) => {
    linkState.set(link, `${LINK_NAMES[link.kind]}: ${detail || state}`);
    status.textContent = [...linkState.values()].join('\n');
  };
  link.onMessage = (raw) => {
    const m = parsePadMessage(raw);
    if (!m) return;
    if (m.t === 'hello') {
      const want = m.host ? 'pad' : 'tv';
      if (want !== hostMode) {
        hostMode = want;
        startWorker();
      } else worker?.postMessage({ t: 'resync' } satisfies WorkerIn);
      broadcast({ t: 'welcome', v: PAD_VERSION, host: hostMode });
      renderer.linkLine = `Pad linked by ${LINK_NAMES[link.kind]}${link.kind === 'cast' ? '' : ` · code ${code}`}`;
      renderer.toast(`${m.name || 'A phone'} joined${m.host ? ' and runs the game' : ''}`);
      padAt = performance.now();
    } else if (m.t === 'in') {
      padAt = performance.now();
      if (hostMode === 'tv') worker?.postMessage({ t: 'in', msg: m, src: 'pad' } satisfies WorkerIn);
    } else if (m.t === 'frame') {
      padAt = performance.now();
      if (hostMode !== 'pad') return;
      accept(m.f);
      if (m.f.chunks) worker?.postMessage({ t: 'chunks', list: m.f.chunks } satisfies WorkerIn);
    }
  };
}

// --- This device's own keyboard and gamepad (a laptop on the TV): a second pad, local.
const keyboard = new KeyboardDevice();
const gamepad = new GamepadDevice();
const localPacker = new PadInputPacker();
const settings = loadInputSettings();
let localAt = -Infinity;
let localSentAt = 0;
let localProfile: ControlProfile = 'airplane';
function pollLocal(now: number): void {
  const raw = emptyRaw();
  const ctx = { profile: localProfile, onFoot: !!latest?.me.foot, throttle: latest?.hud.thr ?? 0, settings };
  keyboard.read(raw);
  gamepad.read(raw, ctx);
  const actions: Action[] = [];
  keyboard.drainActions(actions);
  gamepad.drainActions(actions);
  const active = actions.length > 0 || raw.throttleSet !== null || Math.abs(raw.pitch) + Math.abs(raw.roll) + Math.abs(raw.yaw) + Math.abs(raw.throttleRate) + raw.brake > 0 || raw.fire || raw.fireAlt;
  if (active) localAt = now;
  // The local devices speak only while used (and a moment after), so they never hold the phone's stick at zero.
  if (now - localAt > 1000) return;
  localPacker.add(raw, actions);
  if (localPacker.urgent || now - localSentAt > 1000 / PAD_INPUT_HZ) {
    localSentAt = now;
    const msg = localPacker.take();
    if (hostMode === 'tv') worker?.postMessage({ t: 'in', msg, src: 'local' } satisfies WorkerIn);
    else for (const a of msg.a ?? []) if (a === 'camera' || a === 'help') latest?.ui.push(a);
  }
}

// --- Draw.
let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  pollLocal(now);
  const f = latest;
  if (f && !f.craft && craftShape?.key === f.me.craft) f.craft = craftShape;
  if (f) localProfile = f.hud.profile === 'foot' ? localProfile : f.hud.profile;
  const playing = !!f && (now - padAt < 4000 || now - localAt < 30000);
  card.classList.toggle('hidden', playing && ready);
  card.classList.toggle('over', !!f);
  if (f) renderer.draw(f, dt, hostMode === 'pad' ? (now - frameAt) / 1000 : 0);
  if (hostMode === 'tv' && f !== drawn) worker?.postMessage({ t: 'want' } satisfies WorkerIn);
  drawn = f;
}
startWorker();
requestAnimationFrame(frame);
// Debugging handle (the checks and the browser console).
(window as unknown as { __tv: unknown }).__tv = { renderer, store, get frame() { return latest; } };
