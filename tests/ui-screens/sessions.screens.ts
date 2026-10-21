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
/** A session with a plan: the one the filter-bar plan came out of. */
const PLAN_SESSION_TITLE = 'Search box height made uniform on list pages';
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
  for (const name of ['Member', 'State', 'Active']) await expect(bar.getByRole('combobox', { name: new RegExp(`^${name}(?::|$)`) })).toBeVisible();
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
  await settled(page);
}

/** Waits for the conversation's turns and each turn's body to be read, so a tab opened next cancels none of them. */
async function settled(page: Page): Promise<void> {
  await expect(page.getByRole('status', { name: 'Loading the conversation' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Conversation', exact: true }).getByRole('listitem').first()).toBeVisible();
  await expect(page.getByRole('status', { name: 'Reading this turn' })).toHaveCount(0);
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
  // Two spores Myco's runs wrote, and the one an agent saved later to replace one of them, listed on the Spores tab.
  await expect(outcome.getByRole('link', { name: '3 spores from this session →' })).toHaveAttribute('href', /\/sessions\/[^/?]+\?tab=spores$/);
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
  const conversation = page.getByRole('list', { name: 'Conversation', exact: true });
  await expect(page.locator('[data-session-context]').getByText('Myco sent the session start block')).toBeVisible();
  await expect(conversation.getByText('Myco prepared 1 sub-agent preamble')).toBeVisible();
  await expect(conversation.getByText('Sub-agent tokens not recorded')).toBeVisible();
  await expect(conversation).not.toContainText('<subagent_notification>');
  await expect(conversation.getByText('This test fails one run in twenty', { exact: true })).toBeVisible();
  const envelope = conversation.getByRole('button', { name: 'Sub-agent notification', exact: true });
  await expect(envelope).toBeVisible();
  await envelope.click();
  await expect(conversation.getByText('/audit', { exact: true })).toBeVisible();
  await envelope.click();
  await conversation.getByRole('button', { name: 'Myco prepared no context' }).click();
  await expect(conversation.getByText('No relevant memories found')).toBeVisible();
  await expect(conversation.getByText('12 matches, none relevant enough')).toBeVisible();
  await conversation.getByRole('button', { name: 'Myco prepared no context' }).click();
  await expect(conversation.getByRole('button', { name: /Myco added .*spore/ })).toBeVisible();
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
        await watch.navigate(() => openTable(page, viewport));
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
        await watch.navigate(() => openTable(page, viewport));
        await watch.navigate(() => openOutcomeSession(page));
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
      await expect(page.getByRole('combobox', { name: /^State(?::|$)/ })).toContainText('Ended');
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
      await expect(page.getByText('Every session your agents ran.')).toBeInViewport();
      await expect(page.getByRole('table', { name: 'Sessions' }).locator('thead th')).toHaveText(['Session', 'Agent', 'Size', 'Started']);
      await expect(page.locator('main [data-scope-current]')).toHaveText(project.name);
      // Filtering is the server's: an agent the project has no sessions from empties the table, and Clear brings it back.
      await page.getByRole('button', { name: /^Agent: / }).click();
      await page.getByRole('combobox', { name: 'Search agent' }).fill('Cursor');
      await watch.navigate(async () => {
        await page.getByRole('option', { name: 'Cursor' }).click();
        await expect(page).toHaveURL(/\?agent=cursor$/);
      });
      await expect(rows(page, 'desktop')).toHaveCount(1);
      await watch.navigate(async () => {
        await page.getByRole('button', { name: 'Clear search and filters' }).click();
        await expect(page).toHaveURL(new RegExp(`/p/${project.projectId}/sessions$`));
      });
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

  /** The checks every state of a session's list passes, and its picture. */
  async function expectListState(page: Page, viewport: ViewportName, shot: string): Promise<void> {
    await page.waitForLoadState('networkidle');
    await expectFits(page, viewport);
    await expectNoRawIds(page);
    await expectAxeClean(page);
    await shoot(page, shot, viewport, 'light');
  }

  for (const viewport of ['desktop', 'phone'] as const) {
    test(`a session's spores and plans tabs ${viewport}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the sessions are the fixture’s');
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode: 'light', cookie: screensEnv('ownerCookie') });
      try {
        await watch.navigate(() => openTable(page, viewport));
        await watch.navigate(() => openOutcomeSession(page));
        const tabs = page.getByRole('tablist', { name: 'What the session holds' });
        await expect(tabs.getByRole('tab')).toHaveText(['Conversation', 'Agent activity', 'Outcomes', 'Spores', 'Plans']);

        // Spores: every one the session produced, a row each, the type above its line and its status under it.
        await tabs.getByRole('tab', { name: 'Spores' }).click();
        await expect(page).toHaveURL(/\?tab=spores$/);
        const spores = page.getByRole('list', { name: 'Spores' }).getByRole('listitem');
        await expect(spores).toHaveCount(3);
        await expect(spores.filter({ hasText: 'Gotcha' })).toHaveCount(2);
        await expect(spores.filter({ hasText: 'Replaced' })).toHaveCount(1);
        await expect(page.getByText('Showing 3 of 3 spores')).toBeVisible();
        // A divider under every row but the last.
        const dividers = await spores.evaluateAll((items) => items.map((item) => getComputedStyle(item.firstElementChild!).borderBottomWidth));
        expect(dividers).toEqual(['1px', '1px', '0px']);
        await expectListState(page, viewport, 'session-spores');

        await page.getByRole('button', { name: 'Type: Every type' }).click();
        await page.getByRole('option', { name: 'Gotchas' }).click();
        await expect(page).toHaveURL(/\?tab=spores&type=gotcha$/);
        await expect(spores).toHaveCount(2);
        await expectListState(page, viewport, 'session-spores-filtered');

        await page.getByRole('button', { name: 'Type: Gotchas' }).click();
        await page.getByRole('option', { name: 'Decisions' }).click();
        await expect(page.getByText('No spores in this session match this filter.')).toBeVisible();
        await expectListState(page, viewport, 'session-spores-none-match');

        // Another tab opens without the filter, and a session with no plans says so.
        await tabs.getByRole('tab', { name: 'Plans' }).click();
        await expect(page).toHaveURL(/\?tab=plans$/);
        await expect(page.getByText('No plans were captured in this session.')).toBeVisible();
        await expect(page.getByRole('combobox', { name: /^Status(?::|$)/ })).toHaveText('Every status');
        await expectListState(page, viewport, 'session-plans-empty');

        // A spore's row opens the spore.
        await tabs.getByRole('tab', { name: 'Spores' }).click();
        await watch.navigate(async () => {
          await spores.filter({ hasText: 'Fix' }).getByRole('link').click();
          await expect(page).toHaveURL(/\/spores\/[^/?]+$/);
        });
        await expect(page.getByText('A test that reserves a fixed port races the server’s ephemeral fallback', { exact: false }).first()).toBeVisible();

        // Plans: a session that wrote one lists it with its status words, filters by status and title, and opens it.
        await watch.navigate(async () => {
          await page.goto(new URL('/sessions', page.url()).href);
          await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
        });
        await page.locator('[data-table="Sessions"]').getByRole('link', { name: PLAN_SESSION_TITLE }).click();
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(PLAN_SESSION_TITLE);
        await settled(page);
        await tabs.getByRole('tab', { name: 'Plans' }).click();
        const plans = page.getByRole('list', { name: 'Plans' }).getByRole('listitem');
        await expect(plans).toHaveCount(1);
        await expect(plans.first()).toContainText('Open');
        await expect(plans.first()).toContainText('One filter bar on every list page');
        await expect(plans.first()).toContainText('0 of 3 items done');
        await expectListState(page, viewport, 'session-plans');

        await page.getByRole('searchbox', { name: 'Search plans' }).fill('filter bar');
        await expect(page).toHaveURL(/\?tab=plans&q=filter\+bar$/);
        await page.getByRole('combobox', { name: /^Status(?::|$)/ }).click();
        await page.getByRole('option', { name: 'Done', exact: true }).click();
        await expect(page.getByText('No plans in this session match this filter.')).toBeVisible();
        await expectListState(page, viewport, 'session-plans-none-match');
        await page.getByRole('combobox', { name: /^Status(?::|$)/ }).click();
        await page.getByRole('option', { name: 'Open', exact: true }).click();
        await expect(plans).toHaveCount(1);
        await expectListState(page, viewport, 'session-plans-filtered');

        await watch.navigate(async () => {
          await plans.first().getByRole('link').click();
          await expect(page).toHaveURL(/\/plans\/[^/?]+$/);
        });
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('One filter bar on every list page');
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  for (const viewport of ['desktop', 'phone'] as const) {
    test(`a session's agent activity tab ${viewport}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the sessions are the fixture’s');
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode: 'light', cookie: screensEnv('ownerCookie') });
      const capture = async (name: string) => {
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        await shoot(page, name, viewport, 'light', process.env.MYCO_ACTIVITY_SHOTS_DIR);
      };
      try {
        await watch.navigate(() => openTable(page, viewport));
        await watch.navigate(() => openOutcomeSession(page));
        const sessionUrl = page.url();
        const tabs = page.getByRole('tablist', { name: 'What the session holds' });
        await tabs.getByRole('tab', { name: 'Agent activity' }).click();
        await expect(page).toHaveURL(/\?tab=activity$/);
        const list = page.getByRole('list', { name: 'Agent activity' });
        const events = list.getByRole('listitem');
        await expect(events).toHaveCount(4);
        await expect(events.filter({ hasText: 'Tool reported a failure' })).toContainText('Failure');
        const legacy = events.filter({ hasText: 'Tool call did not succeed' });
        await expect(legacy).toContainText('Reason not recorded · Not tied to a prompt');
        await expect(legacy.getByRole('link')).toHaveCount(0);
        await expect(page.getByRole('searchbox')).toHaveCount(0);
        await capture('session-activity-failure');

        await page.getByRole('combobox', { name: /^Type(?::|$)/ }).click();
        await page.getByRole('option', { name: 'No result captured', exact: true }).click();
        await expect(page).toHaveURL(/tab=activity&type=no_result$/);
        await expect(events).toHaveCount(2);
        await expect(events.filter({ hasText: 'Read' })).toContainText('Not tied to a prompt');
        await expect(events.getByRole('link')).toHaveCount(0);
        await capture('session-activity-no-result');

        await page.getByRole('combobox', { name: /^Tool(?::|$)/ }).click();
        await page.getByRole('option', { name: 'Read', exact: true }).click();
        await expect(events).toHaveCount(1);
        await expect(page).toHaveURL(/type=no_result&tool=Read$/);
        await capture('session-activity-filtered');

        await page.getByRole('combobox', { name: /^Result(?::|$)/ }).click();
        await page.getByRole('option', { name: 'Succeeded', exact: true }).click();
        await expect(page.getByText('No agent activity in this session matches these filters.')).toBeVisible();
        await capture('session-activity-none-match');

        await page.getByRole('button', { name: 'Clear search and filters' }).click();
        await expect(page).toHaveURL(/\?tab=activity$/);
        await expect(events).toHaveCount(4);
        await watch.navigate(async () => {
          await events.filter({ hasText: 'Tool reported a failure' }).getByRole('link').click();
          await expect(page).toHaveURL(/\?turn=/);
        });
        await expect(tabs.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('list', { name: 'Conversation', exact: true })).toBeVisible();

        await page.goto(`${sessionUrl}?tab=activity&type=failure&tool=Bash&failed=true`);
        await expect(events).toHaveCount(1);
        await tabs.getByRole('tab', { name: 'Plans' }).click();
        await expect(page).toHaveURL(/\?tab=plans$/);

        await page.goto(new URL('/sessions', page.url()).href);
        await page.locator('[data-table="Sessions"]').getByRole('link', { name: 'Checkout form validation messages rewritten' }).click();
        await tabs.getByRole('tab', { name: 'Agent activity' }).click();
        await expect(page.getByText('No agent activity was recorded in this session.')).toBeVisible();
        await capture('session-activity-empty');
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  for (const viewport of ['desktop', 'phone'] as const) {
    test(`a session's outcomes tab ${viewport}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the sessions are the fixture’s');
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode: 'light', cookie: screensEnv('ownerCookie') });
      const reopen = async (title: string) => {
        await watch.navigate(async () => {
          await page.goto(new URL('/sessions', page.url()).href);
          await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
        });
        await page.locator('[data-table="Sessions"]').getByRole('link', { name: title }).click();
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
        await settled(page);
      };
      try {
        await watch.navigate(() => openTable(page, viewport));
        await watch.navigate(() => openOutcomeSession(page));
        const tabs = page.getByRole('tablist', { name: 'What the session holds' });

        // The commits it started and ended on, with the release check on the end commit it classified.
        await tabs.getByRole('tab', { name: 'Outcomes' }).click();
        await expect(page).toHaveURL(/\?tab=outcomes$/);
        const outcomes = page.getByRole('list', { name: 'Outcomes' }).getByRole('listitem');
        await expect(outcomes).toHaveCount(2);
        await expect(outcomes.nth(0)).toContainText('Started at 3f9c2a1 on main');
        await expect(outcomes.nth(1)).toContainText('Ended at 8d41b7e');
        await expect(outcomes.nth(1)).toContainText(/Released · myco\/v2\.0\.3 · PR #1873 · checked /);
        await expect(outcomes.getByRole('button', { name: 'Copy commit' })).toHaveCount(2);
        await expect(page.locator('[data-session-events="outcomes"] [data-filter-bar]')).toHaveCount(0);
        await expectListState(page, viewport, 'session-outcomes');

        // Equal start and end commits are said to be the same, and a dirty end says so.
        await reopen(PLAN_SESSION_TITLE);
        await tabs.getByRole('tab', { name: 'Outcomes' }).click();
        await expect(outcomes).toHaveCount(2);
        await expect(outcomes.nth(1)).toContainText('Ended at 5be0c94, uncommitted changes');
        await expect(outcomes.nth(1)).toContainText('Start and end HEAD are the same');
        await expectListState(page, viewport, 'session-outcomes-same-dirty');

        // A session whose commits were never observed says so; another tab opens from it.
        await reopen('Checkout form validation messages rewritten');
        await tabs.getByRole('tab', { name: 'Outcomes' }).click();
        await expect(page.getByText('No commits were observed in this session.')).toBeVisible();
        await expectListState(page, viewport, 'session-outcomes-empty');
        await tabs.getByRole('tab', { name: 'Spores' }).click();
        await expect(page).toHaveURL(/\?tab=spores$/);
        await tabs.getByRole('tab', { name: 'Conversation' }).click();
        await expect(page).toHaveURL(/\/sessions\/[^/?]+$/);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  for (const viewport of ['desktop', 'phone'] as const) {
    test(`searching a session's conversation ${viewport}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the session is the fixture’s');
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode: 'light', cookie: screensEnv('ownerCookie') });
      try {
        await watch.navigate(() => openTable(page, viewport));
        await watch.navigate(() => openOutcomeSession(page));
        const box = page.getByRole('searchbox', { name: 'Search the conversation' });
        await expect(box).toBeVisible();

        // The prompt and the reply that said it, each leading to the turn they belong to.
        await box.fill('fixed port');
        await expect(page).toHaveURL(/\?q=fixed\+port$/);
        const matches = page.getByRole('list', { name: 'Matches' }).getByRole('listitem');
        await expect(matches).toHaveCount(2);
        const prompt = matches.filter({ hasText: 'Prompt' });
        const reply = matches.filter({ hasText: 'Reply' });
        await expect(prompt).toContainText('Stop reserving a fixed port');
        await expect(reply).toContainText('Done: stop reserving a fixed port');
        await expect(reply).toContainText('In reply to “Stop reserving a fixed port”');
        await expect(page.getByRole('list', { name: 'Conversation', exact: true })).toHaveCount(0);
        await expectListState(page, viewport, 'session-conversation-search');

        await box.fill('qqzzxx');
        await expect(page.getByText('Nothing said in this session matches “qqzzxx”.')).toBeVisible();
        await expectListState(page, viewport, 'session-conversation-search-none');

        // A hit opens its turn, and the search is left behind.
        await box.fill('fixed port');
        await expect(matches).toHaveCount(2);
        await reply.getByRole('link').click();
        await expect(page).toHaveURL(/\/sessions\/[^/?]+\?turn=[^&]+$/);
        const conversation = page.getByRole('list', { name: 'Conversation', exact: true });
        await expect(conversation.getByText('Stop reserving a fixed port', { exact: true })).toBeInViewport();
        await expect(page.getByRole('searchbox', { name: 'Search the conversation' })).toHaveValue('');
        await expectListState(page, viewport, 'session-conversation-search-opened');
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

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
