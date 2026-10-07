import { expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { scheduleWords, descriptionProfile } from '@myco-server-worker/read/task-descriptions.js';
import { OFFERABLE_PROFILE_HARNESSES } from '@goondocks/myco-shared/execution-profile';

import { RUNTIME_SERVED_TASKS } from '@myco-server-worker/core/harness.js';
import { TASK_SCHEDULE } from '@myco-server-worker/core/jobs.js';
import { PRE_CONDITIONS, ACCELERATORS } from '@myco-server-worker/core/scheduled-tasks.js';
import { RUN_CLOSE_RULES } from '@myco-server-worker/core/run-postconditions.js';
import { TASK_WORDS, TASK_ADMISSION, RETAINED_TASKS } from '@myco-server-worker/core/task-catalogue.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { MECHANISM_WORDS } from '../helpers/reader-vocabulary.js';

async function tasks(f: ReturnType<typeof sqliteEnv>, path = '/api/tasks') {
  const response = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(f.db), 'cf-connecting-ip': '1.2.3.4' } }), { ...f.env, ...OWNER_ENV });
  expect(response.status).toBe(200);
  return await response.json() as { tasks: Array<Record<string, unknown>> };
}

it('uses singular and plural schedule units and reader state names', () => {
  const schedule = TASK_SCHEDULE['canopy-map']!;
  for (const [seconds, unit] of [[3600, '1 hour'], [21600, '6 hours'], [900, '15 minutes']] as const) {
    const words = scheduleWords({ ...schedule, enabled: true, intervalSeconds: seconds, runIn: ['idle', 'sleep'] }, true);
    expect(words).toContain(`At least ${unit} between runs; on in Settings.`);
    expect(words).toContain('Runs while Myco is idle or asleep.');
    expect(words.join(' ')).not.toMatch(MECHANISM_WORDS);
  }
  expect(scheduleWords({ ...schedule, runIn: ['active'] }, true)).toContain('Runs while Myco is in use.');
});

it('runtime-served tasks describe their own surface rather than an agent run', async () => {
  const f = sqliteEnv();
  try {
    const answer = await tasks(f);
    for (const name of RUNTIME_SERVED_TASKS) {
      const task = answer.tasks.find((task) => task.task === name)!;
      expect(task).toMatchObject({ tools: [], budget: null, tier: null, profiles: [], promptTemplate: null, standingRules: null, profileNote: 'This task does not use a reasoning tier or a server-built prompt.' });
      expect((task.triggers as string[]).join(' ')).not.toMatch(/Only for projects|quiet for more|Reported/);
    }
    expect(answer.tasks.find((task) => task.task === 'embedding-reconcile')!.triggers).toEqual(['When the search index has pending work and Myco is idle or in use. At least 60 seconds between runs.']);
  } finally { f.sqlite.close(); }
});

it('describes the manual request for an unscheduled runtime task', async () => {
  const f = sqliteEnv();
  try {
    expect(TASK_SCHEDULE['container-smoke']).toBeNull();
    expect((await tasks(f)).tasks.find((task) => task.task === 'container-smoke')!.triggers).toEqual(['When a person requests this task.']);
  } finally { f.sqlite.close(); }
});

it('resolves every offerable agent without a preference and preserves run hold reasons', () => {
  const profile = descriptionProfile('extract-curate', new Map());
  expect(profile.tier).toBe('default');
  expect(profile.profileNote).toBe('Which agent runs it depends on what is signed in on your machines.');
  expect(profile.profiles.map((row) => row.harness)).toEqual(OFFERABLE_PROFILE_HARNESSES);
  expect(profile).toMatchObject({ profiles: expect.arrayContaining([
    { harness: 'claude-code', model: 'sonnet', effort: 'medium', note: null },
    { harness: 'codex', model: null, effort: null, note: 'Codex has no model chosen for the default tier. Choose one in Settings.' },
    expect.objectContaining({ harness: 'cursor', note: 'Cursor can’t use a chosen model, so it won’t run this task.' }),
  ]) });
  expect(descriptionProfile('extract-curate', new Map([['worker.harness', '"claude-code"']]))).toMatchObject({ profiles: [{ harness: 'claude-code', model: 'sonnet', effort: 'medium', note: null }], profileNote: 'A machine without this agent signed in may run it with the next agent in your fallback order.' });
});

