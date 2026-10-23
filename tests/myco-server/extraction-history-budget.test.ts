import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { planEventWrite } from '@myco-server-worker/ingest/events.js';
import { listUnprocessedPrompts } from '@myco-server-worker/read/prompts.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { handleBlob } from '@myco-server-worker/ingest/blobs.js';
import { parseTranscripts } from '@myco-server-worker/ingest/parse.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { ensureAgent, recordDispatch } from '@myco-server-worker/core/runs.js';
import { recordServedPrompts } from '@myco-server-worker/core/served-material.js';
import { acknowledgePrompt } from '@myco-server-worker/core/extraction-acks.js';
import { memoryBlobStore, sqliteEnv } from './helpers/fixtures.js';
import { markPromptProcessed } from './helpers/extraction.js';
import { MAX_PAGE } from '@myco-server-worker/read/scope.js';
import { assertExtractionPlans, extractionSqlStore } from './helpers/extraction-sql.js';
import { fixtureBatchStore } from './helpers/extraction-budget.js';
import { measuredStore } from './helpers/read-budget.js';

const scope = { projectId: 'history-budget' };
const PAGE = 20;
const LOOKAHEAD = 1;
const LIVE_GROUPS = 2;
const COMPLETION_RANGES = 2;
const ORIGINS = 2;
const CURSOR_CLASSES = 2;
const PARTITIONS = 2;
const ROW_AND_INDEX = 2;
const PRIMARY_SELECTIONS = 2;
const PINNED_POSITIONS = 2;
const BODY_READS = 1;
const RESPONSE_PROBE = 1;
const CURSOR_PAGES = 2;
const FIXTURE_BATCH = 64;
const MAX_VISITS = PAGE + LOOKAHEAD;
const STATEMENT_BOUND = LIVE_GROUPS * COMPLETION_RANGES + PRIMARY_SELECTIONS + PINNED_POSITIONS + ORIGINS * CURSOR_CLASSES * PARTITIONS + BODY_READS;
const METADATA_READ_BOUND = MAX_VISITS * (2 * ROW_AND_INDEX + ORIGINS) + ROW_AND_INDEX * (LIVE_GROUPS * COMPLETION_RANGES + PINNED_POSITIONS + PRIMARY_SELECTIONS);
const readBound = (includeText: boolean) => METADATA_READ_BOUND + (includeText ? PAGE * (ROW_AND_INDEX + RESPONSE_PROBE) : 0);
const sessionId = (i: number) => `history-${String(i).padStart(5, '0')}`;

