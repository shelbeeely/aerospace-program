import { defineConfig, loadEnv } from 'vite';
import { openrouterProxy } from './tools/openrouterProxy.ts';

export default defineConfig(({ mode }) => {
  // Load all env vars (not just VITE_*), server-side only: never exposed to the page.
  const env = { ...loadEnv(mode, '.', ''), ...process.env };
  return {
    // GitHub Pages serves project sites from /<repo>/; the deploy workflow sets BASE_PATH.
    base: env.BASE_PATH ?? '/',
    server: { host: true },
    build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
    // The proxy only exists on the dev/preview server. Static builds use bring-your-own-key.
    plugins: [openrouterProxy(env)],
  };
});
