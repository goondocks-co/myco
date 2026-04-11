import { describe, it, expect } from 'vitest';
import { handleGraph } from '../../../../src/worker/src/mcp/tools/graph';
import { createFakeD1, parseToolResult } from './_helpers';

describe('handleGraph', () => {
  it('returns edges and entities for a node (default both direction)', async () => {
    const fake = createFakeD1();
    // First query: edges
    fake.addResult([
      { id: 'e1', source_id: 'n1', source_type: 'entity', target_id: 'n2', target_type: 'entity', type: 'RELATES_TO', confidence: 0.9, properties: '{}' },
    ]);
    // Second query: entities
    fake.addResult([
      { id: 'n1', type: 'concept', name: 'Node 1', properties: '{}', first_seen: 1700000000, last_seen: 1700000000 },
      { id: 'n2', type: 'concept', name: 'Node 2', properties: '{}', first_seen: 1700000000, last_seen: 1700000000 },
    ]);

    const result = await handleGraph({ node_id: 'n1' }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.node_id).toBe('n1');
    expect(parsed.edges).toHaveLength(1);
    expect(parsed.edges[0].type).toBe('RELATES_TO');
    expect(parsed.entities).toHaveLength(2);
  });

  it('filters by outgoing direction', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    await handleGraph({ node_id: 'n1', direction: 'outgoing' }, { MYCO_TEAM_DB: fake.db });

    expect(fake.queries[0].sql).toContain('source_id = ?');
    expect(fake.queries[0].sql).not.toContain('OR');
    expect(fake.queries[0].values).toEqual(['n1']);
  });

  it('filters by incoming direction', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    await handleGraph({ node_id: 'n1', direction: 'incoming' }, { MYCO_TEAM_DB: fake.db });

    expect(fake.queries[0].sql).toContain('target_id = ?');
    expect(fake.queries[0].sql).not.toContain('OR');
    expect(fake.queries[0].values).toEqual(['n1']);
  });

  it('uses both direction by default', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    await handleGraph({ node_id: 'n1' }, { MYCO_TEAM_DB: fake.db });

    expect(fake.queries[0].sql).toContain('source_id = ? OR target_id = ?');
    expect(fake.queries[0].values).toEqual(['n1', 'n1']);
  });

  it('skips entity hydration when no entity-type nodes in edges', async () => {
    const fake = createFakeD1();
    fake.addResult([
      { id: 'e1', source_id: 's1', source_type: 'session', target_id: 'sp1', target_type: 'spore', type: 'EXTRACTED_FROM', confidence: 1.0, properties: null },
    ]);

    const result = await handleGraph({ node_id: 's1' }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.edges).toHaveLength(1);
    expect(parsed.entities).toHaveLength(0);
    // Only one query (edges), no entity query
    expect(fake.queries).toHaveLength(1);
  });

  it('returns empty edges and entities when no edges found', async () => {
    const fake = createFakeD1();
    fake.addResult([]);

    const result = await handleGraph({ node_id: 'nonexistent' }, { MYCO_TEAM_DB: fake.db });
    const parsed = parseToolResult(result);

    expect(parsed.edges).toHaveLength(0);
    expect(parsed.entities).toHaveLength(0);
  });
});
