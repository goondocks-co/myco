/**
 * A restore as a job: accepted before it writes, walked in bounded passes, and resumable from any point a process can
 * die at. The destination a killed-and-resumed restore leaves is the destination an uninterrupted one leaves.
 */
import { describe, expect, it } from 'bun:test';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { createBackup } from '@myco-server-worker/core/backup.js';
import { acceptRestore, acceptUploadedRestore, advanceRestore, latestRestore, restoreJobProgress } from '@myco-server-worker/core/restore-job.js';
import worker from '@myco-server-worker/index.js';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { readFixtureRecords } from './helpers/fixtures.js';
import { counters } from './helpers/document-publication.js';
import { restoreDocuments } from '@myco-server-worker/ingest/document-restore.js';
import { asOwner, asOwnerPost, OWNER_ENV } from './helpers/owner.js';
import {
  artifactOf, destination, documentBackup, documentDestination, NOW, OWNER, PASS_ROWS, restoredRows, tickUntilEnded, type Fixture,
} from './helpers/restore-job.js';
import { dying } from './helpers/store-faults.js';

const HOUR = 3_600_000;

describe('a restore job', () => {
  it('leaves the destination as an uninterrupted restore does, wherever the process dies, before or after a commit', async () => {
    const text = await artifactOf(45);
    const reference = await destination();
    const before = restoredRows(reference);
    const accepted = await acceptUploadedRestore(reference.serverEnv, text, { allowForeignLineage: true, memberId: OWNER, now: NOW });
    await tickUntilEnded(reference, PASS_ROWS);
    expect((await restoreJobProgress(reference.serverEnv, accepted.id))?.state).toBe('complete');
    const expected = restoredRows(reference);
    const expectedOutcome = (await latestRestore(reference.serverEnv))?.outcome.tables;
    expect(expected.reports).toHaveLength(45);
    expect(expectedOutcome?.agent_reports).toEqual({ rows: 45, inserted: 45 });
    reference.sqlite.close();

    const counting = await destination();
    const counter = dying(counting.db, Number.POSITIVE_INFINITY, 'before');
    const counted = { ...counting.serverEnv, db: counter.store };
    await acceptUploadedRestore(counted, text, { allowForeignLineage: true, memberId: OWNER, now: NOW });
    for (let wake = 0; wake < 500 && (await advanceRestore(counted, NOW, PASS_ROWS)).more; wake++) { /* every call of a whole restore */ }
    const total = counter.calls();
    counting.sqlite.close();
    expect(total).toBeGreaterThan(20);

    for (const when of ['before', 'after'] as const) {
      for (let at = 1; at <= total; at++) {
        const target = await destination();
        const killed = dying(target.db, at, when);
        const env = { ...target.serverEnv, db: killed.store };
        try {
          await acceptUploadedRestore(env, text, { allowForeignLineage: true, memberId: OWNER, now: NOW });
          for (let wake = 0; wake < 500 && (await advanceRestore(env, NOW, PASS_ROWS)).more; wake++) { /* until the process dies */ }
        } catch { /* the process ended */ }

        const owner = await latestRestore(target.serverEnv);
        // Killed before its job committed, a restore wrote nothing of the artifact; once it committed, the job owns it.
        if (owner === null) expect(restoredRows(target), `${when} call ${at}`).toEqual(before);
        else expect(['running', 'complete'], `${when} call ${at}`).toContain(owner.state);
        // Killed after its job committed but before the uploaded bytes were kept, the job waits a moment for them, then
        // ends failed having restored nothing, and says to upload again.
        if (owner?.state === 'running') await tickUntilEnded(target, PASS_ROWS, NOW + HOUR);
        const ended = await latestRestore(target.serverEnv);
        if (ended?.state === 'failed') {
          expect({ code: ended.failure?.code, rows: restoredRows(target) }, `${when} call ${at}`).toEqual({ code: 'backup_unavailable', rows: before });
        }
        if (ended === null || ended.state === 'failed') await acceptUploadedRestore(target.serverEnv, text, { allowForeignLineage: true, memberId: OWNER, now: NOW + 1 });
        await tickUntilEnded(target, PASS_ROWS);
        expect((await latestRestore(target.serverEnv))?.state, `${when} call ${at}`).toBe('complete');
        expect(restoredRows(target), `${when} call ${at}`).toEqual(expected);
        expect((await latestRestore(target.serverEnv))?.outcome.tables, `${when} call ${at}`).toEqual(expectedOutcome);
        target.sqlite.close();
      }
    }
  }, 300_000);

  it('restores a session document to the same state and counts wherever the process dies, the first pass crossing its transcripts', async () => {
    const backup = await documentBackup();
    /** What the restored session holds: its records, document, frontier, continuation and chunks. */
    const documents = async (f: Fixture) => ({
      records: (await readFixtureRecords({ db: f.db, blobs: f.bucket }, 'project', 'portable')).map((record) => [record.k, record.id, record.text]),
      counts: await counters(f.db, 'portable'),
      document: f.sqlite.query(`SELECT state, prompts, user_prompts, replies, next_chunk FROM session_documents WHERE session_id = 'portable'`).all(),
      frontier: f.sqlite.query(`SELECT transcript_id, published_offset, record_scheme, parser_version, state FROM transcript_publication WHERE session_id = 'portable'`).all(),
      continuations: f.sqlite.query(`SELECT COUNT(*) AS n FROM document_continuations WHERE session_id = 'portable'`).all(),
      chunks: f.sqlite.query(`SELECT kind, chunk_no FROM session_chunks WHERE session_id = 'portable' ORDER BY chunk_no`).all(),
    });
    /** Passes as an owner's requests run them, with the document side, a first pass large enough to cross every table. */
    const passes = async (f: Fixture, db: RelationalStore) => {
      const env = { ...f.serverEnv, db };
      for (let wake = 0; wake < 50 && (await advanceRestore(env, NOW, 2_000, restoreDocuments({ db, blobs: f.bucket }))).more; wake++) { /* until it ends */ }
    };
    const accept = (f: Fixture) => acceptUploadedRestore(f.serverEnv, backup.text, { allowForeignLineage: true, memberId: OWNER, now: NOW,
      documents: restoreDocuments({ db: f.db, blobs: f.bucket }) });

    const reference = await documentDestination(backup);
    await accept(reference);
    await passes(reference, reference.db);
    const expected = { ...(await documents(reference)), outcome: (await latestRestore(reference.serverEnv))?.outcome };
    expect((await latestRestore(reference.serverEnv))?.state).toBe('complete');
    expect(expected.records.map(([kind, , text]) => [kind, text])).toEqual(expect.arrayContaining([['prompt', 'a kept prompt']]));
    expect(expected.frontier).not.toEqual([]);
    reference.sqlite.close();

    const counting = await documentDestination(backup);
    await accept(counting);
    const counter = dying(counting.db, Number.POSITIVE_INFINITY, 'before');
    await passes(counting, counter.store);
    const total = counter.calls();
    counting.sqlite.close();
    expect(total).toBeGreaterThan(20);

    for (const when of ['before', 'after'] as const) {
      for (let at = 1; at <= total; at++) {
        const target = await documentDestination(backup);
        await accept(target);
        try { await passes(target, dying(target.db, at, when).store); } catch { /* the process ended */ }
        await passes(target, target.db);
        const restored = await latestRestore(target.serverEnv);
        expect(restored?.state, `${when} call ${at}`).toBe('complete');
        expect({ ...(await documents(target)), outcome: restored?.outcome }, `${when} call ${at}`).toEqual(expected);
        target.sqlite.close();
      }
    }
  }, 300_000);

  it('commits no larger a batch for an artifact ten times the size', async () => {
    const measured: number[] = [];
    for (const reports of [45, 450]) {
      const f = await destination();
      let largestBatch = 0;
      const metered = { ...f.serverEnv, db: { ...f.db, batch: (statements: PreparedStatement[]) => {
        largestBatch = Math.max(largestBatch, statements.length);
        return f.db.batch(statements);
      } } };
      await acceptUploadedRestore(metered, await artifactOf(reports), { allowForeignLineage: true, memberId: OWNER, now: NOW });
      for (let wake = 0; wake < 500 && (await advanceRestore(metered, NOW, PASS_ROWS)).more; wake++) { /* the tick walks it */ }
      expect((await latestRestore(f.serverEnv))?.state).toBe('complete');
      measured.push(largestBatch);
      f.sqlite.close();
    }
    expect(measured[1]).toEqual(measured[0]!);
  });

  it('waits at session documents on the tick, which never reads them, until an owner continues it', async () => {
    const backup = await documentBackup();
    const f = await documentDestination(backup);
    const env = { ...f.env, ...OWNER_ENV };
    const accepted = await acceptUploadedRestore(f.serverEnv, backup.text, { allowForeignLineage: true, memberId: OWNER, now: NOW,
      documents: restoreDocuments({ db: f.db, blobs: f.bucket }) });
    expect(await advanceRestore(f.serverEnv, NOW, PASS_ROWS)).toMatchObject({ more: false });
    expect(await restoreJobProgress(f.serverEnv, accepted.id)).toMatchObject({ state: 'running', awaitingDocuments: true, retrying: null });
    expect(f.sqlite.query(`SELECT session_id FROM sessions WHERE session_id = 'portable'`).all()).toEqual([]);

    const continued = await worker.fetch(await asOwnerPost(f.db, `/api/backups/restores/${accepted.id}/continue`, {}), env);
    const body = await continued.json() as { applied: boolean; job: { state: string; awaitingDocuments: boolean } };
    expect({ status: continued.status, applied: body.applied, job: body.job }).toMatchObject({ status: 200, applied: true, job: { state: 'complete', awaitingDocuments: false } });
    expect((await readFixtureRecords({ db: f.db, blobs: f.bucket }, 'project', 'portable')).filter((record) => record.k === 'prompt').map((record) => record.text)).toEqual(['a kept prompt']);
    const ended = await worker.fetch(await asOwnerPost(f.db, `/api/backups/restores/${accepted.id}/continue`, {}), env);
    expect({ status: ended.status, error: (await ended.json() as { error: string }).error }).toEqual({ status: 409, error: 'restore_ended' });
    f.sqlite.close();
  });

  it('ends a restore that cannot place its documents failed, named, after five Continues, though the tick runs between each', async () => {
    const backup = await documentBackup();
    const f = await documentDestination(backup);
    const env = { ...f.env, ...OWNER_ENV };
    const accepted = await acceptUploadedRestore(f.serverEnv, backup.text, { allowForeignLineage: true, memberId: OWNER, now: NOW,
      documents: restoreDocuments({ db: f.db, blobs: f.bucket }) });
    expect(await advanceRestore(f.serverEnv, NOW, PASS_ROWS)).toMatchObject({ more: false });
    for (const key of backup.objects.keys()) f.bucket.objects.delete(key);
    const answers: number[] = [];
    for (let press = 0; press < 10 && (await restoreJobProgress(f.serverEnv, accepted.id))?.state === 'running'; press++) {
      answers.push((await worker.fetch(await asOwnerPost(f.db, `/api/backups/restores/${accepted.id}/continue`, {}), env)).status);
      await advanceRestore(f.serverEnv, NOW, PASS_ROWS);
    }
    expect({ presses: answers.length, failure: (await restoreJobProgress(f.serverEnv, accepted.id))?.failure?.code }).toEqual({ presses: 5, failure: 'retries_exhausted' });
    f.sqlite.close();
  });

  it('leaves every restored row projected when catch-up finishes its phases between the reset and the inserts', async () => {
    const text = await artifactOf(45);
    /** What catch-up derives from the restored run and sessions: the run's evidence head and each session's title work. */
    const projected = (f: Fixture) => ({
      runHeads: f.sqlite.query(`SELECT * FROM run_head WHERE project_id = 'proj_rs' ORDER BY run_id`).all(),
      titleWork: f.sqlite.query(`SELECT * FROM session_title_work WHERE project_id = 'proj_rs' ORDER BY session_id`).all(),
    });
    const restored: ReturnType<typeof projected>[] = [];
    for (const interleaved of [false, true]) {
      const f = await destination();
      await acceptUploadedRestore(f.serverEnv, text, { allowForeignLineage: true, memberId: OWNER, now: NOW });
      for (let wake = 0; wake < 500; wake++) {
        const pass = await advanceRestore(f.serverEnv, NOW, 1);
        // The tick runs catch-up to its end between passes, so its phases finish over tables the restore has not filled.
        if (interleaved) while ((await catchUpProjections(f.db)).more) { /* every phase over what the tables hold now */ }
        if (!pass.more) break;
      }
      expect((await latestRestore(f.serverEnv))?.state).toBe('complete');
      while ((await catchUpProjections(f.db)).more) { /* the wakes after the restore */ }
      restored.push(projected(f));
      f.sqlite.close();
    }
    expect(restored[0]!.runHeads).toHaveLength(1);
    expect(restored[1]).toEqual(restored[0]!);
  });

  it('runs one at a time, answers its progress while it runs, and its outcome once the tick finishes it', async () => {
    const text = await artifactOf(45);
    const f = await destination();
    const env = { ...f.env, ...OWNER_ENV };
    const accepted = await acceptUploadedRestore(f.serverEnv, text, { allowForeignLineage: true, memberId: OWNER, now: NOW });
    expect(accepted).toMatchObject({ state: 'running', phase: 'start', rowsDone: 0, failure: null });
    expect(accepted.rowsTotal).toBeGreaterThan(45);
    expect(restoredRows(f).reports).toEqual([]);

    const second = await worker.fetch(await asOwnerPost(f.db, '/api/backups/restore-upload', { artifact: text, allowForeignLineage: true }), env);
    expect({ status: second.status, body: await second.json() }).toMatchObject({ status: 409, body: { error: 'restore_running', restoreId: accepted.id } });

    await advanceRestore(f.serverEnv, NOW, PASS_ROWS);
    const listed = await (await worker.fetch(await asOwner(f.db, '/api/backups'), env)).json() as { restore: { id: string; state: string; rowsDone: number; rowsTotal: number } };
    expect(listed.restore).toMatchObject({ id: accepted.id, state: 'running' });
    expect(listed.restore.rowsDone).toBeGreaterThan(0);
    expect(listed.restore.rowsDone).toBeLessThan(listed.restore.rowsTotal);

    await tickUntilEnded(f, PASS_ROWS);
    const done = await worker.fetch(await asOwner(f.db, `/api/backups/restores/${accepted.id}`), env);
    const body = await done.json() as { job: { state: string; rowsDone: number; rowsTotal: number; completedAt: number; outcome: { tables: Record<string, { rows: number; inserted: number }> } } };
    expect(done.status).toBe(200);
    expect(body.job).toMatchObject({ state: 'complete', completedAt: NOW });
    expect(body.job.rowsDone).toBe(body.job.rowsTotal);
    expect(body.job.outcome.tables.agent_reports).toEqual({ rows: 45, inserted: 45 });
    expect(restoredRows(f).reports).toHaveLength(45);
    f.sqlite.close();
  });

  it('answers a small restore complete in the request that accepts it, and a stored backup the same way', async () => {
    const f = await destination();
    const env = { ...f.env, ...OWNER_ENV };
    f.sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_own', 'own', 1)`);
    f.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      VALUES ('proj_own', 'sess_own', 'm1', 'mt_seed', 1, 1)`);
    const backup = await createBackup(f.db, f.bucket, { producer: OWNER, now: NOW });
    f.sqlite.run(`DELETE FROM sessions WHERE session_id = 'sess_own'`);
    const response = await worker.fetch(await asOwnerPost(f.db, `/api/backups/${backup.id}/restore`, {}), env);
    const body = await response.json() as { applied: boolean; job: { state: string }; tables: Record<string, { inserted: number }> };
    expect({ status: response.status, applied: body.applied, state: body.job.state, sessions: body.tables.sessions?.inserted }).toEqual({ status: 200, applied: true, state: 'complete', sessions: 1 });
    expect(f.sqlite.query(`SELECT session_id FROM sessions WHERE session_id = 'sess_own'`).all()).toEqual([{ session_id: 'sess_own' }]);
    f.sqlite.close();
  });

  it('ends failed with its refusal and keeps what it restored when the backup it reads goes away mid-restore', async () => {
    const text = await artifactOf(45);
    const f = await destination();
    const accepted = await acceptUploadedRestore(f.serverEnv, text, { allowForeignLineage: true, memberId: OWNER, now: NOW });
    await advanceRestore(f.serverEnv, NOW, PASS_ROWS);
    await advanceRestore(f.serverEnv, NOW, PASS_ROWS);
    const partial = restoredRows(f);
    const kept = [...f.bucket.objects.keys()].filter((key) => key.startsWith('restores/'));
    expect(kept).toHaveLength(1);
    f.bucket.objects.delete(kept[0]!);
    await advanceRestore(f.serverEnv, NOW, PASS_ROWS);
    const ended = await restoreJobProgress(f.serverEnv, accepted.id);
    expect(ended).toMatchObject({ state: 'failed', failure: { code: 'backup_unavailable' } });
    expect(restoredRows(f)).toEqual(partial);
    expect(await acceptRestore(f.serverEnv, 'bk_absent', { allowForeignLineage: true, memberId: OWNER, now: NOW })).toBeNull();
    f.sqlite.close();
  });
});
