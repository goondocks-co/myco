/**
 * The Today reads (plans across Projects, capture recency, a viewer's machines, Needs you) and an actor's task entries
 * cost the same on D1 when a Deployment holds ten times the history; and every
 * across-Projects read answers on both stores when it names the most Projects a read may.
 */
import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { MAX_NAMED_PROJECTS, type ProjectSet } from '@myco-server-worker/read/scope.js';
import { sessions_listSessionsAcross as listSessionsAcross } from '@myco-server-worker/read/catalog/sessions.js';
import { listSporePageAcross } from '@myco-server-worker/core/spores.js';
import { encodeProjectCursor } from '@myco-server-worker/read/project-cursor.js';
import { plans_pagePlansAcross as pagePlansAcross, plans_planTotals as planTotals } from '@myco-server-worker/read/catalog/plans.js';
import { capabilityHolds, failingOutcomes, readWork, runsAwaitingWorker } from '@myco-server-worker/read/work.js';
import { captureRecency, ownMachineNames } from '@myco-server-worker/read/capture.js';
import { renameMachine } from '@myco-server-worker/auth/enrollment.js';
import { grantsExpiringBy } from '@myco-server-worker/auth/grants.js';
import {
  deploymentLastTaskEntryAt, deploymentTaskCeilingWindow, deploymentTaskEntriesSince, deploymentTaskRunTally, recordQueued,
} from '@myco-server-worker/db/runs/claim.js';
import { createProject } from '@myco-server-worker/db/storage/projects.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { d1TwoScale, eachUnit, expectTwoScale, type CostCase } from './helpers/two-scale.js';

const NOW = 1_790_000_000_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

async function setup(db: RelationalStore) {
  for (const project of ['proj_0', 'proj_1', 'proj_2']) await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
  await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
  for (let m = 0; m < 3; m++) await db.prepare('INSERT INTO members(id,label,created_at) VALUES(?,?,1)').bind(`mem_${m}`, `member ${m}`).run();
  for (let m = 0; m < 6; m++) {
    await db.prepare('INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES(?,?,1)').bind(`m_${m}`, `mem_${m % 3}`).run();
    await db.prepare(`INSERT INTO member_credentials(id,member_id,token_hash,machine_id,runtime_label,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES(?,?,?,?,?,1,?,?,1)`).bind(`mt_${m}`, `mem_${m % 3}`, `hash_${m}`, `m_${m}`, `host ${m}`, NOW + DAY, `mt_${m}`).run();
  }
  // Each machine's capture head is a session received in the last minutes.
  for (let m = 0; m < 6; m++) {
    await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent)
      VALUES('proj_0',?,?,?,?,?,'codex')`).bind(`head-${m}`, `m_${m}`, `mt_${m}`, NOW - m * MINUTE, NOW - m * MINUTE).run();
  }
  // Within the last day: two entries by the actor, one failed outcome, one held run and one queued for a worker.
  await db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,queued_at,dispatch_spec,origin,held_by) VALUES
    ('proj_0','recent-1','agent','extract-curate','completed',?1,?1,?1,'{"actor":"mem_1"}','manual',NULL),
    ('proj_0','recent-2','agent','extract-curate','running',?2,NULL,?2,'{"actor":"mem_1"}','manual',NULL),
    ('proj_1','recent-failure','agent','canopy-map','failed',?2,?2,?2,'{"actor":"clock"}','automatic',NULL),
    ('proj_1','recent-held','agent','canopy-map','queued',NULL,NULL,?2,'{"actor":"clock"}','automatic','repository-checkout'),
    ('proj_2','recent-waiting','agent','extract-curate','queued',NULL,NULL,?2,'{"actor":"clock"}','automatic',NULL)`).bind(NOW - 2 * MINUTE, NOW - MINUTE).run();
  await db.prepare(`INSERT INTO external_grants(id,project_id,key_hash,label,created_by,created_at,expires_at) VALUES('grant-due','proj_0','hash','due','mem_0',1,?)`)
    .bind(NOW + DAY / 2).run();
}

/**
 * Each unit is history older than the last day: a session, an edited plan, a finished run of an actor (some failed
 * before they started, as queue expiry fails them) and a grant that ends later; and another member with a machine, a
 * rotated-away credential of one of the fixed machines, and an expired one of the member's own.
 */
