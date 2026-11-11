/**
 * The Runs page costs D1 the same when a Deployment holds ten times the run history: the count a finishing run adds to
 * its hour (measured first, in place of the small size's run, so every later read sees the same runs at both sizes), its
 * hourly counts over a day, a week or one Project, and the due work no machine took. Its pages of finished runs cost the
 * same when the window holds ten times the runs: whole, or narrowed to a runner, a cause, no runner or one Project, a
 * narrowed page reads only the runs that match its first filter, and a page narrowed twice inspects a bounded number of
 * them however many other runs share its first filter.
 */
import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { readFinishedRuns, readRunHours, runWindow, FINISHED_RUNS_PAGE } from '@myco-server-worker/read/run-hours.js';
import { failStaleRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { unclaimedDue } from '@myco-server-worker/db/runs/unclaimed.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const TASKS = JSON.stringify(['embedding-reconcile', 'title-summary', 'canopy-map', 'extract-curate']);
const CODES = JSON.stringify([null, null, 'machine_unresponsive', 'lease_lapsed']);
/** Runs that finished inside the page's widest read: the last two weeks. */
const RECENT = 400;

/** Finished runs `[from, to)` ending `step` apart back from `end`, across two Projects, three runners, four tasks and both ends. */
const finished = (db: RelationalStore, prefix: string, from: number, to: number, end: number, step: number) => eachUnit(db, from, to, `INSERT INTO agent_runs
    (project_id,id,agent_id,task,status,harness,error_code,queued_at,started_at,completed_at,leased_runner_id,leased_runner_credential_id)
  SELECT 'proj_'||(i%2),'${prefix}-'||i,'agent',json_extract(?3,'$['||(i%4)||']'),CASE WHEN i%4>=2 THEN 'failed' ELSE 'completed' END,
    CASE WHEN i%3=0 THEN 'codex' ELSE 'claude-code' END,json_extract(?4,'$['||(i%4)||']'),?5-i*?6-60000,?5-i*?6,?5-i*?6+1000,'rn_'||(i%3),'rc_'||(i%3) FROM n`,
  TASKS, CODES, end, step);

async function setup(db: RelationalStore) {
  for (const project of ['proj_0', 'proj_1']) await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
  await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
  for (const i of [0, 1, 2]) {
    await db.prepare('INSERT INTO runners(id,name,created_at) VALUES(?,?,1)').bind(`rn_${i}`, `runner ${i}`).run();
    await db.prepare("INSERT INTO runner_credentials(id,runner_id,token_hash,epoch,issued_at,expires_at,lineage_root) VALUES(?,?,?,1,1,?,?)").bind(`rc_${i}`, `rn_${i}`, `hash_${i}`, NOW + DAY, `rc_${i}`).run();
  }
  await finished(db, 'recent', 0, RECENT, NOW, (14 * DAY) / RECENT);
  await eachUnit(db, 0, 20, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,held_by) SELECT 'proj_'||(i%2),'due-'||i,'agent','embedding-reconcile','queued',?3-i*60000,'worker' FROM n`, NOW - HOUR);
}

/** Each unit is an older run, finished three to four weeks back, outside every read's window, or due work queued beside it. */
async function grow(db: RelationalStore, from: number, to: number) {
  await finished(db, 'old', from, to, NOW - 15 * DAY, (15 * DAY) / 5_000);
  await eachUnit(db, from, to, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,held_by)
    SELECT 'proj_'||(i%2),'queued-'||i,'agent','embedding-reconcile','queued',?3-i,'worker' FROM n WHERE i%10=0`, NOW - 2 * DAY);
}

