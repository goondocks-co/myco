/**
 * Sessions, signed in as the owner and as a member who is not an admin, at both
 * viewports in both modes: the table across every project, and a session's
 * reading page opened from it. The table narrowed to one project, and an
 * admin's session actions, are checked once each.
 *
 * On the fixture the table holds a live session and two days of sessions across
 * projects, and one session ("Flaky test port collision fixed") has what came of
 * it: spores, a learning run that recorded reading it, one that wrote from it
 * with no record of reading it, a titling run that titled it, and an earlier
 * titling run dispatched on it that recorded nothing. Each check asserts that
 * content, that the page's key parts start on screen, that nothing scrolls
 * sideways, that no raw id reaches the page's text, and that axe-core finds
 * nothing serious or critical.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  expectAxeClean, expectFits, pagesNav, expectNoRawIds, expectQuiet, openPage, shoot, SHOT_MATRIX, type ViewportName,
} from './checks.ts';
import { SCREENS_ENV, screensEnv } from './env.ts';

const onFixture = (): boolean => process.env[SCREENS_ENV.fixture] === '1';

const ROLES = [
  { role: 'admin', cookie: 'ownerCookie' },
  { role: 'member', cookie: 'memberCookie' },
] as const;

/** The session whose reading page the checks open, by its title. */
const OUTCOME_TITLE = 'Flaky test port collision fixed';
/** The live session is untitled; it is headed by the first thing the person typed. */
const LIVE_HEADING = 'Run the canopy parity scenarios on both targets';

/** The fixture's first project: the one Myco's runs and the live session belong to. */
function fixtureProject(): { projectId: string; name: string } {
  const projects = JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>;
  return projects[0]!;
}

/** The rows of the table on a desktop, or its cards on a phone or tablet. */
function rows(page: Page, viewport: ViewportName) {
  const list = page.locator('[data-table="Sessions"]');
  return viewport === 'desktop' ? list.locator('tbody tr:has(td)') : list.locator('li');
}

async function expectTable(page: Page, viewport: ViewportName): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeInViewport();
  const bar = page.locator('[data-filter-bar]');
  await expect(bar).toHaveCount(1);
  await expect(bar).toBeInViewport();
  await expect(bar.getByRole('searchbox', { name: 'Filter sessions' })).toBeVisible();
  for (const name of ['Member', 'State', 'Active']) await expect(bar.getByRole('combobox', { name })).toBeVisible();
  await expect(bar.getByRole('button', { name: /^Agent: / })).toBeVisible();
  await expect(rows(page, viewport).first()).toBeInViewport();
  if (!onFixture()) return;
  const live = page.locator('[data-table="Sessions"] [data-live]');
  await expect(live).toHaveCount(1);
  await expect(live).toContainText('Live');
  await expect(live).toContainText(LIVE_HEADING);
  await expect(live).toContainText('Myco');
  // The Live chip says it is live; the start stays the real start.
  if (viewport === 'desktop') await expect(live.locator('time')).toHaveText(/^\d{2}:\d{2}$/);
  else await expect(live).toContainText(/· \d{2}:\d{2}$/);
  const titled = rows(page, viewport).filter({ hasText: OUTCOME_TITLE });
  await expect(titled).toHaveCount(1);
  await expect(titled).toContainText('Codex');
  await expect(rows(page, viewport).filter({ hasText: 'Checkout form validation messages rewritten' })).toContainText('Atlas web');
  if (viewport === 'desktop') {
    await expect(page.getByRole('table', { name: 'Sessions' }).locator('thead th')).toHaveText(['Session', 'Project', 'Agent', 'Size', 'Started']);
    const groups = page.getByRole('table', { name: 'Sessions' }).locator('tbody th');
    await expect(groups.nth(0)).toHaveText('Live now');
    await expect(groups.nth(1)).toHaveText('Today');
    await expect(groups.nth(2)).toHaveText('Yesterday');
  }
}

/**
 * Opens the table across every project from the nav, the way a reader does
 * from any page that names no project.
 */
