/**
 * Multiplayer relay for the Grid. Run with Bun: `bun server/index.ts` (PORT, default 8787).
 *
 * - WebSocket at ws://host:PORT/ (any path but /health upgrades). Protocol: src/net/protocol.ts.
 * - GET /health → { ok, version, rooms, players }.
 * - Room logic lives in server/rooms.ts. No accounts, no persistence, no CORS (WebSocket only).
 */
import { Lobby, type Peer, type Session } from './rooms.ts';
import { MAX_CRAFT_BYTES, PROTOCOL_VERSION } from '../src/net/protocol.ts';

export interface RelayOptions {
  port?: number;
  idleMs?: number;
  sweepMs?: number;
  quiet?: boolean;
}

export function startServer(opts: RelayOptions = {}) {
  const log = opts.quiet ? undefined : (m: string) => console.log(`[grid] ${m}`);
  // eslint-disable-next-line prefer-const
  let server: BunServer;
  const lobby = new Lobby({
    idleMs: opts.idleMs,
    broadcast: (topic, data) => server.publish(topic, data),
    log,
  });
  const decoder = new TextDecoder();
  server = Bun.serve<{ session?: Session }>({
    port: opts.port ?? Number(process.env.PORT ?? 8787),
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return Response.json({ ok: true, version: PROTOCOL_VERSION, rooms: lobby.rooms.size, players: lobby.playerCount });
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
  log?.(`relay listening on :${server.port} (protocol v${PROTOCOL_VERSION})`);
  return {
    server,
    lobby,
    port: server.port as number,
    stop() {
      clearInterval(sweep);
      server.stop(true);
    },
  };
}

if (import.meta.main) startServer();
