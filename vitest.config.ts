import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**'],
    testTimeout: 15000,
    pool: 'threads',
    maxThreads: 4,
  },
  resolve: {
    alias: {
      '@myco': path.resolve(__dirname, './src'),
    },
  },
});
