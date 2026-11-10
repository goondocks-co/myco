/**
 * The Knowledge page's reads (#1535): one plan by its key, the plan board's totals, who wrote a spore, the spore
 * stream's facets under every structured filter, a text filter refused for search, and search leading a spore with
 * its line.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import { memberHeaders } from './helpers/fixtures.js';
import { issueMemberToken } from './helpers/member-token.js';
import worker from '@myco-server-worker/index.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
/** The UTC day `NOW` falls in. */
const TODAY = Math.floor(NOW / DAY) * DAY;
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
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(fixture.db, Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), env);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const save = async (body: Record<string, unknown>) => {
    const { token } = await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const res = await worker.fetch(new Request('https://s/spores/save', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify(body) }), env);
    return await res.json() as Record<string, any>;
  };
  return { sqlite, plan, tag, spore, get, save, env };
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
  it('counts every status from the counters on the first page, not on a later one, and pages a window with hasMore alone', async () => {
    const h = harness();
    h.plan('proj_1', key(1), NOW + 1, 'active', 'alpha one');
    h.plan('proj_1', key(2), NOW + 2, 'active', 'beta two');
    h.plan('proj_2', key(3), NOW + 3, 'completed', 'alpha three');
    h.plan('proj_2', key(4), NOW - 10, 'abandoned', 'alpha old');
    h.sqlite.run("UPDATE plans SET status = 'completed' WHERE plan_key = ?", [key(2)]);
    const first = await h.get('/api/plans?status=active&limit=1');
    expect({ totals: first.body.totals, plans: first.body.plans.length, hasMore: first.body.hasMore })
      .toEqual({ totals: { active: 1, completed: 2, abandoned: 1 }, plans: 1, hasMore: false });
    const both = await h.get('/api/plans?limit=1');
    expect({ hasMore: both.body.hasMore, next: (await h.get(`/api/plans?limit=1&cursor=${encodeURIComponent(both.body.cursor)}`)).body.totals }).toEqual({ hasMore: true, next: undefined });
    const windowed = await h.get(`/api/plans?since=${NOW}&limit=1`);
    expect({ totals: windowed.body.totals, hasMore: windowed.body.hasMore }).toEqual({ totals: undefined, hasMore: true });
    expect((await h.get('/api/plans?project=proj_1')).body.totals).toEqual({ active: 1, completed: 1 });
  });

  it('leaves an archived Project out of every Project\'s totals, and counts it when named', async () => {
    const h = harness();
    h.plan('proj_1', key(1), NOW + 1, 'active', 'kept');
    h.plan('proj_2', key(2), NOW + 2, 'active', 'archived one');
    h.plan('proj_2', key(3), NOW + 3, 'completed', 'archived two');
    h.sqlite.run(`UPDATE projects SET archived_at = ?, archived_by = 'mem_machine_1' WHERE project_id = 'proj_2'`, [NOW]);
    expect((await h.get('/api/plans')).body.totals).toEqual({ active: 1 });
    expect((await h.get('/api/plans?project=proj_2')).body.totals).toEqual({ active: 1, completed: 1 });
  });

  it('refuses a text filter, naming the search to make instead, and reads nothing', async () => {
    const h = harness();
    h.plan('proj_1', key(1), NOW + 1, 'active', 'Cobalt migration');
    const refused = await h.get('/api/plans?q=cobalt');
    expect({ status: refused.status, error: refused.body.reason }).toEqual({ status: 400, error: expect.stringContaining('Next call: myco_search {"query":"cobalt","type":"plan","mode":"fts"}; over HTTP, GET /api/search?q=cobalt&type=plan&mode=fts.') });
  });
});

