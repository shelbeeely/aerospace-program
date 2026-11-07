import { defineConfig, loadEnv } from 'vite';
import { openrouterProxy } from './tools/openrouterProxy.ts';

export default defineConfig(({ mode }) => {
  // Load all env vars (not just VITE_*), server-side only: never exposed to the page.
  const env = { ...loadEnv(mode, '.', ''), ...process.env };
  return {
    server: { host: true },
    build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
    plugins: [openrouterProxy(env)],
  };
});
