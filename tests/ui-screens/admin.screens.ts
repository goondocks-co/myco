/**
 * The admin pages and My machines, at both viewports in both modes.
 *
 * Signed in as the owner: People & machines, Settings (its first section and
 * Models and keys), a project's settings and Health. Signed in as a member who
 * is not an admin: My machines, and each admin page, which says it is for an
 * admin and asks the server nothing an admin route answers.
 *
 * On the fixture the owner has two machines (one named, one whose runtime gave
 * no name), the member one; two invitations are open; the owner's machine has
 * checked in as a worker; one project has an access key about to expire; and
 * imported sessions are titled. Each check asserts that content, that the
 * page's key parts start on screen, that nothing scrolls sideways, that no raw
 * id reaches the page's text, that axe-core finds nothing serious or critical,
 * and that the page made no failed request.
 */
import { expect, test, type Page } from '@playwright/test';
import { INVITE_CONTROLS } from '../../packages/myco-shared/src/member-protocol.ts';
import {
  expectAxeClean, expectNoHorizontalOverflow, expectNoRawIds, expectQuiet, openPage, shoot, SHOT_MATRIX, type ViewportName,
} from './checks.ts';
import { SCREENS_ENV, screensEnv } from './env.ts';

const onFixture = (): boolean => process.env[SCREENS_ENV.fixture] === '1';

function fixtureProject(): { projectId: string; name: string } {
  const projects = JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>;
  return projects[0]!;
}

/** Every link or tab of a strip sits on one line: the same top, within a pixel. */
async function expectOneLine(page: Page, selector: string): Promise<void> {
  const tops = await page.locator(selector).evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
  expect(tops.length).toBeGreaterThan(1);
  expect(new Set(tops).size, `${selector} on one line`).toBe(1);
}

async function expectPeople(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: INVITE_CONTROLS.page })).toBeInViewport();
  await expect(page.getByRole('button', { name: INVITE_CONTROLS.invite })).toBeInViewport();
  await expect(page.getByRole('button', { name: INVITE_CONTROLS.button })).toBeInViewport();
  for (const name of ['People', 'Invitations', 'Machines']) await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  if (!onFixture()) return;
  const machines = page.locator('section#machines');
  await expect(machines.getByText('Ada’s studio Mac', { exact: true })).toBeVisible();
  await expect(machines.getByText('Lin’s build box', { exact: true })).toBeVisible();
  // The runtime that gave no name reads as a stand-in, never as its machine's id.
  await expect(machines.getByText('A machine', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('ada_7c1e9f02');
  await expect(page.locator('section#people').getByText('Ada', { exact: true })).toBeVisible();
  await expect(page.locator('section#invitations').locator('li')).toHaveCount(2);
}

async function expectSettings(page: Page, viewport: ViewportName): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeInViewport();
  const tabs = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(tabs).toBeInViewport();
  await expect(tabs.getByRole('link', { name: 'Myco’s work' })).toHaveAttribute('aria-current', 'page');
  // The five sections never wrap: on a phone the strip scrolls in its own box, and fades at the edge where more wait.
  await expectOneLine(page, 'nav[aria-label="Settings sections"] a');
  await expect(page.locator('[data-more-tabs]')).toHaveCount(viewport === 'phone' ? 1 : 0);
  await expect(page.getByRole('switch').first()).toBeVisible();
  const titling = page.getByRole('switch', { name: 'Title imported sessions' });
  await expect(titling).toBeVisible();
  if (onFixture()) await expect(titling).toBeChecked();
  // With nothing stored, a switch the server treats as on reads on.
  if (onFixture()) await expect(page.getByRole('switch', { name: 'Instructions at session start' })).toBeChecked();
  // A setting nothing reads any more is not offered.
  await expect(page.locator('[data-setting="agent.event_tasks_enabled"]')).toHaveCount(0);
}

