/**
 * Today, signed in as the owner and as a member who is not an admin, at both
 * viewports in both modes; the quiet day; connecting a repository Myco isn't
 * capturing yet; and the one-project form.
 *
 * On the fixture the day holds a live session, sessions across projects, a
 * learning run that saved four spores, one that stopped early but kept two,
 * two titling runs, a code map update that failed with its cause, an index
 * update that failed and then succeeded, an access key about to expire, and
 * capture from two named machines. Each check asserts that content, that the
 * page's key parts start on screen, that nothing scrolls sideways, that no raw
 * id reaches the page's text, and that axe-core finds nothing serious or
 * critical.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  expectAxeClean, expectFits, expectNoRawIds, expectQuiet, openPage, shoot, SHOT_MATRIX, type ViewportName,
} from './checks.ts';
import { FIXTURE_TIMEZONE, fixtureNow, SCREENS_ENV, screensEnv } from './env.ts';

const onFixture = (): boolean => process.env[SCREENS_ENV.fixture] === '1';

const ROLES = [
  { role: 'admin', cookie: 'ownerCookie' },
  { role: 'member', cookie: 'memberCookie' },
] as const;

/** A day before the fixture's now, as the `day` parameter names it, in the fixture's time zone. */
function dayBefore(days: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FIXTURE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(fixtureNow() - days * 24 * 3_600_000));
}

/** The fixture's first project: the one Myco's runs, the live session and the access key belong to. */
function fixtureProject(): { projectId: string; name: string } {
  const projects = JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>;
  return projects[0]!;
}

const timeline = (page: Page) => page.getByRole('list', { name: 'What happened' });

/** What the fixture's day shows on the timeline, whoever reads it. */
async function expectFixtureDay(page: Page): Promise<void> {
  const list = timeline(page);
  await expect(page.locator('[data-lede]')).toContainText('Myco learned 6 spores');
  await expect(page.locator('[data-lede]')).toContainText('An agent is working in');
  await expect(list.getByText('Live', { exact: true })).toBeVisible();
  await expect(list.getByText('Canopy parity verified across both targets').or(list.getByText('Run the canopy parity scenarios on both targets'))).toBeVisible();
  const learned = list.locator('li[data-timeline-item]', { hasText: 'Myco learned 4 spores' });
  await expect(learned.getByRole('list', { name: 'Spores it wrote' }).getByRole('listitem')).toHaveCount(4);
  await expect(learned).toContainText('and 1 more');
  const kept = list.locator('li[data-timeline-item]', { hasText: 'Myco learned 2 spores' });
  await expect(kept).toContainText('Stopped early:');
  await expect(kept).toContainText('What it saved is kept, so there’s nothing to do.');
  const map = list.locator('li[data-timeline-item="bad"]', { hasText: 'Myco couldn’t update the code map' });
  await expect(map).toContainText('The task stopped before it could finish.');
  await expect(map).not.toContainText('repo.sha256');
  await expect(map).toContainText('Open the run to see where it stopped.');
  await expect(map.getByRole('link', { name: 'Open the run →' })).toBeVisible();
  const titled = list.locator('li[data-timeline-item]', { hasText: 'Myco titled 2 sessions' });
  await expect(titled.getByRole('list', { name: 'Sessions it titled' }).getByRole('link')).toHaveCount(2);
  // "in" and the project it names stay on one line: a phone never leaves "in" at a line's end with the name below it.
  const split = await page.locator('[data-in-project]').evaluateAll((parts) => parts
    .filter((part) => new Set([...part.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))).size !== 1)
    .map((part) => part.textContent));
  expect(split, '"in <project>" broken across lines').toEqual([]);
  await expect(page.locator('[data-upkeep]')).toContainText('Search kept up to date');
  await expect(page.locator('[data-upkeep]')).toContainText('1 retry along the way');
}

