import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the myco package version at build time so the UI can compare
// against the X-Myco-Api-Version response header and surface a warning
// when the bundled UI is older than the daemon it's talking to.
const mycoPackageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
) as { version: string };

export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: './',
  define: {
    __MYCO_UI_VERSION__: JSON.stringify(mycoPackageJson.version),
  },
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
