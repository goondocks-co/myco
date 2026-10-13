/**
 * The product surface over generated intelligence.
 *
 * #991's acceptance is that an empty result is distinguishable from a failed
 * one. Every collection here answers 200 with an empty list for a Project that
 * has generated nothing, and 404 only when the Project is not one this caller
 * may see — so "the task has not run" never reads as "the Project is gone".
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { insertSpore, resolveSpore } from '@myco-server-worker/core/spores.js';
import { upsertCortexInstructions } from '@myco-server-worker/core/runs.js';

const AGENT = 'agent_1';
const NOW = 1_700_000_000_000;

async function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  fixture.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`).run(NOW);
  fixture.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, NOW);
  const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await worker.fetch(await asOwner(fixture.db, path), env);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { ...fixture, env, get, scope: { projectId: 'proj_1' } };
}

const spore = (id: string, over: Record<string, unknown> = {}) => ({
  id, agentId: AGENT, sessionId: null, promptId: null, observationType: 'gotcha',
  content: `body of ${id}`, context: null, filePath: null, tags: null,
  contentHash: null, properties: null, author: null, createdAt: NOW, ...over,
});

describe('an empty answer is not a missing one', () => {
  it('answers 200 with empty collections for a Project that has generated nothing', async () => {
    const { get } = await harness();
    for (const [path, key] of [
      ['/api/projects/proj_1/spores', 'spores'],
      ['/api/projects/proj_1/release-states', 'releaseStates'],
      ['/api/projects/proj_1/cortex/instructions', 'instructions'],
    ] as const) {
      const { status, body } = await get(path);
      expect({ path, status, empty: (body[key] as unknown[]).length }).toEqual({ path, status: 200, empty: 0 });
    }
  });

  it('answers 404 for a Project this caller cannot see, never an empty list', async () => {
    const { get } = await harness();
    for (const path of ['/api/projects/absent/spores', '/api/projects/absent/cortex/instructions']) {
      expect((await get(path)).status).toBe(404);
    }
  });
});

describe('spores through the product surface', () => {
  it('lists with a total and filters by type', async () => {
    const { get, db, scope } = await harness();
    await insertSpore(db, scope, spore('sp1'));
    await insertSpore(db, scope, spore('sp2', { observationType: 'decision' }));

    const all = await get('/api/projects/proj_1/spores');
    expect({ n: (all.body.spores as unknown[]).length, total: all.body.total }).toEqual({ n: 2, total: 2 });
    const filtered = await get('/api/projects/proj_1/spores?type=decision');
    expect({ n: (filtered.body.spores as unknown[]).length, total: filtered.body.total }).toEqual({ n: 1, total: 1 });
  });

  it('shows a retired spore its replacement rather than a dead end', async () => {
    const { get, db, scope } = await harness();
    await insertSpore(db, scope, spore('old'));
    await insertSpore(db, scope, spore('new'));
    await resolveSpore(db, scope, 'superseded', {
      id: 're1', agentId: AGENT, sporeId: 'old', action: 'supersede',
      newSporeId: 'new', reason: null, sessionId: null, author: null, createdAt: NOW,
    }, NOW);

    const { body } = await get('/api/projects/proj_1/spores/old');
    expect(body.supersededBy).toEqual(['new']);
    expect((await get('/api/projects/proj_1/spores/new')).body).toMatchObject({ supersededBy: [], supersedes: ['old'] });
  });

  it('narrows the list to one session and pages through it', async () => {
    const { get, db, sqlite, scope } = await harness();
    sqlite.query(`INSERT INTO sessions (project_id, session_id, created_by_token_id, first_received_at, last_received_at)
      VALUES ('proj_1', 'sess_a', 'tok', ?, ?)`).run(NOW, NOW);
    // s1 and s2 share an instant, so a page boundary between them lands on the
    // id tiebreaker rather than on whatever order the storage happens to return.
    for (const [id, sessionId] of [['s1', 'sess_a'], ['s2', 'sess_a'], ['s3', null]] as const) {
      await insertSpore(db, scope, spore(id, { sessionId, createdAt: NOW }));
    }
    const filtered = await get('/api/projects/proj_1/spores?session=sess_a');
    expect({ ids: (filtered.body.spores as { id: string }[]).map((s) => s.id), total: filtered.body.total }).toEqual({ ids: ['s2', 's1'], total: 2 });
    const paged = await get('/api/projects/proj_1/spores?session=sess_a&offset=1');
    expect({ ids: (paged.body.spores as { id: string }[]).map((s) => s.id), total: paged.body.total }).toEqual({ ids: ['s1'], total: 2 });
  });

  it('serves no more than the ceiling, however large a page the caller asks for', async () => {
    const { get, db, scope } = await harness();
    for (let i = 0; i < 205; i += 1) await insertSpore(db, scope, spore(`sp${i}`));
    const { body } = await get('/api/projects/proj_1/spores?limit=99999');
    expect((body.spores as unknown[]).length).toBe(200);
  });
});

describe('retired generated intelligence', () => {
  it('does not serve skills, candidates or digests after their tables retire', async () => {
    const { get } = await harness();
    for (const suffix of ['skills', 'skills/absent', 'skill-candidates', 'digests', 'digests/5000/revisions']) {
      expect((await get(`/api/projects/proj_1/${suffix}`)).status).toBe(401);
    }
  });
});

describe('cortex instructions through the product surface', () => {
  it('serves each agent\'s current instructions newest first, naming the run that produced them', async () => {
    const { get, db, scope } = await harness();
    await upsertCortexInstructions(db, scope, { agentId: AGENT, content: '# old', inputHash: 'h1', sourceRunId: 'run_1', generatedAt: NOW });
    await upsertCortexInstructions(db, scope, { agentId: AGENT, content: '# current', inputHash: 'h2', sourceRunId: 'run_2', generatedAt: NOW + 1 });
    await upsertCortexInstructions(db, scope, { id: 'other:instructions', agentId: 'agent_2', content: '# other', inputHash: 'h3', sourceRunId: null, generatedAt: NOW + 2 });

    const { body } = await get('/api/projects/proj_1/cortex/instructions');
    expect((body.instructions as { agentId: string; content: string; sourceRunId: string | null }[]).map((r) => [r.agentId, r.content, r.sourceRunId]))
      .toEqual([['agent_2', '# other', null], [AGENT, '# current', 'run_2']]);
  });
});

describe('replaying a spore resolution', () => {
  it('moves nothing when the event is already recorded, so a later change stands', async () => {
    const { db, sqlite, scope } = await harness();
    await insertSpore(db, scope, spore('old'));
    await insertSpore(db, scope, spore('new'));
    const event = { id: 're1', agentId: AGENT, sporeId: 'old', action: 'supersede' as const, newSporeId: 'new', reason: null, sessionId: null, author: null, createdAt: NOW - 5 };
    expect(await resolveSpore(db, scope, 'superseded', event, NOW - 5)).toBe(true);
    sqlite.run(`UPDATE spores SET status = 'active', updated_at = ? WHERE id = 'old'`, [NOW]);
    expect(await resolveSpore(db, scope, 'superseded', event, NOW + 5)).toBe('duplicate');
    expect(sqlite.query(`SELECT status, updated_at FROM spores WHERE id = 'old'`).get()).toEqual({ status: 'active', updated_at: NOW });
    expect(sqlite.query(`SELECT COUNT(*) AS n, MAX(created_at) AS at FROM resolution_events`).get()).toEqual({ n: 1, at: NOW - 5 });
  });
});
