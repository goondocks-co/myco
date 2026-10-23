import { describe, expect, it } from 'bun:test';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { ensureAgent, recordDispatch, pruneTerminalRuns } from '@myco-server-worker/core/runs.js';
import { recordServedPrompts } from '@myco-server-worker/core/served-material.js';
import { handleRunPrompts } from '@myco-server-worker/mcp/tools/run-prompts.js';
import type { ToolContext } from '@myco-server-worker/mcp/context.js';
import { readWindowFor } from '@myco-server-worker/core/read-window.js';
import { runAllowlist } from '@myco-server-worker/mcp/run-surface.js';
import { TASK_TOOLS } from '@myco-server-worker/core/task-catalogue.js';
import { extractionHistorySessions, hasProcessedPrompts, listUnprocessedPrompts } from '@myco-server-worker/read/prompts.js';
import { nothingUnread } from '@myco-server-worker/core/run-postconditions.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { createBackup, backupArtifact, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { extractionSqlEnv as sqliteEnv, assertExtractionSql } from './helpers/extraction-sql.js';

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
    return { promptId, sessionId, createdAt, endedAt: now };
  };
  await ensureAgent(f.db, { id: 'coverage', name: 'Coverage', provider: null, model: null, enabled: true }, now);
  const run = async (runId = crypto.randomUUID(), projectId = scope.projectId, startedAt = now) => {
    expect(await recordDispatch(f.db, { projectId }, { id: runId, agentId: 'coverage', task: 'extract-curate', provider: null,
      model: null, runContext: null, dispatchedBy: null, startedAt })).toBe(true);
    const ctx: ToolContext = { env, projectId, now, principal: { kind: 'run', runId, task: 'extract-curate', agentId: 'coverage',
      sessionId: null, runContext: null, tokenId: 'capture', allow: runAllowlist(TASK_TOOLS['extract-curate']!, { dryRun: false }), window: readWindowFor('extract-curate') } };
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
  it('advances empty pages under plain and legacy floors and snapshot cutoffs without declaring all material read', async () => {
    const f = await fixture();
    try {
      const sessionIds = Array.from({ length: 55 }, (_, i) => 'visit-' + String(i).padStart(3, '0'));
      for (const [i, id] of sessionIds.entries()) await f.capture(id, i + 1);
      const floor = '9007199254740991:~';
      for (const mode of ['plain', 'legacy', 'snapshot'] as const) {
        const history = mode === 'snapshot' ? { receivedThrough: f.now - 1, sessionIds } : undefined;
        let cursor: string | null = mode === 'plain' ? floor : mode === 'legacy' ? 'ex1:' + JSON.stringify([sessionIds.at(-1), false, floor]) : null;
        const visited = new Set<string>();
        let pages = 0;
        do {
          const result = await listUnprocessedPrompts(f.db, f.scope, { limit: 2, cursor: cursor ?? undefined, history });
          expect(result.rows).toEqual([]);
          cursor = result.cursor; pages++;
          if (cursor !== null) {
            const decoded = JSON.parse(cursor.slice(4));
            expect(decoded.history.prompt).toBe(false);
            expect(decoded.floor).toBe(mode === 'snapshot' ? null : floor);
            expect(visited.has(decoded.history.position.id)).toBe(false);
            visited.add(decoded.history.position.id);
          }
          expect(pages).toBeLessThanOrEqual(sessionIds.length);
        } while (cursor !== null);
        expect(pages).toBeGreaterThan(1);
        expect(await nothingUnread(f.db, f.scope)).toBe(false);
      }
      const run = await f.run();
      const empty = await run.call({ op: 'unprocessed', cursor: floor, limit: 2, include_text: true }) as { prompts: unknown[]; next_cursor: string | null };
      expect(empty.prompts).toEqual([]);
      expect(empty.next_cursor).not.toBeNull();
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM run_served_material').get()).toEqual({ n: 0 });
      const resumed = await run.call({ op: 'unprocessed', cursor: empty.next_cursor!, limit: 2, include_text: true }) as { prompts: unknown[]; next_cursor: string | null };
      expect(resumed.prompts).toEqual([]);
      expect(resumed.next_cursor).not.toBe(empty.next_cursor);
      expect(await nothingUnread(f.db, f.scope)).toBe(false);
      const fresh = await run.call({ op: 'unprocessed', limit: 2, include_text: true }) as { prompts: { served_id: string }[] };
      expect(fresh.prompts).toHaveLength(2);
      expect(fresh.prompts.every(row => typeof row.served_id === 'string')).toBe(true);
    } finally { f.sqlite.close(); }
  });

  it('pages history in candidate-session order with immutable positions, snapshot cutoffs and scoped cursor structure', async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 10; i++) await f.capture('zz-primary', 100 + i);
      const later = [];
      for (let i = 0; i < 3; i++) later.push(await f.capture('yy-history', 200 + i));
      const older = [await f.capture('aa-history', 1), await f.capture('aa-history', 2)];
      const history = { receivedThrough: f.now, sessionIds: ['zz-primary', 'yy-history', 'aa-history'] };
      const first = await listUnprocessedPrompts(f.db, f.scope, { limit: 4, history });
      expect(first.rows.map(row => row.sessionId)).toEqual(['zz-primary', 'zz-primary', 'zz-primary', 'yy-history']);
      await expect(listUnprocessedPrompts(f.db, { projectId: 'proj_2' }, { cursor: first.cursor! })).rejects.toThrow('Invalid extraction cursor');
      await expect(listUnprocessedPrompts(f.db, f.scope, { cursor: 'ex1:' + JSON.stringify(['', null, null]) })).rejects.toThrow('Invalid extraction cursor');
      const forged = JSON.parse(first.cursor!.slice(4));
      forged.history.prompt = 'invalid-key';
      await expect(listUnprocessedPrompts(f.db, f.scope, { cursor: 'ex2:' + JSON.stringify(forged) })).rejects.toThrow('Invalid extraction cursor');
      f.sqlite.run("UPDATE sessions SET ended_at=? WHERE project_id='proj_1' AND session_id='yy-history'", [f.now + 100]);
      const late = await f.capture('zzz-late', 300);
      const seen = [...first.rows];
      let cursor = first.cursor;
      while (cursor !== null) {
        const next = await listUnprocessedPrompts(f.db, f.scope, { limit: 4, history, cursor });
        seen.push(...next.rows); cursor = next.cursor;
      }
      expect(new Set(seen.map(row => row.promptId)).size).toBe(15);
      expect(seen.filter(row => row.sessionId !== 'zz-primary').map(row => row.promptId)).toEqual([...later, ...older].map(row => row.promptId));
      expect(seen.some(row => row.promptId === late.promptId)).toBe(false);
      expect((await listUnprocessedPrompts(f.db, f.scope)).rows.some(row => row.promptId === late.promptId)).toBe(true);
    } finally { f.sqlite.close(); }
  });

  it('continues immutable cursors after anchor deletion and session tombstones', async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 8; i++) await f.capture('zz-primary', 100 + i);
      for (let i = 0; i < 3; i++) await f.capture('yy-history', 200 + i);
      const remaining = [await f.capture('aa-history', 1), await f.capture('aa-history', 2)];
      const first = await listUnprocessedPrompts(f.db, f.scope, { limit: 4 });
      const anchor = first.rows[2]!;
      f.sqlite.run('DELETE FROM prompt_batches WHERE project_id=? AND prompt_id=?', [f.scope.projectId, anchor.promptId]);
      const next = await listUnprocessedPrompts(f.db, f.scope, { limit: 4, cursor: first.cursor! });
      expect(next.rows).toHaveLength(4);
      expect(next.rows.some(row => first.rows.some(prior => prior.promptId === row.promptId))).toBe(false);
      await tombstoneSession(f.env, f.scope, 'zz-primary', 'test', f.now);
      await tombstoneSession(f.env, f.scope, 'yy-history', 'test', f.now);
      const tail = await listUnprocessedPrompts(f.db, f.scope, { limit: 4, cursor: next.cursor! });
      expect(tail.rows.map(row => row.promptId)).toEqual(remaining.map(row => row.promptId));
      expect(tail.cursor).toBeNull();
      expect((await listUnprocessedPrompts(f.db, f.scope, { cursor: '100:' + anchor.promptId })).rows.map(row => row.promptId)).toEqual([]);
    } finally { f.sqlite.close(); }
  });

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
      const backup = await createBackup(f.db, f.env.blobs, { producer: 'test', now: f.now });
      const { text } = (await backupArtifact(f.db, f.env.blobs, backup.id))!;
      const options = { text, allowForeignLineage: true, authorization: { kind: 'recovery' as const } };
      await restoreArtifact(restored.db, options);
      restored.sqlite.run("UPDATE session_read_facts SET eligible_prompts=18 WHERE project_id='proj_1'");
      await restoreArtifact(restored.db, options);
      expect(restored.sqlite.query("SELECT eligible_prompts FROM session_read_facts WHERE project_id='proj_1' ORDER BY session_id").all()).toEqual([{ eligible_prompts: 1 }, { eligible_prompts: 1 }]);
      restored.sqlite.run("UPDATE session_read_facts SET eligible_prompts=18 WHERE project_id='proj_1'");
      let recounts = 0;
      const interrupted = { prepare(sql: string) {
        if (sql.startsWith('UPDATE session_read_facts SET eligible_prompts =')) { recounts++; throw new Error('interrupted recount'); }
        return restored.db.prepare(sql);
      }, batch: restored.db.batch };
      await expect(restoreArtifact(interrupted, options)).rejects.toThrow('interrupted recount');
      expect(recounts).toBe(1);
      expect(restored.sqlite.query("SELECT DISTINCT eligible_prompts FROM session_read_facts WHERE project_id='proj_1'").all()).toEqual([{ eligible_prompts: 18 }]);
      expect(restored.sqlite.query("SELECT next_row FROM backup_restore_progress WHERE table_name LIKE 'extraction-session-counters:%'").all()).toEqual([{ next_row: 0 }]);
      const before = restored.prepared.length;
      await restoreArtifact(restored.db, options);
      expect(restored.prepared.slice(before).filter(sql => sql.startsWith('UPDATE session_read_facts SET eligible_prompts ='))).toHaveLength(1);
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
      const page = await r.call({ op: 'unprocessed', include_text: true }) as { prompts: { prompt_id: string; served_id: string }[] };
      const served = page.prompts.find(p => p.prompt_id === first.promptId)!;
      expect(await r.call({ op: 'mark_processed', served_id: served.served_id })).toMatchObject({ marked: true });
      expect(await r.call({ op: 'mark_processed', served_id: served.served_id })).toMatchObject({ marked: false });
      const hole = await f.capture('session', 100);
      const next = await f.run();
      const rest = await next.call({ op: 'unprocessed', include_text: true }) as { prompts: { prompt_id: string; served_id: string }[] };
      expect(rest.prompts.map(p => p.prompt_id)).toEqual([hole.promptId, tie.promptId]);
      expect(await hasProcessedPrompts(f.db, f.scope)).toBe(true);
      expect(await nothingUnread(f.db, f.scope)).toBe(false);
      expect(await extractionHistorySessions(f.db, f.scope)).toEqual(['session']);
      f.assertCounts();
      for (const item of rest.prompts) expect(await next.call({ op: 'mark_processed', served_id: item.served_id })).toMatchObject({ marked: true });
      expect(await nothingUnread(f.db, f.scope)).toBe(true);
      expect(await extractionHistorySessions(f.db, f.scope)).toEqual([]);
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
      const backup = await createBackup(f.db, f.env.blobs, { producer: 'test', now: f.now });
      const { text } = (await backupArtifact(f.db, f.env.blobs, backup.id))!;
      await restoreArtifact(restored.db, { text, blobs: restoredEnv.blobs, allowForeignLineage: true, authorization: { kind: 'recovery' } });
      expect(restored.sqlite.query('SELECT COUNT(*) AS n FROM extraction_acks').get()).toEqual({ n: 2 });
      expect(restored.sqlite.query("SELECT eligible_prompts AS n FROM session_read_facts WHERE project_id='proj_1' AND session_id='session'").get()).toEqual({ n: 1 });
      await restoreArtifact(restored.db, { text, blobs: restoredEnv.blobs, allowForeignLineage: true, authorization: { kind: 'recovery' } });
      expect(restored.sqlite.query("SELECT eligible_prompts AS n FROM session_read_facts WHERE project_id='proj_1' AND session_id='session'").get()).toEqual({ n: 1 });
      await tombstoneSession(f.env, f.scope, 'session', 'test', f.now);
      f.assertCounts();
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
      expect((await listUnprocessedPrompts(f.db, f.scope)).rows).toEqual([]);
      f.assertCounts();
      const backup = await createBackup(f.db, f.env.blobs, { producer: 'test', now: f.now });
      const { text } = (await backupArtifact(f.db, f.env.blobs, backup.id))!;
      const restored = sqliteEnv();
      try {
        await restoreArtifact(restored.db, { text, authorization: { kind: 'recovery' }, allowForeignLineage: true });
        expect(restored.sqlite.query('SELECT * FROM agent_runs').all()).toEqual([]);
        expect(restored.sqlite.query('SELECT COUNT(*) AS n FROM extraction_acks').get()).toEqual({ n: 2 });
        expect(await nothingUnread(restored.db, f.scope)).toBe(true);
      } finally { restored.sqlite.close(); }
    } finally { f.sqlite.close(); }
  });
});
