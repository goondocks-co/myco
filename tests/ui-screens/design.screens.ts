/**
 * The design system specimen: every token and component the dashboard builds
 * from, on one page. It renders its content inside its landmarks, logs no
 * errors, scrolls nowhere sideways, passes axe-core with nothing serious or
 * critical, and is shot at both viewports in both modes.
 */
import { expect, test } from '@playwright/test';
import { expectAxeClean, expectNoHorizontalOverflow, expectQuiet, openPage, shoot, SHOT_MATRIX } from './checks.ts';
import { SCREENS_ENV } from './env.ts';

const SPECIMEN = '/specimen/index.html';

test.describe('design specimen', () => {
  test.skip(process.env[SCREENS_ENV.fixture] !== '1', 'the specimen is served only by the screens launcher');

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`${viewport} ${mode}`, async ({ browser }) => {
      expect(process.env[SCREENS_ENV.specimen], 'the launcher served no specimen; run `npm run build:specimen --prefix packages/myco-server/ui` first').toBe('1');
      const { context, page, watch } = await openPage(browser, { path: `${SPECIMEN}?mode=${mode}`, viewport, mode });
      try {
        await page.locator('html[data-ready="1"]').waitFor();
        await expect(page.locator('main')).toHaveCount(1);
        await expect(page.getByRole('heading', { level: 1, name: 'Design system' })).toBeVisible();
        await expect(page.getByRole('switch', { name: 'Learn from sessions' })).toBeVisible();
        await expect(page.getByText('Canopy parity verified against the hosted map')).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await expectAxeClean(page);
        expectQuiet(watch);
        await shoot(page, 'design', viewport, mode);
      } finally {
        await context.close();
      }
    });
  }
});
