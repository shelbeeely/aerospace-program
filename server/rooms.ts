/**
 * Room logic for the multiplayer relay, independent of the transport (server/index.ts wires it
 * to Bun.serve's WebSockets; tests can drive it directly).
 *
 * - Rooms are keyed by a 5-letter code. Joining an unknown valid code creates it; an empty code
 *   creates a fresh random one. At most MAX_PLAYERS per room. A room vanishes with its last player.
 *   WORLD is the shared room every client joins on load: when it is full a newcomer is seated in
 *   the first overflow room with space (WORLA, WORLB, ...) instead of being turned away.
 * - On join the player gets a snapshot (everyone's name, colour, CraftDef and last state); the
 *   room hears `join`. States, craft changes and events are relayed to the room's topic
 *   (everyone but the sender). Messages are shape-checked and size-capped (src/net/protocol.ts)
 *   and rate-limited per player; players that go quiet are dropped.
 * - Nothing persists: no accounts, no storage.
 */
import {
  MAX_PLAYERS, PROTOCOL_VERSION, WORLD_ROOM, asTeam, isRoomCode, parseClientMessage, randomRoomCode, worldOverflowRooms,
  type ClientMessage, type NetTeam, type ErrorCode, type NetState, type PlayerInfo, type ServerMessage,
} from '../src/net/protocol.ts';
import type { CraftDef } from '../src/craft/types.ts';

/** The bits of a Bun ServerWebSocket the lobby uses. */
export interface Peer {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
  subscribe(topic: string): unknown;
  unsubscribe(topic: string): unknown;
  /** Publish to a topic, excluding this peer. */
  publish(topic: string, data: string): unknown;
}

/** Token bucket: `rate` per second, holding up to `burst`. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(private readonly rate: number, private readonly burst: number, now: number) {
    this.tokens = burst;
    this.last = now;
  }
  take(now: number, n = 1): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

export interface Session {
  readonly peer: Peer;
  id: string;
  room: string | null;
  name: string;
  color: string;
  team: NetTeam;
  craft: CraftDef | null;
  state: NetState | null;
  lastSeen: number;
  strikes: number;
  lastErrorAt: number;
  limits: Record<'all' | 'state' | 'event' | 'chat' | 'craft', RateLimiter>;
}

export interface LobbyOptions {
  now?: () => number;
  /** Drop players silent for this long (ms). */
  idleMs?: number;
  /** Publish to every subscriber of a topic (Bun: server.publish). */
  broadcast: (topic: string, data: string) => void;
  log?: (msg: string) => void;
}

const topic = (room: string) => `room:${room}`;
/** Rate-limit violations tolerated before a player is disconnected. */
const MAX_STRIKES = 200;

export class Lobby {
  readonly rooms = new Map<string, Set<Session>>();
  private readonly sessions = new Set<Session>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private nextId = 1;

  constructor(private readonly opts: LobbyOptions) {
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? 20_000;
  }

