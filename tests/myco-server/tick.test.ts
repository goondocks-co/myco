/**
 * The tick: what one wake does, and that a second wake on the same clock does
 * nothing more. The jobs it runs converge on a state; these hold each job's
 * bound in place — what it never touches — as much as what it removes.
 */
import { describe, expect, it } from 'bun:test';
import { armNextWake, armSoon, CLOCK_MANUAL, clockArmsAlarms } from '@myco-server-worker/platform/cloudflare/deployment-clock.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { DEFAULT_DISPATCH_TIMEOUT_SECONDS, RUN_OVERRUN_MARGIN_MS } from '@myco-server-worker/core/harness.js';
import { JOB_BATCH, RUN_RETENTION_DAYS_DEFAULT, STALE_RUN_ERROR, staleAfter, timeoutSecondsOf } from '@myco-server-worker/core/jobs-run.js';
import { SERVER_JOBS } from '@myco-server-worker/core/jobs.js';
import { lastActivityAt, REQUEST_STAMP_INTERVAL_MS, stampOwnerRequest } from '@myco-server-worker/core/activity.js';
import { POWER_THRESHOLDS, runTick, WAKE_INTERVALS } from '@myco-server-worker/core/tick.js';
import { seedCredential } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const AGENT = 'myco-agent';

function fixture() {
  const e = sqliteEnv();
  e.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, NOW);
  const ended: string[] = [];
  const env: ServerEnv = { ...e.serverEnv, harnessEnd: async (runId) => { ended.push(runId); } };
  const seedRun = (over: { id: string; status?: string; startedAt?: number | null; completedAt?: number | null; resumable?: number; runContext?: string | null; dispatchedBy?: string | null; project?: string }) => {
    e.sqlite.query(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, resumable, run_context, dispatched_by)
      VALUES (?, ?, ?, 'digest', ?, ?, ?, ?, ?, ?)`)
      .run(over.project ?? 'proj_1', over.id, AGENT, over.status ?? 'completed', over.startedAt === undefined ? NOW - 2 * DAY : over.startedAt, over.completedAt === undefined ? NOW - DAY : over.completedAt, over.resumable ?? 0, over.runContext ?? null, over.dispatchedBy ?? null);
  };
  const seedChild = (runId: string) => {
    e.sqlite.query(`INSERT INTO agent_turns (project_id, run_id, agent_id, turn_number, tool_name) VALUES ('proj_1', ?, ?, 0, 'read')`).run(runId, AGENT);
    e.sqlite.query(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at) VALUES ('proj_1', ?, ?, 'noted', 'x', ?)`).run(runId, AGENT, NOW);
  };
  const seedToken = seedCredential(e.sqlite, { id: 'mt_seed' });
  const seedSession = (id: string, lastReceivedAt: number) => {
    e.sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent) VALUES ('proj_1', ?, 'machine_1', ?, ?, ?, 'claude-code')`).run(id, seedToken, lastReceivedAt, lastReceivedAt);
  };
  const runRow = (id: string) => e.sqlite.query(`SELECT status, error, completed_at AS completedAt FROM agent_runs WHERE id = ?`).get(id) as { status: string; error: string | null; completedAt: number | null } | null;
  const count = (table: string) => (e.sqlite.query(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
  const setting = (leaf: string, value: unknown) => e.sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, 'mem_1')`).run(leaf, JSON.stringify(value), NOW);
  return { ...e, env, ended, seedRun, seedChild, seedSession, runRow, count, setting };
}

describe('the run bound the sweep reads', () => {
  it('rides the run context beside the task parameters, and is the dispatcher default when absent', () => {
    expect(timeoutSecondsOf(JSON.stringify({ session_id: 's', timeoutSeconds: 240 }))).toBe(240);
    expect(timeoutSecondsOf(JSON.stringify({ session_id: 's' }))).toBe(DEFAULT_DISPATCH_TIMEOUT_SECONDS);
    expect(timeoutSecondsOf(null)).toBe(DEFAULT_DISPATCH_TIMEOUT_SECONDS);
    expect(timeoutSecondsOf('not json')).toBe(DEFAULT_DISPATCH_TIMEOUT_SECONDS);
    expect(staleAfter(NOW, JSON.stringify({ timeoutSeconds: 300 }))).toBe(NOW + 300_000 + RUN_OVERRUN_MARGIN_MS);
  });
});

