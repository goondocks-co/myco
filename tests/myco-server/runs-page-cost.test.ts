/**
 * The Runs page costs D1 the same when a Deployment holds ten times the run history: the count a finishing run adds to
 * its hour (measured first, in place of the small size's run, so every later read sees the same runs at both sizes), its
 * hourly counts over a day, a week or one Project, and the due work no machine took. Its pages of finished runs cost the
 * same when the window holds ten times the runs: whole, or narrowed to a runner, a cause, no runner or one Project, a
 * narrowed page reads only the runs that match its first filter, and a page narrowed twice inspects a bounded number of
 * them however many other runs share its first filter. Each runner's check-ins and the runs that waited, which a quiet
 * spell is read from, cost the same when a Deployment holds ten times their history outside the window, and so does
 * a runner's contact counting its check-in. One Project's waiting work costs the same however many other Projects'
 * queues hold work.
 */
import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { readFinishedRuns, readRunHours, runWindow, FINISHED_RUNS_PAGE } from '@myco-server-worker/read/run-hours.js';
import { failStaleRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { unclaimedDue } from '@myco-server-worker/db/runs/unclaimed.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';
import { readPulledWaiting } from '@myco-server-worker/read/pulled-waiting.js';
import { completeBudgetMigration } from '@myco-server-worker/db/meta/budget-activation.js';
import { NOW_PROJECTS_MAX } from '@myco-server-worker/db/runs/now.js';
import { readWorkNow } from '@myco-server-worker/read/work-now.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { memoryBlobStore, recordingLimiter } from './helpers/fixtures.js';
import { runnerContactWrite } from '@myco-server-worker/core/worker-contacts.js';
import { commit } from '@myco-server-worker/db/index.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const TASKS = JSON.stringify(['embedding-reconcile', 'title-summary', 'canopy-map', 'extract-curate']);
const CODES = JSON.stringify([null, null, 'machine_unresponsive', 'lease_lapsed']);
/** Runs that finished inside the page's widest read: the last two weeks. */
const RECENT = 400;

it('pulled work costs D1 the same as unrelated live runs, its ready backlog and terminal history grow', async () => {
  const page = Array.from({ length: NOW_PROJECTS_MAX }, (_, i) => `proj_visible_${i}`);
  const work = async (db: RelationalStore, project: string) => {
    await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
    await db.prepare("INSERT INTO learning_sessions(project_id,session_id,init_state,counted,source_activity_at,pending_cards,next_model_due_at,quiet_at,card_promoted_at,eligible_at,learning_promoted_at) VALUES(?1,'waiting','ready',1,?2,1,?3,?3,?3,?3,?3)")
      .bind(project, NOW - 2 * HOUR, NOW - HOUR).run();
    await db.prepare("UPDATE learning_sessions SET next_model_due_at=?2,card_promoted_at=?2 WHERE project_id=?1").bind(project, NOW - HOUR).run();
    await db.prepare("INSERT INTO project_capabilities VALUES(?1,'spore_curation',1,1,'owner')").bind(project).run();
    await db.prepare("INSERT INTO spore_curation_work(project_id,cluster_key,members,due_at) VALUES(?1,'group','[]',?2)").bind(project, NOW - HOUR).run();
  };
  expectTwoScale(await d1TwoScale({
    sizes: [500, 5_000],
    setup: async db => {
      await completeBudgetMigration(db, NOW);
      await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('load-agent','load','built-in',1,1)").run();
      await db.prepare("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner'),('agent.learning_history_enabled','true',1,'owner')").run();
      for (const project of page) await work(db, project);
    },
    grow: async (db, from, to) => {
      await eachUnit(db, from, to, "INSERT INTO projects(project_id,name,created_at) SELECT 'proj_unrelated_'||i,'other',1 FROM n");
      await eachUnit(db, from, to, `INSERT INTO learning_sessions(project_id,session_id,init_state,counted,source_activity_at,pending_cards,next_model_due_at,quiet_at,card_promoted_at,eligible_at,learning_promoted_at)
        SELECT 'proj_unrelated_'||i,'waiting','ready',1,?3,1,?4,?4,?4,?4,?4 FROM n`, NOW - 2 * HOUR, NOW - HOUR);
      await eachUnit(db, from, to, "UPDATE learning_sessions SET next_model_due_at=?3,card_promoted_at=?3 WHERE project_id IN (SELECT 'proj_unrelated_'||i FROM n)", NOW - HOUR);
      await eachUnit(db, from, to, "INSERT INTO project_capabilities SELECT 'proj_unrelated_'||i,'spore_curation',1,1,'owner' FROM n");
      await eachUnit(db, from, to, "INSERT INTO spore_curation_work(project_id,cluster_key,members,due_at) SELECT 'proj_unrelated_'||i,'group','[]',?3 FROM n", NOW - HOUR);
      await eachUnit(db, from, to, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin,queued_at,started_at)
        SELECT 'proj_unrelated_'||i,'busy-'||i,'load-agent','title-summary',CASE WHEN i%2=0 THEN 'queued' ELSE 'running' END,'manual',?3,CASE WHEN i%2=1 THEN ?3 END FROM n`, NOW - HOUR);
      await eachUnit(db, from, to, `INSERT INTO learning_sessions(project_id,session_id,init_state,counted,source_activity_at,pending_cards,next_model_due_at,quiet_at,card_promoted_at,eligible_at,learning_promoted_at)
        SELECT ?3,'own-'||i,'ready',1,?4,1,?5,?5,?5,?5,?5 FROM n`, page[0], NOW - 2 * HOUR, NOW - 45 * 60_000);
      await eachUnit(db, from, to, "UPDATE learning_sessions SET next_model_due_at=?4,card_promoted_at=?4 WHERE project_id=?3 AND session_id IN (SELECT 'own-'||i FROM n)", page[0], NOW - 45 * 60_000);
      await eachUnit(db, from, to, "INSERT INTO spore_curation_work(project_id,cluster_key,members,due_at) SELECT ?3,'own-'||i,'[]',?4 FROM n", page[0], NOW - 45 * 60_000);
      await eachUnit(db, from, to, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin,queued_at,started_at,completed_at)
        SELECT ?3,'ended-'||i,'load-agent','title-summary',CASE WHEN i%2=0 THEN 'completed' ELSE 'failed' END,'manual',?4-i-1000,?4-i-500,?4-i FROM n`, page[0], NOW - DAY);
    },
    cases: [
      { name: 'one Project with all pulled stages on', run: async db => {
        const env = serverEnvFromBindings({ MYCO_DB: db, BUCKET: memoryBlobStore(), SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() } as never);
        const answer = await readWorkNow(env, { projectId: page[0]! }, NOW, true);
        expect(answer.unavailable).toEqual([]);
        const rows = answer.needsYou.filter(row => row.key.startsWith('pulled:'));
        expect(rows).toHaveLength(3);
        expect(rows.every(row => row.projectId === page[0])).toBe(true);
      } },
      { name: 'the bounded all-Projects page with all pulled stages on', run: async db => {
        const env = serverEnvFromBindings({ MYCO_DB: db, BUCKET: memoryBlobStore(), SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() } as never);
        const rows = await readPulledWaiting(env, { projects: page, now: NOW, cutoff: NOW - HOUR / 2 });
        expect(new Set(rows.map(row => row.projectId))).toEqual(new Set(page));
      } },
    ],
  }));
}, 240_000);

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