async function expectModels(page: Page): Promise<void> {
  const tabs = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(tabs.getByRole('link', { name: 'Models and keys' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Provider').first()).toBeVisible();
  await expect(page.locator('#credentials')).toBeVisible();
}

async function expectProjectSettings(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Project settings' })).toBeInViewport();
  await expect(page.getByText(name).first()).toBeInViewport();
  for (const id of ['capabilities', 'repository', 'access-keys', 'release-tracking']) await expect(page.locator(`section#${id}`)).toBeVisible();
  await expect(page.locator('section#capabilities').getByRole('switch').first()).toBeVisible();
  if (onFixture()) await expect(page.locator('section#access-keys')).toContainText('CI deploys');
}

async function expectHealth(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Health' })).toBeInViewport();
  for (const id of ['needs-you', 'status', 'workers', 'backups', 'upkeep', 'measures']) await expect(page.locator(`section#${id}`)).toBeVisible();
  await expect(page.locator('section#needs-you')).toBeInViewport();
  if (!onFixture()) return;
  await expect(page.locator('section#needs-you')).toContainText('CI deploys');
  // The worker is named by its machine, never by its credential or machine id.
  await expect(page.locator('section#workers')).toContainText('Ada’s studio Mac');
  await expect(page.locator('section#status')).toContainText('Myco');
}

async function expectMyMachines(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'My machines' })).toBeInViewport();
  if (!onFixture()) return;
  await expect(page.getByText('Lin’s build box', { exact: true })).toBeInViewport();
  await expect(page.getByText('Ada’s studio Mac', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: INVITE_CONTROLS.button })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0);
}

const ADMIN_PAGES: ReadonlyArray<{ name: string; path: () => string; rendered: (page: Page, viewport: ViewportName) => Promise<void> }> = [
  { name: 'people', path: () => '/people', rendered: (page) => expectPeople(page) },
  { name: 'settings', path: () => '/settings', rendered: (page, viewport) => expectSettings(page, viewport) },
  { name: 'settings-models', path: () => '/settings/models', rendered: (page) => expectModels(page) },
  { name: 'project-settings', path: () => `/p/${fixtureProject().projectId}/settings`, rendered: (page) => expectProjectSettings(page, fixtureProject().name) },
  { name: 'health', path: () => '/status/health', rendered: (page) => expectHealth(page) },
];

test.describe('admin pages, as the owner', () => {
  for (const { name, path, rendered } of ADMIN_PAGES) for (const { viewport, mode } of SHOT_MATRIX) {
    test(`${name} admin ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: path(), viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        await rendered(page, viewport);
        await page.waitForLoadState('networkidle');
        await expectNoHorizontalOverflow(page);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        if (name === 'health' && onFixture()) {
          // A self-hosted server runs no automatic recovery and says so in its answer, which the page reads as unavailable
          // without any request failing.
          await expect(page.getByTestId('recovery-unavailable')).toBeVisible();
        }
        expectQuiet(watch);
        await shoot(page, `admin-${name}`, viewport, mode);
      } finally {
        await context.close();
      }
    });
  }
});

test.describe('My machines and the admin pages, as a member', () => {
  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`my machines member ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/me/machines', viewport, mode, cookie: screensEnv('memberCookie') });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        await expectMyMachines(page);
        await page.waitForLoadState('networkidle');
        await expectNoHorizontalOverflow(page);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        expectQuiet(watch);
        await shoot(page, 'member-my-machines', viewport, mode);
      } finally {
        await context.close();
      }
    });
  }

  for (const { name, path } of ADMIN_PAGES) {
    test(`${name} member says it is for an admin`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: path(), viewport: 'desktop', mode: 'dark', cookie: screensEnv('memberCookie') });
      try {
        await expect(page.getByTestId('admin-only')).toBeInViewport();
        await expect(page.getByRole('switch')).toHaveCount(0);
        await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0);
        await page.waitForLoadState('networkidle');
        await expectNoRawIds(page);
        // A refused admin read would show here as a failed request.
        expectQuiet(watch);
      } finally {
        await context.close();
      }
    });
  }
});

test.describe('old admin addresses', () => {
  for (const [from, to] of [
    ['/status', /\/status\/health#status$/],
    ['/measures?window=7', /\/status\/health\?window=7#measures$/],
    ['/operations', /\/status\/health#upkeep$/],
    ['/access', /\/people$/],
  ] as const) {
    test(`${from} leads to its new page`, async ({ browser }) => {
      const { context, page } = await openPage(browser, { path: from, viewport: 'desktop', mode: 'dark', cookie: screensEnv('ownerCookie') });
      try {
        await expect(page).toHaveURL(to);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      } finally {
        await context.close();
      }
    });
  }
});