describe('when the Deployment last saw activity', () => {
  it('is the latest of a capture receipt, a run start and an owner request, or null when nothing ever happened', async () => {
    const f = fixture();
    expect(await lastActivityAt(f.env.db)).toBeNull();
    f.seedSession('s1', NOW - 3 * DAY);
    expect(await lastActivityAt(f.env.db)).toBe(NOW - 3 * DAY);
    f.seedRun({ id: 'r1', startedAt: NOW - 2 * DAY });
    expect(await lastActivityAt(f.env.db)).toBe(NOW - 2 * DAY);
    await stampOwnerRequest(f.env.db, NOW - DAY);
    expect(await lastActivityAt(f.env.db)).toBe(NOW - DAY);
  });

  it('stamps an owner request once per interval, not once per request', async () => {
    const f = fixture();
    await stampOwnerRequest(f.env.db, NOW);
    await stampOwnerRequest(f.env.db, NOW + REQUEST_STAMP_INTERVAL_MS - 1);
    expect(await lastActivityAt(f.env.db)).toBe(NOW);
    await stampOwnerRequest(f.env.db, NOW + REQUEST_STAMP_INTERVAL_MS + 1);
    expect(await lastActivityAt(f.env.db)).toBe(NOW + REQUEST_STAMP_INTERVAL_MS + 1);
  });
});

describe('the power state a tick resolves', () => {
  it('follows inactivity, is held to idle by a live run, and answers the next wake for its depth', async () => {
    const f = fixture();
    f.seedSession('s1', NOW);
    expect(await runTick(f.env, NOW + 1_000)).toMatchObject({ state: 'active', heldBy: null, nextWakeMs: WAKE_INTERVALS.activeMs });
    expect(await runTick(f.env, NOW + POWER_THRESHOLDS.sleepMs)).toMatchObject({ state: 'sleep', nextWakeMs: WAKE_INTERVALS.sleepMs });
    expect(await runTick(f.env, NOW + POWER_THRESHOLDS.deepSleepMs)).toMatchObject({ state: 'deep_sleep', nextWakeMs: null, jobs: [] });
    // A run that started long enough ago for inactivity alone to mean sleep, still inside a long bound, holds the Deployment at idle.
    const later = NOW + POWER_THRESHOLDS.deepSleepMs;
    f.seedRun({ id: 'live', status: 'running', startedAt: later - POWER_THRESHOLDS.sleepMs - 60_000, completedAt: null, runContext: JSON.stringify({ timeoutSeconds: 3_600 }) });
    expect(await runTick(f.env, later)).toMatchObject({ state: 'idle', heldBy: 'run:live', nextWakeMs: WAKE_INTERVALS.activeMs });
    // A run past its bound holds nothing: its runtime is gone, and only the sweep can help it.
    expect(await runTick(f.env, later + 3_600_000 + RUN_OVERRUN_MARGIN_MS)).toMatchObject({ state: 'deep_sleep', heldBy: null });
  });

  it('runs housekeeping at every depth but deep sleep: a Deployment in use is swept too', async () => {
    const f = fixture();
    f.seedSession('s1', NOW);
    expect((await runTick(f.env, NOW)).jobs.map((j) => j.name)).toEqual(['agent-run-retention', 'run-stale-sweep', 'search-index', 'embedding-reconcile']);
  });

  it('runs nothing when the Deployment never saw activity: nothing to keep, and no wake to pay for', async () => {
    const f = fixture();
    expect(await runTick(f.env, NOW)).toMatchObject({ state: 'deep_sleep', idleMs: null, jobs: [], nextWakeMs: null });
  });
});