describe('who wrote a spore', () => {
  it('names a run, a member, a spore the 1.4 import brought for a member, a grant, or no one, on every read of the row', async () => {
    const h = harness();
    h.sqlite.run(`INSERT INTO external_grants (id, project_id, key_hash, label, created_by, created_at) VALUES ('eg_1', 'proj_1', 'kh', 'ci', 'mem_machine_1', 1)`);
    h.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('eg_1', 'ci', 'grant', 1, 0)`);
    h.spore('proj_1', 'sp_run', { author: 'run_gone' });
    h.spore('proj_1', 'sp_member', { author: 'mem_machine_2', agentId: 'user' });
    h.spore('proj_1', 'sp_imported', { author: 'mem_machine_1', agentId: 'agent_1' });
    h.spore('proj_1', 'sp_grant', { author: 'eg_1', agentId: 'eg_1' });
    h.spore('proj_1', 'sp_legacy', { author: null });
    const expected = { sp_run: 'run', sp_member: 'member', sp_imported: 'imported', sp_grant: 'grant', sp_legacy: null };
    const kinds = (rows: any[]) => Object.fromEntries(rows.map((s) => [s.id, s.authorKind]));
    expect(kinds((await h.get('/api/projects/proj_1/spores', MEMBER_SUB)).body.spores)).toEqual(expected);
    expect(kinds((await h.get('/api/spores?project=proj_1')).body.spores)).toEqual(expected);
    for (const [id, kind] of Object.entries(expected)) {
      expect({ id, kind: (await h.get(`/api/projects/proj_1/spores/${id}`)).body.spore.authorKind }).toEqual({ id, kind });
    }
  });
});

describe('the spore stream', () => {
  it('counts its total and facets from the counters under its status and a window of whole UTC days', async () => {
    const h = harness();
    h.spore('proj_1', 'sp_a', { status: 'active', type: 'gotcha', at: NOW });
    h.spore('proj_1', 'sp_b', { status: 'superseded', type: 'gotcha', at: NOW });
    h.spore('proj_2', 'sp_c', { status: 'active', type: 'decision', at: TODAY - 1 });
    h.spore('proj_2', 'sp_d', { status: 'active', type: 'decision', at: NOW });
    const page = async (query: string) => (await h.get(`/api/spores?${query}`)).body;
    expect(await page('')).toMatchObject({ total: 4, facets: { type: { gotcha: 2, decision: 2 }, project: { proj_1: 2, proj_2: 2 } } });
    expect(await page('status=active')).toMatchObject({ total: 3, facets: { type: { gotcha: 1, decision: 2 }, project: { proj_1: 1, proj_2: 2 } } });
    expect(await page('type=decision')).toMatchObject({ total: 2, facets: { type: { gotcha: 2, decision: 2 }, project: { proj_2: 2 } } });
    expect(await page(`since=${TODAY}`)).toMatchObject({ total: 3, facets: { type: { gotcha: 2, decision: 1 }, project: { proj_1: 2, proj_2: 1 } } });
    expect(await page(`since=${TODAY - DAY}&until=${TODAY}`)).toMatchObject({ total: 1, facets: { type: { decision: 1 }, project: { proj_2: 1 } } });
    // A bound inside a day widens to the whole UTC day: the page, the total and the facets read the same days.
    const inside = await page(`since=${NOW}&until=${NOW + 1}`);
    expect({ ids: inside.spores.map((s: any) => s.id).sort(), total: inside.total, facets: inside.facets, window: inside.window })
      .toEqual({ ids: ['sp_a', 'sp_b', 'sp_d'], total: 3, facets: { type: { gotcha: 2, decision: 1 }, project: { proj_1: 2, proj_2: 1 } }, window: { from: TODAY, to: TODAY + DAY } });
    const yesterday = await page(`since=${TODAY - DAY + 5}&until=${TODAY - 5}`);
    expect({ ids: yesterday.spores.map((s: any) => s.id), total: yesterday.total, window: yesterday.window })
      .toEqual({ ids: ['sp_c'], total: 1, window: { from: TODAY - DAY, to: TODAY } });
    expect((await page(`since=${TODAY - 1}&until=${TODAY + 1}`)).total).toBe(4);
  });

  it('pages by the cursor its last page answered, and refuses offset paging', async () => {
    const h = harness();
    for (const id of ['sp_1', 'sp_2', 'sp_3']) h.spore('proj_1', id, { at: NOW });
    const first = (await h.get('/api/spores?limit=2')).body;
    const next = (await h.get(`/api/spores?limit=2&cursor=${encodeURIComponent(first.cursor)}`)).body;
    expect({ ids: [...first.spores, ...next.spores].map((s: any) => s.id), more: [first.hasMore, next.hasMore], facets: next.facets })
      .toEqual({ ids: ['sp_3', 'sp_2', 'sp_1'], more: [true, false], facets: undefined });
    for (const path of ['/api/spores?offset=2', '/api/projects/proj_1/spores?offset=2']) {
      const refused = await h.get(path);
      expect({ path, status: refused.status, error: refused.body.reason }).toEqual({ path, status: 400, error: expect.stringContaining('cursor') });
    }
  });
});

describe('search leads a spore with its line', () => {
  it('previews a spore by its line where it has one, and by a snippet of its body where it has none', async () => {
    const h = harness();
    h.spore('proj_1', 'sp_lined', { content: 'cobalt appears deep in a long body of text', line: 'Cobalt keys expire after a day' });
    h.spore('proj_1', 'sp_plain', { content: 'cobalt without a line' });
    const previews = Object.fromEntries(((await h.get('/api/search?q=cobalt&type=spore')).body.hits as any[]).map((r) => [r.id, r.preview]));
    expect(previews).toEqual({ sp_lined: 'Cobalt keys expire after a day', sp_plain: expect.stringContaining('cobalt without a line') });
    const inProject = Object.fromEntries(((await h.get('/api/projects/proj_1/search?q=cobalt&type=spore&mode=fts')).body.hits as any[]).map((r) => [r.id, r.preview]));
    expect(inProject.sp_lined).toBe('Cobalt keys expire after a day');
  });
});

describe('a written spore answers in the shape a write answers', () => {
  it('carries no author kind, written fresh or held already; the reads carry it', async () => {
    const h = harness();
    const body = { channel: 'import', id: 'sp_written', agentId: 'myco-agent', observationType: 'gotcha', content: 'imported body' };
    const fresh = await h.save(body);
    expect(fresh).toMatchObject({ persisted: true, spore: { id: 'sp_written' } });
    expect(fresh.spore).not.toHaveProperty('authorKind');
    const again = await h.save(body);
    expect(again).toMatchObject({ persisted: true, duplicate: true, spore: { id: 'sp_written' } });
    expect(again.spore).not.toHaveProperty('authorKind');
    expect((await h.get('/api/projects/proj_1/spores/sp_written')).body.spore.authorKind).toBe('imported');
  });
});

describe('a text filter on a spore list', () => {
  it('is refused on every list, naming the search to make instead', async () => {
    const h = harness();
    h.spore('proj_1', 'sp_percent', { content: 'spend 100% of it' });
    for (const path of ['/api/projects/proj_1/spores?q=100%25', '/api/spores?q=restart']) {
      const refused = await h.get(path);
      expect({ path, status: refused.status, error: refused.body.reason }).toEqual({ path, status: 400, error: expect.stringContaining('search?q=') });
    }
    // Each names the search to call with the text it got, narrowed as the list is.
    expect((await h.get('/api/projects/proj_1/spores?q=100%25')).body.reason)
      .toContain('Next call: myco_search {"query":"100%","type":"spore","mode":"fts","project":"proj_1"}; over HTTP, GET /api/projects/proj_1/search?q=100%25&type=spore&mode=fts.');
    expect((await h.get('/api/plans?q=cobalt')).body.reason).toContain('Next call: myco_search {"query":"cobalt","type":"plan","mode":"fts"}');
  });
});
