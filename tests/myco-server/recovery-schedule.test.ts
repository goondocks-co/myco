/**
 * What "Back up every" actually drives, and what an owner is told about it.
 *
 * The interval is the only input: unset schedules nothing, and a Deployment with no producer schedules nothing
 * whatever the setting says. What decides due is the last attempt's own start, so these tests move the clock
 * rather than any schedule state, and assert that a duplicate wake in the same window admits nothing twice.
 *
 * The producer is a stand-in; its own behaviour is proven in its own suites. What is under test here is the
 * scheduling decision, the no-overlap guarantee, and whether the status a dashboard reads is true.
 */
import { expect, it } from 'bun:test';
import { runTick } from '@myco-server-worker/core/tick.js';
import { jobRunsAt, SERVER_JOBS } from '@myco-server-worker/core/jobs.js';
import { handleRecoveryExportStatus } from '@myco-server-worker/api/recovery.js';
import { recoveryScheduleOf, scheduledIntervalHours, SCHEDULE_JOB } from '@myco-server-worker/core/recovery-schedule.js';
import { SCHEDULED_BY } from '@myco-server-worker/core/recovery-admission.js';
import { settlementOf, type AttemptStage, type RecoveryAdmission, type RecoveryAdmissionReadiness, type RecoveryProducerStatus } from '@myco-server-worker/core/recovery-producer.js';
import { stampRequest } from '@myco-server-worker/core/activity.js';
import { sqliteEnv } from './helpers/fixtures.js';

const HOUR = 60 * 60 * 1000;

const idle: RecoveryProducerStatus = {
  attempt: null, stage: 'idle', startedAt: null, recoverable: false, staged: null, export: null, error: null,
  transientSpent: 0, stagedSchema: null,
};

/** A producer that records each admission and answers the status a test puts in front of it. */
function producer(now: number) {
  const seen: RecoveryAdmission[] = [];
  let status: RecoveryProducerStatus = idle;
  const carried = new Map<string, { id: number; stage: AttemptStage }>();
  return {
    seen,
    set: (next: Partial<RecoveryProducerStatus>) => { status = { ...idle, ...next }; },
    port: {
      admission: { ready: true } as RecoveryAdmissionReadiness,
      admit: async (admission: RecoveryAdmission) => {
        seen.push(admission);
        // An admitted attempt starts now and holds the hold, exactly as the real producer records it.
        status = { ...idle, attempt: seen.length, stage: 'export' as const, startedAt: now };
        carried.set(admission.holdToken, { id: seen.length, stage: 'export' });
        return status;
      },
      settleHold: async (token: string) => settlementOf(carried.get(token) ?? null),
      status: async () => status,
      noteSchemaDrift: async () => status,
    },
  };
}

/**
 * A Deployment with a producer and a clock this test controls.
 *
 * Its activity is stamped at each instant a tick runs: a Deployment nobody has touched for hours is in deep
 * sleep, where no job of any kind runs. Sleep is where this job runs; deep sleep is where nothing does.
 */
async function deployment(options: { intervalHours?: number | string; now?: number } = {}) {
  const fixture = sqliteEnv();
  const now = options.now ?? 10 * HOUR;
  const held = producer(now);
  if (options.intervalHours !== undefined) {
    fixture.sqlite.query('INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 1, \'mem_machine_1\')')
      .run('backup.auto_interval_hours', JSON.stringify(options.intervalHours));
  }
  const env = { ...fixture.serverEnv, recovery: held.port, wake: async () => { wakes += 1; } } as never as Parameters<typeof recoveryScheduleOf>[0];
  let wakes = 0;
  return { fixture, env, held, now, wakes: () => wakes, close: () => fixture.sqlite.close() };
}

/** Keeps the Deployment out of deep sleep at `now`, where no job of any kind runs. */
const awake = async (env: never, now: number): Promise<void> => {
  await stampRequest((env as unknown as { db: Parameters<typeof stampRequest>[0] }).db, now);
};

/**
 * The scheduled job alone, through the canonical tick on a clock wake.
 *
 * The job is declared `wake: 'clock'`, so ordinary request traffic never reaches it: a Deployment does not start
 * a 389 MB export off someone loading a page. The first test below holds that.
 */
const runSchedule = async (env: never, now: number): Promise<number> => {
  await awake(env, now);
  const report = await runTick(env, now, { wake: 'clock' });
  const job = report.jobs.find((entry) => entry.name === SCHEDULE_JOB);
  expect(job?.failed ?? null).toBe(null);
  return job?.changed ?? 0;
};

/** Whether a request-driven tick runs the schedule at all. */
const ranOnRequestWake = async (env: never, now: number): Promise<boolean> => {
  await awake(env, now);
  return (await runTick(env, now)).jobs.some((entry) => entry.name === SCHEDULE_JOB);
};

