import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { READ_BUDGET_SESSION_STATEMENTS } from '@myco-server-worker/db/read-budget-session-statements.js';
import { markPromptProcessed, newestUnprocessedSession, newestUnprocessedSessionQuery } from '@myco-server-worker/read/prompts.js';
import { hasUnprocessedPrompts } from '@myco-server-worker/core/schedule-rules.js';
import { listProjects, listProjectsSql } from '@myco-server-worker/read/sessions.js';
import { sqliteD1 } from './helpers/d1.js';

const session = (id: string, end: number | null, receipt = 1, project = 'proj_1') => `INSERT INTO sessions
  (project_id,session_id,created_by_token_id,first_received_at,last_received_at,ended_at)
  VALUES('${project}','${id}','t',1,${receipt},${end ?? 'NULL'})`;
const prompt = (id: string, owner: string, origin = 'user') => `INSERT INTO prompt_batches
  (project_id,prompt_id,session_id,event_id,origin,content_hash,created_at,updated_at,token_id,received_at)
  VALUES('proj_1','${id}','${owner}','event','${origin}','hash',1,1,'t',1)`;
const transcript = (id: string, owner: string, imported: number | null = null) => `INSERT INTO transcripts
  (project_id,transcript_id,session_id,machine_id,size,parsed_offset,first_received_at,last_received_at,token_id,imported_at)
  VALUES('proj_1','${id}','${owner}','m',10,10,1,1,'t',${imported ?? 'NULL'})`;

const sourceSelection = `SELECT s.session_id AS id,s.ended_at AS endedAt,
  EXISTS(SELECT 1 FROM transcripts t WHERE t.project_id=s.project_id AND t.session_id=s.session_id AND t.imported_at IS NULL) AS liveCapture
  FROM sessions s WHERE s.project_id=? AND s.ended_at IS NOT NULL
  AND EXISTS(SELECT 1 FROM prompt_batches p WHERE p.project_id=s.project_id AND p.session_id=s.session_id AND p.processed=0 AND p.origin IN ('user','unknown'))
  AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.project_id=s.project_id AND t.session_id=s.session_id)
  AND NOT EXISTS(SELECT 1 FROM transcripts t WHERE t.project_id=s.project_id AND t.session_id=s.session_id AND (t.parsed_offset<t.size OR t.parse_error IS NOT NULL))
  ORDER BY liveCapture DESC,s.ended_at DESC,s.session_id DESC LIMIT 1`;

async function assertProjection(db: RelationalStore) {
  const expected = await db.prepare(`WITH ids AS (
    SELECT project_id,session_id FROM sessions UNION SELECT project_id,session_id FROM prompt_batches
    UNION SELECT project_id,session_id FROM transcripts UNION SELECT project_id,session_id FROM session_tombstones)
    SELECT i.project_id,i.session_id,
    EXISTS(SELECT 1 FROM sessions s WHERE s.project_id=i.project_id AND s.session_id=i.session_id) AS has_session,
    EXISTS(SELECT 1 FROM session_tombstones t WHERE t.project_id=i.project_id AND t.session_id=i.session_id) AS tombstoned,
    (SELECT ended_at FROM sessions s WHERE s.project_id=i.project_id AND s.session_id=i.session_id) AS ended_at,
    (SELECT last_received_at FROM sessions s WHERE s.project_id=i.project_id AND s.session_id=i.session_id) AS last_received_at,
    (SELECT COUNT(*) FROM prompt_batches p WHERE p.project_id=i.project_id AND p.session_id=i.session_id AND p.processed=0 AND p.origin IN ('user','unknown')) AS eligible_prompts,
    (SELECT COUNT(*) FROM transcripts t WHERE t.project_id=i.project_id AND t.session_id=i.session_id AND (t.parsed_offset<t.size OR t.parse_error IS NOT NULL)) AS pending_transcripts,
    (SELECT COUNT(*) FROM transcripts t WHERE t.project_id=i.project_id AND t.session_id=i.session_id AND t.imported_at IS NULL) AS live_transcripts
    FROM ids i ORDER BY i.project_id,i.session_id`).all<Record<string, unknown>>();
  const actual = await db.prepare('SELECT * FROM session_read_facts ORDER BY project_id,session_id').all<Record<string, unknown>>();
  expect(actual.results.filter((r) => expected.results.some((e) => e.project_id === r.project_id && e.session_id === r.session_id))).toEqual(expected.results);
  for (const orphan of actual.results.filter((r) => !expected.results.some((e) => e.project_id === r.project_id && e.session_id === r.session_id))) {
    expect(orphan).toMatchObject({ has_session: 0, tombstoned: 0, ended_at: null, last_received_at: null, eligible_prompts: 0, pending_transcripts: 0, live_transcripts: 0 });
  }
  for (const projectId of ['proj_1', 'proj_2']) {
    const expectedSession = await db.prepare(sourceSelection).bind(projectId).first<{ id: string; endedAt: number; liveCapture: number }>();
    expect(await newestUnprocessedSession(db, { projectId })).toEqual(expectedSession);
    expect(await hasUnprocessedPrompts(db, projectId)).toBe(expectedSession !== null);
  }
  const expectedProjects = (await db.prepare(`SELECT p.project_id AS projectId,COUNT(s.session_id) AS sessionCount,MAX(s.last_received_at) AS lastActivityAt
    FROM projects p LEFT JOIN sessions s ON s.project_id=p.project_id
    AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.project_id=s.project_id AND t.session_id=s.session_id)
    GROUP BY p.project_id ORDER BY projectId`).all<{ projectId: string; sessionCount: number; lastActivityAt: number | null }>()).results;
  expect((await listProjects(db, { includeArchived: true })).map(({ projectId, sessionCount, lastActivityAt }) => ({ projectId, sessionCount, lastActivityAt }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId))).toEqual(expectedProjects);
}

