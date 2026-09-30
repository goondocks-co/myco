/**
 * Knowledge, signed in as the owner and as a member who is not an admin, at
 * both viewports in both modes: the spore stream across every project, a
 * replaced spore's article opened from it, the plans board and a plan's page
 * opened from it. A project's code map, ⌘K across every project, and the old
 * address of the spores list are checked on their own.
 *
 * On the fixture the stream holds spores of every type across projects, two
 * saved without their one line and one replaced by a newer spore; the board
 * holds a plan in every status. Each check asserts that content, that the
 * page's key parts start on screen, that nothing scrolls sideways, that no raw
 * id reaches the page's text, and that axe-core finds nothing serious or
 * critical.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  expectAxeClean, expectNoHorizontalOverflow, expectNoRawIds, expectQuiet, openPage, shoot, SHOT_MATRIX, type ViewportName,
} from './checks.ts';
import { SCREENS_ENV, screensEnv } from './env.ts';

const onFixture = (): boolean => process.env[SCREENS_ENV.fixture] === '1';

const ROLES = [
  { role: 'admin', cookie: 'ownerCookie' },
  { role: 'member', cookie: 'memberCookie' },
] as const;

/** The spore another replaced, and the line of the one that replaced it. */
const REPLACED_LINE = 'A port the kernel hands out can be reused at once; never cache it across test files.';
const REPLACING_LINE = 'Bind every test server to port 0 and read its port back from the server’s address; never share one across files.';
/** The plan the checks open from the board, and the session that wrote it. */
const PLAN_TITLE = 'Myco’s work as outcomes';
const PLAN_SESSION = 'Work outcomes counted per task';

function fixtureProject(): { projectId: string; name: string } {
  const projects = JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>;
  return projects[0]!;
}

/** Opens Knowledge across every project from the nav, the way a reader does from a page that names no project. */
async function openKnowledge(page: Page, viewport: ViewportName): Promise<void> {
  await expect(page.locator('main')).toHaveCount(1);
  const nav = viewport === 'desktop' ? page.getByRole('navigation', { name: 'Pages' }) : page.getByRole('navigation', { name: 'Main pages' });
  const link = nav.getByRole('link', { name: 'Knowledge' });
  await expect(link).toHaveAttribute('href', '/knowledge');
  await link.click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await expect(link).toHaveAttribute('aria-current', 'page');
}

const cards = (page: Page) => page.locator('[data-spore-stream] li[data-spore]');

