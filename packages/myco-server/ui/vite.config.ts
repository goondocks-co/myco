import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const SERVER = process.env.MYCO_SERVER_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  // Absolute base: a relative one resolves `./assets/x` against a deep route on
  // hard refresh and 404s.
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // `changeOrigin` rewrites the proxied Host to the server's own loopback
    // literal; the self-hosted server admits only those Hosts.
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/auth': { target: SERVER, changeOrigin: true },
      '/health': { target: SERVER, changeOrigin: true },
    },
  },
});
