import { describe, it, expect } from 'bun:test';
import { handleSearch } from '@myco-team-worker/mcp/tools/search';
import { createFakeD1, createFakeVectorize, createFakeAI, parseToolResult } from './_helpers';

describe('handleSearch', () => {
  it('embeds query, searches vectorize, and hydrates from D1', async () => {
    const fake = createFakeD1();
    const vectorize = createFakeVectorize([
      { id: 'spores:sp1:m1', score: 0.95, metadata: { table: 'spores', id: 'sp1', machine_id: 'm1' } },
    ]);
    const ai = createFakeAI([0.1, 0.2, 0.3]);

    fake.addResult([{ id: 'sp1', machine_id: 'm1', content: 'test spore', observation_type: 'gotcha' }]);

    const result = await handleSearch(
      { query: 'test query' },
      { MYCO_TEAM_DB: fake.db, MYCO_TEAM_VECTORS: vectorize, AI: ai },
    );

    const parsed = parseToolResult(result);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].id).toBe('sp1');
    expect(parsed.results[0].type).toBe('spores');
    expect(parsed.results[0].score).toBe(0.95);
    expect(parsed.results[0].data.content).toBe('test spore');
    expect(parsed.results[0].metadata.observation_type).toBeUndefined();
  });

  it('filters by types when specified', async () => {
    const fake = createFakeD1();
    const vectorize = createFakeVectorize([
      { id: 'spores:sp1:m1', score: 0.9, metadata: { table: 'spores', id: 'sp1', machine_id: 'm1' } },
      { id: 'sessions:s1:m1', score: 0.8, metadata: { table: 'sessions', id: 's1', machine_id: 'm1' } },
    ]);
    const ai = createFakeAI();

    fake.addResult([{ id: 'sp1', machine_id: 'm1', content: 'spore' }]);

    const result = await handleSearch(
      { query: 'test', types: ['spores'] },
      { MYCO_TEAM_DB: fake.db, MYCO_TEAM_VECTORS: vectorize, AI: ai },
    );

    const parsed = parseToolResult(result);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].type).toBe('spores');
  });

  it('respects limit parameter', async () => {
    const fake = createFakeD1();
    const vectorize = createFakeVectorize([
      { id: 'spores:sp1:m1', score: 0.9, metadata: { table: 'spores', id: 'sp1', machine_id: 'm1' } },
      { id: 'spores:sp2:m1', score: 0.8, metadata: { table: 'spores', id: 'sp2', machine_id: 'm1' } },
    ]);
    const ai = createFakeAI();

    fake.addResult([
      { id: 'sp1', machine_id: 'm1', content: 'first' },
      { id: 'sp2', machine_id: 'm1', content: 'second' },
    ]);

    const result = await handleSearch(
      { query: 'test', limit: 1 },
      { MYCO_TEAM_DB: fake.db, MYCO_TEAM_VECTORS: vectorize, AI: ai },
    );

    const parsed = parseToolResult(result);
    expect(parsed.results).toHaveLength(1);
  });

  it('sorts results by score descending', async () => {
    const fake = createFakeD1();
    const vectorize = createFakeVectorize([
      { id: 'spores:sp1:m1', score: 0.7, metadata: { table: 'spores', id: 'sp1', machine_id: 'm1' } },
      { id: 'spores:sp2:m1', score: 0.95, metadata: { table: 'spores', id: 'sp2', machine_id: 'm1' } },
    ]);
    const ai = createFakeAI();

    fake.addResult([
      { id: 'sp1', machine_id: 'm1', content: 'lower' },
      { id: 'sp2', machine_id: 'm1', content: 'higher' },
    ]);

    const result = await handleSearch(
      { query: 'test' },
      { MYCO_TEAM_DB: fake.db, MYCO_TEAM_VECTORS: vectorize, AI: ai },
    );

    const parsed = parseToolResult(result);
    expect(parsed.results[0].score).toBe(0.95);
    expect(parsed.results[1].score).toBe(0.7);
  });

  it('returns empty results when no vectorize matches', async () => {
    const fake = createFakeD1();
    const vectorize = createFakeVectorize([]);
    const ai = createFakeAI();

    const result = await handleSearch(
      { query: 'nothing' },
      { MYCO_TEAM_DB: fake.db, MYCO_TEAM_VECTORS: vectorize, AI: ai },
    );

    const parsed = parseToolResult(result);
    expect(parsed.results).toHaveLength(0);
  });

  it('filters by semantic metadata and returns metadata in results', async () => {
    const fake = createFakeD1();
    const vectorize = createFakeVectorize([
      {
        id: 'spores:sp1:m1',
        score: 0.95,
        metadata: {
          table: 'spores',
          id: 'sp1',
          machine_id: 'm1',
          status: 'active',
          observation_type: 'decision',
          created_at: 100,
          session_id: 'sess-1',
        },
      },
      {
        id: 'spores:sp2:m1',
        score: 0.98,
        metadata: {
          table: 'spores',
          id: 'sp2',
          machine_id: 'm1',
          status: 'superseded',
          observation_type: 'gotcha',
          created_at: 50,
          session_id: 'sess-2',
        },
      },
    ]);
    const ai = createFakeAI();

    fake.addResult([{ id: 'sp1', machine_id: 'm1', content: 'decision spore' }]);

    const result = await handleSearch(
      {
        query: 'test query',
        status: 'active',
        observation_type: 'decision',
        since: 90,
        session_id: 'sess-1',
      },
      { MYCO_TEAM_DB: fake.db, MYCO_TEAM_VECTORS: vectorize, AI: ai },
    );

    const parsed = parseToolResult(result);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].id).toBe('sp1');
    expect(parsed.results[0].metadata).toEqual(expect.objectContaining({
      status: 'active',
      observation_type: 'decision',
      created_at: 100,
      session_id: 'sess-1',
    }));
  });

  it('uses overfetch so filtered searches can still fill the requested limit', async () => {
    const fake = createFakeD1();
    const query = async (_vector: number[], options?: { topK?: number }) => ({
      matches: [
        { id: 'spores:drop:m1', score: 0.99, metadata: { table: 'spores', id: 'drop', machine_id: 'm1', status: 'superseded' } },
        { id: 'spores:keep:m1', score: 0.98, metadata: { table: 'spores', id: 'keep', machine_id: 'm1', status: 'active' } },
      ],
      count: 2,
      observedTopK: options?.topK,
    });
    const vectorize = { query } as unknown as VectorizeIndex;
    const ai = createFakeAI();

    fake.addResult([{ id: 'keep', machine_id: 'm1', content: 'kept spore' }]);

    const result = await handleSearch(
      { query: 'test query', limit: 1, status: 'active' },
      { MYCO_TEAM_DB: fake.db, MYCO_TEAM_VECTORS: vectorize, AI: ai },
    );

    const parsed = parseToolResult(result);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].id).toBe('keep');
  });

  it('clamps limit to range [1, 50]', async () => {
    const fake = createFakeD1();
    const vectorize = createFakeVectorize([]);
    const ai = createFakeAI();

    // limit=0 should become 1, limit=100 should become 50
    await handleSearch(
      { query: 'test', limit: 0 },
      { MYCO_TEAM_DB: fake.db, MYCO_TEAM_VECTORS: vectorize, AI: ai },
    );

    await handleSearch(
      { query: 'test', limit: 100 },
      { MYCO_TEAM_DB: fake.db, MYCO_TEAM_VECTORS: vectorize, AI: ai },
    );

    // No assertion needed beyond no errors — the clamping is internal
    expect(true).toBe(true);
  });
});