async function grow(db: RelationalStore, from: number, to: number) {
  await eachUnit(db, from, to, `INSERT INTO members(id,label,created_at) SELECT 'member-'||i,'member '||i,1 FROM n`);
  await eachUnit(db, from, to, `INSERT INTO machine_claims(machine_id,member_id,claimed_at,label) SELECT 'machine-'||i,'member-'||i,1,'host '||i FROM n`);
  await eachUnit(db, from, to, `INSERT INTO member_credentials(id,member_id,token_hash,machine_id,runtime_label,issued_at,expires_at,revoked_at,lineage_root,lineage_started_at)
    SELECT 'rotated-'||i,'mem_'||(i%6%3),'rotated-hash-'||i,'m_'||(i%6),'host '||(i%6),0,?3,2,'mt_'||(i%6),1 FROM n`, NOW + DAY);
  await eachUnit(db, from, to, `INSERT INTO member_credentials(id,member_id,token_hash,machine_id,runtime_label,issued_at,expires_at,lineage_root,lineage_started_at)
    SELECT 'expired-'||i,'member-'||i,'expired-hash-'||i,'machine-'||i,'host '||i,1,2,'expired-'||i,1 FROM n`);
  await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,ended_at)
    SELECT 'proj_'||(i%3),'s-'||i,'m_'||(i%6),'mt_'||(i%6),?3-?4-i*?5,?3-?4-i*?5,'claude-code',?3-?4-i*?5+1 FROM n`, NOW, DAY, MINUTE);
  await eachUnit(db, from, to, `INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,content_hash,status,created_at,updated_at,token_id,received_at)
    SELECT 'proj_'||(i%3),printf('plan-%06d',i),'s-'||i,'e-'||i,'m_0','h',CASE i%4 WHEN 0 THEN 'active' WHEN 1 THEN 'completed' WHEN 2 THEN 'abandoned' ELSE 'in_progress' END,
      1,?3-i*?4,'mt_0',1 FROM n`, NOW, MINUTE);
  await eachUnit(db, from, to, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,queued_at,dispatch_spec,origin)
    SELECT 'proj_'||(i%3),'run-'||i,'agent',CASE i%3 WHEN 0 THEN 'extract-curate' WHEN 1 THEN 'canopy-map' ELSE 'embedding-reconcile' END,
      CASE WHEN i%7=0 THEN 'failed' ELSE 'completed' END,CASE WHEN i%14=0 THEN NULL ELSE ?3-?4-i*?5 END,?3-?4-i*?5+1,?3-?4-i*?5,
      json_object('actor',CASE i%3 WHEN 2 THEN 'clock' ELSE 'mem_'||(i%3) END),'automatic' FROM n`, NOW, 2 * DAY, MINUTE);
  await eachUnit(db, from, to, `INSERT INTO external_grants(id,project_id,key_hash,label,created_by,created_at,expires_at,revoked_at)
    SELECT 'grant-'||i,'proj_'||(i%3),'hash-'||i,'grant '||i,'mem_0',1,?3+30*?4+i,CASE WHEN i%5=0 THEN 2 END FROM n`, NOW, DAY);
}

/** Sizes of the history, in units. */
const SIZES = [600, 6_000] as const;

