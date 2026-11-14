/**
 * `bun test server`: real WebSocket clients against a real relay on a random port.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startServer } from './index.ts';
import { Lobby, RateLimiter, type Peer } from './rooms.ts';
import { MAX_MESSAGE_BYTES, MAX_PLAYERS, PROTOCOL_VERSION, type NetState, type ServerMessage } from '../src/net/protocol.ts';
import type { CraftDef } from '../src/craft/types.ts';

const CRAFT: CraftDef = {
  formatVersion: 1,
  name: 'Test cycle',
  parts: [{ id: 'body', kind: 'fuselage', shape: { type: 'box', size: [1, 1, 2] }, position: [0, 0, 0], mass: 100, color: '#00eaff' }],
} as unknown as CraftDef;

let relay: ReturnType<typeof startServer>;
let url = '';
beforeAll(() => {
  relay = startServer({ port: 0, quiet: true, idleMs: 1500, sweepMs: 200 });
  url = `ws://localhost:${relay.port}/`;
});
afterAll(() => relay.stop());

/** A test client: collects every server message and lets tests wait for one. */
class Client {
  readonly ws: WebSocket;
  readonly inbox: ServerMessage[] = [];
  closed = false;
  private waiters: Array<() => void> = [];
  constructor() {
    this.ws = new WebSocket(url);
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
  send(m: unknown): void {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }
  async waitFor<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, ms = 2000): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.inbox.find((m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>));
      if (hit) return hit as Extract<ServerMessage, { t: T }>;
      const left = deadline - Date.now();
      if (left <= 0 || this.closed) throw new Error(`timed out waiting for ${t}; got ${this.inbox.map((m) => m.t).join(',')}`);
      await new Promise<void>((res) => {
        this.waiters.push(res);
        setTimeout(res, left);
      });
    }
  }
  async join(room: string, name: string) {
    await this.opened();
    this.send({ t: 'hello', v: PROTOCOL_VERSION, room, name, color: '#ff8a1f', craft: CRAFT });
    return this.waitFor('welcome');
  }
  close(): void {
    this.ws.close();
  }
}