it('declares its job in the canonical registry, so the clock runs it', () => {
  expect(SERVER_JOBS.some((job) => job.name === SCHEDULE_JOB)).toBe(true);
});

it('never runs on a request wake, so ordinary traffic starts no export', async () => {
  const d = await deployment({ intervalHours: 6 });
  try {
    expect(await ranOnRequestWake(d.env as never, d.now)).toBe(false);
    expect(d.held.seen).toEqual([]);
    // The same instant on a clock wake does admit one, so the difference is the wake and nothing else.
    expect(await runSchedule(d.env as never, d.now)).toBe(1);
  } finally { d.close(); }
});

it('reads the interval as hours, and treats anything unusable as off', async () => {
  for (const [stored, expected] of [[6, 6], [1, 1], [720, 720], [1000, 720], [0, null], [-4, null], ['soon', null], [2.7, 2]] as Array<[number | string, number | null]>) {
    const d = await deployment({ intervalHours: stored });
    try {
      expect(await scheduledIntervalHours(d.env as never)).toBe(expected as never);
    } finally { d.close(); }
  }
  const none = await deployment();
  try { expect(await scheduledIntervalHours(none.env as never)).toBe(null); } finally { none.close(); }
});

it('schedules nothing while the interval is unset, and says so in as many words', async () => {
  const d = await deployment();
  try {
    const schedule = await recoveryScheduleOf(d.env as never, d.now);
    expect([schedule.supported, schedule.configured, schedule.due, schedule.dueAt]).toEqual([true, false, false, null]);
    expect(schedule.idleBecause).toContain('automatic recovery is off');
    expect(await runSchedule(d.env as never, d.now)).toBe(0);
    expect(d.held.seen).toEqual([]);
  } finally { d.close(); }
});

it('schedules nothing on a Deployment that runs no producer, whatever the interval says', async () => {
  const d = await deployment({ intervalHours: 6 });
  try {
    const env = { ...(d.env as unknown as Record<string, unknown>), recovery: undefined } as never;
    const schedule = await recoveryScheduleOf(env, d.now);
    expect([schedule.supported, schedule.configured, schedule.due]).toEqual([false, false, false]);
    expect(schedule.idleBecause).toContain('no hosted recovery producer');
    expect(await runSchedule(env, d.now)).toBe(0);
  } finally { d.close(); }
});

it('admits one attempt when the interval is set and nothing has ever run, recording no member for it', async () => {
  const d = await deployment({ intervalHours: 6 });
  try {
    const before = await recoveryScheduleOf(d.env as never, d.now);
    expect([before.configured, before.due, before.dueAt]).toEqual([true, true, d.now]);

    expect(await runSchedule(d.env as never, d.now)).toBe(1);
    expect(d.held.seen.length).toBe(1);
    // Nothing invents a member for a scheduled attempt.
    expect(d.held.seen[0]!.startedBy).toBe(SCHEDULED_BY);
    expect(d.held.seen[0]!.tables.length).toBeGreaterThan(0);
    expect(d.wakes()).toBe(1);
  } finally { d.close(); }
});

it('admits nothing again in the same window, and nothing while that attempt still advances', async () => {
  const d = await deployment({ intervalHours: 6 });
  try {
    expect(await runSchedule(d.env as never, d.now)).toBe(1);
    // An ordinary duplicate wake, moments later.
    expect(await runSchedule(d.env as never, d.now + 1_000)).toBe(0);
    // And again much later, while the attempt is still exporting: it holds the hold, so nothing is due.
    const during = await recoveryScheduleOf(d.env as never, d.now + 48 * HOUR);
    expect([during.due, during.dueAt]).toEqual([false, null]);
    expect(during.idleBecause).toContain('still export');
    expect(await runSchedule(d.env as never, d.now + 48 * HOUR)).toBe(0);
    expect(d.held.seen.length).toBe(1);
  } finally { d.close(); }
});

it('waits out the interval from the last attempt, then admits exactly one more', async () => {
  const d = await deployment({ intervalHours: 6 });
  try {
    d.held.set({ attempt: 1, stage: 'complete', startedAt: d.now, staged: { prefix: 'staging/1', sqlBytes: 10, downloadedBytes: 10, parts: 1, objects: { registered: 1, staged: 1 } } });

    const early = await recoveryScheduleOf(d.env as never, d.now + 5 * HOUR);
    expect([early.due, early.dueAt]).toEqual([false, d.now + 6 * HOUR]);
    expect(await runSchedule(d.env as never, d.now + 5 * HOUR)).toBe(0);
    expect(d.held.seen).toEqual([]);

    const due = await recoveryScheduleOf(d.env as never, d.now + 6 * HOUR);
    expect(due.due).toBe(true);
    expect(await runSchedule(d.env as never, d.now + 6 * HOUR)).toBe(1);
    expect(d.held.seen.length).toBe(1);
  } finally { d.close(); }
});

