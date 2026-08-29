import { describe, it, expect } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { clampLimit, decodeCursor, encodeCursor, page, DEFAULT_PAGE, MAX_PAGE } from '@myco-server-worker/read/scope.js';

import { getSession, listProjects, listSessions, projectStats } from '@myco-server-worker/read/sessions.js';

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
      agent: 'claude-code', branch: 'main', startedAt: 3, endedAt: null, originPath: '/repo', parentSessionId: null, parentReason: null,
      memberId: null, memberLabel: null, runtimeLabel: null, runtimeKind: null,
    });
    expect(cursor).toBeNull();
  });

  it('names the member and runtime behind each session, lists a session whose credential is gone, and keeps the order', async () => {
    const { db, sqlite } = sqliteEnv();
    seedSessions(sqlite);
    sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at) VALUES ('mem_a', 'chris', 1)`);
    sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, runtime_label, runtime_kind, issued_at, expires_at, lineage_root, lineage_started_at)
                VALUES ('tok_1', 'mem_a', 'h', 'm1', 'laptop', 'host', 1, 99, 'tok_1', 1)`);
    const { rows } = await listSessions(db, { projectId: 'proj_1' });
    expect(rows.map((r) => [r.sessionId, r.memberLabel, r.runtimeLabel, r.runtimeKind])).toEqual([
      ['s3', 'chris', 'laptop', 'host'], ['s2', null, null, null], ['s1', 'chris', 'laptop', 'host'],
    ]);
    expect((await getSession(db, { projectId: 'proj_1' }, 's2'))?.memberId).toBeNull();
  });

  it('counts what a project holds, and only that project', async () => {
    const { db, sqlite } = sqliteEnv();
    seedSessions(sqlite);
    sqlite.run(`UPDATE sessions SET ended_at = 9 WHERE project_id = 'proj_1' AND session_id = 's1'`);
    sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                VALUES ('proj_1','s1','p1','e1','a','user','h1',1,1,'t',1), ('proj_2','other','p2','e2','b','user','h2',1,1,'t',1)`);
    sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, content_hash, status, created_at, updated_at, token_id, received_at)
                VALUES ('proj_1','pl1','s1','e3','m1','h3','active',1,1,'t',1)`);
    expect(await projectStats(db, { projectId: 'proj_1' }, 3 + 7 * 24 * 60 * 60 * 1000)).toEqual({
      sessions: 3, openSessions: 2, sessionsLast7d: 1, prompts: 1, toolCalls: 0, plans: 1, attachments: 0, lastActivityAt: 30,
    });
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
      { projectId: 'proj_2', name: 'Two', createdAt: 2, sessionCount: 1, lastActivityAt: 99 },
      { projectId: 'proj_1', name: 'One', createdAt: 1, sessionCount: 3, lastActivityAt: 30 },
    ]);
  });
});

import { INPUT_PREVIEW_CHARS, listPrompts, listToolCalls } from '@myco-server-worker/read/children.js';

