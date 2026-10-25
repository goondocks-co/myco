import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { planEventWrite } from '@myco-server-worker/ingest/events.js';
import { ensureAgent, recordDispatch } from '@myco-server-worker/core/runs.js';
import { hasProcessedPrompts } from '@myco-server-worker/read/prompts.js';
import { assertExtractionPlans, extractionSqlStore } from './helpers/extraction-sql.js';
import { fixtureBatchStore } from './helpers/extraction-budget.js';
import { measuredStore } from './helpers/read-budget.js';
import { PAGE, scope, runId, fill, acknowledgeHistory, restoreCapturedHistory } from './helpers/extraction-coverage.js';

it('D1 acknowledgement existence stays bounded with 7k and 14k acknowledged prompts in other sessions', async () => {
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
    const rowAndIndex = 2;
    let previous = 0;
    for (const acknowledged of [7_000, 14_000]) {
      await restoreCapturedHistory(source, d1, previous, acknowledged);
      const initialization = measuredStore(d1);
      expect(await hasProcessedPrompts(initialization.db, scope)).toBe(previous > 0);
      expect(initialization.reads()).toBeLessThanOrEqual(2 * rowAndIndex);
      await acknowledgeHistory(fixtureBatchStore(d1), acknowledged, previous);
      const measured = measuredStore(d1);
      expect(await hasProcessedPrompts(measured.db, scope)).toBe(true);
      expect(measured.reads()).toBeLessThanOrEqual(2 * rowAndIndex);
      console.info('EXTRACTION_STEADY_COST', { acknowledged, reads: measured.reads() });
      previous = acknowledged;
    }
  } finally { planning.close(); await mf.dispose(); }
}, 240_000);
