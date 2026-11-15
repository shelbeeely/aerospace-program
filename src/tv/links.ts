import { GRID_RELAY } from '../net/protocol.ts';
import { PAD_NAMESPACE } from './protocol.ts';

/**
 * How the pad (the phone) and the TV talk. Every link carries the same JSON messages
 * (src/tv/protocol.ts); the pages pick one:
 *
 * - Cast: the phone starts a Google Cast session with this game's receiver app (Chrome on
 *   Android or a desktop); messages ride the session's custom channel (PAD_NAMESPACE). The TV is
 *   the receiver page running on the Chromecast. Needs a registered receiver app id.
 * - Relay: both open the relay's /pad endpoint with the same four-letter code (server/pads.ts).
 *   Works for any phone (iPhones too) and any browser on the TV.
 * - Local: a BroadcastChannel between two tabs of one browser (development, and a laptop on the
 *   TV's HDMI with the pad in another window).
 */

export type LinkState = 'connecting' | 'waiting' | 'connected' | 'closed' | 'error';

export interface Link {
  readonly kind: 'cast' | 'relay' | 'local';
  send(msg: object): void;
  close(): void;
  onMessage: ((msg: unknown) => void) | null;
  /** State and a line to show the player. */
  onState: ((state: LinkState, detail: string) => void) | null;
}

/** The relay's base URL: `?server=`, the build's VITE_GRID_SERVER, or the deployed relay. */
export function relayBase(params: URLSearchParams): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const s = params.get('server')?.trim() || env?.VITE_GRID_SERVER?.trim() || GRID_RELAY;
  return s.replace(/\/+$/, '');
}

/** The Cast receiver app id: `?castApp=`, remembered, else the build's VITE_CAST_APP_ID. */
export function castAppId(params: URLSearchParams): string | null {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const fromUrl = params.get('castApp')?.trim();
  try {
    if (fromUrl) localStorage.setItem('castAppId', fromUrl);
    return fromUrl || localStorage.getItem('castAppId') || env?.VITE_CAST_APP_ID?.trim() || null;
  } catch {
    return fromUrl || env?.VITE_CAST_APP_ID?.trim() || null;
  }
}

abstract class BaseLink implements Link {
  abstract readonly kind: Link['kind'];
  onMessage: ((msg: unknown) => void) | null = null;
  onState: ((state: LinkState, detail: string) => void) | null = null;
  protected state(s: LinkState, detail: string): void {
    // Let the page attach its handlers before the first state arrives.
    queueMicrotask(() => this.onState?.(s, detail));
  }
  abstract send(msg: object): void;
  abstract close(): void;
}

/** Two tabs of one browser. */
export class LocalLink extends BaseLink {
  readonly kind = 'local' as const;
  private readonly ch: BroadcastChannel;
  constructor(code: string, private readonly role: 'tv' | 'pad') {
    super();
    this.ch = new BroadcastChannel(`aerospace-pad:${code}`);
    this.ch.onmessage = (e) => {
      const d = e.data as { from?: string; msg?: unknown };
      if (d && d.from !== this.role) this.onMessage?.(d.msg);
    };
    this.state('connected', `this browser, code ${code}`);
  }
  send(msg: object): void {
    this.ch.postMessage({ from: this.role, msg });
  }
  close(): void {
    this.ch.close();
    this.state('closed', '');
  }
}

