import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expectAxeClean, expectFits, expectNoHorizontalOverflow, openPage } from './checks';
import { screensEnv } from './env';

const evidence = process.env.MYCO_REPOSITORY_SHOTS_DIR ?? path.join('target', 'ui-screens', 'shots', 'repository');
for (const [viewport, mode] of [['desktop', 'light'], ['phone', 'dark']] as const) {
  test(`repository requirement and run refusal ${viewport} ${mode}`, async ({ browser }) => {
    const project = (JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>)[0]!;
    const { context, page } = await openPage(browser, {
      path: `/p/${project.projectId}/work`, viewport, mode, cookie: screensEnv('ownerCookie'),
    });
    await fs.mkdir(evidence, { recursive: true });
    try {
      await page.route('**/api/attention*', route => route.fulfill({ json: {
        items: [{ kind: 'repository_missing', tone: 'warn', projectId: project.projectId }], unavailable: [],
      } }));
      await page.reload();
      const notice = page.locator('[data-repository-notice]');
      await expect(notice).toContainText(`Connect ${project.name}’s repository so Myco can map its code`);
      await expect(notice.getByRole('link', { name: 'Connect repository →' })).toHaveAttribute('href', `/p/${project.projectId}/settings?connect=repository#repository`);
      await page.route('**/api/harness/dispatch', route => route.fulfill({ status: 400, json: {
        error: 'repository_missing', message: 'Connect the project repository in Settings before running a code task.',
      } }));
      await page.getByRole('button', { name: 'Run a task' }).click();
      await page.getByRole('menuitem', { name: /Update the code map now/ }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Update the code map', exact: true }).click();
      await expect(dialog.locator('[data-refusal]')).toContainText('The code map and other code tasks need this project’s repository before they can run.');
      await expect(dialog.getByRole('button', { name: 'Update the code map', exact: true })).toBeDisabled();
      await expect(dialog.getByRole('link', { name: 'Connect repository →' })).toHaveAttribute('href', `/p/${project.projectId}/settings?connect=repository#repository`);
      await expectFits(page, viewport);
      await expectAxeClean(page, ['[role="dialog"]']);
      await page.screenshot({ path: path.join(evidence, `run-now-repository-refusal-${viewport}-${mode}.png`) });
      await page.route(`**/api/projects/${project.projectId}/repository`, route => route.fulfill({ json: { repository: null } }));
      await dialog.getByRole('link', { name: 'Connect repository →' }).click();
      await expect(page.getByRole('dialog', { name: 'Connect a repository' })).toBeVisible();
      await page.getByRole('dialog').getByRole('switch', { name: 'Use without a token' }).click();
      await expect(page.getByRole('dialog')).toContainText('For a private GitHub repository, use a fine-grained token limited to this repository with Contents: Read-only');
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.goto(new URL(`/p/${project.projectId}`, screensEnv('url')).href);
      const needs = page.locator('[data-needs-you]');
      if (viewport === 'phone') await needs.getByRole('button').first().click();
      await expect(needs).toContainText(`Connect ${project.name}’s repository so Myco can map its code`);
      await expect(needs.getByRole('link', { name: 'Connect repository →' })).toHaveAttribute('href', `/p/${project.projectId}/settings?connect=repository#repository`);
      await expectNoHorizontalOverflow(page);
      await expectAxeClean(page, ['[data-needs-you]']);
      await needs.screenshot({ path: path.join(evidence, `needs-you-repository-${viewport}-${mode}.png`) });
    } finally { await context.close(); }
  });
}
