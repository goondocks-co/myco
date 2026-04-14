import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_PROFILE_FAST = 'fast';
const TEST_PROFILE_INTEGRATION = 'integration';
const DEFAULT_TEST_INCLUDES = ['tests/**/*.test.ts', 'tests/**/*.test.tsx'];
const DEFAULT_TEST_EXCLUDES = ['**/node_modules/**', '**/dist/**', '**/.worktrees/**'];
const FAST_TEST_EXCLUDES = [
  ...DEFAULT_TEST_EXCLUDES,
  'tests/integration/**',
  'tests/smoke/**',
  'tests/daemon/integration.test.ts',
  'tests/daemon/server.test.ts',
  'tests/hooks/client.test.ts',
];
const INTEGRATION_TEST_INCLUDES = [
  'tests/integration/**/*.test.ts',
  'tests/smoke/**/*.test.ts',
  'tests/daemon/integration.test.ts',
  'tests/daemon/server.test.ts',
  'tests/hooks/client.test.ts',
];

function resolveTestProfile() {
  const profile = process.env.MYCO_TEST_PROFILE;
  if (profile === TEST_PROFILE_FAST || profile === TEST_PROFILE_INTEGRATION) {
    return profile;
  }
  return null;
}

const testProfile = resolveTestProfile();
const testInclude = testProfile === TEST_PROFILE_INTEGRATION ? INTEGRATION_TEST_INCLUDES : DEFAULT_TEST_INCLUDES;
const testExclude = testProfile === TEST_PROFILE_FAST ? FAST_TEST_EXCLUDES : DEFAULT_TEST_EXCLUDES;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
    exclude: testExclude,
    include: testInclude,
    setupFiles: ['./tests/setup/vitest.ts'],
    testTimeout: 15000,
    pool: 'threads',
    maxThreads: 4,
  },
  resolve: {
    alias: {
      '@myco': path.resolve(__dirname, './packages/myco/src'),
      '@myco-team': path.resolve(__dirname, './packages/myco-team/src'),
      '@myco-team-worker': path.resolve(__dirname, './packages/myco-team/worker/src'),
      '@myco-collective': path.resolve(__dirname, './packages/myco-collective/src'),
      '@myco-deploy': path.resolve(__dirname, './packages/myco-deploy/src'),
      react: path.resolve(__dirname, './node_modules/react'),
      'react-dom': path.resolve(__dirname, './node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(__dirname, './node_modules/react/jsx-runtime.js'),
      'react/jsx-dev-runtime': path.resolve(__dirname, './node_modules/react/jsx-dev-runtime.js'),
      'react-router-dom': path.resolve(__dirname, './node_modules/react-router-dom'),
      '@tanstack/react-query': path.resolve(__dirname, './node_modules/@tanstack/react-query'),
    },
  },
});