async function initialize(db: RelationalStore) {
  for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
  await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('history-budget','History',1)").run();
}
async function capture(db: RelationalStore, begin: number, end: number, active = false) {
  const batched = fixtureBatchStore(db);
  const context = { projectId: scope.projectId, machineId: 'fixture', tokenId: 'capture', bodyBytes: 0, now: 10_000_000, writeOrigin: 'server' as const };
  const one = async (i: number, kind: 'prompt' | 'session.end') => {
    const write = await planEventWrite(batched, context, { eventId: crypto.randomUUID(), sessionId: sessionId(i), kind,
      createdAt: kind === 'prompt' ? i + 1 : 1_000_000 + i, channel: 'cli', producer: { adapter: 'claude-code', version: 'test' },
      payload: kind === 'prompt' ? { promptId: crypto.randomUUID(), text: 'History material', origin: i % ORIGINS === 0 ? 'user' : 'unknown' } : { endedAt: 1_000_000 + i } });
    if (!write.ok || !write.write.interpret(await batched.batch(write.write.statements)).persisted) throw new Error('history capture failed');
  };
  for (const kind of active ? ['prompt'] as const : ['prompt', 'session.end'] as const) {
    for (let start = begin; start < end; start += FIXTURE_BATCH) {
      await Promise.all(Array.from({ length: Math.min(FIXTURE_BATCH, end - start) }, (_, offset) => one(start + offset, kind)));
    }
  }
  console.info('EXTRACTION_HISTORY_FIXTURE', { begin, end, active });
}
async function cursorAt(db: RelationalStore, count: number, includeActive = false) {
  let cursor: string | undefined, consumed = 0;
  while (consumed < count) {
    const result = await listUnprocessedPrompts(db, scope, { limit: Math.min(MAX_PAGE, count - consumed), cursor, includeActive });
    if (result.rows.length === 0 || result.cursor === null) throw new Error('fixture traversal ended before its deep position');
    consumed += result.rows.length;
    cursor = result.cursor;
  }
  return cursor!;
}
async function verifyHistory(mode: 'deep' | 'floor') {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  const sqlite = new Database(':memory:');
  try {
    const d1 = await mf.getD1Database('DB'), native = sqliteRelationalStore(sqlite);
    await initialize(d1); await initialize(native);
    let previous = 0;
    for (const count of [400, 1200]) {
      await capture(d1, previous, count); await capture(native, previous, count);
      for (const [target, db] of [['D1', d1], ['native', native]] as const) for (const includeText of [false, true]) {
        if (mode === 'deep') {
          let cursor = await cursorAt(db, count - CURSOR_PAGES * PAGE);
          for (let part = 0; part < CURSOR_PAGES; part++) {
            const measured = measuredStore(d1);
            const tracked = extractionSqlStore(target === 'D1' ? measured.db : db);
            const result = await listUnprocessedPrompts(tracked.db, scope, { limit: PAGE, cursor, includeText });
            expect(tracked.prepared.length).toBeLessThanOrEqual(STATEMENT_BOUND);
            if (target === 'D1') expect(measured.reads()).toBeLessThanOrEqual(readBound(includeText));
            expect(result.rows.map(row => row.sessionId)).toEqual(Array.from({ length: PAGE }, (_, i) => sessionId((CURSOR_PAGES - part) * PAGE - 1 - i)));
            await assertExtractionPlans(db, tracked.queries, target);
            console.info('EXTRACTION_HISTORY_COST', { target, count, part, kind: 'deep', includeText, statements: tracked.prepared.length,
              reads: measured.reads(), statementBound: STATEMENT_BOUND, readBound: readBound(includeText) });
            expect(result.cursor).not.toBeNull();
            cursor = result.cursor!;
          }
        } else {
          const measured = measuredStore(d1);
          const floor = '9007199254740991:~';
          for (const cursor of [floor, 'ex1:' + JSON.stringify([sessionId(count - 1), false, floor])]) {
            measured.reset();
            const tracked = extractionSqlStore(target === 'D1' ? measured.db : db);
            const result = await listUnprocessedPrompts(tracked.db, scope, { limit: PAGE, cursor, includeText });
            expect(tracked.prepared.length).toBeLessThanOrEqual(STATEMENT_BOUND);
            if (target === 'D1') expect(measured.reads()).toBeLessThanOrEqual(readBound(includeText));
            expect(result.rows).toEqual([]);
            expect(result.cursor).not.toBeNull();
            expect(JSON.parse(result.cursor!.slice(4)).history.prompt).toBe(false);
            await assertExtractionPlans(db, tracked.queries, target);
            console.info('EXTRACTION_HISTORY_COST', { target, count, kind: cursor.startsWith('ex1:') ? 'legacy floor' : 'plain floor', includeText,
              statements: tracked.prepared.length, reads: measured.reads(), statementBound: STATEMENT_BOUND, readBound: readBound(includeText) });
          }
        }
      }
      previous = count;
    }
    if (mode === 'deep') for (const [target, db] of [['D1', d1], ['native', native]] as const) {
      await capture(db, 1200, 1204, true);
      let cursor: string | null = await cursorAt(db, 1200, true);
      const seen: string[] = [];
      const tracked = extractionSqlStore(db);
      while (cursor !== null) {
        const result = await listUnprocessedPrompts(tracked.db, scope, { limit: 2, cursor, includeActive: true, includeText: true });
        seen.push(...result.rows.map(row => row.sessionId)); cursor = result.cursor;
      }
      expect(seen).toEqual([1203, 1202, 1201, 1200].map(sessionId));
      expect(tracked.prepared.some(sql => sql.includes('ended_at IS NULL') && sql.includes('session_id <'))).toBe(true);
      await assertExtractionPlans(db, tracked.queries, target);
    }
  } finally { sqlite.close(); await mf.dispose(); }
}

