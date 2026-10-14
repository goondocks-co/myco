import { expect, test } from '@playwright/test';
import { expectAxeClean, expectFits, expectNoRawIds, expectQuiet, openPage, shoot, SHOT_MATRIX } from './checks.ts';
import { screensEnv } from './env.ts';

for (const { viewport, mode } of SHOT_MATRIX) for (const role of ['admin', 'member'] as const) {
  test(`get started ${role} ${viewport} ${mode}`, async ({ browser }) => {
    const { context, page, watch } = await openPage(browser, { path: '/', viewport, mode,
      cookie: screensEnv(role === 'admin' ? 'ownerCookie' : 'memberCookie') });
    try {
      if (role === 'member') {
        await page.route('**/api/setup', async (route) => {
          const response = await route.fetch();
          await route.fulfill({ json: { ...await response.json(), liveCapture: false, projects: 0 } });
        });
        await page.reload();
      }
      const card = page.locator('[data-get-started]');
      await expect(card.getByRole('heading', { name: 'Get started' })).toBeVisible();
      await expect(card.locator('[data-state="unchecked"]')).toHaveCount(0);
      await expect(card.locator('[data-setup-item]')).toHaveCount(role === 'admin' ? 8 : 2);
      if (role === 'admin') {
        await expect(card.locator('[data-setup-item="capture"]')).toHaveAttribute('data-state', 'done');
        await expect(card.locator('[data-setup-item="runner"]')).toContainText(`myco setup --runner ${new URL(page.url()).origin}`);
        await expect(card.locator('[data-setup-item="work"]')).toContainText('last 31 days');
        await expect(card.locator('[data-setup-item^="repository:"]')).toContainText('Connect Myco’s repository so Myco can map its code');
      } else {
        await expect(card).toContainText('Myco’s work runs on machines an admin chooses');
        await expect(card.locator('[data-setup-item="runner"]')).toHaveCount(0);
      }
      await card.scrollIntoViewIfNeeded();
      await expectFits(page, viewport); await expectNoRawIds(page); await expectAxeClean(page);
      await shoot(page, `get-started-${role}`, viewport, mode);
      await card.getByRole('button', { name: 'Hide for now' }).click();
      await expect(card).toHaveCount(0);
      await page.reload(); await expect(card).toHaveCount(0);
      await expectQuiet(watch);
    } finally { await context.close(); }
  });
}
