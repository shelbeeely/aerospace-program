import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import type { CraftDef } from '../craft/types.ts';
import { RemoteCraftView } from '../render/RemoteCraftView.ts';
import { ShotScanner, type NetTarget } from './hits.ts';
import type { WeaponKind } from '../sim/weapons.ts';
import { TrailView } from '../render/TrailView.ts';
import { PLANET } from '../sim/layout.ts';
import type { Simulation } from '../sim/Simulation.ts';
import { DEREZ_TIME, type Trail, type TrailMode, type TrailPoint, type TrailSystem } from '../sim/trails.ts';
import {
  MAX_TRAIL_POINTS, PROTOCOL_VERSION, STATE_HZ, normalizeRoom, r2, r4, splitGroupName, validCraftShape, validEvent, validState,
  type ClientMessage, type NetEvent, type NetState, type NetTrail, type NetTrailPoint, type PlayerInfo, type ServerMessage, asTeam, type NetTeam, HIT_KINDS,
} from './protocol.ts';

/**
 * The client half of multiplayer. Owns the WebSocket to the relay (server/index.ts), sends the
 * local craft's state at STATE_HZ, and brings everyone else into this world:
 *
 * - Remote craft are drawn from their CraftDef (RemoteCraftView), interpolated INTERP_DELAY
 *   behind the newest state (extrapolated briefly from velocity when packets are late).
 * - Their trails arrive as point deltas and are drawn by one shared TrailView in their colour.
 *   Remote jetwalls near you get static colliders in the local physics world, so riding into
 *   one crashes (derezzes) you just like your own walls.
 * - Fractures replicate by StaticWorld group NAME (registration order differs between clients;
 *   planet-chunk names carry an image suffix that is re-based onto the local image). A fracture
 *   for a structure this client hasn't streamed in yet waits until it is registered.
 * - Explosions show (and are heard) locally; derez events take a player's trails down.
 *
 * Positions are flat-world coordinates; the planet wraps, so every remote position is shown at
 * its image nearest the local craft. Not connected = single player, untouched.
 */
export type NetStatus = 'offline' | 'connecting' | 'connected' | 'error';

/** Render remote craft this far behind their newest state (ms): absorbs jitter. */
export const INTERP_DELAY = 100;
/** Longest extrapolation past the newest state (ms) before the craft holds still. */
const MAX_EXTRAPOLATE = 250;
/** Remote jetwall segments within this distance of the local craft are solid (m). */
const WALL_SOLID_RADIUS = 350;
const WALL_DROP_RADIUS = 450;
const MAX_REMOTE_COLLIDERS = 4000;
const WALL_THICKNESS = 0.18;
/** After a (re)spawn, remote walls through the craft stay hollow this long (ms). */
const SPAWN_GRACE_MS = 2000;
/** Craft changes go out at most this often (s); cycling through vehicles sends the last one. */
const CRAFT_INTERVAL = 0.5;
const C = PLANET.circumference;
/** Horizontal distance from `p` to the segment a-b. */
function segmentDistance(a: { x: number; z: number }, b: { x: number; z: number }, p: { x: number; z: number }): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
  return Math.hypot(a.x + dx * k - p.x, a.z + dz * k - p.z);
}
/** Shift that brings `v` to the image nearest `ref`. */
const imageShift = (v: number, ref: number) => C * Math.round((ref - v) / C);

interface Snapshot { t: number; p: THREE.Vector3; q: THREE.Quaternion; v: THREE.Vector3; c: NetState['c'] }

interface RemoteTrail extends Trail {
  /** Image offset applied to this trail's points (x, z). */
  ox: number;
  oz: number;
}

export interface RemotePlayer {
  id: string;
  name: string;
  color: string;
  /** Their team (0 Cyan, 1 Red, 2 Amber): friend or foe. */
  team: NetTeam;
  craft: CraftDef;
  view: RemoteCraftView | null;
  buffer: Snapshot[];
  /** Estimated local-clock minus sender-clock (ms). */
  clockOffset: number | null;
  latest: NetState | null;
  trails: Map<number, RemoteTrail>;
  trailMode: TrailMode;
  /** Rendered pose (local image), updated every frame. */
  readonly pose: { position: THREE.Vector3; rotation: THREE.Quaternion; speed: number; visible: boolean };
}

export interface ConnectOptions {
  server: string;
  /** '' creates a new room. */
  room: string;
  name: string;
  color: string;
}

export interface NetGame {
  sim: Simulation;
  scene: THREE.Scene;
  mode: () => 'hangar' | 'flight';
}