it('waits the same interval after a failure, and keeps the failure visible', async () => {
  const d = await deployment({ intervalHours: 6 });
  try {
    d.held.set({ attempt: 4, stage: 'failed', startedAt: d.now, error: 'provider_refused' });

    const soon = await recoveryScheduleOf(d.env as never, d.now + HOUR);
    expect(soon.due).toBe(false);
    expect(soon.latest).toEqual({ attempt: 4, stage: 'failed', startedAt: d.now, failure: 'provider_refused' });
    // A failure is not retried at every wake: the interval bounds it.
    expect(await runSchedule(d.env as never, d.now + HOUR)).toBe(0);
    expect(await runSchedule(d.env as never, d.now + 6 * HOUR)).toBe(1);
  } finally { d.close(); }
});

it('never calls a staging recoverable, at any stage', async () => {
  const d = await deployment({ intervalHours: 6 });
  try {
    expect((await recoveryScheduleOf(d.env as never, d.now)).available).toEqual({ state: 'none' });

    d.held.set({ attempt: 2, stage: 'copy', startedAt: d.now, staged: { prefix: 'staging/2', sqlBytes: 1, downloadedBytes: 1, parts: 1, objects: { registered: 2, staged: 1 } } });
    expect((await recoveryScheduleOf(d.env as never, d.now)).available).toEqual({ state: 'incomplete', attempt: 2, stage: 'copy' });

    d.held.set({ attempt: 2, stage: 'complete', startedAt: d.now, staged: { prefix: 'staging/2', sqlBytes: 1, downloadedBytes: 1, parts: 1, objects: { registered: 2, staged: 2 } } });
    const staged = (await recoveryScheduleOf(d.env as never, d.now)).available;
    expect(staged.state).toBe('staged');
    if (staged.state !== 'staged') throw new Error('unreachable');
    expect(staged.prefix).toBe('staging/2');
    // The one thing a complete staging must never be called.
    expect(staged.needs).toContain('materializes');
    expect(JSON.stringify(staged)).not.toContain('recoverable');
  } finally { d.close(); }
});

it('runs at every depth, so a Deployment nobody has touched still gets its due backup', async () => {
  // An owner who sets a daily backup does not visit the dashboard to make it happen. This is the ordinary case:
  // no activity stamped at all, so the clock resolves the deepest state it has.
  const d = await deployment({ intervalHours: 24 });
  try {
    const report = await runTick(d.env as never, d.now, { wake: 'clock' });
    expect(report.state).toBe('deep_sleep');
    const job = report.jobs.find((entry) => entry.name === SCHEDULE_JOB);
    expect([job?.changed ?? null, job?.failed ?? null]).toEqual([1, null]);
    expect(d.held.seen.length).toBe(1);
    expect(jobRunsAt(SCHEDULE_JOB, 'deep_sleep')).toBe(true);
  } finally { d.close(); }
});

it('says so, and admits nothing, when this Deployment cannot admit an attempt at all', async () => {
  const d = await deployment({ intervalHours: 24 });
  try {
    // What a Deployment whose deploy config renders no recovery configuration answers.
    const reason = 'this Deployment carries no recovery configuration; update it so its deploy config renders one';
    (d.held.port as { admission: unknown }).admission = { ready: false, reason };

    const schedule = await recoveryScheduleOf(d.env as never, d.now);
    expect([schedule.supported, schedule.configured, schedule.ready, schedule.due]).toEqual([true, true, false, false]);
    expect(schedule.idleBecause).toContain(reason);
    // No admission is attempted while it cannot run, so nothing refuses on every wake.
    expect(await runSchedule(d.env as never, d.now)).toBe(0);
    expect(d.held.seen).toEqual([]);
  } finally { d.close(); }
});

it('answers the producer status even when the settings read fails under it', async () => {
  const d = await deployment({ intervalHours: 6 });
  try {
    d.held.set({ attempt: 7, stage: 'export', startedAt: d.now });
    // A running export pauses this Deployment's database: the settings read is what fails, not the producer.
    const paused = {
      ...(d.env as unknown as Record<string, unknown>),
      db: { prepare: () => { throw new Error('D1_ERROR: Network connection lost. [code: 7500]'); } },
    } as never;
    const answered = await handleRecoveryExportStatus(paused, { member: { id: 'owner-1' }, now: d.now } as never);
    expect(answered.status).toBe(200);
    const body = await answered.json() as { attempt: number; stage: string; schedule: { unreadable?: string } };
    // The authoritative answer survives; the schedule says it could not be read.
    expect([body.attempt, body.stage]).toEqual([7, 'export']);
    expect(body.schedule.unreadable).toContain('could not be read');
  } finally { d.close(); }
});
