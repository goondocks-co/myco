import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { changePlanStatus, savePlan } from '@myco-server-worker/core/plans.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import {
  plans_pagePlansAcross as pagePlansAcross,
  plans_pageProjectPlans as pageProjectPlans,
  plans_pageSessionPlans as pageSessionPlans,
} from '@myco-server-worker/read/catalog/plans.js';
import { activity_activityFeed as activityFeed } from '@myco-server-worker/read/catalog/activity.js';
import { memoryBlobStore, recordingLimiter } from './helpers/fixtures.js';
import { d1TwoScale, eachUnit, expectTwoScale, type CostCase } from './helpers/two-scale.js';

/**
 * Plan lists, the activity feed and the plan writer cost D1 the same however much history the Deployment holds: each
 * unit of history adds an older plan to each of two Projects, and an older session, run and active spore to one of them.
 */
const SIZES = [400, 2_000] as const;
const NOW = 1_800_000_000_000;
const A = { projectId: 'proj_a' };
/** The Project plans are written into, so a write at one size does not move what another case reads at the next. */
const WRITTEN = { projectId: 'proj_w' };
const PAGE = 20;
const MEMBER = { machineId: 'machine', tokenId: 'credential' };

async function setup(db: RelationalStore): Promise<void> {
  await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_a','A',1),('proj_b','B',1),('proj_w','W',1)").run();
  await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','Agent','built-in',1,1)").run();
  await db.prepare("INSERT INTO members(id,label,created_at) VALUES('member','member',1)").run();
  await db.prepare("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','member',1)").run();
  await db.prepare(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
    VALUES('credential','member','machine','hash',1,99999999999999,'credential',1)`).run();
  // The session a member writes plans into, and a session with three plans newer than any history.
  await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
    VALUES('proj_w','writer','machine','credential',?1,?1),('proj_a','target','machine','credential',?1,?1)`).bind(NOW).run();
  for (const n of [1, 2, 3]) {
    await db.prepare(`INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,created_at,updated_at,token_id,received_at)
      VALUES('proj_a',?1,'target',?1,'machine','Target','- [x] a','h','active',?2,?2,'credential',?2)`).bind(`target-${n}`, NOW + n).run();
  }
}

async function grow(db: RelationalStore, from: number, to: number): Promise<void> {
  for (const project of ['proj_a', 'proj_b']) {
    await eachUnit(db, from, to, `INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,created_at,updated_at,token_id,received_at)
      SELECT ?3,'plan-'||i,'history-'||i,'e-'||i,'machine','History '||i,'- [x] one'||char(10)||'- [ ] two','h',
        CASE i%4 WHEN 0 THEN 'abandoned' WHEN 1 THEN 'completed' WHEN 2 THEN 'in_progress' ELSE 'active' END,?4-i,?4-i,'credential',?4 FROM n`, project, NOW - 1_000);
  }
  await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
    SELECT 'proj_a','history-'||i,'machine','credential',?3-i,?3-i FROM n`, NOW - 1_000);
  await eachUnit(db, from, to, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,started_at,completed_at)
    SELECT 'proj_a','run-'||i,'agent','extract-curate','completed',?3-i,?3-i,?3-i FROM n`, NOW - 1_000);
  await eachUnit(db, from, to, `INSERT INTO spores(project_id,id,agent_id,observation_type,status,content,created_at)
    SELECT 'proj_a','spore-'||i,'agent','gotcha','active','history '||i,?3-i FROM n`, NOW - 1_000);
}

/** Reads a first page, then the page its cursor continues to, each holding rows. */
async function twoPages<T>(read: (cursor: string | undefined) => Promise<{ rows: readonly T[]; cursor: string | null } | null>): Promise<void> {
  const first = (await read(undefined))!;
  expect(first.rows.length).toBeGreaterThan(0);
  expect(first.cursor).not.toBeNull();
  expect((await read(first.cursor!))!.rows.length).toBeGreaterThan(0);
}

const CASES: CostCase[] = [
  { name: 'plan pages in one Project, with and without a status', run: async (db) => {
    for (const status of [undefined, 'abandoned']) {
      await twoPages(cursor => pageProjectPlans(db, A, { limit: PAGE, ...(status === undefined ? {} : { status }), ...(cursor === undefined ? {} : { cursor }) }));
    }
  } },
  { name: "a session's plans", run: async (db) => {
    await twoPages(cursor => pageSessionPlans(db, A, 'target', { limit: 2, ...(cursor === undefined ? {} : { cursor }) }));
  } },
  { name: 'plan pages across Projects: every Project, named Projects, one named Project, with and without a status', run: async (db) => {
    for (const set of [{ all: true } as const, { all: false, projectIds: ['proj_a', 'proj_b'] } as const, { all: false, projectIds: ['proj_b'] } as const]) {
      for (const status of [undefined, 'abandoned']) {
        await twoPages(cursor => pagePlansAcross(db, set, { limit: PAGE, ...(status === undefined ? {} : { status }), ...(cursor === undefined ? {} : { cursor }) }));
      }
    }
  } },
  { name: 'activity feed, first page', run: async (db) => {
    const feed = (await activityFeed(db, A, { limit: PAGE }))!;
    expect({ items: feed.items.length, building: feed.building }).toEqual({ items: PAGE, building: false });
  } },
  { name: 'activity feed, a later page', run: async (db, { store }) => {
    const first = (await activityFeed(store, A, { limit: PAGE }))!;
    const later = (await activityFeed(db, A, { limit: PAGE, cursor: first.nextCursor! }))!;
    expect(later.items.length).toBe(PAGE);
  } },
  // The capture path reads two rows more at the large size once statistics are analyzed, with or without the plan list
  // and feed triggers, and still two at 25 times the history: a bounded seek, not a walk.
  { name: 'plan writer: a capture save and a status edit', extra: 2, run: async (db, { scale }) => {
    const env = serverEnvFromBindings({ MYCO_DB: db, BUCKET: memoryBlobStore(), SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() });
    const saved = await savePlan(env, MEMBER, WRITTEN, { sessionId: 'writer', planKey: `written-${scale}`, title: 'Written', content: '- [x] done\n- [ ] next' }, NOW + 100);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.row.progress).toBe('1/2');
    expect(await changePlanStatus(env, WRITTEN, saved.row.planKey, 'completed', 'member', NOW + 200)).toMatchObject({ status: 'completed' });
  } },
];

it('plan lists, the activity feed and the plan writer cost D1 the same as the Deployment\'s history grows, under any planner statistics', async () => {
  expectTwoScale(await d1TwoScale({ sizes: SIZES, setup, grow, cases: CASES, statistics: ['none', 'analyzed', 'stale'], warm: true }));
}, 300_000);
