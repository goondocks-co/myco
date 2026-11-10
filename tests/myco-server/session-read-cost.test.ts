/**
 * The session reads a person waits on, and the turn writes a working session makes, cost the same on D1 when a
 * Deployment holds ten times the sessions; and a session's plans page in order.
 */
import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { endTurnStatement, startTurnStatement } from '@myco-server-worker/ingest/turns.js';
import {
  sessions_listSessions as listSessions,
  sessions_listSessionsAcross as listSessionsAcross,
} from '@myco-server-worker/read/catalog/sessions.js';
import { listSessionArtifacts } from '@myco-server-worker/read/session-artifacts.js';
import { plans_pageSessionPlans as listPlans } from '@myco-server-worker/read/catalog/plans.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { schemaSqlite } from './helpers/schema-template.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';

const NOW = 1_790_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Sessions open with a turn running now, beside the history. */
const WORKING = 5;

async function setup(db: RelationalStore) {
  for (const project of ['proj_0', 'proj_1']) await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
  await eachUnit(db, 0, WORKING, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,started_at,working_since)
    SELECT 'proj_0','working-'||i,'m_0','mt_0',?3,?3,'codex',?3,?3 FROM n`, NOW - MINUTE);
  await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,started_at,ended_at)
    VALUES('proj_0','reported','m_0','mt_0',1,1,1,2)`).run();
}