const state = (x: number): NetState => ({
  t: Date.now(), p: [x, 2, -50], q: [0, 0, 0, 1], v: [30, 0, 0], c: [0, 0, 0, 1, 0, 0], m: 'flight', x: false, tm: 'wall',
  tr: [{ id: 1, kind: 'wall', color: '#00eaff', height: 1.6, pts: [[x - 3, -50, 0, 1.6, 10], [x - 1.5, -50, 0, 1.6, 11.5]], tail: 0, active: true, derez: false }],
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('health endpoint', async () => {
  const res = await fetch(`http://localhost:${relay.port}/health`);
  expect(res.status).toBe(200);
  const body = await res.json() as { ok: boolean; version: number };
  expect(body.ok).toBe(true);
  expect(body.version).toBe(PROTOCOL_VERSION);
});

test('two players see each other, states and events relay, other rooms are isolated, oversize is rejected', async () => {
  const a = new Client(), b = new Client(), c = new Client();
  const wa = await a.join('TESTA', 'Alpha');
  expect(wa.room).toBe('TESTA');
  expect(wa.players).toHaveLength(0);

  const wb = await b.join('testa', 'Bravo'); // codes are case-insensitive
  expect(wb.room).toBe('TESTA');
  expect(wb.players.map((p) => p.name)).toEqual(['Alpha']);
  expect(wb.players[0].craft.name).toBe('Test cycle');
  const joined = await a.waitFor('join');
  expect(joined.player.name).toBe('Bravo');
  expect(joined.player.id).toBe(wb.id);

  const wc = await c.join('OTHER', 'Charlie');
  expect(wc.players).toHaveLength(0);

  // State relays to the room (not back to the sender, not to other rooms).
  a.send({ t: 'state', s: state(100) });
  const st = await b.waitFor('state');
  expect(st.id).toBe(wa.id);
  expect(st.s.p[0]).toBe(100);
  expect(st.s.tr[0].pts).toHaveLength(2);

  // Events: fracture, explosion, derez, chat.
  b.send({ t: 'event', e: { k: 'fracture', group: 'city:12', hit: { impulse: 9000, x: 1, y: 2, z: 3 }, crater: true } });
  b.send({ t: 'event', e: { k: 'explosion', x: 5, y: 6, z: 7, radius: 12 } });
  b.send({ t: 'event', e: { k: 'chat', text: '  end of line  ' } });
  const fr = await a.waitFor('event', (m) => m.e.k === 'fracture');
  expect(fr.id).toBe(wb.id);
  expect(fr.e.k === 'fracture' && fr.e.group).toBe('city:12');
  await a.waitFor('event', (m) => m.e.k === 'explosion');
  const chat = await a.waitFor('event', (m) => m.e.k === 'chat');
  expect(chat.e.k === 'chat' && chat.e.text).toBe('end of line');

  // A late joiner gets everyone's last pose in the snapshot.
  const d = new Client();
  const wd = await d.join('TESTA', 'Delta');
  expect(wd.players).toHaveLength(2);
  const alpha = wd.players.find((p) => p.name === 'Alpha')!;
  expect(alpha.state?.p[0]).toBe(100);
  expect(alpha.state?.tr).toHaveLength(0);

  // Oversize: an error comes back and nothing relays.
  const big = JSON.stringify({ t: 'event', e: { k: 'chat', text: 'x'.repeat(MAX_MESSAGE_BYTES + 10) } });
  a.send(big);
  const err = await a.waitFor('error');
  expect(err.code).toBe('too-large');
  // Malformed shapes are refused too.
  await sleep(1100); // errors are throttled to one a second
  a.send({ t: 'state', s: { ...state(1), p: [1, 2] } });
  await a.waitFor('error', (m) => m.code === 'bad-message');

  await sleep(150);
  expect(c.inbox.filter((m) => m.t !== 'welcome')).toHaveLength(0); // the other room heard nothing
  expect(b.inbox.some((m) => m.t === 'event' && m.e.k === 'chat' && m.e.text.length > 100)).toBe(false);
  expect(a.inbox.some((m) => m.t === 'state')).toBe(false); // own state never echoes

  // Leaving is announced.
  b.close();
  const left = await a.waitFor('leave');
  expect(left.id).toBe(wb.id);
  for (const x of [a, c, d]) x.close();
});

test('networked damage: hits relay to other teams, a team-mate hit goes nowhere, kills and blasts relay', async () => {
  const a = new Client(), b = new Client(), c = new Client();
  const hello = async (cl: Client, name: string, team: 0 | 1 | 2) => {
    await cl.opened();
    cl.send({ t: 'hello', v: PROTOCOL_VERSION, room: 'FIGHT', name, color: '#ffffff', craft: CRAFT, team });
    return cl.waitFor('welcome');
  };
  const wa = await hello(a, 'Red A', 1);
  const wb = await hello(b, 'Cyan B', 0);
  const wc = await hello(c, 'Red C', 1);
  // A (red) hits B (cyan): relayed.
  a.send({ t: 'event', e: { k: 'hit', target: wb.id, kind: 'gun', x: 1, y: 2, z: 3 } });
  const hit = await b.waitFor('event');
  expect(hit.e).toEqual({ k: 'hit', target: wb.id, kind: 'gun', x: 1, y: 2, z: 3 });
  expect(hit.id).toBe(wa.id);
  // A hits C (both red): dropped. (Everyone in the room sees every relayed hit; only its
  // target applies it, so what matters is that no hit on C was relayed at all.)
  a.send({ t: 'event', e: { k: 'hit', target: wc.id, kind: 'gun', x: 1, y: 2, z: 3 } });
  b.send({ t: 'event', e: { k: 'kill', by: wa.id } });
  const kill = await c.waitFor('event', (m) => m.e.k === 'kill');
  expect(kill.e).toEqual({ k: 'kill', by: wa.id });
  await sleep(100);
  expect(c.inbox.some((m) => m.t === 'event' && m.e.k === 'hit' && m.e.target === wc.id)).toBe(false);
  a.send({ t: 'event', e: { k: 'nuke', x: 10, y: 20, z: 30 } });
  const nuke = await b.waitFor('event', (m) => m.e.k === 'nuke');
  expect(nuke.e).toEqual({ k: 'nuke', x: 10, y: 20, z: 30 });
  // A malformed hit (unknown weapon) is refused.
  a.send({ t: 'event', e: { k: 'hit', target: wb.id, kind: 'death-ray', x: 1, y: 2, z: 3 } as never });
  const err = await a.waitFor('error');
  expect(err.code).toBe('bad-message');
  a.close(); b.close(); c.close();
});

test('diplomacy: a war or cease fire relays to the room; a team at war with itself is refused', async () => {
  const a = new Client(), b = new Client();
  for (const [cl, name, team] of [[a, 'Cyan A', 0], [b, 'Red B', 1]] as const) {
    await cl.opened();
    cl.send({ t: 'hello', v: PROTOCOL_VERSION, room: 'PEACE', name, color: '#ffffff', craft: CRAFT, team });
    await cl.waitFor('welcome');
  }
  a.send({ t: 'event', e: { k: 'war', a: 0, b: 1, on: true } });
  const war = await b.waitFor('event', (m) => m.e.k === 'war');
  expect(war.e).toEqual({ k: 'war', a: 0, b: 1, on: true });
  a.send({ t: 'event', e: { k: 'war', a: 0, b: 1, on: false } });
  const peace = await b.waitFor('event', (m) => m.e.k === 'war' && m.e.on === false);
  expect(peace.e).toEqual({ k: 'war', a: 0, b: 1, on: false });
  a.send({ t: 'event', e: { k: 'war', a: 1, b: 1, on: true } as never });
  const err = await a.waitFor('error');
  expect(err.code).toBe('bad-message');
  a.close(); b.close();
});

test('teams: given on hello, relayed on change, invalid ones read as Cyan', async () => {
  const a = new Client(), b = new Client();
  await a.opened();
  a.send({ t: 'hello', v: PROTOCOL_VERSION, room: 'TEAMS', name: 'Red one', color: '#ff2a12', craft: CRAFT, team: 1 });
  await a.waitFor('welcome');
  await b.opened();
  b.send({ t: 'hello', v: PROTOCOL_VERSION, room: 'TEAMS', name: 'Odd one', color: '#ffffff', craft: CRAFT, team: 7 as never });
  const wb = await b.waitFor('welcome');
  expect(wb.players.map((p) => p.team)).toEqual([1]);
  const joined = await a.waitFor('join');
  expect(joined.player.team).toBe(0);
  a.send({ t: 'team', team: 2 });
  const change = await b.waitFor('team');
  expect(change.team).toBe(2);
  expect(change.id).toBe(wb.players[0].id);
  a.close();
  b.close();
});

test('room creation, bad codes and protocol version', async () => {
  const a = new Client();
  const w = await a.join('', 'Alpha');
  expect(w.room).toMatch(/^[A-Z]{5}$/);
  a.close();

  const b = new Client();
  await b.opened();
  b.send({ t: 'hello', v: PROTOCOL_VERSION, room: 'TOOLONG', name: 'x', color: '#ffffff', craft: CRAFT });
  expect((await b.waitFor('error')).code).toBe('bad-room');
  b.close();

  const c = new Client();
  await c.opened();
  c.send({ t: 'hello', v: PROTOCOL_VERSION + 99, room: 'ABCDE', name: 'x', color: '#ffffff', craft: CRAFT });
  expect((await c.waitFor('error')).code).toBe('version');
  c.send({ t: 'state', s: state(0) });
  c.close();
});

test('idle players are dropped', async () => {
  const a = new Client(), b = new Client();
  await a.join('IDLEX', 'Alpha');
  const wb = await b.join('IDLEX', 'Bravo');
  // Alpha keeps talking; Bravo goes silent.
  const keep = setInterval(() => a.send({ t: 'ping' }), 300);
  try {
    const left = await a.waitFor('leave', () => true, 4000);
    expect(left.id).toBe(wb.id);
    expect(left.reason).toBe('idle');
  } finally {
    clearInterval(keep);
    a.close();
    b.close();
  }
});

test('rate limiting', () => {
  const r = new RateLimiter(10, 5, 0);
  let ok = 0;
  for (let i = 0; i < 20; i++) if (r.take(0)) ok++;
  expect(ok).toBe(5);
  expect(r.take(1000)).toBe(true); // refilled

  // A state flood is cut off at the bucket, not relayed.
  const now = 0;
  const published: string[] = [];
  const sent: string[] = [];
  const peer: Peer = { send: (d) => sent.push(d), close: () => {}, subscribe: () => {}, unsubscribe: () => {}, publish: (_t, d) => published.push(d) };
  const lobby = new Lobby({ now: () => now, broadcast: () => {} });
  const s = lobby.connect(peer);
  lobby.message(s, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: 'RATEX', name: 'x', color: '#ffffff', craft: CRAFT }));
  published.length = 0;
  for (let i = 0; i < 500; i++) lobby.message(s, JSON.stringify({ t: 'state', s: state(i) }));
  expect(published.length).toBeLessThanOrEqual(60);
  expect(sent.some((d) => d.includes('rate-limited'))).toBe(true);
});

test('a full WORLD seats newcomers in its overflow rooms', () => {
  const lobby = new Lobby({ now: () => 0, broadcast: () => {} });
  const welcomes: string[] = [];
  const join = () => {
    const peer: Peer = {
      send: (d) => { const m = JSON.parse(d) as ServerMessage; if (m.t === 'welcome') welcomes.push(m.room); },
      close: () => {}, subscribe: () => {}, unsubscribe: () => {}, publish: () => {},
    };
    const s = lobby.connect(peer);
    lobby.message(s, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: 'WORLD', name: 'x', color: '#ffffff', craft: CRAFT }));
    return s;
  };
  const first = Array.from({ length: MAX_PLAYERS }, join);
  expect(welcomes.every((r) => r === 'WORLD')).toBe(true);
  join();
  expect(welcomes.at(-1)).toBe('WORLA');
  expect(lobby.rooms.get('WORLD')?.size).toBe(MAX_PLAYERS);
  // A seat frees up in WORLD: the next newcomer goes back there.
  lobby.disconnect(first[0]);
  join();
  expect(welcomes.at(-1)).toBe('WORLD');
});
