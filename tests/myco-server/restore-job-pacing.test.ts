/**
 * A restore job under the budget a wake really gives it, and what its owner can do with one: it finishes in the
 * tick whatever the artifact's size or what earlier jobs spent, an upload never becomes one of this Deployment's
 * backups, a write landing in an insertion-ordered table mid-restore is reported rather than ending the restore, and
 * a stuck restore can be stopped.
 */
import { describe, expect, it } from 'bun:test';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { createBackup } from '@myco-server-worker/core/backup.js';
import { acceptRestore, acceptUploadedRestore, advanceRestore, latestRestore, restoreJobProgress } from '@myco-server-worker/core/restore-job.js';
import { JOB_IMPLEMENTATIONS } from '@myco-server-worker/core/jobs-run.js';
import { CONTENT_BLOB_LIMIT, CONTENT_WAKE_JOB_RESERVE, CONTENT_WALL_MS, measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { WAKE_JOB_BLOB_LIMIT, WAKE_JOB_STATEMENT_LIMIT } from '@myco-server-worker/core/tick.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { pruneBackups } from '@myco-server-worker/core/backup-retention.js';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import worker from '@myco-server-worker/index.js';
import { asOwner, asOwnerPost, OWNER_ENV } from './helpers/owner.js';
import { eventContent } from '@myco-server-worker/core/event-content.js';
import { artifactOf, bundledBackup, destination, documentDestination, NOW, OWNER, PASS_ROWS, restoredRows, tickUntilEnded, type Fixture } from './helpers/restore-job.js';

const DAY = 86_400_000;

/** One wake as `runJobs` runs it: the restore job inside the wake's measured allowance, less what earlier jobs spent. */
async function wake(f: Fixture, spent: number, blobsSpent = 0): Promise<{ statements: number }> {
  const measured = measuredContentEnv(f.serverEnv, { statements: WAKE_JOB_STATEMENT_LIMIT - spent, blobCalls: WAKE_JOB_BLOB_LIMIT - blobsSpent, wallMs: CONTENT_WALL_MS });
  await JOB_IMPLEMENTATIONS['backup-restore']!(measured.env, NOW, 'sleep', { drainOnly: false });
  return { statements: measured.usage.statements };
}

/** A store whose batches holding a statement that matches `pattern` fail with an error no restore rule names. */
function failing(db: RelationalStore, pattern: RegExp): RelationalStore {
  const sql = new WeakMap<PreparedStatement, string>();
  const originals = new WeakMap<PreparedStatement, PreparedStatement>();
  const wrap = (statement: PreparedStatement, text: string): PreparedStatement => {
    const wrapped: PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values), text),
      first: () => pattern.test(text) ? Promise.reject(new Error('storage offline')) : statement.first(),
      all: () => pattern.test(text) ? Promise.reject(new Error('storage offline')) : statement.all(),
      run: () => pattern.test(text) ? Promise.reject(new Error('storage offline')) : statement.run(),
    };
    sql.set(wrapped, text);
    originals.set(wrapped, statement);
    return wrapped;
  };
  return {
    prepare: (text) => wrap(db.prepare(text), text),
    batch: (statements) => statements.some((s) => pattern.test(sql.get(s) ?? '')) ? Promise.reject(new Error('storage offline'))
      : db.batch(statements.map((s) => originals.get(s) ?? s)),
  };
}

