import { expect, test } from '@playwright/test';
import { expectAxeClean, expectFits, expectNoRawIds, expectQuiet, openPage, shoot, SHOT_MATRIX } from './checks.ts';
import { screensEnv } from './env.ts';

for (const { viewport, mode } of SHOT_MATRIX) {
  test(`project rename settings ${viewport} ${mode}`, async ({ browser }) => {
    const project = (JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>)[0]!;
    const { context, page, watch } = await openPage(browser, {
      path: `/p/${project.projectId}/settings`, viewport, mode, cookie: screensEnv('ownerCookie'),
    });
    try {
      const rename = page.getByRole('button', { name: 'Rename project', exact: true });
      await expect(rename).toBeInViewport();
      await page.waitForLoadState('networkidle');
      await expectFits(page, viewport);
      await shoot(page, 'project-rename-settings', viewport, mode);
      await rename.click();
      const dialog = page.getByRole('dialog', { name: `Rename ${project.name}` });
      await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(project.name);
      await expect(dialog.getByRole('button', { name: 'Rename', exact: true })).toBeInViewport();
      await expectFits(page, viewport);
      await expectNoRawIds(page);
      await expectAxeClean(page);
      expectQuiet(watch);
      await shoot(page, 'project-rename-dialog', viewport, mode);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}
