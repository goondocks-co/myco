/**
 * The Project's plans, read as one list and as the measures surface reads them.
 *
 * Two surfaces are held here: the plan list a reader browses, and the measures
 * route. Both are owner reads over rows the Deployment already holds, and both
 * must tell an empty Project apart from one this caller may not see.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';

const NOW = 1_700_000_000_000;

async function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  fixture.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`).run(NOW);
  const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await worker.fetch(await asOwner(path), env);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const plan = (key: string, over: { status?: string; title?: string; content?: string; session?: string; at?: number } = {}) => {
    const at = over.at ?? NOW;
    fixture.sqlite.query(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, content_hash, status, created_at, updated_at, token_id, received_at)
                          VALUES ('proj_1', ?, ?, ?, 'm1', ?, ?, ?, ?, ?, ?, 'tok_1', ?)`)
      .run(key, over.session ?? 'sess_1', `ev_${key}`, over.title ?? `Plan ${key}`, over.content ?? null, `hash_${key}`, over.status ?? 'active', at, at, at);
  };
  return { ...fixture, env, get, plan };
}

describe('a Project\'s plans', () => {
  it('answers 200 with an empty list for a Project that has written none, and 404 for one this caller cannot see', async () => {
    const { get } = await harness();
    const empty = await get('/api/projects/proj_1/plans');
    expect({ status: empty.status, plans: (empty.body.plans as unknown[]).length }).toEqual({ status: 200, plans: 0 });
    expect((await get('/api/projects/absent/plans')).status).toBe(404);
  });

  it('lists every plan newest edit first, with the session it came from and its task-list progress', async () => {
    const { get, plan } = await harness();
    plan('k_old', { at: NOW - 10_000, title: 'Older plan' });
    plan('k_new', { at: NOW, title: 'Newer plan', content: '- [x] one\n- [ ] two', session: 'sess_2' });
    const { body } = await get('/api/projects/proj_1/plans');
    const rows = body.plans as Array<Record<string, unknown>>;
    expect(rows.map((r) => ({ key: r.planKey, session: r.sessionId, progress: r.progress })))
      .toEqual([
        { key: 'k_new', session: 'sess_2', progress: '1/2' },
        { key: 'k_old', session: 'sess_1', progress: 'N/A' },
      ]);
  });

  it('narrows to one status and refuses a status the catalogue does not hold', async () => {
    const { get, plan } = await harness();
    plan('k_active', { status: 'active' });
    plan('k_done', { status: 'completed' });
    const done = await get('/api/projects/proj_1/plans?status=completed');
    expect((done.body.plans as Array<Record<string, unknown>>).map((r) => r.planKey)).toEqual(['k_done']);

    // A filter nothing matches and a filter nothing could match read the same on a
    // page; only one of them is the caller's mistake, and it is named.
    const refused = await get('/api/projects/proj_1/plans?status=nonsense');
    expect({ status: refused.status, error: refused.body.error }).toEqual({ status: 400, error: 'bad_request' });
  });
});

describe('a Project\'s plans at the size a real Project reaches', () => {
  it('answers a full page past the hosted store\'s parameter ceiling, each plan with its tags, and pages through every plan once', async () => {
    const { get, plan, sqlite } = await harness();
    const count = 230;
    const key = (i: number) => `k_${String(i).padStart(3, '0')}`;
    // Five plans to each edit instant: a tie is ordered by key, newest key first, and a page boundary inside a tie loses
    // and repeats nothing.
    for (let i = 0; i < count; i += 1) {
      plan(key(i), { at: NOW + Math.floor(i / 5) });
      sqlite.query(`INSERT INTO tags (project_id, entity_kind, entity_id, tag) VALUES ('proj_1', 'plan', ?, ?)`).run(key(i), `t${i % 3}`);
    }
    for (const limit of [100, 200]) {
      const page = await get(`/api/projects/proj_1/plans?limit=${limit}`);
      const rows = page.body.plans as Array<{ planKey: string; tags: string[] }>;
      expect({ limit, status: page.status, rows: rows.length, tagged: rows.every((r) => r.tags.length === 1) }).toEqual({ limit, status: 200, rows: limit, tagged: true });
      expect(typeof page.body.cursor).toBe('string');
    }
    const seen: string[] = [];
    let cursor: unknown = null;
    for (let pages = 0; pages < 40; pages += 1) {
      const page = await get(`/api/projects/proj_1/plans?limit=7${cursor === null ? '' : `&cursor=${encodeURIComponent(String(cursor))}`}`);
      seen.push(...(page.body.plans as Array<{ planKey: string }>).map((r) => r.planKey));
      cursor = page.body.cursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(Array.from({ length: count }, (_, i) => key(count - 1 - i)));
    expect((await get('/api/projects/proj_1/plans?cursor=nonsense')).status).toBe(400);
  });

  it('holds the store it runs on to the hosted ceiling: a statement binding more than 100 parameters is refused', () => {
    const { db } = sqliteEnv();
    const bind = (n: number) => () => db.prepare(`SELECT ${Array.from({ length: n }, () => '?').join(', ')}`).bind(...Array.from({ length: n }, (_, i) => i));
    expect(bind(100)).not.toThrow();
    expect(bind(101)).toThrow('too many SQL variables');
  });
});

describe('the measures route', () => {
  it('answers every measure with its sample, and carries the window it was read over', async () => {
    const { get } = await harness();
    const { status, body } = await get('/api/kpis?window=7');
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      'callsPerPrompt', 'callsPerPromptByHarness', 'contextPresent',
      'firstInjectionMs', 'planReadsPerSession', 'recallQuality', 'since', 'sporeServeRate', 'windowDays',
    ]);
    expect(body.windowDays).toBe(7);
    // Every measure answers the pair; none answers a bare number.
    for (const key of ['contextPresent', 'sporeServeRate', 'callsPerPrompt', 'planReadsPerSession', 'firstInjectionMs', 'recallQuality'] as const) {
      expect({ key, shape: Object.keys(body[key] as object).sort() }).toEqual({ key, shape: ['sampleSize', 'value'] });
    }
  });

  it('reads a window it does not offer as every row the Deployment holds', async () => {
    const { get } = await harness();
    const { body } = await get('/api/kpis?window=4000');
    expect({ windowDays: body.windowDays, since: body.since }).toEqual({ windowDays: null, since: null });
  });
});

describe('spores named by id at the size a page of recall reaches', () => {
  it('hydrates more spores than one statement may bind on the hosted store', async () => {
    const { db, sqlite } = sqliteEnv();
    sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, ?)`).run(NOW);
    const { insertSpore, listSporesByIds, MAX_SPORE_LIMIT } = await import('@myco-server-worker/core/spores.js');
    const scope = { projectId: 'proj_1' };
    const ids = Array.from({ length: MAX_SPORE_LIMIT }, (_, i) => `sp_${i}`);
    for (const id of ids) {
      await insertSpore(db, scope, { id, agentId: 'agent_1', sessionId: null, promptId: null, observationType: 'gotcha', content: `content of ${id}`, context: null, filePath: null, tags: null, contentHash: null, properties: null, author: null, createdAt: NOW });
    }
    expect((await listSporesByIds(db, scope, ids)).map((row) => row.id).sort()).toEqual([...ids].sort());
  });
});
