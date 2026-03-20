import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/ui/',
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
