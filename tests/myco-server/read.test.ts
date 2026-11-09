import { legacyBlob } from './helpers/d1.js';
import { describe, it, expect } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';

import { Database } from 'bun:sqlite';
import { SCHEMA_DDL, SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { clampLimit, decodeCursor, encodeCursor, page, DEFAULT_PAGE, MAX_PAGE } from '@myco-server-worker/read/scope.js';

import { archiveProject, renameProject } from '@myco-server-worker/db/storage/s2a3.js';
import {
  sessions_getSession as getSession,
  sessions_listProjects as listProjects,
  sessions_listSessions as listSessions,
  sessions_projectStats as projectStats,
  sessions_sessionDurationMs as sessionDurationMs,
  sessions_SESSION_OCCURRED_AT as SESSION_OCCURRED_AT,
} from '@myco-server-worker/read/catalog/sessions.js';
import { unarchiveProject } from '@myco-server-worker/db/storage/projects.js';
import {
  activity_activityFeed as activityFeed,
} from '@myco-server-worker/read/catalog/activity.js';

function seedSessions(sqlite: import('bun:sqlite').Database) {
  sqlite.run(`INSERT OR REPLACE INTO projects (project_id, name, created_at) VALUES ('proj_1','One',1), ('proj_2','Two',2)`);
  sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
              VALUES ('proj_1','s1','m1','tok_1',1,10), ('proj_1','s2','m1','tok_2',2,30), ('proj_1','s3','m2','tok_1',3,20),
                     ('proj_2','other','m9','tok_9',5,99)`);
  sqlite.run(`UPDATE sessions SET agent = 'claude-code', branch = 'main', started_at = first_received_at, origin_path = '/repo' WHERE project_id = 'proj_1'`);
}

describe('read/sessions', () => {
  it('lists a project\'s sessions newest first, carrying machine and minting token', async () => {
    const { db, sqlite } = sqliteEnv();
    seedSessions(sqlite);
    const { rows, cursor } = await listSessions(db, { projectId: 'proj_1' });
    expect(rows.map((r) => r.sessionId)).toEqual(['s3', 's2', 's1']);
    expect(rows[0]).toEqual({
      sessionId: 's3', machineId: 'm2', createdByTokenId: 'tok_1', firstReceivedAt: 3, lastReceivedAt: 20,
      agent: 'claude-code', branch: 'main', startedAt: 3, endedAt: null, originPath: '/repo', parentSessionId: null, parentReason: null, launchParentSessionId: null,
      memberId: null, memberLabel: null, runtimeLabel: null, runtimeKind: null, workingSince: null, working: false,
      title: null, summary: null, titledAt: null, endedBy: null, endedByLabel: null, label: 'claude-code',
    });
    expect(cursor).toBeNull();
  });

  it('distinguishes recorded endpoints from synthetic transcript bounds for session durations', async () => {
    const { db, sqlite } = sqliteEnv();
    seedSessions(sqlite);
    sqlite.run("UPDATE sessions SET agent='cursor', started_at=1, ended_at=10, occurred_started_at=1, occurred_ended_at=10 WHERE session_id='s1'");
    expect(await sessionDurationMs(db, { projectId: 'proj_1' }, 's1')).toBeNull();
    expect(await sessionDurationMs(db, { projectId: 'proj_2' }, 's1')).toBeNull();
    sqlite.run("UPDATE sessions SET occurred_started_at=NULL, occurred_ended_at=NULL WHERE session_id='s1'");
    expect(await sessionDurationMs(db, { projectId: 'proj_1' }, 's1')).toBe(9);
    sqlite.run("UPDATE sessions SET occurred_started_at=1, occurred_ended_at=10, agent='claude-code' WHERE session_id='s1'");
    expect(await sessionDurationMs(db, { projectId: 'proj_1' }, 's1')).toBe(9);
    sqlite.run("UPDATE sessions SET agent='cursor', started_at=NULL, ended_at=NULL, occurred_started_at=NULL, occurred_ended_at=NULL WHERE session_id='s1'");
    expect(await sessionDurationMs(db, { projectId: 'proj_1' }, 's1')).toBeNull();
    sqlite.run("UPDATE sessions SET agent='claude-code' WHERE session_id='s1'");
    expect(await sessionDurationMs(db, { projectId: 'proj_1' }, 's1')).toBeNull();
  });

  it('renames a project, archived or not, and says so when none carries the id', async () => {
    const { db, sqlite } = sqliteEnv();
    seedSessions(sqlite);
    expect(await renameProject(db, 'proj_1', 'Myco')).toBe('renamed');
    expect(await archiveProject(db, 'proj_2', 'mem_a', 5)).toBe('archived');
    expect(await renameProject(db, 'proj_2', 'Archived one')).toBe('renamed');
    expect(await renameProject(db, 'proj_9', 'Nobody')).toBe('absent');
    expect((await listProjects(db, { includeArchived: true })).map((p) => [p.projectId, p.name]).sort()).toEqual([['proj_1', 'Myco'], ['proj_2', 'Archived one']]);
  });

  it('names the member and runtime kind behind each session, never its machine, lists a session whose credential is gone, and keeps the order', async () => {
    const { db, sqlite } = sqliteEnv();
    seedSessions(sqlite);
    sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at) VALUES ('mem_a', 'chris', 1)`);
    sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, runtime_label, runtime_kind, issued_at, expires_at, lineage_root, lineage_started_at)
                VALUES ('tok_1', 'mem_a', 'h', 'm1', 'laptop', 'host', 1, 99, 'tok_1', 1)`);
    const { rows } = await listSessions(db, { projectId: 'proj_1' });
    // A read names no machine: a facade names the viewer's own (`nameOwnMachines`).
    expect(rows.map((r) => [r.sessionId, r.memberLabel, r.runtimeLabel, r.runtimeKind])).toEqual([
      ['s3', 'chris', null, 'host'], ['s2', null, null, null], ['s1', 'chris', null, 'host'],
    ]);
    expect((await getSession(db, { projectId: 'proj_1' }, 's2'))?.memberId).toBeNull();
  });

  it('pages with a cursor and never repeats or drops a row', async () => {
    const { db, sqlite } = sqliteEnv();
    seedSessions(sqlite);
    const first = await listSessions(db, { projectId: 'proj_1' }, { limit: 2 });
    expect(first.rows.map((r) => r.sessionId)).toEqual(['s3', 's2']);
    expect(first.cursor).not.toBeNull();
    const second = await listSessions(db, { projectId: 'proj_1' }, { limit: 2, cursor: first.cursor! });
    expect(second.rows.map((r) => r.sessionId)).toEqual(['s1']);
    expect(second.cursor).toBeNull();
  });

  it('never returns a session outside the scope', async () => {
    const { db, sqlite } = sqliteEnv();
    seedSessions(sqlite);
    expect(await getSession(db, { projectId: 'proj_1' }, 'other')).toBeNull();
    expect((await getSession(db, { projectId: 'proj_2' }, 'other'))?.sessionId).toBe('other');
  });

  it('lists projects with their session counts and last activity', async () => {
    const { db, sqlite } = sqliteEnv();
    seedSessions(sqlite);
    const rows = await listProjects(db);
    expect(rows).toEqual([
      { projectId: 'proj_2', name: 'Two', createdAt: 2, sessionCount: 1, lastActivityAt: 99, archivedAt: null, archivedBy: null },
      { projectId: 'proj_1', name: 'One', createdAt: 1, sessionCount: 3, lastActivityAt: 30, archivedAt: null, archivedBy: null },
    ]);
  });

  it('counts and orders projects by live sessions only, keeping a project whose sessions are all deleted and an empty one', async () => {
    const { db, sqlite } = sqliteEnv();
    seedSessions(sqlite);
    sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_3','Only deleted',3), ('proj_4','Empty',4)`);
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                VALUES ('proj_1','s9','m1','tok_1',9,200), ('proj_3','gone','m1','tok_1',6,300)`);
    sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES ('proj_1','s9',NULL,400,'mem_1'), ('proj_3','gone',NULL,400,'mem_1')`);
    const rows = await listProjects(db);
    expect(rows.map((p) => [p.projectId, p.sessionCount, p.lastActivityAt])).toEqual([
      ['proj_2', 1, 99],
      ['proj_1', 3, 30],
      ['proj_4', 0, null],
      ['proj_3', 0, null],
    ]);
    const stats = await projectStats(db, { projectId: 'proj_1' }, 1_000);
    expect([stats.sessions, stats.lastActivityAt]).toEqual([3, 30]);
    expect((await projectStats(db, { projectId: 'proj_3' }, 1_000)).sessions).toBe(0);
  });

  it('hides an archived project by default, lists it on request with who archived it, and restores it', async () => {
    const { db, sqlite } = sqliteEnv();
    seedSessions(sqlite);
    expect(await archiveProject(db, 'proj_1', 'mem_a', 50)).toBe('archived');
    expect(await archiveProject(db, 'proj_1', 'mem_b', 51)).toBe('already_archived');
    expect(await archiveProject(db, 'absent', 'mem_a', 52)).toBe('absent');
    expect((await listProjects(db)).map((p) => p.projectId)).toEqual(['proj_2']);
    const all = await listProjects(db, { includeArchived: true });
    expect(all.map((p) => [p.projectId, p.archivedAt, p.archivedBy])).toEqual([['proj_2', null, null], ['proj_1', 50, 'mem_a']]);
    expect(await unarchiveProject(db, 'proj_2')).toBe('not_archived');
    expect(await unarchiveProject(db, 'proj_1')).toBe('restored');
    expect((await listProjects(db)).map((p) => p.projectId)).toEqual(['proj_2', 'proj_1']);
  });
});