export type NetNotice =
  | { kind: 'join' | 'leave'; name: string; color: string }
  | { kind: 'chat'; name: string; color: string; text: string }
  | { kind: 'status'; text: string }
  /** The kill feed: someone shot someone down. */
  | { kind: 'kill'; text: string };

export class NetClient {
  status: NetStatus = 'offline';
  statusText = 'Offline';
  room = '';
  selfId = '';
  server = '';
  readonly players = new Map<string, RemotePlayer>();
  readonly chat: Array<{ name: string; color: string; text: string }> = [];
  /** Called on any roster / status change (the panel re-renders). */
  onChange: (() => void) | null = null;
  onNotice: ((n: NetNotice) => void) | null = null;
  /** Counters for tests and the debug overlay. */
  readonly stats = { sent: 0, received: 0, fracturesSent: 0, fracturesApplied: 0, explosionsShown: 0, hitsSent: 0, hitsTaken: 0, hitsRefused: 0 };
  /** The player's rounds against the other players as drawn here (networked damage). */
  private readonly scanner = new ShotScanner();
  private wasExploded = false;
  private readonly blastsSent = new Set<object>();

  private ws: WebSocket | null = null;
  private opts: ConnectOptions | null = null;
  private wantOnline = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private sendClock = 0;
  private craftClock = 0;
  private sentArc = new Map<number, number>();
  private lastCraft: CraftDef | null = null;
  private applyingRemote = false;
  private readonly seenExplosions = new WeakSet<object>();
  private readonly pendingFractures: NetEvent[] = [];
  private groupIndex: { size: number; exact: Map<string, number>; base: Map<string, Array<{ i: number; ox: number; oz: number }>> } = { size: -1, exact: new Map(), base: new Map() };
  private wallBody: RAPIER.RigidBody | null = null;
  private colliderCount = 0;
  private wallTick = 0;
  private spawnGraceUntil = 0;
  private radiusFor: CraftDef | null = null;
  private craftRadius = 2;
  /** All remote trails in one list, drawn by one TrailView. */
  private readonly trailSet = { trails: [] as Trail[], mode: 'wall' as TrailMode, version: 0 };
  private readonly trailView: TrailView;

  constructor(private readonly game: NetGame) {
    this.trailView = new TrailView(game.scene, this.trailSet as unknown as TrailSystem);
    this.hookSimulation();
  }

  /**
   * The relay to use by default: the build's VITE_GRID_SERVER (the deployed relay, e.g.
   * wss://grid-relay.onrender.com), else ws://<page host>:8787 (wss on https pages).
   */
  static defaultServer(): string {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    const built = env?.VITE_GRID_SERVER?.trim();
    if (built) return built;
    const host = typeof location !== 'undefined' && location.hostname ? location.hostname : 'localhost';
    const secure = typeof location !== 'undefined' && location.protocol === 'https:';
    return `${secure ? 'wss' : 'ws'}://${host.includes(':') ? `[${host}]` : host}:8787`;
  }

  get connected(): boolean {
    return this.status === 'connected';
  }

  /** Invite link for the current room (this page with ?room=&server=). */
  inviteLink(base = typeof location !== 'undefined' ? location.href : 'http://localhost/'): string {
    const url = new URL(base);
    url.searchParams.set('room', this.room);
    url.searchParams.set('server', this.server);
    url.searchParams.delete('mode');
    url.searchParams.set('mode', 'fly');
    return url.toString();
  }

  connect(opts: ConnectOptions): void {
    this.disconnect(false);
    this.opts = { ...opts, room: normalizeRoom(opts.room) };
    this.server = opts.server;
    this.room = '';
    this.wantOnline = true;
    this.retries = 0;
    this.open();
  }

