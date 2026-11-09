import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { memoryBlobStore, recordingLimiter } from './helpers/fixtures.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { preparePromptAcknowledgement } from './helpers/extraction.js';
import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applySchemaSteps } from './helpers/migrate.js';
import { planEventWrite } from '@myco-server-worker/ingest/events.js';
import { handleBlob, type BlobResult } from '@myco-server-worker/ingest/blobs.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { rawMemberResourceSql } from '@myco-server-worker/db/raw/resources.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { LAST_ACTIVITY_SQL, LAST_REQUEST_KEY, lastActivityAt } from '@myco-server-worker/core/activity.js';
import { RETENTION_CANDIDATES_SQL, pruneTerminalRuns } from '@myco-server-worker/db/runs/retention.js';
import {
  sessions_listProjects as listProjects,
  sessions_listProjectsSql as listProjectsSql,
} from '@myco-server-worker/read/catalog/sessions.js';
import { notTombstonedSql } from '@myco-server-worker/db/session-read-model.js';
import { measuredStore } from './helpers/read-budget.js';
import { sharedChecks } from '@myco-server-worker/ingest/projections.js';
import { KINDS } from '@myco-server-worker/ingest/kinds.js';

const PROJECT = 'proj_event_budget';
const BLOB = await sha256Hex('x');
const CONTEXT = { projectId: PROJECT, machineId: 'machine', tokenId: 'credential', bodyBytes: 100, now: 2_000 };
const ROW_READ_LIMIT = 64;
/** A complete capture settles its session end and presented dates from the keyed lifecycle facts: the fact row, the phase row, the transcript and document seeks. */
const LIFECYCLE_CAPTURE_READS = 16;
/** The lifecycle event walk's index, and the facts row a session's first lifecycle event creates. */
const LIFECYCLE_EVENT_INDEX_WRITES = 1;
const LIFECYCLE_FACT_INSERT_WRITES = 1;
const CORPUS_SIZES = [1_000, 10_000] as const;
const ACTIVE_COUNTER_INDEX_REPLACE_WRITES = 2;
const ACTIVE_COUNTER_INDEX_UPDATE_WRITES = 1;
/** A session's first prompt after learning resumed queues the session for learning initialization: one row. */
const LEARNING_QUEUE_WRITES = 1;
/** A content event queues its session's publication; the session's first one also opens its document row. */
const DOCUMENT_QUEUE_WRITES = 5;
/** A session's first transcript makes its document due: the row and its due index entry. */
const DOCUMENT_DUE_WRITES = 2;
/** A transcript header's session page index stores one entry. */
const TRANSCRIPT_PAGE_INDEX_WRITES = 1;
/** Health's credential and receipt-time indexes each add one session insert entry. */
const SESSION_HEALTH_INDEX_WRITES = 2;
/** Health's receipt-time index adds one transcript insert entry. */
const TRANSCRIPT_HEALTH_INDEX_WRITES = 1;
/** Heads write on receipt-minute advances and canonical identity changes. */
const CAPTURE_HEAD_INSERT_WRITES = 1;
/** A new session contributes one fact, one daily row and at most one lineage row. */
const KPI_PROJECTION_WRITES = 3;
/** A human prompt's first delivery records its identity's earliest instant and the session's latest turn, and writes one idx_session_user_prompt_firsts entry. */
const LIFECYCLE_PROMPT_WRITES = 2;
/** An end moves the session's winning-end fact row. */
const LIFECYCLE_END_WRITES = 1;
/** A live transcript's arrival moves its session's live-transcript count. */
const LIFECYCLE_TRANSCRIPT_WRITES = 1;
/** A live prompt contributes one fact and one daily row. */
const KPI_PROMPT_PROJECTION_WRITES = 2;
/** An unpinned transcript contributes one scheme-conflict fact and one daily row. */
const KPI_TRANSCRIPT_PROJECTION_WRITES = 2;
/** One-card learning completion writes coverage, attribution, session progress, the session's Project rollup and learning mark, and the landed write's one idx_agent_run_events_write entry. */
const LEARNING_SLICE_COMPLETION_WRITES = 19;
/** A transcript or frontier mutation writes its contribution, session total and input revision. */
const PUBLICATION_CONTRIBUTION_WRITES = 3;
/** Growth past a complete frontier changes its pending contribution and generation total too. */
const PUBLICATION_FRONTIER_REOPEN_WRITES = 2;
/** The publication directory orders transcripts by role, receipt and canonical id. */
const PUBLICATION_DIRECTORY_INDEX_WRITES = 1;
/** New source input resets an in-progress session directory cursor by key. */
const PUBLICATION_DIRECTORY_RESTART_WRITES = 1;
/** Turn lifecycle changes fence in-flight publication and restart its directory. */
const PUBLICATION_LIFECYCLE_REVISION_WRITES = 1;
/** A registered transcript contributes its pin, group admission and scheme total. */
const PUBLICATION_PIN_WRITES = 3;
/** A session's title work row, written or moved when its state changes. */
/** A transcript's pin row gains an entry in the session-keyed index the deletion job pages. */
const DELETION_PIN_INDEX_WRITES = 1;
const TITLE_WORK_WRITES = 1;
const CAPTURE_WRITE_LIMITS = {
  'session.start': TITLE_WORK_WRITES + LIFECYCLE_EVENT_INDEX_WRITES + LIFECYCLE_FACT_INSERT_WRITES + 38 + SESSION_HEALTH_INDEX_WRITES + CAPTURE_HEAD_INSERT_WRITES + KPI_PROJECTION_WRITES, prompt: 30 + TITLE_WORK_WRITES + LIFECYCLE_EVENT_INDEX_WRITES + LIFECYCLE_PROMPT_WRITES + ACTIVE_COUNTER_INDEX_REPLACE_WRITES + LEARNING_QUEUE_WRITES + DOCUMENT_QUEUE_WRITES + KPI_PROMPT_PROJECTION_WRITES,
  notification: 16 + ACTIVE_COUNTER_INDEX_UPDATE_WRITES, 'transcripts insert': DELETION_PIN_INDEX_WRITES + LIFECYCLE_TRANSCRIPT_WRITES + PUBLICATION_PIN_WRITES + PUBLICATION_DIRECTORY_INDEX_WRITES + 14 + DOCUMENT_DUE_WRITES + TRANSCRIPT_PAGE_INDEX_WRITES + TRANSCRIPT_HEALTH_INDEX_WRITES + KPI_TRANSCRIPT_PROJECTION_WRITES + PUBLICATION_CONTRIBUTION_WRITES,
  'transcript grows after full publish': 3 + TRANSCRIPT_PAGE_INDEX_WRITES + TRANSCRIPT_HEALTH_INDEX_WRITES + PUBLICATION_CONTRIBUTION_WRITES + PUBLICATION_FRONTIER_REOPEN_WRITES,
  'transcript grows during directory pass': 3 + TRANSCRIPT_PAGE_INDEX_WRITES + TRANSCRIPT_HEALTH_INDEX_WRITES + PUBLICATION_CONTRIBUTION_WRITES + PUBLICATION_FRONTIER_REOPEN_WRITES + PUBLICATION_DIRECTORY_RESTART_WRITES,
  'publication-progress UPDATE': 3 + PUBLICATION_CONTRIBUTION_WRITES, 'session.end': 26 + TITLE_WORK_WRITES + 2 * PUBLICATION_LIFECYCLE_REVISION_WRITES + LIFECYCLE_END_WRITES + LIFECYCLE_EVENT_INDEX_WRITES, 'learning slice completion': LEARNING_SLICE_COMPLETION_WRITES,
} as const;
type CaptureWrite = keyof typeof CAPTURE_WRITE_LIMITS;
const CAPTURE_WRITE_NAMES = Object.keys(CAPTURE_WRITE_LIMITS) as CaptureWrite[];

