/**
 * Sessions, spores and plans read across Projects (`/api/sessions`, `/api/spores`, `/api/plans`).
 *
 * Naming no Project covers every Project that accepts capture; naming some covers exactly those, and a name the
 * caller may not see answers 404 as the per-Project twin does. Each list pages as its twin pages, carries each row's
 * Project, and a member who is not an admin reads all three.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { MAX_NAMED_PROJECTS } from '@myco-server-worker/read/scope.js';

const NOW = 1_700_000_000_000;

async function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const { sqlite } = fixture;
  sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_3', 'c', 0)`);
  sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, ?)`, [NOW]);
  const session = (project: string, id: string, at: number, agent: string | null = 'claude-code') =>
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at)
                VALUES (?, ?, 'm1', 'tok_1', ?, ?, ?, ?)`, [project, id, at, at, agent, at]);
  const spore = (project: string, id: string, at: number, type = 'gotcha') =>
    sqlite.run(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) VALUES (?, ?, 'agent_1', ?, 'active', ?, ?)`, [project, id, type, `body of ${id}`, at]);
  const plan = (project: string, key: string, at: number, status = 'active') =>
    sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, content_hash, status, title, content, created_at, updated_at, token_id, received_at)
                VALUES (?, ?, 's', ?, 'm1', 'h', ?, ?, '- [ ] a', ?, ?, 'tok_1', ?)`, [project, key, `ev_${key}`, status, `plan ${key}`, at, at, at]);
  const get = async (path: string, sub?: string) => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), env);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { sqlite, session, spore, plan, get };
}

describe('the session list across Projects', () => {
  it('covers every Project that accepts capture when none is named, newest first, each row with its Project', async () => {
    const { sqlite, session, get } = await harness();
    session('proj_1', 's_a', NOW + 1);
    session('proj_2', 's_b', NOW + 3);
    session('proj_3', 's_c', NOW + 2);
    sqlite.run(`UPDATE projects SET archived_at = ?, archived_by = 'mem_machine_1' WHERE project_id = 'proj_3'`, [NOW]);
    const { status, body } = await get('/api/sessions');
    expect(status).toBe(200);
    expect(body.rows.map((r: any) => [r.projectId, r.sessionId])).toEqual([['proj_2', 's_b'], ['proj_1', 's_a']]);
    expect(body.rows[0]).toMatchObject({ promptCount: 0, toolCallCount: 0, agent: 'claude-code' });
  });

  it('covers exactly the Projects named, archived or not, and answers 404 for a name that is not a Project', async () => {
    const { sqlite, session, get } = await harness();
    session('proj_1', 's_a', NOW + 1);
    session('proj_2', 's_b', NOW + 2);
    session('proj_3', 's_c', NOW + 3);
    sqlite.run(`UPDATE projects SET archived_at = ?, archived_by = 'mem_machine_1' WHERE project_id = 'proj_3'`, [NOW]);
    expect((await get('/api/sessions?project=proj_1&project=proj_3')).body.rows.map((r: any) => r.sessionId)).toEqual(['s_c', 's_a']);
    expect((await get('/api/sessions?project=proj_1&project=absent')).status).toBe(404);
  });

  it('takes exactly as many Projects as a read may name, and refuses one more', async () => {
    const { sqlite, session, get } = await harness();
    const names = Array.from({ length: MAX_NAMED_PROJECTS + 1 }, (_, i) => `proj_n${i}`);
    for (const name of names) sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, 0)`, [name, name]);
    session(names[0]!, 's_first', NOW);
    const query = (count: number) => names.slice(0, count).map((n) => `project=${n}`).join('&');
    const most = await get(`/api/sessions?${query(MAX_NAMED_PROJECTS)}`);
    expect(most.status).toBe(200);
    expect(most.body.rows.map((r: any) => r.sessionId)).toEqual(['s_first']);
    expect((await get(`/api/sessions?${query(MAX_NAMED_PROJECTS + 1)}`)).status).toBe(400);
    // A name repeated is one Project.
    expect((await get(`/api/sessions?${query(MAX_NAMED_PROJECTS)}&project=${names[0]}`)).status).toBe(200);
  });

  it('keeps sessions from a start instant on, and of one agent', async () => {
    const { session, get } = await harness();
    session('proj_1', 's_old', NOW - 10);
    session('proj_1', 's_new', NOW + 1, 'codex');
    session('proj_2', 's_edge', NOW, 'claude-code');
    expect((await get(`/api/sessions?since=${NOW}`)).body.rows.map((r: any) => r.sessionId)).toEqual(['s_new', 's_edge']);
    expect((await get(`/api/sessions?since=${NOW}&agent=codex`)).body.rows.map((r: any) => r.sessionId)).toEqual(['s_new']);
    expect((await get('/api/sessions?agent=claude-code')).body.rows.map((r: any) => r.sessionId)).toEqual(['s_edge', 's_old']);
    expect((await get('/api/sessions?since=yesterday')).status).toBe(400);
  });

  it('takes the agent filter on the per-Project list too', async () => {
    const { session, get } = await harness();
    session('proj_1', 's_a', NOW + 1, 'codex');
    session('proj_1', 's_b', NOW + 2, 'claude-code');
    expect((await get('/api/projects/proj_1/sessions?agent=codex')).body.rows.map((r: any) => r.sessionId)).toEqual(['s_a']);
    expect((await get(`/api/projects/proj_1/sessions?since=${NOW + 2}`)).body.rows.map((r: any) => r.sessionId)).toEqual(['s_b']);
  });

  it('pages across Projects with a cursor, every session exactly once', async () => {
    const { session, get } = await harness();
    for (let i = 0; i < 7; i += 1) session(i % 2 === 0 ? 'proj_1' : 'proj_2', `s${i}`, NOW + i);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const { body } = await get(`/api/sessions?limit=3${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      seen.push(...body.rows.map((r: any) => r.sessionId));
      cursor = body.cursor;
    } while (cursor !== null);
    expect(seen).toEqual(['s6', 's5', 's4', 's3', 's2', 's1', 's0']);
  });

  it('pages past sessions sharing the instant the page ends on, each exactly once', async () => {
    const { session, get } = await harness();
    session('proj_1', 's_a', NOW);
    session('proj_2', 's_b', NOW);
    session('proj_1', 's_c', NOW);
    session('proj_2', 's_old', NOW - 1);
    const first = await get('/api/sessions?limit=2');
    expect(first.body.rows.map((r: any) => r.sessionId)).toEqual(['s_c', 's_b']);
    const second = await get(`/api/sessions?limit=2&cursor=${encodeURIComponent(first.body.cursor)}`);
    expect(second.body.rows.map((r: any) => r.sessionId)).toEqual(['s_a', 's_old']);
  });

  it('answers a member who is not an admin', async () => {
    const { sqlite, session, get } = await harness();
    seedMemberRoleAccount(sqlite);
    session('proj_1', 's_a', NOW);
    const answered = await get('/api/sessions', MEMBER_SUB);
    expect(answered.status).toBe(200);
    expect(answered.body.rows.map((r: any) => r.sessionId)).toEqual(['s_a']);
  });
});

describe('the spore list across Projects', () => {
  it('lists newest first with each row\'s Project, and carries facets on the first page only', async () => {
    const { spore, get } = await harness();
    spore('proj_1', 'sp1', NOW + 1, 'gotcha');
    spore('proj_2', 'sp2', NOW + 2, 'decision');
    spore('proj_2', 'sp3', NOW + 3, 'gotcha');
    const first = await get('/api/spores?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.spores.map((s: any) => [s.projectId, s.id])).toEqual([['proj_2', 'sp3'], ['proj_2', 'sp2']]);
    expect(first.body.total).toBe(3);
    expect(first.body.facets).toEqual({ type: { gotcha: 2, decision: 1 }, project: { proj_1: 1, proj_2: 2 } });
    const second = await get('/api/spores?limit=2&offset=2');
    expect(second.body.spores.map((s: any) => s.id)).toEqual(['sp1']);
    expect(second.body.facets).toBeUndefined();
  });

  it('counts each facet under every filter but its own', async () => {
    const { spore, get } = await harness();
    spore('proj_1', 'sp1', NOW + 1, 'gotcha');
    spore('proj_2', 'sp2', NOW + 2, 'decision');
    spore('proj_2', 'sp3', NOW + 3, 'gotcha');
    const { body } = await get('/api/spores?project=proj_2&type=gotcha');
    expect(body.spores.map((s: any) => s.id)).toEqual(['sp3']);
    expect(body.facets).toEqual({ type: { gotcha: 1, decision: 1 }, project: { proj_1: 1, proj_2: 1 } });
  });

  it('keeps spores written from a start instant on', async () => {
    const { spore, get } = await harness();
    spore('proj_1', 'sp_old', NOW - 1);
    spore('proj_2', 'sp_edge', NOW);
    expect((await get(`/api/spores?since=${NOW}`)).body.spores.map((s: any) => s.id)).toEqual(['sp_edge']);
  });
});

describe('the plan list across Projects', () => {
  it('lists newest edit first with each row\'s Project, filters by status and start, and pages by cursor', async () => {
    const { plan, get } = await harness();
    plan('proj_1', '00000000-0000-4000-8000-000000000001', NOW + 1);
    plan('proj_2', '00000000-0000-4000-8000-000000000002', NOW + 2, 'completed');
    plan('proj_3', '00000000-0000-4000-8000-000000000003', NOW + 3);
    const { status, body } = await get('/api/plans?limit=2');
    expect(status).toBe(200);
    expect(body.plans.map((p: any) => p.projectId)).toEqual(['proj_3', 'proj_2']);
    expect(body.plans[0]).toMatchObject({ progress: '0/1', tags: [] });
    const next = await get(`/api/plans?limit=2&cursor=${encodeURIComponent(body.cursor)}`);
    expect(next.body.plans.map((p: any) => p.projectId)).toEqual(['proj_1']);
    expect((await get('/api/plans?status=completed')).body.plans.map((p: any) => p.projectId)).toEqual(['proj_2']);
    expect((await get(`/api/plans?since=${NOW + 2}`)).body.plans.map((p: any) => p.projectId)).toEqual(['proj_3', 'proj_2']);
    expect((await get('/api/plans?status=bogus')).status).toBe(400);
  });

  it('covers only the Projects named, and pages past plans sharing the instant the page ends on', async () => {
    const { plan, get } = await harness();
    plan('proj_1', '00000000-0000-4000-8000-000000000001', NOW);
    plan('proj_2', '00000000-0000-4000-8000-000000000002', NOW);
    plan('proj_3', '00000000-0000-4000-8000-000000000003', NOW);
    plan('proj_2', '00000000-0000-4000-8000-000000000004', NOW - 1);
    expect((await get('/api/plans?project=proj_2&project=proj_3')).body.plans.map((p: any) => p.planKey.slice(-1))).toEqual(['3', '2', '4']);
    expect((await get('/api/plans?project=absent')).status).toBe(404);
    const first = await get('/api/plans?limit=2');
    expect(first.body.plans.map((p: any) => p.planKey.slice(-1))).toEqual(['3', '2']);
    const second = await get(`/api/plans?limit=2&cursor=${encodeURIComponent(first.body.cursor)}`);
    expect(second.body.plans.map((p: any) => p.planKey.slice(-1))).toEqual(['1', '4']);
  });
});
