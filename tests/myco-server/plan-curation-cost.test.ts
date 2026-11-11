import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { buildPlanCurationInput, hasStalePlans, PLAN_CURATION_PLANS, PLAN_CURATION_STALE_MS } from '@myco-server-worker/core/plan-curation.js';
import { writePlanDecision } from '@myco-server-worker/db/plans/resolution.js';
import { d1TwoScale, eachUnit, expectTwoScale, type CostCase } from './helpers/two-scale.js';

/**
 * Plan curation's candidate page, its evidence and its decision write cost D1 the same however many plans the
 * Deployment holds: each unit of history adds, to the curated Project, a stale live plan, a past plan, a plan curation
 * reviewed recently, and a session reporting an outcome, and a stale live plan to another Project.
 */
const SIZES = [400, 2_000] as const;
const NOW = 1_800_000_000_000;
const STALE = NOW - PLAN_CURATION_STALE_MS - 86_400_000;
const PLAN = `INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,created_at,updated_at,token_id,received_at)`;

async function setup(db: RelationalStore): Promise<void> {
  await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_a','A',1),('proj_b','B',1)").run();
  await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,launch_parent_session_id)
    VALUES('proj_a','target','machine','credential',?1,?1,NULL),('proj_a','target-child','machine','credential',?1,?1,'target')`).bind(STALE).run();
  await db.prepare(`INSERT INTO session_artifacts(project_id,id,session_id,kind,artifact_id,url,author,reported_at)
    VALUES('proj_a','artifact-target','target-child','pr','2180','https://example.test/pull/2180','member',?1)`).bind(STALE).run();
  // The longest-untouched plans, one decided at each size and one in the warm-up, then enough to fill a page.
  for (const key of ['decided-w', 'decided-0', 'decided-1', 'target-a', 'target-b', 'target-c', 'target-d', 'target-e', 'target-f']) {
    await db.prepare(`${PLAN} VALUES('proj_a',?1,'target',?1,'machine',?1,'- [x] done','h','active',?2,?2,'credential',?2)`).bind(key, STALE - 100_000).run();
  }
}

async function grow(db: RelationalStore, from: number, to: number): Promise<void> {
  await eachUnit(db, from, to, `${PLAN} SELECT 'proj_a','stale-'||i,'history-'||i,'e-'||i,'machine','Stale '||i,'- [ ] one','h',
    CASE i%2 WHEN 0 THEN 'active' ELSE 'in_progress' END,?3-i,?3-i,'credential',?3 FROM n`, STALE);
  await eachUnit(db, from, to, `${PLAN} SELECT 'proj_a','past-'||i,'history-'||i,'p-'||i,'machine','Past '||i,'- [x] one','h','completed',?3-i,?3-i,'credential',?3 FROM n`, STALE - 200_000);
  await eachUnit(db, from, to, `${PLAN} SELECT 'proj_a','reviewed-'||i,'history-'||i,'r-'||i,'machine','Reviewed '||i,'- [ ] one','h','active',?3-i,?3-i,'credential',?3 FROM n`, STALE - 200_000);
  await eachUnit(db, from, to, `UPDATE plans SET reviewed_at=?3 WHERE project_id='proj_a' AND plan_key IN (SELECT 'reviewed-'||i FROM n)`, NOW);
  await eachUnit(db, from, to, `${PLAN} SELECT 'proj_b','stale-'||i,'other-'||i,'o-'||i,'machine','Other '||i,'- [ ] one','h','active',?3-i,?3-i,'credential',?3 FROM n`, STALE - 300_000);
  await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
    SELECT 'proj_a','history-'||i,'machine','credential',?3,?3 FROM n`, STALE);
  await eachUnit(db, from, to, `INSERT INTO session_artifacts(project_id,id,session_id,kind,artifact_id,url,author,reported_at)
    SELECT 'proj_a','artifact-'||i,'history-'||i,'pr','h'||i,'https://example.test/pull/h'||i,'member',?3 FROM n`, STALE);
}

const CASES: CostCase[] = [
  { name: 'the candidate page and its evidence', run: async (db) => {
    const input = await buildPlanCurationInput({ db }, 'proj_a', NOW);
    expect(input?.counts.plans).toBe(PLAN_CURATION_PLANS);
    expect(input?.instruction).toContain('"pr:2180"');
  } },
  { name: 'the schedule precondition', run: async (db) => { expect(await hasStalePlans(db, 'proj_a', NOW)).toBe(true); } },
  { name: 'a decision', run: async (db, { scale }) => {
    expect(await writePlanDecision(db, { projectId: 'proj_a', planKey: `decided-${scale === -1 ? 'w' : scale}`, revision: STALE - 100_000, runId: 'run',
      now: NOW, note: 'Landed #2180.', status: 'completed', supersededBy: null, evidence: '["pr:2180"]' })).toBe(true);
  } },
];

it('plan curation reads and writes D1 the same as the Deployment\'s plans grow', async () => {
  expectTwoScale(await d1TwoScale({ sizes: SIZES, setup, grow, cases: CASES, warm: true }));
}, 300_000);
