import { prepareLearningSlice } from './helpers/extraction.js';
import { completeLearning } from '@myco-server-worker/core/learning-sessions.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { ensureAgent } from '@myco-server-worker/db/runs/state.js';
import { recordDispatch } from '@myco-server-worker/db/runs/claim.js';
import { pruneTerminalRuns } from '@myco-server-worker/db/runs/retention.js';
import { recordServedPrompts } from '@myco-server-worker/db/runs/served.js';
import { tombstoneSession } from './helpers/session-deletion.js';
import { createBackup, backupArtifact, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { extractionSqlEnv as sqliteEnv, assertExtractionSql } from './helpers/extraction-sql.js';

/** The destination registers every blob the source holds, as a restore requires: a backup carries no blob bytes. */
function holdBlobs(from: Database, to: Database, source:ReturnType<typeof memoryBlobStore>, destination:ReturnType<typeof memoryBlobStore>): void {
  for(const [key,value]of source.objects)destination.seed(key,value);
  for (const row of from.query('SELECT * FROM blobs').all() as Record<string, unknown>[]) {
    const columns = Object.keys(row);
    to.query(`INSERT OR IGNORE INTO blobs (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...(Object.values(row) as never[]));
  }
}

async function fixture() {
  const f = sqliteEnv();
  const env = serverEnvFromBindings(f.env);
  const scope = { projectId: 'proj_1' };
  const now = Date.now();
  const capture = async (sessionId: string, createdAt: number, projectId = scope.projectId, origin = 'user') => {
    const promptId = crypto.randomUUID();
    expect(await ingestEvent(f.db, { projectId, machineId: 'machine', tokenId: 'capture', now, bodyBytes: 0, writeOrigin: 'server' }, {
      eventId: crypto.randomUUID(), sessionId, kind: 'prompt', createdAt, channel: 'cli',
      producer: { adapter: 'claude-code', version: 'test' }, payload: { promptId, text: `Material ${promptId}`, origin },
    })).toMatchObject({ persisted: true, projected: true });
    expect(await ingestEvent(f.db, { projectId, machineId: 'machine', tokenId: 'capture', now, bodyBytes: 0, writeOrigin: 'server' }, {
      eventId: crypto.randomUUID(), sessionId, kind: 'session.end', createdAt: now, channel: 'cli',
      producer: { adapter: 'claude-code', version: 'test' }, payload: { endedAt: now },
    })).toMatchObject({ persisted: true, projected: true });
    // Acknowledgements check membership against the published document's catalog.
    await publishDocuments(env, now, { calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
    return { promptId, sessionId, createdAt, endedAt: now };
  };
  await ensureAgent(f.db, { id: 'coverage', name: 'Coverage', provider: null, model: null, enabled: true }, now);
  const run = async (runId = crypto.randomUUID(), projectId = scope.projectId, startedAt = now) => {
    expect(await recordDispatch(f.db, { projectId }, { id: runId, agentId: 'coverage', task: 'extract-curate', provider: null,
      model: null, runContext: null, dispatchedBy: null, startedAt })).toBe(true);
    return { id: runId,
      complete: async (rows: Parameters<typeof recordServedPrompts>[3]) => {
        const assignment = await prepareLearningSlice(f.db, { projectId }, runId, rows[0]!.sessionId, rows, now);
        return completeLearning(f.db, projectId, rows[0]!.sessionId, runId, assignment, '', now);
      },
      serve: (rows: Parameters<typeof recordServedPrompts>[3], instanceId: string | null = null) => recordServedPrompts(f.db, { projectId }, runId, rows, now, instanceId) };

  };
  return { ...f, env, scope, now, capture, run };
}

describe('served extraction coverage', () => {

  it('rejects prepared flag reads and mutations outside the coverage owner', () => {
    const column = 'processed';
    for (const sql of [`SELECT p.${column} FROM prompt_batches p`, 'SELECT * FROM prompt_batches p WHERE p."processed"=0',
      `UPDATE prompt_batches SET ${column}=? WHERE project_id=?`]) expect(() => assertExtractionSql(sql)).toThrow('coverage owner');
  });

  it('keeps holes and equal timestamps unread independently and preserves an interrupted run’s partial acks', async () => {
    const f = await fixture();
    try {
      const first = await f.capture('session', 200);
      const tie = await f.capture('session', 200);
      const r = await f.run();
      const [served] = await r.serve([first, tie]);
      expect(await r.complete([first])).toEqual({ completed: true, covered: 1 });
      const hole = await f.capture('session', 100);
      const next = await f.run();
      const rest = await next.serve([hole, tie]);
      expect(rest.map(p => p.promptId)).toEqual([hole.promptId, tie.promptId]);
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM extraction_acks WHERE project_id = ?').get(f.scope.projectId)).toEqual({ n: 1 });
      expect(await next.complete([hole, tie])).toEqual({ completed: true, covered: 2 });
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM session_prompts').get()).toEqual({n:3});
      expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_run_events WHERE event_type='run_write' AND tool_name='myco_run_learning'").get()).toEqual({ n: 2 });
    } finally { f.sqlite.close(); }
  });

  it('records the first ack once across runs, new capture, tombstones and additive restore', async () => {
    const f = await fixture();
    const restored = sqliteEnv();
    const restoredEnv = serverEnvFromBindings(restored.env);
    try {
      const a = await f.capture('session', 1);
      const b = await f.capture('session', 2);
      const r = await f.run();
      const other = await f.run();
      const [first] = await r.serve([a]);
      const [second] = await other.serve([a]);
      await r.complete([a]);
      await other.complete([a]);
      expect(() => f.sqlite.run('UPDATE extraction_acks SET acknowledged_at=2')).toThrow('extraction acknowledgements are immutable');
      const c = await f.capture('session', 3);
      f.sqlite.run("UPDATE agent_runs SET status='completed'");
      const backup = await createBackup(f.db, f.env.blobs, { producer: 'test', now: f.now });
      const { text } = (await backupArtifact(f.db, f.env.blobs, backup.id))!;
      holdBlobs(f.sqlite, restored.sqlite,f.bucket,restored.bucket);
      await restoreArtifact(restored.db, { text, blobs: restoredEnv.blobs, allowForeignLineage: true, authorization: { kind: 'recovery' } });
      expect(restored.sqlite.query('SELECT COUNT(*) AS n FROM extraction_acks').get()).toEqual({ n: 2 });
      await restoreArtifact(restored.db, { text, blobs: restoredEnv.blobs, allowForeignLineage: true, authorization: { kind: 'recovery' } });
      await tombstoneSession(f.env, f.scope, 'session', 'test', f.now);
      holdBlobs(restored.sqlite, f.sqlite,restored.bucket,f.bucket);
      await restoreArtifact(f.db, { text, blobs: f.env.blobs, authorization: { kind: 'recovery' } });
      expect(f.sqlite.query('SELECT * FROM extraction_acks').all()).toEqual([]);
    } finally { restored.sqlite.close(); f.sqlite.close(); }
  });

  it('keeps acknowledgements after run deletion and terminal-run retention', async () => {
    const f = await fixture();
    try {
      const row = await f.capture('session', 1);
      const first = await f.run();
      const second = await f.run();
      for (const r of [first, second]) {
        const [item] = await r.serve([row]);
        await r.complete([row]);
      }
      f.sqlite.run('DELETE FROM agent_runs WHERE id=?', [first.id]);
      f.sqlite.run("UPDATE agent_runs SET status='completed',completed_at=1 WHERE id=?", [second.id]);
      expect(await pruneTerminalRuns(f.db, f.now + 1, 10)).toBeGreaterThan(0);
      expect(f.sqlite.query('SELECT * FROM agent_runs').all()).toEqual([]);
      expect(f.sqlite.query('SELECT * FROM run_served_material').all()).toEqual([]);
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM extraction_acks').get()).toEqual({ n: 2 });
      f.sqlite.run("UPDATE agent_runs SET status='completed'");
      const backup = await createBackup(f.db, f.env.blobs, { producer: 'test', now: f.now });
      const { text } = (await backupArtifact(f.db, f.env.blobs, backup.id))!;
      const restored = sqliteEnv();
      try {
        holdBlobs(f.sqlite, restored.sqlite,f.bucket,restored.bucket);
        await restoreArtifact(restored.db, { text, blobs:restored.bucket, authorization: { kind: 'recovery' }, allowForeignLineage: true });
        expect(restored.sqlite.query('SELECT * FROM agent_runs').all()).toEqual([]);
        expect(restored.sqlite.query('SELECT COUNT(*) AS n FROM extraction_acks').get()).toEqual({ n: 2 });
      } finally { restored.sqlite.close(); }
    } finally { f.sqlite.close(); }
  });
});
