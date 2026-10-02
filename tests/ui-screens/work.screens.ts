/**
 * Myco's work, signed in as the owner and as a member who is not an admin, at
 * every viewport (desktop, tablet, phone) in both modes: the page under the fixture's first project,
 * a run's panel, the "Run a task" confirmation, the page across every
 * project, and the old Agent runs address.
 *
 * On the fixture the week holds learning runs (one that stopped early but
 * kept two spores, one Lin started by hand that saved four, one held off
 * while learning was switched off), two titling runs, a code map update that
 * failed on Lin's build box after one Ada started yesterday, and the search
 * index's upkeep with one retry. Each check asserts that content, that the
 * page's key parts start on screen, that nothing scrolls sideways, that no raw
 * id reaches the page's text outside a facts panel, and that axe-core finds
 * nothing serious or critical. Nothing here starts a task: the confirmation is
 * always cancelled, so the fixture every other check reads is left as it was.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  expectAxeClean, expectFits, expectNoRawIds, expectQuiet, openPage, shoot, SHOT_MATRIX,
} from './checks.ts';
import { SCREENS_ENV, screensEnv } from './env.ts';
import { MACHINE_IDS } from './machine-ids.ts';

const onFixture = (): boolean => process.env[SCREENS_ENV.fixture] === '1';

const ROLES = [
  { role: 'admin', cookie: 'ownerCookie' },
  { role: 'member', cookie: 'memberCookie' },
] as const;

/** The fixture's first project: the one Myco's runs belong to. */
function fixtureProject(): { projectId: string; name: string } {
  const projects = JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>;
  return projects[0]!;
}

const workPath = () => `/p/${encodeURIComponent(fixtureProject().projectId)}/work`;

const card = (page: Page, kind: string) => page.locator(`article[data-outcome="${kind}"]`);

/** What the fixture's week shows, whoever reads it. */
async function expectFixtureWeek(page: Page, role: 'admin' | 'member'): Promise<void> {
  await expect(page.locator('[data-lede]')).toContainText('learned 6 spores');
  await expect(page.locator('[data-lede]')).toContainText('titled 2 sessions');
  await expect(page.locator('[data-lede]')).toContainText('1 code map update failed, and none has worked since.');

  const learn = card(page, 'learn');
  await expect(learn.getByRole('heading', { level: 2 })).toHaveText(/^Learned 6 spores from \d+ sessions$/);
  await expect(learn.getByRole('list', { name: 'Spores it wrote' }).getByRole('listitem')).toHaveCount(3);
  const runs = learn.getByRole('list', { name: 'Latest learning runs' });
  await expect(runs.locator('[data-run-line="held"]')).toContainText('Held off: it was switched off for this project');
  await expect(runs).toContainText(role === 'member' ? 'by you' : 'by Lin');
  // A machine is named only to the member it belongs to; to anyone else it reads as that member's, and never by its id.
  const main = page.locator('main');
  if (role === 'admin') {
    await expect(runs).toContainText('Ada’s studio Mac');
    await expect(main).not.toContainText('Lin’s build box');
    // Lin's machine reads as hers: the map update that failed on it is "from Lin".
    await expect(main).toContainText('from Lin');
  } else {
    await expect(runs).toContainText('from Ada');
    await expect(main).not.toContainText('Ada’s studio Mac');
  }
  for (const machine of Object.values(MACHINE_IDS)) await expect(main).not.toContainText(machine);
  await expect(main).not.toContainText(/\b[Aa] machine\b/);
  await expect(learn.locator('[data-kept]')).toContainText('One run stopped early');
  await expect(learn.locator('[data-kept]')).toContainText('It kept the 2 spores it had saved, so there’s nothing to do.');

  const map = card(page, 'map');
  const failure = map.locator('[data-failure="open"]');
  await expect(failure).toContainText('1 code map update failed this week');
  await expect(failure).toContainText('The task stopped before it could finish.');
  await expect(failure).not.toContainText('repo.sha256');
  // Lin's own machine is named to Lin; to Ada it reads as Lin's, never by its name.
  if (role === 'member') await expect(failure).toContainText('On Lin’s build box: The task stopped before it could finish.');
  else await expect(failure).toContainText('On Lin’s machine: The task stopped before it could finish.');
  await expect(failure).toContainText('Open the run to see where it stopped.');
  await failure.getByRole('button', { name: 'Details' }).click();
  await expect(failure).toContainText('the run ended without its artifact');
  await expect(failure).toContainText('The task stopped before it could finish.');
  await failure.getByRole('button', { name: 'Details' }).click();
  await expect(failure.getByRole('link', { name: 'Open the latest attempt →' })).toBeVisible();
  await expect(map.getByRole('list', { name: 'Latest code map updates' })).toContainText(role === 'admin' ? 'by you' : 'by Ada');

  const title = card(page, 'title');
  await expect(title.getByRole('heading', { level: 2 })).toHaveText('Titled and summarized 2 sessions');
  await expect(title.getByRole('list', { name: 'Sessions it titled' }).getByRole('link')).toHaveCount(2);

  await expect(page.locator('[data-upkeep]')).toContainText('Search kept up to date');
  await expect(page.locator('[data-upkeep]')).toContainText('1 retry along the way');
  const cost = page.locator('[data-cost]');
  await expect(cost.locator('[data-cost-total]')).toHaveText(/^\$\d+\.\d\d$/);
  await expect(cost).toContainText('Recorded costs may include agent estimates and estimates using model prices; they are not a bill. 2 runs reported no cost, so the total is incomplete.');
}