/**
 * Capture lists the machine that sent last agent by agent, and the other machines in one line: every machine to an
 * admin, and a member's own alone to a member. A machine is named to the member it belongs to alone.
 */
async function expectCapture(page: Page, viewport: ViewportName, role: 'admin' | 'member'): Promise<void> {
  const capture = page.locator('[data-capture]');
  if (viewport === 'desktop') await expect(capture).toBeInViewport();
  else await capture.scrollIntoViewIfNeeded();
  await expect(capture).toBeVisible();
  if (!onFixture()) return;
  if (role === 'member') {
    await expect(capture).toContainText('Lin’s build box');
    await expect(capture).not.toContainText('Ada’s studio Mac');
    return;
  }
  await expect(capture).toContainText('Ada’s studio Mac');
  await expect(capture.getByRole('list', { name: 'Agents on Ada’s studio Mac' }).getByRole('img', { name: 'Received recently' })).toHaveCount(1);
  // Another member's machine is listed by its member, never by its name: the server serves the name only to its own member.
  await expect(capture.getByRole('list', { name: 'Other machines' })).toContainText('Lin');
  await expect(capture).not.toContainText('Lin’s build box');
}

/**
 * The fixture's repositories a machine is not capturing yet, as `role` is shown them: an admin every machine's, a member
 * their own. They are one line of "Needs you" that opens to each; it is closed again before returning.
 */
async function expectWaitingRepositories(within: Locator, role: 'admin' | 'member'): Promise<void> {
  const group = within.locator('[data-repositories]');
  await expect(group).toHaveAttribute('data-needs-you-item', 'bad');
  await expect(group).toContainText(role === 'admin' ? '5 repositories aren’t being captured yet' : '4 repositories aren’t being captured yet');
  await expect(group).toContainText('Work in 2 of them isn’t being kept.');
  await group.getByRole('button', { name: 'See each' }).click();
  const rows = group.locator('[data-repository]');
  await expect(rows).toHaveCount(role === 'admin' ? 5 : 4);
  // An archived project holds old-site: nothing connects it, and an admin is pointed to where the project is restored.
  const oldSite = rows.filter({ hasText: 'old-site isn’t being captured yet' });
  await expect(oldSite).toContainText('The project it belongs to is archived. An admin can restore it from Projects.');
  await expect(oldSite.getByRole('button')).toHaveCount(0);
  await expect(oldSite.getByRole('link', { name: 'Open Projects →' })).toHaveCount(role === 'admin' ? 1 : 0);
  await expect(rows.filter({ hasText: 'prototype isn’t being captured yet' })).toContainText('No project holds it yet, and only an admin can start a new one.');
  const notes = rows.filter({ hasText: 'field-notes isn’t being captured yet' });
  await expect(notes).toHaveAttribute('data-needs-you-item', 'bad');
  await expect(notes).toContainText('It has no git remote');
  await expect(notes).toContainText(role === 'admin' ? 'Lin’s machine has kept all it can' : 'Lin’s build box has kept all it can');
  await expect(rows.filter({ hasText: 'sketches isn’t being captured yet' })).toContainText('Work there older than 7 days wasn’t kept.');
  await expect(notes.getByRole('button', { name: 'Connect field-notes' })).toBeVisible();
  if (role === 'admin') {
    const gadget = rows.filter({ hasText: 'gadget isn’t being captured yet' });
    await expect(gadget).toHaveAttribute('data-needs-you-item', 'warn');
    await expect(gadget).toContainText('It’s outside the folders Ada’s studio Mac captures.');
    await expect(gadget).toContainText('4 sessions on Ada’s studio Mac so far, most recently 25 min ago.');
  } else {
    await expect(within).not.toContainText('gadget');
  }
  await expect(within).not.toContainText(/uncaptured/i);
  await group.getByRole('button', { name: 'See each' }).click();
  await expect(rows).toHaveCount(0);
}

