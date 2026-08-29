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
import { insertLineage, insertSkillRecord } from '@myco-server-worker/core/skills.js';
import { upsertDigest } from '@myco-server-worker/core/digests.js';
import { upsertCortexInstructions } from '@myco-server-worker/core/runs.js';

const AGENT = 'agent_1';
const NOW = 1_700_000_000_000;

async function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  fixture.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`).run(NOW);
  fixture.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, NOW);
  const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await worker.fetch(await asOwner(path), env);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { ...fixture, env, get, scope: { projectId: 'proj_1' } };
}

const spore = (id: string, over: Record<string, unknown> = {}) => ({
  id, agentId: AGENT, sessionId: null, promptId: null, observationType: 'gotcha',
  content: `body of ${id}`, context: null, filePath: null, tags: null,
  contentHash: null, properties: null, createdAt: NOW, ...over,
});

describe('an empty answer is not a missing one', () => {
  it('answers 200 with empty collections for a Project that has generated nothing', async () => {
    const { get } = await harness();
    for (const [path, key] of [
      ['/api/projects/proj_1/spores', 'spores'],
      ['/api/projects/proj_1/skills', 'skills'],
      ['/api/projects/proj_1/digests', 'digests'],
      ['/api/projects/proj_1/release-states', 'releaseStates'],
      ['/api/projects/proj_1/cortex/instructions', 'instructions'],
    ] as const) {
      const { status, body } = await get(path);
      expect({ path, status, empty: (body[key] as unknown[]).length }).toEqual({ path, status: 200, empty: 0 });
    }
  });

  it('answers 404 for a Project this caller cannot see, never an empty list', async () => {
    const { get } = await harness();
    for (const path of ['/api/projects/absent/spores', '/api/projects/absent/skills', '/api/projects/absent/digests', '/api/projects/absent/cortex/instructions']) {
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
      newSporeId: 'new', reason: null, sessionId: null, createdAt: NOW,
    }, NOW);

    const { body } = await get('/api/projects/proj_1/spores/old');
    expect(body.supersededBy).toEqual(['new']);
  });

  /**
   * Asserting the advertised `maxPage` proves nothing — it is a constant echoed
   * back. This asks for more rows than the ceiling with more than a ceiling's
   * worth present, so an unclamped surface would answer with all of them.
   * `skill_records` is the collection where the surface ceiling genuinely
   * tightens: its own reader admits up to 500.
   */
  it('serves no more than the ceiling, however large a page the caller asks for', async () => {
    const { get, db, scope } = await harness();
    for (let i = 0; i < 205; i += 1) {
      await insertSkillRecord(db, scope, {
        id: `sk${i}`, agentId: AGENT, name: `skill-${String(i).padStart(3, '0')}`,
        displayName: 'd', description: 'd', candidateId: null, sourceIds: '[]',
        path: `p${i}`, createdAt: NOW,
      });
    }
    const { body } = await get('/api/projects/proj_1/skills?limit=99999');
    expect((body.skills as unknown[]).length).toBe(200);
  });
});

describe('skills through the product surface', () => {
  it('serves content from the lineage snapshot, not from the record path', async () => {
    const { get, db, scope } = await harness();
    await insertSkillRecord(db, scope, {
      id: 'sk1', agentId: AGENT, name: 'debugging', displayName: 'Debugging', description: 'd',
      candidateId: null, sourceIds: '[]', path: '.agents/skills/debugging/SKILL.md', createdAt: NOW,
    });
    await insertLineage(db, scope, {
      id: 'l1', skillId: 'sk1', generation: 1, action: 'generate', rationale: 'r',
      sourceIdsAdded: '[]', contentSnapshot: 'the published body', createdAt: NOW,
    });

    const { body } = await get('/api/projects/proj_1/skills/sk1');
    expect(body.content).toBe('the published body');
    expect((body.lineage as unknown[]).length).toBe(1);
  });

  it('answers 404 for a skill with neither content nor lineage', async () => {
    const { get } = await harness();
    expect((await get('/api/projects/proj_1/skills/absent')).status).toBe(404);
  });
});

describe('digests through the product surface', () => {
  it('serves the current digest and the bodies it displaced', async () => {
    const { get, db, scope } = await harness();
    await upsertDigest(db, scope, { id: 'd1', agentId: AGENT, tier: 5000, content: 'first', substrateHash: null, generatedAt: NOW });
    await upsertDigest(db, scope, { id: 'd1', agentId: AGENT, tier: 5000, content: 'second', substrateHash: null, generatedAt: NOW + 10 });

    const current = await get('/api/projects/proj_1/digests');
    expect((current.body.digests as { content: string }[]).map((d) => d.content)).toEqual(['second']);

    const history = await get(`/api/projects/proj_1/digests/5000/revisions?agentId=${AGENT}`);
    expect((history.body.revisions as { content: string }[]).map((r) => r.content)).toEqual(['first']);
  });

  it('answers 404 for a revisions request naming no agent, rather than every agent', async () => {
    const { get } = await harness();
    expect((await get('/api/projects/proj_1/digests/5000/revisions')).status).toBe(404);
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