const UUID = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

import { credentialActivity, listCredentials } from '@myco-server-worker/read/credentials.js';

describe('read/credentials', () => {
  it('reports what a credential wrote, newest first, across every project', async () => {
    const { db, sqlite } = sqliteEnv();
    sqlite.run(`INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
                VALUES ('proj_1','e1','s1','tok_1','prompt','cli','{}','h1',10,10),
                       ('proj_1','e2','s1','tok_1','response','cli','{}','h2',20,20),
                       ('proj_1','e3','s2','tok_2','prompt','cli','{}','h3',30,30),
                       ('proj_2','e4','s3','tok_1','prompt','cli','{}','h4',40,40)`);
    const { rows } = await credentialActivity(db, 'tok_1');
    expect(rows.map((r) => r.eventId)).toEqual(['e4', 'e2', 'e1']);
    expect(rows[0]).toMatchObject({ kind: 'prompt', sessionId: 's3', projectId: 'proj_2' });
  });

  it('lists the Deployment\'s credentials with quota and lineage, one page at a time', async () => {
    const { db, sqlite, env } = sqliteEnv();
    const { issueMemberToken } = await import('@myco-server-worker/auth/tokens.js');
    await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, 1_000);
    const { rows } = await listCredentials(db, 1_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ machineId: 'machine_1', bytesWritten: 0, revokedAt: null });
    expect(rows[0].lineageRoot).toBe(rows[0].id);
    void sqlite; void env;
  });

  it('lists one member\'s credentials alone where it is asked for them, and every member\'s where it is not (#1491)', async () => {
    const { db } = sqliteEnv();
    const { issueMemberToken } = await import('@myco-server-worker/auth/tokens.js');
    await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, 1_000);
    await issueMemberToken(db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, 1_000);
    const owners = async (opts: { memberId?: string }) => [...new Set((await listCredentials(db, 1_000, opts)).rows.map((r) => r.memberId))].sort();
    expect({ one: await owners({ memberId: 'mem_machine_2' }), all: await owners({}) }).toEqual({ one: ['mem_machine_2'], all: ['mem_machine_1', 'mem_machine_2'] });
  });
});