/** The relay's pad pairing. Reconnects with backoff while open. */
export class RelayLink extends BaseLink {
  readonly kind = 'relay' as const;
  private ws: WebSocket | null = null;
  private closed = false;
  private tries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The other side is there (from the relay's `pair` messages). */
  paired = false;
  constructor(private readonly base: string, readonly code: string, private readonly role: 'tv' | 'pad') {
    super();
    this.open();
  }
  private open(): void {
    this.state('connecting', this.tries ? 'reconnecting to the relay…' : 'reaching the relay (a sleeping relay takes a minute to wake)…');
    const ws = new WebSocket(`${this.base}/pad?code=${encodeURIComponent(this.code)}&role=${this.role}`);
    this.ws = ws;
    ws.onopen = () => { this.tries = 0; };
    ws.onmessage = (e) => {
      let m: unknown;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      const o = m as { t?: string; tv?: boolean; pads?: number; code?: string };
      if (o.t === 'pair') {
        this.paired = this.role === 'pad' ? !!o.tv : (o.pads ?? 0) > 0;
        this.state(this.paired ? 'connected' : 'waiting', this.paired
          ? (this.role === 'pad' ? `TV ${this.code}` : `${o.pads} pad${o.pads === 1 ? '' : 's'}`)
          : (this.role === 'pad' ? `waiting for TV ${this.code}` : `code ${this.code}`));
        return;
      }
      if (o.t === 'pair-error') {
        this.closed = true;
        this.state('error', o.code === 'code-taken' ? 'that code is in use' : o.code === 'full' ? 'that TV has four pads already' : 'the relay refused the code');
        return;
      }
      this.onMessage?.(m);
    };
    ws.onclose = () => {
      this.paired = false;
      if (this.closed) return;
      this.tries++;
      const wait = Math.min(15000, 1000 * 2 ** Math.min(4, this.tries));
      this.state('connecting', `relay unreachable, retrying in ${Math.round(wait / 1000)} s`);
      this.timer = setTimeout(() => this.open(), wait);
    };
  }
  send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.paired) this.ws.send(JSON.stringify(msg));
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.state('closed', '');
  }
}

// --- Google Cast (the few parts of the Web Sender and Web Receiver SDKs used here)

interface CastReceiverContext {
  addCustomMessageListener(ns: string, fn: (e: { data: unknown; senderId: string }) => void): void;
  addEventListener(type: string, fn: (e: { senderId?: string }) => void): void;
  sendCustomMessage(ns: string, senderId: string | undefined, data: unknown): void;
  start(options: object): void;
}
interface CastReceiverNs {
  framework: {
    CastReceiverContext: { getInstance(): CastReceiverContext };
    CastReceiverOptions: new () => Record<string, unknown>;
    system: { MessageType: { JSON: unknown }; EventType: Record<string, string> };
  };
}
interface CastSession {
  sendMessage(ns: string, msg: object): Promise<unknown>;
  addMessageListener(ns: string, fn: (ns: string, message: string) => void): void;
  removeMessageListener(ns: string, fn: (ns: string, message: string) => void): void;
  getCastDevice(): { friendlyName: string };
  endSession(stop: boolean): void;
}
interface CastContext {
  setOptions(o: object): void;
  addEventListener(type: string, fn: (e: { sessionState: string }) => void): void;
  getCurrentSession(): CastSession | null;
  requestSession(): Promise<unknown>;
}
interface CastSenderNs {
  framework: {
    CastContext: { getInstance(): CastContext };
    CastContextEventType: { SESSION_STATE_CHANGED: string };
    SessionState: Record<string, string>;
  };
}

const RECEIVER_SDK = 'https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js';
const SENDER_SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

