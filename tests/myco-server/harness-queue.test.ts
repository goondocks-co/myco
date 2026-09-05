/**
 * The queue: a dispatch past a limit is a run row that waits, launched by the
 * drain as capacity returns, in order, and never refused. What a queued row
 * never has — a credential, a start — is held as firmly as what it has.
 */
import { describe, expect, it } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { dispatchPrepared, dispatchTask, drainQueue, DRAIN_BATCH, HARNESS_MEMBER_ID, launchDispatch, LimitReached, prepareDispatch } from '@myco-server-worker/core/harness.js';
import { heldBy, readDispatchLimits } from '@myco-server-worker/core/limits.js';
import { claimRun, dispatchLoad, launchQueued, recordDispatch } from '@myco-server-worker/core/runs.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import { titleSession } from '@myco-server-worker/core/titling.js';
import { seedCredential } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://s';
type Launch = { runId: string; timeoutSeconds: number; envVars: Record<string, string> };

function fixture(opts: { bound?: boolean; refuse?: string } = {}) {
  const e = sqliteEnv();
  const launches: Launch[] = [];
  const wakes: number[] = [];
  const HARNESS = opts.bound === false ? undefined : {
    idFromName: (name: string) => ({ name }),
    get: () => ({ launch: async (spec: Launch) => {
      if (opts.refuse !== undefined) throw new Error(opts.refuse);
      launches.push(spec);
    } }),
  };
  const base = serverEnvFromBindings({ ...e.env, ...(HARNESS === undefined ? {} : { HARNESS }) } as never);
  const env: ServerEnv = { ...base, wake: async () => { wakes.push(Date.now()); } };
  const setting = (leaf: string, value: unknown) => e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, 'mem_1')`, [leaf, JSON.stringify(value), NOW]);
  const clear = (leaf: string) => e.sqlite.run(`DELETE FROM deployment_settings WHERE leaf = ?`, [leaf]);
  setting('agent.provider.type', 'openai-compatible');
  setting('agent.provider.model', 'm');
  setting('agent.provider.base_url', 'http://models.internal/v1');
  const run = (id: string) => e.sqlite.query(`SELECT status, task, started_at AS startedAt, queued_at AS queuedAt, held_by AS heldBy, dispatched_by AS dispatchedBy, run_context AS runContext, dispatch_spec AS dispatchSpec, error FROM agent_runs WHERE id = ?`).get(id) as Record<string, unknown> | null;
  const dispatch = (task = 'container-smoke', now = NOW) => dispatchTask(env, task, 'proj_1', { serverUrl: ORIGIN, actor: 'mem_1', timeoutSeconds: 120 }, now);
  const complete = (id: string, at = NOW) => e.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE id = ?`, [at, id]);
  return { ...e, env, launches, wakes, setting, clear, run, dispatch, complete };
}

