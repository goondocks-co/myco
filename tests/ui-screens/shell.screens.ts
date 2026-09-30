/**
 * The dashboard shell, signed in as the owner and as a member who is not an
 * admin, at both viewports in both modes.
 *
 * The shell is the nav column on a desktop, and the header, bottom bar and nav
 * drawer on a phone. Each check opens a project's Sessions page inside it and
 * asserts the shell's key content (the pages, the project filter listing the
 * fixture's projects, the admin foot for the owner only, search and the
 * account), that nothing scrolls sideways, that no raw id reaches the shell's
 * text, and that axe-core finds nothing serious or critical in the shell. The
 * pages inside keep their own checks: they are rebuilt, and held to account,
 * in later phases.
 *
 * The Projects and Settings pages P1a touched are still shot inside the shell.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  expectAxeClean, expectNoHorizontalOverflow, expectNoRawIds, expectQuiet, expectUniformSearch, filterBarMetrics, openPage, shoot, SHOT_MATRIX,
} from './checks.ts';
import { SCREENS_ENV, screensEnv } from './env.ts';

const onFixture = (): boolean => process.env[SCREENS_ENV.fixture] === '1';

/** Every part of the shell, and nothing of the page inside it. */
const SHELL = '[data-shell]';

const ROLES = [
  { role: 'admin', cookie: 'ownerCookie', name: 'Ada' },
  { role: 'member', cookie: 'memberCookie', name: 'Lin' },
] as const;

const ADMIN_PAGES = ['Members', 'Settings', 'Status', 'Measures', 'Operations'];

/** The project the checks open: the fixture's first, or on a real deployment the first the project filter lists. */
function fixtureProject(): { projectId: string; name: string } | null {
  if (!onFixture()) return null;
  const projects = JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>;
  expect(projects.length).toBeGreaterThan(0);
  return projects[0]!;
}

async function sessionsPath(page: Page): Promise<string> {
  const project = fixtureProject();
  if (project !== null) return `/p/${encodeURIComponent(project.projectId)}/sessions`;
  const first = page.locator('[data-project-filter-item]').first();
  const href = await first.getAttribute('href');
  if (href === null) throw new Error('the project filter lists no project');
  return `${href}/sessions`;
}

/** The fixture's project names, each listed in the project filter. */
async function expectProjectsListed(page: Page, scope: ReturnType<Page['locator']>): Promise<void> {
  const filter = scope.getByRole('navigation', { name: 'Projects' });
  await expect(filter).toBeVisible();
  if (!onFixture()) { await expect(filter.locator('[data-project-filter-item]').first()).toBeVisible(); return; }
  const names = JSON.parse(screensEnv('projectNames')) as string[];
  for (const name of names) await expect(filter.getByText(name, { exact: true })).toBeVisible();
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
          const pages = nav.getByRole('navigation', { name: 'Pages' });
          await expect(pages.getByRole('link', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page');
          await expect(pages.getByRole('link', { name: 'Access' })).toHaveCount(role === 'admin' ? 1 : 0);
          await expectProjectsListed(page, nav);
          await expect(nav.locator('[data-project-filter-item][aria-current="true"]')).toHaveCount(1);
          await expect(nav.getByRole('button', { name: /Search/ })).toBeVisible();
          if (onFixture()) await expect(nav.getByRole('button', { name: `Account and appearance for ${name}` })).toBeVisible();
          const admin = nav.getByRole('navigation', { name: 'Admin' });
          if (role === 'admin') for (const label of ADMIN_PAGES) await expect(admin.getByRole('link', { name: label })).toBeVisible();
          else await expect(admin).toHaveCount(0);
        } else {
          await expect(page.getByRole('complementary', { name: 'Navigation' })).toHaveCount(0);
          await expect(page.getByRole('banner')).toContainText('Sessions');
          const bar = page.getByRole('navigation', { name: 'Main pages' });
          for (const label of ['Overview', 'Sessions', 'Spores']) await expect(bar.getByRole('link', { name: label })).toBeVisible();
          await expect(bar.getByRole('link', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page');
          await expect(page.getByRole('banner').getByRole('button', { name: 'Search' })).toBeVisible();
        }

        await page.waitForLoadState('networkidle');
        await expectNoHorizontalOverflow(page);
        await expectNoRawIds(page, SHELL);
        await expectAxeClean(page, [SHELL]);
        await shoot(page, `shell-${role}`, viewport, mode);

        if (viewport === 'phone') {
          await page.getByRole('navigation', { name: 'Main pages' }).getByRole('button', { name: 'More' }).click();
          const drawer = page.getByRole('dialog', { name: 'Navigation' });
          await expect(drawer).toBeVisible();
          await expectProjectsListed(page, drawer);
          await expect(drawer.getByRole('navigation', { name: 'Admin' })).toHaveCount(role === 'admin' ? 1 : 0);
          await expectNoHorizontalOverflow(page);
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
    test(`search command ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/projects', viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        await page.keyboard.press('ControlOrMeta+k');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        const input = dialog.getByRole('searchbox', { name: 'Search this project' });
        await expect(input).toBeFocused();
        // The field runs the dialog's width: no short search box.
        const [field, box] = await Promise.all([input.boundingBox(), dialog.boundingBox()]);
        expect(field!.width).toBeGreaterThan(box!.width - 64);
        if (viewport === 'desktop') expect(box!.width).toBeGreaterThanOrEqual(600);
        await input.fill('parity');
        if (onFixture()) await expect(dialog.getByRole('list', { name: 'Search results' }).getByRole('link').first()).toBeVisible();
        await expectNoHorizontalOverflow(page);
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
        await expectNoHorizontalOverflow(page);
        await expectAxeClean(page, ['[role="menu"]']);
        await shoot(page, 'shell-account', viewport, mode);
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }

  test('one uniform search box on every list page', async ({ browser }) => {
    const { context, page, watch } = await openPage(browser, { path: '/projects', viewport: 'desktop', mode: 'dark', cookie: screensEnv('ownerCookie') });
    try {
      const sessions = await sessionsPath(page);
      const measured = [];
      for (const path of [sessions, sessions.replace(/\/sessions$/, '/spores')]) {
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

  test('/join hands over the command without a sign-in', async ({ browser }) => {
    const key = 'k'.repeat(43);
    const { context, page, watch } = await openPage(browser, { path: `/join#${key}`, viewport: 'phone', mode: 'dark' });
    try {
      await expect(page.getByRole('heading', { name: 'Connect a machine to Myco' })).toBeVisible();
      await expect(page.getByText(`myco login ${new URL(page.url()).origin}/join#${key}`)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectAxeClean(page);
      await shoot(page, 'join', 'phone', 'dark');
      expectQuiet(watch);
    } finally {
      await context.close();
    }
  });
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
  {
    name: 'settings',
    path: '/settings',
    rendered: async (page) => {
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
      await expect(page.getByRole('switch').first()).toBeVisible();
      await expect(page.getByLabel('Provider').first()).toBeVisible();
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
        await expectNoHorizontalOverflow(page);
        expectQuiet(watch);
        await shoot(page, name, viewport, mode);
      } finally {
        await context.close();
      }
    });
  }
});