function loadScript(src: string): Promise<void> {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

/** Is this page running on a Cast device (a Chromecast, a Google TV)? */
export const onCastDevice = (): boolean => typeof navigator !== 'undefined' && /CrKey/.test(navigator.userAgent);

/** The TV side on a Chromecast: the Web Receiver's custom channel. Replies go to every sender. */
export class CastReceiverLink extends BaseLink {
  readonly kind = 'cast' as const;
  private ctx: CastReceiverContext | null = null;
  senders = 0;
  constructor() {
    super();
    this.state('connecting', 'starting the Cast receiver…');
    void loadScript(RECEIVER_SDK).then(() => {
      const cast = (globalThis as unknown as { cast: CastReceiverNs }).cast;
      const ctx = cast.framework.CastReceiverContext.getInstance();
      this.ctx = ctx;
      ctx.addCustomMessageListener(PAD_NAMESPACE, (e) => this.onMessage?.(e.data));
      const ev = cast.framework.system.EventType;
      ctx.addEventListener(ev.SENDER_CONNECTED, () => { this.senders++; this.state('connected', 'phone connected over Cast'); });
      ctx.addEventListener(ev.SENDER_DISCONNECTED, () => { this.senders = Math.max(0, this.senders - 1); if (!this.senders) this.state('waiting', 'phone disconnected'); });
      const opts = new cast.framework.CastReceiverOptions();
      opts.customNamespaces = { [PAD_NAMESPACE]: cast.framework.system.MessageType.JSON };
      // A game, not a media app: stay up while nothing plays, and load no media players.
      opts.disableIdleTimeout = true;
      opts.skipPlayersLoad = true;
      ctx.start(opts);
      this.state('waiting', 'Cast receiver ready');
    }, (err: Error) => this.state('error', err.message));
  }
  send(msg: object): void {
    this.ctx?.sendCustomMessage(PAD_NAMESPACE, undefined, msg);
  }
  close(): void {
    this.state('closed', '');
  }
}

/**
 * The phone side: a Cast session with the receiver app. `start()` (from a tap) opens Chrome's
 * device picker; an existing session (the page reloaded) is picked up by itself.
 */
export class CastSenderLink extends BaseLink {
  readonly kind = 'cast' as const;
  private ctx: CastContext | null = null;
  private session: CastSession | null = null;
  private readonly listener = (_ns: string, message: string) => {
    try { this.onMessage?.(JSON.parse(message)); } catch { /* not JSON */ }
  };
  /** Resolves true when the SDK is there and casting is possible in this browser. */
  readonly ready: Promise<boolean>;

  constructor(appId: string) {
    super();
    this.ready = new Promise<boolean>((resolve) => {
      const w = window as unknown as { __onGCastApiAvailable?: (ok: boolean) => void; cast?: CastSenderNs; chrome?: { cast?: { AutoJoinPolicy: Record<string, string> } } };
      w.__onGCastApiAvailable = (ok) => {
        if (!ok || !w.cast?.framework) { this.state('error', 'this browser cannot cast (Chrome on Android or a computer can)'); resolve(false); return; }
        const fw = w.cast.framework;
        const ctx = fw.CastContext.getInstance();
        this.ctx = ctx;
        ctx.setOptions({ receiverApplicationId: appId, autoJoinPolicy: w.chrome?.cast?.AutoJoinPolicy.ORIGIN_SCOPED ?? 'origin_scoped' });
        ctx.addEventListener(fw.CastContextEventType.SESSION_STATE_CHANGED, (e) => {
          if (e.sessionState === fw.SessionState.SESSION_STARTED || e.sessionState === fw.SessionState.SESSION_RESUMED) this.attach(ctx.getCurrentSession());
          else if (e.sessionState === fw.SessionState.SESSION_ENDED) this.attach(null);
          else if (e.sessionState === fw.SessionState.SESSION_START_FAILED) this.state('error', 'could not start casting');
        });
        this.attach(ctx.getCurrentSession());
        resolve(true);
      };
      loadScript(SENDER_SDK).catch(() => { this.state('error', 'could not load the Cast SDK'); resolve(false); });
    });
  }

  private attach(s: CastSession | null): void {
    if (this.session === s) return;
    this.session?.removeMessageListener(PAD_NAMESPACE, this.listener);
    this.session = s;
    if (s) {
      s.addMessageListener(PAD_NAMESPACE, this.listener);
      this.state('connected', `casting to ${s.getCastDevice().friendlyName}`);
    } else this.state('waiting', 'not casting');
  }

  get casting(): boolean {
    return !!this.session;
  }

  /** Open the device picker (call from a tap). */
  async start(): Promise<void> {
    if (!(await this.ready) || !this.ctx) return;
    try { await this.ctx.requestSession(); } catch { /* cancelled */ }
  }

  send(msg: object): void {
    void this.session?.sendMessage(PAD_NAMESPACE, msg).catch(() => {});
  }

  close(): void {
    this.session?.endSession(true);
    this.attach(null);
  }
}
