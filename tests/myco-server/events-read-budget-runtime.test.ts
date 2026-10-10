import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { planEventWrite } from '@myco-server-worker/ingest/events.js';
import { rawMemberResourceSql } from '@myco-server-worker/core/raw-resources.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { LAST_ACTIVITY_SQL, LAST_REQUEST_KEY, lastActivityAt } from '@myco-server-worker/core/activity.js';
import { RETENTION_CANDIDATES_SQL, pruneTerminalRuns } from '@myco-server-worker/core/runs.js';
import { listUnprocessedPrompts, newestUnprocessedSession, newestUnprocessedSessionQuery, READ_ORIGINS } from '@myco-server-worker/read/prompts.js';
import { listProjects, listProjectsSql } from '@myco-server-worker/read/sessions.js';
import { notTombstonedSql } from '@myco-server-worker/core/tombstones.js';
import { sessionMaterialReadySql } from '@myco-server-worker/read/material-readiness.js';
import { measuredStore } from './helpers/read-budget.js';
import { blobDecisionStatements } from '@myco-server-worker/core/object-release.js';
import { sharedChecks } from '@myco-server-worker/ingest/projections.js';
import { KINDS } from '@myco-server-worker/ingest/kinds.js';
import { hasUnprocessedPrompts } from '@myco-server-worker/core/schedule-rules.js';

const PROJECT = 'proj_event_budget';
const BLOB = '0'.repeat(64);
const CONTEXT = { projectId: PROJECT, machineId: 'machine', tokenId: 'credential', bodyBytes: 100, now: 2_000 };
const ROW_READ_LIMIT = 64;
const CORPUS_SIZES = [1_000, 10_000] as const;

