/**
 * The dashboard shell, signed in as the owner and as a member who is not an
 * admin, at every viewport (desktop, tablet, phone) in both modes.
 *
 * The shell is the nav column on a desktop, and the header, bottom bar and nav
 * drawer on a phone. Each check opens a project's Sessions page inside it and
 * asserts the shell's pages, People link, owner-only admin links, search,
 * account, and no project list. It checks the page's scope switcher beside
 * its title, sideways scrolling, raw ids in shell text, and serious or
 * critical axe-core findings. The
 * pages inside keep their own checks: they are rebuilt, and held to account,
 * in later phases.
 *
 * The Projects page is still shot inside the shell; the admin pages have their own checks.
 */
import { INVITE_CONTROLS } from '../../packages/myco-shared/src/member-protocol.ts';
import { expect, test, type Page } from '@playwright/test';
import {
  expectAxeClean, expectFits, expectNoRawIds, expectQuiet, expectUniformSearch, filterBarMetrics, openPage, shoot, SHOT_MATRIX,
} from './checks.ts';
import { SCREENS_ENV, screensEnv } from './env.ts';

const onFixture = (): boolean => process.env[SCREENS_ENV.fixture] === '1';

/** Every part of the shell, and nothing of the page inside it. */
const SHELL = '[data-shell]';

const ROLES = [
  { role: 'admin', cookie: 'ownerCookie', name: 'Ada' },
  { role: 'member', cookie: 'memberCookie', name: 'Lin' },
] as const;

/** Health's name carries the count of what needs an admin, so it is matched by its start. */
const ADMIN_PAGES = ['Projects', 'Settings', /^Health/] as const;
const PAGES_NAV = ['Today', 'Sessions', 'Knowledge', 'Myco’s work'];

/** The project the checks open: the fixture's first, or on a real deployment the first the Projects page lists. */
function fixtureProject(): { projectId: string; name: string } | null {
  if (!onFixture()) return null;
  const projects = JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>;
  expect(projects.length).toBeGreaterThan(0);
  return projects[0]!;
}

async function sessionsPath(page: Page): Promise<string> {
  const project = fixtureProject();
  if (project !== null) return `/p/${encodeURIComponent(project.projectId)}/sessions`;
  const first = page.getByRole('list', { name: 'Projects' }).getByRole('link').first();
  const href = await first.getAttribute('href');
  if (href === null) throw new Error('the Projects page lists no project');
  return `${href}/sessions`;
}

/** The nav lists pages only: no list of projects, in the column or the drawer. */
async function expectNoProjectList(scope: ReturnType<Page['locator']>): Promise<void> {
  await expect(scope.getByRole('navigation', { name: 'Projects' })).toHaveCount(0);
  await expect(scope.locator('[data-scope-switcher]')).toHaveCount(0);
}

/** The page's header says which project it shows, beside the title, on screen at every width. */
async function expectScopeInHeader(page: Page): Promise<void> {
  const scope = page.locator('main [data-scope-switcher]');
  await expect(scope).toBeInViewport();
  await expect(scope).toHaveAttribute('data-scope-switcher', 'project');
  const project = fixtureProject();
  if (project !== null) await expect(scope.locator('[data-scope-current]')).toHaveText(project.name);
}

/** The pages, the role's nav foot and the account are all on screen, whatever the project list holds. */
async function expectNavInView(scope: ReturnType<Page['locator']>, role: 'admin' | 'member'): Promise<void> {
  const pages = scope.getByRole('navigation', { name: 'Pages' });
  for (const label of PAGES_NAV) await expect(pages.getByRole('link', { name: label })).toBeInViewport();
  await expect(pages.getByRole('link', { name: 'Project settings' })).toHaveCount(role === 'admin' ? 1 : 0);
  const admin = scope.getByRole('navigation', { name: 'Admin' });
  if (role === 'admin') {
    await expect(admin.getByRole('link', { name: INVITE_CONTROLS.page })).toBeInViewport();
    for (const label of ADMIN_PAGES) await expect(admin.getByRole('link', { name: label })).toBeInViewport();
    await expect(scope.getByRole('navigation', { name: 'People' })).toHaveCount(0);
  } else {
    await expect(admin).toHaveCount(0);
    await expect(scope.getByRole('link', { name: 'Projects', exact: true })).toHaveCount(0);
    await expect(scope.getByRole('navigation', { name: 'People' }).getByRole('link', { name: INVITE_CONTROLS.page })).toBeInViewport();
  }
  await expect(scope.getByRole('button', { name: /^Account and appearance for / })).toBeInViewport();
}

