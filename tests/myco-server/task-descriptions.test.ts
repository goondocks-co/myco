import { MECHANISM_WORDS } from '../helpers/reader-vocabulary';
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import worker from '@myco-server-worker/index.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import { RETAINED_TASKS, TASK_TOOLS, TASK_TIERS, TASK_WORDS, runTimeoutForTask } from '@myco-server-worker/core/task-catalogue.js';
import { RUN_CLOSE_RULES } from '@myco-server-worker/core/run-postconditions.js';
import { TASK_SCHEDULE } from '@myco-server-worker/core/jobs.js';
import { runAllowlist } from '@myco-server-worker/mcp/run-surface.js';
import { callWords } from '@goondocks/myco-shared/call-words';
import { readWindowFor } from '@myco-server-worker/core/read-window.js';
import { DEFAULT_DISPATCH_TIMEOUT_SECONDS } from '@myco-server-worker/core/harness.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { buildTaskInput } from '@myco-server-worker/core/task-inputs.js';

import type { TaskDescription } from '@myco-server-worker/read/task-descriptions.js';

async function read(f: ReturnType<typeof sqliteEnv>): Promise<TaskDescription[]> {
  const response = await worker.fetch(new Request('https://s/api/tasks', { headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' } }), { ...f.env, ...OWNER_ENV });
  expect(response.status).toBe(200);
  return (await response.json() as { tasks: TaskDescription[] }).tasks;
}

describe('task description registry gates', () => {
  it('registry completeness: every runnable task has a full description', async () => {
    const f = sqliteEnv();
    try {
      const tasks = await read(f);
      expect(tasks.map((task) => task.task).sort()).toEqual([...RETAINED_TASKS].sort());
      for (const task of tasks) {
        expect([task.name, task.description, ...task.triggers, ...task.tools, ...task.done, task.profileNote ?? ''].join(' ')).not.toMatch(MECHANISM_WORDS);
        expect(task.name.length).toBeGreaterThan(0);
        expect(task.description.length).toBeGreaterThan(0);
        expect(task.triggers.length).toBeGreaterThan(0);
        expect(task.tools.length).toBeGreaterThan(0);
        expect(task.done.length).toBeGreaterThan(0);
        expect(task.budget.timeoutSeconds).toBeGreaterThan(0);
        if (Object.hasOwn(TASK_TIERS, task.task)) expect(task.promptTemplate?.length).toBeGreaterThan(0);
      }
    } finally { f.sqlite.close(); }
  });

  it('registry derivation: descriptions use execution constants and effective schedule', async () => {
    const f = sqliteEnv();
    try {
      await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled', true, 'test', 1);
      await settingsWriter(f.db).setLeaf('agent.tasks', { 'extract-curate': { schedule: { intervalSeconds: 7200, maxRunsPerDay: 5 } } }, 'test', 2);
      for (const task of await read(f)) {
        expect(task.name).toBe(TASK_WORDS[task.task].name);
        expect(task.description).toBe(TASK_WORDS[task.task].description);
        expect(task.done).toEqual(RUN_CLOSE_RULES[task.task].description);
        expect(task.budget).toEqual({ timeoutSeconds: runTimeoutForTask(task.task) ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS, readWindow: readWindowFor(task.task) });
        const allow = runAllowlist(TASK_TOOLS[task.task], { dryRun: false });
        expect(task.tools).toEqual([...new Set([...allow].flatMap(([tool, ops]) => [...ops].map((op) => callWords(tool, op))))]);
        if (task.task === 'extract-curate') expect(task.triggers).toEqual(expect.arrayContaining(['At least 2 hours between runs; on in Settings.', 'At most 5 runs in a day.']));
        else if (TASK_SCHEDULE[task.task] != null) expect(task.triggers.join(' ')).toContain(String(TASK_SCHEDULE[task.task]!.maxRunsPerDay));
      }
    } finally { f.sqlite.close(); }
  });

  it('exact disclosure: templates and standing rules equal the server build for every prompted task', async () => {
    const f = sqliteEnv();
    try {
      f.sqlite.run(`INSERT INTO project_repositories (project_id, url, branch, revision, updated_at, updated_by) VALUES ('proj_1', ?, ?, 'test', 1, 'test')`, ['{{repository.url}}', '{{repository.branch}}']);
      const tasks = await read(f);
      for (const task of tasks.filter((task) => task.promptTemplate !== null)) {
        const params = task.task === 'title-summary' ? { session_id: '{{session.id}}', mode: 'claim' } : undefined;
        const built = await buildTaskInput(f.serverEnv, task.task, 'proj_1', 1, { params });
        expect(built !== null && !built.unchanged).toBe(true);
        if (built === null || built.unchanged) throw new Error('Missing build');
        expect(task.promptTemplate).toBe(built.input.instruction);
        expect(task.standingRules).toBe(built.input.instructions ?? null);
        for (const variant of task.templateVariants) {
          const alternate = await buildTaskInput(f.serverEnv, task.task, 'proj_1', 1, task.task === 'title-summary' ? { params: { session_id: '{{session.id}}', mode: 'owner' } } : { fresh: true });
          if (alternate === null || alternate.unchanged) throw new Error('Missing alternate build');
          expect(variant.prompt).toBe(alternate.input.instruction);
        }
      }
    } finally { f.sqlite.close(); }
  });

  it('Settings tier change: the read API immediately resolves the changed model and effort', async () => {
    const f = sqliteEnv();
    try {
      const env = { ...f.env, ...OWNER_ENV };
      const headers = { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' };
      const write = async (leaf: string, value: unknown) => {
        const response = await worker.fetch(new Request(`https://s/api/settings/${leaf}`, { method: 'PUT', headers, body: JSON.stringify({ value }) }), env);
        expect(response.status).toBe(200);
        expect((await response.json() as { applied: boolean }).applied).toBe(true);
      };
      const read = async () => {
        const response = await worker.fetch(new Request('https://s/api/tasks', { headers }), env);
        expect(response.status).toBe(200);
        return (await response.json() as { tasks: import('@myco-server-worker/read/task-descriptions.js').TaskDescription[] }).tasks.find((task) => task.task === 'extract-curate')!;
      };
      await write('worker.harness', 'claude-code');
      expect(await read()).toMatchObject({ tier: 'default', model: 'sonnet', effort: 'medium' });
      await write('agent.tasks', { 'extract-curate': { reasoningLevel: 'high' } });
      expect(await read()).toMatchObject({ tier: 'high', model: 'opus', effort: 'high' });
      await write('agent.reasoning_map.claude-code.high', 'claude-opus-4-6');
      expect(await read()).toMatchObject({ model: 'claude-opus-4-6' });
    } finally { f.sqlite.close(); }
  });

  it('resolves task pins, fallback preferences, missing models and malformed tiers visibly', async () => {
    const { descriptionProfile } = await import('@myco-server-worker/read/task-descriptions.js');
    const setting = (values: Record<string, unknown>) => new Map(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]));
    expect(descriptionProfile('extract-curate', setting({ 'worker.harness_fallback': ['claude-code'] }))).toMatchObject({ tier: 'default', harness: 'claude-code', model: 'sonnet' });
    expect(descriptionProfile('extract-curate', setting({ 'worker.harness': 'codex' }))).toMatchObject({ tier: 'default', harness: 'codex', model: null });
    expect(descriptionProfile('extract-curate', setting({ 'worker.harness': 'codex', 'agent.tasks': { 'extract-curate': { harness: 'claude-code', model: 'claude-sonnet-4-6', reasoningLevel: 'high' } } }))).toMatchObject({ tier: 'high', harness: 'claude-code', model: 'claude-sonnet-4-6', effort: 'high' });
    expect(descriptionProfile('extract-curate', new Map([['agent.tasks', 'broken']]))).toMatchObject({ tier: null, model: null });
  });

  it('read authority: members name a visible project and inaccessible projects reveal no descriptions', async () => {
    const f = sqliteEnv();
    try {
      seedMemberRoleAccount(f.sqlite);
      const env = { ...f.env, ...OWNER_ENV };
      const headers = { cookie: await ownerCookie(Date.now(), MEMBER_SUB), 'cf-connecting-ip': '1.2.3.4' };
      for (const [path, status] of [['/api/tasks', 400], ['/api/tasks?project=missing', 404], ['/api/tasks?project=proj_1', 200]] as const) {
        const response = await worker.fetch(new Request(`https://s${path}`, { headers }), env);
        expect(response.status).toBe(status);
        if (status === 200) expect((await response.json() as { tasks: unknown[] }).tasks).toHaveLength(RETAINED_TASKS.length);
      }
    } finally { f.sqlite.close(); }
  });
});
