/**
 * The admin pages and each machine's page, at every viewport (desktop, tablet, phone) in both modes.
 *
 * Signed in as the owner: every Settings section, a machine's page for each
 * kind of machine, a project's settings and Health. Signed in as a member who
 * is not an admin: Settings › People and machines read-only, their machine's
 * page and its Rename and folder dialogs. Other admin pages say they are for an admin.
 *
 * On the fixture the owner has two machines (one named, one whose runtime gave
 * no name), the member one, which is also a runner; two more runners are
 * machines of their own (one online, one quiet for hours) and one is removed;
 * two invitations are open; one project has an access key about to expire; and
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
import { MACHINE_IDS } from './machine-ids.ts';

const machinePage = (id: string): string => `/settings/people/machines/${id}`;

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

async function expectMemberPeople(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeInViewport();
  const tabs = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(tabs.getByRole('link')).toHaveText(['People and machines']);
  const directory = page.locator('section#sign-in');
  await expect(directory.getByRole('list', { name: 'Members' })).toBeVisible();
  await expect(directory).toContainText('· Owner');
  await expect(directory).toContainText('· Member');
  await expect(page.getByTestId('admin-only')).toHaveCount(0);
  await expect(page.getByRole('button', { name: INVITE_CONTROLS.invite })).toHaveCount(0);
  await expect(page.getByRole('button', { name: INVITE_CONTROLS.button })).toHaveCount(0);
  await expect(directory.getByRole('button', { name: 'Manage' })).toHaveCount(0);
  for (const section of ['invitations', 'runs']) await expect(page.locator(`section#${section}`)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your machines' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Admin' })).toHaveCount(0);
  if (onFixture()) {
    await expect(page.getByRole('group', { name: 'Machines' }).getByText('Lin’s build box', { exact: true })).toBeVisible();
    await expect(page.getByText('Ada’s studio Mac', { exact: true })).toHaveCount(0);
  }
}

/** A machine's page leads with its verdict and its name, and answers each question in order. */
async function expectMachine(page: Page, name: string, verdict: string | RegExp, sections: readonly string[]): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name })).toBeInViewport();
  await expect(page.locator('[data-machine-verdict]')).toBeInViewport();
  await expect(page.locator('[data-machine-verdict] p').first()).toHaveText(verdict);
  await expect(page.locator('main section h2')).toHaveText([...sections]);
  await expect(page.locator('body')).not.toContainText(/ada_|lin_|homelab_|closet_|retired_/);
}

async function expectSettings(page: Page, viewport: ViewportName): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeInViewport();
  const tabs = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(tabs).toBeInViewport();
  await expect(tabs.getByRole('link', { name: 'Myco’s work' })).toHaveAttribute('aria-current', 'page');
  // The sections never wrap: on a phone the strip scrolls in its own box, and fades at the edge where more wait.
  await expectOneLine(page, 'nav[aria-label="Settings sections"] a');
  await expect(page.locator('[data-more-tabs]')).toHaveCount(viewport === 'phone' ? 1 : 0);
  await expect(page.getByRole('switch', { name: 'Work on its own' })).toBeVisible();
  await expect(page.getByLabel('Daily budget in dollars')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Where the work runs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a runner' })).toBeVisible();
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
}

/** Opens one fold under Advanced by its anchor. */
async function openFold(page: Page, id: string): Promise<void> {
  await page.locator(`[data-fold="${id}"] button[aria-expanded="false"]`).first().click();
}

async function expectModels(page: Page): Promise<void> {
  const tabs = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(tabs.getByRole('link', { name: 'Models', exact: true })).toHaveAttribute('aria-current', 'page');
  for (const heading of ['Quick jobs', 'Work that needs an agent', 'Search']) await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: /^Answered by(?::|$)/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check now' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Advanced › Model sizes' })).toBeVisible();
  await expect(page.getByLabel('Provider', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: /^Embedding\ provider(?::|$)/ })).toBeVisible();
  if (!onFixture()) return;
  // The switch to nomic-embed-text under way: its progress, what search uses meanwhile, and the admin's way out.
  const rebuild = page.locator('[data-embedding-switch="building"]');
  await expect(rebuild).toContainText('Rebuilding search with nomic-embed-text (768 dimensions)');
  await expect(rebuild).toContainText('Search keeps using bge-m3 until every source is done');
  await expect(rebuild.getByRole('button', { name: 'Cancel the switch' })).toBeVisible();
}

