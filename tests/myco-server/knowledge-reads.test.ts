/**
 * The Knowledge page's reads (#1535): one plan by its key, the plan board's totals and text filter, who wrote a spore,
 * the spore stream's facets under every filter, the stream's text matching the line a reader sees, and search leading
 * a spore with that same line.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';

const NOW = 1_700_000_000_000;
const key = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const { sqlite } = fixture;
  seedMemberRoleAccount(sqlite);
  sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, 0), ('user', 'user', 'built-in', 1, 0)`);
  const plan = (project: string, planKey: string, at: number, status: string, title: string, content: string | null = '- [ ] a') =>
    sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, content_hash, status, title, content, created_at, updated_at, token_id, received_at)
                VALUES (?, ?, 's', ?, 'm1', 'h', ?, ?, ?, ?, ?, 'tok_1', ?)`, [project, planKey, `ev_${project}_${planKey}`, status, title, content, at, at, at]);
  const tag = (project: string, planKey: string, t: string) => sqlite.run(`INSERT INTO tags (project_id, entity_kind, entity_id, tag) VALUES (?, 'plan', ?, ?)`, [project, planKey, t]);
  const spore = (project: string, id: string, opts: { author?: string | null; agentId?: string; status?: string; type?: string; content?: string; line?: string | null; at?: number } = {}) =>
    sqlite.run(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, author, agent_line, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [project, id, opts.agentId ?? 'agent_1', opts.type ?? 'gotcha', opts.status ?? 'active', opts.content ?? `body of ${id}`, opts.author ?? null, opts.line ?? null, opts.at ?? NOW]);
  const get = async (path: string, sub?: string) => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), env);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { sqlite, plan, tag, spore, get };
}

describe('one plan by its key', () => {
  it('answers the plan with its tags, and 404 for a key the Project does not hold', async () => {
    const h = harness();
    h.plan('proj_1', key(1), NOW, 'active', 'Ship the board');
    h.tag('proj_1', key(1), 'ui');
    h.tag('proj_1', key(1), 'p4');
    h.plan('proj_2', key(2), NOW, 'active', 'Elsewhere');
    const { status, body } = await h.get(`/api/projects/proj_1/plans/${key(1)}`, MEMBER_SUB);
    expect(status).toBe(200);
    expect(body).toMatchObject({ projectId: 'proj_1', plan: { planKey: key(1), title: 'Ship the board', tags: ['p4', 'ui'] } });
    expect((await h.get(`/api/projects/proj_1/plans/${key(2)}`)).status).toBe(404);
    expect((await h.get(`/api/projects/proj_1/plans/${key(3)}`)).status).toBe(404);
    expect((await h.get(`/api/projects/proj_missing/plans/${key(1)}`)).status).toBe(404);
  });
});

describe('the plan board across Projects', () => {
  it('counts each status under the other filters on the first page, and not on a later one', async () => {
    const h = harness();
    h.plan('proj_1', key(1), NOW + 1, 'active', 'alpha one');
    h.plan('proj_1', key(2), NOW + 2, 'active', 'beta two');
    h.plan('proj_2', key(3), NOW + 3, 'completed', 'alpha three');
    h.plan('proj_2', key(4), NOW - 10, 'abandoned', 'alpha old');
    const first = await h.get('/api/plans?status=active&limit=1');
    expect(first.body.totals).toEqual({ active: 2, completed: 1, abandoned: 1 });
    expect(first.body.plans).toHaveLength(1);
    expect((await h.get(`/api/plans?status=active&limit=1&cursor=${encodeURIComponent(first.body.cursor)}`)).body.totals).toBeUndefined();
    expect((await h.get(`/api/plans?since=${NOW}`)).body.totals).toEqual({ active: 2, completed: 1 });
    expect((await h.get('/api/plans?q=alpha')).body.totals).toEqual({ active: 1, completed: 1, abandoned: 1 });
    expect((await h.get('/api/plans?q=alpha&project=proj_1')).body.totals).toEqual({ active: 1 });
  });

  it('matches a text in the title or the inline body, pages through the matches, and treats % and _ as text', async () => {
    const h = harness();
    h.plan('proj_1', key(1), NOW + 1, 'active', 'Cobalt migration');
    h.plan('proj_1', key(2), NOW + 2, 'active', 'Other', '- [ ] move the cobalt index');
    h.plan('proj_2', key(3), NOW + 3, 'active', 'Unrelated');
    h.plan('proj_2', key(4), NOW + 4, 'active', 'Spend 100% of it');
    const ids = async (path: string) => (await h.get(path)).body.plans.map((p: any) => p.planKey);
    expect(await ids('/api/plans?q=cobalt')).toEqual([key(2), key(1)]);
    const first = await h.get('/api/plans?q=COBALT&limit=1');
    expect(first.body.plans.map((p: any) => p.planKey)).toEqual([key(2)]);
    expect(await ids(`/api/plans?q=COBALT&limit=1&cursor=${encodeURIComponent(first.body.cursor)}`)).toEqual([key(1)]);
    expect(await ids('/api/plans?q=100%25')).toEqual([key(4)]);
    expect(await ids('/api/plans?q=_')).toEqual([]);
  });
});

describe('who wrote a spore', () => {
  it('names a run, a member, a grant, or no one, on every read of the row', async () => {
    const h = harness();
    h.sqlite.run(`INSERT INTO external_grants (id, project_id, key_hash, label, created_by, created_at) VALUES ('eg_1', 'proj_1', 'kh', 'ci', 'mem_machine_1', 1)`);
    h.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('eg_1', 'ci', 'grant', 1, 0)`);
    h.spore('proj_1', 'sp_run', { author: 'run_gone' });
    h.spore('proj_1', 'sp_member', { author: 'mem_machine_2', agentId: 'user' });
    h.spore('proj_1', 'sp_imported', { author: 'mem_machine_1', agentId: 'agent_1' });
    h.spore('proj_1', 'sp_grant', { author: 'eg_1', agentId: 'eg_1' });
    h.spore('proj_1', 'sp_legacy', { author: null });
    const expected = { sp_run: 'run', sp_member: 'member', sp_imported: 'member', sp_grant: 'grant', sp_legacy: null };
    const kinds = (rows: any[]) => Object.fromEntries(rows.map((s) => [s.id, s.authorKind]));
    expect(kinds((await h.get('/api/projects/proj_1/spores', MEMBER_SUB)).body.spores)).toEqual(expected);
    expect(kinds((await h.get('/api/spores?project=proj_1')).body.spores)).toEqual(expected);
    for (const [id, kind] of Object.entries(expected)) {
      expect({ id, kind: (await h.get(`/api/projects/proj_1/spores/${id}`)).body.spore.authorKind }).toEqual({ id, kind });
    }
  });
});

describe('the spore stream', () => {
  it('counts its facets under the status, text and window it is asked for', async () => {
    const h = harness();
    h.spore('proj_1', 'sp_a', { status: 'active', type: 'gotcha', content: 'cobalt', at: NOW });
    h.spore('proj_1', 'sp_b', { status: 'superseded', type: 'gotcha', content: 'cobalt', at: NOW });
    h.spore('proj_2', 'sp_c', { status: 'active', type: 'decision', content: 'cobalt', at: NOW - 1000 });
    h.spore('proj_2', 'sp_d', { status: 'active', type: 'decision', content: 'other', at: NOW });
    const facets = async (query: string) => (await h.get(`/api/spores?${query}`)).body.facets;
    expect(await facets('')).toEqual({ type: { gotcha: 2, decision: 2 }, project: { proj_1: 2, proj_2: 2 } });
    expect(await facets('status=active')).toEqual({ type: { gotcha: 1, decision: 2 }, project: { proj_1: 1, proj_2: 2 } });
    expect(await facets('q=cobalt')).toEqual({ type: { gotcha: 2, decision: 1 }, project: { proj_1: 2, proj_2: 1 } });
    expect(await facets(`since=${NOW}`)).toEqual({ type: { gotcha: 2, decision: 1 }, project: { proj_1: 2, proj_2: 1 } });
    expect(await facets(`status=active&q=cobalt&since=${NOW}`)).toEqual({ type: { gotcha: 1 }, project: { proj_1: 1 } });
  });

  it('matches its text against the line a reader sees, as well as the body and the type', async () => {
    const h = harness();
    h.spore('proj_1', 'sp_line', { content: 'the long body', line: 'Capture drops the last event on restart' });
    h.spore('proj_1', 'sp_body', { content: 'restart handling in the body' });
    h.spore('proj_1', 'sp_none', { content: 'nothing relevant', line: 'Unrelated line' });
    const ids = async (path: string) => (await h.get(path)).body.spores.map((s: any) => s.id).sort();
    expect(await ids('/api/projects/proj_1/spores?q=restart')).toEqual(['sp_body', 'sp_line']);
    expect(await ids('/api/spores?q=drops%20the%20last')).toEqual(['sp_line']);
  });
});

describe('search leads a spore with its line', () => {
  it('previews a spore by its line where it has one, and by a snippet of its body where it has none', async () => {
    const h = harness();
    h.spore('proj_1', 'sp_lined', { content: 'cobalt appears deep in a long body of text', line: 'Cobalt keys expire after a day' });
    h.spore('proj_1', 'sp_plain', { content: 'cobalt without a line' });
    const previews = Object.fromEntries(((await h.get('/api/search?q=cobalt&type=spore')).body.results as any[]).map((r) => [r.id, r.preview]));
    expect(previews).toEqual({ sp_lined: 'Cobalt keys expire after a day', sp_plain: expect.stringContaining('cobalt without a line') });
    const inProject = Object.fromEntries(((await h.get('/api/projects/proj_1/search?q=cobalt&type=spore&mode=fts')).body.results as any[]).map((r) => [r.id, r.preview]));
    expect(inProject.sp_lined).toBe('Cobalt keys expire after a day');
  });
});
