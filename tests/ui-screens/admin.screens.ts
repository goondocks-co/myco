/**
 * The admin pages and My machines, at every viewport (desktop, tablet, phone) in both modes.
 *
 * Signed in as the owner: People & machines, Settings (its first section and
 * Models and keys), a project's settings and Health. Signed in as a member who
 * is not an admin: the read-only People directory, My machines and its Rename
 * dialog. Other admin pages say they are for an admin.
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
import type { SettingsAnswer } from '../../packages/myco-server/ui/src/features/admin/settings/wire.ts';
import { INVITE_CONTROLS } from '../../packages/myco-shared/src/member-protocol.ts';
import {
  expectAxeClean, expectFits, expectNoRawIds, expectQuiet, openPage, shoot, SHOT_MATRIX, type ViewportName,
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
  await page.getByRole('button', { name: 'More for Lin', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Make admin' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Remove' })).toBeVisible();
  await page.keyboard.press('Escape');
}

async function expectMemberPeople(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: INVITE_CONTROLS.page })).toBeInViewport();
  const directory = page.locator('section#people');
  await expect(directory.getByRole('heading', { level: 2, name: 'People' })).toBeVisible();
  await expect(directory.getByRole('list', { name: 'Members' })).toBeVisible();
  await expect(directory.getByText('Admin', { exact: true })).toBeVisible();
  await expect(directory.getByText('Member', { exact: true })).toBeVisible();
  await expect(page.getByTestId('admin-only')).toHaveCount(0);
  await expect(page.getByRole('button', { name: INVITE_CONTROLS.invite })).toHaveCount(0);
  await expect(page.getByRole('button', { name: INVITE_CONTROLS.button })).toHaveCount(0);
  await expect(directory.getByRole('button', { name: /^More for / })).toHaveCount(0);
  for (const section of ['invitations', 'machines', 'runs', 'ownership']) await expect(page.locator(`section#${section}`)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0);
  if (onFixture()) {
    await expect(directory.getByText('Ada', { exact: true })).toBeVisible();
    await expect(directory.getByText('Lin', { exact: true })).toBeVisible();
  }
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
  const response = await page.evaluate(async () => {
    const answer = await fetch('/api/settings');
    return { ok: answer.ok, body: await answer.json() };
  });
  expect(response.ok).toBe(true);
  const settings = response.body as SettingsAnswer;
  for (const row of settings.leaves.filter((row: { retired: boolean }) => row.retired)) {
    const control = page.locator(`[data-setting="${row.leaf}"]`);
    if (row.source === 'derived') {
      await expect(control).toBeVisible();
      await expect(control.locator('input, textarea, button')).toHaveCount(0);
    } else await expect(control).toHaveCount(0);
  }
  const digest = settings.leaves.find((row: { leaf: string }) => row.leaf === 'cortex.digest.tier');
  expect(digest).toBeUndefined();
}

async function expectModels(page: Page): Promise<void> {
  const tabs = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(tabs.getByRole('link', { name: 'Models and keys' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Claude Code tiers' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Embedding provider' })).toBeVisible();
  await expect(page.getByLabel('Provider', { exact: true })).toHaveCount(0);
  await expect(page.locator('#credentials')).toBeVisible();
  if (!onFixture()) return;
  const overrides = page.locator('[data-setting="agent.tasks"]');
  await expect(overrides).toContainText('cortex-instructions: this task no longer exists');
  await expect(overrides.getByRole('button', { name: 'Clear the stored value for Task overrides' })).toBeVisible();
  await expect(overrides.getByRole('button', { name: 'Remove entries that no longer apply' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Container smoke test' })).toHaveCount(0);
  await expect(overrides.locator('[role="alert"]')).toHaveCount(0);
  // The switch to nomic-embed-text under way: its progress, what search uses meanwhile, and the admin's way out.
  const rebuild = page.locator('[data-embedding-switch="building"]');
  await expect(rebuild).toContainText('Rebuilding search with nomic-embed-text (768 dimensions)');
  await expect(rebuild).toContainText('Search keeps using bge-m3 until every source is done');
  await expect(rebuild.getByRole('button', { name: 'Cancel the switch' })).toBeVisible();
}

/** A section of Settings past the first: its tab is the current one, and its first group is on the page. */
async function expectSection(page: Page, tab: string, group: string): Promise<void> {
  const tabs = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(tabs.getByRole('link', { name: tab })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: group }).first()).toBeVisible();
}

/** Capture and retention, with whether a repository no project holds yet gets a project of its own. */
async function expectCaptureSettings(page: Page): Promise<void> {
  await expectSection(page, 'Capture and retention', 'Importing past sessions');
  await expect(page.getByRole('heading', { name: 'New repositories' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Create a project for it' })).toBeVisible();
  if (onFixture()) {
    const window = page.locator('[data-setting="import.window_days"]');
    await expect(window).toContainText('Myco uses 30 days');
    await expect(window.locator('pre')).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Stored value', exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Clear the stored value for Reach back at most' })).toBeVisible();
    await expect(window.locator('[role="alert"]')).toHaveCount(0);
  }
}

