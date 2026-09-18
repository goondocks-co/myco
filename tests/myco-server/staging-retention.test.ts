/**
 * Which staged recovery payloads a Deployment keeps, and what the job that releases them asks for.
 *
 * Selection is pure, so the policy is under test here without a store: what survives, what goes, and in what
 * order. The producer is a stand-in that records the requests it receives; the deletion itself, its ordering and
 * its tombstone are proven against the real Durable Object and bucket in the runtime harness.
 *
 * The one case an owner feels is the last good staging: at every policy value, including one, a complete staging
 * survives the attempt that would replace it.
 */
import { expect, it } from 'bun:test';
import { runTick } from '@myco-server-worker/core/tick.js';
import { jobRunsAt, SERVER_JOBS } from '@myco-server-worker/core/jobs.js';
import { acquireRecoveryHold, releaseRecoveryHold } from '@myco-server-worker/core/object-release.js';
import {
  keptStagings, KEEP_STAGINGS_DEFAULT, KEEP_STAGINGS_SETTING, PRUNE_FILE_BUDGET, prunableStagings,
  stagingPruneDue, stagingPrunePolicy, STAGING_RETENTION_JOB, type RetainedStaging,
} from '@myco-server-worker/core/staging-retention.js';
import type { StagingPrunePolicy, StagingPruneRequest } from '@myco-server-worker/core/recovery-producer.js';
import { stampRequest } from '@myco-server-worker/core/activity.js';
import { sqliteEnv } from './helpers/fixtures.js';

/** One attempt as retention reads it, with nothing of it released yet. */
const attempt = (id: number, stage: string, holdToken: string | null = null, pruneStartedAt: number | null = null): RetainedStaging =>
  ({ id, stage, holdToken, pruneStartedAt });

const complete = (...ids: number[]): RetainedStaging[] => ids.map((id) => attempt(id, 'complete'));

it('keeps the newest complete stagings the policy names, and releases the older ones oldest first', () => {
  const rows = complete(1, 2, 3, 4);
  expect(prunableStagings(rows, 2)).toEqual([1, 2]);
  expect(prunableStagings(rows, 3)).toEqual([1]);
  expect(prunableStagings(rows, 4)).toEqual([]);
  expect(prunableStagings(rows, 9)).toEqual([]);
});

it('counts the newest complete staging toward the policy, and keeps one at every value', () => {
  // One is the floor: a value below it is clamped rather than obeyed, so no policy releases the last good staging.
  for (const keep of [1, 0, -4, 0.5]) expect(prunableStagings(complete(1, 2, 3), keep)).toEqual([1, 2]);
  expect(prunableStagings(complete(7), 1)).toEqual([]);
});

it('keeps the last good staging while the attempt that would replace it is still running', () => {
  // The ordinary cadence: yesterday's complete staging and today's attempt, at the tightest policy there is.
  for (const stage of ['export', 'download', 'inventory', 'copy', 'unconfirmed', 'failed']) {
    expect(prunableStagings([attempt(1, 'complete'), attempt(2, stage)], 1)).toEqual([]);
  }
});

it('keeps the newest failed staging for diagnostics and releases the older failed payloads', () => {
  const rows = [attempt(1, 'failed'), attempt(2, 'failed'), attempt(3, 'failed'), attempt(4, 'complete')];
  expect(prunableStagings(rows, 2)).toEqual([1, 2]);
  // A failure bounds itself against the failures, not against the complete stagings the policy counts.
  expect(prunableStagings(rows, 1)).toEqual([1, 2]);
});

it('releases nothing whose state says its payload is still wanted', () => {
  const rows = [
    attempt(1, 'complete'), attempt(2, 'complete'),
    attempt(3, 'export'), attempt(4, 'download'), attempt(5, 'inventory'), attempt(6, 'copy'),
    attempt(7, 'unconfirmed'), attempt(8, 'downloaded'), attempt(9, 'complete'),
  ];
  // Advancing, publication-uncertain and legacy download-only attempts are none of retention's business.
  expect(prunableStagings(rows, 1)).toEqual([1, 2]);
});