/** Every hour of the last week for each of three runners, and runs that waited an hour, taken in each of those hours. */
async function recentContacts(db: RelationalStore) {
  await setup(db);
  for (const i of [0, 1, 2]) {
    await eachUnit(db, 0, 7 * 24, `INSERT INTO runner_contact_hour(hour,runner_id,contacts,first_seen_at,last_seen_at)
      SELECT ?3-i*${HOUR},'rn_${i}',4,?3-i*${HOUR},?3-i*${HOUR}+1000 FROM n`, NOW - (NOW % HOUR));
  }
  await eachUnit(db, 0, 7 * 24, `INSERT INTO run_wait_hour(left_hour,entered_hour,project_id,taken,waits) SELECT ?3-i*${HOUR},?3-(i+1)*${HOUR},'proj_'||(i%2),i%2,2 FROM n`, NOW - (NOW % HOUR));
  await commit(db, runnerContactWrite(db, { runnerId: 'rn_0', now: NOW }));
}

/** Each unit is an hour, eight days to a month back, outside every read's window: another runner's check-in and runs that waited then. */
async function olderContacts(db: RelationalStore, from: number, to: number) {
  await eachUnit(db, from, to, `INSERT INTO runner_contact_hour(hour,runner_id,contacts,first_seen_at,last_seen_at)
    SELECT ?3-(i%500)*${HOUR},'rn_old_'||(i/500),1,?3-(i%500)*${HOUR},?3-(i%500)*${HOUR} FROM n`, NOW - (NOW % HOUR) - 8 * DAY);
  await eachUnit(db, from, to, `INSERT INTO run_wait_hour(left_hour,entered_hour,project_id,taken,waits)
    SELECT ?3-(i%500)*${HOUR},?3-(i%500)*${HOUR}-(i/500+1)*${HOUR},'proj_'||(i%2),1,1 FROM n`, NOW - (NOW % HOUR) - 8 * DAY);
}

