/**
 * `GET /api/tasks/start`: what starting a task by hand in one Project would do
 * right now. The agent, model and effort it names are the ones a claim then
 * runs the task under; while no worker could take it, it names the holder a
 * queued run waits under; and a member reads their own day of runs of it as
 * the dispatch counts it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { claimNextRun } from '@myco-server-worker/core/harness.js';
import { recordWorkerContact } from '@myco-server-worker/core/worker-contacts.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { RETAINED_TASKS } from '@myco-server-worker/core/task-catalogue.js';
import type { TaskStartPreview } from '@myco-server-worker/read/task-start.js';
import { REPOSITORY_CHECKOUT_CAPABILITY } from '@goondocks/myco-shared/repository';
import { noModelForTier, profileUnsupported } from '@goondocks/myco-shared/run-holds';
import { sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { MEMBER_PRINCIPAL, MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';

type Answer = TaskStartPreview & { allowance: { perDay: number; used: number; resetsAt: number | null } | null };

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

async function rig(settings: Record<string, unknown> = {}) {
  const f = sqliteEnv({ workerLogin: true });
  cleanups.push(() => f.sqlite.close());
  seedMemberRoleAccount(f.sqlite);
  turnOnGatedCapabilities(f.sqlite);
  for (const [leaf, value] of Object.entries(settings)) {
    f.sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 1, 'test')`).run(leaf, JSON.stringify(value));
  }
  const env = { ...f.env, ...OWNER_ENV };
  const send = async (method: string, path: string, sub?: string, body?: unknown) => {
    const response = await worker.fetch(new Request(`https://s${path}`, {
      method,
      headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const preview = async (task: string, sub?: string, project = 'proj_1') => {
    const answer = await send('GET', `/api/tasks/start?${new URLSearchParams({ project, task })}`, sub);
    expect(answer.status).toBe(200);
    return answer.body as unknown as Answer;
  };
  await ensureMember(f.db, 'mem_worker', 0, 'admin', 'worker');
  const token = await issueMemberToken(f.db, { memberId: 'mem_worker', machineId: 'fixture' }, Date.now());
  /** A worker heard from now, offering `harnesses` and reporting `capabilities`. */
  const heard = (harnesses: string[], capabilities: string[] = []) => recordWorkerContact(f.db, {
    credentialId: token.tokenId, machineId: 'fixture', offers: harnesses.map(offeredHarness), capabilities, reason: 'no_work', now: Date.now(),
  });
  const claim = (harnesses: string[], capabilities: string[] = []) => claimNextRun(f.serverEnv, { tokenId: token.tokenId, machineId: 'fixture', harnesses: harnesses.map(offeredHarness), capabilities, now: Date.now() });
  return { f, send, preview, heard, claim };
}