it('releases nothing carrying a hold the Deployment holds open', () => {
  const rows = [attempt(1, 'complete', 'tok-1'), attempt(2, 'complete', 'tok-2'), attempt(3, 'complete', 'tok-3')];
  expect(prunableStagings(rows, 1, ['tok-1'])).toEqual([2]);
  expect(prunableStagings(rows, 1, ['tok-1', 'tok-2'])).toEqual([]);
});

it('selects no attempt whose release already began, so a resumed one is never counted twice', () => {
  const rows = [attempt(1, 'complete', null, 5_000), attempt(2, 'complete'), attempt(3, 'complete'), attempt(4, 'complete')];
  expect(prunableStagings(rows, 1)).toEqual([2, 3]);
});

/** A Deployment with a producer that records what retention asks of it. */
async function deployment(options: { keep?: number | string; pending?: number; refuse?: string; hang?: boolean } = {}) {
  const fixture = sqliteEnv();
  if (options.keep !== undefined) {
    fixture.sqlite.query('INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 1, \'mem_machine_1\')')
      .run(KEEP_STAGINGS_SETTING, JSON.stringify(options.keep));
  }
  const asked: StagingPruneRequest[] = [];
  const read: StagingPrunePolicy[] = [];
  let pending = options.pending ?? 0;
  const port = {
    admission: { ready: true as const },
    admit: async () => { throw new Error('this test admits nothing'); },
    settleHold: async () => ({ state: 'retired' as const }),
    status: async () => { throw new Error('this test reads no status'); },
    noteSchemaDrift: async () => { throw new Error('this test fails no attempt'); },
    pendingStagingPrunes: async (policy: StagingPrunePolicy) => {
      read.push(policy);
      if (options.hang === true) return new Promise<number>(() => {});
      return pending;
    },
    pruneStagings: async (request: StagingPruneRequest) => {
      asked.push(request);
      const released = options.refuse === undefined ? Math.min(pending, 1) : 0;
      pending -= released;
      return {
        releasedFiles: released * 3, releasedStagings: released, pending,
        refused: options.refuse ?? null,
      };
    },
  };
  const env = { ...fixture.serverEnv, recovery: port } as never as Parameters<typeof stagingPruneDue>[0];
  return { fixture, env, asked, read, close: () => fixture.sqlite.close() };
}

/** The retention job alone, through the canonical tick on a clock wake. */
const runRetention = async (env: never, now: number): Promise<number> => {
  await stampRequest((env as unknown as { db: Parameters<typeof stampRequest>[0] }).db, now);
  const report = await runTick(env, now, { wake: 'clock' });
  const job = report.jobs.find((entry) => entry.name === STAGING_RETENTION_JOB);
  expect(job?.failed ?? null).toBe(null);
  return job?.changed ?? 0;
};

it('declares its job in the canonical registry, on the clock and never in deep sleep', () => {
  const job = SERVER_JOBS.find((entry) => entry.name === STAGING_RETENTION_JOB);
  expect([job?.runsThrough ?? null, job?.wake ?? null]).toEqual(['sleep', 'clock']);
  expect(jobRunsAt(STAGING_RETENTION_JOB, 'deep_sleep')).toBe(false);
});

it('never runs on a request wake, so ordinary traffic deletes nothing', async () => {
  const d = await deployment({ pending: 2 });
  try {
    await stampRequest((d.env as unknown as { db: Parameters<typeof stampRequest>[0] }).db, 1_000);
    const report = await runTick(d.env as never, 1_000);
    expect(report.jobs.some((entry) => entry.name === STAGING_RETENTION_JOB)).toBe(false);
    expect(d.asked).toEqual([]);
    expect(await runRetention(d.env as never, 1_000)).toBe(1);
  } finally { d.close(); }
});

it('asks for the default policy where the leaf holds no value, rather than leaving cleanup off', async () => {
  const d = await deployment({ pending: 3 });
  try {
    expect(await keptStagings((d.env as unknown as { db: Parameters<typeof keptStagings>[0] }).db)).toBe(KEEP_STAGINGS_DEFAULT);
    expect(await runRetention(d.env as never, 1_000)).toBe(1);
    expect(d.asked).toEqual([{ keep: KEEP_STAGINGS_DEFAULT, protect: [], budget: PRUNE_FILE_BUDGET }]);
  } finally { d.close(); }
});