async function verify(db: RelationalStore) {
  for (const step of SCHEMA_STEPS.filter((step) => step.version <= 82)) await db.batch(step.statements.map((sql) => db.prepare(sql)));
  const initial = [
    "INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','one',1),('proj_2','two',2)",
    session('old', 10, 100), session('new', 20, 200), session('tie', 20, 300), session('active', null, 400),
    prompt('old', 'old'), prompt('new', 'new', 'unknown'), prompt('tie', 'tie'), prompt('active', 'active'),
    prompt('orphan', 'orphan'), prompt('ignored', 'new', 'system'),
    transcript('old', 'old'), transcript('new', 'new', 1), transcript('tie', 'tie', 1),
    "INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES('proj_1','missing',1,'m')",
  ];
  for (const sql of initial) await db.prepare(sql).run();
  await db.batch(READ_BUDGET_SESSION_STATEMENTS.map((sql) => db.prepare(sql)));
  await assertProjection(db);
  expect(await newestUnprocessedSession(db, { projectId: 'proj_1' })).toEqual({ id: 'old', endedAt: 10, liveCapture: 1 });
  expect(await markPromptProcessed(db, { projectId: 'proj_1' }, 'old')).toBe(true);
  expect(await markPromptProcessed(db, { projectId: 'proj_1' }, 'absent')).toBe(false);
  await assertProjection(db);
  await db.prepare("UPDATE prompt_batches SET processed=0 WHERE prompt_id='old'").run();
  const mutations = [
    "UPDATE transcripts SET imported_at=1 WHERE transcript_id='old'",
    "UPDATE prompt_batches SET processed=1 WHERE prompt_id='tie'",
    "UPDATE transcripts SET parsed_offset=5 WHERE transcript_id='new'",
    "UPDATE transcripts SET parsed_offset=size,parse_error='bad' WHERE transcript_id='new'",
    "UPDATE transcripts SET parse_error=NULL,imported_at=NULL WHERE transcript_id='new'",
    transcript('second', 'new'),
    "UPDATE transcripts SET size=20 WHERE transcript_id='second'",
    "DELETE FROM transcripts WHERE transcript_id='second'",
    "UPDATE prompt_batches SET origin='hook_injected' WHERE prompt_id='new'",
    "UPDATE prompt_batches SET origin='user',processed=0 WHERE prompt_id='tie'",
    "UPDATE prompt_batches SET session_id='new',project_id='proj_2' WHERE prompt_id='tie'",
    session('new', 100, 600, 'proj_2'),
    "UPDATE transcripts SET project_id='proj_2',session_id='new' WHERE transcript_id='tie'",
    session('orphan', 50, 500),
    "INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES('proj_1','orphan',1,'m')",
    "UPDATE sessions SET last_received_at=900,ended_at=NULL WHERE session_id='orphan'",
    "UPDATE session_tombstones SET session_id='new',project_id='proj_2' WHERE session_id='orphan'",
    "DELETE FROM session_tombstones WHERE project_id='proj_2'",
    "UPDATE sessions SET project_id='proj_2',session_id='moved',ended_at=90 WHERE session_id='orphan'",
    "DELETE FROM sessions WHERE session_id='new' AND project_id='proj_2'",
    "DELETE FROM prompt_batches WHERE project_id='proj_2'",
    "DELETE FROM transcripts WHERE project_id='proj_2'",
    "DELETE FROM sessions WHERE session_id='old'",
    session('old', 100, 800),
    "UPDATE sessions SET ended_at=200,last_received_at=1000 WHERE session_id='active'",
    "UPDATE projects SET archived_at=1,archived_by='m' WHERE project_id='proj_1'",
    "DELETE FROM prompt_batches", "DELETE FROM transcripts", "DELETE FROM sessions", "DELETE FROM session_tombstones",
  ];
  for (const sql of mutations) { await db.prepare(sql).run(); await assertProjection(db); }
  expect(await newestUnprocessedSession(db, { projectId: 'proj_1' })).toBeNull();
  expect(await listProjects(db)).toHaveLength(1);
  await expect(db.batch([db.prepare(session('rollback', 1)), db.prepare('INSERT INTO absent_table VALUES(1)')])).rejects.toThrow();
  await assertProjection(db);
  const select = newestUnprocessedSessionQuery({ projectId: 'proj_1' });
  const extractionPlan = (await db.prepare(`EXPLAIN QUERY PLAN ${select.sql}`).bind(...select.binds).all<{ detail: string }>()).results.map((r) => r.detail).join('\n');
  expect(extractionPlan).toContain('idx_session_read_extraction');
  expect(extractionPlan).not.toContain('TEMP B-TREE');
  const projectsPlan = (await db.prepare(`EXPLAIN QUERY PLAN ${listProjectsSql()}`).all<{ detail: string }>()).results.map((r) => r.detail).join('\n');
  expect(projectsPlan).toContain('idx_session_read_activity');
  expect(projectsPlan).not.toMatch(/SCAN [fs]\b/);
}

test('native 82→83 backfill and every session eligibility/count mutation preserve source parity', async () => {
  const sqlite = new Database(':memory:');
  try { await verify(sqliteD1(sqlite)); } finally { sqlite.close(); }
});

test('local D1 82→83 backfill and every session eligibility/count mutation preserve source parity', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
  try { await verify(await mf.getD1Database('DB')); } finally { await mf.dispose(); }
}, 30_000);
