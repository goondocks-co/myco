import path from 'node:path';
import { expect, test } from '@playwright/test';
import { expectFits, expectNoRawIds, openPage, shoot, SHOTS_DIR, SHOT_MATRIX } from './checks.ts';
import { screensEnv } from './env.ts';

const shots = process.env.MYCO_REPOSITORY_SHOTS_DIR ?? path.join(SHOTS_DIR, 'repository');

test.describe('repository requirements in Project settings', () => {
  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`${viewport} ${mode}`, async ({ browser }) => {
      const project = (JSON.parse(screensEnv('projects')) as Array<{ projectId: string }>)[0]!;
      const route = `/p/${project.projectId}/settings`;
      const { context, page } = await openPage(browser, { path: route, viewport, mode, cookie: screensEnv('ownerCookie') });
      let connected = false;
      try {
        await page.route(`**/api/projects/${project.projectId}/repository`, async (request) => {
          await request.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ repository: connected ? {
              revision: 'rev_fixture', url: 'https://github.com/goondocks-co/myco.git', branch: 'main',
              username: null, credential: null, updatedAt: Number(screensEnv('now')) - 3_600_000, updatedBy: 'system',
            } : null }),
          });
        });

        await page.reload();
        const map = page.locator('[data-setting="capability.canopy"]');
        const learning = page.locator('[data-setting="capability.vault_evolution"]');
        await expect(map).toContainText('Needs this project’s repository to read its code.');
        await expect(learning).toContainText('Can run Learn from sessions now; connect the repository to also run Seed project memory.');
        await expect(learning).toContainText('On · Some tasks need a repository');
        await expect(learning).not.toContainText('Code tasks cannot run');
        await expect(map.getByRole('link', { name: 'Connect repository' })).toHaveAttribute('href', `${route}?connect=repository#repository`);
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await shoot(page, 'repository-settings-missing', viewport, mode, shots);

        connected = true;
        await page.reload();
        await expect(map).toContainText('Reads goondocks-co/myco @ main');
        await expect(learning).toContainText('Reads goondocks-co/myco @ main');
        await expect(map.getByRole('link', { name: 'Connect repository' })).toHaveCount(0);
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await shoot(page, 'repository-settings-connected', viewport, mode, shots);
      } finally {
        await context.close();
      }
    });
  }
});