it('reads the leaf as a count, clamped to the one staging the floor keeps', async () => {
  for (const [stored, expected] of [[1, 1], [5, 5], [0, 1], [-2, 1], ['two', 2], [3.7, 3]] as Array<[number | string, number]>) {
    const d = await deployment({ keep: stored });
    try {
      expect(await keptStagings((d.env as unknown as { db: Parameters<typeof keptStagings>[0] }).db)).toBe(expected);
    } finally { d.close(); }
  }
});

it('protects the holds this Deployment holds open, and stops protecting a released one', async () => {
  const d = await deployment({ keep: 1 });
  try {
    const db = (d.env as unknown as { db: Parameters<typeof acquireRecoveryHold>[0] }).db;
    await acquireRecoveryHold(db, 'tok-producer', 1_000);
    await acquireRecoveryHold(db, 'tok-operator', 1_000, 'operator');
    const policy = await stagingPrunePolicy(d.env as never);
    expect([policy.keep, [...policy.protect].sort()]).toEqual([1, ['tok-operator', 'tok-producer']]);

    await releaseRecoveryHold(db, 'tok-producer', 2_000, 'retired');
    expect((await stagingPrunePolicy(d.env as never)).protect).toEqual(['tok-operator']);
  } finally { d.close(); }
});

it('carries the protected tokens and the budget into the request the producer receives', async () => {
  const d = await deployment({ keep: 4, pending: 1 });
  try {
    await acquireRecoveryHold((d.env as unknown as { db: Parameters<typeof acquireRecoveryHold>[0] }).db, 'tok-producer', 1_000);
    expect(await runRetention(d.env as never, 2_000)).toBe(1);
    expect(d.asked).toEqual([{ keep: 4, protect: ['tok-producer'], budget: PRUNE_FILE_BUDGET }]);
  } finally { d.close(); }
});

it('leaves a refused pass to the next wake without failing the job', async () => {
  const d = await deployment({ pending: 2, refuse: 'the store refused a delete' });
  try {
    expect(await runRetention(d.env as never, 1_000)).toBe(0);
    expect(await runRetention(d.env as never, 2_000)).toBe(0);
    expect(d.asked.length).toBe(2);
  } finally { d.close(); }
});

it('runs on a Deployment nobody has touched while payloads wait, and deep sleep still runs nothing', async () => {
  // No activity stamped at all, so inactivity alone would put this Deployment in deep sleep, where nothing runs.
  const d = await deployment({ pending: 1 });
  try {
    expect(await stagingPruneDue(d.env as never)).toBe(true);
    const report = await runTick(d.env as never, 1_000, { wake: 'clock' });
    expect([report.state, report.heldBy]).toEqual(['sleep', 'recovery:prune']);
    const job = report.jobs.find((entry) => entry.name === STAGING_RETENTION_JOB);
    expect([job?.changed ?? null, job?.failed ?? null]).toEqual([1, null]);

    // Nothing holds it awake once the last payload has gone.
    expect(await stagingPruneDue(d.env as never)).toBe(false);
    expect((await runTick(d.env as never, 2_000, { wake: 'clock' })).state).toBe('deep_sleep');
  } finally { d.close(); }
});

it('asserts nothing on a Deployment whose producer cannot answer, and says so rather than staying silent', async () => {
  const hung = await deployment({ hang: true, pending: 4 });
  const logged: string[] = [];
  const console_log = console.log;
  console.log = (line: string) => { logged.push(String(line)); };
  try {
    expect(await stagingPruneDue(hung.env as never, 25)).toBe(false);
  } finally { console.log = console_log; hung.close(); }
  // A producer that cannot answer reads as an unanswered producer, not as a Deployment with no cleanup owing.
  const events = logged.map((line) => JSON.parse(line) as { kind: string; error_class?: string })
    .filter((event) => event.kind === 'recovery_prune_unreadable');
  expect(events.length).toBe(1);
  expect(typeof events[0]!.error_class).toBe('string');

});

it('asserts nothing on a Deployment that runs no producer', async () => {
  const fixture = sqliteEnv();
  try {
    expect(await stagingPruneDue({ ...fixture.serverEnv, recovery: undefined } as never)).toBe(false);
  } finally { fixture.sqlite.close(); }
});