it('Today reads and an actor\'s task entries cost D1 the same as the Deployment\'s history grows', async () => {
  const costs = await d1TwoScale({
    sizes: SIZES,
    setup,
    grow,
    cases: [
      { name: 'capture recency', run: async (db) => expect((await captureRecency(db, NOW, 'mem_1')).length).toBeGreaterThan(0) },
      { name: 'machine rename', run: async (db, { scale }) => expect(await renameMachine(db, { memberId: 'mem_1' }, 'm_1', `renamed ${scale}`)).toBe(true) },
      { name: 'own machine names', run: async (db) => expect((await ownMachineNames(db, 'mem_1', NOW)).size).toBe(2) },
      { name: 'failing outcomes', run: async (db) => expect(await failingOutcomes(db, ['extract-curate', 'canopy-map'], NOW - DAY))
        .toEqual([expect.objectContaining({ projectId: 'proj_1', task: 'canopy-map' })]) },
      { name: 'capability holds', run: async (db) => expect(await capabilityHolds(db, ['repository-checkout'], NOW))
        .toEqual([expect.objectContaining({ capability: 'repository-checkout', runs: 1 })]) },
      { name: 'runs awaiting a worker', run: async (db) => expect((await runsAwaitingWorker(db, ['embedding-reconcile'])).runs).toBeGreaterThan(0) },
      { name: 'grants expiring', run: async (db) => expect((await grantsExpiringBy(db, NOW, NOW + DAY)).map((grant) => grant.id)).toEqual(['grant-due']) },
      { name: 'actor task entries', run: async (db) => {
        const since = NOW - DAY;
        expect(await deploymentTaskEntriesSince(db, 'extract-curate', since, 'mem_1')).toBe(2);
        await deploymentTaskCeilingWindow(db, 'extract-curate', since, 'mem_1', 50);
        expect(await deploymentLastTaskEntryAt(db, 'extract-curate', 'mem_1')).toBe(NOW - MINUTE);
        await deploymentTaskRunTally(db, 'extract-curate', since, 'mem_1');
      } },
      {
        name: 'queued entry under its actor ceiling',
        // Each size's queued entry is one more in the window the next size's ceiling reads.
        extra: 1,
        run: async (db, { scale, store }) => {
          expect(await recordQueued(db, { projectId: 'proj_0' }, { id: `queued-${scale}`, agentId: 'agent', task: 'extract-curate',
            provider: null, model: null, heldBy: 'worker', queuedAt: NOW, dispatchSpec: '{"actor":"mem_2"}' },
          { ceiling: { actor: 'mem_2', task: 'extract-curate', perDay: 50, sinceMs: NOW - DAY } })).toBe(true);
          // The queue the other reads count stays as it was.
          await store.prepare("UPDATE agent_runs SET status='completed',completed_at=?2 WHERE project_id='proj_0' AND id=?1").bind(`queued-${scale}`, NOW).run();
        },
      },
    ],
    warm: true,
  });
  expectTwoScale(costs);
}, 180_000);

it('answers every across-Projects read naming the most Projects a read may and every filter it takes, on both stores', async () => {
  const most: ProjectSet = { all: false, projectIds: Array.from({ length: MAX_NAMED_PROJECTS }, (_, i) => `proj_${i}`) };
  await withDocumentStores(async (db, target) => {
    for (const projectId of most.projectIds) await createProject(db, projectId, projectId, 1);
    await db.prepare("INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('a', 'a', 'built-in', 1, 0)").run();
    await db.prepare(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) VALUES ('proj_63', 'sp_last', 'a', 't', 's', 'x', 10)`).run();
    const cursor = encodeProjectCursor({ createdAt: 1, projectId: 'proj_0', id: 'k' });
    const reads = await Promise.all([
      listSessionsAcross(db, most, { limit: 50, cursor: 'p2:1:proj_0:k', since: 1, until: 2, branch: 'b', agent: 'a', memberLabel: 'm', sessionId: 's', state: 'open', fidelity: 'full' }),
      listSessionsAcross(db, most, { limit: 50, cursor: 'p2:1:proj_0:k', since: 1, until: 2, window: 'activity', branch: 'b', agent: 'a', memberLabel: 'm', sessionId: 's', state: 'open', fidelity: 'full' }),
      listSporePageAcross(db, most, { observationType: 't', status: 's', sessionId: 's', createdFrom: 1, createdTo: 2, limit: 50, cursor }),
      listSporePageAcross(db, most, { observationType: 't', status: 's', createdFrom: 0, createdTo: DAY, limit: 50 }),
      pagePlansAcross(db, most, { status: 'active', since: 1, limit: 50, cursor: 'plans1:1789000000000:proj_0:k' }),
      planTotals(db, most),
      readWork(db, most, 0, DAY, undefined, 1),
    ]);
    const spores = reads[3] as Awaited<ReturnType<typeof listSporePageAcross>>;
    expect({ target, ids: spores?.rows.map((row) => row.id), total: spores?.total, facets: spores?.facets?.project })
      .toEqual({ target, ids: ['sp_last'], total: 1, facets: { proj_63: 1 } });
    expect({ target, plans: reads[5] }).toEqual({ target, plans: { state: 'ready', value: {} } });
  });
});