describe('read scope', () => {
  it('round-trips a cursor', () => {
    expect(decodeCursor(encodeCursor(1234, 'sess_a'))).toEqual({ createdAt: 1234, id: 'sess_a' });
  });

  it('refuses a malformed cursor rather than guessing', () => {
    for (const bad of ['', 'nope', ':x', 'NaN:x', '12']) expect(decodeCursor(bad)).toBeNull();
  });

  it('clamps the page size', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE);
    expect(clampLimit(0)).toBe(DEFAULT_PAGE);
    expect(clampLimit(10_000)).toBe(MAX_PAGE);
    expect(clampLimit(10)).toBe(10);
  });

  it('emits a cursor only when another page exists', () => {
    const key = (r: { t: number; id: string }) => ({ createdAt: r.t, id: r.id });
    const rows = [{ t: 3, id: 'c' }, { t: 2, id: 'b' }, { t: 1, id: 'a' }];
    expect(page(rows.slice(0, 2), 2, key).cursor).toBeNull();
    const full = page(rows, 2, key);
    expect(full.rows).toHaveLength(2);
    expect(full.cursor).toBe(encodeCursor(2, 'b'));
  });
});

describe('D1 adapter', () => {
  it('returns typed rows from all<T>()', async () => {
    const { db, sqlite } = sqliteEnv();
    sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_a', 'A', 1), ('proj_b', 'B', 2)`);
    const { results } = await db.prepare(`SELECT project_id, name FROM projects ORDER BY created_at`).all<{ project_id: string; name: string }>();
    expect(results.map((r) => r.project_id).filter((p) => p.startsWith('proj_'))).toEqual(['proj_1', 'proj_2', 'proj_a', 'proj_b']);
  });
});