describe('what holds a dispatch', () => {
  it('is null with no limit set, and names the first limit the load is at, the fleet first', () => {
    const none = { concurrent_runs: null, task_concurrent_runs: null, task_runs_per_hour: null, fleet: null };
    expect(heldBy({ liveRuns: 100, liveTaskRuns: 100, taskRunsLastHour: 100 }, none)).toBeNull();
    expect(heldBy({ liveRuns: 2, liveTaskRuns: 0, taskRunsLastHour: 0 }, { ...none, concurrent_runs: 2 })).toBe('concurrent_runs');
    expect(heldBy({ liveRuns: 1, liveTaskRuns: 0, taskRunsLastHour: 0 }, { ...none, concurrent_runs: 2 })).toBeNull();
    expect(heldBy({ liveRuns: 3, liveTaskRuns: 1, taskRunsLastHour: 0 }, { ...none, concurrent_runs: 2, fleet: 3 })).toBe('fleet');
    expect(heldBy({ liveRuns: 0, liveTaskRuns: 1, taskRunsLastHour: 0 }, { ...none, task_concurrent_runs: 1 })).toBe('task_concurrent_runs');
    expect(heldBy({ liveRuns: 0, liveTaskRuns: 0, taskRunsLastHour: 5 }, { ...none, task_runs_per_hour: 5 })).toBe('task_runs_per_hour');
  });

  it('reads each owner limit from its leaf, unset or malformed meaning none, and the fleet from what the operator deployed', async () => {
    const f = fixture();
    expect(await readDispatchLimits(f.env)).toEqual({ concurrent_runs: null, task_concurrent_runs: null, task_runs_per_hour: null, fleet: null });
    f.setting('agent.limits.concurrent_runs', 3);
    f.setting('agent.limits.task_runs_per_hour', 0);
    f.setting('agent.limits.task_concurrent_runs', 2.9);
    expect(await readDispatchLimits(f.env)).toEqual({ concurrent_runs: 3, task_concurrent_runs: 2, task_runs_per_hour: null, fleet: null });
    expect(await readDispatchLimits({ ...f.env, fleet: 12 })).toMatchObject({ fleet: 12 });
    expect(await readDispatchLimits({ ...f.env, fleet: 0 })).toMatchObject({ fleet: null });
  });

  it('holds a dispatch at the fleet the operator deployed, by name', async () => {
    const f = fixture();
    const env: ServerEnv = { ...f.env, fleet: 1 };
    expect(await dispatchTask(env, 'container-smoke', 'proj_1', { serverUrl: ORIGIN, actor: 'mem_1', timeoutSeconds: 120 }, NOW)).toMatchObject({ dispatched: true, queued: false });
    expect(await dispatchTask(env, 'digest-only', 'proj_1', { serverUrl: ORIGIN, actor: 'mem_1', timeoutSeconds: 120 }, NOW + 1)).toMatchObject({ dispatched: true, queued: true, heldBy: 'fleet' });
  });
});

describe('a dispatch past a limit', () => {
  it('is a run row that waits — no credential, no start, the limit by name — and wakes the Deployment', async () => {
    const f = fixture();
    f.setting('agent.limits.concurrent_runs', 1);
    const first = await f.dispatch();
    expect(first).toMatchObject({ dispatched: true, queued: false });
    const second = await f.dispatch('container-smoke', NOW + 1);
    expect(second).toMatchObject({ dispatched: true, queued: true, heldBy: 'concurrent_runs', task: 'container-smoke', projectId: 'proj_1' });
    const runId = (second as { runId: string }).runId;
    expect(f.run(runId)).toMatchObject({ status: 'queued', startedAt: null, queuedAt: NOW + 1, heldBy: 'concurrent_runs', dispatchedBy: null, runContext: null });
    expect(JSON.parse(f.run(runId)!.dispatchSpec as string)).toEqual({ serverUrl: ORIGIN, actor: 'mem_1', timeoutSeconds: 120 });
    expect(f.launches).toHaveLength(1);
    expect(f.wakes).toHaveLength(2);
    expect((f.sqlite.query(`SELECT COUNT(*) c FROM member_credentials`).get() as { c: number }).c).toBe(1);
    expect(await dispatchLoad(f.env.db, 'container-smoke', NOW)).toEqual({ liveRuns: 1, liveTaskRuns: 1, taskRunsLastHour: 1 });
  });

  it('is refused a claim, from any credential: nothing has been dispatched to it', async () => {
    const f = fixture();
    f.setting('agent.limits.concurrent_runs', 1);
    await f.dispatch();
    const queued = (await f.dispatch('container-smoke', NOW + 1)) as { runId: string };
    const claim = await claimRun(f.env.db, { projectId: 'proj_1' }, { id: queued.runId, agentId: 'myco-agent', task: 'container-smoke', instruction: null, harness: 'h', provider: null, model: null, dryRun: false, startedAt: NOW, runContext: null, dispatchedBy: 'cred_x' }, { taskName: 'container-smoke', admission: { kind: 'capability', capability: 'cortex' }, dispatchedOnly: true }, NOW);
    expect(claim.claimed).toBe(false);
    expect(f.run(queued.runId)?.status).toBe('queued');
  });
});