  disconnect(user = true): void {
    this.wantOnline = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try { ws.close(1000, 'bye'); } catch { /* not open */ }
    }
    this.clearRemote();
    if (user) this.setStatus('offline', 'Offline');
  }

  sendChat(text: string): void {
    const t = text.trim().slice(0, 280);
    if (t) this.sendEvent({ k: 'chat', text: t });
    if (t && this.connected) this.addChat(this.opts?.name ?? 'You', this.opts?.color ?? '#00eaff', t);
  }

  private open(): void {
    if (!this.opts) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.server);
    } catch (e) {
      this.setStatus('error', `Bad server address: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.ws = ws;
    this.setStatus('connecting', `Connecting to ${this.opts.server}…`);
    ws.onopen = () => {
      const o = this.opts!;
      this.lastCraft = this.game.sim.craft.def;
      this.send({ t: 'hello', v: PROTOCOL_VERSION, room: this.room || o.room, name: o.name, color: o.color, craft: this.lastCraft, team: asTeam(this.game.sim.team) });
    };
    ws.onmessage = (e) => {
      let m: ServerMessage;
      try { m = JSON.parse(String(e.data)) as ServerMessage; } catch { return; }
      this.stats.received++;
      this.handle(m);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.status === 'connected';
      this.clearRemote();
      if (this.wantOnline && (was || this.retries > 0) && this.retries < 5) {
        const wait = 1000 * 2 ** this.retries++;
        this.setStatus('connecting', `Connection lost; retrying in ${Math.round(wait / 1000)} s…`);
        this.retryTimer = setTimeout(() => this.open(), wait);
      } else {
        this.wantOnline = false;
        this.setStatus('error', e.reason ? `Disconnected: ${e.reason}` : was ? 'Disconnected' : `Can't reach ${this.opts?.server}`);
      }
    };
  }

  /** Tell the room we changed team (others see our new colours with the next craft update). */
  setTeam(team: number): void {
    if (this.connected) this.send({ t: 'team', team: asTeam(team) });
  }

  private send(m: ClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(m));
    this.stats.sent++;
  }

  private sendEvent(e: NetEvent): void {
    if (this.connected) this.send({ t: 'event', e });
  }

  private setStatus(s: NetStatus, text: string): void {
    this.status = s;
    this.statusText = text;
    this.onNotice?.({ kind: 'status', text });
    this.onChange?.();
  }

  private addChat(name: string, color: string, text: string): void {
    this.chat.push({ name, color, text });
    if (this.chat.length > 50) this.chat.shift();
  }

  // --- Incoming

  private handle(m: ServerMessage): void {
    switch (m.t) {
      case 'welcome':
        this.selfId = m.id;
        this.room = m.room;
        this.retries = 0;
        this.sentArc.clear(); // everyone gets our trails from the start
        this.craftClock = CRAFT_INTERVAL;
        this.spawnGraceUntil = performance.now() + SPAWN_GRACE_MS; // we may be sitting in someone's wall
        for (const p of m.players) this.addPlayer(p);
        this.setStatus('connected', `Room ${m.room} · ${m.players.length + 1} on the Grid`);
        break;
      case 'join':
        this.addPlayer(m.player);
        this.sentArc.clear(); // resend our trails so the newcomer sees them
        this.onNotice?.({ kind: 'join', name: m.player.name, color: m.player.color });
        this.onChange?.();
        break;
      case 'leave': {
        const p = this.players.get(m.id);
        if (p) {
          this.removePlayer(p);
          this.onNotice?.({ kind: 'leave', name: p.name, color: p.color });
          this.onChange?.();
        }
        break;
      }
      case 'state': {
        const p = this.players.get(m.id);
        if (p && validState(m.s)) this.applyState(p, m.s);
        break;
      }
      case 'craft': {
        const p = this.players.get(m.id);
        if (p && validCraftShape(m.craft)) {
          p.craft = m.craft;
          this.rebuildView(p);
          this.onChange?.();
        }
        break;
      }
      case 'team': {
        const p = this.players.get(m.id);
        if (p) {
          p.team = asTeam(m.team);
          this.onChange?.();
        }
        break;
      }
      case 'event': {
        const p = this.players.get(m.id);
        if (p && validEvent(m.e)) this.applyEvent(p, m.e);
        break;
      }
      case 'error':
        if (m.code === 'room-full' || m.code === 'bad-room' || m.code === 'version') {
          this.wantOnline = false;
          this.setStatus('error', m.message);
        } else console.warn(`[net] ${m.code}: ${m.message}`);
        break;
      case 'pong':
        break;
    }
  }

  private addPlayer(info: PlayerInfo): void {
    if (info.id === this.selfId || this.players.has(info.id) || !validCraftShape(info.craft)) return;
    const p: RemotePlayer = {
      id: info.id, name: info.name, color: info.color, team: asTeam(info.team), craft: info.craft, view: null, buffer: [], clockOffset: null,
      latest: null, trails: new Map(), trailMode: 'wall',
      pose: { position: new THREE.Vector3(), rotation: new THREE.Quaternion(), speed: 0, visible: false },
    };
    this.players.set(p.id, p);
    this.rebuildView(p);
    if (info.state && validState(info.state)) this.applyState(p, info.state);
  }

  private rebuildView(p: RemotePlayer): void {
    if (p.view) {
      p.view.root.removeFromParent();
      p.view.dispose();
    }
    p.view = new RemoteCraftView(p.craft, p.color);
    p.view.root.visible = false;
    this.game.scene.add(p.view.root);
  }

  private removePlayer(p: RemotePlayer): void {
    for (const t of p.trails.values()) this.dropTrail(t);
    p.trails.clear();
    this.syncTrailList();
    if (p.view) {
      p.view.root.removeFromParent();
      p.view.dispose();
    }
    this.players.delete(p.id);
  }

  private clearRemote(): void {
    for (const p of [...this.players.values()]) this.removePlayer(p);
    this.pendingFractures.length = 0;
    this.selfId = '';
  }

  private applyState(p: RemotePlayer, s: NetState): void {
    const now = performance.now();
    const sample = now - s.t;
    p.clockOffset = p.clockOffset === null || sample < p.clockOffset ? sample : p.clockOffset + (sample - p.clockOffset) * 0.01;
    const last = p.buffer.at(-1);
    if (!last || s.t > last.t) {
      const pos = new THREE.Vector3(...s.p);
      // Keep the track continuous across a wrap edge (the sender jumps one circumference).
      if (last) pos.x += imageShift(pos.x, last.p.x), pos.z += imageShift(pos.z, last.p.z);
      p.buffer.push({ t: s.t, p: pos, q: new THREE.Quaternion(...s.q).normalize(), v: new THREE.Vector3(...s.v), c: s.c });
      if (p.buffer.length > 40) p.buffer.shift();
    }
    const roster = !p.latest || p.latest.m !== s.m || p.latest.x !== s.x;
    p.latest = s;
    p.trailMode = s.tm;
    if (roster) this.onChange?.(); // hangar / derezzed shows in the player list
    this.applyTrails(p, s.tr);
  }

  private applyTrails(p: RemotePlayer, list: NetTrail[]): void {
    const time = this.game.sim.time;
    const ref = this.game.sim.position;
    const listed = new Set<number>();
    let changed = false;
    for (const nt of list) {
      listed.add(nt.id);
      let t = p.trails.get(nt.id);
      if (!t) {
        if (nt.derez) continue;
        const first = nt.pts[0];
        t = {
          id: nt.id, kind: nt.kind, color: p.color, height: nt.height, points: [], active: nt.active, derezAt: null,
          emitter: new THREE.Vector3(), ox: first ? imageShift(first[0], ref.x) : 0, oz: first ? imageShift(first[1], ref.z) : 0,
        };
        p.trails.set(nt.id, t);
        changed = true;
      }
      if (t.derezAt !== null) continue;
      if (nt.derez) {
        this.derezTrail(t, time);
        changed = true;
        continue;
      }
      t.active = nt.active;
      if (nt.tail < 0) {
        // The sender's trail emptied (a ribbon faded out): its arcs restart from zero.
        for (const pt of t.points) this.dropCollider(pt);
        t.points.length = 0;
        changed = true;
      }
      const pts = t.points;
      if (nt.pts.length && pts.length && nt.pts[0][4] < pts[0].arc - 1) {
        for (const pt of pts) this.dropCollider(pt);
        pts.length = 0; // restarted
      }
      for (const [x, z, y0, y1, arc] of nt.pts) {
        if (pts.length && arc <= pts[pts.length - 1].arc) continue; // already have it
        pts.push({ x: x + t.ox, z: z + t.oz, y0, y1, arc, time });
        changed = true;
      }
      while (pts.length && pts[0].arc < nt.tail - 0.011) {
        this.dropCollider(pts[0]);
        pts.shift();
        changed = true;
      }
    }
    // Trails the sender no longer has: derez them.
    for (const t of p.trails.values()) {
      if (!listed.has(t.id) && t.derezAt === null) {
        this.derezTrail(t, time);
        changed = true;
      }
    }
    if (changed) this.syncTrailList();
  }

  private derezTrail(t: Trail, time: number): void {
    t.active = false;
    t.derezAt = time;
    for (const pt of t.points) this.dropCollider(pt);
  }

  private dropTrail(t: Trail): void {
    for (const pt of t.points) this.dropCollider(pt);
  }

  private syncTrailList(): void {
    this.trailSet.trails.length = 0;
    for (const p of this.players.values()) for (const t of p.trails.values()) this.trailSet.trails.push(t);
    this.trailSet.version++;
  }

  private applyEvent(p: RemotePlayer, e: NetEvent): void {
    const sim = this.game.sim;
    switch (e.k) {
      case 'fracture':
        if (!this.applyFracture(e)) {
          this.pendingFractures.push(e);
          if (this.pendingFractures.length > 256) this.pendingFractures.shift();
        }
        break;
      case 'explosion': {
        const ref = sim.position;
        const ex = { x: e.x + imageShift(e.x, ref.x), y: e.y, z: e.z + imageShift(e.z, ref.z), time: sim.time, radius: e.radius };
        this.seenExplosions.add(ex);
        sim.explosions.push(ex);
        if (sim.explosions.length > 32) sim.explosions.splice(0, sim.explosions.length - 32);
        this.stats.explosionsShown++;
        break;
      }
      case 'derez':
        for (const t of p.trails.values()) if (t.derezAt === null) this.derezTrail(t, sim.time);
        this.syncTrailList();
        break;
      case 'hit': {
        // Someone's round struck someone: ours to apply only if it struck us.
        if (e.target !== this.selfId || !HIT_KINDS.includes(e.kind)) break;
        const ref = sim.position;
        const point = new THREE.Vector3(e.x + imageShift(e.x, ref.x), e.y, e.z + imageShift(e.z, ref.z));
        const r = sim.applyRemoteHit({ id: p.id, team: p.team }, e.kind as WeaponKind, point);
        if (r === 'applied') this.stats.hitsTaken++;
        else this.stats.hitsRefused++;
        break;
      }
      case 'kill': {
        const killer = e.by === this.selfId ? 'You' : this.players.get(e.by)?.name ?? 'Someone';
        this.onNotice?.({ kind: 'kill', text: `${killer} shot down ${p.name}` });
        if (e.by === this.selfId) sim.creditRemoteKill(p.name);
        break;
      }
      case 'nuke':
      case 'emp': {
        // Another player's strategic weapon: it plays out here too (its fractures aren't sent on).
        const ref = sim.position;
        const x = e.x + imageShift(e.x, ref.x), z = e.z + imageShift(e.z, ref.z);
        const hitsBefore = sim.hitsTaken, wasDown = sim.exploded, empBefore = sim.empUntil;
        this.applyingRemote = true;
        try {
          if (e.k === 'nuke') sim.detonateNuke(x, e.y, z, p.team, false);
          else sim.detonateEmp(x, e.y, z, false);
        } finally {
          this.applyingRemote = false;
        }
        for (const x of sim.explosions) this.seenExplosions.add(x); // its derezzes aren't sent back out
        if (sim.hitsTaken !== hitsBefore || (!wasDown && sim.exploded) || sim.empUntil !== empBefore) sim.lastRemoteHit = { id: p.id, time: sim.time };
        break;
      }
      case 'war':
        sim.applyRemoteDiplomacy(e.a, e.b, e.on);
        break;
      case 'chat':
        this.addChat(p.name, p.color, e.text);
        this.onNotice?.({ kind: 'chat', name: p.name, color: p.color, text: e.text });
        this.onChange?.();
        break;
    }
  }

  /** Fracture the local structure named in `e`. False if it isn't registered here (yet). */
  private applyFracture(e: Extract<NetEvent, { k: 'fracture' }>): boolean {
    const sw = this.game.sim.staticWorld;
    const idx = this.indexGroups();
    let group = idx.exact.get(e.group);
    let dx = 0, dz = 0;
    if (group === undefined) {
      // A planet chunk registered at another wrap image: same structure, shifted.
      const remote = splitGroupName(e.group);
      const cands = idx.base.get(remote.base);
      if (!cands?.length) return false;
      const ref = this.game.sim.position;
      let best = cands[0], bestD = Infinity;
      for (const c of cands) {
        const g = sw.structures.groups[c.i];
        const d = Math.abs(g.x0 - ref.x) + Math.abs(g.z0 - ref.z);
        if (d < bestD) { bestD = d; best = c; }
      }
      group = best.i;
      dx = best.ox - remote.ox;
      dz = best.oz - remote.oz;
    }
    if (!sw.fractured.has(group)) {
      this.applyingRemote = true;
      try {
        sw.fracture(group, { impulse: e.hit.impulse, x: e.hit.x + dx, y: e.hit.y, z: e.hit.z + dz }, this.game.sim.time, e.crater);
      } finally {
        this.applyingRemote = false;
      }
      this.stats.fracturesApplied++;
    }
    return true;
  }

  /** Name → group index (rebuilt when StaticWorld registers more planet chunks). */
  private indexGroups() {
    const groups = this.game.sim.staticWorld.structures.groups;
    if (this.groupIndex.size === groups.length) return this.groupIndex;
    const exact = new Map<string, number>();
    const base = new Map<string, Array<{ i: number; ox: number; oz: number }>>();
    for (let i = 0; i < groups.length; i++) {
      const name = groups[i].name;
      exact.set(name, i);
      const s = splitGroupName(name);
      if (s.base !== name) {
        let l = base.get(s.base);
        if (!l) base.set(s.base, (l = []));
        l.push({ i, ox: s.ox, oz: s.oz });
      }
    }
    this.groupIndex = { size: groups.length, exact, base };
    return this.groupIndex;
  }

  // --- Outgoing: hooks on the local simulation (no-ops unless connected)

  private hookSimulation(): void {
    const sim = this.game.sim;
    const sw = sim.staticWorld;
    const fracture = sw.fracture.bind(sw);
    sw.fracture = (group, hit, time, crater = true) => {
      const b = fracture(group, hit, time, crater);
      if (!this.applyingRemote && this.connected) {
        this.sendEvent({ k: 'fracture', group: sw.structures.groups[group].name, hit: { impulse: r2(hit.impulse), x: r2(hit.x), y: r2(hit.y), z: r2(hit.z) }, crater });
        this.stats.fracturesSent++;
      }
      return b;
    };
    const derez = sim.trails.derez.bind(sim.trails);
    sim.trails.derez = (time) => {
      derez(time);
      // Respawn (not a crash: explode() marks the wreck before it derezzes).
      if (!sim.exploded) this.spawnGraceUntil = performance.now() + SPAWN_GRACE_MS;
      this.sendEvent({ k: 'derez' });
    };
  }

  /** Call once per frame (both modes). */
  update(dt: number): void {
    const sim = this.game.sim;
    if (this.connected) {
      this.combat();
      // Local explosions out.
      for (const e of sim.explosions) {
        if (this.seenExplosions.has(e)) continue;
        this.seenExplosions.add(e);
        this.sendEvent({ k: 'explosion', x: r2(e.x), y: r2(e.y), z: r2(e.z), radius: r2(e.radius) });
      }
      this.craftClock += dt;
      if (sim.craft.def !== this.lastCraft && this.craftClock >= CRAFT_INTERVAL) {
        this.craftClock = 0;
        this.lastCraft = sim.craft.def;
        this.send({ t: 'craft', craft: this.lastCraft });
      }
      const flight = this.game.mode() === 'flight';
      this.sendClock += dt;
      // 20 Hz in flight; a slow heartbeat from the hangar keeps the seat.
      if (this.sendClock >= (flight ? 1 / STATE_HZ : 0.5)) {
        this.sendClock = 0;
        this.send({ t: 'state', s: this.localState(flight) });
      }
      if (this.pendingFractures.length && this.indexGroups().size !== this.pendingSize) {
        this.pendingSize = this.groupIndex.size;
        for (let i = this.pendingFractures.length - 1; i >= 0; i--) {
          if (this.applyFracture(this.pendingFractures[i] as Extract<NetEvent, { k: 'fracture' }>)) this.pendingFractures.splice(i, 1);
        }
      }
    } else {
      for (const e of sim.explosions) this.seenExplosions.add(e);
    }
    if (!this.players.size && !this.trailSet.trails.length) return;
    this.updateRemote(dt);
  }
  private pendingSize = -1;

  /**
   * Networked damage, our side: our rounds against the other players of other teams as they are
   * drawn here (each hit goes to its victim's game, which applies it); our strategic
   * detonations out; and when we go down to someone's fire, the kill to the room.
   */
  private combat(): void {
    const sim = this.game.sim;
    if (this.game.mode() === 'flight') {
      const targets: NetTarget[] = [];
      for (const p of this.players.values()) {
        if (!p.pose.visible || p.team === asTeam(sim.team)) continue;
        targets.push({ id: p.id, pos: p.pose.position, radius: Math.max(3, p.view?.radius ?? 4) + 1 });
      }
      for (const h of this.scanner.scan(sim.weapons, targets)) {
        this.sendEvent({ k: 'hit', target: h.target, kind: h.kind, x: r2(h.point.x), y: r2(h.point.y), z: r2(h.point.z) });
        this.stats.hitsSent++;
      }
    }
    // Wars started or ended here: the room hears of them (the world starts at peace).
    for (const d of sim.diplomacyEvents.splice(0)) this.sendEvent({ k: 'war', a: d.a, b: d.b, on: d.on });
    for (const b of sim.blasts) {
      if (b.remote || this.blastsSent.has(b)) continue;
      this.blastsSent.add(b);
      this.sendEvent({ k: b.kind, x: r2(b.x), y: r2(b.y), z: r2(b.z) });
    }
    if (this.blastsSent.size > 64) for (const b of [...this.blastsSent]) if (!sim.blasts.includes(b as never)) this.blastsSent.delete(b);
    if (sim.exploded && !this.wasExploded) {
      const by = sim.lastRemoteHit;
      if (by && sim.time - by.time < 12 && this.players.has(by.id)) {
        this.sendEvent({ k: 'kill', by: by.id });
        this.onNotice?.({ kind: 'kill', text: `${this.players.get(by.id)!.name} shot you down` });
      }
    }
    this.wasExploded = sim.exploded;
  }

  private localState(flight: boolean): NetState {
    const sim = this.game.sim;
    const p = sim.position, q = sim.rotation, v = sim.craft.body.linvel(), c = sim.controls;
    const tr: NetTrail[] = [];
    let budget = MAX_TRAIL_POINTS;
    const live = new Set<number>();
    for (const t of sim.trails.trails.slice(0, 16)) {
      live.add(t.id);
      let sent = this.sentArc.get(t.id);
      const head = t.points.at(-1);
      if (sent !== undefined && (!head || head.arc < sent)) sent = undefined; // emptied / restarted
      const pts: NetTrailPoint[] = [];
      for (const pt of t.points) {
        if (budget <= 0 || pts.length >= 128) break;
        if (sent !== undefined && pt.arc <= sent) continue;
        pts.push([r2(pt.x), r2(pt.z), r2(pt.y0), r2(pt.y1), r2(pt.arc)]);
        budget--;
      }
      if (pts.length) this.sentArc.set(t.id, pts[pts.length - 1][4]);
      else if (!head) this.sentArc.delete(t.id);
      tr.push({
        id: t.id, kind: t.kind === 'wall' ? 'wall' : 'contrail', color: /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : '#00eaff',
        height: r2(Math.min(100, t.height)), pts, tail: t.points.length ? r2(t.points[0].arc) : -1,
        active: t.active, derez: t.derezAt !== null,
      });
    }
    for (const id of [...this.sentArc.keys()]) if (!live.has(id)) this.sentArc.delete(id);
    return {
      t: Math.round(performance.now()), p: [r2(p.x), r2(p.y), r2(p.z)], q: [r4(q.x), r4(q.y), r4(q.z), r4(q.w)],
      v: [r2(v.x), r2(v.y), r2(v.z)], c: [r2(c.pitch), r2(c.roll), r2(c.yaw), r2(c.throttle), r2(c.brake), r2(c.flaps ?? 0)],
      m: flight ? 'flight' : 'hangar', x: sim.exploded, tm: sim.trails.mode, tr,
    };
  }

  // --- Remote craft, trails and wall colliders

  private updateRemote(dt: number): void {
    const sim = this.game.sim;
    const ref = sim.position;
    const now = performance.now();
    const flight = this.game.mode() === 'flight';
    for (const p of this.players.values()) {
      const pose = p.pose;
      const s = p.latest;
      pose.visible = flight && !!s && s.m === 'flight' && !s.x && p.buffer.length > 0;
      if (p.buffer.length && p.clockOffset !== null) {
        const rt = now - p.clockOffset - INTERP_DELAY;
        const b = p.buffer;
        let i = b.length - 1;
        while (i > 0 && b[i - 1].t > rt) i--;
        // b[i] is the first snapshot newer than rt (or the newest).
        if (rt >= b[b.length - 1].t || b.length === 1) {
          const last = b[b.length - 1];
          const ahead = Math.min(MAX_EXTRAPOLATE, Math.max(0, rt - last.t)) / 1000;
          pose.position.copy(last.p).addScaledVector(last.v, ahead);
          pose.rotation.copy(last.q);
          pose.speed = last.v.length();
        } else if (rt <= b[0].t) {
          pose.position.copy(b[0].p);
          pose.rotation.copy(b[0].q);
          pose.speed = b[0].v.length();
        } else {
          const a = b[i - 1], c = b[i];
          const k = (rt - a.t) / Math.max(1, c.t - a.t);
          pose.position.lerpVectors(a.p, c.p, k);
          pose.rotation.slerpQuaternions(a.q, c.q, k);
          pose.speed = a.v.length() * (1 - k) + c.v.length() * k;
        }
        pose.position.x += imageShift(pose.position.x, ref.x);
        pose.position.z += imageShift(pose.position.z, ref.z);
      }
      if (p.view) {
        p.view.root.visible = pose.visible;
        if (pose.visible) p.view.update(pose.position, pose.rotation, pose.speed, s?.c[3] ?? 0, dt);
      }
    }
    // Trails: finished derezzes go; trails re-based when the local craft crosses a wrap edge.
    let changed = false;
    for (const p of this.players.values()) {
      for (const [id, t] of p.trails) {
        if (t.derezAt !== null && sim.time - t.derezAt > DEREZ_TIME) { p.trails.delete(id); changed = true; continue; }
        if (sim.time < (t.derezAt ?? 0)) t.derezAt = sim.time; // the local world was reset
        const head = t.points.at(-1);
        if (!head) continue;
        const sx = imageShift(head.x, ref.x), sz = imageShift(head.z, ref.z);
        if (sx || sz) {
          for (const pt of t.points) { this.dropCollider(pt); pt.x += sx; pt.z += sz; }
          t.ox += sx;
          t.oz += sz;
        }
      }
    }
    if (changed) this.syncTrailList();
    this.trailView.update(sim.time);
    if (flight && ++this.wallTick % 6 === 0) this.updateWallColliders();
  }

  /** Remote players' lit jetwalls (for autonomous ground vehicles to steer clear of). */
  *remoteWalls(): Generator<{ points: TrailPoint[] }> {
    for (const p of this.players.values()) for (const t of p.trails.values()) if (t.kind === 'wall' && t.derezAt === null) yield t;
  }

  /** Remote jetwalls near the local craft are solid; far ones carry no colliders. */
  private updateWallColliders(): void {
    const sim = this.game.sim;
    const ref = sim.position;
    // A segment laid through the local craft (everyone spawns on the same runway; someone may
    // set off from right beside you) is not built while it overlaps you: it would embed the
    // craft, not stop it. For a moment after a (re)spawn, walls you landed in are cleared too.
    if (this.radiusFor !== sim.craft.def) {
      this.radiusFor = sim.craft.def;
      this.craftRadius = sim.craft.boundingRadius();
    }
    const grace = performance.now() < this.spawnGraceUntil;
    const keepOut = grace ? this.craftRadius + 1.5 : this.craftRadius + 0.3;
    const clearOut = grace ? keepOut : -1;
    for (const p of this.players.values()) {
      for (const t of p.trails.values()) {
        if (t.kind !== 'wall' || t.derezAt !== null) continue;
        const pts = t.points;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const d = segmentDistance(a, b, ref);
          if (b.collider) {
            if (d > WALL_DROP_RADIUS || d < clearOut) this.dropCollider(b);
          } else if (d < WALL_SOLID_RADIUS && d >= keepOut && this.colliderCount < MAX_REMOTE_COLLIDERS) this.solidify(a, b);
        }
      }
    }
  }

  private solidify(a: TrailPoint, b: TrailPoint): void {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.05 || len > 60) return;
    const world = this.game.sim.world;
    this.wallBody ??= world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    const y0 = Math.min(a.y0, b.y0), y1 = Math.max(a.y1, b.y1);
    const desc = RAPIER.ColliderDesc.cuboid(WALL_THICKNESS / 2, Math.max(0.05, (y1 - y0) / 2), len / 2)
      .setTranslation((a.x + b.x) / 2, (y0 + y1) / 2, (a.z + b.z) / 2)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .setFriction(0.4).setRestitution(0.1);
    b.collider = world.createCollider(desc, this.wallBody);
    this.colliderCount++;
  }

  private dropCollider(p: TrailPoint): void {
    if (!p.collider) return;
    this.game.sim.world.removeCollider(p.collider, false);
    p.collider = undefined;
    this.colliderCount--;
  }

  /** Remote wall colliders in the local world right now (tests). */
  get remoteColliders(): number {
    return this.colliderCount;
  }

  /** Snapshot for tests / console: where each remote player is drawn. */
  describe(): Array<{ id: string; name: string; color: string; craft: string; visible: boolean; position: [number, number, number]; trails: number; points: number }> {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, craft: p.craft.name, visible: p.pose.visible,
      position: [p.pose.position.x, p.pose.position.y, p.pose.position.z],
      trails: p.trails.size, points: [...p.trails.values()].reduce((n, t) => n + t.points.length, 0),
    }));
  }
}
