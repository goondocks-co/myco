/**
 * Today, signed in as the owner and as a member who is not an admin, at both
 * viewports in both modes; the quiet day; and the one-project form.
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
import { expect, test, type Page } from '@playwright/test';
import {
  expectAxeClean, expectNoHorizontalOverflow, expectNoRawIds, expectQuiet, openPage, shoot, SHOT_MATRIX, type ViewportName,
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
  await expect(map).toContainText('repo.sha256 is absent from this checkout');
  await expect(map).toContainText('Open the run to see where it stopped.');
  await expect(map.getByRole('link', { name: 'Open the run →' })).toBeVisible();
  const titled = list.locator('li[data-timeline-item]', { hasText: 'Myco titled 2 sessions' });
  await expect(titled.getByRole('list', { name: 'Sessions it titled' }).getByRole('link')).toHaveCount(2);
  await expect(page.locator('[data-upkeep]')).toContainText('Search kept up to date');
  await expect(page.locator('[data-upkeep]')).toContainText('1 retry along the way');
}

/** Capture lists the machine that sent last agent by agent, and the other machine in one line, by name. */
async function expectCapture(page: Page, viewport: ViewportName): Promise<void> {
  const capture = page.locator('[data-capture]');
  if (viewport === 'desktop') await expect(capture).toBeInViewport();
  else await capture.scrollIntoViewIfNeeded();
  await expect(capture).toBeVisible();
  if (!onFixture()) return;
  await expect(capture).toContainText('Ada’s studio Mac');
  await expect(capture.getByRole('list', { name: 'Agents on Ada’s studio Mac' }).getByRole('img', { name: 'Sending now' })).toHaveCount(1);
  await expect(capture.getByRole('list', { name: 'Other machines' })).toContainText('Lin’s build box');
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
          if (viewport === 'desktop') {
            const panel = page.locator('[data-needs-you]');
            await expect(panel).toBeInViewport();
            if (onFixture()) {
              await expect(panel.getByRole('heading', { name: 'Needs you' })).toBeVisible();
              await expect(panel.locator('[data-needs-you-item="bad"]')).toContainText('A code map update failed');
              await expect(panel.locator('[data-needs-you-item="warn"]')).toContainText('Access key “CI deploys” expires');
            }
          } else {
            const summary = page.locator('[data-needs-you]');
            await expect(summary).toBeInViewport();
            if (onFixture()) {
              await expect(summary.getByRole('button', { name: /2 things need you/ })).toBeVisible();
              await summary.getByRole('button', { name: /2 things need you/ }).click();
              await expect(summary.locator('[data-needs-you-item]')).toHaveCount(2);
              await expectAxeClean(page, ['[data-needs-you]']);
              await summary.getByRole('button', { name: /2 things need you/ }).click();
              await expect(summary.locator('[data-needs-you-item]')).toHaveCount(0);
            }
          }
        } else {
          // Nothing of Needs you reaches a member: no card, and no element named for it, loading or failed.
          await expect(page.locator('[data-needs-you]')).toHaveCount(0);
          await expect(page.getByText(/needs you/i)).toHaveCount(0);
          const named = await page.evaluate(() => [...document.querySelectorAll('*')]
            .map((el) => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`)
            .filter((name) => /needs you/i.test(name)));
          expect(named, 'an element named for Needs you').toEqual([]);
        }

        await expectCapture(page, viewport);
        await page.waitForLoadState('networkidle');
        await expectNoHorizontalOverflow(page);
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
        await expectNoHorizontalOverflow(page);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        await shoot(page, 'today-quiet', viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  test('today narrowed to one project', async ({ browser }) => {
    test.skip(!onFixture(), 'the project is the fixture\'s');
    const project = fixtureProject();
    const { context, page, watch } = await openPage(browser, { path: `/p/${encodeURIComponent(project.projectId)}`, viewport: 'desktop', mode: 'dark', cookie: screensEnv('ownerCookie') });
    try {
      await expect(timeline(page).locator(':scope > li').first()).toBeInViewport();
      await expect(page.locator('[data-lede]')).toContainText('Myco learned 6 spores.');
      await expect(page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
      await expect(page.locator(`[data-project-filter-item][aria-current="true"]`)).toContainText(project.name);
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalOverflow(page);
      await expectNoRawIds(page);
      await expectAxeClean(page);
      await shoot(page, 'today-project', 'desktop', 'dark');
      expectQuiet(watch);
    } finally {
      await context.close();
    }
  });
});

test.describe('Code map', () => {
  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`code map ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the project is the fixture\'s');
      const project = fixtureProject();
      const { context, page, watch } = await openPage(browser, { path: `/p/${encodeURIComponent(project.projectId)}/knowledge/map`, viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(page.getByRole('heading', { level: 1, name: 'Code map' })).toBeInViewport();
        await expect(page.getByTestId('repository-map')).toBeInViewport();
        await page.waitForLoadState('networkidle');
        await expectNoHorizontalOverflow(page);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        await shoot(page, 'code-map', viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }
});
