/**
 * The project home and the session pages through the product surface.
 *
 * A project that has captured nothing answers an empty feed and zero counts,
 * and 404 names only a project this caller may not see. The feed is one page
 * across sessions, runs and spores, newest first, and never another project's.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { registerBlob } from './helpers/d1.js';
import { reconcileSearchIndex } from '@myco-server-worker/core/search-index.js';
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
    const res = await worker.fetch(await asOwner(fixture.db, path), env);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const patch = async (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await worker.fetch(await asOwnerPatch(fixture.db, path, body), env);
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

  it('carries the member behind a session through the list and the detail, and names the machine only to the member it belongs to', async () => {
    const { get, session, sqlite } = await harness();
    session('proj_1', 's1', NOW, { agent: 'claude-code', branch: 'main' });
    sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at) VALUES ('mem_a', 'chris', 1)`);
    sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at, label) VALUES ('m1', 'mem_a', 1, 'chris-laptop'), ('m_own', 'mem_machine_1', 1, 'studio')`);
    sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, runtime_label, runtime_kind, issued_at, expires_at, lineage_root, lineage_started_at)
                VALUES ('tok_1', 'mem_a', 'h', 'm1', 'laptop', 'host', 1, 99, 'tok_1', 1), ('tok_own', 'mem_machine_1', 'h2', 'm_own', 'studio-host', 'host', 1, ?, 'tok_own', 1)`, [NOW * 2]);
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, started_at) VALUES ('proj_1', 's_own', 'm_own', 'tok_own', ?, ?, ?)`, [NOW - 1, NOW - 1, NOW - 1]);
    const list = (await get('/api/projects/proj_1/sessions')).body.rows as Record<string, unknown>[];
    const across = (await get('/api/sessions')).body.rows as Record<string, unknown>[];
    const detail = (await get('/api/projects/proj_1/sessions/s1')).body.session as Record<string, unknown>;
    const own = (await get('/api/projects/proj_1/sessions/s_own')).body.session as Record<string, unknown>;
    // Another member's session names that member, and never the machine it came from.
    for (const row of [list.find((r) => r.sessionId === 's1')!, across.find((r) => r.sessionId === 's1')!, detail]) {
      expect([row.memberLabel, row.runtimeLabel, row.runtimeKind]).toEqual(['chris', null, 'host']);
    }
    // The viewer's own session names the machine by the name it holds.
    for (const row of [list.find((r) => r.sessionId === 's_own')!, across.find((r) => r.sessionId === 's_own')!, own]) expect(row.runtimeLabel).toBe('studio');
    for (const body of [list, across, detail, own]) expect(JSON.stringify(body)).not.toMatch(/chris-laptop|"laptop"/);
  });
});

describe('a session\'s plans', () => {
  async function plans() {
    const h = await harness();
    h.session('proj_1', 's1', NOW);
    h.session('proj_1', 's2', NOW);
    const plan = (session: string, key: string, title: string, status: string, at: number, project = 'proj_1') =>
      h.sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, content_hash, status, created_at, updated_at, token_id, received_at)
                    VALUES (?, ?, ?, ?, 'm1', ?, 'body', ?, ?, ?, ?, 'tok_1', ?)`, [project, key, session, `e_${key}`, title, `h_${key}`, status, at, at, at]);
    return { ...h, plan };
  }
  const keys = (body: Record<string, unknown>) => (body.rows as { planKey: string }[]).map((r) => r.planKey);

  it('narrows to one status and a text in the title, inside the session only', async () => {
    const { get, plan } = await plans();
    plan('s1', 'k_done_match', 'Ship the search box', 'completed', NOW + 1);
    plan('s1', 'k_open_match', 'Search the plans', 'active', NOW + 2);
    plan('s1', 'k_done_other', 'Tidy the docs', 'completed', NOW + 3);
    plan('s2', 'k_elsewhere', 'Search elsewhere', 'completed', NOW + 4);
    plan('s1', 'k_other_project', 'Search in another project', 'completed', NOW + 5, 'proj_2');
    const base = '/api/projects/proj_1/sessions/s1/plans';
    expect(keys((await get(base)).body)).toEqual(['k_done_match', 'k_open_match', 'k_done_other']);
    expect(keys((await get(`${base}?status=completed`)).body)).toEqual(['k_done_match', 'k_done_other']);
    expect(keys((await get(`${base}?q=SEARCH`)).body)).toEqual(['k_done_match', 'k_open_match']);
    expect(keys((await get(`${base}?status=completed&q=search`)).body)).toEqual(['k_done_match']);
    // The body is not searched here, and `%` is matched as text.
    expect(keys((await get(`${base}?q=body`)).body)).toEqual([]);
    expect(keys((await get(`${base}?q=${encodeURIComponent('%')}`)).body)).toEqual([]);
  });

  it('finds a match beyond the first page, and pages the filtered set by its cursor', async () => {
    const { get, plan } = await plans();
    for (let i = 0; i < 5; i += 1) plan('s1', `k_noise_${i}`, `Noise ${i}`, 'active', NOW + i);
    plan('s1', 'k_late_a', 'Late match one', 'abandoned', NOW + 10);
    plan('s1', 'k_late_b', 'Late match two', 'abandoned', NOW + 11);
    const base = '/api/projects/proj_1/sessions/s1/plans';
    expect(keys((await get(`${base}?limit=2`)).body)).toEqual(['k_noise_0', 'k_noise_1']);
    const first = (await get(`${base}?limit=1&q=late`)).body;
    expect(keys(first)).toEqual(['k_late_a']);
    const second = (await get(`${base}?limit=1&q=late&cursor=${encodeURIComponent(first.cursor as string)}`)).body;
    expect([keys(second), second.cursor]).toEqual([['k_late_b'], null]);
    expect(keys((await get(`${base}?limit=1&status=abandoned`)).body)).toEqual(['k_late_a']);
  });

  it('refuses a status the catalogue does not hold, and the other children ignore the plan filters', async () => {
    const { get, plan } = await plans();
    plan('s1', 'k1', 'One', 'active', NOW);
    for (const status of ['all', 'done', '']) {
      expect((await get(`/api/projects/proj_1/sessions/s1/plans?status=${status}`)).status).toBe(400);
    }
    expect((await get('/api/projects/proj_1/sessions/s1/prompts?status=bogus&q=x')).status).toBe(200);
  });
});

describe('a project\'s name', () => {
  it('is renamed by the owner, archived or not, under the creation grammar, and 404 names only an absent project', async () => {
    const { get, patch, sqlite } = await harness();
    expect(await patch('/api/projects/proj_1', { name: '  Myco  ' })).toEqual({ status: 200, body: { projectId: 'proj_1', name: 'Myco' } });
    expect((await patch('/api/projects/proj_1', { name: '   ' })).status).toBe(400);
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


describe('searching a session\'s conversation', () => {
  const TURN_PAGE = 200;

  async function conversation() {
    const h = await harness();
    h.session('proj_1', 's1', NOW);
    h.session('proj_1', 's2', NOW);
    const prompt = (session: string, id: string, at: number, text: string | null, blobKey: string | null = null) =>
      h.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, blob_key, origin, content_hash, created_at, updated_at, token_id, received_at)
                    VALUES ('proj_1', ?, ?, ?, ?, ?, 'user', ?, ?, ?, 'tok_1', ?)`, [session, id, `e_${id}`, text, blobKey, `h_${id}`, at, at, at]);
    const reply = (session: string, id: string, promptId: string | null, at: number, text: string) =>
      h.sqlite.run(`INSERT INTO responses (project_id, response_id, session_id, prompt_id, event_id, text, content_hash, created_at, token_id, received_at)
                    VALUES ('proj_1', ?, ?, ?, ?, ?, ?, ?, 'tok_1', ?)`, [id, session, promptId, `e_${id}`, text, `h_${id}`, at, at]);
    // The route's own query, exactly as the dashboard's conversation search sends it.
    const search = async (type: string, session = 's1') => {
      const { status, body } = await h.get(`/api/projects/proj_1/search?${new URLSearchParams({ q: 'zirconium', type, limit: '20', session_id: session, mode: 'fts' })}`);
      expect(status).toBe(200);
      return (body.results as { id: string; type: string; session_id: string; prompt_id?: string; preview: string }[]);
    };
    return { ...h, prompt, reply, search };
  }

  it('returns this session\'s prompt and reply hits only, including a prompt beyond the first page of turns and a hit inside a stored body', async () => {
    const { get, prompt, reply, search, sqlite, bucket, db } = await conversation();
    prompt('s1', 'p_oldest', NOW, 'zirconium opening request');
    for (let i = 1; i <= TURN_PAGE + 5; i += 1) prompt('s1', `p_${String(i).padStart(4, '0')}`, NOW + i, `filler ${i}`);
    reply('s1', 'r_answer', 'p_0007', NOW + 7, 'the zirconium answer');
    reply('s1', 'r_orphan', null, NOW + 8, 'a zirconium note with no prompt');
    prompt('s2', 'p_other', NOW, 'zirconium in another session');
    reply('s2', 'r_other', 'p_other', NOW + 1, 'zirconium elsewhere');
    const text = `${'padding '.repeat(10_000)} zirconium deepbody`;
    const objectKey = registerBlob(sqlite, { projectId: 'proj_1', key: 'long-prompt', size: text.length, tokenId: 'tok_1', receivedAt: NOW });
    await bucket.put(objectKey, new Response(text).body);
    prompt('s1', 'p_long', NOW + 9, null, 'long-prompt');
    await reconcileSearchIndex(db, bucket, NOW);

    // The oldest prompt is not on the first page of turns, so only the search reaches it.
    const firstPage = (await get('/api/projects/proj_1/sessions/s1/turns?origins=user&limit=200&order=desc')).body as { rows: { promptId: string }[]; cursor: string | null };
    expect(firstPage.rows).toHaveLength(TURN_PAGE);
    expect(firstPage.cursor).not.toBeNull();
    expect(firstPage.rows.map((row) => row.promptId)).not.toContain('p_oldest');

    const prompts = await search('prompt');
    expect(prompts.map((hit) => hit.id).sort()).toEqual(['p_long', 'p_oldest']);
    expect(prompts.every((hit) => hit.type === 'prompt' && hit.session_id === 's1' && hit.prompt_id === hit.id)).toBe(true);
    // The stored body has no inline text; its hit is found through the body's chunks.
    expect(prompts.find((hit) => hit.id === 'p_long')!.preview.length).toBeGreaterThan(0);
    const replies = await search('response');
    expect(replies.map((hit) => [hit.id, hit.session_id, hit.prompt_id ?? null]).sort()).toEqual([['r_answer', 's1', 'p_0007'], ['r_orphan', 's1', null]]);

    // The named lookup the hit opens reads the turn directly, past the first page.
    const lookup = (await get('/api/projects/proj_1/sessions/s1/turns?origins=user,system,agent_dispatch,hook_injected,unknown&turn=p_oldest')).body as { rows: { promptId: string }[] };
    expect(lookup.rows.map((row) => row.promptId)).toEqual(['p_oldest']);

    // Without the session filter the other session's hits are found, so the filter is what keeps them out.
    const { body } = await get(`/api/projects/proj_1/search?${new URLSearchParams({ q: 'zirconium', type: 'prompt', limit: '20', mode: 'fts' })}`);
    expect((body.results as { id: string }[]).map((hit) => hit.id)).toContain('p_other');
    // The other session searched for its own gets only its own.
    expect((await search('prompt', 's2')).map((hit) => hit.id)).toEqual(['p_other']);
  });

  it('answers a prompt that the session does not hold with no turn, so a hit on it leads nowhere', async () => {
    const { get, prompt, reply, search } = await conversation();
    prompt('s2', 'p_other', NOW, 'a prompt kept elsewhere');
    reply('s1', 'r_stray', 'p_other', NOW + 1, 'a zirconium reply to a prompt of another session');
    expect((await search('response')).map((hit) => [hit.id, hit.prompt_id])).toEqual([['r_stray', 'p_other']]);
    const lookup = (await get('/api/projects/proj_1/sessions/s1/turns?origins=user,system,agent_dispatch,hook_injected,unknown&turn=p_other')).body as { rows: unknown[] };
    expect(lookup.rows).toEqual([]);
  });
});