test.describe('Myco’s work', () => {
  test('failed run details retain its reason and report', async ({ browser }) => {
    test.skip(!onFixture(), 'Requires the screen fixture’s failed run.');
    const { context, page, watch } = await openPage(browser, { path: workPath(), viewport: 'desktop', mode: 'light', cookie: screensEnv('ownerCookie') });
    try {
      await card(page, 'map').getByRole('link', { name: 'Open the latest attempt →' }).click();
      const panel = page.locator('[data-slide-over]');
      await expect(panel.locator('[data-run-failure]')).toContainText('The task stopped before it could finish.');
      await expect(panel).not.toContainText('the run ended without its artifact');
      await expect(panel.locator('[data-run-report]')).toContainText('repo.sha256');
      await panel.locator('[data-run-technical]').getByRole('button', { name: /Technical details/ }).click();
      await expect(panel.locator('[data-run-technical]')).toContainText('the run ended without its artifact');
      await expect(panel.getByRole('region', { name: 'The agent’s report' })).toContainText('repo.sha256 is absent from this checkout');
      await expectNoRawIds(page);
      await expectAxeClean(page);
      expectQuiet(watch);
    } finally { await context.close(); }
  });

  for (const { role, cookie } of ROLES) for (const { viewport, mode } of SHOT_MATRIX) {
    test(`work ${role} ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: workPath(), viewport, mode, cookie: screensEnv(cookie) });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        await expect(page.getByRole('heading', { level: 1, name: 'Myco’s work' })).toBeInViewport();
        await expect(page.locator('[data-filter-bar]')).toHaveCount(1);
        await expect(page.locator('[data-filter-bar]')).toBeInViewport();
        // Every member, admin or not, can start a task: the menu is there for both.
        await expect(page.getByRole('button', { name: 'Run a task' })).toBeVisible();
        const first = page.locator('article[data-outcome]').first();
        await expect(first).toBeVisible();
        if (viewport === 'desktop') {
          await expect(first).toBeInViewport();
          await expect(page.locator('[data-cost]')).toBeInViewport();
        }
        if (onFixture()) await expectFixtureWeek(page, role);
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        await shoot(page, `work-${role}`, viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  for (const { role, cookie } of ROLES) for (const { viewport, mode } of SHOT_MATRIX) {
    test(`work run panel ${role} ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: workPath(), viewport, mode, cookie: screensEnv(cookie) });
      try {
        const runs = card(page, 'learn').getByRole('list', { name: 'Latest learning runs' });
        const line = onFixture() ? runs.locator('li', { hasText: '4 spores' }) : runs.locator('li').first();
        await line.getByRole('link').click();
        const panel = page.locator('[data-slide-over]');
        await expect(panel).toBeVisible();
        await expect(page).toHaveURL(/\/work\/runs\//);
        await expect(panel.locator('[data-run-headline]')).toBeInViewport();
        if (onFixture()) {
          await expect(panel.locator('[data-run-headline]')).toHaveText('Learned 4 spores from 1 session');
          // The run's own account of what it did leads, above what it read.
          await expect(panel.locator('[data-run-report]')).toHaveText('Read 1 session and saved 4 spores from it.');
          await expect(panel.locator('[data-started-by]')).toHaveText(role === 'member' ? 'started by you' : 'started by Lin');
          await expect(panel.getByRole('region', { name: 'Sessions it read' })).toContainText('Flaky test port collision fixed');
          await expect(panel.getByRole('list', { name: 'Spores it wrote' }).getByRole('listitem')).toHaveCount(4);
        }
        // Technical details start folded; opened, the run's id is only ever copied.
        const technical = panel.locator('[data-run-technical]');
        await expect(technical.locator('[data-facts]')).toHaveCount(0);
        await technical.getByRole('button', { name: /Technical details/ }).click();
        await expect(technical.locator('[data-facts]')).toBeVisible();
        await expect(technical.getByRole('button', { name: 'Copy run id' })).toBeVisible();
        if (onFixture()) {
          await expect(technical).toContainText(role === 'admin' ? 'Ada’s studio Mac' : 'Ada’s machine');
          if (role === 'member') await expect(technical).not.toContainText('Ada’s studio Mac');
          await expect(technical).toContainText('Codex');
          await expect(technical).toContainText('Model not recorded');
          await expect(technical).toContainText('Cost provenance not recorded');
        }
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page, ['[data-slide-over]']);
        await shoot(page, `work-run-${role}`, viewport, mode);
        await panel.getByRole('button', { name: 'Close' }).click();
        await expect(panel).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`${workPath().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  for (const { role, cookie } of ROLES) for (const { viewport, mode } of SHOT_MATRIX) {
    test(`work run a task ${role} ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: workPath(), viewport, mode, cookie: screensEnv(cookie) });
      const dispatched: string[] = [];
      page.on('request', (request) => { if (request.url().includes('/api/harness/dispatch')) dispatched.push(request.url()); });
      try {
        await page.getByRole('button', { name: 'Run a task' }).click();
        const menu = page.getByRole('menu');
        await expect(menu.getByRole('menuitem')).toHaveCount(3);
        await expectAxeClean(page, ['[role="menu"]']);
        await menu.getByRole('menuitem', { name: /Update the code map now/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Update the code map now?' });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('[data-spend]')).toContainText('This spends model tokens.');
        if (onFixture()) await expect(dialog.locator('[data-spend]')).toContainText('This week’s updates each used 24K tokens, about $0.48 by the agent’s estimate.');
        // Only an admin may start a task fresh; a member never sees the choice.
        await expect(dialog.getByRole('switch', { name: 'Start fresh' })).toHaveCount(role === 'admin' ? 1 : 0);
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page, ['[role="dialog"]']);
        await shoot(page, `work-run-a-task-${role}`, viewport, mode);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toHaveCount(0);
        expect(dispatched, 'the confirmation was cancelled, so nothing was started').toEqual([]);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`work across every project ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/work', viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(page.getByRole('heading', { level: 1, name: 'Myco’s work' })).toBeInViewport();
        await expect(page.getByText('What Myco did in the background, across every project')).toBeVisible();
        // A task is started in one project: across every project there is no menu, and the rail says how to pick one.
        await expect(page.getByRole('button', { name: 'Run a task' })).toHaveCount(0);
        await expect(page.locator('[data-when]')).toContainText('To start a task by hand, pick a project in the nav.');
        if (onFixture()) {
          await expect(page.locator('[data-lede]')).toContainText('This week, Myco learned 6 spores');
          await expect(card(page, 'learn').getByRole('list', { name: 'Latest learning runs' })).toContainText(fixtureProject().name);
        }
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        await shoot(page, 'work-all', viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  test('the Agent runs address leads to Myco’s work', async ({ browser }) => {
    const { projectId } = fixtureProject();
    const { context, page, watch } = await openPage(browser, { path: `/p/${encodeURIComponent(projectId)}/runs`, viewport: 'desktop', mode: 'dark', cookie: screensEnv('memberCookie') });
    try {
      await expect(page).toHaveURL(new RegExp(`/p/${projectId}/work$`));
      await expect(page.getByRole('heading', { level: 1, name: 'Myco’s work' })).toBeVisible();
      await expect(page.getByRole('navigation').getByRole('link', { name: 'Myco’s work' }).first()).toHaveAttribute('aria-current', 'page');
      expectQuiet(watch);
    } finally {
      await context.close();
    }
  });
});

for (const viewport of ['desktop', 'phone'] as const) for (const mode of ['light', 'dark'] as const) {
  test(`empty work window all-time history ${viewport} ${mode}`, async ({ browser }) => {
    test.skip(!onFixture(), 'Requires a project with no recorded work.');
    const quietProject = (JSON.parse(screensEnv('projects')) as Array<{ projectId: string }>)[1]!;
    const { context, page, watch } = await openPage(browser, { path: `/p/${encodeURIComponent(quietProject.projectId)}/work?window=today&outcome=map`, viewport, mode, cookie: screensEnv('ownerCookie') });
    try {
      await expect(page.getByRole('status')).toContainText('No code map today');
      await expect(page.locator('[data-lede]')).toHaveCount(0);
      const all = page.getByRole('button', { name: 'Show all · all time' });
      await expect(all).toBeVisible();
      await expectFits(page, viewport);
      await expectAxeClean(page);
      const shot = await shoot(page, 'run-panel-empty-window', viewport, mode, process.env.MYCO_RUN_PANEL_SHOTS);
      await page.screenshot({ path: shot, fullPage: false });
      await all.click();
      await expect(page.getByRole('button', { name: 'All-time run history' })).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('button', { name: 'Code map updates · all time' })).toHaveAttribute('aria-expanded', 'true');
      expectQuiet(watch);
    } finally { await context.close(); }
  });

  test(`stored run audit panel ${viewport} ${mode}`, async ({ browser }) => {
    test.skip(!onFixture(), 'Requires the recorded audit fixture.');
    const { context, page, watch } = await openPage(browser, { path: `${workPath()}/runs/run_c19f7a0e55`, viewport, mode, cookie: screensEnv('ownerCookie') });
    try {
      const panel = page.locator('[data-slide-over]');
      await expect(panel.locator('header [data-model-summary]')).toContainText('Requested: high · opus · high effort');
      await expect(panel.locator('header [data-model-summary]')).toContainText('Actual: claude-sonnet-4-6');
      await expect(panel.locator('header [data-model-mismatch]')).toBeVisible();
      await expect(panel.locator('[data-run-summary]')).toHaveText('Read 2 files, searched once, ran 1 command and saved the code map; 1 step failed.');
      const files = panel.getByRole('region', { name: 'Files it read' });
      await expect(files).toContainText('packages/myco/src/runner/loop.ts');
      await expect(files).toContainText('packages/myco-shared/src/command-shape.ts');
      const calls = panel.getByRole('region', { name: 'What it did' });
      await expect(calls.getByRole('listitem')).toHaveCount(8);
      await expect(calls.locator('[data-activity-seen="both"]')).toHaveCount(4);
      await expect(calls).toContainText('Searched packages/myco-server/src');
      await expect(calls).toContainText('Ran git log --oneline');
      await expect(calls).toContainText('Map text must be a bounded nonempty line.');
      await expect(calls.getByRole('listitem').nth(5)).toContainText('a later call to the same operation succeeded');
      await expect(calls.getByRole('button', { name: 'Show more' })).toHaveCount(0);
      await expect(calls.getByRole('listitem').nth(6)).toContainText('117 ms · Succeeded');
      await expect(calls.locator('[data-coverage="complete"]')).toContainText('Every step the worker saw is listed.');
      const account = panel.locator('[data-run-account]');
      await expect(account).toContainText('Recovered: Shortened the entry and saved the map again');
      await expect(panel.locator('[data-audit-checks]')).toHaveAttribute('data-audit-checks', 'clear');
      await expect(panel.getByRole('link', { name: 'Open the current code map →' })).toBeVisible();
      const shots = process.env.MYCO_RUN_PANEL_SHOTS;
      await panel.locator('[data-run-headline]').scrollIntoViewIfNeeded();
      await shoot(page, 'run-panel-summary', viewport, mode, shots);
      const summaryShot = await shoot(page, 'run-panel-summary-viewport', viewport, mode, shots);
      await page.screenshot({ path: summaryShot, fullPage: false });
      await calls.scrollIntoViewIfNeeded();
      await shoot(page, 'run-panel-calls', viewport, mode, shots);
      const callsShot = await shoot(page, 'run-panel-calls-viewport', viewport, mode, shots);
      await page.screenshot({ path: callsShot, fullPage: false });
      await account.scrollIntoViewIfNeeded();
      const accountShot = await shoot(page, 'run-panel-account-viewport', viewport, mode, shots);
      await page.screenshot({ path: accountShot, fullPage: false });
      await panel.getByRole('button', { name: 'Report details' }).click();
      await expect(panel.getByRole('region', { name: 'The agent’s report' })).toContainText('Corrected the map text');
      await panel.getByRole('button', { name: 'Instruction at launch' }).click();
      await expect(panel).toContainText('Keep every map entry to one bounded line.');
      await expect(panel).toContainText('Standing rules were not recorded for this run.');
      await shoot(page, 'run-panel-instruction', viewport, mode, shots);
      const instructionShot = await shoot(page, 'run-panel-instruction-viewport', viewport, mode, shots);
      await page.screenshot({ path: instructionShot, fullPage: false });
      await expectFits(page, viewport);
      await expectNoRawIds(page);
      await expectAxeClean(page, ['[data-slide-over]']);
      expectQuiet(watch);
    } finally { await context.close(); }
  });
}
