import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { baseUrl, signIn, setAppearance } from './checks';
import { fixtureNow, screensEnv } from './env';

const before = process.env.MYCO_HONESTY_BEFORE;
const report = process.env.MYCO_HONESTY_REPORT ?? path.resolve('target/ui-screens/shots/honesty');

for (const finding of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
  test(`finding ${finding} dashboard honesty screenshot`, async ({ browser }) => {
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
    if (before) {
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (route.request().resourceType() === 'document') return route.fulfill({ path: path.join(before, 'index.html'), contentType: 'text/html' });
        if (url.pathname.startsWith('/assets/')) return route.fulfill({ path: path.join(before, url.pathname) });
        return route.fallback();
      });
    }
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
    if (finding === 4 || finding === 5) {
      await page.route('**/api/work?*', async (route) => {
        const kind = finding === 4 ? 'map' : 'seed';
        const task = finding === 4 ? 'canopy-map' : 'vault-seed';
        const outcome = { projectId, kind, task, runs: finding === 4 ? { failed: 1, completed: 200 } : { queued: 1 }, outcome: { spores: 0, sessions: 0, maps: finding === 4 ? 200 : 0 }, failedWithOutput: 0, failed: finding === 4 ? 1 : 0, failure: finding === 4 ? { runs: 1, since: now - 10000, latestAt: now - 10000, latestRunId: 'older-failed-run', producedSince: 0 } : null, latestAt: now, tokens: 0, costUsd: 0, runsWithoutCost: 0, spend: { tokens: null, costUsd: null, durationMs: null }, map: null };
        const otherProject = projects[1]!.projectId;
        const outcomes = finding === 4 ? [
          { ...outcome, runs: { failed: 1 }, outcome: { spores: 0, sessions: 0, maps: 0 }, latestAt: now - 10000 },
          { ...outcome, projectId: otherProject, runs: { completed: 200 }, failed: 0, failure: null },
        ] : [outcome];
        const runs = finding === 4 ? Array.from({ length: 200 }, (_, i) => ({
          id: `newer-map-${i}`, projectId: otherProject, kind, task, status: 'completed', result: 'produced',
          at: now - i, queuedAt: null, startedAt: now - i - 1000, completedAt: now - i,
          requested: null, identity: { status: 'not_recorded' }, costProvenance: null, harness: null, model: null, provider: null,
          outcome: { spores: 0, sessions: 0, maps: 1 }, sessionId: null, failure: null, tokens: 0, costUsd: 0,
        })) : [];
        return route.fulfill({ json: { window: { since: now - 86400000, until: now }, outcomes, runs, truncated: finding === 4, cursor: finding === 4 ? 'more' : null, upkeep: { task: 'embedding-reconcile', lastSuccessAt: null, failedInWindow: 0, unrecovered: null } } });
      });
    }
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
    if (finding === 8) await page.route('**/api/credentials*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return route.fulfill({ json: { rows: [], cursor: 'credential-history-continues' } });
    });
    const url = finding <= 2 ? `/p/${projectId}/sessions/${session.sessionId}` : finding === 4 || finding === 5 ? '/work' : finding === 6 ? '/status/health' : finding === 7 ? '/work/tasks' : finding === 8 ? '/me/machines' : '/';
    await page.goto(new URL(url, baseUrl()).href);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    if (finding <= 2) {
      await page.getByRole('tab', { name: /^Conversation/ }).click();
      await expect(page.getByRole('list', { name: 'Conversation' })).toBeVisible();
      if (finding === 1) {
        if (!before) { await page.getByRole('button', { name: 'Show more replies' }).click(); await expect(page.getByText('Final answer on the second page')).toBeVisible(); }
        await page.getByText(before ? 'Reply 50' : 'Final answer on the second page', { exact: true }).scrollIntoViewIfNeeded();
      } else {
        const last = page.getByText(`Conversation turn ${before ? 5000 : 5001}`, { exact: true });
        await expect(last).toBeVisible();
        await last.scrollIntoViewIfNeeded();
      }
    } else if (finding === 3 && !before) await expect(page.getByRole('alert').first()).toBeVisible();
    else if (finding === 6) await page.locator('[data-health-schema]').scrollIntoViewIfNeeded();
    else if (finding === 7) await page.locator('[data-task="canopy-map"]').scrollIntoViewIfNeeded();
    else if (finding === 9) await page.locator('[data-capture]').scrollIntoViewIfNeeded();
    if (finding === 9 && !before) await expect(page.getByRole('img', { name: 'Received recently' })).toBeVisible();
    await page.waitForTimeout(500);
    fs.mkdirSync(report, { recursive: true });
    await page.screenshot({ path: path.join(report, `finding-${finding}-${before ? 'before' : 'after'}.png`), fullPage: finding !== 1 && finding !== 2 });
    await context.close();
  });
}
