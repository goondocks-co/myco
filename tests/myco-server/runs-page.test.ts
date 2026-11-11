/**
 * The Runs page's reads (`/api/runs/hours`, `/api/runs/finished`): each finished run counted once in its hour under the
 * runner that ran it, failures grouped with the window before for a trend, the finished runs paged and filtered (runs
 * that recorded no runner included), each run counted once however its finish and catch-up pages meet, the runs mark
 * moved as the catch-up counts, and hours older than the kept window dropped by the wake.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { catchUpPhase, catchUpProjections, resetProjectionCatchup } from '@myco-server-worker/db/projections/catchup.js';
import { RUN_HOUR_RETENTION_MS } from '@myco-server-worker/db/runs/run-hours.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR + HOUR / 2;
type Answer = Record<string, any>;

function fixture() {
  const f = sqliteEnv();
  f.sqlite.run("INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('agent', 'agent', 'built-in', 1, 1)");
  for (const [id, name] of [['rn_mini', 'homelab-mini'], ['rn_vm', 'cloud-vm-1']]) {
    f.sqlite.run('INSERT INTO runners (id, name, created_at) VALUES (?, ?, 1)', [id, name]);
    f.sqlite.run(`INSERT INTO runner_credentials (id, runner_id, token_hash, epoch, issued_at, expires_at, lineage_root) VALUES (?, ?, ?, 1, 1, ?, ?)`, [`rc_${id}`, id, `hash_${id}`, NOW + HOUR, `rc_${id}`]);
  }
  /** A run that waited a minute, started at `at`, ran by `runner` and finished in `status` with `code`. */
  const run = (id: string, at: number, status: string, runner: string | null, over: { code?: string; harness?: string; task?: string } = {}) => {
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, harness, error_code, queued_at, started_at, completed_at, leased_runner_id, leased_runner_credential_id)
      VALUES ('proj_1', ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, over.task ?? 'embedding-reconcile', status, over.harness ?? 'claude-code', over.code ?? null,
      at - 60_000, at, status === 'running' ? null : at + 1_000, runner, runner === null ? null : `rc_${runner}`]);
  };
  const get = async (path: string): Promise<Answer> => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(f.db, Date.now()), 'cf-connecting-ip': '1.2.3.4' } }), { ...f.env, ...OWNER_ENV });
    expect(res.status).toBe(200);
    return await res.json() as Answer;
  };
  return { ...f, run, get };
}