it('D1 event admission reads stay bounded as unrelated archive bundles and events grow', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
    await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?, ?, 1)').bind(PROJECT, PROJECT).run();
    await db.prepare("INSERT INTO members(id,label,created_at) VALUES('member','member',1)").run();
    await db.prepare("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','member',1)").run();
    await db.prepare(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES('credential','member','machine','hash',1,99999999,'credential',1)`).run();
    await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES(?,'session','machine','credential',1,1)`).bind(PROJECT).run();
    await db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
      VALUES(?, ?,1,'text/plain','credential',1,'00000000-0000-4000-8000-000000000001')`).bind(PROJECT, BLOB).run();
    const reads: number[] = [];
    const media: { before: number[]; after: number[] } = { before: [], after: [] };
    const retention: { before: number[]; after: number[] } = { before: [], after: [] };
    const retentionLive: { before: number[]; after: number[] } = { before: [], after: [] };
    const measured = measuredStore(db);
    for (const size of CORPUS_SIZES) {
      const sequence = `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<${size})`;
      await db.prepare(`${sequence} INSERT OR IGNORE INTO archive_bundles(id,project_id,session_id,token_id,event_id,envelope_hash,archive_key,receipt_key,digest,size,version,entry_count)
        SELECT i,?,'session','credential','archive-event-'||i,'hash','archive-'||i,'receipt-'||i,'digest',1,1,1 FROM seq`).bind(PROJECT).run();
      await db.prepare(`${sequence} INSERT OR IGNORE INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,raw_revision)
        SELECT ?,'seed-'||i,'session','credential','notification','cli','{}','hash',1,1,1 FROM seq`).bind(PROJECT).run();
      await db.prepare(`${sequence} INSERT OR IGNORE INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        SELECT ?,printf('%064d',i),1,'text/plain','credential',1,'00000000-0000-4000-8000-000000000001' FROM seq`).bind(PROJECT).run();
      await db.prepare(`${sequence} INSERT OR IGNORE INTO blob_release_candidates(project_id,key,created_at)
        SELECT ?,printf('%064d',i),1 FROM seq`).bind(PROJECT).run();
      await db.prepare('INSERT OR IGNORE INTO blob_release_candidates(project_id,key,created_at) VALUES(?,?,1)').bind(PROJECT, BLOB).run();
      await db.prepare("INSERT OR IGNORE INTO recovery_holds(token,holder,acquired_at) VALUES(?,'operator',1)").bind('hold-' + size).run();
      const pageSql = `(SELECT json_extract(j.value, '$.p') AS p, json_extract(j.value, '$.k') AS k FROM json_each(?) j)`;
      const page = JSON.stringify([{ p: PROJECT, k: BLOB }]);
      const oldDecisions: RelationalStore = { ...measured.db, prepare: sql => measured.db.prepare(sql
        .replace(`(project_id, key) IN (SELECT c.p, c.k FROM ${pageSql} c)`,
          `EXISTS (SELECT 1 FROM ${pageSql} c WHERE c.p = ${sql.startsWith('DELETE FROM blobs') ? 'blobs' : 'blob_release_candidates'}.project_id AND c.k = ${sql.startsWith('DELETE FROM blobs') ? 'blobs' : 'blob_release_candidates'}.key)`)
        .replace(`(rc.project_id, rc.key) IN (SELECT c.p, c.k FROM ${pageSql} c)`,
          `EXISTS (SELECT 1 FROM ${pageSql} c WHERE c.p = rc.project_id AND c.k = rc.key)`)) };
      measured.reset();
      await oldDecisions.batch(blobDecisionStatements(oldDecisions, page, 2));
      retention.before.push(measured.reads());
      measured.reset();
      await measured.db.batch(blobDecisionStatements(measured.db, page, 2));
      retention.after.push(measured.reads());
      await db.prepare("UPDATE recovery_holds SET released_at=2,release_reason='complete',released_by='operator' WHERE released_at IS NULL").run();
      const envelope = { eventId: 'media-read', sessionId: 'session', kind: 'prompt', createdAt: 1, channel: 'cli' as const,
        producer: { adapter: 'test', version: '1' }, payload: { promptId: 'prompt', blob: BLOB, origin: 'user' },
        payloadJson: '{}', payloadBytes: new TextEncoder().encode('{}') };
      const mediaRead = sharedChecks(KINDS.find(kind => kind.name === 'prompt')!,
        { projectId: PROJECT, machineId: 'machine', tokenId: 'credential', now: 2, nonce: 'nonce', actor: null }, envelope, envelope.payload, [])
        .find(check => check.read.sql.startsWith('SELECT media_type'))!.read;
      const oldMediaSql = mediaRead.sql.replace(/AND NOT EXISTS \(SELECT 1 FROM archive_bundles a WHERE 'blob'='blob' AND a.project_id=r.project_id\s+AND a.archive_key=r.resource_id\)\s+AND NOT EXISTS \(SELECT 1 FROM archive_bundles a WHERE 'blob'='blob' AND a.project_id=r.project_id\s+AND a.receipt_key=r.resource_id\)/,
        "AND NOT EXISTS (SELECT 1 FROM archive_bundles a WHERE 'blob'='blob' AND a.project_id=r.project_id AND (a.archive_key=r.resource_id OR a.receipt_key=r.resource_id))");
      const oldMedia = await db.prepare(oldMediaSql).bind(...mediaRead.params).all();
      const newMedia = await db.prepare(mediaRead.sql).bind(...mediaRead.params).all();
      expect(newMedia.results).toEqual([{ media_type: 'text/plain' }]);
      expect(newMedia.results).toEqual(oldMedia.results);
      media.before.push(oldMedia.meta.rows_read);
      media.after.push(newMedia.meta.rows_read);
      const eventId = crypto.randomUUID();
      const planned = await planEventWrite(db as unknown as RelationalStore, CONTEXT, {
        eventId, sessionId: 'session', kind: 'prompt', createdAt: 1_000, channel: 'import',
        producer: { adapter: 'claude-code', version: '1' }, payload: { promptId: crypto.randomUUID(), blob: BLOB, origin: 'user' },
      });
      if (!planned.ok) throw new Error(JSON.stringify(planned));
      const result = await db.batch(planned.write.statements as unknown as Parameters<typeof db.batch>[0]);
      expect(planned.write.interpret(result)).toEqual({ persisted: true, projected: true });
      const rowsRead = result[0]!.meta.rows_read;
      reads.push(rowsRead);
      expect(await db.prepare('SELECT owner_member_id,provenance FROM raw_credentials WHERE token_id=?').bind('credential').first<{ owner_member_id: string; provenance: string }>())
        .toEqual({ owner_member_id: 'member', provenance: 'recorded' });
      expect((await db.prepare('SELECT raw_revision FROM events WHERE project_id=? AND event_id=?').bind(PROJECT, eventId).first<{ raw_revision: number }>())!.raw_revision).toBeGreaterThan(0);
      expect(await db.prepare('SELECT session_id FROM storage_cleanup_queue WHERE project_id=? AND resource_kind=? AND resource_id=?').bind(PROJECT, 'event', eventId).first<{ session_id: string }>())
        .toEqual({ session_id: 'session' });
      measured.reset();
      await oldDecisions.batch(blobDecisionStatements(oldDecisions, page, 2));
      retentionLive.before.push(measured.reads());
      await db.prepare('INSERT INTO blob_release_candidates(project_id,key,created_at) VALUES(?,?,1)').bind(PROJECT, BLOB).run();
      measured.reset();
      await measured.db.batch(blobDecisionStatements(measured.db, page, 2));
      retentionLive.after.push(measured.reads());
    }
    console.info('EVENT_INSERT_READ_BUDGET ' + JSON.stringify({ sizes: CORPUS_SIZES, rowsRead: reads }));
    for (const [index, rowsRead] of reads.entries()) {
      expect(rowsRead, `events INSERT at ${CORPUS_SIZES[index]} archive bundles`).toBeLessThanOrEqual(ROW_READ_LIMIT);
    }
    expect(reads[1]).toBe(reads[0]);
    for (const [name, rows] of [['blob-retention-held-page', retention], ['blob-retention-live-page', retentionLive], ['blob-media-type', media]] as const) {
      console.info('HISTORY_READ_BUDGET ' + JSON.stringify({ name, sizes: CORPUS_SIZES, ...rows }));
      for (const after of rows.after) expect(after).toBeLessThanOrEqual(ROW_READ_LIMIT);
      expect(rows.after[1]).toBe(rows.after[0]);
      expect(rows.before[0]!).toBeGreaterThan(ROW_READ_LIMIT);
      expect(rows.before[1]!).toBeGreaterThan(rows.before[0]!);
    }
    const proof = `SELECT ${rawMemberResourceSql('?', 'blob', '?', '?')} AS admitted`;
    const native = new Database(':memory:');
    try {
      for (const step of SCHEMA_STEPS) for (const sql of step.statements) native.exec(sql);
      const nativePlan = native.query<{ detail: string }, [string, string, string]>(`EXPLAIN QUERY PLAN ${proof}`).all(PROJECT, BLOB, 'member');
      const d1Plan = (await db.prepare(`EXPLAIN QUERY PLAN ${proof}`).bind(PROJECT, BLOB, 'member').all<{ detail: string }>()).results;
      for (const plan of [nativePlan, d1Plan]) {
        const archives = plan.filter(row => row.detail.includes(' a ')).map(row => row.detail);
        expect(archives).toHaveLength(2);
        expect(archives.some(detail => detail.includes('project_id=? AND archive_key=?'))).toBe(true);
        expect(archives.some(detail => detail.includes('project_id=? AND receipt_key=?'))).toBe(true);
      }
    } finally { native.close(); }
    const allowed = (key: string) => db.prepare(`SELECT ${rawMemberResourceSql('?', 'blob', '?', '?')} AS admitted`).bind(PROJECT, key, 'member').first<{ admitted: number }>();
    expect(await allowed(BLOB)).toEqual({ admitted: 1 });
    for (const key of ['archive-1', 'receipt-1']) {
      await db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        VALUES(?, ?,1,'text/plain','credential',1,'00000000-0000-4000-8000-000000000001')`).bind(PROJECT, key).run();
      expect(await allowed(key)).toEqual({ admitted: 0 });
    }
  } finally { await mf.dispose(); }
}, 120_000);