describe('read/children', () => {
  it('lists a session\'s prompts oldest first inside the scope', async () => {
    const { db, sqlite } = sqliteEnv();
    sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                VALUES ('proj_1','s1','p2','e2','second','user','h2',20,20,'t1',20), ('proj_1','s1','p1','e1','first','user','h1',10,10,'t1',10),
                       ('proj_2','s1','pX','eX','other','user','hX',15,15,'t1',15)`);
    const { rows } = await listPrompts(db, { projectId: 'proj_1' }, 's1');
    expect(rows.map((r) => r.text)).toEqual(['first', 'second']);
  });

  it('carries how each tool call went, with a bounded input preview and the input\'s full size', async () => {
    const { db, sqlite } = sqliteEnv();
    const input = 'x'.repeat(190_000);
    sqlite.run(`INSERT INTO tool_calls (project_id, session_id, tool_call_id, event_id, tool_name, myco_tool, input, output_preview, success, error_message, duration_ms, created_at, token_id, received_at)
                VALUES ('proj_1','s1','tc1','ev1','Write',NULL,?,'wrote it',0,'disk full',42,1,'t1',1)`, [input]);
    const { rows } = await listToolCalls(db, { projectId: 'proj_1' }, 's1');
    expect(rows.map((r) => [r.toolName, r.success, r.errorMessage, r.durationMs, r.outputPreview, r.inputPreview?.length, r.inputBytes]))
      .toEqual([['Write', false, 'disk full', 42, 'wrote it', INPUT_PREVIEW_CHARS, 190_000]]);
  });

  it('pages tool calls and stops cleanly at the end', async () => {
    const { db, sqlite } = sqliteEnv();
    for (let i = 1; i <= 3; i++) {
      sqlite.run(`INSERT INTO tool_calls (project_id, session_id, tool_call_id, event_id, tool_name, success, created_at, token_id, received_at) VALUES ('proj_1','s1','tc${i}','ev${i}','Read',1,${i * 10},'t1',${i * 10})`);
    }
    const first = await listToolCalls(db, { projectId: 'proj_1' }, 's1', { limit: 2 });
    expect(first.rows.map((r) => r.toolCallId)).toEqual(['tc1', 'tc2']);
    const second = await listToolCalls(db, { projectId: 'proj_1' }, 's1', { limit: 2, cursor: first.cursor! });
    expect(second.rows.map((r) => r.toolCallId)).toEqual(['tc3']);
    expect(second.cursor).toBeNull();
  });
});

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
    const { rows } = await listCredentials(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ machineId: 'machine_1', bytesWritten: 0, revokedAt: null });
    expect(rows[0].lineageRoot).toBe(rows[0].id);
    void sqlite; void env;
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
    expect(SERVER_SCHEMA_VERSION).toBe(9);
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

describe('read/meta', () => {
  it('reports the schema version the database carries', async () => {
    const { db } = sqliteEnv();
    const { schemaVersion } = await import('@myco-server-worker/read/meta.js');
    expect(await schemaVersion(db)).toBe(9);
  });
});

describe('read/blobs', () => {
  it('reads a blob record inside the scope and refuses one outside it', async () => {
    const { db, sqlite } = sqliteEnv();
    const { getBlob } = await import('@myco-server-worker/read/blobs.js');
    const key = 'f'.repeat(64);
    sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at)
                VALUES ('proj_1','${key}',12,'image/png','t1',1)`);
    expect(await getBlob(db, { projectId: 'proj_1' }, key)).toEqual({ size: 12, mediaType: 'image/png' });
    expect(await getBlob(db, { projectId: 'proj_2' }, key)).toBeNull();
  });
});

describe('read/transcript', () => {
  it('reads a session transcript and its segments in offset order', async () => {
    const { db, sqlite } = sqliteEnv();
    const { getTranscript, listSegments } = await import('@myco-server-worker/read/transcript.js');
    const cols = sqlite.query(`SELECT name FROM pragma_table_info('transcripts')`).all() as { name: string }[];
    const segCols = sqlite.query(`SELECT name FROM pragma_table_info('transcript_segments')`).all() as { name: string }[];
    // Bind only what the tables declare, so this test tracks the schema rather than a snapshot of it.
    const value = (name: string): string =>
      name.endsWith('_at') || name.includes('size') || name.includes('offset') || name.includes('bytes') ? '1'
      : name === 'project_id' ? `'proj_1'`
      : name === 'session_id' ? `'s1'`
      : name === 'transcript_id' ? `'tr1'`
      : `'x'`;
    sqlite.run(`INSERT INTO transcripts (${cols.map((c) => c.name).join(',')}) VALUES (${cols.map((c) => value(c.name)).join(',')})`);
    const t = await getTranscript(db, { projectId: 'proj_1' }, 's1');
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