describe('agent-run-retention', () => {
  it('removes terminal, non-resumable runs past the window with their turns and reports, and nothing else', async () => {
    const f = fixture();
    const old = NOW - (RUN_RETENTION_DAYS_DEFAULT + 1) * DAY;
    f.seedRun({ id: 'gone', completedAt: old, startedAt: old - 1000 }); f.seedChild('gone');
    f.seedRun({ id: 'gone-by-start', completedAt: null, startedAt: old }); f.seedChild('gone-by-start');
    f.seedRun({ id: 'gone-failed', status: 'failed', completedAt: old });
    f.seedRun({ id: 'kept-fresh', completedAt: NOW - DAY });
    f.seedRun({ id: 'kept-resumable', status: 'failed', completedAt: old, resumable: 1 });
    f.seedRun({ id: 'kept-live', status: 'running', startedAt: old, completedAt: null });
    f.seedRun({ id: 'kept-pending', status: 'pending', startedAt: old, completedAt: null });
    f.seedSession('s1', NOW - POWER_THRESHOLDS.sleepMs);
    const report = await runTick(f.env, NOW);
    expect(report.state).toBe('sleep');
    expect(report.jobs.find((j) => j.name === 'agent-run-retention')).toEqual({ name: 'agent-run-retention', changed: 3, failed: null });
    expect(f.sqlite.query(`SELECT id FROM agent_runs ORDER BY id`).all().map((r) => (r as { id: string }).id)).toEqual(['kept-fresh', 'kept-live', 'kept-pending', 'kept-resumable']);
    expect(f.count('agent_turns')).toBe(0);
    expect(f.count('agent_reports')).toBe(0);
    // The second wake on the same clock finds nothing left to do.
    expect((await runTick(f.env, NOW)).jobs.find((j) => j.name === 'agent-run-retention')).toEqual({ name: 'agent-run-retention', changed: 0, failed: null });
  });

  it('reads the window from the Deployment leaf, clamped to the leaf\'s own bounds', async () => {
    const f = fixture();
    f.setting('agent.run_retention_days', 7);
    f.seedRun({ id: 'eight-days', completedAt: NOW - 8 * DAY });
    f.seedRun({ id: 'six-days', completedAt: NOW - 6 * DAY });
    f.seedSession('s1', NOW - POWER_THRESHOLDS.sleepMs);
    await runTick(f.env, NOW);
    expect(f.sqlite.query(`SELECT id FROM agent_runs`).all().map((r) => (r as { id: string }).id)).toEqual(['six-days']);
    f.setting('agent.run_retention_days', 0);
    f.seedRun({ id: 'one-day', completedAt: NOW - DAY - 1 });
    f.seedRun({ id: 'hours', completedAt: NOW - 3_600_000 });
    await runTick(f.env, NOW);
    expect(f.sqlite.query(`SELECT id FROM agent_runs ORDER BY id`).all().map((r) => (r as { id: string }).id)).toEqual(['hours']);
  });

  it('touches at most one batch per wake and continues on the next', async () => {
    const f = fixture();
    for (let i = 0; i < JOB_BATCH + 5; i++) f.seedRun({ id: `r${String(i).padStart(4, '0')}`, completedAt: NOW - 40 * DAY });
    f.seedSession('s1', NOW - POWER_THRESHOLDS.sleepMs);
    expect((await runTick(f.env, NOW)).jobs[0]).toEqual({ name: 'agent-run-retention', changed: JOB_BATCH, failed: null });
    expect((await runTick(f.env, NOW)).jobs[0]).toEqual({ name: 'agent-run-retention', changed: 5, failed: null });
    expect(f.count('agent_runs')).toBe(0);
  });
});

