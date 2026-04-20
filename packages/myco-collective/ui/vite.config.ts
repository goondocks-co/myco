import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const DEFAULT_PROXY_TARGET = 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: '/',
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': process.env.COLLECTIVE_UI_PROXY_TARGET || DEFAULT_PROXY_TARGET,
      '/health': process.env.COLLECTIVE_UI_PROXY_TARGET || DEFAULT_PROXY_TARGET,
    },
  },
});
