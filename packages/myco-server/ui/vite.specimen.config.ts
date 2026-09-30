import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/**
 * The design-system specimen: every token and component on one static page,
 * built beside the dashboard (never into it) for the screen checks in
 * `tests/ui-screens/`. The launcher serves it at `/specimen/index.html`, so
 * the dashboard's own `/fonts` reach it.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./src/design/specimen', import.meta.url)),
  plugins: [tailwindcss(), react()],
  resolve: { alias: { '@goondocks/myco-shared': fileURLToPath(new URL('../../myco-shared/src', import.meta.url)) } },
  base: '/specimen/',
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL('../../../target/ui-screens/specimen', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
