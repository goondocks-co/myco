/**
 * Failing outcomes on Needs you: the answer over a task's run history, and the rows the read costs as that history grows.
 */
import { describe, expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { failingOutcomes } from '@myco-server-worker/read/work.js';
import { EXTRACTION_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { measuredStore } from './helpers/read-budget.js';
import { schemaD1Root } from './helpers/schema-template.js';

const P = 'proj_1';
const LOOKBACK = 1_000_000;

/** A D1 store holding `history` failed runs from before the lookback, and the window's runs around one success. */
async function store<T>(history: number, analyzed: boolean, use: (d1: Awaited<ReturnType<Miniflare['getD1Database']>>) => Promise<T>): Promise<T> {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response(null)}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
  try {
    const d1 = await mf.getD1Database('DB');
    const run = `INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at,completed_at) VALUES(?1,?2,'myco',?3,?4,?5,?6,?7)`;
    await d1.batch([
      d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES(?1,'p',1)").bind(P),
      d1.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco','Myco','built-in',1,1)"),
      d1.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at,completed_at)
        SELECT ?1,'old_'||value,'myco',?2,'failed',value,value,value+1 FROM json_each(?3)`).bind(P, EXTRACTION_TASK, JSON.stringify(Array.from({ length: history }, (_, n) => n + 1))),
      d1.prepare(run).bind(P, 'recovered', EXTRACTION_TASK, 'failed', LOOKBACK + 50, LOOKBACK + 100, LOOKBACK + 101),
      d1.prepare(run).bind(P, 'success', EXTRACTION_TASK, 'completed', LOOKBACK + 150, LOOKBACK + 200, LOOKBACK + 300),
      d1.prepare(run).bind(P, 'started', EXTRACTION_TASK, 'failed', LOOKBACK + 400, LOOKBACK + 500, LOOKBACK + 600),
      d1.prepare(run).bind(P, 'unstarted', EXTRACTION_TASK, 'failed', LOOKBACK + 700, null, LOOKBACK + 800),
    ]);
    if (analyzed) await d1.prepare('ANALYZE').run();
    return await use(d1);
  } finally { await mf.dispose(); }
}

describe('failing outcomes', () => {
  it('count the failures since the lookback after the last success, including one that never started, and name the latest', async () => {
    const answer = await store(20, false, (d1) => failingOutcomes(d1, [EXTRACTION_TASK], LOOKBACK));
    expect(answer).toEqual([{ projectId: P, task: EXTRACTION_TASK, kind: expect.any(String), failures: 2, since: LOOKBACK + 500,
      latestAt: LOOKBACK + 700, latestRunId: 'unstarted' }]);
  }, 120_000);

  for (const analyzed of [false, true]) {
    it(`read the same rows at a 600- and a 6,000-run failure history ${analyzed ? 'with' : 'without'} planner statistics`, async () => {
      const reads = (history: number) => store(history, analyzed, async (d1) => {
        const measured = measuredStore(d1);
        measured.reset();
        await failingOutcomes(measured.db, [EXTRACTION_TASK], LOOKBACK);
        return measured.reads();
      });
      expect(await reads(6_000)).toBe(await reads(600));
    }, 240_000);
  }
});
