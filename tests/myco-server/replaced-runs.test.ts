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
import { memberPost, sqliteEnv, withHarness } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ORIGIN = 'https://s';
const SCOPE = { projectId: 'proj_1' };
type Launch = { runId: string; timeoutSeconds: number; envVars: Record<string, string> };

function fixture() {
  const e = sqliteEnv();
  const launches: Launch[] = [];
  // The entry maps its own deployment, so a launch reaches it only as the
  // recording runtime: the successor is queued and marked, and starts nothing.
  const bindings = { ...e.env, HARNESS_LAUNCH_MODE: 'record' };
  const base = withHarness(() => e.serverEnv, { launch: async (spec) => { launches.push(spec); } });
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
  /** The launch a queued row carries, as the dispatch recorded it. */
  const specOf = (id: string) => JSON.parse((e.sqlite.query(`SELECT dispatch_spec s FROM agent_runs WHERE id = ?`).get(id) as { s: string }).s) as Record<string, unknown>;
  return { ...e, env, bindings, launches, setting, rows, contextOf, specOf };
}

/** A dispatched run of a task, recorded the way the dispatcher records one. */
async function dispatched(f: ReturnType<typeof fixture>, id: string, task: string, context: Record<string, unknown>, at = NOW): Promise<void> {
  await ensureMember(f.db, HARNESS_MEMBER_ID, at, 'member', 'harness runtime');
  const minted = await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, at);
  await recordDispatch(f.db, SCOPE, {
    id, agentId: 'myco-agent', task, provider: 'openai-compatible', model: 'm',
    runContext: JSON.stringify(context), dispatchedBy: minted.tokenId, startedAt: at,
    dispatchSpec: JSON.stringify({ actor: HARNESS_MEMBER_ID }),
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

  it('marks no context that is not an object, and counts the run either way', async () => {
    const f = fixture();
    // Neither of these is a context the dispatcher writes. The first is no JSON
    // at all; the second is valid JSON whose root is a scalar, which a naive
    // guard admits and a key-set then overwrites whole.
    for (const [id, context] of [['run_a', 'not json at all'], ['run_b', '7'], ['run_c', '"a string"']] as const) {
      await dispatched(f, id, 'container-smoke', { timeoutSeconds: 120 });
      f.sqlite.run(`UPDATE agent_runs SET run_context = ? WHERE id = ?`, [context, id]);
      expect({ id, marked: await markRunReplaced(f.db, SCOPE, id) }).toEqual({ id, marked: false });
      expect({ id, kept: (f.sqlite.query(`SELECT run_context c FROM agent_runs WHERE id = ?`).get(id) as { c: string }).c }).toEqual({ id, kept: context });
    }
    expect(await taskEntriesSince(f.db, SCOPE, 'container-smoke', NOW - DAY)).toBe(3);
  });
});

