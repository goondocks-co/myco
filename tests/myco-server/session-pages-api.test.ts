/**
 * The project home and the session pages through the product surface.
 *
 * A project that has captured nothing answers an empty feed and zero counts,
 * and 404 names only a project this caller may not see. The feed is one page
 * across sessions, runs and spores, newest first, and never another project's.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, asOwnerPatch, OWNER_ENV } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { MAX_FEED } from '@myco-server-worker/read/activity.js';

const NOW = 1_700_000_000_000;

async function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const sqlite = fixture.sqlite;
  sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, ?)`, [NOW]);
  const session = (project: string, id: string, at: number, over: { agent?: string; branch?: string; endedAt?: number } = {}) =>
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at)
                VALUES (?, ?, 'm1', 'tok_1', ?, ?, ?, ?, ?, ?)`, [project, id, at, at, over.agent ?? null, over.branch ?? null, at, over.endedAt ?? null]);
  const run = (project: string, id: string, at: number | null, task: string | null, status = 'completed') =>
    sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES (?, ?, 'agent_1', ?, ?, ?)`, [project, id, task, status, at]);
  const spore = (project: string, id: string, at: number, status: string) =>
    sqlite.run(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) VALUES (?, ?, 'agent_1', 'gotcha', ?, ?, ?)`, [project, id, status, `body of ${id}`, at]);
  const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await worker.fetch(await asOwner(path), env);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const patch = async (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await worker.fetch(await asOwnerPatch(path, body), env);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { ...fixture, sqlite, env, get, patch, session, run, spore };
}

const ids = (body: Record<string, unknown>): string[] => (body.items as { type: string; id: string }[]).map((i) => `${i.type}:${i.id}`);

describe('the project home', () => {
  it('answers an empty feed and zero counts for a project that has captured nothing, and 404 for one the caller cannot see', async () => {
    const { get } = await harness();
    expect(await get('/api/projects/proj_1/activity')).toEqual({
      status: 200,
      body: { items: [], stats: { sessions: 0, openSessions: 0, sessionsLast7d: 0, prompts: 0, toolCalls: 0, plans: 0, attachments: 0, lastActivityAt: null } },
    });
    expect((await get('/api/projects/absent/activity')).status).toBe(404);
  });

  it('interleaves sessions, runs and active spores newest first, inside the project only', async () => {
    const { get, session, run, spore } = await harness();
    session('proj_1', 's_old', NOW + 1, { agent: 'claude-code', branch: 'main' });
    run('proj_1', 'r_mid', NOW + 2, null);
    spore('proj_1', 'sp_new', NOW + 3, 'active');
    spore('proj_1', 'sp_gone', NOW + 4, 'superseded');
    spore('proj_1', 'sp_dead', NOW + 5, 'obsolete');
    run('proj_1', 'r_pending', null, 'digest', 'pending');
    session('proj_2', 's_other', NOW + 9, { agent: 'other' });

    const { body } = await get('/api/projects/proj_1/activity');
    expect(ids(body)).toEqual(['spore:sp_new', 'run:r_mid', 'session:s_old']);
    const items = body.items as { type: string; summary: string; sessionId: string | null; at: number }[];
    expect(items.map((i) => [i.summary, i.sessionId])).toEqual([
      ['gotcha: body of sp_new', null], ['run — completed', null], ['claude-code', 's_old'],
    ]);
  });

  it('serves no more than the ceiling, and refuses a limit that is not a number', async () => {
    const { get, session } = await harness();
    for (let i = 0; i < MAX_FEED + 5; i += 1) session('proj_1', `s${i}`, NOW + i);
    expect(((await get('/api/projects/proj_1/activity?limit=1000')).body.items as unknown[]).length).toBe(MAX_FEED);
    expect(((await get('/api/projects/proj_1/activity?limit=3')).body.items as unknown[]).length).toBe(3);
    expect((await get('/api/projects/proj_1/activity?limit=three')).status).toBe(400);
  });

  it('counts sessions, open sessions and the week\'s sessions from the rows it holds', async () => {
    const { get, session } = await harness();
    session('proj_1', 's_open', NOW);
    session('proj_1', 's_done', NOW - 1, { endedAt: NOW });
    session('proj_2', 's_other', NOW);
    const stats = (await get('/api/projects/proj_1/activity')).body.stats as Record<string, unknown>;
    expect({ sessions: stats.sessions, open: stats.openSessions, last: stats.lastActivityAt }).toEqual({ sessions: 2, open: 1, last: NOW });
  });
});

describe('the session pages', () => {
  it('lists children for a session whose id needs escaping in the path', async () => {
    const { get, session, sqlite } = await harness();
    session('proj_1', 's one', NOW);
    sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                VALUES ('proj_1','s one','p1','e1','hello','user','h1',?,?,'tok_1',?)`, [NOW, NOW, NOW]);
    const { status, body } = await get('/api/projects/proj_1/sessions/s%20one/prompts');
    expect({ status, texts: (body.rows as { text: string }[]).map((r) => r.text) }).toEqual({ status: 200, texts: ['hello'] });
  });

  it('carries the member and runtime behind a session through the list and the detail', async () => {
    const { get, session, sqlite } = await harness();
    session('proj_1', 's1', NOW, { agent: 'claude-code', branch: 'main' });
    sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at) VALUES ('mem_a', 'chris', 1)`);
    sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, runtime_label, runtime_kind, issued_at, expires_at, lineage_root, lineage_started_at)
                VALUES ('tok_1', 'mem_a', 'h', 'm1', 'laptop', 'host', 1, 99, 'tok_1', 1)`);
    const list = (await get('/api/projects/proj_1/sessions')).body.rows as Record<string, unknown>[];
    const detail = (await get('/api/projects/proj_1/sessions/s1')).body.session as Record<string, unknown>;
    expect([list[0]!.memberLabel, list[0]!.runtimeLabel, detail.memberLabel, detail.runtimeKind]).toEqual(['chris', 'laptop', 'chris', 'host']);
  });
});

describe('a project\'s name', () => {
  it('is renamed by the owner, archived or not, under the creation grammar, and 404 names only an absent project', async () => {
    const { get, patch, sqlite } = await harness();
    expect(await patch('/api/projects/proj_1', { name: 'Myco' })).toEqual({ status: 200, body: { projectId: 'proj_1', name: 'Myco' } });
    const listed = (await get('/api/projects')).body.projects as { projectId: string; name: string }[];
    expect(listed.find((p) => p.projectId === 'proj_1')?.name).toBe('Myco');
    sqlite.run(`UPDATE projects SET archived_at = ?, archived_by = 'mem_x' WHERE project_id = 'proj_2'`, [NOW]);
    expect((await patch('/api/projects/proj_2', { name: 'Old' })).status).toBe(200);
    expect((await patch('/api/projects/proj_9', { name: 'Nobody' })).status).toBe(404);
    expect((await patch('/api/projects/proj_1', { name: '' })).status).toBe(400);
    expect((await patch('/api/projects/proj_1', { name: 'x'.repeat(201) })).status).toBe(400);
    expect((await patch('/api/projects/proj_1', { name: 7 })).status).toBe(400);
    expect((await patch('/api/projects/proj_1', 'nope')).status).toBe(400);
    expect(listed.find((p) => p.projectId === 'proj_1')?.name).toBe('Myco');
  });

  it('a session line in the feed carries the same label the session list shows', async () => {
    const { get, session, sqlite } = await harness();
    session('proj_1', 's_t', NOW + 1, { agent: 'claude-code' });
    session('proj_1', 's_p', NOW + 2, { agent: 'codex' });
    sqlite.run(`UPDATE sessions SET title = 'Titled by the model' WHERE session_id = 's_t'`);
    sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                VALUES ('proj_1','s_p','p1','e1','Fix the flaky test\nplease','user','h1',?,?,'tok_1',?)`, [NOW + 2, NOW + 2, NOW + 2]);
    const feed = (await get('/api/projects/proj_1/activity')).body.items as { id: string; summary: string }[];
    const rows = (await get('/api/projects/proj_1/sessions')).body.rows as { sessionId: string; label: string }[];
    const labels = Object.fromEntries(rows.map((r) => [r.sessionId, r.label]));
    expect(labels).toEqual({ s_t: 'Titled by the model', s_p: 'Fix the flaky test' });
    expect(feed.map((i) => [i.id, i.summary])).toEqual([['s_p', 'Fix the flaky test'], ['s_t', 'Titled by the model']]);
  });
});