describe('the drain', () => {
  it('launches queued runs oldest first as the limit allows, on a terminal write and on the tick, and leaves the rest waiting', async () => {
    const f = fixture();
    f.setting('agent.limits.concurrent_runs', 1);
    const first = (await f.dispatch()) as { runId: string };
    const second = (await f.dispatch('container-smoke', NOW + 1)) as { runId: string };
    const third = (await f.dispatch('container-smoke', NOW + 2)) as { runId: string };
    expect(await drainQueue(f.env, NOW + 3)).toBe(0);
    f.complete(first.runId);
    expect(await drainQueue(f.env, NOW + 4)).toBe(1);
    expect(f.run(second.runId)).toMatchObject({ status: 'pending', startedAt: NOW + 4, heldBy: null, queuedAt: NOW + 1 });
    expect(typeof f.run(second.runId)?.dispatchedBy).toBe('string');
    expect(JSON.parse(f.run(second.runId)!.runContext as string)).toEqual({ timeoutSeconds: 120 });
    expect(f.run(third.runId)?.status).toBe('queued');
    expect(f.launches.map((l) => l.runId)).toEqual([first.runId, second.runId]);
    expect(f.launches[1]!.envVars.MYCO_SERVER_URL).toBe(ORIGIN);
    // The tick drains too, and a queued run keeps the Deployment awake.
    f.complete(second.runId, NOW + 5);
    const report = await runTick(f.env, NOW + 6);
    expect(report.drained).toBe(1);
    expect(f.run(third.runId)?.status).toBe('pending');
    expect(await runTick(f.env, NOW + 7)).toMatchObject({ drained: 0 });
  });

  it('holds the Deployment at active while a run waits, whatever inactivity says', async () => {
    const f = fixture();
    f.setting('agent.limits.concurrent_runs', 1);
    await f.dispatch();
    await f.dispatch('container-smoke', NOW + 1);
    const later = NOW + 120 * 60_000;
    expect(await runTick(f.env, later)).toMatchObject({ state: 'active', heldBy: 'queue:pending' });
  });

  it('fails a queued run by name when the Deployment can no longer prepare it, and launches all once the limit is lifted', async () => {
    const f = fixture();
    f.setting('agent.limits.concurrent_runs', 1);
    const first = (await f.dispatch()) as { runId: string };
    const second = (await f.dispatch('container-smoke', NOW + 1)) as { runId: string };
    const third = (await f.dispatch('container-smoke', NOW + 2)) as { runId: string };
    f.complete(first.runId);
    f.clear('agent.provider.type');
    expect(await drainQueue(f.env, NOW + 3)).toBe(0);
    expect(f.run(second.runId)).toMatchObject({ status: 'failed', error: 'no provider is configured; Settings names one before a dispatch can run' });
    expect(f.run(third.runId)).toMatchObject({ status: 'failed' });
    f.setting('agent.provider.type', 'openai-compatible');
    f.clear('agent.limits.concurrent_runs');
    const a = (await f.dispatch('container-smoke', NOW + 10)) as { runId: string };
    const b = (await f.dispatch('container-smoke', NOW + 11)) as { runId: string };
    expect([f.run(a.runId)?.status, f.run(b.runId)?.status]).toEqual(['pending', 'pending']);
  });

  it('stops at a Deployment-wide holder and skips past a per-task one', async () => {
    const f = fixture();
    f.setting('agent.limits.task_concurrent_runs', 1);
    const smoke = (await f.dispatch()) as { runId: string };
    const smokeQueued = (await f.dispatch('container-smoke', NOW + 1)) as { runId: string };
    const digest = (await f.dispatch('digest-only', NOW + 2)) as { runId: string };
    expect(f.run(smokeQueued.runId)?.status).toBe('queued');
    expect(f.run(digest.runId)?.status).toBe('pending');
    f.complete(smoke.runId);
    expect(await drainQueue(f.env, NOW + 3)).toBe(1);
    expect(f.run(smokeQueued.runId)?.status).toBe('pending');
  });

  it('never launches without a runtime: an unbound Deployment leaves the queue for the runtime that arrives', async () => {
    const f = fixture({ bound: false });
    expect(await f.dispatch()).toMatchObject({ dispatched: false, refusal: 'harness_unavailable' });
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec) VALUES ('proj_1', 'q1', 'myco-agent', 'container-smoke', 'queued', ?, 'fleet', ?)`, [NOW, JSON.stringify({ serverUrl: ORIGIN, actor: 'mem_1', timeoutSeconds: 120 })]);
    expect(await drainQueue(f.env, NOW + 1)).toBe(0);
    expect(f.run('q1')?.status).toBe('queued');
  });

  it('considers one batch per drain', () => {
    expect(DRAIN_BATCH).toBeGreaterThan(0);
    expect(HARNESS_MEMBER_ID).toBe('mem_harness');
  });
});

describe('a titling past a limit', () => {
  it('claims the session, queues the run, and the drain launches it with the parameters the ask named', async () => {
    const f = fixture();
    f.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at) VALUES ('proj_1', 's1', 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?)`, [NOW - 10_000, NOW, NOW - 10_000, NOW]);
    f.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', 's1', 'p1', 'e1', 'hello there', 'user', 'h1', ?, ?, 'tok_1', ?)`, [NOW - 5000, NOW - 5000, NOW - 5000]);
    f.setting('agent.limits.concurrent_runs', 1);
    await f.dispatch();
    const asked = await titleSession(f.env, { projectId: 'proj_1', sessionId: 's1', now: NOW + 1, origin: ORIGIN });
    expect(asked.outcome).toBe('queued');
    const runId = asked.runId!;
    expect(f.run(runId)).toMatchObject({ status: 'queued', task: 'title-summary', heldBy: 'concurrent_runs' });
    expect((f.sqlite.query(`SELECT titled_at FROM sessions WHERE session_id = 's1'`).get() as { titled_at: number | null }).titled_at).toBe(NOW + 1);
    f.clear('agent.limits.concurrent_runs');
    expect(await drainQueue(f.env, NOW + 2)).toBe(1);
    expect(JSON.parse(f.launches.at(-1)!.envVars.MYCO_TASK_PARAMS!)).toEqual({ session_id: 's1', mode: 'claim', timeoutSeconds: expect.any(Number) });
  });
});

