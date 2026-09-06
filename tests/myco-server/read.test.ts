import { describe, it, expect } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { clampLimit, decodeCursor, encodeCursor, page, DEFAULT_PAGE, MAX_PAGE } from '@myco-server-worker/read/scope.js';

import { archiveProject, getSession, listProjects, listSessions, projectStats, renameProject, sessionLabel, unarchiveProject, LABEL_MAX_CHARS } from '@myco-server-worker/read/sessions.js';
import { activityFeed } from '@myco-server-worker/read/activity.js';

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
      title: null, summary: null, titledAt: null, label: 'claude-code',
    });
    expect(cursor).toBeNull();
  });

  it('labels a session by its title, else by the first line of its first user prompt cut on a word boundary, else by its agent, else by its id', async () => {
    const { db, sqlite } = sqliteEnv();
    seedSessions(sqlite);
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1','s4','m1','tok_1',4,40)`);
    sqlite.run(`UPDATE sessions SET title = 'Wave-based executor', summary = 'Built it.', titled_at = 50 WHERE session_id = 's3'`);
    const long = `${'abcde '.repeat(30).trim()}\nsecond line`;
    sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                VALUES ('proj_1','s1','p2','e2','later prompt','user','h2',20,20,'t1',20),
                       ('proj_1','s1','p1','e1',?,'user','h1',10,10,'t1',10),
                       ('proj_1','s1','p0','e0','assistant text first','assistant','h0',5,5,'t1',5),
                       ('proj_1','s2','pS','eS',NULL,'user','hS',10,10,'t1',10),
                       ('proj_1','s3','p3','e3','ignored: the title wins','user','h3',10,10,'t1',10)`, [long]);
    const rows = (await listSessions(db, { projectId: 'proj_1' })).rows;
    const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]));
    expect(byId.s3.label).toBe('Wave-based executor');
    expect(byId.s3.summary).toBe('Built it.');
    expect(byId.s3.titledAt).toBe(50);
    expect(byId.s1.label.endsWith('…')).toBe(true);
    expect(byId.s1.label.length).toBeLessThanOrEqual(LABEL_MAX_CHARS + 1);
    expect(byId.s1.label).toBe(`${'abcde '.repeat(13).trim()}…`);
    expect(byId.s2.label).toBe('claude-code');
    expect(byId.s4.label).toBe('s4');
    expect((await getSession(db, { projectId: 'proj_1' }, 's1'))?.label).toBe(byId.s1.label);
    expect(sessionLabel(null, '  first line here  \n\nmore', null, 'x')).toBe('first line here');
    expect(sessionLabel(null, 'a'.repeat(100), null, 'x')).toBe(`${'a'.repeat(LABEL_MAX_CHARS)}…`);
    const exact = `${'abcdefghij '.repeat(7)}abc tail words`;
    expect(exact[LABEL_MAX_CHARS]).toBe(' ');
    expect(sessionLabel(null, exact, null, 'x')).toBe(`${'abcdefghij '.repeat(7)}abc…`);
    expect(sessionLabel('  Titled  ', 'prompt', 'agent', 'x')).toBe('Titled');
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
                VALUES ('proj_1','pl1','s1','e3','m1','h3','active',1,1,'t',1), ('proj_2','pl2','other','e4','m9','h4','active',1,1,'t',1)`);
    sqlite.run(`INSERT INTO tool_calls (project_id, session_id, tool_call_id, event_id, tool_name, success, created_at, token_id, received_at)
                VALUES ('proj_1','s1','tc1','e5','Read',1,1,'t',1), ('proj_2','other','tc2','e6','Read',1,1,'t',1)`);
    sqlite.run(`INSERT INTO attachments (project_id, attachment_id, session_id, event_id, blob_key, media_type, byte_size, created_at, token_id, received_at)
                VALUES ('proj_1','a1','s1','e7','${'a'.repeat(64)}','image/png',9,1,'t',1), ('proj_2','a2','other','e8','${'b'.repeat(64)}','image/png',9,1,'t',1)`);
    expect(await projectStats(db, { projectId: 'proj_1' }, 3 + 7 * 24 * 60 * 60 * 1000)).toEqual({
      sessions: 3, openSessions: 2, sessionsLast7d: 1, prompts: 1, toolCalls: 1, plans: 1, attachments: 1, lastActivityAt: 30,
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
      { projectId: 'proj_2', name: 'Two', createdAt: 2, sessionCount: 1, lastActivityAt: 99, archivedAt: null, archivedBy: null },
      { projectId: 'proj_1', name: 'One', createdAt: 1, sessionCount: 3, lastActivityAt: 30, archivedAt: null, archivedBy: null },
    ]);
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

import { listTurns, parseOrigins, turnDetail, DEFAULT_ORIGINS, TURN_PREVIEW_CHARS } from '@myco-server-worker/read/turns.js';
import { listAttachments } from '@myco-server-worker/read/children.js';
import { bucketActivity, containsPattern, listSessionSummaries, ACTIVITY_BUCKETS } from '@myco-server-worker/read/sessions.js';
import { inListChunks, MAX_IN_LIST } from '@myco-server-worker/read/scope.js';

const UUID = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('read/turns', () => {
  function seedTurns(sqlite: import('bun:sqlite').Database) {
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, started_at) VALUES ('proj_1','s1','m1','tok_1',1,100,1)`);
    sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, parent_prompt_id, thread_label, text, blob_key, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES
      ('proj_1','s1',?,'e1',NULL,NULL,?,NULL,'user','h1',10,10,'t1',10),
      ('proj_1','s1',?,'e2',NULL,NULL,'<task-notification>ignored by default</task-notification>',NULL,'system','h2',20,20,'t1',20),
      ('proj_1','s1',?,'e3',?,'reviewer','steer it left',NULL,'user','h3',25,25,'t1',25),
      ('proj_1','s1',?,'e4',NULL,NULL,NULL,?,'user','h4',30,30,'t1',30),
      ('proj_2','s1',?,'e5',NULL,NULL,'other project',NULL,'user','h5',15,15,'t1',15)`,
      [UUID(1), `${'first prompt '.repeat(20)}tail`, UUID(2), UUID(3), UUID(1), UUID(4), 'a'.repeat(64), UUID(9)]);
    sqlite.run(`INSERT INTO tool_calls (project_id, session_id, tool_call_id, event_id, prompt_id, tool_name, success, created_at, token_id, received_at) VALUES
      ('proj_1','s1','tc1','ev1',?,'Read',1,11,'t1',11), ('proj_1','s1','tc2','ev2',?,'Edit',1,12,'t1',12), ('proj_1','s1','tc3','ev3',?,'Bash',0,26,'t1',26)`, [UUID(1), UUID(1), UUID(3)]);
    sqlite.run(`INSERT INTO responses (project_id, session_id, response_id, event_id, prompt_id, text, content_hash, created_at, token_id, received_at) VALUES
      ('proj_1','s1','r1','er1',?,'done the first','hr1',13,'t1',13), ('proj_1','s1','r2','er2',?,'steered','hr2',27,'t1',27)`, [UUID(1), UUID(3)]);
    sqlite.run(`INSERT INTO attachments (project_id, session_id, attachment_id, event_id, prompt_id, blob_key, media_type, byte_size, created_at, token_id, received_at) VALUES
      ('proj_1','s1','a1','ea1',?,?,'image/png',1234,14,'t1',14)`, [UUID(1), 'b'.repeat(64)]);
    sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, content_hash, status, prompt_id, updated_by, created_at, updated_at, token_id, received_at) VALUES
      ('proj_1',?,'s1','ep1','m1','Plan','- [x] a\n- [ ] b','hp1','in_progress',?,'mem_x',15,16,'t1',16)`, [UUID(5), UUID(1)]);
  }

  it('lists top-level prompts of the default origin oldest first, with a preview, the spilled key, and counts of what followed each', async () => {
    const { db, sqlite } = sqliteEnv();
    seedTurns(sqlite);
    const { rows, cursor } = await listTurns(db, { projectId: 'proj_1' }, 's1');
    expect(cursor).toBeNull();
    expect(rows.map((r) => r.promptId)).toEqual([UUID(1), UUID(4)]);
    expect(rows[0]).toMatchObject({ origin: 'user', threadLabel: null, blobKey: null, createdAt: 10, toolCallCount: 2, responseCount: 1, childCount: 1, planCount: 1, attachmentCount: 1 });
    expect(rows[0].preview).toHaveLength(TURN_PREVIEW_CHARS);
    expect(rows[0].textChars).toBe(`${'first prompt '.repeat(20)}tail`.length);
    expect(rows[1]).toMatchObject({ preview: null, textChars: null, blobKey: 'a'.repeat(64), toolCallCount: 0, responseCount: 0, childCount: 0, planCount: 0, attachmentCount: 0 });
  });

  it('shows every origin when asked, pages by the turn key, and refuses an origin the wire does not admit', async () => {
    const { db, sqlite } = sqliteEnv();
    seedTurns(sqlite);
    const all = await listTurns(db, { projectId: 'proj_1' }, 's1', { origins: ['user', 'system'], limit: 2 });
    expect(all.rows.map((r) => [r.promptId, r.origin])).toEqual([[UUID(1), 'user'], [UUID(2), 'system']]);
    const rest = await listTurns(db, { projectId: 'proj_1' }, 's1', { origins: ['user', 'system'], limit: 2, cursor: all.cursor! });
    expect(rest.rows.map((r) => r.promptId)).toEqual([UUID(4)]);
    expect(rest.cursor).toBeNull();
    expect(parseOrigins(null)).toEqual(DEFAULT_ORIGINS);
    expect(parseOrigins('system, user,user')).toEqual(['system', 'user']);
    expect(parseOrigins('human')).toBeNull();
    expect(parseOrigins(',')).toBeNull();
    expect((await listTurns(db, { projectId: 'proj_1' }, 's1', { origins: [] })).rows).toEqual([]);
    expect((await listTurns(db, { projectId: 'proj_1' }, 's1', { cursor: 'garbage' })).rows).toEqual([]);
  });

  it('reads one turn with its responses, its attachments and its steering children, and nothing of another project', async () => {
    const { db, sqlite } = sqliteEnv();
    seedTurns(sqlite);
    const detail = await turnDetail(db, { projectId: 'proj_1' }, 's1', UUID(1));
    expect(detail?.prompt).toMatchObject({ promptId: UUID(1), origin: 'user', parentPromptId: null, blobKey: null });
    expect(detail?.prompt.text?.endsWith('tail')).toBe(true);
    expect(detail?.responses.map((r) => r.text)).toEqual(['done the first']);
    expect(detail?.attachments.map((a) => [a.attachmentId, a.promptId, a.mediaType])).toEqual([['a1', UUID(1), 'image/png']]);
    expect(detail?.plans.map((p) => [p.planKey, p.promptId, p.status, p.progress, p.updatedBy])).toEqual([[UUID(5), UUID(1), 'in_progress', '1/2', 'mem_x']]);
    expect((await turnDetail(db, { projectId: 'proj_1' }, 's1', UUID(4)))?.plans).toEqual([]);
    expect(detail?.children.map((c) => [c.prompt.promptId, c.prompt.threadLabel, c.prompt.text, c.toolCallCount, c.responses.map((r) => r.text)])).toEqual([[UUID(3), 'reviewer', 'steer it left', 1, ['steered']]]);
    expect(await turnDetail(db, { projectId: 'proj_2' }, 's1', UUID(1))).toBeNull();
    expect(await turnDetail(db, { projectId: 'proj_1' }, 's1', UUID(9))).toBeNull();
  });

  it('carries what Myco added to a turn, hydrated, and null for a turn it added nothing to', async () => {
    const { db, sqlite } = sqliteEnv();
    seedTurns(sqlite);
    sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1','a','built-in',1,0)`);
    sqlite.run(`INSERT INTO spores (project_id, id, agent_id, session_id, prompt_id, observation_type, status, content, importance, created_at, embedded)
      VALUES ('proj_1','sp1','agent_1',NULL,NULL,'decision','active','the selector reads recency',5,5,0)`);
    sqlite.run(`INSERT INTO spore_injections (project_id, session_id, prompt_id, prompt_hash, spore_ids, created_at)
      VALUES ('proj_1','s1',?,'ph1',?,9)`, [UUID(1), JSON.stringify(['sp1', 'sp_gone'])]);

    const detail = await turnDetail(db, { projectId: 'proj_1' }, 's1', UUID(1));
    expect(detail?.injection).toEqual({
      sporeIds: ['sp1', 'sp_gone'],
      createdAt: 9,
      spores: [{ id: 'sp1', observationType: 'decision', preview: 'the selector reads recency' }],
    });
    expect((await turnDetail(db, { projectId: 'proj_1' }, 's1', UUID(4)))?.injection).toBeNull();
  });

  it('narrows a child read to one prompt, and carries the prompt an attachment accompanies', async () => {
    const { db, sqlite } = sqliteEnv();
    seedTurns(sqlite);
    const { listToolCalls } = await import('@myco-server-worker/read/children.js');
    expect((await listToolCalls(db, { projectId: 'proj_1' }, 's1', { promptId: UUID(1) })).rows.map((t) => t.toolCallId)).toEqual(['tc1', 'tc2']);
    expect((await listToolCalls(db, { projectId: 'proj_1' }, 's1', { promptId: UUID(3), limit: 1 })).rows.map((t) => t.toolName)).toEqual(['Bash']);
    expect((await listAttachments(db, { projectId: 'proj_1' }, 's1')).rows.map((a) => a.promptId)).toEqual([UUID(1)]);
  });
});

