/**
 * The run list, a run's detail, what a run read and the spores a run wrote cost the same on D1 when a Deployment holds
 * ten times the run history, and so does the produced rule a page of runs of every task reads. A full page of runs is one D1 request, so its ids
 * travel within the store's bind limit.
 */
import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { getRunDetail, listRuns } from '@myco-server-worker/read/runs.js';
import { runReads } from '@myco-server-worker/db/runs/reads.js';
import { listSporePage } from '@myco-server-worker/core/spores.js';
import { MAX_PAGE } from '@myco-server-worker/read/scope.js';
import { RETAINED_TASKS } from '@myco-server-worker/core/task-catalogue.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';

const NOW = 1_790_000_000_000;
const MINUTE = 60_000;
const SCOPE = { projectId: 'proj_0' };
/** Runs newer than every unit of history: a full page and more. */
const RECENT = MAX_PAGE + 50;

async function setup(db: RelationalStore) {
  for (const project of ['proj_0', 'proj_1']) {
    await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
    await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES(?,'recent','m','t',1,1)`).bind(project).run();
  }
  await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
  await db.prepare("INSERT INTO members(id,label,created_at) VALUES('mem_1','member',1)").run();
  // The page's runs: each wrote a spore every other run, and read the session every third.
  await eachUnit(db, 0, RECENT, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,queued_at,dispatch_spec)
    SELECT 'proj_0','recent-'||i,'agent','extract-curate','completed',?3-i*?4,?3-i*?4+1,?3-i*?4,'{"actor":"mem_1"}' FROM n`, NOW, MINUTE);
  await eachUnit(db, 0, RECENT, `INSERT INTO spores(project_id,id,agent_id,session_id,observation_type,content,author,created_at)
    SELECT 'proj_0','recent-spore-'||i,'agent','recent','gotcha','x','recent-'||i,?3-i*?4 FROM n WHERE i%2=0`, NOW, MINUTE);
  await eachUnit(db, 0, RECENT, `INSERT INTO run_reads(project_id,run_id,session_id,token_id,received_at)
    SELECT 'proj_0','recent-'||i,'recent','t',?3 FROM n WHERE i%3=0`, NOW);
}

/** Each unit is an older run in one of two Projects, with a session it read and a spore it wrote. */
async function grow(db: RelationalStore, from: number, to: number) {
  await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
    SELECT 'proj_'||(i%2),'old-'||i,'m','t',1,1 FROM n`);
  await eachUnit(db, from, to, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,queued_at,dispatch_spec)
    SELECT 'proj_'||(i%2),'old-'||i,'agent','extract-curate','completed',?3-(i+1)*?4,?3-(i+1)*?4+1,?3-(i+1)*?4,'{"actor":"mem_1"}' FROM n`, NOW - RECENT * MINUTE, MINUTE);
  await eachUnit(db, from, to, `INSERT INTO run_reads(project_id,run_id,session_id,token_id,received_at)
    SELECT 'proj_'||(i%2),'old-'||i,'old-'||i,'t',1 FROM n`);
  await eachUnit(db, from, to, `INSERT INTO spores(project_id,id,agent_id,session_id,observation_type,content,author,created_at)
    SELECT 'proj_'||(i%2),'old-spore-'||i,'agent','old-'||i,'gotcha','x','old-'||i,1 FROM n`);
}

it('a page of runs, a run\'s detail, its reads and its spores cost D1 the same as run history grows', async () => {
  expectTwoScale(await d1TwoScale({
    sizes: [500, 5_000],
    setup,
    grow,
    cases: [
      { name: 'full page of runs', run: async (db) => {
        const page = await listRuns(db, SCOPE, NOW, 'mem_1', { limit: MAX_PAGE });
        expect(page.rows).toHaveLength(MAX_PAGE);
        expect({ wrote: page.rows.some((row) => row.outcome.spores > 0), read: page.rows.some((row) => row.outcome.readsRecorded) }).toEqual({ wrote: true, read: true });
      } },
      { name: 'run detail', run: async (db) => expect(await getRunDetail(db, SCOPE, 'recent-0', NOW, 'mem_1')).not.toBeNull() },
      { name: 'run reads', run: (db) => runReads(db, SCOPE, 'recent-0') },
      { name: 'spores a run wrote', run: async (db) => expect((await listSporePage(db, SCOPE, { author: 'recent-0', limit: 50 }))?.rows).toHaveLength(1) },
    ],
  }));
}, 180_000);

/** Every retained task, so a page of runs carries every arm of the produced rule. */
const TASKS = JSON.stringify(RETAINED_TASKS);
/**
 * Runs of every retained task in `proj_2` for units [from, to), named under `prefix`, each with the evidence its task's
 * produced rule reads: half record output, half nothing. History takes a prefix that sorts apart from the page's, so
 * every seek for a page run lands among page keys at either size.
 */
async function produceRuns(db: RelationalStore, prefix: string, from: number, to: number) {
  const run = `'${prefix}-'||i`;
  await eachUnit(db, from, to, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,queued_at)
    SELECT 'proj_2',${run},'agent',json_extract(?3,'$['||CAST(i%?5 AS INTEGER)||']'),'completed',?4-i*?6,?4-i*?6+1,?4-i*?6 FROM n`, TASKS, NOW, RETAINED_TASKS.length, MINUTE);
  await eachUnit(db, from, to, `INSERT INTO agent_run_events(project_id,run_id,event_type,tool_name,outcome,payload,recorded_at)
    SELECT 'proj_2',${run},'run_write',value,'written',json_object('op','write','written',i%2),1 FROM n CROSS JOIN json_each('["myco_run_cards","myco_run_sessions","myco_run_map"]')
    WHERE value='myco_run_cards' OR i%2=1`);
  await eachUnit(db, from, to, `INSERT INTO agent_reports(project_id,run_id,agent_id,action,summary,details,created_at)
    SELECT 'proj_2',${run},'agent','embedding','Reported.',json_object('processed',i%2),1 FROM n`);
  await eachUnit(db, from, to, `INSERT INTO spores(project_id,id,agent_id,session_id,observation_type,status,content,author,created_at)
    SELECT 'proj_2',${run}||'-spore','agent','recent','gotcha','obsolete','x',CASE WHEN i%2=1 THEN ${run} END,1 FROM n`);
  await eachUnit(db, from, to, `INSERT INTO resolution_events(project_id,id,agent_id,spore_id,action,created_at,author)
    SELECT 'proj_2',${run}||'-retire','agent',${run}||'-spore','obsolete',1,CASE WHEN i%2=1 THEN ${run} END FROM n`);
}

it('a page of runs of every task reads what each produced at the same D1 cost as history grows', async () => {
  const PAGE_RUNS = MAX_PAGE + RETAINED_TASKS.length;
  expectTwoScale(await d1TwoScale({
    sizes: [500, 5_000],
    setup: async (db) => {
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_2','proj_2',1)").run();
      await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_2','recent','m','t',1,1)`).run();
      await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
      await produceRuns(db, 'page', 0, PAGE_RUNS);
    },
    grow: (db, from, to) => produceRuns(db, 'history', PAGE_RUNS + from, PAGE_RUNS + to),
    cases: [{ name: 'full page of runs of every task', run: async (db) => {
      const page = await listRuns(db, { projectId: 'proj_2' }, NOW, 'mem_1', { limit: MAX_PAGE });
      expect(page.rows).toHaveLength(MAX_PAGE);
      expect(new Set(page.rows.map((row) => `${row.task} ${row.result}`)).size).toBe(RETAINED_TASKS.length * 2);
    } }],
  }));
}, 180_000);
