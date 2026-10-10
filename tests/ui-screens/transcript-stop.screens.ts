import { expect, test } from '@playwright/test';
import path from 'node:path';
import { expectAxeClean, expectFits, expectNoRawIds, expectQuiet, openPage, shoot } from './checks';
import { screensEnv } from './env';

for (const viewport of ['desktop', 'phone'] as const) {
  for (const mode of ['light', 'dark'] as const) {
    test(`stopped transcript reason at Health Status · ${viewport} · ${mode}`, async ({ browser }) => {
      const opened = await openPage(browser, { path: '/status/health#status', viewport, mode, cookie: screensEnv('ownerCookie') });
      const { page } = opened;
      try {
        const projects = JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>;
        await page.route('**/api/attention', async (route) => {
          await route.fulfill({ json: { items: [{
            kind: 'transcripts_stopped', tone: 'warn', projectId: projects[0]!.projectId,
            transcripts: 2, latestAt: Date.now(), reasons: { parse: 2 },
            latestDiagnostic: { branch: 'no_progress', offset: 12345, lineKind: 'tool_result' },
          }], unavailable: [] } });
        });
        await page.reload();
        const stopped = page.locator('[data-health-transcripts]');
        await expect(stopped).toContainText('Reading could not move past a record at byte 12345 (tool result).');
        await stopped.scrollIntoViewIfNeeded();
        await expect(stopped).toBeInViewport();
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        expectQuiet(opened.watch);
        await shoot(page, 'transcript-stop', viewport, mode, path.resolve('tests/ui-screens/evidence/parser-stops'));
      } finally { await opened.context.close(); }
    });
  }
}
