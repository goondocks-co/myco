/**
 * Full-text search across Projects (`GET /api/search`).
 *
 * Naming no Project covers every Project that accepts capture; naming some covers exactly those, and a name that is
 * not a Project answers 404, as a Project's own search does. Each result carries its Project. A member who is not an
 * admin reads it, and the answer is always full text.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { registerBlob } from './helpers/d1.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { MAX_NAMED_PROJECTS } from '@myco-server-worker/read/scope.js';
import { SEARCH_API_LIMIT, SEARCH_MAX_LIMIT } from '@myco-server-worker/read/search.js';
import { reconcileSearchIndex } from '@myco-server-worker/core/search-index.js';

const NOW = 1_700_000_000_000;
const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });

function harness() {
  const fixture = sqliteEnv();
  opened.push(fixture);
  const env = { ...fixture.env, ...OWNER_ENV };
  const { sqlite } = fixture;
  sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_3', 'c', 0)`);
  sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, ?)`, [NOW]);
  const archive = (project: string) => sqlite.run(`UPDATE projects SET archived_at = ?, archived_by = 'mem_machine_1' WHERE project_id = ?`, [NOW, project]);
  const session = (project: string, id: string, title: string) =>
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, started_at, title)
                VALUES (?, ?, 'm1', 'tok_1', ?, ?, ?, ?)`, [project, id, NOW, NOW, NOW, title]);
  const spore = (project: string, id: string, content: string, at = NOW) =>
    sqlite.run(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) VALUES (?, ?, 'agent_1', 'gotcha', 'active', ?, ?)`, [project, id, content, at]);
  const prompt = (project: string, id: string, text: string | null, blobKey: string | null = null) =>
    sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, token_id, received_at, created_at, updated_at, content_hash, origin, text, blob_key)
                VALUES (?, 's', ?, ?, 't', ?, ?, ?, 'h', 'user', ?, ?)`, [project, id, `ev_${id}`, NOW, NOW, NOW, text, blobKey]);
  const blob = async (project: string, key: string, text: string) => {
    const bytes = new TextEncoder().encode(text);
    await fixture.bucket.put(registerBlob(sqlite, { projectId: project, key, size: bytes.length, tokenId: 't', receivedAt: 1000 }), new Response(bytes).body);
  };
  const get = async (path: string, sub?: string) => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), env);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const hits = async (path: string) => {
    const { status, body } = await get(path);
    expect({ path, status }).toEqual({ path, status: 200 });
    return (body.results as Array<{ projectId: string; id: string; type: string }>).map((r) => `${r.projectId}/${r.type}/${r.id}`).sort();
  };
  return { fixture, sqlite, archive, session, spore, prompt, blob, get, hits };
}

describe('search across Projects', () => {
  it('covers every Project that accepts capture when none is named, each result with its Project', async () => {
    const h = harness();
    h.spore('proj_1', 'sp_a', 'cobalt in one');
    h.spore('proj_2', 'sp_b', 'cobalt in two');
    h.spore('proj_3', 'sp_c', 'cobalt archived');
    h.session('proj_2', 's_b', 'cobalt session');
    h.archive('proj_3');
    expect(await h.hits('/api/search?q=cobalt')).toEqual(['proj_1/spore/sp_a', 'proj_2/session/s_b', 'proj_2/spore/sp_b']);
    const { body } = await h.get('/api/search?q=cobalt');
    expect(body).toMatchObject({ mode: 'fts', provider_unavailable: false, coverage: { pending_blobs: 0 } });
    expect(body.results.find((r: any) => r.id === 'sp_b')).toMatchObject({ projectId: 'proj_2', type: 'spore', retrieve: { tool: 'myco_spores', input: { op: 'get', id: 'sp_b' } } });
  });

  it('covers exactly the Projects named, archived or not, and answers 404 for a name that is not a Project', async () => {
    const h = harness();
    h.spore('proj_1', 'sp_a', 'cobalt in one');
    h.spore('proj_2', 'sp_b', 'cobalt in two');
    h.spore('proj_3', 'sp_c', 'cobalt archived');
    h.archive('proj_3');
    expect(await h.hits('/api/search?q=cobalt&project=proj_1&project=proj_3')).toEqual(['proj_1/spore/sp_a', 'proj_3/spore/sp_c']);
    expect(await h.hits('/api/search?q=cobalt&project=proj_2')).toEqual(['proj_2/spore/sp_b']);
    expect((await h.get('/api/search?q=cobalt&project=proj_1&project=absent')).status).toBe(404);
  });

  it('takes exactly as many Projects as a read may name, and refuses one more', async () => {
    const h = harness();
    const names = Array.from({ length: MAX_NAMED_PROJECTS + 1 }, (_, i) => `proj_n${i}`);
    for (const name of names) h.sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, 0)`, [name, name]);
    h.spore(names[0]!, 'sp_first', 'cobalt first');
    h.spore(names[MAX_NAMED_PROJECTS - 1]!, 'sp_last', 'cobalt last');
    h.spore(names[MAX_NAMED_PROJECTS]!, 'sp_beyond', 'cobalt beyond');
    const query = (count: number) => names.slice(0, count).map((n) => `project=${n}`).join('&');
    expect(await h.hits(`/api/search?q=cobalt&${query(MAX_NAMED_PROJECTS)}`)).toEqual([`${names[0]}/spore/sp_first`, `${names[MAX_NAMED_PROJECTS - 1]}/spore/sp_last`]);
    expect((await h.get(`/api/search?q=cobalt&${query(MAX_NAMED_PROJECTS + 1)}`)).status).toBe(400);
  });

  it('keeps the Project of each result apart when two Projects hold the same id', async () => {
    const h = harness();
    h.session('proj_1', 's', 'cobalt one');
    h.session('proj_2', 's', 'cobalt two');
    h.sqlite.run(`INSERT INTO knowledge_release_state (project_id, id, identity_key, namespace, record_id, state, confidence, checked_at, created_at)
                  VALUES ('proj_2', 'rs_1', 'k', 'sessions', 's', 'released', 'high', ?, ?)`, [NOW, NOW]);
    const { body } = await h.get('/api/search?q=cobalt&type=session');
    const byProject = Object.fromEntries(body.results.map((r: any) => [r.projectId, r]));
    expect(Object.keys(byProject).sort()).toEqual(['proj_1', 'proj_2']);
    expect(byProject.proj_2.release).toMatchObject({ state: 'released', confidence: 'high' });
    expect(byProject.proj_1.release).toBeUndefined();
  });

  it('ranks by the full-text rank across Projects, not by Project', async () => {
    const h = harness();
    h.spore('proj_1', 'sp_weak', `cobalt ${'filler '.repeat(60)}`);
    h.spore('proj_2', 'sp_strong', 'cobalt cobalt cobalt');
    const { body } = await h.get('/api/search?q=cobalt&type=spore');
    expect(body.results.map((r: any) => [r.projectId, r.id])).toEqual([['proj_2', 'sp_strong'], ['proj_1', 'sp_weak']]);
    expect(body.results[0].score).toBe(1);
    expect(body.results[1].score).toBeLessThan(1);
  });

  it('answers the same number of results a Project\'s search does, and refuses a limit past its most', async () => {
    const h = harness();
    for (let i = 0; i < SEARCH_API_LIMIT + 5; i += 1) h.spore(i % 2 === 0 ? 'proj_1' : 'proj_2', `sp_${i}`, `cobalt ${i}`);
    expect((await h.get('/api/search?q=cobalt')).body.results).toHaveLength(SEARCH_API_LIMIT);
    expect((await h.get('/api/search?q=cobalt&limit=3')).body.results).toHaveLength(3);
    expect((await h.get(`/api/search?q=cobalt&limit=${SEARCH_MAX_LIMIT + 1}`)).status).toBe(400);
    expect((await h.get('/api/search?q=')).status).toBe(400);
  });

  it('is full text only: semantic mode is refused, auto answers full text', async () => {
    const h = harness();
    h.spore('proj_1', 'sp_a', 'cobalt');
    const refused = await h.get('/api/search?q=cobalt&mode=semantic');
    expect(refused).toEqual({ status: 400, body: { error: 'bad_request', reason: expect.stringContaining('semantic search reads one project') } });
    expect((await h.get('/api/search?q=cobalt&mode=auto')).body).toMatchObject({ mode: 'fts', provider_unavailable: false });
    expect((await h.get('/api/search?q=cobalt&mode=fts')).body.results).toHaveLength(1);
  });

  it('matches spilled bodies only inside the Projects searched, and counts their backlog alone', async () => {
    const h = harness();
    await h.blob('proj_2', 'body-2', 'deepneedle in two');
    await h.blob('proj_3', 'body-3', 'deepneedle archived');
    h.prompt('proj_2', 'pr_2', null, 'body-2');
    h.prompt('proj_3', 'pr_3', null, 'body-3');
    h.archive('proj_3');
    expect((await h.get('/api/search?q=deepneedle')).body.coverage.pending_blobs).toBe(1);
    expect((await h.get('/api/search?q=deepneedle&project=proj_1')).body.coverage.pending_blobs).toBe(0);
    // One body per pass.
    while (await reconcileSearchIndex(h.fixture.db, h.fixture.bucket, 1000) > 0);
    expect(await h.hits('/api/search?q=deepneedle')).toEqual(['proj_2/prompt/pr_2']);
    expect(await h.hits('/api/search?q=deepneedle&project=proj_1')).toEqual([]);
    expect(await h.hits('/api/search?q=deepneedle&project=proj_3')).toEqual(['proj_3/prompt/pr_3']);
    expect((await h.get('/api/search?q=deepneedle')).body.coverage.pending_blobs).toBe(0);
  });

  it('is read by a member who is not an admin', async () => {
    const h = harness();
    seedMemberRoleAccount(h.sqlite);
    h.spore('proj_1', 'sp_a', 'cobalt');
    const { status, body } = await h.get('/api/search?q=cobalt', MEMBER_SUB);
    expect(status).toBe(200);
    expect(body.results.map((r: any) => r.id)).toEqual(['sp_a']);
  });
});