/** Connections: GitHub as a short row leading to Repositories, and the way to add another. */
async function expectConnections(page: Page): Promise<void> {
  await expectSection(page, 'Connections', 'Everything Myco is connected to');
  const github = page.locator('[data-connection="github"]');
  await expect(github).toBeVisible();
  await expect(github.getByRole('link', { name: 'Repositories' })).toBeVisible();
  await expect(page.locator('[data-step]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a connection' })).toBeVisible();
}

/** People and machines: who can sign in, open invitations, every machine leading to its page, and Myco's run sign-ins. */
async function expectPeopleSection(page: Page): Promise<void> {
  await expectSection(page, 'People and machines', 'Who can sign in?');
  for (const name of ['Open invitations', 'Machines', 'Myco’s run sign-ins']) await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  await expect(page.getByRole('button', { name: INVITE_CONTROLS.invite })).toBeVisible();
  await expect(page.getByRole('button', { name: INVITE_CONTROLS.button })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Advanced › Owner actions' })).toBeVisible();
  if (!onFixture()) return;
  const machines = page.getByRole('group', { name: 'Machines' });
  for (const name of ['Ada’s studio Mac', 'Lin’s build box', 'A machine', 'homelab-mini', 'closet-pc']) await expect(machines.getByText(name, { exact: true })).toBeVisible();
  await expect(machines.locator(`#machine-${MACHINE_IDS.buildbox}`)).toContainText('also a runner');
  await expect(machines.locator(`#machine-${MACHINE_IDS.buildbox} a`)).toHaveAttribute('href', machinePage(MACHINE_IDS.buildbox));
  await expect(page.locator('section#invitations li')).toHaveCount(2);
  await page.locator('section#sign-in li', { hasText: 'Lin' }).getByRole('button', { name: 'Manage' }).click();
  await expect(page.getByRole('menuitem', { name: 'Make admin' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Remove' })).toBeVisible();
  await page.keyboard.press('Escape');
}

/** Repositories: the GitHub App with its setup checklist open while a step remains, then every project's repository. */
async function expectRepositories(page: Page): Promise<void> {
  await expectSection(page, 'Repositories', 'What can Myco read?');
  await expect(page.getByRole('heading', { name: 'Projects and their repositories' })).toBeVisible();
  await expect(page.locator('[data-project-repository]').first()).toBeVisible();
  await expect(page.locator('[data-setup-headline]')).toHaveText('Repository access is not set up yet: 5 of 6 steps remain. Next: Set the App’s repository permissions.');
  await expect(page.locator('[data-step="key"] code')).toHaveText(['myco server uninstall --target local', /^myco server github-app --target local --url http:\/\/127\.0\.0\.1:\d+ --private-key-file <downloaded\.pem>$/, 'myco server install --target local']);
}

/** A section of Settings past the first: its tab is the current one, and its first group is on the page. */
async function expectSection(page: Page, tab: string, group: string): Promise<void> {
  const tabs = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(tabs.getByRole('link', { name: tab })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: group }).first()).toBeVisible();
}

/** Advanced: seven folds, each opened where a link points into it; New repositories and past sessions and Model sizes opened. */
async function expectAdvanced(page: Page): Promise<void> {
  // An older Capture and retention address lands on its group under Advanced, opened.
  await expect(page).toHaveURL(/\/settings\/advanced#import$/);
  // Opened directly, the last tab is scrolled into the strip's view, even on a phone.
  const strip = page.getByRole('navigation', { name: 'Settings sections' });
  const [box, tab] = await Promise.all([strip.boundingBox(), strip.getByRole('link', { name: 'Advanced' }).boundingBox()]);
  expect(tab!.x, 'the open tab starts inside the strip').toBeGreaterThanOrEqual(box!.x - 1);
  expect(tab!.x + tab!.width, 'the open tab ends inside the strip').toBeLessThanOrEqual(box!.x + box!.width + 1);
  await expectSection(page, 'Advanced', 'Advanced');
  await expect(page.locator('[data-fold]')).toHaveCount(7);
  await expect(page.getByRole('heading', { name: 'Importing past sessions' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Create a project for it' })).toBeVisible();
  // A stored switch keeps its name readable beside it and its reset inside the card, at every width.
  const creation = page.locator('[data-setting="capture.auto_create_projects"]');
  const named = await creation.getByText('Create a project for it', { exact: true }).boundingBox();
  const card = await creation.boundingBox();
  expect(named!.width, 'the switch’s name has room').toBeGreaterThan(100);
  if (onFixture()) {
    const clear = await creation.getByRole('button', { name: 'Clear the stored value for Create a project for it' }).boundingBox();
    expect(clear!.x + clear!.width, 'the reset sits inside the row').toBeLessThanOrEqual(card!.x + card!.width);
    expect(clear!.y, 'the reset sits under the name').toBeGreaterThan(named!.y);
  }
  const titling = page.getByRole('switch', { name: 'Title imported sessions' });
  await expect(titling).toBeVisible();
  if (onFixture()) await expect(titling).toBeChecked();
  await openFold(page, 'sessions-given');
  // With nothing stored, a switch the server treats as on reads on.
  if (onFixture()) await expect(page.getByRole('switch', { name: 'Instructions at session start' })).toBeChecked();
  if (onFixture()) {
    await openFold(page, 'model-sizes');
    const overrides = page.locator('[data-setting="agent.tasks"]');
    await expect(overrides).toContainText('cortex-instructions: this task no longer exists');
    await expect(overrides.getByRole('button', { name: 'Clear the stored value for Task overrides' })).toBeVisible();
    await expect(overrides.getByRole('button', { name: 'Remove entries that no longer apply' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Container smoke test' })).toHaveCount(0);
    await expect(overrides.locator('[role="alert"]')).toHaveCount(0);
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
  if (onFixture()) await expect(page.locator('section#access-keys')).toContainText('CI deploys');
}

async function expectHealth(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Health' })).toBeInViewport();
  for (const id of ['needs-you', 'status', 'backups', 'upkeep', 'measures']) await expect(page.locator(`section#${id}`)).toBeVisible();
  await expect(page.locator('section#needs-you')).toBeInViewport();
  if (!onFixture()) return;
  await expect(page.locator('section#needs-you')).toContainText('CI deploys');
  // What Myco is doing, and the machines that do it, are on Myco's work.
  await expect(page.locator('section#workers')).toHaveCount(0);
  await expect(page.locator('section#status')).toContainText('Myco');
  await expect(page.locator('[data-health-search-rebuild]')).toContainText('Rebuilding search with nomic-embed-text');
}

const ADMIN_PAGES: ReadonlyArray<{ name: string; path: () => string; rendered: (page: Page, viewport: ViewportName) => Promise<void> }> = [
  { name: 'settings', path: () => '/settings', rendered: (page, viewport) => expectSettings(page, viewport) },
  { name: 'settings-models', path: () => '/settings/models', rendered: (page) => expectModels(page) },
  { name: 'settings-connections', path: () => '/settings/connections', rendered: (page) => expectConnections(page) },
  { name: 'settings-people', path: () => '/settings/people', rendered: (page) => expectPeopleSection(page) },
  { name: 'settings-repositories', path: () => '/settings/repositories', rendered: (page) => expectRepositories(page) },
  { name: 'settings-advanced', path: () => '/settings/capture#import', rendered: (page) => expectAdvanced(page) },
  { name: 'project-settings', path: () => `/p/${fixtureProject().projectId}/settings`, rendered: (page) => expectProjectSettings(page, fixtureProject().name) },
  { name: 'health', path: () => '/status/health', rendered: (page) => expectHealth(page) },
];
const WORK = 'Does it do Myco’s work?';
const CAPTURE = 'What does it capture?';
const CURRENT = 'How does it stay current?';
const REMOVE = 'Remove this machine';
/** A machine's page for each kind of machine the fixture holds, opened by the owner. */
const MACHINE_PAGES: typeof ADMIN_PAGES = onFixture() ? [
  { name: 'machine-runner', path: () => machinePage(MACHINE_IDS.homelab), rendered: (page) => expectMachine(page, 'homelab-mini', 'Working', [WORK, CAPTURE, CURRENT, REMOVE]) },
  { name: 'machine-capturing', path: () => machinePage(MACHINE_IDS.studio), rendered: (page) => expectMachine(page, 'Ada’s studio Mac', 'Capturing', [CAPTURE, WORK, CURRENT, REMOVE]) },
  { name: 'machine-both', path: () => machinePage(MACHINE_IDS.buildbox), rendered: (page) => expectMachine(page, 'Lin’s build box', 'Working', [WORK, CAPTURE, CURRENT, REMOVE]) },
  { name: 'machine-offline', path: () => machinePage(MACHINE_IDS.closet), rendered: (page) => expectMachine(page, 'closet-pc', 'Offline', [WORK, CAPTURE, CURRENT, REMOVE]) },
  { name: 'machine-removed', path: () => machinePage(MACHINE_IDS.retired), rendered: (page) => expectMachine(page, 'old-laptop', 'Removed', [CAPTURE, WORK]) },
] : [];
const OWNER_PAGES = [...ADMIN_PAGES, ...MACHINE_PAGES] as const;

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

test.describe('People and machines and the admin pages, as a member', () => {
  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`people directory member ${viewport} ${mode}`, async ({ browser }) => {
      const { context, page, watch } = await openPage(browser, { path: '/settings/people', viewport, mode, cookie: screensEnv('memberCookie') });
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
    test(`own machine member ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the fixture names the member\'s machine');
      const { context, page, watch } = await openPage(browser, { path: machinePage(MACHINE_IDS.buildbox), viewport, mode, cookie: screensEnv('memberCookie') });
      try {
        await expect(page.locator('main')).toHaveCount(1);
        await expectMachine(page, 'Lin’s build box', 'Working', [WORK, CAPTURE, CURRENT, REMOVE]);
        await expect(page.getByRole('switch', { name: 'Runs Myco’s work' })).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Change folders' })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await expectFits(page, viewport);
        await expectNoRawIds(page);
        await expectAxeClean(page);
        expectQuiet(watch);
        await shoot(page, 'member-own-machine', viewport, mode);
      } finally {
        await context.close();
      }
    });
  }

  for (const { viewport, mode } of SHOT_MATRIX) {
    test(`rename a machine member ${viewport} ${mode}`, async ({ browser }) => {
      test.skip(!onFixture(), 'the fixture names the member\'s machine');
      const { context, page, watch } = await openPage(browser, { path: machinePage(MACHINE_IDS.buildbox), viewport, mode, cookie: screensEnv('memberCookie') });
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
      const { context, page, watch } = await openPage(browser, { path: machinePage(MACHINE_IDS.buildbox), viewport, mode, cookie: screensEnv('memberCookie') });
      try {
        await page.getByRole('button', { name: 'Change folders' }).click();
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

  for (const { name, path } of ADMIN_PAGES.filter((entry) => entry.name !== 'settings-people')) {
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
    ['/access', /\/settings\/people$/],
    ['/me/machines', /\/settings\/people#machines$/],
  ] as const) {
    test(`${from} leads to its new page`, async ({ browser }) => {
      const { context, page } = await openPage(browser, { path: from, destination: to, viewport: 'desktop', mode: 'dark', cookie: screensEnv('ownerCookie') });
      try {
        await expect(page).toHaveURL(to);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      } finally {
        await context.close();
      }
    });
  }
});