test.describe('dashboard shell', () => {
  for (const { role, cookie, name } of ROLES) for (const { viewport, mode } of SHOT_MATRIX) {
    test(`shell ${role} ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode, cookie: screensEnv(cookie) });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        await page.goto(new URL(await sessionsPath(page), page.url()).href);
        await expect(page.getByRole('searchbox', { name: 'Filter sessions' })).toBeVisible();

        if (viewport === 'desktop') {
          const nav = page.getByRole('complementary', { name: 'Navigation' });
          await expect(nav).toBeVisible();
          await expect(nav.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page');
          await expectNavInView(nav, role);
          await expectNoProjectList(nav);
          await expect(nav.getByRole('button', { name: /Search/ })).toBeInViewport();
          if (onFixture()) await expect(nav.getByRole('button', { name: `Account and appearance for ${name}` })).toBeInViewport();
        } else {
          await expect(page.getByRole('complementary', { name: 'Navigation' })).toHaveCount(0);
          await expect(page.getByRole('banner')).toContainText('Sessions');
          await expect(page.getByRole('banner').getByRole('button', { name: 'Search' })).toBeVisible();
          if (viewport === 'phone') {
            const bar = page.getByRole('navigation', { name: 'Main pages' });
            for (const label of ['Today', 'Sessions', 'Knowledge']) await expect(bar.getByRole('link', { name: label })).toBeInViewport();
            await expect(bar.getByRole('link', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page');
          } else {
            // A tablet has no bottom bar: the header opens the nav.
            await expect(page.getByRole('navigation', { name: 'Main pages' })).toHaveCount(0);
            await expect(page.getByRole('banner').getByRole('button', { name: 'Open navigation' })).toBeVisible();
          }
        }

        await expectScopeInHeader(page);
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectNoRawIds(page, SHELL);
        await expectAxeClean(page, [SHELL]);
        await shoot(page, `shell-${role}`, viewport, mode);

        if (viewport !== 'desktop') {
          // The phone's More and the tablet's header button open the nav links.
          const opener = viewport === 'phone'
            ? page.getByRole('navigation', { name: 'Main pages' }).getByRole('button', { name: 'More' })
            : page.getByRole('banner').getByRole('button', { name: 'Open navigation' });
          await opener.click();
          const drawer = page.getByRole('dialog', { name: 'Navigation' });
          await expect(drawer).toBeVisible();
          await expect(drawer.getByRole('link', { name: 'Myco’s work' })).toBeVisible();
          await expect(drawer.getByRole('link', { name: INVITE_CONTROLS.page, exact: true })).toHaveCount(1);
          for (const label of ADMIN_PAGES) await expect(drawer.getByRole('link', { name: label, exact: typeof label === 'string' })).toHaveCount(role === 'admin' ? 1 : 0);
          await expectNavInView(drawer, role);
          await expectNoProjectList(drawer);
          await expectFits(page, viewport);
          await expectNoRawIds(page, SHELL);
          await expectAxeClean(page, [SHELL]);
          await shoot(page, `shell-${role}-drawer`, viewport, mode);
        }
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`scope switcher ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        const sessions = await sessionsPath(page);
        await page.goto(new URL(`${sessions}?state=ended`, page.url()).href);
        await expectScopeInHeader(page);
        const trigger = page.locator('main [data-scope-switcher]');
        await trigger.click();
        const list = page.getByRole('menu');
        await expect(list).toBeVisible();
        const options = list.locator('[data-scope-option]');
        await expect(options.first()).toHaveText('All projects');
        await expect(list.locator('[data-scope-option="project"][aria-checked="true"]')).toHaveCount(1);
        await expect(list.getByRole('menuitem', { name: 'Every project, in detail' })).toBeVisible();
        await expectFits(page, viewport);
        await expectNoRawIds(page, '[role="menu"]');
        await expectAxeClean(page, ['[role="menu"]']);
        await shoot(page, 'scope-switcher', viewport, mode);
        // A pick keeps the section and the list's filters; All projects leads to the section's form across every project.
        const other = list.locator('[data-scope-option="project"]:not([aria-checked="true"])').first();
        if (await other.count() > 0) {
          await other.click();
          await expect(page).toHaveURL(/\/p\/[^/]+\/sessions\?state=ended$/);
          expect(new URL(page.url()).pathname).not.toBe(sessions);
          await page.locator('main [data-scope-switcher]').click();
        } else await trigger.click();
        await page.getByRole('menu').locator('[data-scope-option="all"]').click();
        await expect(page).toHaveURL(/\/sessions\?state=ended$/);
        await expect(page.locator('main [data-scope-switcher]')).toHaveAttribute('data-scope-switcher', 'all');
        await expect(page.locator('main [data-scope-current]')).toHaveText('All projects');
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });

    test(`a page for the whole server names no project ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/settings', viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(page.locator('[data-scope-deployment]')).toHaveText('Applies to every project.');
        await expect(page.locator('[data-scope-switcher]')).toHaveCount(0);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`search command ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        await page.keyboard.press('ControlOrMeta+k');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        // A page that names no project searches every project.
        const input = dialog.getByRole('searchbox', { name: 'Search every project' });
        await expect(input).toBeFocused();
        // The field runs the dialog's width: no short search box.
        const [field, box] = await Promise.all([input.boundingBox(), dialog.boundingBox()]);
        expect(field!.width).toBeGreaterThan(box!.width - 64);
        if (viewport === 'desktop') expect(box!.width).toBeGreaterThanOrEqual(600);
        await input.fill('parity');
        if (onFixture()) await expect(dialog.locator('a[data-result]').first()).toBeVisible();
        await expectFits(page, viewport);
        await expectNoRawIds(page, '[role="dialog"]');
        await expectAxeClean(page, ['[role="dialog"]']);
        await shoot(page, 'shell-search', viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`account menu ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        await page.getByRole('button', { name: /^Account and appearance for / }).click();
        const menu = page.getByRole('menu');
        await expect(menu).toBeVisible();
        for (const label of ['Light', 'Dark', 'System', 'Compact', 'Normal', 'Comfy']) await expect(menu.getByRole('menuitemradio', { name: label })).toBeVisible();
        await expect(menu.getByRole('menuitem', { name: /Code font/ })).toBeVisible();
        await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
        await expectFits(page, viewport);
        await expectAxeClean(page, ['[role="menu"]']);
        await shoot(page, 'shell-account', viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  for (const { viewport, mode } of SHOT_MATRIX) test(`one uniform search box on every list page ${viewport} ${mode}`, async ({ browser }) => {
    const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode, cookie: screensEnv('ownerCookie') });
    try {
      const sessions = await sessionsPath(page);
      const measured = [];
      const project = sessions.replace(/\/sessions$/, '');
      for (const path of [sessions, `${project}/knowledge`, `${project}/knowledge/plans`, `${project}/work`, '/sessions', '/knowledge', '/knowledge/plans', '/work']) {
        await page.goto(new URL(path, page.url()).href);
        await expect(page.locator('[data-filter-bar] input').first()).toBeVisible();
        measured.push({ page: path, metrics: await filterBarMetrics(page) });
      }
      expectUniformSearch(measured);
      expectQuiet(watch);
    } finally {
      await context.close();
    }
  });

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`/join hands over the command without a sign-in ${viewport} ${mode}`, async ({ browser }) => {
      const key = 'k'.repeat(43);
      const { context, page, watch } = await openPage(browser, { path: `/join#${key}`, viewport, mode });
      try {
        await expect(page.getByRole('heading', { name: 'Connect a machine to Myco' })).toBeInViewport();
        await expect(page.getByText(`myco login ${new URL(page.url()).origin}/join#${key}`)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
        await expectFits(page, viewport);
        await expectAxeClean(page);
        await shoot(page, 'join', viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });

    test(`signed out ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/', viewport, mode });
      try {
        await expect(page.getByRole('heading', { name: 'Sign in to Myco' })).toBeInViewport();
        await expect(page.getByRole('link', { name: 'Sign in with GitHub' })).toBeInViewport();
        await expectFits(page, viewport);
        await expectAxeClean(page);
        await shoot(page, 'signed-out', viewport, mode);
        // The one refusal is the sign-in check itself, which is how the page knows no one is signed in.
        expect(watch.failedRequests.filter((line) => !/GET \S+\/auth\/me: 401$/.test(line)), 'failed requests').toEqual([]);
        expect(watch.consoleErrors.filter((line) => !line.includes('401')), 'console errors').toEqual([]);
      } finally {
        await context.close();
      }
    });

    test(`not a member ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'a sign-in no member is linked to is the fixture\'s');
      const { context, page, watch } = await openPage(browser, { path: '/', viewport, mode, cookie: screensEnv('strangerCookie') });
      try {
        await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
        await expect(page.getByText('Ask an owner or admin to connect it from People & machines, then open the link they send while signed in to this account.', { exact: false })).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Pages' })).toHaveCount(0);
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        await shoot(page, 'not-a-member', viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }
});

const PAGES: ReadonlyArray<{ name: string; path: string; rendered: (page: Page) => Promise<void> }> = [
  {
    name: 'projects',
    path: '/projects',
    rendered: async (page) => {
      const list = page.getByRole('list', { name: 'Projects' });
      if (!onFixture()) { await expect(list.getByRole('listitem').first()).toBeVisible(); return; }
      const names = JSON.parse(screensEnv('projectNames')) as string[];
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) await expect(list.getByText(name, { exact: true })).toBeVisible();
    },
  },
];

test.describe('pages inside the shell', () => {
  for (const { name, path, rendered } of PAGES) for (const { viewport, mode } of SHOT_MATRIX) {
    test(`${name} ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path, viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        await rendered(page);
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        expectQuiet(watch);
        await shoot(page, name, viewport, mode);
      } finally {
        await context.close();
      }
    });
  }
});
