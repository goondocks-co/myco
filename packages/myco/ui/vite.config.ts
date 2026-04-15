import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: '/',
  // Mirror the tsconfig paths entry so vite can resolve `@myco/*` imports
  // from `packages/myco/src/*` at dev time and during production builds.
  resolve: {
    alias: {
      '@myco': path.resolve(__dirname, '../src'),
    },
  },
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': `http://localhost:${process.env.MYCO_DAEMON_PORT || '19200'}`,
      '/health': `http://localhost:${process.env.MYCO_DAEMON_PORT || '19200'}`,
    },
  },
});
