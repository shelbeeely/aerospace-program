/**
 * The few Bun APIs the relay uses (Bun ships its own types as `bun-types`, which this repo does
 * not install: no new dependencies). Only for `npx tsc -p server`; the client tsconfig never
 * includes server/.
 */
interface BunServerWebSocket<T> {
  data: T;
  send(data: string): number;
  close(code?: number, reason?: string): void;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  publish(topic: string, data: string): number;
}
interface BunServer {
  port: number;
  publish(topic: string, data: string): number;
  upgrade(req: Request, opts?: { data?: unknown }): boolean;
  stop(closeActive?: boolean): void;
}
declare const Bun: {
  serve<T>(opts: {
    port?: number;
    fetch(req: Request, server: BunServer): Response | undefined | Promise<Response | undefined>;
    websocket: {
      maxPayloadLength?: number;
      idleTimeout?: number;
      sendPings?: boolean;
      open?(ws: BunServerWebSocket<T>): void;
      message?(ws: BunServerWebSocket<T>, msg: string | Uint8Array): void;
      close?(ws: BunServerWebSocket<T>, code: number, reason: string): void;
    };
  }): BunServer;
};
declare const process: { env: Record<string, string | undefined> };
declare const Buffer: { byteLength(s: string): number };
interface ImportMeta { main: boolean }
declare module 'bun:test' {
  export function test(name: string, fn: () => unknown): void;
  export function beforeAll(fn: () => unknown): void;
  export function afterAll(fn: () => unknown): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function expect(v: unknown): any;
}