describe('schema v4', () => {
  it('adds a recency index on sessions and stamps the build version', () => {
    expect(SCHEMA_STEPS.at(-1)).toMatchObject({ version: SERVER_SCHEMA_VERSION });
    const v4 = SCHEMA_STEPS.find((s) => s.version === 4);
    expect(v4?.statements.some((s) => s.includes('idx_sessions_recent'))).toBe(true);
  });

  it('orders a project\'s sessions by the index key', async () => {
    const { db, sqlite } = sqliteEnv();
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                VALUES ('proj_1','s1','m1','t1',1,10), ('proj_1','s2','m1','t1',2,30), ('proj_1','s3','m1','t1',3,20)`);
    const { results } = await db.prepare(
      `SELECT session_id FROM sessions WHERE project_id = ? ORDER BY last_received_at DESC, session_id DESC`
    ).bind('proj_1').all<{ session_id: string }>();
    expect(results.map((r) => r.session_id)).toEqual(['s2', 's3', 's1']);
  });
});

/** A database at the build's schema, for reading a plan off it. */
function planDb(drop: readonly string[] = []): Database {
  const sqlite = new Database(':memory:');
  for (const statement of SCHEMA_DDL) sqlite.exec(statement);
  for (const index of drop) sqlite.exec(`DROP INDEX ${index}`);
  return sqlite;
}

/**
 * How a statement reaches a project's sessions: the `sessions` index it seeks
 * on, whether it scanned the table instead, and whether the planner sorted what
 * that step produced.
 *
 * The plan is a tree, so the sort is attributed rather than searched for: a
 * sort of these rows sits beside the step that produced them. In a statement
 * whose sessions arm is one branch of a union, another branch always carries a
 * sort of its own, and a plan-wide search for one reports every such statement
 * as sorted.
 */
function sessionPlan(sqlite: Database, sql: string): { index: string | null; scanned: string | null; sorted: boolean } {
  const rows = sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { id: number; parent: number; detail: string }[];
  const search = rows.find((r) => /^SEARCH \w+ USING (?:COVERING )?INDEX idx_sessions_\w+/.test(r.detail)) ?? null;
  return {
    index: search === null ? null : /INDEX (idx_sessions_\w+)/.exec(search.detail)![1],
    scanned: rows.map((r) => /^SCAN (s|sessions)\b/.exec(r.detail)?.[1]).find((x) => x !== undefined) ?? null,
    sorted: search !== null && rows.some((r) => r.parent === search.parent && r.detail.includes('TEMP B-TREE')),
  };
}

/**
 * The session list as PR #1195 issues it, first page and keyset page.
 *
 * The statement is a literal: the read that issues it has not landed yet, and
 * this step exists so the index is in place when it arrives. It is copied from
 * that branch's `read/sessions.ts`, and the ordering expression — the whole of
 * what this index answers — is the one `read/catalog/activity.ts` already orders by
 * here, so the test below holds the same plan against a statement the module
 * itself executes.
 */
// The ordering expression is shared with the production read.
const OCCURRED_AT = SESSION_OCCURRED_AT;
const A4_SESSION_LIST = (keyset: boolean): string =>
  `SELECT s.session_id, s.machine_id, s.created_by_token_id, s.first_received_at, s.last_received_at,
     s.agent, s.branch, s.started_at, s.ended_at, s.origin_path, s.parent_session_id, s.parent_reason,
     s.title, s.summary, s.titled_at, (SELECT first_prompt FROM session_documents d WHERE d.project_id=s.project_id AND d.session_id=s.session_id AND d.state='live') AS first_prompt,
     c.member_id, c.runtime_label, c.runtime_kind, m.label AS member_label
   FROM sessions s
     LEFT JOIN member_credentials c ON c.id = s.created_by_token_id
     LEFT JOIN members m ON m.id = c.member_id
   WHERE s.project_id = ? AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = s.project_id AND t.session_id = s.session_id)${
     keyset ? ` AND (${OCCURRED_AT} < ? OR (${OCCURRED_AT} = ? AND s.session_id < ?))` : ''}
   ORDER BY ${OCCURRED_AT} DESC, s.session_id DESC LIMIT ?`;

describe('schema v34', () => {
  it('keeps occurrence ordering for session lists and receipt ordering for KPI denominators', () => {
    const v34 = SCHEMA_STEPS.find((s) => s.version === 34);
    expect(v34?.statements.some((s) => s.includes('CREATE INDEX IF NOT EXISTS idx_sessions_occurred'))).toBe(true);
    expect(v34?.statements).toContain('DROP INDEX IF EXISTS idx_sessions_recent');
    const sqlite = planDb();
    try {
      const indexes = sqlite.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'").all().map(row => row.name);
      expect(indexes).toEqual(expect.arrayContaining(['idx_sessions_occurred', 'idx_sessions_received']));
      expect(indexes).not.toContain('idx_sessions_recent');
    } finally { sqlite.close(); }
  });

  it('serves a session list ordered by when the session happened from one index, first page and keyset page alike, with no sort step', () => {
    const served = planDb();
    for (const keyset of [false, true]) {
      expect({ keyset, ...sessionPlan(served, A4_SESSION_LIST(keyset)) })
        .toEqual({ keyset, index: 'idx_sessions_occurred', scanned: null, sorted: false });
    }
    // The assertion above is load-bearing. Without the index the planner reaches
    // the project's sessions by another path and sorts every one of them: the
    // 0.026 ms and the 4.222 ms this step's measurement separates at 50k sessions.
    const bare = planDb(['idx_sessions_occurred']);
    for (const keyset of [false, true]) {
      expect({ keyset, sorted: sessionPlan(bare, A4_SESSION_LIST(keyset)).sorted }).toEqual({ keyset, sorted: true });
    }
  });

  it('serves the activity feed\'s sessions arm from the same index, and reaches no project\'s sessions by a scan', async () => {
    const { db, sqlite, executed } = sqliteEnv();
    seedSessions(sqlite);
    await activityFeed(db, { projectId: 'proj_1' });
    await listSessions(db, { projectId: 'proj_1' });
    await listSessions(db, { projectId: 'proj_1' }, { cursor: encodeCursor(2, 's2') });
    const overSessions = [...new Set(executed)].filter((sql) => /\bFROM sessions s\b/.test(sql));
    expect(overSessions.length).toBeGreaterThanOrEqual(3);
    // Every read of a project's sessions reaches them by an index — on this
    // branch, and once the occurred-at list lands.
    const served = planDb();
    for (const sql of overSessions) expect({ sql, scanned: sessionPlan(served, sql).scanned }).toEqual({ sql, scanned: null });
    const feed = overSessions.find((sql) => sql.includes("'session' AS type"))!;
    expect(sessionPlan(served, feed)).toEqual({ index: 'idx_sessions_occurred', scanned: null, sorted: false });
    expect(sessionPlan(planDb(['idx_sessions_occurred']), feed).sorted).toBe(true);
  });
});

describe('read/meta', () => {
  it('reports the schema version the database carries', async () => {
    const { db } = sqliteEnv();
    const { schemaVersion } = await import('@myco-server-worker/read/meta.js');
    expect(await schemaVersion(db)).toBe(SERVER_SCHEMA_VERSION);
  });
});

describe('read/blobs', () => {
  it('reads a blob record inside the scope and refuses one outside it', async () => {
    const key = 'f'.repeat(64);
    // A row registered before generations existed names its legacy object.
    const { db, sqlite } = sqliteEnv({ beforeStep42: (seed) => legacyBlob(seed, { projectId: 'proj_1', key, size: 12, mediaType: 'image/png', tokenId: 't1' }) });
    const { getBlob } = await import('@myco-server-worker/read/blobs.js');
    expect(await getBlob(db, { projectId: 'proj_1' }, key)).toEqual({ size: 12, mediaType: 'image/png', objectKey: `proj_1/${key}` });
    const generation = crypto.randomUUID();
    sqlite.run(`UPDATE blobs SET generation = ? WHERE key = ?`, [generation, key]);
    expect(await getBlob(db, { projectId: 'proj_1' }, key)).toEqual({ size: 12, mediaType: 'image/png', objectKey: `proj_1/${key}~${generation}` });
    expect(await getBlob(db, { projectId: 'proj_2' }, key)).toBeNull();
  });
});

describe('read/transcript', () => {
  it('reads a session transcript and its segments in offset order', async () => {
    const { db, sqlite } = sqliteEnv();
    const { listSegments, listTranscripts } = await import('@myco-server-worker/read/transcript.js');
    const cols = sqlite.query(`SELECT name FROM pragma_table_info('transcripts')`).all() as { name: string }[];
    const segCols = sqlite.query(`SELECT name FROM pragma_table_info('transcript_segments')`).all() as { name: string }[];
    // Bind only what the tables declare, so this test tracks the schema rather than a snapshot of it.
    const value = (name: string): string =>
      name.endsWith('_at') || name.includes('size') || name.includes('offset') || name.includes('bytes') ? '1'
      : name === 'project_id' ? `'proj_1'`
      : name === 'session_id' ? `'s1'`
      : name === 'parser_context' ? `'{}'`
      : name === 'transcript_id' ? `'tr1'`
      : `'x'`;
    sqlite.run(`INSERT INTO transcripts (${cols.map((c) => c.name).join(',')}) VALUES (${cols.map((c) => value(c.name)).join(',')})`);
    const [t] = await listTranscripts(db, { projectId: 'proj_1' }, 's1');
    expect(t?.transcriptId).toBe('tr1');
    sqlite.run(`INSERT INTO transcript_segments (${segCols.map((c) => c.name).join(',')}) VALUES (${segCols.map((c) => value(c.name)).join(',')})`);
    expect((await listSegments(db, { projectId: 'proj_1' }, 'tr1')).length).toBe(1);
  });
});

describe('paging is stable under live capture', () => {
  it('returns every session even when one receives events between pages', async () => {
    const { db, sqlite } = sqliteEnv();
    for (let i = 1; i <= 6; i++) {
      sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                  VALUES ('proj_1','s${i}','m','t',${i},${i})`);
    }
    const first = await listSessions(db, { projectId: 'proj_1' }, { limit: 3 });
    // The oldest-started session becomes the most recently active mid-page, the way a live
    // capture rewrites last_received_at while an owner is paging.
    sqlite.run(`UPDATE sessions SET last_received_at = 9999 WHERE session_id = 's1'`);
    const second = await listSessions(db, { projectId: 'proj_1' }, { limit: 3, cursor: first.cursor! });
    const seen = [...first.rows, ...second.rows].map((r) => r.sessionId).sort();
    expect(seen).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
  });
});

