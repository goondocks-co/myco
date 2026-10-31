import {statementRecorder} from '../helpers/statement-recorder.js';
import {readTag} from '../helpers/view-read-contract.js';
import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { ensureAgent, recordDispatch, pruneTerminalRuns } from '@myco-server-worker/core/runs.js';
import { recordServedPrompts } from '@myco-server-worker/core/served-material.js';
import { handleRunPrompts } from '@myco-server-worker/mcp/tools/run-prompts.js';
import type { ToolContext } from '@myco-server-worker/mcp/context.js';
import { readWindowFor } from '@myco-server-worker/core/read-window.js';
import { runAllowlist } from '@myco-server-worker/mcp/run-surface.js';
import { TASK_TOOLS } from '@myco-server-worker/core/task-catalogue.js';
import { hasProcessedPrompts } from '@myco-server-worker/read/prompts.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { createBackup, backupArtifact, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { extractionSqlEnv as sqliteEnv, assertExtractionSql } from './helpers/extraction-sql.js';

/** The destination registers every blob the source holds, as a restore requires: a backup carries no blob bytes. */
function holdBlobs(from: Database, to: Database): void {
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
    const ctx: ToolContext = { env, projectId, now, principal: { kind: 'run', runId, task: 'extract-curate', agentId: 'coverage',
      sessionId: null, runContext: null, model: null, tokenId: 'capture', allow: runAllowlist(TASK_TOOLS['extract-curate']!, { dryRun: false }), window: readWindowFor('extract-curate') } };
    return { id: runId, ctx, call: (input: Parameters<typeof handleRunPrompts>[0]) => handleRunPrompts(input, ctx),
      serve: (rows: Parameters<typeof recordServedPrompts>[3], instanceId: string | null = null) => recordServedPrompts(f.db, { projectId }, runId, rows, now, instanceId) };
  };
  const count = () => f.sqlite.query('SELECT eligible_prompts AS n FROM session_read_facts WHERE project_id = ? AND session_id = ?').get('proj_1', 'session');
  const assertCounts = () => {
    const prompts = f.sqlite.query('SELECT project_id,session_id,prompt_id,processed,origin FROM prompt_batches').all() as { project_id: string; session_id: string; prompt_id: string; processed: number; origin: string }[];
    const acks = f.sqlite.query("SELECT project_id,record_id FROM extraction_acks WHERE kind = 'record'").all() as { project_id: string; record_id: string }[];
    const facts = f.sqlite.query('SELECT project_id,session_id,eligible_prompts FROM session_read_facts').all() as { project_id: string; session_id: string; eligible_prompts: number }[];
    for (const fact of facts) expect(fact.eligible_prompts).toBe(prompts.filter(p => p.project_id === fact.project_id && p.session_id === fact.session_id
      && p.processed === 0 && ['user', 'unknown'].includes(p.origin) && !acks.some(a => a.project_id === p.project_id && a.record_id === p.prompt_id)).length);
  };
  return { ...f, env, scope, now, capture, run, count, assertCounts };
}

