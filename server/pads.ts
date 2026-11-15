/**
 * Phone-as-gamepad pairing on the relay (src/tv/protocol.ts; codes: src/tv/pair.ts): a TV page
 * and the phones that drive it meet on a four-letter code, at ws://host/pad?code=ABCD&role=tv|pad.
 * For phones that cannot cast (iPhones: no web Cast sender) and TVs that are just a browser.
 *
 * - One TV per code (a second is refused, so nobody can take over a TV by guessing its code);
 *   up to MAX_PADS pads. Pads may arrive first and wait for their TV.
 * - Frames are passed on unread: TV → every pad, pad → the TV. Each is size-capped
 *   (PAD_MAX_BYTES: controls and context, not game frames: a phone that runs the game sends
 *   those over the cast channel or a BroadcastChannel) and rate-limited per connection.
 * - The relay's own messages are `{t:'pair', tv, pads}` (who is there, on every change) and
 *   `{t:'pair-error', code}`.
 */
import { RateLimiter } from './rooms.ts';
import { isPairCode } from '../src/tv/pair.ts';

export const PAD_MAX_BYTES = 4096;
export const MAX_PADS = 4;
const MAX_STRIKES = 120;

export interface PadPeer {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

export interface PadSession {
  readonly peer: PadPeer;
  readonly code: string;
  readonly role: 'tv' | 'pad';
  limiter: RateLimiter;
  strikes: number;
}

interface Pair {
  tv: PadSession | null;
  pads: Set<PadSession>;
}

export class PadHub {
  readonly pairs = new Map<string, Pair>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A new connection: its session, or why it was refused (it is closed). */
  connect(peer: PadPeer, code: unknown, role: unknown): PadSession | null {
    const refuse = (why: string) => {
      peer.send(JSON.stringify({ t: 'pair-error', code: why }));
      peer.close(4000, why);
      return null;
    };
    if (!isPairCode(code)) return refuse('bad-code');
    if (role !== 'tv' && role !== 'pad') return refuse('bad-role');
    let pair = this.pairs.get(code);
    if (!pair) this.pairs.set(code, (pair = { tv: null, pads: new Set() }));
    if (role === 'tv' && pair.tv) return refuse('code-taken');
    if (role === 'pad' && pair.pads.size >= MAX_PADS) return refuse('full');
    const s: PadSession = { peer, code, role, limiter: new RateLimiter(60, 120, this.now()), strikes: 0 };
    if (role === 'tv') pair.tv = s;
    else pair.pads.add(s);
    this.announce(pair);
    return s;
  }

  message(s: PadSession, raw: string, bytes = raw.length): void {
    const pair = this.pairs.get(s.code);
    if (!pair) return;
    if (bytes > PAD_MAX_BYTES || !s.limiter.take(this.now())) {
      if (++s.strikes > MAX_STRIKES) s.peer.close(4008, 'rate');
      return;
    }
    if (s.role === 'pad') pair.tv?.peer.send(raw);
    else for (const p of pair.pads) p.peer.send(raw);
  }

  disconnect(s: PadSession): void {
    const pair = this.pairs.get(s.code);
    if (!pair) return;
    if (pair.tv === s) pair.tv = null;
    pair.pads.delete(s);
    if (!pair.tv && pair.pads.size === 0) this.pairs.delete(s.code);
    else this.announce(pair);
  }

  private announce(pair: Pair): void {
    const m = JSON.stringify({ t: 'pair', tv: !!pair.tv, pads: pair.pads.size });
    pair.tv?.peer.send(m);
    for (const p of pair.pads) p.peer.send(m);
  }
}
