/**
 * Today's dashboard shell, signed in as the owner: the Projects and Settings
 * pages P1a touched render the fixture inside the shell's `main` landmark, with
 * no console errors or failed requests and nothing scrolling sideways, and each
 * is shot at both viewports in both modes.
 *
 * Axe-core and the raw-id check are not asserted here: the pages they hold to
 * account are the rebuilt ones, each asserted by its own `*.screens.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow, expectQuiet, openPage, shoot, SHOT_MATRIX } from './checks.ts';
import { SCREENS_ENV, screensEnv } from './env.ts';

const onFixture = (): boolean => process.env[SCREENS_ENV.fixture] === '1';

const PAGES: ReadonlyArray<{ name: string; path: string; rendered: (page: Page) => Promise<void> }> = [
  {
    name: 'projects',
    path: '/projects',
    rendered: async (page) => {
      const list = page.getByRole('list', { name: 'Projects' });
      if (!onFixture()) { await expect(list.getByRole('listitem').first()).toBeVisible(); return; }
      const names = JSON.parse(screensEnv('projectNames')) as string[];
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) await expect(list.getByText(name, { exact: true })).toBeVisible();
    },
  },
  {
    name: 'settings',
    path: '/settings',
    rendered: async (page) => {
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
      await expect(page.getByRole('switch').first()).toBeVisible();
      await expect(page.getByLabel('Provider').first()).toBeVisible();
    },
  },
];

test.describe('dashboard shell', () => {
  for (const { name, path, rendered } of PAGES) for (const { viewport, mode } of SHOT_MATRIX) {
    test(`${name} ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path, viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        await rendered(page);
        await page.waitForLoadState('networkidle');
        await expectNoHorizontalOverflow(page);
        expectQuiet(watch);
        await shoot(page, name, viewport, mode);
      } finally {
        await context.close();
      }
    });
  }
});