/** Each unit is one ended session, older than every unit before it, in one of two Projects, an event it stored, and one artifact it reported. */
async function grow(db: RelationalStore, from: number, to: number) {
  await eachUnit(db, from, to, `INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,ingest_nonce)
    SELECT 'proj_'||(i%2),'event-'||i,'s-'||i,'mt_0','notification','cli','{}','hash',1,1,'nonce-'||i FROM n`);
  await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,branch,started_at,ended_at,title)
    SELECT 'proj_'||(i%2),'s-'||i,'m_'||(i%4),'mt_'||(i%8),?3-(i+1)*?4,?3-(i+1)*?4,'claude-code','main',?3-(i+1)*?4,?3-(i+1)*?4+1,'title '||i FROM n`, NOW, MINUTE);
  await eachUnit(db, from, to, `INSERT INTO session_artifacts(project_id,id,session_id,kind,artifact_id,url,author,reported_at)
    SELECT 'proj_0','artifact-'||i,CASE WHEN i%2=0 THEN 'reported' ELSE 's-'||i END,'pr','pr-'||i,'https://example.test/pr/'||i,'mem_1',i FROM n`);
}

const window = { window: 'activity' as const, since: NOW - 15 * MINUTE, now: NOW, state: 'open' as const, fidelity: 'any' as const };

it('pages, windows and turns a session at the same D1 cost as the Deployment\'s sessions grow', async () => {
  const costs = await d1TwoScale({
    sizes: [300, 3_000],
    setup,
    grow,
    cases: [
      { name: 'session page', run: async (db) => expect((await listSessions(db, { projectId: 'proj_0' }, { limit: 50, fidelity: 'any' })).rows).toHaveLength(50) },
      { name: 'session page past a cursor', run: async (db, { store, restart }) => {
        const first = await listSessions(store, { projectId: 'proj_0' }, { limit: 50, fidelity: 'any' });
        restart();
        const next = await listSessions(db, { projectId: 'proj_0' }, { limit: 50, cursor: first.cursor!, fidelity: 'any' });
        expect(next.rows).toHaveLength(50);
        expect(next.rows.some((row) => first.rows.some((seen) => seen.sessionId === row.sessionId))).toBe(false);
      } },
      { name: 'reported artifacts page', run: async (db, { store, restart }) => {
        const first = await listSessionArtifacts(store, { projectId: 'proj_0' }, 'reported', { limit: 2 });
        restart();
        await listSessionArtifacts(db, { projectId: 'proj_0' }, 'reported', { limit: 2 });
        const next = await listSessionArtifacts(db, { projectId: 'proj_0' }, 'reported', { limit: 2, cursor: first!.cursor! });
        expect(next!.rows).toHaveLength(2);
      } },
      { name: 'sessions working now', run: async (db) => {
        const open = await listSessions(db, { projectId: 'proj_0' }, window);
        expect(open.rows.filter((row) => row.sessionId.startsWith('working-'))).toHaveLength(WORKING);
        await listSessionsAcross(db, { all: true }, window);
      } },
      { name: 'turn start and end', run: async (db, { scale, store, restart }) => {
        // A session received a day ago, outside the working window, and the turn-end event this request stored.
        const session = `turning-${scale}`;
        await store.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,started_at)
          VALUES('proj_0',?1,'m_0','mt_0',?2,?2,'codex',?2)`).bind(session, NOW - DAY).run();
        await store.prepare(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,ingest_nonce)
          VALUES('proj_0',?1,?2,'mt_0','turn','cli','{}','hash',?3,?3,?4)`).bind(`end-${scale}`, session, NOW, `nonce-end-${scale}`).run();
        restart();
        await startTurnStatement(db, { projectId: 'proj_0', sessionId: session, machineId: 'm_0', at: NOW }).run();
        await endTurnStatement(db, { projectId: 'proj_0', sessionId: session, eventId: `end-${scale}`, endedAt: NOW + 1, nonce: `nonce-end-${scale}` }).run();
        expect(await store.prepare('SELECT working_since, last_turn_end_at FROM sessions WHERE project_id = ? AND session_id = ?').bind('proj_0', session).first())
          .toEqual({ working_since: null, last_turn_end_at: NOW + 1 });
      } },
    ],
    // Every case runs once first, so both sizes measure requests that are not the first of their kind.
    warm: true,
  });
  expectTwoScale(costs);
  for (const turn of costs.filter((cost) => cost.name === 'turn start and end')) {
    expect(Math.min(...turn.writes), 'the turn opened and closed').toBeGreaterThan(0);
  }
}, 180_000);

it('pages a session\'s plans narrowed by status through every match once, oldest edit first, and none from elsewhere', async () => {
  const sqlite = schemaSqlite();
  try {
    sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'p', 1), ('proj_2', 'q', 1)`);
    for (const [project, session] of [['proj_1', 's1'], ['proj_1', 's2'], ['proj_2', 's1']]) {
      sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES (?, ?, 'm', 't', 1, 1)`, [project, session]);
    }
    const plan = (project: string, session: string, key: string, status: string, at: number) => sqlite.run(`INSERT INTO plans
      (project_id, plan_key, session_id, event_id, machine_id, content_hash, status, title, content, created_at, updated_at, token_id, received_at)
      VALUES (?, ?, ?, ?, 'm', 'h', ?, ?, '- [ ] a', ?, ?, 't', ?)`, [project, key, session, `e_${project}_${key}`, status, key, at, at, at]);
    // Pairs of plans share an edit instant, so the key breaks the tie across page boundaries.
    for (let i = 0; i < 90; i += 1) plan('proj_1', 's1', `k${String(i).padStart(3, '0')}`, ['active', 'completed', 'in_progress'][i % 3]!, 1_000 + Math.floor(i / 2));
    plan('proj_1', 's2', 'k_elsewhere', 'active', 5_000);
    plan('proj_2', 's1', 'k_other_project', 'active', 5_000);
    const db = sqliteRelationalStore(sqlite);
    const expected = (sqlite.query(`SELECT plan_key FROM plans WHERE project_id = 'proj_1' AND session_id = 's1' AND status = 'active' ORDER BY updated_at, plan_key`).all() as { plan_key: string }[]).map((r) => r.plan_key);
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const listed = await listPlans(db, { projectId: 'proj_1' }, 's1', { limit: 7, status: 'active', ...(cursor === undefined ? {} : { cursor }) });
      walked.push(...listed.rows.map((row) => row.planKey));
      if (listed.cursor === null) break;
      cursor = listed.cursor;
    }
    expect({ n: walked.length, walked }).toEqual({ n: 30, walked: expected });
  } finally {
    sqlite.close();
  }
});