describe('the write is the admission', () => {
  const none = { concurrent_runs: null, task_concurrent_runs: null, task_runs_per_hour: null, fleet: null };
  const record = (id: string) => ({ id, agentId: 'myco-agent', task: 'container-smoke', provider: null, model: null, runContext: null, dispatchedBy: null, startedAt: NOW });

  it('refuses a launch write at a limit in the same statement that would have written it, and admits under it', async () => {
    const f = fixture();
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
    const scope = { projectId: 'proj_1' };
    expect(await recordDispatch(f.env.db, scope, record('a'), { limits: { ...none, concurrent_runs: 1 }, now: NOW })).toBe(true);
    expect(await recordDispatch(f.env.db, scope, record('b'), { limits: { ...none, concurrent_runs: 1 }, now: NOW })).toBe(false);
    expect(f.run('b')).toBeNull();
    expect(await recordDispatch(f.env.db, scope, record('b'), { limits: { ...none, concurrent_runs: 2 }, now: NOW })).toBe(true);
    expect(await recordDispatch(f.env.db, scope, record('c'), { limits: { ...none, task_runs_per_hour: 2 }, now: NOW })).toBe(false);
    expect(await recordDispatch(f.env.db, scope, record('c'), { limits: { ...none, task_runs_per_hour: 2 }, now: NOW + 3_600_001 })).toBe(true);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec) VALUES ('proj_1', 'q', 'myco-agent', 'container-smoke', 'queued', ?, 'fleet', '{}')`, [NOW]);
    const launch = { task: 'container-smoke', dispatchedBy: 'cred_q', startedAt: NOW, runContext: null, provider: null, model: null };
    seedCredential(f.sqlite, { id: 'cred_q', memberId: 'mem_harness', machineId: 'harness' });
    expect(await launchQueued(f.env.db, scope, 'q', launch, { limits: { ...none, fleet: 3 }, now: NOW })).toBe(false);
    expect(f.run('q')?.status).toBe('queued');
    expect(await launchQueued(f.env.db, scope, 'q', launch, { limits: { ...none, fleet: 4 }, now: NOW })).toBe(true);
    expect(f.run('q')?.status).toBe('pending');
  });

  it('revokes the credential a refused launch minted, and the dispatch lands in the queue instead', async () => {
    const f = fixture();
    const prepared = await prepareDispatch(f.env, 'container-smoke', 'proj_1');
    expect(prepared.ok).toBe(true);
    f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'live', 'myco-agent', 'digest-only', 'running', ?)`, [NOW]);
    const spec = { serverUrl: ORIGIN, actor: 'mem_1', timeoutSeconds: 120 };
    await expect(launchDispatch(f.env, (prepared as { prepared: never }).prepared, spec, NOW, { limits: { ...none, concurrent_runs: 1 } })).rejects.toBeInstanceOf(LimitReached);
    const credentials = f.sqlite.query(`SELECT revoked_at FROM member_credentials WHERE member_id = 'mem_harness'`).all() as Array<{ revoked_at: number | null }>;
    expect(credentials).toHaveLength(1);
    expect(credentials[0]!.revoked_at).toBe(NOW);
    expect(f.launches).toHaveLength(0);
    // The one dispatch path reads the load as free, loses the write to a run that lands between the read and the write, and queues.
    f.setting('agent.limits.concurrent_runs', 2);
    let raced = false;
    const racing: ServerEnv = { ...f.env, db: { ...f.env.db, prepare: (sql: string) => {
      if (!raced && sql.includes(`?, 'pending', ?`)) {
        raced = true;
        f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'live-2', 'myco-agent', 'digest-only', 'running', ?)`, [NOW]);
      }
      return f.env.db.prepare(sql);
    } } };
    const outcome = await dispatchPrepared(racing, (prepared as { prepared: never }).prepared, spec, NOW + 1);
    expect(outcome).toMatchObject({ queued: true, heldBy: 'concurrent_runs' });
    expect(f.run((outcome as { runId: string }).runId)?.status).toBe('queued');
    expect(f.launches).toHaveLength(0);
  });

  it('revokes the credential a run whose runtime refused to start minted, along with failing its row', async () => {
    const f = fixture({ refuse: 'the harness runtime refused to launch run_refused: draining' });
    const prepared = await prepareDispatch(f.env, 'container-smoke', 'proj_1');
    expect(prepared.ok).toBe(true);
    const spec = { serverUrl: ORIGIN, actor: 'mem_1', timeoutSeconds: 120, runId: 'run_refused' };

    // The supervisor's own word reaches the caller; the row carries the server's.
    await expect(launchDispatch(f.env, (prepared as { prepared: never }).prepared, spec, NOW)).rejects.toThrow(/draining/);
    expect(f.run('run_refused')).toMatchObject({ status: 'failed', error: 'the runtime refused to start' });

    // A run that never started never presents the credential minted for it.
    const credentials = f.sqlite.query(`SELECT revoked_at FROM member_credentials WHERE member_id = 'mem_harness'`).all() as Array<{ revoked_at: number | null }>;
    expect(credentials).toHaveLength(1);
    expect(credentials[0]!.revoked_at).toBe(NOW);
  });
});
