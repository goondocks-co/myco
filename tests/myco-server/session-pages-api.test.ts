/**
 * The project home and the session pages through the product surface.
 *
 * A project that has captured nothing answers an empty feed and zero counts,
 * and 404 names only a project this caller may not see. The feed is one page
 * across sessions, runs and spores, newest first, and never another project's.
 */
import { describe, expect, it } from 'bun:test';
import { envelope, memberPost, sqliteEnv, uuid } from './helpers/fixtures.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { reportSessionArtifact } from '@myco-server-worker/core/session-artifacts.js';
import { asOwner, asOwnerPatch, OWNER_ENV } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { MAX_FEED } from '@myco-server-worker/read/activity.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';

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
    expect((await get('/api/projects/proj_1/sessions/s1/attachments?status=bogus&q=x')).status).toBe(200);
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
    sqlite.run(`INSERT INTO session_documents (project_id, session_id, state, generation, first_prompt, updated_at)
                VALUES ('proj_1','s_p','live',1,'Fix the flaky test',?)`, [NOW + 2]);
    const feed = (await get('/api/projects/proj_1/activity')).body.items as { id: string; summary: string }[];
    const rows = (await get('/api/projects/proj_1/sessions')).body.rows as { sessionId: string; label: string }[];
    const labels = Object.fromEntries(rows.map((r) => [r.sessionId, r.label]));
    expect(labels).toEqual({ s_t: 'Titled by the model', s_p: 'Fix the flaky test' });
    expect(feed.map((i) => [i.id, i.summary])).toEqual([['s_p', 'Fix the flaky test'], ['s_t', 'Titled by the model']]);
  });
});


