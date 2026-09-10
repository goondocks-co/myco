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

describe('the measures route', () => {
  it('answers every measure with its sample, and carries the window it was read over', async () => {
    const { get } = await harness();
    const { status, body } = await get('/api/kpis?window=7');
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      'callsPerPrompt', 'callsPerPromptByHarness', 'contextPresent', 'evalPassRate',
      'firstInjectionMs', 'planReadsPerSession', 'since', 'sporeServeRate', 'windowDays',
    ]);
    expect(body.windowDays).toBe(7);
    // Every measure answers the pair; none answers a bare number.
    for (const key of ['contextPresent', 'sporeServeRate', 'callsPerPrompt', 'planReadsPerSession', 'firstInjectionMs', 'evalPassRate'] as const) {
      expect({ key, shape: Object.keys(body[key] as object).sort() }).toEqual({ key, shape: ['sampleSize', 'value'] });
    }
  });

  it('reads a window it does not offer as every row the Deployment holds', async () => {
    const { get } = await harness();
    const { body } = await get('/api/kpis?window=4000');
    expect({ windowDays: body.windowDays, since: body.since }).toEqual({ windowDays: null, since: null });
  });
});