it('D1 event admission reads stay bounded as unrelated archive bundles and events grow', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    await applySchemaSteps(db);
    await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?, ?, 1)').bind(PROJECT, PROJECT).run();
    await db.prepare("INSERT INTO members(id,label,created_at) VALUES('member','member',1)").run();
    await db.prepare("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','member',1)").run();
    await db.prepare(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES('credential','member','machine','hash',1,99999999,'credential',1)`).run();
    await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES(?,'session','machine','credential',1,1)`).bind(PROJECT).run();
    // A session whose lifecycle facts already stand: a first touch reconciles history once, and this reads the steady state after it.
    await db.prepare("INSERT INTO session_lifecycle_facts(project_id,session_id) VALUES(?,'session')").bind(PROJECT).run();
    const blobs = memoryBlobStore();
    const env = serverEnvFromBindings({ MYCO_DB: db, BUCKET: blobs, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() });
    const uploaded = await handleBlob(env, new Request(`http://127.0.0.1/blobs/${BLOB}`, {
      method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'x',
    }), { ...CONTEXT, now: 1, clock: () => 1, contentLength: 1, params: { key: BLOB } });
    const stored = await uploaded.json() as BlobResult;
    if (!stored.stored) throw new Error(JSON.stringify(stored));
    await db.prepare("INSERT INTO session_documents(project_id,session_id,state,generation,updated_at,due_at) VALUES(?,'session','live',1,1,0)").bind(PROJECT).run();
    const reads: number[] = [];
    const captureReads: number[] = [];
    const media: { before: number[]; after: number[] } = { before: [], after: [] };
    const measured = measuredStore(db);
    for (const size of CORPUS_SIZES) {
      const sequence = `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<${size})`;
      await db.prepare(`${sequence} INSERT OR IGNORE INTO archive_bundles(id,project_id,session_id,token_id,event_id,envelope_hash,archive_key,receipt_key,digest,size,version,entry_count)
        SELECT i,?,'session','credential','archive-event-'||i,'hash','archive-'||i,'receipt-'||i,'digest',1,1,1 FROM seq`).bind(PROJECT).run();
      await db.prepare(`${sequence} INSERT OR IGNORE INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,raw_revision)
        SELECT ?,'seed-'||i,'session','credential','notification','cli','{}','hash',1,1,1 FROM seq`).bind(PROJECT).run();
      await db.prepare(`${sequence} INSERT OR IGNORE INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        SELECT ?,printf('%064d',i),1,'text/plain','credential',1,'00000000-0000-4000-8000-000000000001' FROM seq`).bind(PROJECT).run();
      const sessionId = `capture-${size}`;
      await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        VALUES(?,?,'machine','credential',1,1)`).bind(PROJECT, sessionId).run();
      await db.prepare("INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES(?,?,'live',1,1)").bind(PROJECT, sessionId).run();
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
      expect(newMedia.results).toEqual([{ media_type: stored.mediaType }]);
      expect(newMedia.results).toEqual(oldMedia.results);
      media.before.push(oldMedia.meta.rows_read);
      media.after.push(newMedia.meta.rows_read);
      const eventId = crypto.randomUUID();
      measured.reset();
      const planned = await planEventWrite(measured.db, CONTEXT, {
        eventId, sessionId, kind: 'prompt', createdAt: 1_000, channel: 'import',
        producer: { adapter: 'claude-code', version: '1' }, payload: { promptId: crypto.randomUUID(), blob: BLOB, origin: 'user' },
      }, { db: measured.db, blobs });
      if (!planned.ok) throw new Error(JSON.stringify(planned));
      const planningReads = measured.reads();
      const result = await measured.db.batch(planned.write.statements);
      expect(planned.write.interpret(result)).toEqual({ persisted: true, projected: true });
      const meta = result[0]!.meta;
      if (!('rows_read' in meta) || typeof meta.rows_read !== 'number') throw new Error('D1 admission metadata has no row-read count');
      reads.push(planningReads + meta.rows_read);
      captureReads.push(measured.reads());
      expect(await db.prepare('SELECT owner_member_id,provenance FROM raw_credentials WHERE token_id=?').bind('credential').first<{ owner_member_id: string; provenance: string }>())
        .toEqual({ owner_member_id: 'member', provenance: 'recorded' });
      expect((await db.prepare('SELECT raw_revision FROM events WHERE project_id=? AND event_id=?').bind(PROJECT, eventId).first<{ raw_revision: number }>())!.raw_revision).toBeGreaterThan(0);
      expect(await db.prepare('SELECT session_id FROM storage_cleanup_queue WHERE project_id=? AND resource_kind=? AND resource_id=?').bind(PROJECT, 'event', eventId).first<{ session_id: string }>())
        .toEqual({ session_id: sessionId });
    }
    console.info('EVENT_ADMISSION_READ_BUDGET ' + JSON.stringify({ sizes: CORPUS_SIZES, rowsRead: reads, captureRowsRead: captureReads }));
    expect(blobs.gets).toHaveLength(CORPUS_SIZES.length);
    for (const [index, rowsRead] of reads.entries()) {
      expect(rowsRead, `event admission at ${CORPUS_SIZES[index]} archive bundles`).toBeLessThanOrEqual(ROW_READ_LIMIT);
      expect(captureReads[index]!, `complete capture at ${CORPUS_SIZES[index]} archive bundles`).toBeLessThanOrEqual(ROW_READ_LIMIT + LIFECYCLE_CAPTURE_READS);
    }
    expect(reads[1]).toBe(reads[0]);
    for (const [name, rows] of [['blob-media-type', media]] as const) {
      console.info('HISTORY_READ_BUDGET ' + JSON.stringify({ name, sizes: CORPUS_SIZES, ...rows }));
      for (const after of rows.after) expect(after).toBeLessThanOrEqual(ROW_READ_LIMIT);
      expect(rows.after[1]).toBe(rows.after[0]);
      expect(rows.before[0]!).toBeGreaterThan(ROW_READ_LIMIT);
      expect(rows.before[1]!).toBeGreaterThan(rows.before[0]!);
    }
    const proof = `SELECT ${rawMemberResourceSql('?', 'blob', '?', '?')} AS admitted`;
    const native = new Database(':memory:');
    try {
      await applySchemaSteps(sqliteRelationalStore(native));
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
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  const native = new Database(':memory:');
  try {
    const d1 = await mf.getD1Database('DB');
    const nativeDb = sqliteRelationalStore(native);
    const stores = [d1 as unknown as RelationalStore, nativeDb];
    await applySchemaSteps(d1);
    await applySchemaSteps(nativeDb);
    const measured = measuredStore(d1);
    for (const db of stores) {
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','p',1)").run();
      await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
    }
    const totals: Record<string, { before: number[]; after: number[] }> = Object.fromEntries(
      ['project-list', 'finished-run', 'last-activity'].map(name => [name, { before: [], after: [] }]));
    const plans: Array<{ details: string; indexes: readonly string[]; ordered: boolean }> = [];
    const read = async (run: () => Promise<unknown>) => { measured.reset(); await run(); return measured.reads(); };
    for (const size of CORPUS_SIZES) {
      for (const db of stores) {
        const seq = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${size})`;
        await db.prepare(`${seq} INSERT OR IGNORE INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,ended_at)
          SELECT 'p',printf('session-%06d',i),'machine','token',i,i,i FROM n`).run();
        await db.prepare(`${seq} INSERT OR IGNORE INTO session_prompts(project_id,prompt_id,session_id,generation,turn_key,created_at,ord,origin)
          SELECT 'p',printf('prompt-%06d',i),printf('session-%06d',i),1,printf('prompt-%06d',i),i,i,'user' FROM n`).run();
        await db.prepare(`${seq} INSERT OR IGNORE INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at)
          SELECT 'p',printf('run-%06d',i),'agent','extract-curate','completed',i*2,i*2 FROM n`).run();
      }
      totals['project-list']!.before.push(await read(() => measured.db.prepare(OLD_PROJECTS_SQL).all()));
      totals['project-list']!.after.push(await read(() => listProjects(measured.db)));
      totals['finished-run']!.after.push(await read(() => pruneTerminalRuns(measured.db, 0, 500)));
      totals['last-activity']!.after.push(await read(() => lastActivityAt(measured.db)));
      for (const db of stores) {
        expect((await db.prepare(listProjectsSql()).all()).results).toEqual((await db.prepare(OLD_PROJECTS_SQL).all()).results);
        const selected = (await db.prepare(RETENTION_CANDIDATES_SQL).bind(size, 10).all()).results;
        const activity = await lastActivityAt(db);
        await db.prepare(LAST_ACTIVITY_SQL).bind(LAST_REQUEST_KEY).all();
        if (db !== nativeDb) for (const [index] of HISTORY_INDEXES) await db.prepare(`DROP INDEX IF EXISTS ${index}`).run();
        expect((await db.prepare(RETENTION_CANDIDATES_SQL).bind(size, 10).all()).results).toEqual(selected);
        expect(await lastActivityAt(db)).toEqual(activity);
        await db.prepare(LAST_ACTIVITY_SQL).bind(LAST_REQUEST_KEY).all();
      }
      totals['finished-run']!.before.push(await read(() => pruneTerminalRuns(measured.db, 0, 500)));
      totals['last-activity']!.before.push(await read(() => lastActivityAt(measured.db)));
      for (const [, sql] of HISTORY_INDEXES) await d1.prepare(sql).run();
      for (const db of stores) for (const [sql, binds, indexes] of [
        [listProjectsSql(), [], ['idx_session_read_activity']],
        [RETENTION_CANDIDATES_SQL, [0, 500], ['idx_agent_runs_retention']],
        [LAST_ACTIVITY_SQL, [LAST_REQUEST_KEY], ['idx_sessions_capture', 'idx_agent_runs_activity']],
      ] as const) {
        const details = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results.map(row => row.detail).join('\n');
        plans.push({ details, indexes, ordered: sql === RETENTION_CANDIDATES_SQL });
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

it('D1 capture writes stay within their rows-written ceilings at both corpus sizes', async () => {
  const captureWrites = new Map<CaptureWrite, number[][]>(CAPTURE_WRITE_NAMES.map(name => [name, []]));
  for (const size of CORPUS_SIZES) {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
      compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
    try {
      const db = await mf.getD1Database('DB');
      await applySchemaSteps(db);
      await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?, ?, 1)').bind(PROJECT, PROJECT).run();
      await db.prepare("INSERT INTO members(id,label,created_at) VALUES('member','member',1)").run();
      await db.prepare("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','member',1)").run();
      await db.prepare(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
        VALUES('credential','member','machine','hash',1,99999999,'credential',1)`).run();
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_history','history',1)").run();
      const seq = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${size})`;
      await db.prepare(`${seq} INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        SELECT 'proj_history','session-'||i,'machine','credential',1,1 FROM n`).run();
      await db.prepare(`${seq} INSERT INTO session_prompts(project_id,prompt_id,session_id,generation,turn_key,created_at,ord,origin)
        SELECT 'proj_history','prompt-'||i,'session-'||i,1,'prompt-'||i,1,i,'user' FROM n`).run();
      await db.prepare(`${seq} INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,parsed_offset,first_received_at,last_received_at,token_id)
        SELECT 'proj_history','transcript-'||i,'session-'||i,'machine',100,0,1,1,'credential' FROM n`).run();
      const measured = measuredStore(db);
      const sessionId = `capture-${size}`;
      const promptIds: string[] = [];
      const writes = new Map<CaptureWrite, number[]>(CAPTURE_WRITE_NAMES.map(name => [name, []]));
      const capture = async (name: CaptureWrite, run: () => Promise<unknown>) => {
        measured.reset();
        await run();
        writes.get(name)!.push(measured.writes());
      };
      let now = CONTEXT.now;
      const event = async (kind: 'session.start' | 'prompt' | 'notification' | 'session.end', payload: Record<string, unknown>) => {
        now += 10;
        const planned = await planEventWrite(measured.db, { ...CONTEXT, now }, {
          eventId: crypto.randomUUID(), sessionId, kind, createdAt: now, channel: 'cli',
          producer: { adapter: 'claude-code', version: '1' }, payload,
        });
        if (!planned.ok) throw new Error(JSON.stringify(planned));
        await capture(kind, async () => {
          expect(planned.write.interpret(await measured.db.batch(planned.write.statements)))
            .toEqual(kind === 'notification' ? { persisted: true } : { persisted: true, projected: true });
        });
      };
      await event('session.start', { agent: 'claude-code' });
      for (let i = 0; i < 5; i++) {
        const promptId = crypto.randomUUID();
        promptIds.push(promptId);
        await event('prompt', { promptId, text: `hello ${i}`, origin: 'user' });
      }
      for (let i = 0; i < 5; i++) await event('notification', { message: `n${i}` });
      await capture('transcripts insert', () => measured.db.prepare(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,parsed_offset,first_received_at,last_received_at,token_id)
        VALUES(?,?,?,'machine',100,0,1,1,'credential')`).bind(PROJECT, sessionId, sessionId).run());
      await db.prepare("INSERT INTO transcript_publication(project_id,transcript_id,generation,session_id,published_offset,record_scheme,parser_version,updated_at) VALUES(?,?,1,?,0,'source-record-v1',1,1)").bind(PROJECT,sessionId,sessionId).run();
      for (let i = 1; i <= 5; i++) await capture('publication-progress UPDATE', () => measured.db.prepare(
        'UPDATE transcript_publication SET published_offset=? WHERE project_id=? AND transcript_id=?').bind(i * 10, PROJECT, sessionId).run());
      for (let i=1;i<=5;i++) {
        await db.prepare('UPDATE transcript_publication SET published_offset=? WHERE project_id=? AND transcript_id=? AND generation=1')
          .bind(100+(i-1)*10,PROJECT,sessionId).run();
        await capture('transcript grows after full publish', () => measured.db.prepare('UPDATE transcripts SET size=? WHERE project_id=? AND transcript_id=?')
          .bind(100+i*10,PROJECT,sessionId).run());
      }
      await db.prepare('UPDATE transcript_publication SET published_offset=150 WHERE project_id=? AND transcript_id=?').bind(PROJECT,sessionId).run();
      await db.prepare("UPDATE session_documents SET publication_after='[]' WHERE project_id=? AND session_id=?").bind(PROJECT,sessionId).run();
      await capture('transcript grows during directory pass', () => measured.db.prepare('UPDATE transcripts SET size=160 WHERE project_id=? AND transcript_id=?').bind(PROJECT,sessionId).run());
      await event('session.end', { endedAt: now });
      const configured=serverEnvFromBindings({MYCO_DB:db,BUCKET:memoryBlobStore(),SOURCE_LIMIT:recordingLimiter(),TOKEN_LIMIT:recordingLimiter()});
      await publishDocuments({...configured,blobs:memoryBlobStore()},now,{calls:500,deadline:Infinity,clock:()=>now});
      const acknowledge = await preparePromptAcknowledgement(measured.db, { projectId: PROJECT }, promptIds[0]!);
      await capture('learning slice completion', async () => { expect(await acknowledge()).toBe(true); });
      for (const name of CAPTURE_WRITE_NAMES) captureWrites.get(name)!.push(writes.get(name)!);
    } finally { await mf.dispose(); }
  }
  for (const [name, rowsWritten] of captureWrites) {
    console.info('CAPTURE_WRITE_BUDGET ' + JSON.stringify({ name, sizes: CORPUS_SIZES, rowsWritten, ceiling: CAPTURE_WRITE_LIMITS[name] }));
  }
  for (const [name, callsBySize] of captureWrites) {
    for (const calls of callsBySize) for (const rows of calls) expect(rows, name).toBeLessThanOrEqual(CAPTURE_WRITE_LIMITS[name]);
    expect(callsBySize[1], name).toEqual(callsBySize[0]);
  }
}, 120_000);