describe('run-stale-sweep', () => {
  it('fails a live run past its bound plus the margin by name, releases what it held, and leaves a run inside its bound', async () => {
    const f = fixture();
    const credential = seedCredential(f.sqlite, { id: 'mt_run', memberId: 'mem_harness', machineId: 'harness' });
    const bound = JSON.stringify({ session_id: 's', timeoutSeconds: 300 });
    f.seedRun({ id: 'stale', status: 'running', startedAt: NOW - 300_000 - RUN_OVERRUN_MARGIN_MS - 1, completedAt: null, runContext: bound, dispatchedBy: credential });
    f.seedRun({ id: 'stale-pending', status: 'pending', startedAt: NOW - 400_000 - RUN_OVERRUN_MARGIN_MS, completedAt: null, runContext: null });
    f.seedRun({ id: 'inside', status: 'running', startedAt: NOW - 300_000, completedAt: null, runContext: bound });
    f.seedRun({ id: 'default-bound', status: 'running', startedAt: NOW - DEFAULT_DISPATCH_TIMEOUT_SECONDS * 1000 - RUN_OVERRUN_MARGIN_MS + 1_000, completedAt: null, runContext: null });
    f.seedSession('s1', NOW - POWER_THRESHOLDS.sleepMs);
    const report = await runTick(f.env, NOW);
    expect(report.jobs.find((j) => j.name === 'run-stale-sweep')).toEqual({ name: 'run-stale-sweep', changed: 2, failed: null });
    expect(f.runRow('stale')).toEqual({ status: 'failed', error: STALE_RUN_ERROR, completedAt: NOW });
    expect(f.runRow('stale-pending')).toEqual({ status: 'failed', error: STALE_RUN_ERROR, completedAt: NOW });
    expect(f.runRow('inside')?.status).toBe('running');
    expect(f.runRow('default-bound')?.status).toBe('running');
    expect(f.ended.sort()).toEqual(['stale', 'stale-pending']);
    expect((f.sqlite.query(`SELECT revoked_at FROM member_credentials WHERE id = ?`).get(credential) as { revoked_at: number | null }).revoked_at).toBe(NOW);
    expect((await runTick(f.env, NOW)).jobs.find((j) => j.name === 'run-stale-sweep')).toEqual({ name: 'run-stale-sweep', changed: 0, failed: null });
  });

  it('never ends a credential that is a person\'s own: a run claimed under it is failed, the credential stays live', async () => {
    const f = fixture();
    const own = seedCredential(f.sqlite, { id: 'mt_person', memberId: 'mem_machine_2', machineId: 'machine_2' });
    f.seedRun({ id: 'stale-own', status: 'running', startedAt: NOW - 10 * DAY, completedAt: null, dispatchedBy: own });
    f.seedSession('s1', NOW - POWER_THRESHOLDS.sleepMs);
    expect((await runTick(f.env, NOW)).jobs.find((j) => j.name === 'run-stale-sweep')).toEqual({ name: 'run-stale-sweep', changed: 1, failed: null });
    expect(f.runRow('stale-own')?.status).toBe('failed');
    expect((f.sqlite.query(`SELECT revoked_at FROM member_credentials WHERE id = ?`).get(own) as { revoked_at: number | null }).revoked_at).toBeNull();
  });

  it('leaves a run that landed terminal between its read and its write exactly as it landed', async () => {
    const f = fixture();
    f.seedRun({ id: 'racing', status: 'running', startedAt: NOW - 10 * DAY, completedAt: null });
    f.seedSession('s1', NOW - POWER_THRESHOLDS.sleepMs);
    const racing: ServerEnv = { ...f.env, db: { ...f.env.db, prepare: (sql: string) => {
      if (sql.includes(`SET status = 'failed'`)) f.sqlite.query(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE id = 'racing'`).run(NOW - 1);
      return f.env.db.prepare(sql);
    } } };
    expect((await runTick(racing, NOW)).jobs.find((j) => j.name === 'run-stale-sweep')).toEqual({ name: 'run-stale-sweep', changed: 0, failed: null });
    expect(f.runRow('racing')).toEqual({ status: 'completed', error: null, completedAt: NOW - 1 });
    expect(f.ended).toEqual([]);
  });

  it('holds the Deployment at idle for one run inside its bound however many stale runs sit ahead of it', async () => {
    const f = fixture();
    for (let i = 0; i < JOB_BATCH + 1; i++) f.seedRun({ id: `stale-${String(i).padStart(4, '0')}`, status: 'running', startedAt: NOW - 10 * DAY - i, completedAt: null });
    f.seedRun({ id: 'inside', status: 'running', startedAt: NOW - POWER_THRESHOLDS.deepSleepMs, completedAt: null, runContext: JSON.stringify({ timeoutSeconds: 7_200 }) });
    f.seedSession('s1', NOW - POWER_THRESHOLDS.deepSleepMs);
    expect(await runTick(f.env, NOW)).toMatchObject({ state: 'idle', heldBy: 'run:live' });
  });

  it('keeps sweeping when a container release throws: the row and the credential still land', async () => {
    const f = fixture();
    f.env.harnessEnd = async () => { throw new Error('gone'); };
    f.seedRun({ id: 'stale', status: 'running', startedAt: NOW - 10 * DAY, completedAt: null });
    f.seedSession('s1', NOW - POWER_THRESHOLDS.sleepMs);
    expect((await runTick(f.env, NOW)).jobs.find((j) => j.name === 'run-stale-sweep')).toEqual({ name: 'run-stale-sweep', changed: 1, failed: null });
    expect(f.runRow('stale')?.status).toBe('failed');
  });
});

describe('a job that throws', () => {
  it('is reported by its failure class and does not stop the jobs after it', async () => {
    const f = fixture();
    f.seedSession('s1', NOW - POWER_THRESHOLDS.sleepMs);
    const broken: ServerEnv = { ...f.env, db: { prepare: (sql: string) => (sql.includes('resumable = 0 AND') ? { bind: () => ({ run: async () => { throw new Error('D1_ERROR: nope'); }, all: async () => { throw new Error('D1_ERROR: nope'); }, first: async () => { throw new Error('D1_ERROR: nope'); } }) } : f.env.db.prepare(sql)) as never, batch: f.env.db.batch } };
    const report = await runTick(broken, NOW);
    expect(report.jobs.map((j) => j.name)).toEqual(SERVER_JOBS.filter((j) => j.runsThrough !== 'idle').map((j) => j.name));
    expect(report.jobs[0]).toMatchObject({ name: 'agent-run-retention', failed: expect.any(String) });
    expect(report.jobs[1]).toEqual({ name: 'run-stale-sweep', changed: 0, failed: null });
  });
});

/**
 * The clock's alarm, and the mode that keeps none.
 *
 * A Deployment's clock arms the next alarm from each tick's answer, so one wake
 * produces the next. A target driving ticks by route needs its ticks to be
 * exactly the wakes it posts: an alarm firing between two assertions is a tick
 * nobody asked for, and the scenario reads its effects as its own.
 */
describe('what a clock arms', () => {
  const store = () => {
    const calls: string[] = [];
    let alarm: number | null = null;
    return {
      calls,
      get alarm() { return alarm; },
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => { calls.push(`set ${at}`); alarm = at; },
      deleteAlarm: async () => { calls.push('delete'); alarm = null; },
    };
  };

  it('holds the instant the tick asked for, and none for deep sleep', async () => {
    const automatic = store();
    await armNextWake(automatic, {}, 1_000, 60_000);
    expect(automatic.calls).toEqual(['set 61000']);

    const sleeping = store();
    await armNextWake(sleeping, {}, 1_000, null);
    expect(sleeping.calls).toEqual(['delete']);
  });

  it('arms nothing at all when the clock is the caller\'s to drive', async () => {
    expect(clockArmsAlarms({ CLOCK_MODE: CLOCK_MANUAL })).toBe(false);
    expect(clockArmsAlarms({})).toBe(true);

    const manual = store();
    await armNextWake(manual, { CLOCK_MODE: CLOCK_MANUAL }, 1_000, 60_000);
    // No alarm is set, and any alarm left behind goes.
    expect(manual.calls).toEqual(['delete']);
    expect(manual.alarm).toBeNull();

    await armSoon(manual, { CLOCK_MODE: CLOCK_MANUAL }, 1_000);
    expect(manual.calls).toEqual(['delete']);
  });

  it('wakes soon on a clock holding no alarm, and leaves one that is already set', async () => {
    const empty = store();
    await armSoon(empty, {}, 1_000);
    expect(empty.calls).toEqual(['set 2000']);

    await armSoon(empty, {}, 5_000);
    expect(empty.calls).toEqual(['set 2000']);
  });

  it('refuses a manual clock beside a runtime that starts real containers', () => {
    expect(() => serverEnvFromBindings({ ...sqliteEnv().env, CLOCK_MODE: CLOCK_MANUAL, HARNESS: {} } as never))
      .toThrow(/CLOCK_MODE=manual is refused beside a bound HARNESS/);
  });
});
