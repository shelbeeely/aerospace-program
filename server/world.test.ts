/**
 * `bun test server`: the Bits' world the relay keeps (server/world.ts), driven directly and over
 * the lobby.
 */
import { expect, test } from 'bun:test';
import { World } from './world.ts';
import { Lobby, type Peer } from './rooms.ts';
import { founderGenome, seededRand } from '../src/people/genome.ts';
import { decodePools, encodePools, fromBase64, toBase64, type StoredLot } from '../src/sim/evolution.ts';
import { PROTOCOL_VERSION, type ServerMessage } from '../src/net/protocol.ts';
import type { CraftDef } from '../src/craft/types.ts';

const CRAFT = { formatVersion: 1, name: 'c', parts: [{ id: 'b', kind: 'fuselage', shape: { type: 'box', size: [1, 1, 1] }, position: [0, 0, 0], mass: 1, color: '#00eaff' }] } as unknown as CraftDef;

/** A lot of `n` grown Bits. */
function lot(key: number, n = 12, seed = 1): StoredLot {
  const rand = seededRand(seed);
  const people = Array.from({ length: n }, (_, i) => ({ genome: founderGenome(rand, rand(), 0.3), age: 150 + rand() * 300, life: 600, energy: 0.9, gen: 0, slot: i, lineage: key * 32 + i, prestige: 0 }));
  return { key, births: 0, capacity: Math.ceil(n * 1.5), people };
}
const b64 = (...lots: StoredLot[]) => toBase64(encodePools(lots));
const read = (pool: string | null) => (pool ? decodePools(fromBase64(pool)!)![0] : null);

test('a lot nobody holds goes on living while no one is there', () => {
  let now = 0;
  const w = new World({ now: () => now });
  expect(w.push('a', 7, b64(lot(7)))).toBe(true);
  w.release('a', [7]);
  const before = read(w.want('b', [7])[0].pool)!;
  w.release('b', [7]);
  for (let i = 0; i < 360; i++) { now += 10_000; w.tick(); } // an hour
  const after = read(w.want('b', [7])[0].pool)!;
  expect(w.births).toBeGreaterThan(0);
  expect(after.births).toBeGreaterThan(before.births);
  expect(Math.max(...after.people.map((p) => p.gen))).toBeGreaterThan(0);
  expect(after.people.length).toBeLessThanOrEqual(after.capacity);
});

test('one holder per lot; a lapsed or released lease goes back to the world', () => {
  let now = 0;
  const w = new World({ now: () => now, leaseMs: 60_000 });
  expect(w.want('a', [3])[0]).toEqual({ key: 3, pool: null, holder: true }); // nobody has it yet: a registers it
  expect(w.push('a', 3, b64(lot(3)))).toBe(true);
  const b = w.want('b', [3])[0];
  expect(b.holder).toBe(false);
  expect(read(b.pool)!.people.length).toBe(12);
  expect(w.push('b', 3, b64(lot(3, 4)))).toBe(false); // not b's to write
  now += 61_000; // a goes quiet
  w.tick();
  expect(w.want('b', [3])[0].holder).toBe(true);
  w.release('b', [3]);
  expect(w.want('c', [3])[0].holder).toBe(true);
  w.drop('c');
  expect(w.lots.get(3)!.holder).toBeNull();
});

test('a Bit derezzed in another game reaches the holder, or leaves the pool', () => {
  const w = new World({ now: () => 0 });
  w.push('a', 5, b64(lot(5)));
  expect(w.derez('b', 5, 2)).toBe('a');
  w.release('a', [5]);
  expect(w.derez('b', 5, 2)).toBeNull();
  expect(w.lots.get(5)!.lot.people.some((p) => p.slot === 2)).toBe(false);
});

test('malformed pools are refused', () => {
  const w = new World({ now: () => 0 });
  expect(w.push('a', 9, 'AAAA')).toBe(false);
  expect(w.push('a', 9, b64(lot(8)))).toBe(false); // the wrong lot
  const over = lot(9, 10);
  over.capacity = 4; // more people than room
  expect(w.push('a', 9, b64(over))).toBe(false);
  expect(w.offer(b64(lot(1), lot(2)), [0])).toBe(0); // away list does not match
  expect(w.lots.size).toBe(0);
});

test('an empty relay reseeds from a client\'s saved pools, carried forward', () => {
  let now = 0;
  const w = new World({ now: () => now });
  expect(w.offer(b64(lot(11), lot(12, 8, 2)), [600, 0])).toBe(2);
  expect(w.lots.size).toBe(2);
  expect(w.births).toBeGreaterThan(0); // the hour away was lived
  w.push('a', 11, b64(lot(11, 3)));
  expect(w.offer(b64(lot(11)), [0])).toBe(0); // it has 11 now: offers do not overwrite
  expect(w.lots.get(11)!.lot.people.length).toBe(3);
});

test('over the lobby: welcome says the world is kept, lots flow, derez is passed on', () => {
  const world = new World({ now: () => 0 });
  const lobby = new Lobby({ now: () => 0, broadcast: () => {}, world });
  const inbox = new Map<string, ServerMessage[]>();
  const join = (name: string) => {
    const box: ServerMessage[] = [];
    const peer: Peer = { send: (d) => box.push(JSON.parse(d)), close: () => {}, subscribe: () => {}, unsubscribe: () => {}, publish: () => {} };
    const s = lobby.connect(peer);
    inbox.set(name, box);
    lobby.message(s, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, room: 'WORLD', name, color: '#ffffff', craft: CRAFT }));
    return s;
  };
  const a = join('a'), b = join('b');
  const welcome = inbox.get('a')!.find((m) => m.t === 'welcome');
  expect(welcome && welcome.t === 'welcome' && welcome.world).toBeTruthy();
  lobby.message(a, JSON.stringify({ t: 'lot-want', keys: [21] }));
  expect(inbox.get('a')!.some((m) => m.t === 'lot' && m.key === 21 && m.pool === null && m.holder)).toBe(true);
  lobby.message(a, JSON.stringify({ t: 'lot-push', key: 21, pool: b64(lot(21)) }));
  lobby.message(b, JSON.stringify({ t: 'lot-want', keys: [21] }));
  expect(inbox.get('b')!.some((m) => m.t === 'lot' && m.key === 21 && !!m.pool && !m.holder)).toBe(true);
  lobby.message(b, JSON.stringify({ t: 'lot-derez', key: 21, slot: 4 }));
  expect(inbox.get('a')!.some((m) => m.t === 'lot-derez' && m.key === 21 && m.slot === 4)).toBe(true);
  lobby.disconnect(a);
  lobby.message(b, JSON.stringify({ t: 'lot-want', keys: [21] }));
  expect(inbox.get('b')!.filter((m) => m.t === 'lot' && m.key === 21).at(-1)).toMatchObject({ holder: true });
  // A bad key is refused by the protocol check.
  lobby.message(b, JSON.stringify({ t: 'lot-want', keys: [-1] }));
  expect(inbox.get('b')!.some((m) => m.t === 'error')).toBe(true);
});
