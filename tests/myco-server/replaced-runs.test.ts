/**
 * A run a deployment ended, and what the Deployment does about it.
 *
 * A rollout takes the runtime away mid-run. The run is failed by the container
 * that held it, marked as one a deployment replaced, kept out of the task's
 * per-day count, and answered by one fresh dispatch of the same task naming the
 * run it stands in for. Two caps hold that: one successor per replaced run, and
 * `REPLACED_REQUEUES_PER_DAY` of a task in a Project in a day.
 */
import { describe, expect, it } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { HARNESS_MEMBER_ID, REPLACED_REQUEUES_PER_DAY, requeueReplaced } from '@myco-server-worker/core/harness.js';
import { getRun, markRunReplaced, recordDispatch, taskEntriesSince } from '@myco-server-worker/core/runs.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import worker from '@myco-server-worker/index.js';
import { memberPost, sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ORIGIN = 'https://s';
const SCOPE = { projectId: 'proj_1' };
type Launch = { runId: string; timeoutSeconds: number; envVars: Record<string, string> };

function fixture() {
  const e = sqliteEnv();
  const launches: Launch[] = [];
  const HARNESS = { idFromName: (name: string) => ({ name }), get: () => ({ launch: async (spec: Launch) => { launches.push(spec); } }) };
  const bindings = { ...e.env, HARNESS };
  const base = serverEnvFromBindings(bindings as never);
  const env: ServerEnv = { ...base, wake: async () => {} };
  const setting = (leaf: string, value: unknown) => e.sqlite.run(
    `INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, 'mem_1')`, [leaf, JSON.stringify(value), NOW]);
  setting('agent.provider.type', 'openai-compatible');
  setting('agent.provider.model', 'm');
  setting('agent.provider.base_url', 'http://models.internal/v1');
  e.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`).run(NOW);
  e.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`).run(NOW);
  e.sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`).run(NOW);
  const rows = () => e.sqlite.query(`SELECT id, task, status, run_context AS runContext FROM agent_runs ORDER BY COALESCE(queued_at, started_at), id`)
    .all() as Array<{ id: string; task: string; status: string; runContext: string | null }>;
  const contextOf = (id: string) => JSON.parse((e.sqlite.query(`SELECT run_context c FROM agent_runs WHERE id = ?`).get(id) as { c: string }).c) as Record<string, unknown>;
  return { ...e, env, bindings, launches, setting, rows, contextOf };
}

/** A dispatched run of a task, recorded the way the dispatcher records one. */
async function dispatched(f: ReturnType<typeof fixture>, id: string, task: string, context: Record<string, unknown>, at = NOW): Promise<void> {
  await ensureMember(f.db, HARNESS_MEMBER_ID, at, 'harness runtime');
  const minted = await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, at);
  await recordDispatch(f.db, SCOPE, {
    id, agentId: 'myco-agent', task, provider: 'openai-compatible', model: 'm',
    runContext: JSON.stringify(context), dispatchedBy: minted.tokenId, startedAt: at,
  });
}

describe('what a replaced run costs the day', () => {
  it('excludes a replaced run from the task\'s count, and counts every other', async () => {
    const f = fixture();
    await dispatched(f, 'run_a', 'container-smoke', { timeoutSeconds: 120 });
    await dispatched(f, 'run_b', 'container-smoke', { timeoutSeconds: 120 });
    expect(await taskEntriesSince(f.db, SCOPE, 'container-smoke', NOW - DAY)).toBe(2);

    expect(await markRunReplaced(f.db, SCOPE, 'run_a')).toBe(true);
    expect(await taskEntriesSince(f.db, SCOPE, 'container-smoke', NOW - DAY)).toBe(1);
    // The mark keeps every other word the context carries.
    expect(f.contextOf('run_a')).toEqual({ timeoutSeconds: 120, replaced: true });
  });

  it('reads a context the store never wrote as JSON without failing the count', async () => {
    const f = fixture();
    await dispatched(f, 'run_a', 'container-smoke', { timeoutSeconds: 120 });
    f.sqlite.run(`UPDATE agent_runs SET run_context = 'not json at all' WHERE id = 'run_a'`);
    expect(await taskEntriesSince(f.db, SCOPE, 'container-smoke', NOW - DAY)).toBe(1);
    expect(await markRunReplaced(f.db, SCOPE, 'run_a')).toBe(false);
  });
});

describe('the run that stands in for a replaced one', () => {
  it('dispatches the same task once, naming the run it replaces and carrying that run\'s parameters', async () => {
    const f = fixture();
    await dispatched(f, 'run_a', 'title-summary', { session_id: 'sess_1', mode: 'claim', timeoutSeconds: 900, input_hash: 'h', fresh: true });
    await markRunReplaced(f.db, SCOPE, 'run_a');
    const run = (await getRun(f.db, SCOPE, 'run_a'))!;

    const first = await requeueReplaced(f.env, { run, projectId: 'proj_1', serverUrl: ORIGIN, actor: HARNESS_MEMBER_ID }, NOW + 1);
    expect(first).toMatchObject({ requeued: true, queued: false });
    const successor = (first as { runId: string }).runId;
    // The successor names its predecessor and carries what the dispatch asked
    // for. The hash of the ended run's own material stays behind: a task whose
    // prompt the server builds has it built again at launch.
    expect(f.contextOf(successor)).toEqual({ session_id: 'sess_1', mode: 'claim', timeoutSeconds: 900, fresh: true, replaces: 'run_a' });
    expect(f.launches.map((l) => l.runId)).toEqual([successor]);

    // A run already answered by a successor is never answered twice.
    expect(await requeueReplaced(f.env, { run, projectId: 'proj_1', serverUrl: ORIGIN, actor: HARNESS_MEMBER_ID }, NOW + 2))
      .toEqual({ requeued: false, reason: 'already_requeued' });
    expect(f.rows().filter((r) => r.task === 'title-summary')).toHaveLength(2);
  });

  it('stops at the day\'s cap on re-queues of one task, and the cap is a named number', async () => {
    const f = fixture();
    expect(REPLACED_REQUEUES_PER_DAY).toBe(2);
    const replaced: string[] = [];
    for (let i = 0; i < REPLACED_REQUEUES_PER_DAY + 1; i += 1) {
      const id = `run_r${i}`;
      await dispatched(f, id, 'container-smoke', { timeoutSeconds: 120 }, NOW + i);
      await markRunReplaced(f.db, SCOPE, id);
      replaced.push(id);
    }
    const outcomes = [];
    for (const [i, id] of replaced.entries()) {
      const run = (await getRun(f.db, SCOPE, id))!;
      outcomes.push(await requeueReplaced(f.env, { run, projectId: 'proj_1', serverUrl: ORIGIN, actor: HARNESS_MEMBER_ID }, NOW + 100 + i));
    }
    expect(outcomes.map((o) => o.requeued)).toEqual([true, true, false]);
    expect(outcomes.at(-1)).toEqual({ requeued: false, reason: 'daily_cap' });

    // Yesterday's successors leave today's cap free again.
    f.sqlite.run(`UPDATE agent_runs SET started_at = ?, queued_at = NULL WHERE run_context LIKE '%replaces%'`, [NOW - 2 * DAY]);
    const run = (await getRun(f.db, SCOPE, replaced.at(-1)!))!;
    expect(await requeueReplaced(f.env, { run, projectId: 'proj_1', serverUrl: ORIGIN, actor: HARNESS_MEMBER_ID }, NOW + 200))
      .toMatchObject({ requeued: true });
  });
});

describe('what a runtime may add to a run it did not dispatch', () => {
  async function runtime() {
    const f = fixture();
    await ensureMember(f.db, HARNESS_MEMBER_ID, NOW, 'harness runtime');
    const minted = await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, Date.now());
    await recordDispatch(f.db, SCOPE, {
      id: 'run_live', agentId: 'myco-agent', task: 'container-smoke', provider: 'openai-compatible', model: 'm',
      runContext: JSON.stringify({ timeoutSeconds: 120, input_hash: 'h' }), dispatchedBy: minted.tokenId, startedAt: Date.now(),
    });
    f.sqlite.run(`UPDATE agent_runs SET status = 'running' WHERE id = 'run_live'`);
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
      await (await worker.fetch(memberPost(minted.token, body, path), f.bindings as never)).json() as Record<string, unknown>;
    return { ...f, post };
  }

  it('adds `replaced` to the context through the failure it posts, and the run it stands in for is queued', async () => {
    const { post, contextOf, rows } = await runtime();
    expect(await post('/runs/update', {
      runId: 'run_live', replaced: true,
      update: { status: 'failed', completed_at: Date.now(), error: 'the platform reclaimed the runtime before the run ended' },
    })).toEqual({ persisted: true, changed: 1 });
    expect(contextOf('run_live')).toEqual({ timeoutSeconds: 120, input_hash: 'h', replaced: true });
    const successor = rows().find((r) => r.id !== 'run_live');
    expect(successor?.task).toBe('container-smoke');
    expect(JSON.parse(successor!.runContext!) as Record<string, unknown>).toMatchObject({ replaces: 'run_live' });
  });

  it('may not move the hash the dispatcher filed, with or without the word it may add', async () => {
    const { post, contextOf } = await runtime();
    expect(await post('/runs/update', { runId: 'run_live', replaced: true, update: { status: 'failed', run_context: '{"input_hash":"mine"}' } }))
      .toMatchObject({ persisted: false, code: 'refused' });
    expect(contextOf('run_live')).toEqual({ timeoutSeconds: 120, input_hash: 'h' });
  });

  it('leaves the context alone on a failure that names no deployment', async () => {
    const { post, contextOf, rows } = await runtime();
    expect(await post('/runs/update', { runId: 'run_live', update: { status: 'failed', error: 'the provider closed the stream' } }))
      .toEqual({ persisted: true, changed: 1 });
    expect(contextOf('run_live')).toEqual({ timeoutSeconds: 120, input_hash: 'h' });
    expect(rows()).toHaveLength(1);
  });
});