  get playerCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) n += r.size;
    return n;
  }

  connect(peer: Peer): Session {
    const now = this.now();
    const s: Session = {
      peer, id: `p${(this.nextId++).toString(36)}${Math.random().toString(36).slice(2, 6)}`, room: null,
      name: '', color: '#00eaff', team: 0, craft: null, state: null, lastSeen: now, strikes: 0, lastErrorAt: -Infinity,
      limits: {
        all: new RateLimiter(80, 160, now),
        state: new RateLimiter(30, 60, now),
        event: new RateLimiter(20, 60, now),
        chat: new RateLimiter(1, 5, now),
        craft: new RateLimiter(2, 5, now),
      },
    };
    this.sessions.add(s);
    return s;
  }

  message(s: Session, raw: string, bytes = raw.length): void {
    const now = this.now();
    s.lastSeen = now;
    if (!s.limits.all.take(now)) return this.limited(s, now);
    const m = parseClientMessage(raw, bytes);
    if ('error' in m) return this.error(s, m.error, m.message, now, true);
    if (m.t === 'ping') return this.send(s, { t: 'pong' });
    if (m.t === 'hello') return this.join(s, m);
    if (!s.room) return this.error(s, 'not-joined', 'send hello first', now, true);
    this.relay(s, m, now);
  }

  disconnect(s: Session, reason = 'left'): void {
    if (!this.sessions.delete(s)) return;
    const room = s.room;
    if (!room) return;
    s.room = null;
    s.peer.unsubscribe(topic(room));
    const members = this.rooms.get(room);
    members?.delete(s);
    if (members && members.size === 0) this.rooms.delete(room);
    else this.opts.broadcast(topic(room), JSON.stringify({ t: 'leave', id: s.id, reason } satisfies ServerMessage));
    this.opts.log?.(`${s.name} (${s.id}) left ${room}: ${reason}`);
  }

  /** Drop players that have been silent too long. Returns how many were dropped. */
  sweep(): number {
    const now = this.now();
    let n = 0;
    for (const s of [...this.sessions]) {
      if (now - s.lastSeen <= this.idleMs) continue;
      this.disconnect(s, 'idle');
      try { s.peer.close(4000, 'idle'); } catch { /* already gone */ }
      n++;
    }
    return n;
  }

  private join(s: Session, m: Extract<ClientMessage, { t: 'hello' }>): void {
    const now = this.now();
    if (s.room) return this.error(s, 'bad-message', 'already in a room', now, true);
    let code = m.room;
    if (code === '') {
      do code = randomRoomCode(); while (this.rooms.has(code));
    } else if (!isRoomCode(code)) {
      return this.error(s, 'bad-room', 'room codes are 5 letters', now, true);
    } else if (code === WORLD_ROOM) {
      // The shared world never turns anyone away: a full WORLD seats them in an overflow room.
      code = worldOverflowRooms().find((c) => (this.rooms.get(c)?.size ?? 0) < MAX_PLAYERS) ?? WORLD_ROOM;
    }
    let members = this.rooms.get(code);
    if (members && members.size >= MAX_PLAYERS) {
      this.error(s, 'room-full', `room ${code} is full (${MAX_PLAYERS} players)`, now);
      try { s.peer.close(4001, 'room full'); } catch { /* gone */ }
      this.sessions.delete(s);
      return;
    }
    if (!members) this.rooms.set(code, (members = new Set()));
    s.name = m.name;
    s.color = m.color;
    s.team = asTeam(m.team);
    s.craft = m.craft;
    s.room = code;
    this.send(s, { t: 'welcome', v: PROTOCOL_VERSION, id: s.id, room: code, players: [...members].map(info) });
    members.add(s);
    // Subscribe first, then announce: Bun 1.2 (the relay's image) only publishes from a socket
    // that is subscribed to the topic, so announcing first never reached the room. publish()
    // still leaves the sender out.
    s.peer.subscribe(topic(code));
    s.peer.publish(topic(code), JSON.stringify({ t: 'join', player: info(s) } satisfies ServerMessage));
    this.opts.log?.(`${s.name} (${s.id}) joined ${code} (${members.size}/${MAX_PLAYERS})`);
  }

  private relay(s: Session, m: Exclude<ClientMessage, { t: 'hello' } | { t: 'ping' }>, now: number): void {
    const room = topic(s.room!);
    let out: ServerMessage;
    if (m.t === 'state') {
      if (!s.limits.state.take(now)) return this.limited(s, now);
      // The snapshot keeps the pose only: trail deltas mean nothing to a late joiner.
      s.state = { ...m.s, tr: [] };
      out = { t: 'state', id: s.id, s: m.s };
    } else if (m.t === 'craft') {
      if (!s.limits.craft.take(now)) return this.limited(s, now);
      s.craft = m.craft;
      out = { t: 'craft', id: s.id, craft: m.craft };
    } else if (m.t === 'team') {
      if (!s.limits.craft.take(now)) return this.limited(s, now);
      s.team = m.team;
      out = { t: 'team', id: s.id, team: m.team };
    } else {
      const bucket = m.e.k === 'chat' ? s.limits.chat : s.limits.event;
      if (!bucket.take(now)) return this.limited(s, now);
      // No friendly fire: a hit on a team-mate (or on no one here) goes nowhere.
      if (m.e.k === 'hit') {
        const target = m.e.target;
        const victim = [...(this.rooms.get(s.room!) ?? [])].find((x) => x.id === target);
        if (!victim || victim.team === s.team) return;
      }
      out = { t: 'event', id: s.id, e: m.e.k === 'chat' ? { k: 'chat', text: m.e.text.trim() } : m.e };
    }
    s.peer.publish(room, JSON.stringify(out));
  }

  private limited(s: Session, now: number): void {
    if (++s.strikes > MAX_STRIKES) {
      this.disconnect(s, 'rate limit');
      try { s.peer.close(1008, 'rate limit'); } catch { /* gone */ }
      return;
    }
    this.error(s, 'rate-limited', 'slow down', now, true);
  }

  /** Errors are throttled to one a second per player (`throttle`), so a flood can't echo back as one. */
  private error(s: Session, code: ErrorCode, message: string, now: number, throttle = false): void {
    if (throttle && now - s.lastErrorAt < 1000) return;
    s.lastErrorAt = now;
    this.send(s, { t: 'error', code, message });
  }

  private send(s: Session, m: ServerMessage): void {
    try { s.peer.send(JSON.stringify(m)); } catch { /* closed */ }
  }
}

function info(s: Session): PlayerInfo {
  return { id: s.id, name: s.name, color: s.color, team: s.team, craft: s.craft!, state: s.state };
}
