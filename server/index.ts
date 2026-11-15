/**
 * Multiplayer relay for the Grid. Run with Bun: `bun server/index.ts` (PORT, default 8787).
 *
 * - WebSocket at ws://host:PORT/ (any path but /health upgrades). Protocol: src/net/protocol.ts.
 * - GET /health → { ok, version, rooms, players, world }.
 * - Room logic lives in server/rooms.ts. No accounts, no CORS (WebSocket only).
 * - The Bits' world (server/world.ts) lives as long as the process: every lot's gene pool,
 *   carried forward every WORLD_TICK while nobody is near it.
 */
import { Lobby, type Peer, type Session } from './rooms.ts';
import { World } from './world.ts';
import { LivingHost } from './living.ts';
import { MAX_CRAFT_BYTES, PROTOCOL_VERSION } from '../src/net/protocol.ts';

export interface RelayOptions {
  port?: number;
  idleMs?: number;
  sweepMs?: number;
  quiet?: boolean;
  /** World tick (ms); 0 keeps no world (a plain relay). */
  worldTickMs?: number;
  /**
   * The living world (server/living.ts): advanced every `livingTickMs` (0: not kept), saved under
   * `livingData` (default: $LIVING_DATA, else $BRAIN_DATA; none: memory only), shared with the
   * world every `livingShareMs`.
   */
  livingTickMs?: number;
  livingData?: string | null;
  livingShareMs?: number;
}

export function startServer(opts: RelayOptions = {}) {
  const log = opts.quiet ? undefined : (m: string) => console.log(`[grid] ${m}`);
  // eslint-disable-next-line prefer-const
  let server: BunServer;
  const worldTick = opts.worldTickMs ?? 10_000;
  const world = worldTick > 0 ? new World() : undefined;
  const livingTick = opts.livingTickMs ?? (world ? 60_000 : 0);
  const livingData = opts.livingData !== undefined ? opts.livingData : (process.env.LIVING_DATA ?? process.env.BRAIN_DATA ?? null);
  const living = livingTick > 0 ? new LivingHost({ dataDir: livingData }) : undefined;
  if (living) { living.tick(); living.save(); }
  const lobby = new Lobby({
    idleMs: opts.idleMs,
    broadcast: (topic, data) => server.publish(topic, data),
    log,
    world,
    living,
  });
  const decoder = new TextDecoder();
  server = Bun.serve<{ session?: Session }>({
    port: opts.port ?? Number(process.env.PORT ?? 8787),
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return Response.json({ ok: true, version: PROTOCOL_VERSION, rooms: lobby.rooms.size, players: lobby.playerCount, ...(world ? { world: world.stats() } : {}), ...(living ? { living: living.stats() } : {}) });
      }
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        if (srv.upgrade(req, { data: {} })) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return new Response('The Grid multiplayer relay: connect with a WebSocket.', { status: 404 });
    },
    websocket: {
      // Frames over this are refused by Bun itself (connection closed); smaller oversize frames
      // get a `too-large` error from the protocol check.
      maxPayloadLength: MAX_CRAFT_BYTES * 2,
      idleTimeout: 60,
      sendPings: true,
      open(ws) {
        ws.data.session = lobby.connect(ws as unknown as Peer);
      },
      message(ws, msg) {
        const s = ws.data.session;
        if (!s) return;
        const raw = typeof msg === 'string' ? msg : decoder.decode(msg);
        lobby.message(s, raw, typeof msg === 'string' ? Buffer.byteLength(msg) : msg.byteLength);
      },
      close(ws) {
        const s = ws.data.session;
        if (s) lobby.disconnect(s);
      },
    },
  });
  const sweep = setInterval(() => lobby.sweep(), opts.sweepMs ?? 5000);
  const ticker = world ? setInterval(() => world.tick(), worldTick) : null;
  // The living world goes on whether anyone is connected or not; it is saved as it changes.
  const livingTicker = living ? setInterval(() => { living.tick(); living.save(); }, livingTick) : null;
  const livingSharer = living ? setInterval(() => lobby.shareLiving(), opts.livingShareMs ?? 10 * 60_000) : null;
  log?.(`relay listening on :${server.port} (protocol v${PROTOCOL_VERSION}${world ? ', keeping the world' : ''})`);
  return {
    server,
    lobby,
    world,
    living,
    port: server.port as number,
    stop() {
      clearInterval(sweep);
      if (ticker) clearInterval(ticker);
      if (livingTicker) clearInterval(livingTicker);
      if (livingSharer) clearInterval(livingSharer);
      living?.save();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const relay = startServer();
  // A redeploy or restart stops the process: save the living world first.
  process.on('SIGTERM', () => { relay.living?.save(); process.exit(0); });
}
