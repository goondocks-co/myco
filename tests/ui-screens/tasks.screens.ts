import { expect, test } from '@playwright/test';
import { expectAxeClean, expectFits, expectNoRawIds, expectQuiet, openPage, shoot, SHOT_MATRIX } from './checks.ts';
import { screensEnv } from './env.ts';
import type { TasksAnswer } from '../../packages/myco-server/ui/src/features/tasks/wire.ts';

function tasksPath(): string {
  const project = (JSON.parse(screensEnv('projects')) as Array<{ projectId: string }>)[0]!;
  return `/p/${encodeURIComponent(project.projectId)}/work/tasks`;
}

for (const { viewport, mode } of SHOT_MATRIX) {
  test(`Tasks view ${viewport} ${mode}`, async ({ browser }) => {
    const { context, page, watch } = await openPage(browser, { path: tasksPath(), viewport, mode, cookie: screensEnv('ownerCookie') });
    try {
      await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeInViewport();
      const project = (JSON.parse(screensEnv('projects')) as Array<{ projectId: string }>)[0]!;
      const answer = await page.evaluate(async (path) => {
        const response = await fetch(path);
        return { status: response.status, body: await response.json() };
      }, `/api/tasks?${new URLSearchParams({ project: project.projectId })}`);
      expect(answer.status).toBe(200);
      const registry = answer.body as TasksAnswer;
      const learning = registry.tasks.find((task) => task.task === 'extract-curate')!;
      expect(learning.profiles.map(({ harness }) => harness).sort()).toEqual(['claude-code', 'codex', 'cursor', 'opencode']);
      expect(learning.profileNote).toBe('Which agent runs it depends on what is signed in on your machines.');
      await expect(page.locator('article[data-task]')).toHaveCount(registry.tasks.length);
      for (const task of registry.tasks) {
        const card = page.locator('article[data-task]').filter({ has: page.getByRole('heading', { level: 2, name: task.name, exact: true }) });
        await expect(card.getByRole('heading', { level: 2 })).toHaveText(task.name);
        await expect(card).toContainText(task.description);
        for (const words of [...task.triggers, ...task.done]) await expect(card).toContainText(words);
        if (task.tools.length === 0) await expect(card.getByRole('button', { name: 'What it may use' })).toHaveCount(0);
        else if (viewport === 'phone' && task.tools.length > 4) {
          const tools = card.getByRole('button', { name: 'What it may use' });
          await tools.click();
          for (const words of task.tools) await expect(card).toContainText(words);
          await tools.click();
        } else for (const words of task.tools) await expect(card).toContainText(words);
        if (task.tier !== null) await expect(card.locator('[data-task-model]')).toContainText(`${task.tier} tier`);
        for (const profile of task.profiles) {
          if (profile.model !== null) expect((await card.locator('[data-task-model]').textContent())?.toLowerCase()).toContain(profile.model.toLowerCase());
          if (profile.note !== null) await expect(card).toContainText(profile.note);
        }
        if (task.budget === null) {
          await expect(card.getByRole('button', { name: 'Reading limits' })).toHaveCount(0);
          await expect(card).not.toContainText('seconds per run');
        }
        if (task.availabilityNote !== null) await expect(card.locator('[data-task-availability]')).toHaveText(task.availabilityNote);
      }
      await expectFits(page, viewport);
      await expectNoRawIds(page);
      await expectAxeClean(page);
      await shoot(page, 'tasks', viewport, mode, process.env.MYCO_TASKS_SHOTS);
      if (viewport !== 'tablet') {
        const viewportShot = await shoot(page, 'tasks-viewport', viewport, mode, process.env.MYCO_TASKS_SHOTS);
        await page.screenshot({ path: viewportShot, fullPage: false });
      }
      const instruction = registry.tasks.find((task) => task.promptTemplate !== null && task.standingRules !== null)!;
      const card = page.locator(`article[data-task="${instruction.task}"]`);
      await card.getByRole('button', { name: 'Exact rules and prompt template' }).click();
      expect(await card.locator('[data-task-exact]').allTextContents()).toEqual([instruction.promptTemplate, instruction.standingRules, ...instruction.templateVariants.map((variant) => variant.prompt)]);
      await expectFits(page, viewport);
      await expectAxeClean(page);
      await shoot(page, 'tasks-instruction', viewport, mode, process.env.MYCO_TASKS_SHOTS);
      expectQuiet(watch);
    } finally { await context.close(); }
  });
}