const ALL = { all: true } as const;
it('the Runs page reads and a finishing run cost D1 the same as run history grows', async () => {
  expectTwoScale(await d1TwoScale({
    sizes: [500, 5_000],
    setup,
    grow,
    cases: [
      { name: 'a run finishing adds to its hour', run: async (db, at) => {
        await at.store.prepare("DELETE FROM agent_runs WHERE project_id='proj_0' AND id='live-0'").run();
        await at.store.prepare("INSERT INTO agent_runs(project_id,id,agent_id,task,status,harness,queued_at,started_at,leased_runner_id,leased_runner_credential_id) VALUES('proj_0',?,'agent','canopy-map','running','codex',?,?,'rn_0','rc_0')")
          .bind(`live-${at.scale}`, NOW - 2_000, NOW - 1_000).run();
        at.restart();
        expect(await failStaleRun(db, { projectId: 'proj_0' }, `live-${at.scale}`, NOW, 'stopped', 'machine_unresponsive')).toBe(true);
      } },
      { name: 'a day of hourly counts', run: async (db) => expect((await readRunHours(db, ALL, 'day', NOW)).lanes.length).toBe(3) },
      { name: 'a week of hourly counts', run: async (db) => expect((await readRunHours(db, ALL, 'week', NOW)).failures.cause.length).toBe(2) },
      { name: 'one Project’s hourly counts', run: async (db) => expect((await readRunHours(db, { all: false, projectIds: ['proj_1'] }, 'week', NOW)).totals.failed).toBeGreaterThan(0) },
      { name: 'due work no machine took', run: async (db) => expect(await unclaimedDue(db, ['proj_0', 'proj_1'], NOW - HOUR / 2)).toHaveLength(2) },
    ],
  }));
}, 240_000);

/** Runs `[from, to)` that finished in the last six days in `proj_0` on `rn_0` or `rn_2`: none matches a narrowed page below. */
const others = (db: RelationalStore, from: number, to: number) => eachUnit(db, from, to, `INSERT INTO agent_runs
    (project_id,id,agent_id,task,status,harness,error_code,queued_at,started_at,completed_at,leased_runner_id,leased_runner_credential_id)
  SELECT 'proj_0','other-'||i,'agent','title-summary',CASE WHEN i%2=0 THEN 'failed' ELSE 'completed' END,'claude-code',CASE WHEN i%2=0 THEN 'lease_lapsed' END,
    ?3-i*?4-60000,?3-i*?4,?3-i*?4+1000,'rn_'||(2*(i%2)),'rc_'||(2*(i%2)) FROM n`, NOW - HOUR, (6 * DAY) / 5_000);

it('a page of finished runs, whole or narrowed, costs D1 the same as the window fills with other runs', async () => {
  const week = runWindow('week', NOW);
  const page = (filters: object, set: Parameters<typeof readFinishedRuns>[1] = ALL) => (db: RelationalStore) => readFinishedRuns(db, set, { ...week, filters, limit: FINISHED_RUNS_PAGE });
  expectTwoScale(await d1TwoScale({
    sizes: [500, 5_000],
    setup: async (db) => {
      await setup(db);
      await eachUnit(db, 0, 5, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,error_code,queued_at,started_at,completed_at)
        SELECT 'proj_1','nobody-'||i,'agent','canopy-map','failed','run_cancelled',?3-i*?4-1000,?3-i*?4,?3-i*?4+1 FROM n`, NOW - 2 * HOUR, HOUR);
    },
    grow: others,
    cases: [
      { name: 'a whole page', run: async (db) => expect((await page({})(db)).rows).toHaveLength(FINISHED_RUNS_PAGE) },
      { name: 'one runner’s failed runs', run: async (db) => expect((await page({ runnerId: 'rn_1', outcome: 'failed' })(db)).rows.length).toBeGreaterThan(0) },
      { name: 'a cause no run recorded', run: async (db) => expect((await page({ errorCode: 'agent_crashed' })(db)).rows).toEqual([]) },
      { name: 'a cause many runs recorded, on one runner', run: async (db) => expect((await page({ errorCode: 'lease_lapsed', runnerId: 'rn_1' })(db)).cursor).not.toBeNull() },
      { name: 'runs that recorded no runner', run: async (db) => expect((await page({ runnerId: '' })(db)).rows).toHaveLength(5) },
      { name: 'one Project’s runs', run: async (db) => expect((await page({}, { all: false, projectIds: ['proj_1'] })(db)).rows.length).toBeGreaterThan(0) },
    ],
  }));
}, 240_000);