describe('the run that stands in for a replaced one', () => {
  it('queues the same task once, naming the run it replaces and carrying that run\'s parameters', async () => {
    const f = fixture();
    await dispatched(f, 'run_a', 'title-summary', { session_id: 'sess_1', mode: 'claim', timeoutSeconds: 900, input_hash: 'h', fresh: true });
    await markRunReplaced(f.db, SCOPE, 'run_a');
    const run = (await getRun(f.db, SCOPE, 'run_a'))!;

    const first = await requeueReplaced(f.env, { run, projectId: 'proj_1', serverUrl: ORIGIN, actor: HARNESS_MEMBER_ID }, NOW + 1);
    expect(first).toMatchObject({ requeued: true, queued: true });
    const successor = (first as { runId: string }).runId;
    // The successor names its predecessor and carries what the dispatch asked
    // for. The hash of the ended run's own material stays behind: a task whose
    // prompt the server builds has it built again for the run that stands in.
    expect(f.specOf(successor)).toEqual({
      serverUrl: ORIGIN, actor: HARNESS_MEMBER_ID, timeoutSeconds: 900,
      params: { session_id: 'sess_1', mode: 'claim' }, options: { dryRun: false, fresh: true }, replaces: 'run_a',
    });
    expect(f.launches).toEqual([]);

    // A run already answered by a successor is never answered twice.
    expect(await requeueReplaced(f.env, { run, projectId: 'proj_1', serverUrl: ORIGIN, actor: HARNESS_MEMBER_ID }, NOW + 2))
      .toEqual({ requeued: false, reason: 'already_requeued' });
    expect(f.rows().filter((r) => r.task === 'title-summary')).toHaveLength(2);
  });

  it.each(['clock', null])('keeps automatic accounting for a replacement with original actor %s', async (actor) => {
    const f = fixture();
    await dispatched(f, 'scheduled', 'extract-curate', { timeoutSeconds: 900 });
    f.sqlite.run(`UPDATE agent_runs SET dispatch_spec = ? WHERE id = 'scheduled'`, [actor === null ? null : JSON.stringify({ actor })]);
    await markRunReplaced(f.db, SCOPE, 'scheduled');
    const result = await requeueReplaced(f.env, { run: (await getRun(f.db, SCOPE, 'scheduled'))!, projectId: 'proj_1', serverUrl: ORIGIN, actor: HARNESS_MEMBER_ID }, NOW + 1);
    expect(result).toMatchObject({ requeued: true });
    expect(await taskEntriesSince(f.db, SCOPE, 'extract-curate', NOW - DAY, 'clock')).toBe(1);
    expect(f.specOf((result as { runId: string }).runId).actor).toBe(actor ?? '');
  });

  it('builds an extraction successor afresh, carrying the bound and the from-scratch ask of the run it stands in for', async () => {
    const f = fixture();
    await dispatched(f, 'run_a', 'extract-curate', { timeoutSeconds: 900, fresh: true });
    await markRunReplaced(f.db, SCOPE, 'run_a');
    const outcome = await requeueReplaced(f.env, { run: (await getRun(f.db, SCOPE, 'run_a'))!, projectId: 'proj_1', serverUrl: ORIGIN, actor: HARNESS_MEMBER_ID }, NOW + 1);
    expect(outcome).toMatchObject({ requeued: true });
    const successor = (outcome as { runId: string }).runId;
    const built = f.sqlite.query(`SELECT instruction, run_context c FROM agent_runs WHERE id = ?`).get(successor) as { instruction: string | null; c: string };
    expect(built.instruction).toContain('Read the prompts nobody has read yet');
    expect(JSON.parse(built.c) as Record<string, unknown>).toMatchObject({ fresh: true, timeoutSeconds: 900, replaces: 'run_a' });
    expect(String((JSON.parse(built.c) as { input_hash?: string }).input_hash)).toHaveLength(64);
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
    await ensureMember(f.db, HARNESS_MEMBER_ID, NOW, 'member', 'harness runtime');
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
    })).toEqual({ persisted: true, changed: 1, applied: true });
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

  it('leaves a scalar context alone and queues nothing behind it', async () => {
    const { post, sqlite, rows } = await runtime();
    sqlite.run(`UPDATE agent_runs SET run_context = '7' WHERE id = 'run_live'`);
    expect(await post('/runs/update', { runId: 'run_live', replaced: true, update: { status: 'failed', completed_at: Date.now(), error: 'reclaimed' } }))
      .toEqual({ persisted: true, changed: 1, applied: true });
    expect((sqlite.query(`SELECT run_context c FROM agent_runs WHERE id = 'run_live'`).get() as { c: string }).c).toBe('7');
    expect(rows()).toHaveLength(1);
  });

  it('is refused by a member that is not the run\'s own runtime: nothing marked, nothing queued', async () => {
    const { bindings, db, sqlite, contextOf, rows } = await runtime();
    // A member of the same Project holding the run id, presenting a credential
    // the dispatch never minted for this run.
    const other = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const answered = await (await worker.fetch(memberPost(other.token, {
      runId: 'run_live', replaced: true, update: { status: 'failed', completed_at: Date.now(), error: 'not mine to say' },
    }, '/runs/update'), bindings as never)).json() as Record<string, unknown>;
    // The status it posted stands; the word it may not say changed nothing.
    expect(answered).toEqual({ persisted: true, changed: 1, applied: true });
    expect(contextOf('run_live')).toEqual({ timeoutSeconds: 120, input_hash: 'h' });
    expect(rows()).toHaveLength(1);
    expect(sqlite.query(`SELECT status FROM agent_runs WHERE id = 'run_live'`).get()).toEqual({ status: 'failed' });
  });

  it('leaves the context alone on a failure that names no deployment', async () => {
    const { post, contextOf, rows } = await runtime();
    expect(await post('/runs/update', { runId: 'run_live', update: { status: 'failed', error: 'the provider closed the stream' } }))
      .toEqual({ persisted: true, changed: 1, applied: true });
    expect(contextOf('run_live')).toEqual({ timeoutSeconds: 120, input_hash: 'h' });
    expect(rows()).toHaveLength(1);
  });
});