const ROLES = [
  { role: 'admin', cookie: 'ownerCookie' },
  { role: 'member', cookie: 'memberCookie' },
] as const;

for (const { role, cookie } of ROLES) for (const { viewport, mode } of SHOT_MATRIX) {
  test(`Tasks Run now ${role} ${viewport} ${mode}`, async ({ browser }) => {
    const { context, page, watch } = await openPage(browser, { path: tasksPath(), viewport, mode, cookie: screensEnv(cookie) });
    const dispatched: string[] = [];
    page.on('request', (request) => { if (request.url().includes('/api/harness/dispatch')) dispatched.push(request.url()); });
    try {
      const project = (JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>)[0]!;
      const registry = await page.evaluate(async (path) => (await (await fetch(path)).json()) as TasksAnswer, `/api/tasks?${new URLSearchParams({ project: project.projectId })}`);
      await expect(page.locator('main [data-scope-current]')).toHaveText(project.name);
      // Every task a person may start by hand has Run now, and no other task does.
      for (const task of registry.tasks) {
        await expect(page.locator(`article[data-task="${task.task}"] [data-run-now]`)).toHaveCount(task.startable ? 1 : 0);
      }
      expect(registry.tasks.filter((task) => task.startable).map((task) => task.task).sort()).toEqual(['canopy-map', 'extract-curate', 'vault-seed']);
      const learning = registry.tasks.find((task) => task.task === 'extract-curate')!;
      await page.getByRole('button', { name: `Run now: ${learning.name}` }).click();
      const dialog = page.getByRole('dialog', { name: 'Learn from new sessions now?' });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('[data-run-task-project]')).toHaveCount(0);
      await expect(dialog.locator('[data-run-on]')).toHaveText(/^(It will run on .+|At its \w+ tier, it will run on whichever machine is free first: .+|No machine that runs Myco’s tasks has checked in lately.+|[A-Z].+\.)$/);
      await expect(dialog.getByRole('switch', { name: 'Start fresh' })).toHaveCount(role === 'admin' ? 1 : 0);
      if (role === 'member') await expect(dialog.locator('[data-allowance]')).toBeVisible();
      await expectFits(page, viewport);
      await expectNoRawIds(page, '[role="dialog"]');
      await expectAxeClean(page, ['[role="dialog"]']);
      await shoot(page, `tasks-run-now-${role}`, viewport, mode, process.env.MYCO_TASKS_SHOTS);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      expect(dispatched, 'the confirmation was cancelled, so nothing was started').toEqual([]);
      expectQuiet(watch);
    } finally { await context.close(); }
  });
}

