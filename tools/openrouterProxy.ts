import type { Plugin } from 'vite';

/**
 * Dev/preview-server proxy for OpenRouter. The browser calls same-origin `/api/openrouter/...`
 * and this middleware adds the API key server-side, so the key never ships to the page.
 *
 * Env (in the shell or a `.env` file, see `.env.example`):
 *   OPENROUTER_API_KEY        your key (optional if an outbound proxy injects it)
 *   OPENROUTER_MAX_SPEND_USD  hard cap on spend per server run (default 2)
 *
 * This is for local play. A public deployment needs a real backend with per-user auth and limits.
 */
export function openrouterProxy(env: Record<string, string | undefined>): Plugin {
  const allowed = [/^\/v1\/models(\?.*)?$/, /^\/v1\/chat\/completions$/];
  const maxSpend = Number(env.OPENROUTER_MAX_SPEND_USD ?? 2);
  let spent = 0;

  // Connect-style middleware; typed loosely to avoid depending on @types/node.
  const handler = async (req: any, res: any) => {
    const path: string = req.url ?? '';
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (!allowed.some((r) => r.test(path))) {
      return send(404, { error: { message: `Not proxied: ${path}`, code: 404 } });
    }
    if (req.method === 'POST' && spent >= maxSpend) {
      return send(402, {
        error: {
          message: `Local spend cap reached ($${spent.toFixed(2)} of $${maxSpend}). Raise OPENROUTER_MAX_SPEND_USD and restart the dev server.`,
          code: 402,
        },
      });
    }
    try {
      const chunks: Uint8Array[] = [];
      for await (const c of req) chunks.push(c);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-title': 'Aerospace Program',
        // Without a key, a placeholder lets an injecting outbound proxy add the real one.
        authorization: `Bearer ${env.OPENROUTER_API_KEY ?? 'injected-by-proxy'}`,
      };
      const upstream = await fetch(`https://openrouter.ai/api${path}`, {
        method: req.method,
        headers,
        body: req.method === 'POST' ? new Blob(chunks as BlobPart[]) : undefined,
      });
      const text = await upstream.text();
      if (req.method === 'POST') {
        try {
          spent += Number(JSON.parse(text)?.usage?.cost ?? 0) || 0;
        } catch {
          /* non-JSON error body */
        }
      }
      res.statusCode = upstream.status;
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
      res.setHeader('x-session-spend-usd', spent.toFixed(6));
      res.end(text);
    } catch (e) {
      send(502, { error: { message: `Proxy error: ${e instanceof Error ? e.message : String(e)}`, code: 502 } });
    }
  };

  return {
    name: 'openrouter-proxy',
    configureServer(server) {
      server.middlewares.use('/api/openrouter', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/openrouter', handler);
    },
  };
}