async function expectStream(page: Page, viewport: ViewportName): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeInViewport();
  const tabs = page.getByRole('navigation', { name: 'Knowledge sections' });
  await expect(tabs.getByRole('link', { name: 'Spores' })).toHaveAttribute('aria-current', 'page');
  const bar = page.locator('[data-filter-bar]');
  await expect(bar).toHaveCount(1);
  await expect(bar).toBeInViewport();
  await expect(bar.getByRole('searchbox', { name: 'Filter spores' })).toBeVisible();
  for (const name of ['Status', 'Saved']) await expect(bar.getByRole('combobox', { name })).toBeVisible();
  await expect(cards(page).first()).toBeInViewport();
  if (viewport === 'desktop') {
    await expect(page.getByRole('region', { name: 'Type' })).toBeInViewport();
    await expect(page.getByRole('region', { name: 'Project' })).toBeVisible();
  } else {
    await expect(page.getByRole('region', { name: 'Type' })).toHaveCount(0);
    // Every type is in the fixture, so the type is the searchable select: a button naming its value.
    await expect(bar.getByRole('combobox', { name: 'Type' }).or(bar.getByRole('button', { name: /^Type: / }))).toBeVisible();
  }
  if (!onFixture()) return;
  const tied = cards(page).filter({ hasText: 'Hosted and self-hosted order ties differently' });
  await expect(tied).toHaveCount(1);
  await expect(tied).toContainText('Gotcha');
  await expect(tied).toContainText('Myco');
  await expect(cards(page).filter({ hasText: 'Validation messages name the field' })).toContainText('Atlas web');
  // Saved without a one line: headlined by type and day, with the start of what it says beneath.
  const unlined = page.locator('[data-spore-stream] li[data-unlined]');
  await expect(unlined).toHaveCount(2);
  await expect(unlined.filter({ hasText: /^Discovery saved / })).toContainText('Opening a long session on its latest turns');
  // The replaced spore is not current, so the stream opens without it.
  await expect(cards(page).filter({ hasText: REPLACED_LINE })).toHaveCount(0);
  if (viewport === 'desktop') {
    const types = page.getByRole('region', { name: 'Type' });
    await expect(types.getByRole('button', { name: /^Everything/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(types.getByRole('button', { name: /^Decisions/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Project' }).getByRole('link', { name: /^Atlas web/ })).toBeVisible();
  }
}

/** Opens the replaced spore from the stream: the status filter first, then its card. */
async function openReplacedSpore(page: Page): Promise<void> {
  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Replaced' }).click();
  await expect(page).toHaveURL(/status=superseded/);
  const card = cards(page).filter({ hasText: REPLACED_LINE });
  await expect(card).toContainText('Replaced');
  await card.getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(REPLACED_LINE);
}

async function expectArticle(page: Page, viewport: ViewportName): Promise<void> {
  const article = page.locator('[data-spore-article]');
  await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
  const replaced = article.locator('[data-spore-replaced]');
  await expect(replaced).toBeInViewport();
  await expect(replaced.getByRole('link', { name: REPLACING_LINE })).toBeVisible();
  await expect(article.locator('[data-spore-body]')).toContainText('Two test files cached the same ephemeral port');
  // The replaced spore replaced nothing itself, so it has no foot of what it replaced.
  await expect(article.locator('[data-spore-lineage]')).toHaveCount(0);
  const origin = article.locator('[data-spore-origin]');
  if (viewport === 'desktop') {
    await expect(origin).toBeInViewport();
    const [body, aside] = await Promise.all([article.locator('[data-spore-body]').boundingBox(), page.getByRole('complementary', { name: 'About this spore' }).boundingBox()]);
    expect(aside!.x).toBeGreaterThan(body!.x + body!.width);
    expect(body!.width).toBeLessThanOrEqual(760);
  }
  await expect(origin).toContainText('Flaky test port collision fixed');
  await expect(origin.getByRole('link', { name: 'Open the session →' })).toBeVisible();
  await expect(origin.getByRole('link', { name: 'The run that wrote it →' })).toBeVisible();
  await expect(article.locator('[data-facts]').getByRole('button', { name: 'Copy spore id' })).toBeVisible();
}

const column = (page: Page, status: string) => page.locator(`[data-plan-column="${status}"]`);

async function expectBoard(page: Page, viewport: ViewportName): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('link', { name: 'Plans' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-filter-bar]')).toHaveCount(1);
  await expect(page.getByRole('searchbox', { name: 'Search plans' })).toBeInViewport();
  await expect(page.locator('[data-plan-column] h2')).toHaveText(['In progress', 'Open', 'Done', 'Abandoned']);
  await expect(column(page, 'in_progress')).toBeInViewport();
  if (viewport === 'desktop') {
    // Every column sits side by side on a desktop.
    for (const status of ['active', 'completed', 'abandoned']) await expect(column(page, status)).toBeInViewport();
  }
  if (!onFixture()) return;
  await expect(column(page, 'in_progress').getByRole('link', { name: PLAN_TITLE, exact: true })).toBeVisible();
  await expect(column(page, 'in_progress')).toContainText('1 of 3 items done');
  await expect(column(page, 'active').getByRole('link', { name: 'One filter bar on every list page', exact: true })).toBeVisible();
  await expect(column(page, 'completed').getByRole('link', { name: 'Speed up the monthly close report', exact: true })).toBeVisible();
  await expect(column(page, 'completed')).toContainText('Ledger service');
  await expect(column(page, 'abandoned').getByRole('link', { name: 'Last-writer-wins offline sync', exact: true })).toBeVisible();
  await expect(column(page, 'in_progress').getByRole('link', { name: `The session that wrote “${PLAN_TITLE}”` })).toBeVisible();
}

async function expectPlanPage(page: Page, viewport: ViewportName, role: 'admin' | 'member'): Promise<void> {
  const plan = page.locator('[data-plan-page]');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(PLAN_TITLE);
  await expect(plan.locator('[data-plan-status]')).toHaveText('In progress');
  await expect(plan.locator('[data-plan-progress]')).toContainText('1 of 3 items done');
  await expect(plan.locator('[data-plan-body]')).toContainText('Fold index upkeep into one line');
  const written = plan.locator('[data-plan-session]');
  if (viewport === 'desktop') await expect(written).toBeInViewport();
  await expect(written).toContainText(PLAN_SESSION);
  await expect(written.getByRole('link', { name: 'Open the session →' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Plan status' })).toHaveCount(role === 'admin' ? 1 : 0);
  await expect(plan.locator('[data-facts]').getByRole('button', { name: 'Copy plan key' })).toBeVisible();
  // The plan is read by its key, so its tags come with it.
  if (onFixture()) await expect(plan.locator('[data-facts]')).toContainText('Tagsdashboardoutcomes');
}

/** The page's own checks, then its screenshot. */
async function settle(page: Page, name: string, viewport: ViewportName, mode: 'dark' | 'light'): Promise<void> {
  await page.waitForLoadState('networkidle');
  await expectNoHorizontalOverflow(page);
  await expectNoRawIds(page);
  await expectAxeClean(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shoot(page, name, viewport, mode);
}

test.describe('Knowledge', () => {
  for (const { role, cookie } of ROLES) for (const { viewport, mode } of SHOT_MATRIX) {
    test(`spore stream ${role} ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode, cookie: screensEnv(cookie) });
      try {
        await openKnowledge(page, viewport);
        await expectStream(page, viewport);
        await settle(page, `knowledge-${role}`, viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });

    test(`spore article ${role} ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the spore is the fixture’s');
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode, cookie: screensEnv(cookie) });
      try {
        await openKnowledge(page, viewport);
        await openReplacedSpore(page);
        // The article is a link of its own: loaded directly, it reads the same.
        await page.reload();
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(REPLACED_LINE);
        await expectArticle(page, viewport);
        await settle(page, `spore-${role}`, viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });

    test(`plans board ${role} ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode, cookie: screensEnv(cookie) });
      try {
        await openKnowledge(page, viewport);
        await page.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('link', { name: 'Plans' }).click();
        await expect(page).toHaveURL(/\/knowledge\/plans$/);
        await expectBoard(page, viewport);
        await settle(page, `plans-${role}`, viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });

    test(`plan page ${role} ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the plan is the fixture’s');
      const { context, page, watch } = await openPage(browser, { path: '/knowledge/plans', viewport, mode, cookie: screensEnv(cookie) });
      try {
        await column(page, 'in_progress').getByRole('link', { name: PLAN_TITLE, exact: true }).click();
        await expect(page).toHaveURL(/\/plans\/[0-9a-f-]+$/);
        await expectPlanPage(page, viewport, role);
        await settle(page, `plan-${role}`, viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`code map ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the project is the fixture’s');
      const project = fixtureProject();
      const { context, page, watch } = await openPage(browser, { path: `/p/${encodeURIComponent(project.projectId)}/knowledge/map`, viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(page.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeInViewport();
        await expect(page.getByRole('navigation', { name: 'Knowledge sections' }).getByRole('link', { name: 'Code map' })).toHaveAttribute('aria-current', 'page');
        await expect(page.getByTestId('repository-map')).toBeInViewport();
        await settle(page, 'code-map', viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });

    test(`search across every project ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the project is the fixture’s');
      const project = fixtureProject();
      const { context, page, watch } = await openPage(browser, { path: `/p/${encodeURIComponent(project.projectId)}/knowledge`, viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(cards(page).first()).toBeVisible();
        await page.keyboard.press('ControlOrMeta+k');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText(`Search ${project.name}`);
        const scope = dialog.getByRole('group', { name: 'Search in' });
        await expect(scope.getByRole('button', { name: project.name })).toHaveAttribute('aria-pressed', 'true');
        await scope.getByRole('button', { name: 'Every project · words only' }).click();
        const input = dialog.getByRole('searchbox', { name: 'Search every project' });
        await expect(input).toBeFocused();
        await input.fill('checkout');
        const results = dialog.locator('a[data-result]');
        await expect(results.first()).toBeVisible();
        await expect(dialog.locator('[data-result-project]', { hasText: 'Atlas web' }).first()).toBeVisible();
        await expect(dialog.getByRole('heading', { level: 3 }).first()).toBeVisible();
        await input.press('ArrowDown');
        await expect(results.first()).toBeFocused();
        await expectNoHorizontalOverflow(page);
        await expectNoRawIds(page, '[role="dialog"]');
        await expectAxeClean(page, ['[role="dialog"]']);
        await shoot(page, 'knowledge-search', viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  test('the old address of a project’s spores leads to its Knowledge', async ({ browser }) => {
    test.skip(!onFixture(), 'the project is the fixture’s');
    const project = fixtureProject();
    const { context, page, watch } = await openPage(browser, { path: `/p/${encodeURIComponent(project.projectId)}/spores?type=gotcha`, viewport: 'desktop', mode: 'dark', cookie: screensEnv('ownerCookie') });
    try {
      await expect(page).toHaveURL(new RegExp(`/p/${project.projectId}/knowledge\\?type=gotcha$`));
      await expect(page.getByRole('region', { name: 'Type' }).getByRole('button', { name: /^Gotchas/ })).toHaveAttribute('aria-pressed', 'true');
      await expect(cards(page).first()).toContainText('Gotcha');
      await expect(page.locator(`[data-project-filter-item][aria-current="true"]`)).toContainText(project.name);
      expectQuiet(watch);
    } finally {
      await context.close();
    }
  });
});