const OLD_SESSION_SQL = `SELECT s.session_id AS id, s.ended_at AS endedAt,
  EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id = s.project_id AND t.session_id = s.session_id AND t.imported_at IS NULL) AS liveCapture
  FROM (SELECT DISTINCT p.session_id FROM prompt_batches p WHERE p.project_id = ? AND p.processed = 0 AND p.origin IN (${READ_ORIGINS.map(() => '?').join(',')})) candidates
  JOIN sessions s ON s.session_id = candidates.session_id
  WHERE s.project_id = ? AND s.ended_at IS NOT NULL AND ${notTombstonedSql('s')} AND ${sessionMaterialReadySql('s')}
  ORDER BY liveCapture DESC, s.ended_at DESC, s.session_id DESC LIMIT 1`;
const OLD_PROJECTS_SQL = `SELECT p.project_id, p.name, p.created_at, p.archived_at, p.archived_by,
  COUNT(s.session_id) AS session_count, MAX(s.last_received_at) AS last_activity_at
  FROM projects p LEFT JOIN sessions s ON s.project_id = p.project_id AND ${notTombstonedSql('s')}
  WHERE p.archived_at IS NULL GROUP BY p.project_id,p.name,p.created_at,p.archived_at,p.archived_by
  ORDER BY last_activity_at DESC NULLS LAST,p.created_at DESC`;
