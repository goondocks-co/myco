import { expect, test } from '@playwright/test';
import { baseUrl, signIn, setAppearance } from './checks';
import { fixtureNow, screensEnv } from './env';

for (const finding of [1, 2, 3, 6, 7, 9]) {
  test(`finding ${finding} dashboard state`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, timezoneId: 'America/Detroit' });
    await signIn(context, screensEnv(finding === 7 ? 'memberCookie' : 'ownerCookie'));
    await setAppearance(context, 'light');
    const page = await context.newPage();
    const now = fixtureNow();
    await page.clock.install({ time: now });
    const projects = JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>;
    const projectId = projects[0]!.projectId;
    const source = await context.request.get(new URL(`/api/projects/${projectId}/sessions?limit=20`, baseUrl()).href, { headers: { cookie: screensEnv(finding === 7 ? 'memberCookie' : 'ownerCookie') } });
    const session = (await source.json()).rows.find((row: { title: string | null }) => row.title) ?? (await source.json()).rows[0];
    const sessionPath = `/api/projects/${projectId}/sessions/${session.sessionId}`;
    const turn = (n: number) => ({ promptId: `turn-${n}`, origin: 'user', promptKind: null, threadLabel: null, preview: `Conversation turn ${n}`, blobKey: null, createdAt: now - (5002 - n) * 1000, orderedAt: now - (5002 - n) * 1000, responseCount: finding === 1 ? 51 : 0, toolCallCount: 0, childCount: 0, attachmentCount: 0, planCount: 0 });
    if (finding === 1 || finding === 2) {
      await page.route(`**${sessionPath}/turns*`, async (route) => {
        const url = new URL(route.request().url());
        const after = Number(url.searchParams.get('cursor') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 200);
        if (finding === 1) return route.fulfill({ json: { rows: [turn(1)], cursor: null } });
        const desc = url.searchParams.get('order') === 'desc';
        const rows = Array.from({ length: Math.min(limit, 5001 - after) }, (_, i) => turn(desc ? 5001 - after - i : after + i + 1));
        return route.fulfill({ json: { rows, cursor: after + limit < 5001 ? String(after + limit) : null } });
      });
      await page.route(`**${sessionPath}/turns/*`, async (route) => {
        const url = new URL(route.request().url());
        const n = Number(url.pathname.split('/').pop()?.replace('turn-', ''));
        const row = turn(n);
        const response = (i: number) => ({ responseId: `reply-${i}`, promptId: row.promptId, text: i === 51 ? 'Final answer on the second page' : `Reply ${i}`, blobKey: null, createdAt: now - 1000, orderedAt: now - 1000 });
        if (url.searchParams.has('collection')) return route.fulfill({ json: { rows: [response(51)], cursor: null } });
        return route.fulfill({ json: { prompt: { ...row, text: row.preview, parentPromptId: null }, responses: finding === 1 ? Array.from({ length: 50 }, (_, i) => response(i + 1)) : [], children: [], attachments: [], plans: [], injection: null, cursors: { responses: finding === 1 ? 'second' : null, children: null, attachments: null, plans: null } } });
      });
    }
    if (finding === 3) await page.route('**/api/spores?*', (route) => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
    if (finding === 6 || finding === 9) {
      await page.route('**/api/status', async (route) => {
        const response = await route.fetch(); const data = await response.json();
        if (finding === 6) { data.projects = []; data.transcriptBacklog = null; data.unavailable = ['projects', 'transcriptBacklog']; }
        else data.capture = [{ machineId: 'receipt-machine', machineName: 'Ada’s studio Mac', member: { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada' }, agent: 'codex', lastEventAt: now - 14 * 60000, projectId }];
        return route.fulfill({ json: data });
      });
    }
    if (finding === 7) {
      await page.route('**/api/tasks*', async (route) => {
        const response = await route.fetch();
        let data = await response.json();
        if (!data.tasks) {
          const single = await context.request.get(new URL(`/api/tasks?project=${projectId}`, baseUrl()).href, { headers: { cookie: screensEnv('memberCookie') } }); data = await single.json();
        }
        const single = new URL(route.request().url()).searchParams.has('project');
        for (const task of data.tasks) if (task.task === 'canopy-map') task.availabilityNote = single ? 'Switched off for this project' : 'Switched off for 1 of 2 selected projects';
        return route.fulfill({ json: data });
      });
    }
    const url = finding <= 2 ? `/p/${projectId}/sessions/${session.sessionId}` : finding === 6 ? '/status/health' : finding === 7 ? '/work/tasks' : '/';
    await page.goto(new URL(url, baseUrl()).href);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    if (finding <= 2) {
      await page.getByRole('tab', { name: /^Conversation/ }).click();
      await expect(page.getByRole('list', { name: 'Conversation' })).toBeVisible();
      if (finding === 1) {
        await page.getByRole('button', { name: 'Show more replies' }).click(); await expect(page.getByText('Final answer on the second page')).toBeVisible();
        await page.getByText('Final answer on the second page', { exact: true }).scrollIntoViewIfNeeded();
      } else {
        const last = page.getByText(`Conversation turn 5001`, { exact: true }).first();
        await expect(last).toBeVisible();
        await last.scrollIntoViewIfNeeded();
      }
    } else if (finding === 3) await expect(page.getByRole('alert').first()).toBeVisible();
    else if (finding === 6) await page.locator('[data-health-schema]').scrollIntoViewIfNeeded();
    else if (finding === 7) await page.locator('[data-task="canopy-map"]').scrollIntoViewIfNeeded();
    else if (finding === 9) await page.locator('[data-capture]').scrollIntoViewIfNeeded();
    if (finding === 9) await expect(page.getByRole('img', { name: 'Received recently' })).toBeVisible();
    await context.close();
  });
}
