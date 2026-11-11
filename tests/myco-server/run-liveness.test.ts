/**
 * The three liveness facts the Runs page and run panel show, each recorded on the path that already writes beside it
 * and read back through the dashboard's routes:
 * - a renewal of a run's lease records when it renewed, so the panel can measure the silence from it;
 * - a runner's recorded contact counts its check-in in its hour, so the Runs page shows each runner's check-ins;
 * - a claim keeps on the attempt the hold its run waited under and when that stay in the queue began;
 * - every stay in the queue counts as one wait by the hours it began and ended, however the run left the queue: taken,
 *   or expired unclaimed, and a run back in the queue waits again from then,
 *   never through the hours it was running.
 * The wake drops check-in and wait hours past the kept window at the same whole hour as the run counts.
 *
 * Every request goes through the deployed pipeline the way a runner and a dashboard reach it.
 */
import { describe, expect, it } from 'bun:test';
import { runTick } from '@myco-server-worker/core/tick.js';
import { runStaleSweep } from '@myco-server-worker/core/jobs-run.js';
import { expireLeases } from '@myco-server-worker/core/harness.js';
import { RUN_HOUR_RETENTION_MS } from '@myco-server-worker/db/runs/run-hours.js';
import { NOW, runnerRig as rig, type Json } from './helpers/runner-rig.js';

const HOUR = 3_600_000;

