/**
 * Playwright for the dashboard's screen checks.
 *
 * Only `*.screens.ts` files are collected here, and Bun's test runner never
 * collects them (it looks for `.test.` and `.spec.` names), so the two suites
 * cannot pick up each other's files. The global setup boots the launcher
 * (`serve.ts`) against the built dashboard, or points at a real deployment when
 * `MYCO_SHOTS_URL` is set.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.screens.ts',
  outputDir: '../../target/ui-screens/results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['html', { outputFolder: '../../target/ui-screens/report', open: 'never' }]] : [['list']],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
