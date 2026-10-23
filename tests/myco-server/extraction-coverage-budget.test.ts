import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { planEventWrite } from '@myco-server-worker/ingest/events.js';
import { ensureAgent, recordDispatch } from '@myco-server-worker/core/runs.js';
import { recordServedPrompts } from '@myco-server-worker/core/served-material.js';
import { acknowledgePrompt } from '@myco-server-worker/core/extraction-acks.js';
import { listUnprocessedPrompts } from '@myco-server-worker/read/prompts.js';
import { hasProcessedPrompts } from '@myco-server-worker/read/prompts.js';
import { nothingUnread } from '@myco-server-worker/core/run-postconditions.js';
import { assertExtractionPlans, extractionSqlStore } from './helpers/extraction-sql.js';
import { fixtureBatchStore } from './helpers/extraction-budget.js';
import { measuredStore } from './helpers/read-budget.js';
import { uuid } from './helpers/fixtures.js';
import { BACKUP_FORMAT, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';

const PROMPTS = 26_000;
const ACKS = 7_000;
const PAGE = 20;
const CONCURRENT = 64;
const WRITE_BATCH = 200;
const PROGRESS_EVERY = 1000;
const scope = { projectId: 'coverage-budget' };
const runId = 'coverage-budget-run';
const RECORD_ACK_SEEK = "SELECT 1 FROM extraction_acks WHERE project_id = ? AND record_id = ? AND kind = 'record' LIMIT 1";

async function fill(db: RelationalStore, prompts = PROMPTS, acks = ACKS) {
  for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
  await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('coverage-budget','Coverage',1)").run();
  await ensureAgent(db, { id: 'coverage', name: 'Coverage', provider: null, model: null, enabled: true }, 1);
  await recordDispatch(db, scope, { id: runId, agentId: 'coverage', task: 'extract-curate', provider: null, model: null,
    runContext: null, dispatchedBy: null, startedAt: Date.now() });
  const context = { projectId: scope.projectId, machineId: 'machine', tokenId: 'capture', bodyBytes: 0, now: 1, writeOrigin: 'server' as const };
  for (let start = 0; start < prompts; start += CONCURRENT) {
    await Promise.all(Array.from({ length: Math.min(CONCURRENT, prompts - start) }, async (_, offset) => {
      const i = start + offset;
      const write = await planEventWrite(db, context, {
        eventId: uuid(i + PROMPTS), sessionId: 'session', kind: 'prompt', createdAt: i, channel: 'cli',
        producer: { adapter: 'claude-code', version: 'test' }, payload: { promptId: uuid(i), text: 'Captured material', origin: 'user' },
      });
      if (!write.ok) throw new Error(JSON.stringify(write));
      const outcome = write.write.interpret(await db.batch(write.write.statements));
      if (!outcome.persisted) throw new Error(JSON.stringify(outcome));
    }));
    const completed = Math.min(start + CONCURRENT, prompts);
    if (completed === prompts || Math.floor(completed / PROGRESS_EVERY) !== Math.floor(start / PROGRESS_EVERY)) console.info('EXTRACTION_FIXTURE_PROGRESS', { stage: 'capture', completed, total: prompts });
  }
  const end = await planEventWrite(db, context, { eventId: crypto.randomUUID(), sessionId: 'session', kind: 'session.end', createdAt: prompts + 1, channel: 'cli', producer: { adapter: 'claude-code', version: 'test' }, payload: { endedAt: prompts + 1 } });
  if (!end.ok || !end.write.interpret(await db.batch(end.write.statements)).persisted) throw new Error('fixture session end failed');
  await acknowledgeHistory(db, acks);
}

async function acknowledgeHistory(db: RelationalStore, end = ACKS, begin = 0) {
  for (let start = begin; start < end; start += WRITE_BATCH) {
    const rows = Array.from({ length: Math.min(WRITE_BATCH, end - start) }, (_, offset) => ({ promptId: uuid(start + offset), sessionId: 'session', createdAt: start + offset, endedAt: 1 }));
    const served = await recordServedPrompts(db, scope, runId, rows, 1);
    await Promise.all(served.map(async item => {
      const ack = await acknowledgePrompt(db, scope, runId, { servedId: item.servedId }, 1);
      if (!('marked' in ack) || !ack.marked) throw new Error(JSON.stringify(ack));
    }));
    const completed = Math.min(start + WRITE_BATCH, end);
    if (completed === end || completed % PROGRESS_EVERY === 0) console.info('EXTRACTION_FIXTURE_PROGRESS', { stage: 'ack', completed, total: end });
  }
}

/** Restore only actual ingest-produced rows; acknowledgement fixtures use the production writers on the target. */
async function restoreCapturedHistory(source: RelationalStore, target: RelationalStore, begin = 0, end = PROMPTS) {
  const sessions = (await source.prepare('SELECT * FROM sessions').all<Record<string, unknown>>()).results;
  const prompts = (await source.prepare('SELECT * FROM prompt_batches ORDER BY created_at,prompt_id').all<Record<string, unknown>>()).results;
  const lineage = await source.prepare("SELECT value FROM schema_meta WHERE key='deployment_id'").first<{ value: string }>();
  for (let start = begin; start < end; start += 1000) {
    const rows = prompts.slice(start, Math.min(start + 1000, end));
    const header = { format: BACKUP_FORMAT, deploymentId: lineage!.value, schemaVersion: SERVER_SCHEMA_VERSION, createdAt: 1, producer: 'test',
      counts: { sessions: sessions.length, prompt_batches: rows.length } };
    const text = [JSON.stringify(header), ...sessions.map(row => JSON.stringify({ t: 'sessions', r: row })),
      ...rows.map(row => JSON.stringify({ t: 'prompt_batches', r: row }))].join('\n') + '\n';
    await restoreArtifact(target, { text, allowForeignLineage: true, authorization: { kind: 'recovery' } });
    console.info('EXTRACTION_FIXTURE_PROGRESS', { stage: 'restore', completed: Math.min(start + 1000, end), total: end });
  }
}

async function verify(db: RelationalStore, target: string) {
  const probes = [
    { sql: RECORD_ACK_SEEK, params: [scope.projectId, uuid(1)], index: 'idx_extraction_acks_record', equalities: 'project_id=? AND record_id=?' },
  ];
  for (const probe of probes) {
    const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${probe.sql}`).bind(...probe.params).all<{ detail: string }>()).results.map(row => row.detail).join('\n');
    expect(plan).toContain(probe.index);
    expect(plan).toContain(probe.equalities);
    expect(plan).not.toMatch(/SCAN (?:a\b|extraction_acks)|TEMP B-TREE/i);
    console.info('EXTRACTION_ACK_PLAN', { target, index: probe.index, plan });
  }
  const tracked = extractionSqlStore(db);
  const page = await listUnprocessedPrompts(tracked.db, scope, { limit: PAGE, includeText: true });
  expect(await nothingUnread(tracked.db, scope)).toBe(false);
  await assertExtractionPlans(db, tracked.queries, target);
  expect(page.rows.map(row => row.promptId)).toEqual(Array.from({ length: PAGE }, (_, i) => uuid(ACKS + i)));
  expect(await db.prepare('SELECT COUNT(*) AS n FROM prompt_batches').first()).toEqual({ n: PROMPTS });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM extraction_acks').first()).toEqual({ n: ACKS });
  expect(await db.prepare("SELECT eligible_prompts AS n FROM session_read_facts WHERE project_id=? AND session_id='session'").bind(scope.projectId).first()).toEqual({ n: PROMPTS - ACKS });
}

it('native equality seeks and counters at 26k captured prompts and 7k production acknowledgements', async () => {
  const sqlite = new Database(':memory:');
  try {
    const db = sqliteRelationalStore(sqlite);
    await fill(fixtureBatchStore(db));
    await verify(db, 'native');
  } finally { sqlite.close(); }
}, 240_000);

it('D1 equality seeks and constant-cost ack writes at 26k captured prompts and 7k acknowledgements', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  const planning = new Database(':memory:');
  try {
    const d1 = await mf.getD1Database('DB');
    const source = sqliteRelationalStore(planning);
    await fill(fixtureBatchStore(source), PROMPTS, 0);
    for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map(sql => d1.prepare(sql)));
    await d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('coverage-budget','Coverage',1)").run();
    await ensureAgent(d1, { id: 'coverage', name: 'Coverage', provider: null, model: null, enabled: true }, 1);
    await recordDispatch(d1, scope, { id: runId, agentId: 'coverage', task: 'extract-curate', provider: null, model: null,
      runContext: null, dispatchedBy: null, startedAt: Date.now() });
    await restoreCapturedHistory(source, d1);
    await acknowledgeHistory(fixtureBatchStore(d1));
    await verify(d1, 'D1');
    const measured = measuredStore(d1);
    measured.reset();
    await measured.db.prepare(RECORD_ACK_SEEK).bind(scope.projectId, uuid(1)).first();
    expect(measured.reads()).toBeLessThanOrEqual(2);
    const [item] = await recordServedPrompts(d1, scope, runId, [{ promptId: uuid(ACKS), sessionId: 'session', createdAt: ACKS, endedAt: 1 }], 1);
    measured.reset();
    expect(await acknowledgePrompt(measured.db, scope, runId, { servedId: item!.servedId }, 1)).toMatchObject({ marked: true });
    console.info('EXTRACTION_ACK_COST', { prompts: PROMPTS, acks: ACKS, reads: measured.reads(), writes: measured.writes() });
    const ackReads = { servedItemProbes: 2, targetPromptAndSession: 2, counter: 1, triggerPrompt: 1,
      priorCoverage: 1, ackProjectForeignKey: 1, attributionRunForeignKey: 1 };
    expect(measured.reads()).toBeLessThanOrEqual(Object.values(ackReads).reduce((sum, reads) => sum + reads, 0));
    expect(measured.writes()).toBe(12);
  } finally { planning.close(); await mf.dispose(); }
}, 240_000);

it('D1 page and nothingUnread stay bounded with 7k and 14k acknowledged prompts in other sessions', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  const planning = new Database(':memory:');
  try {
    const d1 = await mf.getD1Database('DB');
    const source = sqliteRelationalStore(planning);
    await fill(fixtureBatchStore(source), 14_000, 0);
    for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map(sql => d1.prepare(sql)));
    await d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('coverage-budget','Coverage',1)").run();
    await ensureAgent(d1, { id: 'coverage', name: 'Coverage', provider: null, model: null, enabled: true }, 1);
    await recordDispatch(d1, scope, { id: runId, agentId: 'coverage', task: 'extract-curate', provider: null, model: null,
      runContext: null, dispatchedBy: null, startedAt: Date.now() });
    const now = Date.now();
    const db: RelationalStore = d1;
    const context = { projectId: scope.projectId, machineId: 'machine', tokenId: 'capture', bodyBytes: 0, now, writeOrigin: 'server' as const };
    const freshIds: string[] = [];
    for (let i = 0; i <= PAGE; i++) {
      const promptId = crypto.randomUUID();
      const write = await planEventWrite(db, context, { eventId: crypto.randomUUID(), sessionId: 'fresh-session',
        kind: i === PAGE ? 'session.end' : 'prompt', createdAt: now + i, channel: 'cli', producer: { adapter: 'claude-code', version: 'test' },
        payload: i === PAGE ? { endedAt: now + PAGE } : { promptId, text: 'Fresh material', origin: 'user' } });
      if (!write.ok) throw new Error(JSON.stringify(write));
      if (!write.write.interpret(await db.batch(write.write.statements)).persisted) throw new Error('fresh capture failed');
      if (i < PAGE) freshIds.push(promptId);
    }
    const candidateSessions = 1;
    const counterSeeks = 4;
    const rowAndIndex = 2;
    const responseProbe = 1;
    const bodyReads = PAGE * (rowAndIndex + responseProbe);
    const pageBound = rowAndIndex * (counterSeeks * candidateSessions + PAGE) + bodyReads;
    const emptyBound = rowAndIndex * candidateSessions;
    let previous = 0;
    for (const acknowledged of [7_000, 14_000]) {
      await restoreCapturedHistory(source, d1, previous, acknowledged);
      const initialization = measuredStore(d1);
      expect(await hasProcessedPrompts(initialization.db, scope)).toBe(previous > 0);
      expect(initialization.reads()).toBeLessThanOrEqual(2 * rowAndIndex);
      await acknowledgeHistory(fixtureBatchStore(d1), acknowledged, previous);
      const measured = measuredStore(d1);
      const tracked = extractionSqlStore(measured.db);
      const page = await listUnprocessedPrompts(tracked.db, scope, { limit: PAGE, includeText: true });
      expect(page.rows.map(row => row.promptId)).toEqual(freshIds);
      const pageReads = measured.reads();
      expect(pageReads).toBeLessThanOrEqual(pageBound);
      measured.reset();
      expect(await nothingUnread(tracked.db, scope)).toBe(false);
      const emptyReads = measured.reads();
      expect(emptyReads).toBeLessThanOrEqual(emptyBound);
      measured.reset();
      expect(await hasProcessedPrompts(measured.db, scope)).toBe(true);
      expect(measured.reads()).toBeLessThanOrEqual(2 * rowAndIndex);
      await assertExtractionPlans(d1, tracked.queries, `D1 steady ${acknowledged}`);
      console.info('EXTRACTION_STEADY_COST', { acknowledged, pageReads, pageBound, emptyReads, emptyBound });
      previous = acknowledged;
    }
  } finally { planning.close(); await mf.dispose(); }
}, 240_000);