test.describe('Today', () => {
  for (const { role, cookie } of ROLES) for (const { viewport, mode } of SHOT_MATRIX) {
    test(`today ${role} ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/', viewport, mode, cookie: screensEnv(cookie) });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        const heading = page.getByRole('heading', { level: 1 });
        await expect(heading).toBeInViewport();
        // A real deployment's day may be quiet: then the one-line empty state stands where the lede and timeline would.
        const firstItem = timeline(page).locator(':scope > li').first();
        await expect(firstItem.or(page.getByRole('status').filter({ hasText: /^Nothing today/ }))).toBeInViewport();
        if (await firstItem.count() > 0) await expect(page.locator('[data-lede]')).toBeInViewport();
        if (onFixture()) {
          await expect(heading).toHaveText(new Intl.DateTimeFormat('en-US', { timeZone: FIXTURE_TIMEZONE, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(fixtureNow())));
          await expectFixtureDay(page);
        }

        if (role === 'admin') {
          if (viewport !== 'phone') {
            const panel = page.locator('[data-needs-you]');
            await expect(panel).toBeInViewport();
            if (onFixture()) {
              await expect(panel.getByRole('heading', { name: 'Needs you' })).toBeVisible();
              await expect(panel.locator('[data-needs-you-item="bad"]').first()).toContainText('A code map update failed');
              await expect(panel.locator('[data-needs-you-item="warn"]').first()).toContainText('Access key “CI deploys” expires');
              await expectWaitingRepositories(panel, role);
            }
          } else {
            const summary = page.locator('[data-needs-you]');
            await expect(summary).toBeInViewport();
            if (onFixture()) {
              await expect(summary.getByRole('button', { name: /3 things need you/ })).toBeVisible();
              await summary.getByRole('button', { name: /3 things need you/ }).click();
              await expect(summary.locator('[data-needs-you-item]')).toHaveCount(3);
              await expectWaitingRepositories(summary, role);
              await expectAxeClean(page, ['[data-needs-you]']);
              await summary.getByRole('button', { name: /3 things need you/ }).click();
              await expect(summary.locator('[data-needs-you-item]')).toHaveCount(0);
            }
          }
        } else if (onFixture()) {
          // A member is shown their own machines' repositories alone, and nothing of the server's own health.
          const needsYou = page.locator('[data-needs-you]');
          if (viewport === 'phone') await needsYou.getByRole('button', { name: /1 thing needs you/ }).click();
          await expect(needsYou.locator('[data-needs-you-item]')).toHaveCount(1);
          await expectWaitingRepositories(needsYou, role);
          await expect(needsYou).not.toContainText('code map');
          if (viewport === 'phone') await needsYou.getByRole('button', { name: /1 thing needs you/ }).click();
        }

        await expectCapture(page, viewport, role);
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await shoot(page, `today-${role}`, viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`today quiet day ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'a quiet day is chosen from the fixture');
      const quiet = dayBefore(5);
      const { context, page, watch } = await openPage(browser, { path: `/?day=${quiet}`, viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        const empty = page.getByRole('status').filter({ hasText: /^Nothing this day/ });
        await expect(empty).toBeInViewport();
        await expect(empty.getByRole('link', { name: 'The day before →' })).toHaveAttribute('href', `/?day=${dayBefore(6)}`);
        await expect(page.getByRole('link', { name: 'Back to today' })).toHaveAttribute('href', '/');
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        await shoot(page, 'today-quiet', viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  /** Today as the owner with the repositories Myco isn't capturing yet opened to each, Ada's `gadget` in view. */
  async function openRepositories(page: Page, viewport: ViewportName): Promise<Locator> {
    const needsYou = page.locator('[data-needs-you]');
    if (viewport === 'phone') await needsYou.getByRole('button', { name: /things need you/ }).click();
    await needsYou.locator('[data-repositories]').getByRole('button', { name: 'See each' }).click();
    const gadget = needsYou.locator('[data-repository]').filter({ hasText: 'gadget isn’t being captured yet' });
    await gadget.scrollIntoViewIfNeeded();
    return gadget;
  }

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`today repositories not captured yet ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the repositories are the fixture\'s');
      const { context, page, watch } = await openPage(browser, { path: '/', viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        const gadget = await openRepositories(page, viewport);
        await expect(gadget.getByRole('button', { name: 'Connect gadget' })).toBeInViewport();
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        expectQuiet(watch);
        await shoot(page, 'today-repositories', viewport, mode);
      } finally {
        await context.close();
      }
    });
  }

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`today connect a repository ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the repository is the fixture\'s');
      const { context, page, watch } = await openPage(browser, { path: '/', viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        const gadget = await openRepositories(page, viewport);
        await gadget.getByRole('button', { name: 'Connect gadget' }).click();
        const dialog = page.getByRole('dialog', { name: 'Connect gadget' });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('Ada’s studio Mac starts capturing it at the next agent session there');
        // Past eight projects the choice is searchable; its trigger names the choice either way.
        await expect(dialog.getByRole('button', { name: /^Project: The project that holds github\.com\/acme\/gadget/ })).toHaveText('Let Myco choose');
        await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        expectQuiet(watch);
        // Nothing is connected: the shot is the last step, and the repository stays for every other check on this fixture.
        await shoot(page, 'today-connect', viewport, mode);
      } finally {
        await context.close();
      }
    });
  }

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`today connect a repository its member may not start a project for ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the repository is the fixture\'s');
      const { context, page, watch } = await openPage(browser, { path: '/', viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        const needsYou = page.locator('[data-needs-you]');
        if (viewport === 'phone') await needsYou.getByRole('button', { name: /things need you/ }).click();
        await needsYou.locator('[data-repositories]').getByRole('button', { name: 'See each' }).click();
        const prototype = needsYou.locator('[data-repository]').filter({ hasText: 'prototype isn’t being captured yet' });
        await prototype.getByRole('button', { name: 'Connect prototype' }).click();
        const dialog = page.getByRole('dialog', { name: 'Connect prototype' });
        await expect(dialog).toBeVisible();
        // Nothing is chosen for the viewer: connecting binds its remote to the project picked, for every clone.
        await expect(dialog.getByRole('button', { name: 'Project', exact: true })).toHaveText('Choose a project');
        await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        expectQuiet(watch);
        await shoot(page, 'today-connect-pick', viewport, mode);
      } finally {
        await context.close();
      }
    });
  }

  test('a past day reads only that day, bounded by the server', async ({ browser }) => {
    test.skip(!onFixture(), 'the day and its rows are the fixture\'s');
    const yesterday = dayBefore(1);
    const { context, page, watch } = await openPage(browser, { path: '/', viewport: 'desktop', mode: 'dark', cookie: screensEnv('ownerCookie') });
    try {
      await expect(timeline(page).locator(':scope > li').first()).toBeVisible();
      const read = (path: string) => page.waitForResponse((response) => new URL(response.url()).pathname === path && new URL(response.url()).searchParams.has('until'));
      const [sessions, spores] = await Promise.all([read('/api/sessions'), read('/api/spores'), page.goto(new URL(`/?day=${yesterday}`, page.url()).href)]);
      // The dashboard asks for the day between its bounds, and the server answers only rows inside them.
      const bounds = (url: string) => ({ since: Number(new URL(url).searchParams.get('since')), until: Number(new URL(url).searchParams.get('until')) });
      const window = bounds(sessions.url());
      expect(window.until - window.since).toBeGreaterThanOrEqual(23 * 3_600_000);
      expect(window.until).toBeLessThanOrEqual(fixtureNow());
      // The day's sessions are those active in it: started before it ends, heard from since it began, not ended before it.
      expect(new URL(sessions.url()).searchParams.get('window')).toBe('activity');
      const sessionRows = (await sessions.json() as { rows: Array<{ startedAt: number | null; firstReceivedAt: number; lastReceivedAt: number; endedAt: number | null }> }).rows;
      expect(sessionRows.length).toBeGreaterThanOrEqual(4);
      for (const row of sessionRows) {
        const at = row.startedAt ?? row.firstReceivedAt;
        const active = at < window.until && row.lastReceivedAt >= window.since && (row.endedAt === null || row.endedAt >= window.since);
        expect(active, `session started ${at}, last heard ${row.lastReceivedAt}, active in [${window.since}, ${window.until})`).toBe(true);
      }
      // The spores read is bounded the same, and its rows and total are the day's alone.
      expect(bounds(spores.url())).toEqual(window);
      const sporeAnswer = await spores.json() as { spores: Array<{ createdAt: number }>; total: number };
      expect(sporeAnswer.spores.length).toBeGreaterThan(0);
      expect(sporeAnswer.total).toBe(sporeAnswer.spores.length);
      for (const spore of sporeAnswer.spores) expect(spore.createdAt >= window.since && spore.createdAt < window.until, `spore at ${spore.createdAt}`).toBe(true);

      // The same reads without the bound do reach the later rows: the bound is what keeps them out.
      const unbounded = await page.evaluate(async (since) => {
        const read = async (path: string) => (await fetch(path, { credentials: 'same-origin' })).json();
        return {
          sessions: await read(`/api/sessions?since=${since}&limit=200`) as { rows: Array<{ startedAt: number | null; firstReceivedAt: number }> },
          spores: await read(`/api/spores?since=${since}&limit=200`) as { spores: Array<{ createdAt: number }>; total: number },
        };
      }, window.since);
      expect(unbounded.sessions.rows.filter((row) => (row.startedAt ?? row.firstReceivedAt) >= window.until).length).toBeGreaterThan(0);
      expect(unbounded.spores.spores.filter((spore) => spore.createdAt >= window.until).length).toBeGreaterThan(0);
      expect(unbounded.spores.total).toBeGreaterThan(sporeAnswer.total);

      await expect(page.getByRole('heading', { level: 1 })).toHaveText(new Intl.DateTimeFormat('en-US', { timeZone: FIXTURE_TIMEZONE, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(fixtureNow() - 24 * 3_600_000)));
      const list = timeline(page);
      for (const title of ['Image gallery lazy-loading added', 'Session reading page summary moved first', 'Markdown export keeps attachments', 'Currency rounding rule documented']) {
        await expect(list.getByText(title, { exact: true })).toBeVisible();
      }
      for (const title of ['Search box height made uniform on list pages', 'Checkout form validation messages rewritten', 'Run the canopy parity scenarios on both targets']) {
        await expect(list.getByText(title, { exact: true })).toHaveCount(0);
      }
      await expect(list.locator(':scope > li[data-timeline-item="live"]')).toHaveCount(0);
      await expect(page.locator('[data-lede]')).toContainText(`Your agents ran ${sessionRows.length} sessions`);
      expectQuiet(watch);
    } finally {
      await context.close();
    }
  });

  test('today narrowed to one project', async ({ browser }) => {
    test.skip(!onFixture(), 'the project is the fixture\'s');
    const project = fixtureProject();
    const { context, page, watch } = await openPage(browser, { path: `/p/${encodeURIComponent(project.projectId)}`, viewport: 'desktop', mode: 'dark', cookie: screensEnv('ownerCookie') });
    try {
      await expect(timeline(page).locator(':scope > li').first()).toBeInViewport();
      await expect(page.locator('[data-lede]')).toContainText('Myco learned 6 spores.');
      await expect(page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('main [data-scope-current]')).toHaveText(project.name);
      await page.waitForLoadState('networkidle');
      await expectFits(page, 'desktop');
      await expectNoRawIds(page);
      await expectAxeClean(page);
      await shoot(page, 'today-project', 'desktop', 'dark');
      expectQuiet(watch);
    } finally {
      await context.close();
    }
  });
});