async function expectProjectSettings(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Project settings' })).toBeInViewport();
  await expect(page.getByText(name).first()).toBeInViewport();
  for (const id of ['capabilities', 'repository', 'access-keys', 'release-tracking']) await expect(page.locator(`section#${id}`)).toBeVisible();
  await expect(page.locator('section#capabilities').getByRole('switch').first()).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Skills', exact: true })).toHaveCount(0);
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
  await expect(page.locator('[data-health-search-rebuild]')).toContainText('Rebuilding search with nomic-embed-text');
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
  { name: 'settings', path: () => '/settings', rendered: (page, viewport) => expectSettings(page, viewport) },
  { name: 'settings-models', path: () => '/settings/models', rendered: (page) => expectModels(page) },
  { name: 'settings-capture', path: () => '/settings/capture', rendered: (page) => expectCaptureSettings(page) },
  { name: 'settings-backups', path: () => '/settings/backups', rendered: (page) => expectSection(page, 'Backups', 'Store checks') },
  { name: 'settings-access', path: () => '/settings/access', rendered: (page) => expectSection(page, 'Sign-in and access', 'Who can sign in') },
  { name: 'project-settings', path: () => `/p/${fixtureProject().projectId}/settings`, rendered: (page) => expectProjectSettings(page, fixtureProject().name) },
  { name: 'health', path: () => '/status/health', rendered: (page) => expectHealth(page) },
];
const OWNER_PAGES = [{ name: 'people', path: () => '/people', rendered: (page: Page) => expectPeople(page) }, ...ADMIN_PAGES] as const;

test.describe('admin pages, as the owner', () => {
  for (const { name, path, rendered } of OWNER_PAGES) for (const { viewport, mode } of SHOT_MATRIX) {
    test(`${name} admin ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: path(), viewport, mode, cookie: screensEnv('ownerCookie') });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        await rendered(page, viewport);
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
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
    test(`people directory member ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/people', viewport, mode, cookie: screensEnv('memberCookie') });
      try {
        await expectMemberPeople(page);
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        expectQuiet(watch);
        await shoot(page, 'member-people', viewport, mode);
      } finally {
        await context.close();
      }
    });
  }

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`my machines member ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/me/machines', viewport, mode, cookie: screensEnv('memberCookie') });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        await expectMyMachines(page);
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        expectQuiet(watch);
        await shoot(page, 'member-my-machines', viewport, mode);
      } finally {
        await context.close();
      }
    });
  }

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`rename a machine member ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the fixture names the member\'s machine');
      const { context, page, watch } = await openPage(browser, { path: '/me/machines', viewport, mode, cookie: screensEnv('memberCookie') });
      try {
        await page.getByRole('button', { name: 'More for Lin’s build box' }).click();
        await page.getByRole('menuitem', { name: 'Rename' }).click();
        const dialog = page.getByRole('dialog', { name: 'Rename Lin’s build box' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('textbox', { name: 'Machine name' })).toHaveValue('Lin’s build box');
        await expect(dialog.getByRole('button', { name: 'Rename' })).toBeDisabled();
        await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeInViewport();
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        expectQuiet(watch);
        await shoot(page, 'member-rename-machine', viewport, mode);
      } finally {
        await context.close();
      }
    });
  }

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`machine settings member ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the fixture names the member\'s machine');
      const { context, page, watch } = await openPage(browser, { path: '/me/machines', viewport, mode, cookie: screensEnv('memberCookie') });
      try {
        await page.getByRole('button', { name: 'More for Lin’s build box' }).click();
        await page.getByRole('menuitem', { name: 'Its settings' }).click();
        const dialog = page.getByRole('dialog', { name: 'Settings for Lin’s build box' });
        await expect(dialog).toBeVisible();
        const captured = dialog.getByRole('region', { name: 'Folders it captures' });
        await expect(captured.getByRole('list', { name: 'Folders it captures' })).toHaveText('~/Repos');
        await expect(captured.getByRole('textbox', { name: 'Folder to capture' })).toBeVisible();
        await expect(dialog.getByRole('region', { name: 'Extra plan folders' })).toBeVisible();
        const connections = dialog.getByRole('region', { name: 'Connected repositories' });
        await expect(connections).toContainText('1 repository is configured');
        await expect(connections.getByRole('button', { name: 'Remove entries that no longer apply' })).toBeVisible();
        await expect(connections.locator('pre')).toHaveCount(0);
        await connections.getByRole('button', { name: 'At next session start' }).click();
        await expect(connections.locator('pre')).toContainText(fixtureProject().projectId);
        await expect(connections.locator('pre')).not.toContainText('stale');
        await connections.getByRole('button', { name: 'At next session start' }).click();
        await expect(connections).toContainText('Myco doesn’t report when it applied.');
        await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        expectQuiet(watch);
        await shoot(page, 'member-machine-settings', viewport, mode);
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
