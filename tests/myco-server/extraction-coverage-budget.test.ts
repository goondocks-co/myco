import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { ensureAgent, recordDispatch } from '@myco-server-worker/core/runs.js';
import { recordServedPrompts } from '@myco-server-worker/core/served-material.js';
import { acknowledgePrompt } from '@myco-server-worker/core/extraction-acks.js';
import { assertExtractionPlans, extractionSqlStore } from './helpers/extraction-sql.js';
import { fixtureBatchStore } from './helpers/extraction-budget.js';
import { measuredStore } from './helpers/read-budget.js';
import { uuid } from './helpers/fixtures.js';

import { PROMPTS, ACKS, PAGE, scope, runId, RECORD_ACK_SEEK, fill, acknowledgeHistory, restoreCapturedHistory } from './helpers/extraction-coverage.js';

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