it('check-ins and waits on the Runs page, and a contact counting its check-in, cost D1 the same as their history grows', async () => {
  expectTwoScale(await d1TwoScale({
    sizes: [500, 5_000],
    setup: recentContacts,
    grow: olderContacts,
    cases: [
      { name: 'a contact counts its check-in in its hour', run: async (db, at) => {
        await commit(db, runnerContactWrite(db, { runnerId: 'rn_0', now: NOW + (at.scale + 2) * 60_000 }));
      } },
      { name: 'a day of runner lanes with their check-ins and waits', run: async (db) => {
        const day = await readRunHours(db, ALL, 'day', NOW);
        expect(day.lanes.filter((lane) => lane.checkins.length > 0)).toHaveLength(3);
        expect(day.waits.length).toBeGreaterThan(0);
      } },
      { name: 'a week of runner lanes with their check-ins and waits', run: async (db) => {
        const week = await readRunHours(db, ALL, 'week', NOW);
        expect(week.lanes.every((lane) => lane.runnerId === null || lane.checkins.length > 0)).toBe(true);
        expect(week.recordedSince).not.toBeNull();
      } },
      { name: 'one Project’s waits', run: async (db) => expect((await readRunHours(db, { all: false, projectIds: ['proj_1'] }, 'week', NOW)).waits.length).toBeGreaterThan(0) },
    ],
  }));
}, 240_000);

/** Each unit is another Project whose queue holds work, beside the one Project the page reads. */
async function unrelatedQueues(db: RelationalStore, from: number, to: number) {
  await eachUnit(db, from, to, "INSERT INTO projects(project_id,name,created_at) SELECT 'proj_queue_'||i,'other',1 FROM n");
  await eachUnit(db, from, to, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,held_by)
    SELECT 'proj_queue_'||i,'waiting-'||i,'agent','embedding-reconcile','queued',?3,'worker' FROM n`, NOW - 2 * HOUR);
}

it('one Project’s waiting work on the Runs page costs D1 the same as other Projects’ queues fill', async () => {
  expectTwoScale(await d1TwoScale({
    sizes: [500, 5_000],
    setup: recentContacts,
    grow: unrelatedQueues,
    cases: [
      { name: 'one Project’s still-waiting work and waits', run: async (db) => {
        const week = await readRunHours(db, { all: false, projectIds: ['proj_1'] }, 'week', NOW);
        expect(week.stillWaiting.length).toBeGreaterThan(0);
        expect(week.waits.length).toBeGreaterThan(0);
      } },
    ],
  }));
}, 240_000);