describe('a session\'s lineage', () => {
  async function family() {
    const h = await harness();
    /** A session of `project` started at `NOW + at`, with its parents as its records name them. */
    const add = (project: string, id: string, at: number, over: { launch?: string; continues?: string; reason?: string; title?: string; endedAt?: number } = {}) => {
      h.session(project, id, NOW + at, { agent: 'claude-code', endedAt: over.endedAt });
      h.sqlite.run(`UPDATE sessions SET launch_parent_session_id = ?, parent_session_id = ?, parent_reason = ?, title = ? WHERE project_id = ? AND session_id = ?`,
        [over.launch ?? null, over.continues ?? null, over.reason ?? null, over.title ?? `Session ${id}`, project, id]);
    };
    const lineage = async (id: string, project = 'proj_1') => {
      const { status, body } = await h.get(`/api/projects/${project}/sessions/${encodeURIComponent(id)}/lineage`);
      expect(status).toBe(200);
      return body as unknown as { nodes: Array<{ sessionId: string; captured: boolean; label: string | null; depth: number; current: boolean; startedAt: number | null; endedAt: number | null; placedUnder: { parentId: string; kind: string } | null }>; edges: Array<{ parentId: string; childId: string; kind: string; reason: string | null }>; truncated: boolean };
    };
    const tree = (body: Awaited<ReturnType<typeof lineage>>) => body.nodes.map((n) => `${'  '.repeat(n.depth)}${n.sessionId}${n.current ? '*' : ''}${n.placedUnder ? ` <${n.placedUnder.kind}` : ''}`);
    return { ...h, add, lineage, tree };
  }

  it('reads three generations over both parent columns, places each session once, and keeps each edge\'s kind and times', async () => {
    const { add, lineage, tree } = await family();
    add('proj_1', 'root', 0, { endedAt: NOW + 100 });
    add('proj_1', 'worker', 10, { launch: 'root', endedAt: NOW + 50 });
    add('proj_1', 'reviewer', 20, { launch: 'root' });
    add('proj_1', 'fixer', 30, { launch: 'worker' });
    add('proj_1', 'worker-2', 51, { launch: 'root', continues: 'worker', reason: 'compact continuation' });
    add('proj_1', 'unrelated', 5);
    const body = await lineage('worker');
    expect(tree(body)).toEqual(['root', '  worker* <launched', '    fixer <launched', '  reviewer <launched', '  worker-2 <launched']);
    expect(body.edges).toContainEqual({ parentId: 'worker', childId: 'worker-2', kind: 'continuation', reason: 'compact continuation' });
    expect(body.edges).toHaveLength(5);
    expect(body.nodes[0]).toMatchObject({ label: 'Session root', startedAt: NOW, endedAt: NOW + 100, captured: true });
    expect(body.truncated).toBe(false);
    expect(tree(await lineage('fixer'))).toEqual(tree(body).map((line) => line.replace('*', '')).map((line) => line.trimStart() === 'fixer <launched' ? line.replace('fixer', 'fixer*') : line));
  });

  it('shows a parent this Project does not hold as a node that is not captured, and never reads another Project\'s sessions', async () => {
    const { add, lineage, tree } = await family();
    add('proj_2', 'orchestrator', 0);
    add('proj_2', 'stranger', 2, { launch: 'child' });
    add('proj_1', 'child', 1, { launch: 'orchestrator' });
    add('proj_1', 'sibling', 3, { launch: 'orchestrator' });
    const body = await lineage('child');
    expect(tree(body)).toEqual(['orchestrator', '  child* <launched', '  sibling <launched']);
    expect(body.nodes[0]).toMatchObject({ captured: false, label: null, startedAt: null, endedAt: null });
    expect(JSON.stringify(body)).not.toContain('stranger');
    expect(tree(await lineage('orchestrator', 'proj_2'))).toEqual(['orchestrator*']);
  });

  it('places a child that names one parent through both columns once, with its descendants and the session read', async () => {
    const { add, lineage, tree } = await family();
    add('proj_1', 'R', 0);
    add('proj_1', 'C', 1, { launch: 'R', continues: 'R', reason: 'fork' });
    add('proj_1', 'G', 2, { launch: 'C' });
    const fromLeaf = await lineage('G');
    expect([tree(fromLeaf), fromLeaf.truncated]).toEqual([['R', '  C <launched', '    G* <launched'], false]);
    expect(fromLeaf.edges.filter((edge) => edge.childId === 'C').map((edge) => edge.kind).sort()).toEqual(['continuation', 'launched']);
    expect(tree(await lineage('C'))).toEqual(['R', '  C* <launched', '    G <launched']);
  });

  it('names a related session with no title, prompt or agent in words, never by an id fragment', async () => {
    const { add, lineage, sqlite, get } = await family();
    add('proj_1', 'parent', 0);
    add('proj_1', 'abcdef12-unnamed', 1, { launch: 'parent' });
    sqlite.run(`UPDATE sessions SET title = NULL, agent = NULL WHERE session_id = 'abcdef12-unnamed'`);
    expect((await lineage('parent')).nodes.map((node) => node.label)).toEqual(['Session parent', 'Untitled session']);
    const { body } = await get('/api/projects/proj_1/sessions/parent/activity');
    expect((body.rows as Array<{ title: string; sessionId: string }>).map((row) => [row.title, row.sessionId])).toEqual([['Untitled session', 'abcdef12-unnamed']]);
    expect(JSON.stringify((await lineage('parent')).nodes.map((node) => node.label))).not.toContain('abcdef12');
  });

  it('ends at a cycle in the records with each session once', async () => {
    const { add, lineage, tree } = await family();
    add('proj_1', 'a', 0, { launch: 'b' });
    add('proj_1', 'b', 1, { continues: 'a' });
    add('proj_1', 'self', 2, { launch: 'self' });
    const cycle = await lineage('a');
    expect([tree(cycle), cycle.truncated]).toEqual([['a*', '  b <continuation'], false]);
    expect(tree(await lineage('self'))).toEqual(['self*']);
  });

  it('stops at the depth and size bounds and says so', async () => {
    const { add, lineage } = await family();
    for (let i = 0; i <= 10; i++) add('proj_1', `g${i}`, i, i === 0 ? {} : { launch: `g${i - 1}` });
    const deep = await lineage('g10');
    expect(deep.truncated).toBe(true);
    expect(deep.nodes[0]?.sessionId).toBe('g2');
    expect(deep.nodes.map((n) => n.sessionId)).toEqual(['g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10']);
    const fromRoot = await lineage('g5');
    expect([fromRoot.nodes[0]?.sessionId, fromRoot.nodes.at(-1)?.sessionId, fromRoot.truncated]).toEqual(['g0', 'g8', true]);
    add('proj_1', 'hub', 100);
    for (let i = 0; i < 205; i++) add('proj_1', `spoke-${String(i).padStart(3, '0')}`, 101 + i, { launch: 'hub' });
    const wide = await lineage('spoke-204');
    expect(wide.truncated).toBe(true);
    expect(wide.nodes).toHaveLength(200);
    expect(wide.nodes.filter((n) => n.current).map((n) => n.sessionId)).toEqual(['spoke-204']);
  });

  it('clears a deleted session\'s own parents when it is deleted, while a surviving child keeps naming it', async () => {
    const { add, lineage, tree, sqlite, db } = await family();
    add('proj_1', 'grandparent', 0);
    add('proj_1', 'middle', 1, { launch: 'grandparent', continues: 'grandparent', reason: 'fork' });
    add('proj_1', 'child', 2, { launch: 'middle' });
    expect((await tombstoneSession({ db }, { projectId: 'proj_1' }, 'middle', 'owner', NOW)).applied).toBe(true);
    const parents = (id: string) => sqlite.query('SELECT parent_session_id, parent_reason, launch_parent_session_id FROM sessions WHERE project_id = ? AND session_id = ?').get('proj_1', id);
    expect(parents('middle')).toEqual({ parent_session_id: null, parent_reason: null, launch_parent_session_id: null });
    expect(parents('child')).toEqual({ parent_session_id: null, parent_reason: null, launch_parent_session_id: 'middle' });
    const read = await lineage('child');
    expect(tree(read)).toEqual(['middle', '  child* <launched']);
    expect(read.nodes[0]).toMatchObject({ captured: false, label: null });
    expect(tree(await lineage('grandparent'))).toEqual(['grandparent*']);
  });

  it('leaves out a deleted session and answers 404 for a session the Project does not hold', async () => {
    const { add, lineage, tree, sqlite, get } = await family();
    add('proj_1', 'parent', 0);
    add('proj_1', 'kept', 1, { launch: 'parent' });
    add('proj_1', 'deleted', 2, { launch: 'parent' });
    sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, created_at, created_by) VALUES ('proj_1', 'deleted', ?, 'owner')`, [NOW]);
    expect(tree(await lineage('parent'))).toEqual(['parent*', '  kept <launched']);
    expect((await get('/api/projects/proj_1/sessions/absent/lineage')).status).toBe(404);
    expect((await get('/api/projects/proj_2/sessions/parent/lineage')).status).toBe(404);
  });

  it('lists children and continuations as agent activity at the related session\'s start', async () => {
    const { add, get, sqlite } = await family();
    add('proj_1', 'parent', 0);
    add('proj_1', 'here', 10, { continues: 'parent', reason: 'fork' });
    add('proj_1', 'launched', 20, { launch: 'here' });
    add('proj_1', 'next', 30, { continues: 'here', reason: 'compact continuation' });
    add('proj_2', 'foreign', 25, { launch: 'here' });
    const base = '/api/projects/proj_1/sessions/here/activity';
    const rows = (body: Record<string, unknown>) => (body.rows as Array<Record<string, unknown>>).map((r) => [r.type, r.title, r.detail, r.sessionId]);
    expect(rows((await get(base)).body)).toEqual([
      ['continuation', 'Session next', 'Continues this session’s conversation · compact continuation', 'next'],
      ['child_session', 'Session launched', 'Child of this session', 'launched'],
      ['continuation', 'Session parent', 'This session continues its conversation · fork', 'parent'],
    ]);
    expect(rows((await get(`${base}?type=child_session`)).body)).toEqual([['child_session', 'Session launched', 'Child of this session', 'launched']]);
    expect(rows((await get(`${base}?failed=false`)).body).map((r) => r[0])).toEqual(['continuation', 'child_session', 'continuation']);
    sqlite.run(`DELETE FROM sessions WHERE project_id = 'proj_1' AND session_id = 'parent'`);
    expect(rows((await get(`${base}?type=continuation`)).body).at(-1)).toEqual(['continuation', 'A session not captured here', 'This session continues its conversation · fork', null]);
  });
});

describe('a session\'s reported artifacts', () => {
  it('serves only the addressed Project\'s reports for a session id two Projects share, and 404 for a session the Project does not hold', async () => {
    const h = await harness();
    const { token } = await issueMemberToken(h.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    let event = 1;
    for (const [project, sessionId] of [['proj_1', 's_shared'], ['proj_2', 's_shared'], ['proj_2', 's_only_2']]) {
      const res = await worker.fetch(memberPost(token, envelope({ eventId: uuid(event++), sessionId, kind: 'session.start', payload: { agent: 'codex', startedAt: 1_000 } }), '/events', { [PROJECT_HEADER]: project }), h.env);
      expect(res.status).toBe(200);
    }
    const report = (projectId: string, sessionId: string, artifactId: string) => reportSessionArtifact(h.db, { projectId }, {
      sessionId, kind: 'issue', artifactId, url: `https://github.com/o/r/issues/${artifactId}`, author: 'mem_machine_1', reportedAt: NOW,
    });
    expect((await report('proj_1', 's_shared', '1')).outcome).toBe('created');
    expect((await report('proj_2', 's_shared', '2')).outcome).toBe('created');
    expect((await report('proj_2', 's_only_2', '3')).outcome).toBe('created');

    const page = await h.get('/api/projects/proj_1/sessions/s_shared/artifacts');
    expect({ status: page.status, ids: (page.body.rows as Array<{ artifactId: string }>).map((row) => row.artifactId), cursor: page.body.cursor })
      .toEqual({ status: 200, ids: ['1'], cursor: null });
    expect((await h.get('/api/projects/proj_1/sessions/s_only_2/artifacts')).status).toBe(404);
  });
});