describe('served extraction coverage', () => {

  it('rejects prepared flag reads and mutations outside the coverage owner', () => {
    const column = 'processed';
    for (const sql of [`SELECT p.${column} FROM prompt_batches p`, 'SELECT * FROM prompt_batches p WHERE p."processed"=0',
      `UPDATE prompt_batches SET ${column}=? WHERE project_id=?`]) expect(() => assertExtractionSql(sql)).toThrow('coverage owner');
  });

  it('recounts drifted destination sessions atomically and resumes a recount interrupted after all row chunks', async () => {
    const f = await fixture();
    const restored = sqliteEnv();
    try {
      const a = await f.capture('session', 1);
      await f.capture('session', 2);
      await f.capture('other-session', 3);
      const r = await f.run();
      const [item] = await r.serve([a]);
      await r.call({ op: 'mark_processed', served_id: item!.servedId });
      f.sqlite.run("UPDATE agent_runs SET status='completed'");
      const backup = await createBackup(f.db, f.env.blobs, { producer: 'test', now: f.now });
      const { text } = (await backupArtifact(f.db, f.env.blobs, backup.id))!;
      const options = { text, allowForeignLineage: true, authorization: { kind: 'recovery' as const } };
      holdBlobs(f.sqlite, restored.sqlite);
      await restoreArtifact(restored.db, options);
      restored.sqlite.run("UPDATE session_read_facts SET eligible_prompts=18 WHERE project_id='proj_1'");
      await restoreArtifact(restored.db, options);
      expect(restored.sqlite.query("SELECT eligible_prompts FROM session_read_facts WHERE project_id='proj_1' ORDER BY session_id").all()).toEqual([{ eligible_prompts: 1 }, { eligible_prompts: 1 }]);
      restored.sqlite.run("UPDATE session_read_facts SET eligible_prompts=18 WHERE project_id='proj_1'");
      let recounts = 0;
      const interrupted = statementRecorder(restored.db, {accounting:'native',prepared(event) {
        if (event.operation === 'M46:prepareRestoredSessionUnread:0') { recounts++; throw new Error('interrupted recount'); }
      }}).db;
      await expect(restoreArtifact(interrupted, options)).rejects.toThrow('interrupted recount');
      expect(recounts).toBe(1);
      expect(restored.sqlite.query("SELECT DISTINCT eligible_prompts FROM session_read_facts WHERE project_id='proj_1'").all()).toEqual([{ eligible_prompts: 18 }]);
      expect(restored.sqlite.query("SELECT next_row FROM backup_restore_progress WHERE table_name LIKE 'extraction-session-counters:%'").all()).toEqual([{ next_row: 0 }]);
      const before = restored.prepared.length;
      await restoreArtifact(restored.db, options);
      expect(restored.prepared.slice(before).filter(sql => readTag(sql)?.operation === 'M46:prepareRestoredSessionUnread:0')).toHaveLength(1);
      expect(restored.sqlite.query("SELECT eligible_prompts FROM session_read_facts WHERE project_id='proj_1' ORDER BY session_id").all()).toEqual([{ eligible_prompts: 1 }, { eligible_prompts: 1 }]);
      expect(restored.sqlite.query("SELECT next_row FROM backup_restore_progress WHERE table_name LIKE 'extraction-session-counters:%'").all()).toEqual([{ next_row: 1 }]);
    } finally { restored.sqlite.close(); f.sqlite.close(); }
  });

  it('keeps holes and equal timestamps unread independently and preserves an interrupted run’s partial acks', async () => {
    const f = await fixture();
    try {
      const first = await f.capture('session', 200);
      const tie = await f.capture('session', 200);
      const r = await f.run();
      const [served] = await r.serve([first, tie]);
      expect(await r.call({ op: 'mark_processed', served_id: served!.servedId })).toMatchObject({ marked: true });
      expect(await r.call({ op: 'mark_processed', served_id: served!.servedId })).toMatchObject({ marked: false });
      const hole = await f.capture('session', 100);
      const next = await f.run();
      const rest = await next.serve([hole, tie]);
      expect(rest.map(p => p.promptId)).toEqual([hole.promptId, tie.promptId]);
      expect(await hasProcessedPrompts(f.db, f.scope)).toBe(true);
      expect(f.count()).toEqual({ n: 2 });
      f.assertCounts();
      for (const item of rest) expect(await next.call({ op: 'mark_processed', served_id: item.servedId })).toMatchObject({ marked: true });
      expect(f.count()).toEqual({ n: 0 });
      expect(f.sqlite.query('SELECT DISTINCT processed FROM prompt_batches').all()).toEqual([{ processed: 0 }]);
      expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_run_events WHERE event_type='run_write' AND tool_name='myco_run_prompts'").get()).toEqual({ n: 3 });
      f.assertCounts();
    } finally { f.sqlite.close(); }
  });

  it('re-serves one identity and requires served_id when instances differ', async () => {
    const f = await fixture();
    try {
      const row = await f.capture('session', 1);
      const r = await f.run();
      const [a] = await r.serve([row]);
      expect((await r.serve([row]))[0]!.servedId).toBe(a!.servedId);
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM run_served_material').get()).toEqual({ n: 1 });
      const [b] = await r.serve([row], 'second-instance');
      expect(await r.call({ op: 'mark_processed', prompt_id: row.promptId })).toEqual({ ok: false, error: 'prompt_id names material from multiple instances; use served_id' });
      expect(await r.call({ op: 'mark_processed', served_id: b!.servedId })).toMatchObject({ marked: true });
      expect(await r.call({ op: 'mark_processed', served_id: a!.servedId })).toMatchObject({ marked: true });
      expect(f.count()).toEqual({ n: 0 });
      f.assertCounts();
    } finally { f.sqlite.close(); }
  });

  it('refuses compatibility ambiguity introduced between resolution and the acknowledgement transaction', async () => {
    const f = await fixture();
    try {
      const row = await f.capture('session', 1);
      const r = await f.run();
      const [item] = await r.serve([row]);
      let raced = false;
      r.ctx.env = { ...r.ctx.env, db: { prepare: sql => f.db.prepare(sql), batch: async statements => {
        if (!raced) { raced = true; await r.serve([row], 'concurrent-instance'); }
        return f.db.batch(statements);
      } } };
      expect(await r.call({ op: 'mark_processed', prompt_id: row.promptId })).toEqual({ ok: false, error: 'prompt_id names material from multiple instances; use served_id' });
      expect(f.sqlite.query('SELECT * FROM extraction_acks').all()).toEqual([]);
      expect(f.sqlite.query('SELECT * FROM agent_run_events').all()).toEqual([]);
      expect(await r.call({ op: 'mark_processed', served_id: item!.servedId })).toMatchObject({ marked: true });
      f.assertCounts();
    } finally { f.sqlite.close(); }
  });

  it('refuses unserved, foreign-run, foreign-Project and deleted-session items, retaining pre-ledger prompt compatibility', async () => {
    const f = await fixture();
    try {
      const row = await f.capture('session', 1);
      const r = await f.run();
      expect(await r.call({ op: 'mark_processed', prompt_id: row.promptId })).toMatchObject({ ok: false });
      const other = await f.run();
      const [item] = await other.serve([row]);
      expect(await r.call({ op: 'mark_processed', served_id: item!.servedId })).toMatchObject({ ok: false });
      const foreignRow = await f.capture('session', 1, 'proj_2');
      const foreign = await f.run(crypto.randomUUID(), 'proj_2');
      const [foreignItem] = await foreign.serve([foreignRow]);
      expect(await r.call({ op: 'mark_processed', served_id: foreignItem!.servedId })).toMatchObject({ ok: false });
      const boundary = Number((f.sqlite.query("SELECT value FROM schema_meta WHERE key='ledger_enabled_at'").get() as { value: string }).value);
      const old = await f.run(crypto.randomUUID(), 'proj_1', boundary - 1);
      expect(await old.call({ op: 'mark_processed', prompt_id: row.promptId })).toEqual({ prompt_id: row.promptId, marked: true });
      expect(f.sqlite.query('SELECT served_id FROM extraction_acks').all()).toEqual([{ served_id: null }]);
      const historicalSystem = await f.capture('session', 2, 'proj_1', 'system');
      expect(await old.call({ op: 'mark_processed', prompt_id: historicalSystem.promptId })).toEqual({ prompt_id: historicalSystem.promptId, marked: true });
      expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_run_events WHERE run_id=? AND event_type='run_write' AND tool_name='myco_run_prompts'").get(old.id)).toEqual({ n: 2 });
      f.assertCounts();
      const current = await f.run(crypto.randomUUID(), 'proj_1', boundary);
      expect(await current.call({ op: 'mark_processed', prompt_id: row.promptId })).toMatchObject({ ok: false });
      await tombstoneSession(f.env, f.scope, 'session', 'test', f.now);
      expect(await other.call({ op: 'mark_processed', served_id: item!.servedId })).toMatchObject({ ok: false });
      expect(await old.call({ op: 'mark_processed', prompt_id: row.promptId })).toMatchObject({ ok: false });
      expect(f.sqlite.query('SELECT * FROM extraction_acks').all()).toEqual([]);
      f.assertCounts();
    } finally { f.sqlite.close(); }
  });

  it('counts the first ack once across runs, prompt mutations, tombstones and additive restore', async () => {
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
      f.assertCounts();
      await r.call({ op: 'mark_processed', served_id: first!.servedId });
      f.assertCounts();
      await other.call({ op: 'mark_processed', served_id: second!.servedId });
      expect(f.count()).toEqual({ n: 1 });
      expect(() => f.sqlite.run('UPDATE extraction_acks SET acknowledged_at=2')).toThrow('extraction acknowledgements are immutable');
      f.assertCounts();
      const c = await f.capture('session', 3);
      for (const sql of [
        `UPDATE prompt_batches SET origin='system' WHERE prompt_id='${b.promptId}'`,
        `UPDATE prompt_batches SET origin='user' WHERE prompt_id='${b.promptId}'`,
        `UPDATE prompt_batches SET text='Changed body',updated_at=2 WHERE prompt_id='${a.promptId}'`,
        `DELETE FROM prompt_batches WHERE prompt_id='${c.promptId}'`,
      ]) { f.sqlite.run(sql); f.assertCounts(); }
      f.sqlite.run("UPDATE agent_runs SET status='completed'");
      const backup = await createBackup(f.db, f.env.blobs, { producer: 'test', now: f.now });
      const { text } = (await backupArtifact(f.db, f.env.blobs, backup.id))!;
      holdBlobs(f.sqlite, restored.sqlite);
      await restoreArtifact(restored.db, { text, blobs: restoredEnv.blobs, allowForeignLineage: true, authorization: { kind: 'recovery' } });
      expect(restored.sqlite.query('SELECT COUNT(*) AS n FROM extraction_acks').get()).toEqual({ n: 2 });
      expect(restored.sqlite.query("SELECT eligible_prompts AS n FROM session_read_facts WHERE project_id='proj_1' AND session_id='session'").get()).toEqual({ n: 1 });
      await restoreArtifact(restored.db, { text, blobs: restoredEnv.blobs, allowForeignLineage: true, authorization: { kind: 'recovery' } });
      expect(restored.sqlite.query("SELECT eligible_prompts AS n FROM session_read_facts WHERE project_id='proj_1' AND session_id='session'").get()).toEqual({ n: 1 });
      await tombstoneSession(f.env, f.scope, 'session', 'test', f.now);
      f.assertCounts();
      holdBlobs(restored.sqlite, f.sqlite);
      await restoreArtifact(f.db, { text, blobs: f.env.blobs, authorization: { kind: 'recovery' } });
      expect(f.sqlite.query('SELECT * FROM extraction_acks').all()).toEqual([]);
      f.assertCounts();
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
        await r.call({ op: 'mark_processed', served_id: item!.servedId });
      }
      f.sqlite.run('DELETE FROM agent_runs WHERE id=?', [first.id]);
      f.sqlite.run("UPDATE agent_runs SET status='completed',completed_at=1 WHERE id=?", [second.id]);
      expect(await pruneTerminalRuns(f.db, f.now + 1, 10)).toBeGreaterThan(0);
      expect(f.sqlite.query('SELECT * FROM agent_runs').all()).toEqual([]);
      expect(f.sqlite.query('SELECT * FROM run_served_material').all()).toEqual([]);
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM extraction_acks').get()).toEqual({ n: 2 });
      expect(f.count()).toEqual({ n: 0 });
      f.assertCounts();
      f.sqlite.run("UPDATE agent_runs SET status='completed'");
      const backup = await createBackup(f.db, f.env.blobs, { producer: 'test', now: f.now });
      const { text } = (await backupArtifact(f.db, f.env.blobs, backup.id))!;
      const restored = sqliteEnv();
      try {
        holdBlobs(f.sqlite, restored.sqlite);
        await restoreArtifact(restored.db, { text, authorization: { kind: 'recovery' }, allowForeignLineage: true });
        expect(restored.sqlite.query('SELECT * FROM agent_runs').all()).toEqual([]);
        expect(restored.sqlite.query('SELECT COUNT(*) AS n FROM extraction_acks').get()).toEqual({ n: 2 });
        expect(restored.sqlite.query('SELECT SUM(eligible_prompts) AS n FROM session_read_facts').get()).toEqual({ n: 0 });
      } finally { restored.sqlite.close(); }
    } finally { f.sqlite.close(); }
  });
});