describe('the Runs page', () => {
  it('counts each finished run once in its hour under its runner, groups failures with a trend, and pages the runs that finished', async () => {
    const f = fixture();
    f.run('ok_1', NOW - 3 * HOUR, 'completed', 'rn_mini');
    f.run('stale_1', NOW - 2 * HOUR, 'failed', 'rn_mini', { code: 'machine_unresponsive' });
    f.run('stale_2', NOW - HOUR, 'running', 'rn_mini');
    f.sqlite.run("UPDATE agent_runs SET status = 'failed', error_code = 'machine_unresponsive', completed_at = ? WHERE id = 'stale_2'", [NOW - HOUR + 1_000]);
    f.sqlite.run("UPDATE agent_runs SET error = 'stopped' WHERE id = 'stale_2'");
    f.run('lapsed', NOW - 2 * HOUR, 'failed', 'rn_vm', { code: 'lease_lapsed', harness: 'opencode' });
    f.run('earlier', NOW - 30 * HOUR, 'failed', 'rn_mini', { code: 'machine_unresponsive' });

    const day = await f.get('/api/runs/hours?window=day');
    expect(day.totals).toEqual({ worked: 0, unchanged: 1, failed: 3, waitedMs: 4 * 60_000 });
    expect(day.lanes.map((lane: Answer) => [lane.name, lane.hours.reduce((n: number, h: Answer) => n + h.unchanged + h.failed, 0)])).toEqual([['cloud-vm-1', 1], ['homelab-mini', 3]]);
    expect(day.failures.cause.map((g: Answer) => [g.key, g.runs, g.prior])).toEqual([['machine_unresponsive', 2, 1], ['lease_lapsed', 1, 0]]);
    expect(day.failures.runner.map((g: Answer) => [g.name, g.runs, g.prior])).toEqual([['homelab-mini', 2, 1], ['cloud-vm-1', 1, 0]]);
    expect(day.failures.agent.map((g: Answer) => [g.key, g.runs])).toEqual([['claude-code', 2], ['opencode', 1]]);
    expect(day.failures.cause[0].slices.reduce((a: number, b: number) => a + b, 0)).toBe(2);

    const failed = await f.get('/api/runs/finished?outcome=failed&runner=rn_mini&limit=1');
    expect(failed.rows.map((row: Answer) => [row.runId, row.runner?.name, row.errorCode])).toEqual([['stale_2', 'homelab-mini', 'machine_unresponsive']]);
    const next = await f.get(`/api/runs/finished?outcome=failed&runner=rn_mini&limit=1&cursor=${encodeURIComponent(failed.cursor)}`);
    expect(next.rows.map((row: Answer) => row.runId)).toEqual(['stale_1']);
    expect(next.cursor).toBeNull();
    expect((await f.get('/api/runs/finished?window=week&cause=machine_unresponsive')).rows.map((row: Answer) => row.runId)).toEqual(['stale_2', 'stale_1', 'earlier']);
  });

  it('counts each run once however its finish and catch-up pages meet, moves the runs mark as it counts, and the wake drops hours past the kept window', async () => {
    const f = fixture();
    const mark = () => (f.sqlite.query("SELECT revision FROM change_marks WHERE kind='runs'").get() as { revision: number }).revision;
    f.run('before_1', NOW - 3 * HOUR, 'completed', 'rn_mini');
    f.run('before_2', NOW - 2 * HOUR, 'failed', 'rn_vm', { code: 'lease_lapsed' });
    const counted = (await f.get('/api/runs/hours')).totals;
    await resetProjectionCatchup(f.db);
    // A run finishing after the restart, at the same instant as an earlier one and sorting before it.
    f.run('a_during', NOW - 2 * HOUR, 'completed', 'rn_mini');
    expect((await f.get('/api/runs/hours')).counted).toBe(false);
    const before = mark();
    // Two wakes take the same first page before either moves the cursor.
    await Promise.all([catchUpPhase(f.db, 'runHours', Date.now()), catchUpPhase(f.db, 'runHours', Date.now())]);
    while ((await catchUpProjections(f.db)).more);
    expect(mark()).toBeGreaterThan(before);
    const after = await f.get('/api/runs/hours');
    expect(after.counted).toBe(true);
    expect(after.totals).toEqual({ ...counted, unchanged: counted.unchanged + 1, waitedMs: counted.waitedMs + 60_000 });

    f.run('nobody', NOW - 4 * HOUR, 'failed', null, { code: 'run_cancelled' });
    expect((await f.get('/api/runs/finished?noRunner=1')).rows.map((row: Answer) => [row.runId, row.runner])).toEqual([['nobody', null]]);

    f.run('ancient', NOW - RUN_HOUR_RETENTION_MS - 2 * HOUR, 'completed', 'rn_mini');
    f.run('edge', NOW - RUN_HOUR_RETENTION_MS + HOUR / 4, 'completed', 'rn_mini');
    const hours = () => f.sqlite.query('SELECT hour FROM run_hour').all().map((row) => (row as { hour: number }).hour);
    expect(Math.min(...hours())).toBeLessThan(NOW - RUN_HOUR_RETENTION_MS);
    await runTick(f.serverEnv as never, NOW);
    expect(Math.min(...hours())).toBe(NOW - RUN_HOUR_RETENTION_MS - HOUR / 2);
  });
});
