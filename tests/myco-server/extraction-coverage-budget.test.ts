import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { schemaD1Root } from './helpers/schema-template.js';
import { ensureAgent } from '@myco-server-worker/db/runs/state.js';
import { recordDispatch } from '@myco-server-worker/db/runs/claim.js';
import { completeLearning } from '@myco-server-worker/core/learning-sessions.js';
import { prepareLearningSlice } from './helpers/extraction.js';
import { measuredStore } from './helpers/read-budget.js';
import { uuid } from './helpers/fixtures.js';

import { PROMPTS, ACKS, scope, runId, seedAcknowledgedHistory, seedCapturedHistory } from './helpers/extraction-coverage.js';

async function verify(db: RelationalStore, acks = ACKS) {
  expect(await db.prepare('SELECT COUNT(*) AS n FROM session_prompts').first()).toEqual({ n: PROMPTS });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM extraction_acks').first()).toEqual({ n: acks });
}

it('D1 acknowledges a prompt at the same cost after 700 and after 7k acknowledgements among 26k captured prompts', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
  try {
    const d1 = await mf.getD1Database('DB');
    await d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('coverage-budget','Coverage',1)").run();
    await ensureAgent(d1, { id: 'coverage', name: 'Coverage', provider: null, model: null, enabled: true }, 1);
    await recordDispatch(d1, scope, { id: runId, agentId: 'coverage', task: 'extract-curate', provider: null, model: null,
      runContext: null, dispatchedBy: null, startedAt: Date.now() });
    await seedCapturedHistory(d1, 0, PROMPTS, PROMPTS);
    const measured = measuredStore(d1);
    const costs: { reads: number; writes: number }[] = [];
    let seeded = 0;
    for (const [scale, acks] of [ACKS / 10, ACKS].entries()) {
      await seedAcknowledgedHistory(d1, acks, seeded);
      seeded = acks;
      // Each probe acknowledges a captured prompt beyond the acknowledged history.
      const probeRun = `${runId}-probe-${scale}`;
      const promptAt = PROMPTS - 10 + scale;
      await recordDispatch(d1, scope, { id: probeRun, agentId: 'coverage', task: 'extract-curate', provider: null, model: null,
        runContext: null, dispatchedBy: null, startedAt: Date.now() });
      const assignment = await prepareLearningSlice(d1, scope, probeRun, 'session', [{ promptId: uuid(promptAt), sessionId: 'session', createdAt: promptAt, endedAt: 1 }], 1);
      measured.reset();
      expect(await completeLearning(measured.db, scope.projectId, 'session', probeRun, assignment, '', 1)).toEqual({ completed: true, covered: 1 });
      costs.push({ reads: measured.reads(), writes: measured.writes() });
      await verify(d1, acks + scale + 1);
    }
    console.info('EXTRACTION_ACK_COST', { prompts: PROMPTS, acks: [ACKS / 10, ACKS], costs });
    expect(costs[1]!.reads).toBeLessThanOrEqual(costs[0]!.reads);
    expect(costs[1]!.writes).toBeLessThanOrEqual(costs[0]!.writes);
  } finally { await mf.dispose(); }
}, 484_000);