it('D1 deep history page uses tuple seeks with fixed costs at 400 and 1200 candidate sessions', () => verifyHistory('deep'), 120_000);
it('D1 empty-floor pages retain progress with fixed costs at 400 and 1200 candidate sessions', () => verifyHistory('floor'), 120_000);

type TraversalSession = { id: string; prompts: number; createdAt: number; endedAt: number | null; live: boolean };

it('traverses live completed, live active, imported completed and imported active material without repeats or misses', async () => {
  for (const limit of [1, 3]) {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
      compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
    const sqlite = new Database(':memory:'), support = sqliteEnv();
    try {
      const d1 = await mf.getD1Database('DB');
      for (const [target, store] of [['native', sqliteRelationalStore(sqlite)], ['D1', d1]] as const) {
        const db: RelationalStore = store;
        await initialize(db);
        const now = Date.now(), runId = 'traversal-run';
        const env = { ...support.serverEnv, db, blobs: memoryBlobStore() };
        await ensureMember(db, 'mem_traversal', now, 'member', 'Traversal');
        const credential = await issueMemberToken(db, { memberId: 'mem_traversal', machineId: 'fixture' }, now);
        await ensureAgent(db, { id: 'traversal', name: 'Traversal', provider: null, model: null, enabled: true }, now);
        await recordDispatch(db, scope, { id: runId, agentId: 'traversal', task: 'extract-curate', provider: null, model: null,
          runContext: null, dispatchedBy: credential.tokenId, startedAt: now });
        const blob = await sha256Hex('\n');
        const upload = await handleBlob(env, new Request('https://fixture/blobs/' + blob, {
          method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': '1' }, body: '\n',
        }), { projectId: scope.projectId, machineId: 'fixture', tokenId: credential.tokenId, now, clock: () => now,
          contentLength: 1, params: { key: blob } });
        expect(await upload.json()).toMatchObject({ stored: true });
        const specs: TraversalSession[] = [
          { id: 'L-late', prompts: 3, createdAt: 1000, endedAt: 9000, live: true },
          { id: 'L-tie-b', prompts: 2, createdAt: 1000, endedAt: 7000, live: true },
          { id: 'L-tie-a', prompts: 2, createdAt: 1000, endedAt: 7000, live: true },
          { id: 'L-active', prompts: 2, createdAt: 2000, endedAt: null, live: true },
          { id: 'I-late', prompts: 4, createdAt: 3000, endedAt: 9500, live: false },
          { id: 'I-tie-b', prompts: 1, createdAt: 3000, endedAt: 5000, live: false },
          { id: 'I-tie-a', prompts: 1, createdAt: 3000, endedAt: 5000, live: false },
          { id: 'I-early', prompts: 3, createdAt: 100, endedAt: 2000, live: false },
          { id: 'I-active-b', prompts: 2, createdAt: 4000, endedAt: null, live: false },
          { id: 'I-active-a', prompts: 2, createdAt: 4000, endedAt: null, live: false },
        ];
        const ids = new Map<string, string[]>(), expected = new Set<string>();
        const captureSession = async (spec: TraversalSession) => {
          const exists = ids.has(spec.id);
          const context = { projectId: scope.projectId, machineId: 'fixture', tokenId: credential.tokenId, bodyBytes: 0, now, writeOrigin: 'server' as const };
          const write = async (kind: string, at: number, payload: Record<string, unknown>) => {
            const plan = await planEventWrite(db, context, { eventId: crypto.randomUUID(), sessionId: spec.id, kind, createdAt: at,
              channel: spec.live ? 'cli' : 'import', producer: { adapter: 'claude-code', version: 'test' }, payload });
            if (!plan.ok || !plan.write.interpret(await db.batch(plan.write.statements)).persisted) throw new Error('traversal capture failed');
          };
          if (!exists) {
            ids.set(spec.id, []);
            await write('transcript.segment', spec.createdAt, { transcriptId: 'tx_' + crypto.randomUUID().replaceAll('-', ''),
              baseOffset: 0, length: 1, blob, agent: 'claude-code' });
          }
          for (let i = 0; i < spec.prompts; i++) {
            const promptId = crypto.randomUUID();
            await write('prompt', spec.createdAt + i, { promptId, text: 'Traversal material', origin: i % ORIGINS === 0 ? 'user' : 'unknown' });
            ids.get(spec.id)!.push(promptId); expected.add(promptId);
          }
          if (spec.endedAt !== null) await write('session.end', spec.endedAt, { endedAt: spec.endedAt });
        };
        const parse = async () => {
          await parseTranscripts(env, now, { budget: { calls: 1000, wallMs: 10_000 }, clock: () => 0 });
          expect(await db.prepare('SELECT SUM(pending_transcripts) AS n FROM session_read_facts WHERE project_id=?')
            .bind(scope.projectId).first()).toEqual({ n: 0 });
        };
        for (const spec of specs) await captureSession(spec);
        await parse();
        expect((await db.prepare('SELECT session_id AS id FROM session_read_facts WHERE project_id=? AND live_transcripts>0 ORDER BY session_id')
          .bind(scope.projectId).all()).results).toEqual(specs.filter(spec => spec.live).map(spec => ({ id: spec.id })).sort((a, b) => a.id.localeCompare(b.id)));
        const covered = ids.get('I-late')![0]!;
        expect(await markPromptProcessed(db, scope, covered)).toBe(true); expected.delete(covered);
        const seen: string[] = [], sessions: string[] = [], groups: number[] = [];
        let cursor: string | undefined, pages = 0;
        do {
          const page = await listUnprocessedPrompts(db, scope, { limit, cursor, includeActive: true, includeText: true });
          for (const row of page.rows) {
            seen.push(row.promptId);
            if (row.sessionId !== 'L-late' && sessions.at(-1) !== row.sessionId) sessions.push(row.sessionId);
            const spec = specs.find(item => item.id === row.sessionId)!;
            groups.push((spec.live ? 0 : 2) + (spec.endedAt === null ? 1 : 0));
          }
          const tracked = extractionSqlStore(db);
          const served = await recordServedPrompts(tracked.db, scope, runId, page.rows, now);
          for (const item of served.filter((_, i) => i % 2 === 0)) expect(await acknowledgePrompt(db, scope, runId, { servedId: item.servedId }, now)).toMatchObject({ marked: true });
          if (pages === 0) {
            for (const query of tracked.queries.filter(query => query.sql.startsWith('SELECT m.record_id'))) {
              const plan = (await db.prepare('EXPLAIN QUERY PLAN ' + query.sql).bind(...query.binds).all<{ detail: string }>()).results.map(row => row.detail).join('\n');
              expect(plan).toMatch(/SCAN j VIRTUAL TABLE[\s\S]*SEARCH m USING INDEX idx_run_served_material_record \(project_id=\? AND run_id=\? AND record_id=\?\)/);
            }
            await captureSession({ ...specs.find(spec => spec.id === 'I-early')!, prompts: 1, createdAt: 1950 });
          }
          if (pages === 1) {
            const added = { id: 'I-newer', prompts: 1, createdAt: 1400, endedAt: 1500, live: false };
            specs.push(added); await captureSession(added); await parse();
          }
          cursor = page.cursor ?? undefined; pages++;
          expect(pages).toBeLessThan(100);
        } while (cursor !== undefined);
        expect(seen).toHaveLength(expected.size);
        expect(new Set(seen)).toEqual(expected);
        expect(groups).toEqual([...groups].sort((a, b) => a - b));
        expect(sessions).toEqual(['L-tie-b', 'L-tie-a', 'L-active', 'I-late', 'I-tie-b', 'I-tie-a', 'I-early', 'I-newer', 'I-active-b', 'I-active-a']);
        console.info('EXTRACTION_ACTIVE_TRAVERSAL', { target, limit, pages, prompts: seen.length });
      }
    } finally { sqlite.close(); support.sqlite.close(); await mf.dispose(); }
  }
}, 120_000);