describe('read/activity', () => {
  /** A project with one run per shape a run's clock can take. */
  const seedRuns = (sqlite: import('bun:sqlite').Database) => {
    sqlite.run(`INSERT OR REPLACE INTO projects (project_id, name, created_at) VALUES ('proj_1','One',1)`);
    sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('a','a','built-in',1,1)`);
    const insert = `INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, queued_at) VALUES ('proj_1', ?, 'a', 'extract-curate', ?, ?, ?, ?)`;
    sqlite.run(insert, ['ran', 'completed', 300, 400, null]);
    // A queued run the Deployment gave up on: it never started, so it has an
    // end and a place in the queue and nothing else.
    sqlite.run(insert, ['expired', 'failed', null, 200, 100]);
    // A queued run still waiting: no start and no end, only its place.
    sqlite.run(insert, ['waiting', 'queued', null, null, 50]);
  };

  it('shows a run by whichever clock it has, so a run that never started is not lost from the feed', async () => {
    const { db, sqlite } = sqliteEnv();
    seedRuns(sqlite);
    const feed = await activityFeed(db, { projectId: 'proj_1' });
    expect(feed.filter((f) => f.type === 'run').map((f) => [f.id, f.at]))
      .toEqual([['ran', 300], ['expired', 200], ['waiting', 50]]);
  });
});
