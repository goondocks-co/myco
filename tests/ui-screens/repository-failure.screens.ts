import path from 'node:path';
import { expect, test } from '@playwright/test';
import { expectFits, expectNoRawIds, openPage, shoot, SHOTS_DIR, SHOT_MATRIX } from './checks.ts';
import { screensEnv } from './env.ts';

const shots = process.env.MYCO_REPOSITORY_SHOTS_DIR ?? path.join(SHOTS_DIR, 'repository');

test.describe('repository fetch failure in a run panel', () => {
  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`${viewport} ${mode}`, async ({ browser }) => {
      const project = (JSON.parse(screensEnv('projects')) as Array<{ projectId: string }>)[0]!;
      const runId = 'run_5e0b1c2d3f';
      const route = `/p/${project.projectId}/work/runs/${runId}`;
      const { context, page } = await openPage(browser, { path: route, viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await page.route(`**/api/projects/${project.projectId}/runs/${runId}`, async (request) => {
          const response = await request.fetch();
          const answer = await response.json() as { run: Record<string, unknown> };
          await request.fulfill({
            response,
            json: { ...answer, reports: [], source: null, run: {
              ...answer.run,
              errorCode: 'repository_unprepared',
              error: 'Raw worker diagnostic stays out of the panel',
              repositoryFailure: { code: 'fetch_failed', summary: 'Git returned 403 while reading main' },
            } },
          });
        });
        await page.reload();
        const panel = page.getByTestId('run-panel');
        const failure = panel.locator('[data-run-failure]');
        await expect(failure).toContainText('Myco couldn’t read the repository.');
        await expect(failure.getByRole('link', { name: 'Check repository settings' })).toHaveAttribute('href', `/p/${project.projectId}/settings?connect=repository#repository`);
        await expect(failure).not.toContainText('Raw worker diagnostic');
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await panel.locator(':scope > div').last().evaluate(element => { element.scrollTop = 0; });
        await expect(panel.locator('[data-run-headline]')).toBeInViewport();
        await shoot(page, 'repository-fetch-failure', viewport, mode, shots);

        await panel.locator('[data-run-technical]').getByRole('button', { name: /Technical details/ }).click();
        await expect(panel.locator('[data-run-technical]')).toContainText('Git returned 403 while reading main');
        await expect(panel.locator('[data-run-technical]')).not.toContainText('Raw worker diagnostic');
        await shoot(page, 'repository-fetch-failure-details', viewport, mode, shots);
      } finally {
        await context.close();
      }
    });
  }
});
