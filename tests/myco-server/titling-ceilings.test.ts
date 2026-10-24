import { expect, it } from 'bun:test';
import { extractionSqlEnv as sqliteEnv } from './helpers/extraction-sql.js';
import { ensureAgent, recordQueued } from '@myco-server-worker/core/runs.js';
import { HARNESS_AGENT_ID } from '@myco-server-worker/core/harness.js';
import { CLOCK_ACTOR, runScheduledTasks } from '@myco-server-worker/core/scheduled-tasks.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

it('carries each Project rolling-day ceiling into the atomic queue write', async () => {
  const f = sqliteEnv();
  try {
    await ensureAgent(f.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: null, model: null, enabled: true }, NOW);
    for (const projectId of ['proj_1', 'proj_2']) {
      const results = await Promise.all(['a', 'b', 'c'].map((id) => recordQueued(f.db, { projectId }, {
        id, agentId: HARNESS_AGENT_ID, task: 'title-summary', provider: null, model: null, heldBy: 'worker', queuedAt: NOW,
        dispatchSpec: JSON.stringify({ actor: CLOCK_ACTOR }),
      }, { ceiling: { actor: CLOCK_ACTOR, task: 'title-summary', perDay: 2, sinceMs: NOW - DAY, projectId } })));
      expect(results.filter(Boolean)).toHaveLength(2);
    }
  } finally { f.sqlite.close(); }
});

it('keeps extraction paused over repeated wakes', async () => {
  const f=sqliteEnv();
  try {
    await settingsWriter(f.db).setLeaf('agent.scheduled_tasks_enabled',true,'test',NOW);
    for (const at of [NOW,NOW+DAY,NOW+2*DAY]) {
      expect((await runScheduledTasks(f.serverEnv,'idle',at,'https://example.test')).dispatched).toBe(0);
    }
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_runs WHERE task='extract-curate'").get()).toEqual({n:0});
  } finally { f.sqlite.close(); }
});
