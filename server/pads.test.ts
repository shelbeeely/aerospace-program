/**
 * `bun test server`: the phone-as-gamepad pairing (server/pads.ts), against a real relay.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startServer } from './index.ts';
import { PAD_MAX_BYTES } from './pads.ts';

let relay: ReturnType<typeof startServer>;
let base = '';
beforeAll(() => {
  relay = startServer({ port: 0, quiet: true, worldTickMs: 0 });
  base = `ws://localhost:${relay.port}/pad`;
});
afterAll(() => relay.stop());

class End {
  readonly ws: WebSocket;
  readonly inbox: Array<Record<string, unknown>> = [];
  closed = false;
  private waiters: Array<() => void> = [];
  constructor(code: string, role: string) {
    this.ws = new WebSocket(`${base}?code=${code}&role=${role}`);
    this.ws.onmessage = (e) => {
      this.inbox.push(JSON.parse(String(e.data)));
      for (const w of this.waiters.splice(0)) w();
    };
    this.ws.onclose = () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w();
    };
  }
  opened(): Promise<void> {
    return new Promise((res, rej) => {
      if (this.ws.readyState === WebSocket.OPEN) return res();
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('connect failed'));
    });
  }
  async next(pred: (m: Record<string, unknown>) => boolean, ms = 2000): Promise<Record<string, unknown>> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      if (this.closed || Date.now() > end) throw new Error(`no message (closed: ${this.closed})`);
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50); });
    }
  }
  send(m: unknown): void {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }
}

test('a TV and its pad pair on a code and pass messages both ways', async () => {
  const tv = new End('ABCD', 'tv');
  await tv.opened();
  expect((await tv.next((m) => m.t === 'pair')).pads).toBe(0);
  const pad = new End('ABCD', 'pad');
  await pad.opened();
  expect(await pad.next((m) => m.t === 'pair')).toEqual({ t: 'pair', tv: true, pads: 1 });
  pad.send({ t: 'in', s: 1, ax: [0.5, 0, 0, 0, 0, 0, 0, 0], b: 1 });
  expect((await tv.next((m) => m.t === 'in')).ax).toEqual([0.5, 0, 0, 0, 0, 0, 0, 0]);
  tv.send({ t: 'rumble', s: 1, ms: 200 });
  expect((await pad.next((m) => m.t === 'rumble')).ms).toBe(200);
  pad.ws.close();
  expect(await tv.next((m) => m.t === 'pair' && m.pads === 0)).toEqual({ t: 'pair', tv: true, pads: 0 });
  tv.ws.close();
});

test('a second TV cannot take a code that is in use; bad codes are refused', async () => {
  const tv = new End('WXYZ', 'tv');
  await tv.opened();
  const thief = new End('WXYZ', 'tv');
  expect((await thief.next((m) => m.t === 'pair-error')).code).toBe('code-taken');
  const bad = new End('ab1', 'pad');
  expect((await bad.next((m) => m.t === 'pair-error')).code).toBe('bad-code');
  tv.ws.close();
});

test('a pad may arrive first; oversize frames are not passed on', async () => {
  const pad = new End('KMNP', 'pad');
  await pad.opened();
  expect(await pad.next((m) => m.t === 'pair')).toEqual({ t: 'pair', tv: false, pads: 1 });
  const tv = new End('KMNP', 'tv');
  await tv.opened();
  await pad.next((m) => m.t === 'pair' && m.tv === true);
  pad.send({ t: 'in', s: 1, pad: 'x'.repeat(PAD_MAX_BYTES + 10) });
  pad.send({ t: 'in', s: 2 });
  const got = await tv.next((m) => m.t === 'in');
  expect(got.s).toBe(2);
  pad.ws.close();
  tv.ws.close();
});
