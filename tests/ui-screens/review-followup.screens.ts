import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { baseUrl, signIn, setAppearance } from './checks';
import { fixtureNow, screensEnv } from './env';

const before = process.env.MYCO_HONESTY_BEFORE;
const report = process.env.MYCO_HONESTY_REPORT ?? path.resolve('target/ui-screens/shots/honesty');

for (const finding of [1, '1-plans', 3, 4]) {
  test(`review correction ${finding} dashboard screenshot`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, timezoneId: 'America/Detroit' });
    await signIn(context, screensEnv('ownerCookie'));
    await setAppearance(context, 'light');
    const page = await context.newPage();
    const now = fixtureNow();
    await page.clock.install({ time: now });
    const projects = JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>;
    const projectId = projects[0]!.projectId;
    const source = await context.request.get(new URL(`/api/projects/${projectId}/sessions?limit=20`, baseUrl()).href, { headers: { cookie: screensEnv('ownerCookie') } });
    const session = (await source.json()).rows[0];
    const sessionPath = `/api/projects/${projectId}/sessions/${session.sessionId}`;
    if (before) await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().resourceType() === 'document') return route.fulfill({ path: path.join(before, 'index.html'), contentType: 'text/html' });
      if (url.pathname.startsWith('/assets/')) return route.fulfill({ path: path.join(before, url.pathname) });
      return route.fallback();
    });
    let inserted = false;
    let unavailable = finding === 4;
    const turn = { promptId: 'review-turn', origin: 'user', promptKind: null, threadLabel: null, preview: 'A reply arrived while this view was closed', blobKey: null, textChars: 45, createdAt: now - 100000, orderedAt: now - 100000, responseCount: 61, toolCallCount: 0, childCount: 0, attachmentCount: 0, planCount: 0 };
    const reply = (i: number) => ({ responseId: `reply-${i}`, promptId: turn.promptId, text: `Reply ${i}`, blobKey: null, createdAt: now - 10000 + i, orderedAt: now - 10000 + i });
    const extra = { ...reply(25.5), text: 'Inserted reply: the missing detail is now captured.' };
    const plan = (i: number) => ({ planKey: `plan-${i}`, promptId: turn.promptId, title: `Plan ${i}`, status: 'active', content: null, blobKey: null, originPath: null, updatedBy: null, progress: null, createdAt: now - 10000 + i, updatedAt: now - 10000 + i, orderedAt: now - 10000 + i });
    if (finding !== 3) {
      await page.route(`**${sessionPath}/turns*`, (route) => route.fulfill({ json: { rows: [turn], cursor: null } }));
      await page.route(`**${sessionPath}/turns/*`, (route) => {
        const url = new URL(route.request().url());
        if (unavailable) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
        if (url.searchParams.has('collection')) {
          if (finding === '1-plans') return route.fulfill({ json: { rows: before ? [plan(51), { ...plan(1), status: 'completed', updatedAt: now }] : [plan(51)], cursor: null } });
          const first = Array.from({ length: 50 }, (_, i) => reply(i + 1));
          const rows = url.searchParams.has('cursor')
            ? Array.from({ length: inserted ? 12 : 11 }, (_, i) => reply((inserted ? 50 : 51) + i))
            : inserted ? [...first.slice(0, 25), extra, ...first.slice(25, 49)] : first;
          return route.fulfill({ json: { rows, cursor: url.searchParams.has('cursor') ? null : inserted ? '49' : '50' } });
        }
        return route.fulfill({ json: { prompt: { ...turn, text: turn.preview, parentPromptId: null }, responses: finding === '1-plans' ? [] : Array.from({ length: 50 }, (_, i) => reply(i + 1)), attachments: [], plans: finding === '1-plans' ? Array.from({ length: 50 }, (_, i) => plan(i + 1)) : [], children: [], injection: null, cursors: { responses: finding === '1-plans' ? null : '50', attachments: null, plans: finding === '1-plans' ? '50' : null, children: null } } });
      });
    } else await page.route('**/api/work?*', (route) => route.fulfill({ json: {
      window: { since: now - 86400000, until: now },
      outcomes: (['learn', 'seed', 'title', 'map'] as const).map((kind) => ({
        projectId, kind, task: { learn: 'extract-curate', seed: 'vault-seed', title: 'title-summary', map: 'canopy-map' }[kind],
        runs: { failed: 1, completed: 200 }, outcome: { spores: kind === 'learn' || kind === 'seed' ? 201 : 0, sessions: kind === 'title' ? 201 : 0, maps: kind === 'map' ? 201 : 0 },
        failedWithOutput: 1, failed: 0, failure: null, latestAt: now, tokens: 0, costUsd: 0, runsWithoutCost: 0,
        spend: { tokens: null, costUsd: null, durationMs: null }, map: null,
      })),
      runs: Array.from({ length: 200 }, (_, i) => {
        const kind = (['learn', 'seed', 'title', 'map'] as const)[i % 4]!;
        return {
          id: `newer-output-${i}`, projectId, kind, task: { learn: 'extract-curate', seed: 'vault-seed', title: 'title-summary', map: 'canopy-map' }[kind],
          status: 'completed', result: 'produced', at: now - i, queuedAt: null, startedAt: now - i - 1000, completedAt: now - i,
          requested: null, identity: { status: 'not_recorded' }, costProvenance: null, harness: null, model: null, provider: null,
          outcome: { spores: kind === 'learn' || kind === 'seed' ? 1 : 0, sessions: kind === 'title' ? 1 : 0, maps: kind === 'map' ? 1 : 0 },
          sessionId: null, failure: null, tokens: 0, costUsd: 0,
        };
      }), truncated: true, cursor: 'older-output', upkeep: { task: 'embedding-reconcile', lastSuccessAt: null, failedInWindow: 0, unrecovered: null },
    } }));
    await page.goto(new URL(finding === 3 ? '/work' : `/p/${projectId}/sessions/${session.sessionId}`, baseUrl()).href);
    if (finding !== 3) await page.getByRole('tab', { name: /^Conversation/ }).click();
    if (finding === 1) {
      await page.getByRole('button', { name: 'Show more replies' }).click();
      await expect(page.getByText('Reply 61', { exact: true })).toBeVisible();
      await page.getByRole('tab', { name: /^Spores/ }).click();
      inserted = true;
      await page.getByRole('tab', { name: /^Conversation/ }).click();
      await expect(page.getByText('Reply 50', { exact: true })).toHaveCount(before ? 2 : 1);
      await expect(page.getByText(extra.text, { exact: true })).toHaveCount(before ? 0 : 1);
      await page.getByText('Reply 25', { exact: true }).scrollIntoViewIfNeeded();
    } else if (finding === '1-plans') {
      await page.getByRole('button', { name: 'Show more plans' }).click();
      await expect(page.getByText('Plan 1', { exact: true })).toHaveCount(before ? 2 : 1);
      await page.getByText('Plan 51', { exact: true }).scrollIntoViewIfNeeded();
    } else if (finding === 3) {
      await expect(page.locator('[data-outcome]')).toHaveCount(4);
      await expect(page.locator('[data-kept]')).toHaveCount(before ? 0 : 4);
    } else {
      await expect(page.getByText(before ? 'This turn could not be read.' : 'Couldn’t read this turn.', { exact: true })).toBeVisible();
      if (!before) await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    }
    fs.mkdirSync(report, { recursive: true });
    await page.screenshot({ path: path.join(report, `review-${finding}-${before ? 'before' : 'after'}.png`), fullPage: finding !== 1 && finding !== '1-plans' });
    if (finding === 4 && !before) {
      unavailable = false;
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(page.getByText('Reply 1', { exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(report, 'review-4-retry-success.png') });
    }
    await context.close();
  });
}