describe('previewing a task started by hand', () => {
  it('names the agent, tier, model and effort a claim then runs it under', async () => {
    const r = await rig({ 'worker.harness': 'claude-code' });
    await r.heard(['claude-code']);
    const before = await r.preview('extract-curate');
    expect(before).toMatchObject({
      task: 'extract-curate', projectId: 'proj_1', heldBy: null, workers: 1, live: false, allowance: null,
      execution: { harness: 'claude-code', tier: 'default', model: 'sonnet', effort: 'medium' },
      capability: { name: 'vault_evolution', on: true },
      readiness: { condition: 'has-unprocessed-prompts', met: false },
    });
    expect((await r.send('POST', '/api/harness/dispatch', undefined, { projectId: 'proj_1', task: 'extract-curate' })).status).toBe(200);
    expect((await r.preview('extract-curate')).live).toBe(true);
    const claimed = await r.claim(['claude-code']);
    if (!claimed.claimed) throw new Error(`not claimed: ${claimed.reason}`);
    expect({ harness: claimed.run.harness, tier: claimed.run.profile.tier, model: claimed.run.profile.model, effort: claimed.run.profile.effort }).toEqual(before.execution!);
  });

  it('follows a Settings change to the task’s tier', async () => {
    const r = await rig({ 'worker.harness': 'claude-code', 'agent.tasks': { 'extract-curate': { reasoningLevel: 'high' } } });
    await r.heard(['claude-code']);
    expect((await r.preview('extract-curate')).execution).toEqual({ harness: 'claude-code', tier: 'high', model: 'opus', effort: 'high' });
  });

  it('names what a queued run would wait for while no worker could take it', async () => {
    const r = await rig({ 'worker.harness': 'claude-code' });
    expect(await r.preview('extract-curate')).toMatchObject({ execution: null, heldBy: 'worker', workers: 0 });
    await r.heard(['claude-code']);
    expect(await r.preview('canopy-map')).toMatchObject({ execution: null, heldBy: REPOSITORY_CHECKOUT_CAPABILITY, workers: 1 });
    r.f.sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.reasoning_map.claude-code.default', 'null', 2, 'test')`).run();
    expect(await r.preview('extract-curate')).toMatchObject({ execution: null, heldBy: noModelForTier('claude-code', 'default') });
    await recordWorkerContact(r.f.db, { credentialId: (r.f.sqlite.query(`SELECT credential_id AS id FROM worker_contacts`).get() as { id: string }).id, machineId: 'fixture', offers: [{ id: 'claude-code', authenticated: true }], capabilities: [], reason: 'no_work', now: Date.now() });
    expect(await r.preview('vault-seed')).toMatchObject({ execution: null });
    expect((await r.preview('extract-curate')).heldBy).toBe(profileUnsupported('claude-code'));
  });

  it('says whether the task’s own condition holds, and when its capability is off', async () => {
    const r = await rig();
    expect((await r.preview('canopy-map')).readiness).toEqual({ condition: 'has-capture-since-map', met: expect.any(Boolean) });
    expect((await r.preview('vault-seed')).readiness).toBeNull();
    r.f.sqlite.run(`UPDATE project_capabilities SET enabled = 0 WHERE project_id = 'proj_1' AND capability = 'canopy'`);
    expect((await r.preview('canopy-map')).capability).toEqual({ name: 'canopy', on: false });
  });

  it('reads a member’s own day of runs of the task as the dispatch counts it', async () => {
    const r = await rig({ 'agent.tasks': { 'extract-curate': { schedule: { memberRunsPerDay: 1 } }, 'vault-seed': { schedule: { memberRunsPerDay: 0 } } } });
    expect((await r.preview('extract-curate', MEMBER_SUB)).allowance).toEqual({ perDay: 1, used: 0, resetsAt: null });
    expect((await r.send('POST', '/api/harness/dispatch', MEMBER_SUB, { projectId: 'proj_1', task: 'extract-curate' })).status).toBe(200);
    const spent = (await r.preview('extract-curate', MEMBER_SUB)).allowance!;
    const queuedAt = (r.f.sqlite.query(`SELECT queued_at AS at FROM agent_runs WHERE json_extract(dispatch_spec, '$.actor') = ?`).get(MEMBER_PRINCIPAL.id) as { at: number }).at;
    expect(spent).toEqual({ perDay: 1, used: 1, resetsAt: queuedAt + 86_400_000 });
    const refused = await r.send('POST', '/api/harness/dispatch', MEMBER_SUB, { projectId: 'proj_1', task: 'extract-curate' });
    expect(refused).toMatchObject({ status: 429, body: { perDay: spent.perDay, resetsAt: spent.resetsAt } });
    expect((await r.preview('vault-seed', MEMBER_SUB)).allowance).toEqual({ perDay: 0, used: 0, resetsAt: null });
    expect((await r.preview('vault-seed')).allowance).toBeNull();
  });

  it('answers only for one readable project and a task started by hand', async () => {
    const r = await rig();
    for (const [path, status] of [
      ['/api/tasks/start?task=extract-curate', 400],
      ['/api/tasks/start?project=proj_1', 400],
      ['/api/tasks/start?project=proj_1&project=proj_2&task=extract-curate', 400],
      ['/api/tasks/start?project=proj_1&task=title-summary', 400],
      ['/api/tasks/start?project=proj_1&task=embedding-reconcile', 400],
      ['/api/tasks/start?project=proj_1&task=not-a-task', 400],
      ['/api/tasks/start?project=missing&task=extract-curate', 404],
    ] as const) expect({ path, status: (await r.send('GET', path, MEMBER_SUB)).status }).toEqual({ path, status });
    expect(r.f.sqlite.query(`SELECT COUNT(*) AS n FROM agent_runs`).get()).toEqual({ n: 0 });
  });

  it('marks exactly the tasks a person starts by hand in the task descriptions', async () => {
    const r = await rig();
    const answer = await r.send('GET', '/api/tasks');
    const tasks = (answer.body as { tasks: Array<{ task: string; startable: boolean; triggers: string[] }> }).tasks;
    expect(tasks.map((task) => task.task).sort()).toEqual([...RETAINED_TASKS].sort());
    expect(tasks.filter((task) => task.startable).map((task) => task.task).sort()).toEqual(['canopy-map', 'extract-curate', 'vault-seed']);
    for (const task of tasks) expect(task.triggers.includes('When a person chooses Run a task.')).toBe(task.startable);
  });
});