const HISTORY_INDEXES = [
  ['idx_agent_runs_retention', `CREATE INDEX idx_agent_runs_retention ON agent_runs(resumable, COALESCE(completed_at, started_at), id)
    WHERE status IN ('completed', 'failed', 'skipped') AND resumable = 0`],
  ['idx_agent_runs_activity', 'CREATE INDEX idx_agent_runs_activity ON agent_runs(started_at)'],
] as const;

it('D1 recurring history readers keep the existing rows-read budget at both corpus sizes', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
  const native = new Database(':memory:');
  try {
    const d1 = await mf.getD1Database('DB');
    const nativeDb = sqliteRelationalStore(native);
    const stores = [d1 as unknown as RelationalStore, nativeDb];
    for (const step of SCHEMA_STEPS) {
      await d1.batch(step.statements.map(sql => d1.prepare(sql)));
      for (const sql of step.statements) native.exec(sql);
    }
    const measured = measuredStore(d1);
    for (const db of stores) {
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','p',1)").run();
      await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
    }
    const totals: Record<string, { before: number[]; after: number[] }> = Object.fromEntries(
      ['session-selection', 'schedule-precondition', 'empty-selection', 'project-list', 'finished-run', 'last-activity'].map(name => [name, { before: [], after: [] }]));
    const plans: Array<{ details: string; indexes: readonly string[]; ordered: boolean }> = [];
    const read = async (run: () => Promise<unknown>) => { measured.reset(); await run(); return measured.reads(); };
    for (const size of CORPUS_SIZES) {
      for (const db of stores) {
        const seq = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${size})`;
        await db.prepare(`${seq} INSERT OR IGNORE INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,ended_at)
          SELECT 'p',printf('session-%06d',i),'machine','token',i,i,i FROM n`).run();
        await db.prepare(`${seq} INSERT OR IGNORE INTO prompt_batches(project_id,prompt_id,session_id,event_id,content_hash,created_at,updated_at,token_id,received_at,origin)
          SELECT 'p',printf('prompt-%06d',i),printf('session-%06d',i),'event','hash',i,i,'token',i,'user' FROM n`).run();
        await db.prepare(`${seq} INSERT OR IGNORE INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at)
          SELECT 'p',printf('run-%06d',i),'agent','extract-curate','completed',i*2,i*2 FROM n`).run();
      }
      const sessionBinds = ['p', ...READ_ORIGINS, 'p'];
      totals['session-selection']!.before.push(await read(() => measured.db.prepare(OLD_SESSION_SQL).bind(...sessionBinds).first()));
      totals['session-selection']!.after.push(await read(() => newestUnprocessedSession(measured.db, { projectId: 'p' })));
      const oldScheduleDb: RelationalStore = { ...measured.db, prepare: sql => sql === newestUnprocessedSessionQuery({ projectId: 'p' }).sql
        ? { ...measured.db.prepare(OLD_SESSION_SQL), bind: (project) => measured.db.prepare(OLD_SESSION_SQL).bind(project, ...READ_ORIGINS, project) }
        : measured.db.prepare(sql) };
      totals['schedule-precondition']!.before.push(await read(() => listUnprocessedPrompts(oldScheduleDb, { projectId: 'p' }, { limit: 1 })));
      totals['schedule-precondition']!.after.push(await read(async () => expect(await hasUnprocessedPrompts(measured.db, 'p')).toBe(true)));
      await d1.prepare('UPDATE sessions SET ended_at=NULL').run();
      totals['empty-selection']!.before.push(await read(() => measured.db.prepare(OLD_SESSION_SQL).bind(...sessionBinds).first()));
      totals['empty-selection']!.after.push(await read(async () => expect(await hasUnprocessedPrompts(measured.db, 'p')).toBe(false)));
      await d1.prepare('UPDATE sessions SET ended_at=last_received_at').run();
      totals['project-list']!.before.push(await read(() => measured.db.prepare(OLD_PROJECTS_SQL).all()));
      totals['project-list']!.after.push(await read(() => listProjects(measured.db)));
      totals['finished-run']!.after.push(await read(() => pruneTerminalRuns(measured.db, 0, 500)));
      totals['last-activity']!.after.push(await read(() => lastActivityAt(measured.db)));
      for (const db of stores) {
        expect(await newestUnprocessedSession(db, { projectId: 'p' })).toEqual(await db.prepare(OLD_SESSION_SQL).bind(...sessionBinds).first());
        expect((await db.prepare(listProjectsSql()).all()).results).toEqual((await db.prepare(OLD_PROJECTS_SQL).all()).results);
        const selected = (await db.prepare(RETENTION_CANDIDATES_SQL).bind(size, 10).all()).results;
        const activity = await lastActivityAt(db);
        await db.prepare(LAST_ACTIVITY_SQL).bind(LAST_REQUEST_KEY).all();
        await db.prepare(OLD_SESSION_SQL).bind(...sessionBinds).all();
        const candidateQuery = newestUnprocessedSessionQuery({ projectId: 'p' });
        await db.prepare(candidateQuery.sql).bind(...candidateQuery.binds).all();
        if (db !== nativeDb) for (const [index] of HISTORY_INDEXES) await db.prepare(`DROP INDEX IF EXISTS ${index}`).run();
        expect((await db.prepare(RETENTION_CANDIDATES_SQL).bind(size, 10).all()).results).toEqual(selected);
        expect(await lastActivityAt(db)).toEqual(activity);
        await db.prepare(LAST_ACTIVITY_SQL).bind(LAST_REQUEST_KEY).all();
      }
      totals['finished-run']!.before.push(await read(() => pruneTerminalRuns(measured.db, 0, 500)));
      totals['last-activity']!.before.push(await read(() => lastActivityAt(measured.db)));
      for (const [, sql] of HISTORY_INDEXES) await d1.prepare(sql).run();
      const selection = newestUnprocessedSessionQuery({ projectId: 'p' });
      for (const db of stores) for (const [sql, binds, indexes] of [
        [selection.sql, selection.binds, ['idx_session_read_extraction']],
        [listProjectsSql(), [], ['idx_session_read_activity']],
        [RETENTION_CANDIDATES_SQL, [0, 500], ['idx_agent_runs_retention']],
        [LAST_ACTIVITY_SQL, [LAST_REQUEST_KEY], ['idx_sessions_capture', 'idx_agent_runs_activity']],
      ] as const) {
        const details = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results.map(row => row.detail).join('\n');
        plans.push({ details, indexes, ordered: sql === selection.sql || sql === RETENTION_CANDIDATES_SQL });
      }
    }
    const budget = (values: number[]) => {
      for (const rows of values) expect(rows).toBeLessThanOrEqual(ROW_READ_LIMIT);
      expect(values[1]).toBe(values[0]);
    };
    for (const [name, rows] of Object.entries(totals)) {
      console.info('HISTORY_READ_BUDGET ' + JSON.stringify({ name, sizes: CORPUS_SIZES, ...rows }));
      budget(rows.after);
      expect(() => budget(rows.before), `${name}: restoring the old access path must kill the budget`).toThrow();
      expect(rows.before[1]!).toBeGreaterThan(rows.before[0]!);
    }
    for (const { details, indexes, ordered } of plans) {
      for (const index of indexes) expect(details).toContain(index);
      if (ordered) expect(details).not.toContain('TEMP B-TREE');
    }
  } finally { native.close(); await mf.dispose(); }
}, 120_000);