describe('read/sessions summaries', () => {
  it('spreads prompt instants over a session\'s lifetime, widening a stored range by what it observes', () => {
    const open = { sessionId: 'open', startedAt: 1_000, firstReceivedAt: 1_000, endedAt: null, lastReceivedAt: 5_000 };
    const ended = { sessionId: 'ended', startedAt: 1_000, firstReceivedAt: 1_000, endedAt: 9_000, lastReceivedAt: 9_000 };
    const unstarted = { sessionId: 'unstarted', startedAt: null, firstReceivedAt: 2_000, endedAt: null, lastReceivedAt: 6_000 };
    const buckets = bucketActivity([open, ended, unstarted], [
      { sessionId: 'open', at: 1_000 }, { sessionId: 'open', at: 9_000 },
      { sessionId: 'ended', at: 1_000 }, { sessionId: 'ended', at: 5_000 }, { sessionId: 'ended', at: 9_000 },
      { sessionId: 'unstarted', at: 500 }, { sessionId: 'unstarted', at: 6_000 },
    ], 17_000);
    expect(buckets.get('ended')).toEqual([1, 0, 0, 0, 1, 0, 0, 1]);
    expect(buckets.get('open')).toEqual([1, 0, 0, 0, 1, 0, 0, 0]);
    expect(buckets.get('unstarted')).toEqual([1, 0, 0, 0, 0, 0, 0, 1]);
    expect(buckets.get('open')).toHaveLength(ACTIVITY_BUCKETS);
  });

  it('lists sessions with their counts and buckets, and filters by the text the rail types', async () => {
    const { db, sqlite } = sqliteEnv();
    seedSessions(sqlite);
    sqlite.run(`UPDATE sessions SET title = 'Wave-based executor' WHERE session_id = 's3'`);
    sqlite.run(`UPDATE sessions SET branch = 'fix/50%_case' WHERE session_id = 's2'`);
    sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                VALUES ('proj_1','s1','p1','e1','rename the project card','user','h1',5,5,'t1',5), ('proj_1','s1','p2','e2','again','user','h2',9,9,'t1',9)`);
    sqlite.run(`INSERT INTO tool_calls (project_id, session_id, tool_call_id, event_id, tool_name, success, created_at, token_id, received_at) VALUES ('proj_1','s1','tc1','ev1','Read',1,6,'t1',6)`);
    const { rows } = await listSessionSummaries(db, { projectId: 'proj_1' }, {}, 100);
    const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]));
    expect([byId.s1.promptCount, byId.s1.toolCallCount, byId.s1.label]).toEqual([2, 1, 'rename the project card']);
    expect(byId.s1.activityBuckets.reduce((a, b) => a + b, 0)).toBe(2);
    expect([byId.s2.promptCount, byId.s2.toolCallCount, byId.s2.activityBuckets]).toEqual([0, 0, [0, 0, 0, 0, 0, 0, 0, 0]]);
    const find = async (q: string) => (await listSessionSummaries(db, { projectId: 'proj_1' }, { q }, 100)).rows.map((r) => r.sessionId);
    expect(await find('wave')).toEqual(['s3']);
    expect(await find('rename the')).toEqual(['s1']);
    expect(await find('50%_c')).toEqual(['s2']);
    expect(await find('%')).toEqual(['s2']);
    expect(await find('nothing here')).toEqual([]);
    expect(await find('  ')).toEqual(['s3', 's2', 's1']);
    expect(containsPattern('a%b_c\\d')).toBe('%a\\%b\\_c\\\\d%');
  });

  it('names ids in runs under the bound-parameter ceiling, so a full page of summaries reads on every store', async () => {
    expect(MAX_IN_LIST).toBeLessThan(100);
    expect(inListChunks([])).toEqual([]);
    expect(inListChunks(['a']).length).toBe(1);
    const many = Array.from({ length: MAX_IN_LIST * 2 + 1 }, (_, i) => `s${i}`);
    const chunks = inListChunks(many);
    expect(chunks.map((c) => c.length)).toEqual([MAX_IN_LIST, MAX_IN_LIST, 1]);
    expect(chunks.flat()).toEqual(many);

    const { db, sqlite } = sqliteEnv();
    sqlite.run(`INSERT OR REPLACE INTO projects (project_id, name, created_at) VALUES ('proj_1','One',1)`);
    for (let i = 0; i < MAX_PAGE; i++) {
      sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, started_at) VALUES ('proj_1', 'many-${i}', 'm1', 'tok_1', ${1000 + i}, ${2000 + i}, ${1000 + i})`);
      sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', 'many-${i}', 'p-${i}', 'e-${i}', 'hi', 'user', 'h-${i}', ${1500 + i}, ${1500 + i}, 't1', ${1500 + i})`);
    }
    const { rows } = await listSessionSummaries(db, { projectId: 'proj_1' }, { limit: MAX_PAGE }, 5000);
    expect(rows.length).toBe(MAX_PAGE);
    expect(rows.every((r) => r.promptCount === 1 && r.activityBuckets.reduce((a, b) => a + b, 0) === 1)).toBe(true);
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
    expect(SERVER_SCHEMA_VERSION).toBe(19);
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
    expect(await schemaVersion(db)).toBe(19);
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

describe('read/activity', () => {
  /** A project with one run per shape a run's clock can take. */
  const seedRuns = (sqlite: import('bun:sqlite').Database) => {
    sqlite.run(`INSERT OR REPLACE INTO projects (project_id, name, created_at) VALUES ('proj_1','One',1)`);
    sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('a','a','built-in',1,1)`);
    const insert = `INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, queued_at) VALUES ('proj_1', ?, 'a', 'container-smoke', ?, ?, ?, ?)`;
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