describe('a restore job in the tick', () => {
  for (const [label, reports, events, spent] of [
    ['300 reports', 300, 0, 0], ['1,500 reports', 1_500, 0, 0], ['600 events', 0, 600, 0], ['1,500 reports after earlier jobs spent 350 statements', 1_500, 0, 350],
  ] as const) {
    it(`finishes ${label} within each wake's allowance, every wake moving it on`, async () => {
      const f = await destination();
      await acceptUploadedRestore(f.serverEnv, await artifactOf(reports, events), { allowForeignLineage: true, memberId: OWNER, now: NOW });
      let wakes = 0;
      for (let last = -1; wakes < 200; wakes++) {
        const used = await wake(f, spent);
        expect(used.statements).toBeLessThanOrEqual(WAKE_JOB_STATEMENT_LIMIT - spent);
        const job = (await latestRestore(f.serverEnv))!;
        if (job.state !== 'running') break;
        expect(job.rowsDone, `wake ${wakes}`).toBeGreaterThan(last);
        last = job.rowsDone;
      }
      const job = (await latestRestore(f.serverEnv))!;
      expect({ state: job.state, failure: job.failure }).toEqual({ state: 'complete', failure: null });
      expect(restoredRows(f).reports).toHaveLength(reports);
      expect(restoredRows(f).events).toHaveLength(events);
      if (reports > 0) expect(job.outcome.tables.agent_reports).toEqual({ rows: reports, inserted: reports });
      f.sqlite.close();
    }, 300_000);
  }

  // Archive bundles are the dimension a pass reads objects for: one per session, at sizes either side of what one wake's
  // object reads would cover if a pass read them all and near the largest artifact a Deployment backs up, in full wakes
  // and in wakes where capture left the restore only the reserve every job is run with.
  for (const [sessions, busy] of [[20, false], [150, false], [500, false], [60, true]] as const) {
    it(`finishes ${sessions} archive bundles${busy ? ' in busy wakes' : ''} within each wake's allowance, every wake moving it on, and their events read back`, async () => {
      const backup = await bundledBackup(sessions);
      const f = await documentDestination(backup);
      await acceptUploadedRestore(f.serverEnv, backup.text, { allowForeignLineage: true, memberId: OWNER, now: NOW });
      let wakes = 0;
      for (let last = -1; wakes < 1_000; wakes++) {
        await wake(f, busy ? WAKE_JOB_STATEMENT_LIMIT - CONTENT_WAKE_JOB_RESERVE : 0, busy ? WAKE_JOB_BLOB_LIMIT - CONTENT_BLOB_LIMIT : 0);
        const job = (await latestRestore(f.serverEnv))!;
        if (job.state !== 'running') break;
        expect(job.rowsDone, `wake ${wakes}`).toBeGreaterThan(last);
        last = job.rowsDone;
      }
      const job = (await latestRestore(f.serverEnv))!;
      expect({ state: job.state, failure: job.failure, events: restoredRows(f).events.length }).toEqual({ state: 'complete', failure: null, events: sessions });
      expect(await eventContent(f.serverEnv, 'proj_rs', `ev_${String(sessions - 1).padStart(5, '0')}`)).toBe(`{"body":"ev_${String(sessions - 1).padStart(5, '0')}"}`);
      f.sqlite.close();
    }, 600_000);
  }
});