for (const { viewport, mode } of SHOT_MATRIX) {
  test(`Tasks Run now across every project ${viewport} ${mode}`, async ({ browser }) => {
    const { context, page, watch } = await openPage(browser, { path: '/work/tasks', viewport, mode, cookie: screensEnv('ownerCookie') });
    try {
      await expect(page.locator('main [data-scope-current]')).toHaveText('All projects');
      await page.locator('article[data-task="canopy-map"] [data-run-now]').click();
      const dialog = page.getByRole('dialog', { name: 'Update the code map now?' });
      await expect(dialog.locator('[data-run-task-project]')).toContainText('Which project?');
      await expect(dialog.getByRole('button', { name: 'Update the code map' })).toBeDisabled();
      await expectFits(page, viewport);
      await expectAxeClean(page, ['[role="dialog"]']);
      await shoot(page, 'tasks-all-run-now', viewport, mode, process.env.MYCO_TASKS_SHOTS);
      await dialog.getByRole('button', { name: 'Project: Choose a project' }).click();
      const project = (JSON.parse(screensEnv('projects')) as Array<{ projectId: string; name: string }>)[0]!;
      await page.getByRole('menu').getByRole('menuitemradio', { name: new RegExp(`^${project.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click();
      await expect(dialog.getByRole('button', { name: `Project: ${project.name}` })).toBeVisible();
      await expect(dialog.locator('[data-run-on]')).toBeVisible();
      await shoot(page, 'tasks-all-run-now-picked', viewport, mode, process.env.MYCO_TASKS_SHOTS);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      expectQuiet(watch);
    } finally { await context.close(); }
  });
}

test('run task names link to their task card', async ({ browser }) => {
  const { context, page, watch } = await openPage(browser, { path: tasksPath().replace('/tasks', '/runs/run_c19f7a0e55'), viewport: 'desktop', mode: 'light', cookie: screensEnv('ownerCookie') });
  try {
    const link = page.locator('[data-run-task]').getByRole('link');
    await expect(link).toHaveAttribute('href', /\/work\/tasks#canopy-map$/);
    await link.click();
    await expect(page).toHaveURL(/\/work\/tasks#canopy-map$/);
    await expect(page.locator('article[data-task="canopy-map"]')).toBeInViewport();
    expectQuiet(watch);
  } finally { await context.close(); }
});

test('Settings tier changes the model shown by the real Tasks registry', async ({ browser }) => {
  test.skip(process.env.MYCO_TASK_TIER_SMOKE !== '1', 'Runs alone against its own fixture because it changes settings.');
  const { context, page } = await openPage(browser, { path: '/settings', viewport: 'desktop', mode: 'light', cookie: screensEnv('ownerCookie') });
  const changedLeaves = ['worker.harness', 'agent.tasks', 'agent.reasoning_map.claude-code.default', 'agent.reasoning_map.claude-code.high'];
  const original = await page.evaluate(async () => {
    const response = await fetch('/api/settings');
    if (!response.ok) throw new Error(`Settings read failed: ${response.status}`);
    return await response.json() as { leaves: Array<{ leaf: string; configured: boolean; value: unknown }> };
  });
  try {
    const preferred = page.getByRole('combobox', { name: 'Preferred agent' });
    if ((await preferred.textContent()) !== 'Claude Code') {
      await preferred.click();
      await Promise.all([
        page.waitForResponse((response) => response.url().endsWith('/api/settings/worker.harness') && response.request().method() === 'PUT' && response.status() === 200),
        page.getByRole('option', { name: 'Claude Code', exact: true }).click(),
      ]);
    }
    await page.goto(new URL('/settings/models', page.url()).toString());
    const claude = page.getByRole('group', { name: 'Claude Code tiers' });
    for (const [tier, model] of [['default', 'sonnet'], ['high', 'opus']] as const) {
      const input = claude.getByLabel(`${tier} tier model`);
      await input.fill(model);
      await Promise.all([
        page.waitForResponse((response) => response.url().endsWith(`/api/settings/agent.reasoning_map.claude-code.${tier}`) && response.request().method() === 'PUT' && response.status() === 200),
        input.press('Tab'),
      ]);
    }
    const tier = page.getByRole('combobox', { name: 'Learning tier' });
    const pickTier = async (label: string) => {
      if ((await tier.textContent()) === label) return;
      await tier.click();
      await Promise.all([
        page.waitForResponse((response) => response.url().endsWith('/api/settings/agent.tasks') && response.request().method() === 'PATCH' && response.status() === 200),
        page.getByRole('option', { name: label, exact: true }).click(),
      ]);
    };
    await pickTier('Default');
    await page.goto(new URL(tasksPath(), page.url()).toString());
    await expect(page.locator('article[data-task="extract-curate"] [data-task-model]')).toContainText('default tier · Claude Code: Sonnet');
    await page.goto(new URL('/settings/models', page.url()).toString());
    await pickTier('High');
    await page.goto(new URL(tasksPath(), page.url()).toString());
    await expect(page.locator('article[data-task="extract-curate"] [data-task-model]')).toContainText('high tier · Claude Code: Opus');
  } finally {
    try {
      for (const leaf of changedLeaves) {
        const saved = original.leaves.find((row) => row.leaf === leaf);
        const restored = await page.evaluate(async ({ leaf, saved }) => {
          const response = await fetch(`/api/settings/${encodeURIComponent(leaf)}`, saved?.configured
            ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: saved.value }) }
            : { method: 'DELETE' });
          return response.status;
        }, { leaf, saved });
        expect(restored).toBe(200);
      }
    } finally { await context.close(); }
  }
});
