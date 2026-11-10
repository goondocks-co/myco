/** Failing outcomes on Needs you: the failures of a task since the lookback that its last success did not recover from. */
import { expect, it } from 'bun:test';
import { failingOutcomes } from '@myco-server-worker/read/work.js';
import { EXTRACTION_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { schemaSqlite } from './helpers/schema-template.js';

const P = 'proj_1';
const LOOKBACK = 1_000_000;

it('count the failures since the lookback after the last success, including one that never started, and name the latest', async () => {
  const sqlite = schemaSqlite();
  try {
    sqlite.run("INSERT INTO projects(project_id,name,created_at) VALUES(?1,'p',1)", [P]);
    sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco','Myco','built-in',1,1)");
    const run = sqlite.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at,completed_at) VALUES(?1,?2,'myco',?3,?4,?5,?6,?7)`);
    for (const [id, status, queued, started, completed] of [
      ['before-lookback', 'failed', 10, 20, 30],
      ['recovered', 'failed', LOOKBACK + 50, LOOKBACK + 100, LOOKBACK + 101],
      ['success', 'completed', LOOKBACK + 150, LOOKBACK + 200, LOOKBACK + 300],
      ['started', 'failed', LOOKBACK + 400, LOOKBACK + 500, LOOKBACK + 600],
      ['never-started', 'failed', LOOKBACK + 700, null, LOOKBACK + 800],
    ] as const) run.run(P, id, EXTRACTION_TASK, status, queued, started, completed);
    expect(await failingOutcomes(sqliteRelationalStore(sqlite), [EXTRACTION_TASK], LOOKBACK)).toEqual([{ projectId: P, task: EXTRACTION_TASK,
      kind: expect.any(String), failures: 2, since: LOOKBACK + 500, latestAt: LOOKBACK + 700, latestRunId: 'never-started' }]);
  } finally { sqlite.close(); }
});