describe('what an owner can do with a restore', () => {
  it('keeps an upload out of the backup list and retention, and releases its bytes once the restore ends', async () => {
    const source = await destination();
    const text = await artifactOf(10);
    source.sqlite.close();
    const e = await destination();
    for (const [leaf, value] of [['backup.retention.keep_daily', 3], ['backup.retention.keep_weekly', 0]] as const) {
      e.sqlite.run(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES(?,?,1,'m') ON CONFLICT(leaf) DO UPDATE SET value=excluded.value`, [leaf, JSON.stringify(value)]);
    }
    const own: string[] = [];
    for (const age of [3, 2, 1]) own.push((await createBackup(e.db, e.bucket, { producer: 'own', now: NOW - age * DAY })).id);
    const env = { ...e.env, ...OWNER_ENV };
    for (let upload = 0; upload < 3; upload++) {
      const answered = await worker.fetch(await asOwnerPost(e.db, '/api/backups/restore-upload', { artifact: text, allowForeignLineage: true }), env);
      expect(answered.status).toBe(200);
      while ((await catchUpProjections(e.db)).more) { /* week heads */ }
      await pruneBackups(e.db, NOW);
    }
    expect(e.sqlite.query('SELECT id FROM backups ORDER BY created_at').all()).toEqual(own.map((id) => ({ id })));
    const listed = await (await worker.fetch(await asOwner(e.db, '/api/backups'), env)).json() as { backups: { id: string }[] };
    expect(listed.backups.map((row) => row.id).sort()).toEqual([...own].sort());
    await drainObjectReleases(e.serverEnv, NOW + DAY);
    expect([...e.bucket.objects.keys()].filter((key) => key.startsWith('restores/'))).toEqual([]);
    e.sqlite.close();
  });

  it('reports an insertion-ordered table another write landed in mid-restore, and restores everything after it', async () => {
    const f = await destination();
    await acceptUploadedRestore(f.serverEnv, await artifactOf(95), { allowForeignLineage: true, memberId: OWNER, now: NOW });
    for (let at = 0; at < 100 && restoredRows(f).reports.length === 0; at++) await advanceRestore(f.serverEnv, NOW, PASS_ROWS);
    const restoredBefore = restoredRows(f).reports.length;
    expect(restoredBefore).toBeGreaterThan(0);
    expect(restoredBefore).toBeLessThan(95);
    f.sqlite.run(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at) VALUES ('proj_rs', 'run_rs', 'agent_rs', 'note', 'a live report', 2)`);
    await tickUntilEnded(f, PASS_ROWS);
    const job = (await latestRestore(f.serverEnv))!;
    expect(job.state).toBe('complete');
    expect(job.outcome.tables.agent_reports).toMatchObject({ rows: 95, inserted: restoredBefore });
    expect(job.outcome.tables.agent_reports?.skipped).toContain('restore this backup into a Deployment where nothing writes to this table');
    expect(f.sqlite.query(`SELECT summary FROM agent_reports WHERE summary = 'a live report'`).all()).toEqual([{ summary: 'a live report' }]);
    f.sqlite.close();
  });

  it('stops a restore at the owner\'s request, keeping what it restored, and lets the next one start', async () => {
    const f = await destination();
    const env = { ...f.env, ...OWNER_ENV };
    const text = await artifactOf(95);
    const accepted = await acceptUploadedRestore(f.serverEnv, text, { allowForeignLineage: true, memberId: OWNER, now: NOW });
    await advanceRestore(f.serverEnv, NOW, PASS_ROWS);
    const partial = restoredRows(f);
    const stopped = await worker.fetch(await asOwnerPost(f.db, `/api/backups/restores/${accepted.id}/stop`, {}), env);
    expect({ status: stopped.status, body: await stopped.json() }).toMatchObject({ status: 200, body: { job: { state: 'failed', failure: { code: 'stopped' } } } });
    expect(restoredRows(f)).toEqual(partial);
    await advanceRestore(f.serverEnv, NOW, PASS_ROWS);
    expect(restoredRows(f)).toEqual(partial);
    const again = await worker.fetch(await asOwnerPost(f.db, `/api/backups/restores/${accepted.id}/stop`, {}), env);
    const refusal = await again.json() as { error: string; message: string };
    expect({ status: again.status, error: refusal.error }).toEqual({ status: 409, error: 'restore_ended' });
    expect(refusal.message).toContain(`GET /api/backups/restores/${accepted.id}`);
    const next = await worker.fetch(await asOwnerPost(f.db, '/api/backups/restore-upload', { artifact: text, allowForeignLineage: true }), env);
    expect(next.status).toBe(200);
    expect(restoredRows(f).reports).toHaveLength(95);
    f.sqlite.close();
  });

  it('ends a restore failed, named, once the same unnamed error has stopped five passes in a row', async () => {
    const f = await destination();
    const accepted = await acceptUploadedRestore(f.serverEnv, await artifactOf(45), { allowForeignLineage: true, memberId: OWNER, now: NOW });
    const broken = { ...f.serverEnv, db: failing(f.db, /INTO agent_reports/) };
    const states: string[] = [];
    for (let pass = 0; pass < 10 && (await latestRestore(f.serverEnv))?.state === 'running'; pass++) {
      await advanceRestore(broken, NOW, 2_000);
      const job = (await restoreJobProgress(f.serverEnv, accepted.id))!;
      states.push(job.state === 'running' ? `retrying ${job.retrying?.errorClass ?? ''}` : job.state);
    }
    expect(states.at(-1)).toBe('failed');
    expect(states.filter((state) => state.startsWith('retrying'))).toHaveLength(4);
    expect((await restoreJobProgress(f.serverEnv, accepted.id))?.failure?.code).toBe('retries_exhausted');
    expect(await acceptRestore(f.serverEnv, 'bk_absent', { allowForeignLineage: true, memberId: OWNER, now: NOW })).toBeNull();
    f.sqlite.close();
  });

  it('answers a restore that ended failed with its code, its words and the job', async () => {
    const f = await destination();
    const env = { ...f.env, ...OWNER_ENV };
    f.sqlite.run(`CREATE TRIGGER restore_refused_here BEFORE INSERT ON agent_reports WHEN NEW.id = 21 BEGIN SELECT RAISE(ABORT, 'refused by the destination'); END`);
    const answered = await worker.fetch(await asOwnerPost(f.db, '/api/backups/restore-upload', { artifact: await artifactOf(45), allowForeignLineage: true }), env);
    const body = await answered.json() as { error: string; message: string; job: { state: string; outcome: { tables: Record<string, unknown> } } };
    expect({ status: answered.status, error: body.error, state: body.job.state }).toEqual({ status: 409, error: 'restore_refused', state: 'failed' });
    expect(body.message).toContain('refused by the destination');
    expect(restoredRows(f).reports).toHaveLength(20);
    f.sqlite.close();
  });
});