describe('liveness on the run panel and the Runs page', () => {
  it('a renewal records when the run last renewed its hold, and the run panel serves it', async () => {
    const r = rig();
    try {
      const { token } = await r.register('mini');
      await r.queueTitling();
      const { run } = await r.claim(token);
      expect(run).toBeDefined();
      expect((await r.get(`/api/projects/proj_1/runs/${run.id}`)).run.lastRenewedAt).toBeNull();
      r.at(r.now() + 40_000);
      expect(await r.asRunner(token, '/worker/lease', { projectId: 'proj_1', runId: run.id, attemptId: run.attemptId })).toMatchObject({ held: true });
      const renewedAt = r.now();
      r.at(r.now() + 30_000);
      expect(await r.asRunner(token, '/worker/lease', { projectId: 'proj_1', runId: run.id })).toMatchObject({ held: false });
      expect((await r.get(`/api/projects/proj_1/runs/${run.id}`)).run.lastRenewedAt).toBe(renewedAt);
    } finally { r.e.sqlite.close(); }
  });

  it('a claim keeps the hold its run waited under on the attempt, and counts the wait by the hours it was queued and taken', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register('mini');
      await r.queueTitling();
      const queuedAt = r.now();
      // While no machine could take it, the queue marked what held it.
      r.e.sqlite.run("UPDATE agent_runs SET held_by = 'budget' WHERE status = 'queued'");
      r.at(queuedAt + 2 * HOUR);
      const { run } = await r.claim(token);
      const detail = await r.get(`/api/projects/proj_1/runs/${run.id}`);
      expect(detail.attempts.map((attempt: Json) => [attempt.attemptId, attempt.waitedFor, attempt.waitedSince])).toEqual([[run.attemptId, 'budget', queuedAt]]);
      expect(detail.run.heldBy).toBeNull();

      const hours = await r.get('/api/runs/hours?window=day');
      const hourOf = (at: number) => at - (at % HOUR);
      expect(hours.waits).toEqual([{ enteredHour: hourOf(queuedAt), leftHour: hourOf(r.now()), taken: true, waits: 1 }]);
      expect(hours.stillWaiting).toEqual([]);
      expect(hours.lanes.find((lane: Json) => lane.runnerId === runnerId).checkins).toEqual([hourOf(r.now())]);
    } finally { r.e.sqlite.close(); }
  });

  it('each recorded check-in counts in its runner’s hour, and the wake drops check-in and wait hours past the kept window', async () => {
    const r = rig();
    try {
      const old = NOW - RUN_HOUR_RETENTION_MS - 2 * HOUR;
      r.at(old);
      const mini = await r.register('mini');
      await r.queueTitling();
      r.at(old + 30 * 60_000);
      expect((await r.claim(mini.token)).claimed).toBe(true);
      // A runner credential lives far shorter than the kept window: the second runner registers a month later.
      r.at(NOW - 4 * HOUR);
      const studio = await r.register('studio');
      r.at(NOW - 3 * HOUR);
      expect((await r.claim(studio.token)).claimed).toBe(false);
      r.at(NOW - HOUR);
      await r.claim(studio.token);
      r.at(NOW);
      const hourOf = (at: number) => at - (at % HOUR);

      const week = await r.get('/api/runs/hours?window=week');
      const lane = (runnerId: string) => week.lanes.find((row: Json) => row.runnerId === runnerId);
      expect(lane(studio.runnerId).checkins).toEqual([hourOf(NOW - 3 * HOUR), hourOf(NOW - HOUR)]);
      expect(lane(studio.runnerId).name).toBe('studio');
      expect(lane(mini.runnerId)).toBeUndefined();
      expect(week.recordedSince).toBe(hourOf(old));

      const waitHours = () => r.e.sqlite.query('SELECT left_hour FROM run_wait_hour').all().map((row) => (row as { left_hour: number }).left_hour);
      expect(waitHours()).toEqual([hourOf(old)]);
      await runTick(r.e.serverEnv as never, NOW);
      expect(waitHours()).toEqual([]);
      const after = await r.get('/api/runs/hours?window=week');
      expect(after.recordedSince).toBe(hourOf(NOW - 3 * HOUR));
      expect(after.lanes.find((row: Json) => row.runnerId === studio.runnerId).checkins).toEqual([hourOf(NOW - 3 * HOUR), hourOf(NOW - HOUR)]);
    } finally { r.e.sqlite.close(); }
  });

  it('a run that waited and expired unclaimed counts as a wait that no machine took', async () => {
    const r = rig();
    try {
      const { token } = await r.register('mini');
      await r.claim(token);
      await r.queueTitling();
      const queuedAt = r.now();
      for (let hour = 1; hour <= 25; hour++) {
        r.at(queuedAt + hour * HOUR);
        await r.asRunner(token, '/runners/contact', {});
      }
      await runStaleSweep(r.e.serverEnv as never, r.now());
      const hourOf = (at: number) => at - (at % HOUR);
      const week = await r.get('/api/runs/hours?window=week');
      expect(week.waits).toEqual([{ enteredHour: hourOf(queuedAt), leftHour: hourOf(r.now()), taken: false, waits: 1 }]);
      expect(week.stillWaiting).toEqual([]);
    } finally { r.e.sqlite.close(); }
  });

  it('a run back in the queue waits again from then, never through the hours it was running', async () => {
    const r = rig();
    try {
      const { token } = await r.register('mini');
      await r.queueTitling();
      const queuedAt = r.now();
      r.at(queuedAt + HOUR);
      const { run } = await r.claim(token);
      // The machine went quiet; three hours later its lapsed lease puts the run back in the queue.
      r.at(queuedAt + 4 * HOUR);
      expect(await expireLeases(r.e.serverEnv as never, r.now())).toBe(1);
      const back = r.now();
      // While it waits again, its current stay is what still waits, not its first.
      expect((await r.get('/api/runs/hours?window=day')).stillWaiting).toEqual([{ since: back, runs: 1 }]);
      r.at(back + 30 * 60_000);
      const again = await r.claim(token);
      expect(again.run.id).toBe(run.id);
      const hourOf = (at: number) => at - (at % HOUR);
      const day = await r.get('/api/runs/hours?window=day');
      expect(day.waits.toSorted((a: Json, b: Json) => a.enteredHour - b.enteredHour)).toEqual([
        { enteredHour: hourOf(queuedAt), leftHour: hourOf(queuedAt + HOUR), taken: true, waits: 1 },
        { enteredHour: hourOf(back), leftHour: hourOf(r.now()), taken: true, waits: 1 },
      ]);
      const detail = await r.get(`/api/projects/proj_1/runs/${run.id}`);
      expect(detail.attempts.map((attempt: Json) => attempt.waitedSince)).toEqual([queuedAt, back]);
    } finally { r.e.sqlite.close(); }
  });
});