it('uses the resolved project set to show a switched off capability', async () => {
  const f = sqliteEnv();
  try {
    let answer = await tasks(f, '/api/tasks?project=proj_1');
    expect(answer.tasks.find((task) => task.task === 'canopy-map')).toMatchObject({ availabilityNote: 'Switched off for this project' });
    expect(answer.tasks.find((task) => task.task === 'embedding-reconcile')).toMatchObject({ availabilityNote: 'Search for similar knowledge is unavailable on this server.' });
    await settingsWriter(f.db).setCapability('proj_1', 'canopy', true, 'test', 1);
    answer = await tasks(f, '/api/tasks?project=proj_1');
    expect(answer.tasks.find((task) => task.task === 'canopy-map')).toMatchObject({ availabilityNote: null });
  } finally { f.sqlite.close(); }
});

it('returns task names without prompts, rules or settings', async () => {
  const f = sqliteEnv();
  try {
    const answer = await tasks(f, '/api/tasks/names?project=proj_1');
    expect(answer.tasks).toEqual(RETAINED_TASKS.map((task) => ({ task, name: TASK_WORDS[task].name })));
  } finally { f.sqlite.close(); }
});

it('pins close-rule product and skip wording and all scheduled condition labels', () => {
  const products: Record<string, string> = { 'canopy-map': 'code map', 'title-summary': 'title', 'extract-curate': 'prompt', 'vault-seed': 'spore' };
  for (const [task, rule] of Object.entries(RUN_CLOSE_RULES)) {
    if (rule.skipHolds !== undefined) expect(rule.description.join(' ')).toMatch(/skip/);
    if (rule.artifact !== undefined) expect(rule.description.join(' ')).toContain(products[task]!);
  }
  for (const schedule of Object.values(TASK_SCHEDULE)) {
    if (schedule == null) continue;
    for (const name of [schedule.preCondition, schedule.reservedRunsPerDay?.preCondition].filter((name) => name !== undefined)) expect(PRE_CONDITIONS[name!]!.description.length).toBeGreaterThan(0);
  }
});

it('derives exact accelerator and cold-project lines under schedule overrides', async () => {
  const f = sqliteEnv();
  const registered = Object.assign(ACCELERATORS, { 'review-backlog': async () => 10 });
  try {
    await settingsWriter(f.db).setLeaf('agent.tasks', { 'canopy-map': { schedule: { intervalSeconds: 3600, runWhenCold: true, accelerator: { name: 'review-backlog', thresholds: { steady: 2, accelerated: 6 } } } } }, 'test', 1);
    const answer = await tasks(f);
    const triggers = answer.tasks.find((task) => task.task === 'canopy-map')!.triggers as string[];
    expect(triggers).toContain('With more than 2 pending items, the wait shortens to 900 seconds; with more than 6, to 300 seconds.');
    expect(triggers.join(' ')).not.toContain('Waits if the project has been quiet');
    await settingsWriter(f.db).setLeaf('agent.tasks', { 'canopy-map': { schedule: { runWhenCold: false } } }, 'test', 2);
    expect((await tasks(f)).tasks.find((task) => task.task === 'canopy-map')!.triggers).toContain('Waits if the project has been quiet for more than 14 days.');
  } finally { Reflect.deleteProperty(registered, 'review-backlog'); f.sqlite.close(); }
});

// Task-word keys are the retained task union rather than arbitrary strings.
const exhaustive: string extends keyof typeof TASK_WORDS ? false : true = true;
const sameNames: keyof typeof TASK_ADMISSION extends keyof typeof TASK_WORDS ? true : false = true;
it('task words are exhaustive at compile time', () => { expect(exhaustive && sameNames).toBe(true); });
