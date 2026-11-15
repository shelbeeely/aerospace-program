/**
 * Multiplayer relay for the Grid. Run with Bun: `bun server/index.ts` (PORT, default 8787).
 *
 * - WebSocket at ws://host:PORT/ (any path but /health upgrades). Protocol: src/net/protocol.ts.
 * - GET /health → { ok, version, rooms, players, world }.
 * - Room logic lives in server/rooms.ts. No accounts, no CORS (WebSocket only).
 * - ws://host:PORT/pad?code=ABCD&role=tv|pad pairs a TV page with phones used as its gamepad
 *   (server/pads.ts): a separate, much smaller channel than the rooms.
 * - The Bits' world (server/world.ts) lives as long as the process: every lot's gene pool,
 *   carried forward every WORLD_TICK while nobody is near it.
 */
import { Lobby, type Peer, type Session } from './rooms.ts';
import { PadHub, PAD_MAX_BYTES, type PadSession } from './pads.ts';
import { World } from './world.ts';
import { MAX_CRAFT_BYTES, PROTOCOL_VERSION } from '../src/net/protocol.ts';

export interface RelayOptions {
  port?: number;
  idleMs?: number;
  sweepMs?: number;
  quiet?: boolean;
  /** World tick (ms); 0 keeps no world (a plain relay). */
  worldTickMs?: number;
}

export function startServer(opts: RelayOptions = {}) {
  const log = opts.quiet ? undefined : (m: string) => console.log(`[grid] ${m}`);
  // eslint-disable-next-line prefer-const
  let server: BunServer;
  const worldTick = opts.worldTickMs ?? 10_000;
  const world = worldTick > 0 ? new World() : undefined;
  const lobby = new Lobby({
    idleMs: opts.idleMs,
    broadcast: (topic, data) => server.publish(topic, data),
    log,
    world,
  });
  const pads = new PadHub();
  const decoder = new TextDecoder();
  server = Bun.serve<{ session?: Session; pad?: { code: string | null; role: string | null }; padSession?: PadSession | null }>({
    port: opts.port ?? Number(process.env.PORT ?? 8787),
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return Response.json({ ok: true, version: PROTOCOL_VERSION, rooms: lobby.rooms.size, players: lobby.playerCount, ...(world ? { world: world.stats() } : {}) });
      }
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const pad = url.pathname === '/pad' ? { code: url.searchParams.get('code'), role: url.searchParams.get('role') } : undefined;
        if (srv.upgrade(req, { data: pad ? { pad } : {} })) return undefined;
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
        if (ws.data.pad) {
          ws.data.padSession = pads.connect(ws, ws.data.pad.code, ws.data.pad.role);
          return;
        }
        ws.data.session = lobby.connect(ws as unknown as Peer);
      },
      message(ws, msg) {
        if (ws.data.pad) {
          const p = ws.data.padSession;
          if (!p) return;
          const bytes = typeof msg === 'string' ? Buffer.byteLength(msg) : msg.byteLength;
          if (bytes > PAD_MAX_BYTES) return pads.message(p, '', bytes);
          pads.message(p, typeof msg === 'string' ? msg : decoder.decode(msg), bytes);
          return;
        }
        const s = ws.data.session;
        if (!s) return;
        const raw = typeof msg === 'string' ? msg : decoder.decode(msg);
        lobby.message(s, raw, typeof msg === 'string' ? Buffer.byteLength(msg) : msg.byteLength);
      },
      close(ws) {
        if (ws.data.padSession) pads.disconnect(ws.data.padSession);
        const s = ws.data.session;
        if (s) lobby.disconnect(s);
      },
    },
  });
  const sweep = setInterval(() => lobby.sweep(), opts.sweepMs ?? 5000);
  const ticker = world ? setInterval(() => world.tick(), worldTick) : null;
  log?.(`relay listening on :${server.port} (protocol v${PROTOCOL_VERSION}${world ? ', keeping the world' : ''})`);
  return {
    server,
    lobby,
    pads,
    world,
    port: server.port as number,
    stop() {
      clearInterval(sweep);
      if (ticker) clearInterval(ticker);
      server.stop(true);
    },
  };
}

if (import.meta.main) startServer();
