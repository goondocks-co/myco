/**
 * Today's dashboard shell, signed in as the owner: the Projects and Settings
 * pages render inside the shell's `main` landmark with no console errors or
 * failed requests, and each is shot at both viewports in both modes.
 *
 * Axe-core and the raw-id check are not asserted here: the pages they hold to
 * account are the rebuilt ones, each asserted by its own `*.screens.ts`.
 */
import { expect, test } from '@playwright/test';
import { expectQuiet, openPage, shoot, SHOT_MATRIX } from './checks.ts';
import { screensEnv } from './env.ts';

const PAGES = [
  { name: 'projects', path: '/projects' },
  { name: 'settings', path: '/settings' },
] as const;

test.describe('dashboard shell', () => {
  for (const { name, path } of PAGES) for (const { viewport, mode } of SHOT_MATRIX) {
    test(`${name} ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path, viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        await expect(page.locator('main')).toContainText(/\S/);
        await page.waitForLoadState('networkidle');
        expectQuiet(watch);
        await shoot(page, name, viewport, mode);
      } finally {
        await context.close();
      }
    });
  }
});
