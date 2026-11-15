/**
 * The living world on the relay: it goes on whether anyone is connected, it survives a restart
 * (saved to the disk and read back), and a client in the world gets it on asking.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { LivingHost } from './living.ts';
import { World } from './world.ts';
import { Lobby, type Peer } from './rooms.ts';
import { PROTOCOL_VERSION, type ServerMessage } from '../src/net/protocol.ts';
import type { LivingState } from '../src/living/state.ts';
import type { CraftDef } from '../src/craft/types.ts';

const CRAFT = { formatVersion: 1, name: 'c', parts: [{ id: 'b', kind: 'fuselage', shape: { type: 'box', size: [1, 1, 1] }, position: [0, 0, 0], mass: 1, color: '#00eaff' }] } as unknown as CraftDef;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 2);

test('the living world goes on with nobody connected', () => {
  const host = new LivingHost({ now: T0 });
  const ran = host.tick(T0 + 2 * DAY);
  expect(ran).toBe(2 * 144);
  const s = host.state;
  expect(s.factions.every((f) => f.built + s.sites.filter((x) => x.f === s.factions.indexOf(f)).length > 0)).toBe(true);
  expect(host.stats().tick).toBe(2 * 144);
});

test('it survives a restart: saved to the disk and read back where it left off', () => {
  const dir = mkdtempSync('/tmp/living-');
  try {
    const a = new LivingHost({ dataDir: dir, now: T0 });
    a.tick(T0 + 3 * DAY);
    expect(a.save()).toBe(true);
    expect(a.save()).toBe(false); // nothing new to save
    const b = new LivingHost({ dataDir: dir, now: T0 + 5 * DAY });
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
    // Both carry on identically.
    a.tick(T0 + 4 * DAY);
    b.tick(T0 + 4 * DAY);
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot carries the events since the time asked', () => {
  const host = new LivingHost({ now: T0 });
  host.tick(T0 + 3 * DAY);
  const since = T0 + 2 * DAY;
  const snap = host.snapshot(since);
  expect(snap.log.every((e) => e.t > since)).toBe(true);
  expect(snap.log.length).toBe(host.state.log.filter((e) => e.t > since).length);
  expect(snap.developed.length).toBe(host.state.developed.length);
});

test('a client in the world is told the relay keeps the living world, and gets it on asking', () => {
  const living = new LivingHost({ now: T0 });
  living.tick(T0 + DAY);
  const lobby = new Lobby({ now: () => 0, broadcast: () => {}, world: new World({ now: () => 0 }), living });
  const got: ServerMessage[] = [];
  const peer: Peer = { send: (d) => got.push(JSON.parse(d) as ServerMessage), close: () => {}, subscribe: () => {}, unsubscribe: () => {}, publish: () => {} };
  const s = lobby.connect(peer);
  lobby.message(s, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: 'WORLD', name: 'x', color: '#ffffff', craft: CRAFT }));
  const welcome = got.find((m) => m.t === 'welcome');
  expect(welcome && welcome.t === 'welcome' && welcome.world?.living).toBe(true);
  lobby.message(s, JSON.stringify({ t: 'living-want', since: 0 }));
  const m = got.find((x) => x.t === 'living');
  expect(m && m.t === 'living' && (m.state as LivingState).tick).toBe(144);
  // And it is shared with everyone in the world every few minutes.
  expect(lobby.shareLiving()).toBe(1);
});

test('outside the world rooms, no living world is handed out', () => {
  const living = new LivingHost({ now: T0 });
  const lobby = new Lobby({ now: () => 0, broadcast: () => {}, living });
  const got: ServerMessage[] = [];
  const peer: Peer = { send: (d) => got.push(JSON.parse(d) as ServerMessage), close: () => {}, subscribe: () => {}, unsubscribe: () => {}, publish: () => {} };
  const s = lobby.connect(peer);
  lobby.message(s, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: 'ABCD', name: 'x', color: '#ffffff', craft: CRAFT }));
  lobby.message(s, JSON.stringify({ t: 'living-want', since: 0 }));
  expect(got.some((x) => x.t === 'living')).toBe(false);
});