async function openTable(page: Page, viewport: ViewportName): Promise<void> {
  await expect(page.locator('main')).toHaveCount(1);
  const link = (await pagesNav(page, viewport)).getByRole('link', { name: 'Sessions' });
  await expect(link).toHaveAttribute('href', '/sessions');
  await link.click();
  await expect(page).toHaveURL(/\/sessions$/);
}

/** Opens the outcome session from the table, the way a reader does. */
async function openOutcomeSession(page: Page): Promise<void> {
  await page.locator('[data-table="Sessions"]').getByRole('link', { name: OUTCOME_TITLE }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(OUTCOME_TITLE);
}

async function expectReadingPage(page: Page, viewport: ViewportName, role: 'admin' | 'member'): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
  await expect(page.locator('[data-summary]')).toBeInViewport();
  await expect(page.locator('[data-summary]')).toHaveText('The test reserved a fixed port that the server’s ephemeral fallback could also pick; it now asks the kernel for one.');
  const outcome = page.locator('[data-outcome]');
  if (viewport === 'desktop') {
    await expect(outcome).toBeInViewport();
    // The facts and what came of it sit beside the conversation, which keeps a readable width.
    const [article, aside] = await Promise.all([page.getByRole('tablist').boundingBox(), page.getByRole('complementary', { name: 'About this session' }).boundingBox()]);
    expect(aside!.x).toBeGreaterThan(article!.x + article!.width);
    expect(article!.width).toBeLessThanOrEqual(760);
  } else {
    await outcome.scrollIntoViewIfNeeded();
  }
  // Two spores Myco's runs wrote, and the one an agent saved later to replace one of them.
  await expect(outcome.getByRole('list', { name: 'Spores from this session' }).getByRole('listitem')).toHaveCount(3);
  const runs = outcome.getByRole('list', { name: 'Myco’s work on this session' }).getByRole('listitem');
  await expect(runs).toHaveCount(4);
  await expect(outcome.locator('[data-outcome-run="read"]', { hasText: 'Myco learned 1 spore from it' })).toContainText('Read it at');
  await expect(outcome.locator('[data-outcome-run="unrecorded"]', { hasText: 'Myco learned 1 spore from it' })).toContainText('No record of what it read');
  await expect(runs.filter({ hasText: 'Myco titled it' })).toHaveCount(1);
  const unrecorded = runs.filter({ hasText: 'Myco was asked to title it' });
  await expect(unrecorded).toContainText('No record of what it read');
  await expect(outcome).not.toContainText(/read nothing/i);
  await expect(page.locator('[data-outcome-run="unrecorded"]')).toHaveCount(2);
  await expect(page.getByRole('list', { name: 'Conversation' }).getByRole('listitem').first()).toBeVisible();
  const raw = page.getByRole('region', { name: 'Raw data' });
  await expect(raw.getByRole('button', { name: 'Raw data' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Session actions' })).toHaveCount(role === 'admin' ? 1 : 0);
  // Codex can resume it: the command sits beside the id, both only ever copied, for every member.
  const facts = page.getByRole('complementary', { name: 'About this session' }).locator('[data-facts]');
  await expect(facts.getByRole('button', { name: 'Copy resume command' })).toBeVisible();
  await expect(facts).not.toContainText('codex resume');
}

test.describe('Sessions', () => {
  for (const { role, cookie } of ROLES) for (const { viewport, mode } of SHOT_MATRIX) {
    test(`sessions table ${role} ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode, cookie: screensEnv(cookie) });
      try {
        await openTable(page, viewport);
        await expectTable(page, viewport);
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        await shoot(page, `sessions-${role}`, viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });

    test(`session reading page ${role} ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the session is the fixture’s');
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode, cookie: screensEnv(cookie) });
      try {
        await openTable(page, viewport);
        await openOutcomeSession(page);
        // The reading page is a link of its own: loaded directly, it reads the same.
        await page.reload();
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(OUTCOME_TITLE);
        await expectReadingPage(page, viewport, role);
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await shoot(page, `session-${role}`, viewport, mode);

        expectQuiet(watch);

        // The raw data opens at the foot of the page. The fixture's capture holds no transcript file, and the
        // transcript read answers a session without one with 404, which the page reads as none captured.
        await page.getByRole('region', { name: 'Raw data' }).getByRole('button', { name: 'Raw data' }).click();
        await expect(page.getByRole('region', { name: 'Transcript files' })).toContainText('No transcript captured.');
        await expect(page.getByRole('region', { name: 'Context Myco prepared' })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectAxeClean(page, ['[data-raw-data]']);
        const noTranscript = (line: string) => /\/transcript: 404$/.test(line);
        expect(watch.failedRequests.filter(noTranscript)).toHaveLength(1);
        watch.failedRequests = watch.failedRequests.filter((line) => !noTranscript(line));
        watch.consoleErrors = watch.consoleErrors.filter((line) => !line.includes('status of 404'));
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  test('the table across every project loads at its own address', async ({ browser }) => {
    const { context, page, watch } = await openPage(browser, { path: '/sessions?state=ended', viewport: 'desktop', mode: 'dark', cookie: screensEnv('ownerCookie') });
    try {
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'State' })).toContainText('Ended');
      await expect(rows(page, 'desktop').first()).toBeVisible();
      expectQuiet(watch);
    } finally {
      await context.close();
    }
  });

  test('the table narrowed to one project', async ({ browser }) => {
    test.skip(!onFixture(), 'the project is the fixture’s');
    const project = fixtureProject();
    const { context, page, watch } = await openPage(browser, { path: `/p/${encodeURIComponent(project.projectId)}/sessions`, viewport: 'desktop', mode: 'dark', cookie: screensEnv('ownerCookie') });
    try {
      await expect(page.getByText(`Every session your agents ran in ${project.name}.`)).toBeInViewport();
      await expect(page.getByRole('table', { name: 'Sessions' }).locator('thead th')).toHaveText(['Session', 'Agent', 'Size', 'Started']);
      await expect(page.locator(`[data-project-filter-item][aria-current="true"]`)).toContainText(project.name);
      // Filtering is the server's: an agent the project has no sessions from empties the table, and Clear brings it back.
      await page.getByRole('button', { name: /^Agent: / }).click();
      await page.getByRole('combobox', { name: 'Search agent' }).fill('Cursor');
      await page.getByRole('option', { name: 'Cursor' }).click();
      await expect(page).toHaveURL(/\?agent=cursor$/);
      await expect(rows(page, 'desktop')).toHaveCount(1);
      await page.getByRole('button', { name: 'Clear search and filters' }).click();
      await expect(page).toHaveURL(new RegExp(`/p/${project.projectId}/sessions$`));
      await expect(rows(page, 'desktop').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectFits(page, 'desktop');
      await expectNoRawIds(page);
      await expectAxeClean(page);
      await shoot(page, 'sessions-project', 'desktop', 'dark');
      expectQuiet(watch);
    } finally {
      await context.close();
    }
  });

  for (const viewport of ['desktop', 'phone'] as const) {
    test(`an admin's session actions ${viewport}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the session is the fixture’s');
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode: 'dark', cookie: screensEnv('ownerCookie') });
      try {
        await openTable(page, viewport);
        await openOutcomeSession(page);
        await page.getByRole('button', { name: 'Session actions' }).click();
        const menu = page.getByRole('menu');
        await expect(menu.getByRole('menuitem')).toHaveText(['Write a new title', 'Delete session']);
        await expectAxeClean(page, ['[role="menu"]']);
        await menu.getByRole('menuitem', { name: 'Delete session' }).click();
        const dialog = page.getByRole('dialog', { name: 'Delete this session?' });
        await expect(dialog).toContainText(OUTCOME_TITLE);
        await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeInViewport();
        await expectFits(page, viewport);
        await expectNoRawIds(page, '[role="dialog"]');
        await expectAxeClean(page, ['[role="dialog"]']);
        await shoot(page, 'session-delete', viewport, 'dark');
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(OUTCOME_TITLE);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }
});
